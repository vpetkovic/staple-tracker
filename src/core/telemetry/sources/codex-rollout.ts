/**
 * Codex CLI rollout files (docs/execution-telemetry.md, "Codex rollout rules").
 *
 * A rollout is `~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<id>.jsonl`. Ingestion reads
 * only the first `session_meta` line's session id, fork marker, CLI version and outer
 * timestamp, and each `token_count` line's timestamp and `rate_limits` object. Prompts,
 * outputs and everything else in the file are never parsed into anything kept.
 *
 * ## Fork-copied history is skipped, and only at the start of the file
 *
 * A rollout whose first `session_meta` carries `payload.forked_from_id` begins with its
 * parent's history copied in, re-stamped at or 1 to 3 ms after the fork instant (the
 * outer `timestamp` of that `session_meta` line). Walking the token-count lines from the
 * first, a line is a copy when either holds:
 *
 *   1. its `rate_limits` (`limit_id`, `primary`, `secondary`, compared whole) equals a
 *      reading stamped BEFORE the fork instant in an ancestor rollout: the parent named
 *      by `forked_from_id` (the tail of every rollout file name), its parent, and so on,
 *      because a fork of a fork copies copies. Ancestor readings after the fork instant
 *      are excluded: the parent keeps running and sees the same account percentages.
 *   2. it follows the previous token-count line (for the first, the fork instant) by no
 *      more than 1,000 ms. A heuristic for copies whose ancestor is missing or trimmed;
 *      it can drop the fork's own first reading, which loses one reading and never
 *      mis-dates one.
 *
 * The walk stops at the first line that passes neither test. Nothing after it is
 * skipped, whatever it matches.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { StapleError } from "../../types.js";
import type { BudgetReading, Confidence, Missing } from "../budget-store.js";
import { addSeconds, epochSecondsToIso, normalizeInstant, sessionRefOf } from "../formats.js";
import { skip, type ParsedItem } from "./types.js";

/** Copies land within this many milliseconds of the previous token-count line. */
export const FORK_BURST_MS = 1000;
/** A fork chain deeper than this is treated as ending: a guard against a cycle of names. */
const MAX_ANCESTOR_DEPTH = 64;

const ROLLOUT_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

interface SessionMeta {
  readonly id: string | null;
  readonly forkedFromId: string | null;
  readonly cliVersion: string | null;
  /** The outer `timestamp` of the line, not `payload.timestamp`. */
  readonly timestamp: string | null;
}

interface TokenCountLine {
  readonly timestamp: string | null;
  readonly rateLimits: Record<string, unknown> | null;
}

interface RolloutLines {
  readonly meta: SessionMeta | null;
  readonly tokenCounts: TokenCountLine[];
  /** token_count lines that could not be parsed as JSON. */
  readonly unparseable: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Read the few fields ingestion is allowed to read, and nothing else. */
function readRollout(path: string): RolloutLines {
  const text = readFileSync(path, "utf8");
  let meta: SessionMeta | null = null;
  const tokenCounts: TokenCountLine[] = [];
  let unparseable = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A line being written when the file was read, or damaged. Only a token-count
      // line matters, and one that cannot be parsed is reported, never guessed at.
      if (line.includes('"token_count"')) unparseable += 1;
      continue;
    }
    const record = asRecord(parsed);
    if (record === null) continue;
    const payload = asRecord(record.payload);
    if (record.type === "session_meta" && meta === null && payload !== null) {
      meta = {
        id: typeof payload.id === "string" ? payload.id : null,
        forkedFromId: typeof payload.forked_from_id === "string" && payload.forked_from_id !== "" ? payload.forked_from_id : null,
        cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : null,
        timestamp: normalizeInstant(record.timestamp),
      };
      continue;
    }
    if (record.type === "event_msg" && payload?.type === "token_count") {
      tokenCounts.push({ timestamp: normalizeInstant(record.timestamp), rateLimits: asRecord(payload.rate_limits) });
    }
  }
  return { meta, tokenCounts, unparseable };
}

/** Keys sorted at every level, so two equal objects serialize equally. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = asRecord(value);
  if (record === null) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

/** The whole of what "compared whole" compares: `limit_id`, `primary`, `secondary`. */
function contentKey(rateLimits: Record<string, unknown>): string {
  return JSON.stringify([rateLimits.limit_id ?? null, canonical(rateLimits.primary ?? null), canonical(rateLimits.secondary ?? null)]);
}

/** The directory a rollout's ancestors are searched in: the nearest `sessions` above it. */
export function sessionsRootOf(file: string): string {
  let dir = dirname(file);
  for (;;) {
    if (basename(dir) === "sessions") return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(file);
    dir = parent;
  }
}

/** Every rollout file under `root`, by the id its name ends with. */
function indexRollouts(root: string): Map<string, string> {
  const index = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const match = ROLLOUT_ID.exec(entry.name);
        if (match && entry.name.startsWith("rollout-")) index.set(match[1]!, path);
      }
    }
  };
  walk(root);
  return index;
}

/**
 * The readings stamped before `forkInstant` in every ancestor of a fork that can be
 * found, as content keys. A missing ancestor ends the chain; the burst rule still runs.
 */
function preForkAncestorContent(forkedFromId: string, forkInstant: string, root: string): Set<string> {
  const index = indexRollouts(root);
  const seen = new Set<string>();
  const content = new Set<string>();
  const cutoff = Date.parse(forkInstant);
  let next: string | null = forkedFromId;
  while (next !== null && !seen.has(next) && seen.size < MAX_ANCESTOR_DEPTH) {
    seen.add(next);
    const path = index.get(next);
    if (path === undefined) break;
    const ancestor = readRollout(path);
    for (const line of ancestor.tokenCounts) {
      if (line.rateLimits === null || line.timestamp === null) continue;
      if (Date.parse(line.timestamp) < cutoff) content.add(contentKey(line.rateLimits));
    }
    next = ancestor.meta?.forkedFromId ?? null;
  }
  return content;
}

/**
 * How many leading token-count lines are fork copies. Zero for a file that is not a
 * fork. The walk stops at the first line neither test marks.
 */
function leadingCopyCount(rollout: RolloutLines, sessionsRoot: string): number {
  const meta = rollout.meta;
  if (meta === null || meta.forkedFromId === null || meta.timestamp === null) return 0;
  const ancestors = preForkAncestorContent(meta.forkedFromId, meta.timestamp, sessionsRoot);
  let previous = Date.parse(meta.timestamp);
  let count = 0;
  for (const line of rollout.tokenCounts) {
    const at = line.timestamp === null ? Number.NaN : Date.parse(line.timestamp);
    const contentMatch = line.rateLimits !== null && ancestors.has(contentKey(line.rateLimits));
    const inBurst = Number.isFinite(at) && at - previous <= FORK_BURST_MS;
    if (!contentMatch && !inBurst) break;
    count += 1;
    if (Number.isFinite(at)) previous = at;
  }
  return count;
}

/** One sub-limit (`primary` or `secondary`) of a token-count line as a reading. */
function subLimitReading(input: {
  readonly rateLimits: Record<string, unknown>;
  readonly position: "primary" | "secondary";
  readonly observedAt: string;
  readonly sessionRef: string | null;
  readonly harnessVersion: string | null;
}): ParsedItem {
  const { rateLimits, position, observedAt } = input;
  const limitId = typeof rateLimits.limit_id === "string" && rateLimits.limit_id !== "" ? rateLimits.limit_id.toLowerCase() : null;
  // Positional keys are never renamed to five_hour by assumption; the length is its own field.
  const limitKey = `${limitId ?? "unlabelled"}.${position}`;
  const sub = rateLimits[position];
  // The `premium` limit arrives with `primary: null, secondary: null`: no reading.
  if (sub === null || sub === undefined) return skip("not_reported_by_source", limitKey, observedAt);
  const limit = asRecord(sub);
  if (limit === null) return skip("parse_error", limitKey, observedAt);
  const used = limit.used_percent;
  if (used === null || used === undefined) return skip("not_reported_by_source", limitKey, observedAt);
  if (typeof used !== "number" || !Number.isFinite(used)) return skip("parse_error", limitKey, observedAt);

  const missing: Missing = {};
  let resetsAt = epochSecondsToIso(limit.resets_at);
  let resetsAtSource: BudgetReading["resetsAtSource"] = resetsAt === null ? null : "observed_absolute";
  if (resetsAt === null && typeof limit.resets_in_seconds === "number" && Number.isFinite(limit.resets_in_seconds)) {
    // None has been seen. If a build writes one, it is converted at the line's own
    // timestamp, never at ingestion, and marked as converted.
    resetsAt = addSeconds(observedAt, limit.resets_in_seconds);
    resetsAtSource = "derived_from_relative";
  }
  if (resetsAt === null) {
    missing.resetsAt = limit.resets_at === undefined || limit.resets_at === null ? "reset_not_reported" : "parse_error";
  }
  const minutes = limit.window_minutes;
  // Exactly as reported: 299 minutes stays 17,940 seconds, never rounded to 300.
  const windowSeconds = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
  if (windowSeconds === null) missing.windowSeconds = minutes === undefined || minutes === null ? "not_reported_by_source" : "parse_error";
  const planTier = typeof rateLimits.plan_type === "string" && rateLimits.plan_type !== "" ? rateLimits.plan_type : null;
  if (planTier === null) missing.planTier = "not_reported_by_source";
  if (input.sessionRef === null) missing.sessionRef = "not_reported_by_source";

  const oldLine = limitId === null || limit.resets_at === null || limit.resets_at === undefined;
  // medium: an undocumented surface. low: an old unlabelled line, or a converted reset.
  const confidence: Confidence = oldLine || resetsAtSource === "derived_from_relative" ? "low" : "medium";
  return {
    kind: "reading",
    reading: {
      limitKey,
      unit: "percent_of_limit",
      usedPercent: used,
      resetsAt,
      resetsAtSource,
      windowSeconds,
      windowSecondsSource: windowSeconds === null ? null : "observed",
      planTier,
      method: "observed",
      confidence,
      source: { kind: "codex_rollout", harnessVersion: input.harnessVersion, field: `payload.rate_limits.${position}` },
      observedAt,
      observedAtSource: "provider",
      sessionRef: input.sessionRef,
      missing,
    },
  };
}

export interface CodexRolloutOptions {
  /** Where ancestors are looked for. Defaults to the nearest `sessions` directory above the file. */
  readonly sessionsRoot?: string;
}

export function parseCodexRollout(file: string, options: CodexRolloutOptions = {}): ParsedItem[] {
  let rollout: RolloutLines;
  try {
    rollout = readRollout(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new StapleError("not_found", `No rollout file at ${file}.`);
    if (code === "EISDIR") throw new StapleError("validation", `${file} is a directory; pass one rollout-*.jsonl file.`);
    throw error;
  }
  const meta = rollout.meta;
  const sessionRef = meta?.id ? sessionRefOf("codex", meta.id) : null;
  const harnessVersion = meta?.cliVersion ?? null;
  const copies = leadingCopyCount(rollout, options.sessionsRoot ?? sessionsRootOf(file));

  const items: ParsedItem[] = [];
  for (let i = 0; i < rollout.unparseable; i += 1) items.push(skip("parse_error", null, null));
  rollout.tokenCounts.forEach((line, index) => {
    if (index < copies) {
      // Skipped, not deduplicated: a copied line never reaches the dedup key.
      items.push(skip("fork_copied", null, line.timestamp));
      return;
    }
    if (line.timestamp === null) {
      items.push(skip("parse_error", null, null));
      return;
    }
    if (line.rateLimits === null) {
      items.push(skip("not_reported_by_source", null, line.timestamp));
      return;
    }
    for (const position of ["primary", "secondary"] as const) {
      items.push(subLimitReading({ rateLimits: line.rateLimits, position, observedAt: line.timestamp, sessionRef, harnessVersion }));
    }
  });
  return items;
}
