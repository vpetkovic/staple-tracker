/**
 * The formats docs/execution-telemetry.md fixes for budget telemetry ("Formats",
 * "Privacy"): hashing, instants, the account slug, and the display label.
 *
 * Every digest here hashes UTF-8 bytes. A tuple is serialized as a compact JSON array
 * in the order the contract writes it (`JSON.stringify([...])`, no whitespace), so a
 * number is hashed exactly as JSON writes the stored number (`6`, not `6.0`), an
 * instant as its ISO string and a missing value as `null`. A single value is hashed
 * as its bare string.
 */
import { createHash } from "node:crypto";
import { StapleError } from "../types.js";

/** `harness.name`: the closed set a sessionRef is namespaced by. */
export type HarnessName = "claude_code" | "codex" | "other";

/** `source.kind` values an ingestion path in this build writes. */
export type BudgetSourceKind = "claude_code_statusline" | "codex_rollout" | "operator_manual";

/** The harness a sample's sessionRef belongs to, from its `source.kind` (Privacy). */
export const HARNESS_OF_SOURCE: Readonly<Record<string, HarnessName>> = {
  claude_code_statusline: "claude_code",
  codex_rollout: "codex",
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * `sessionRef`: the first 16 hex characters of `sha256(harness name + ":" + session id)`.
 *
 * The input is a plain string, not a tuple. It is the same value an attempt reported
 * from the same session carries, so the two can be joined without the raw id (which
 * names a transcript file) ever being stored.
 */
export function sessionRefOf(harness: HarnessName, sessionId: string): string {
  return sha256Hex(`${harness}:${sessionId}`).slice(0, 16);
}

/** The fields of a sample the dedup key covers, in the contract's order. */
export interface DedupKeyInput {
  readonly sourceKind: string;
  readonly accountRef: string;
  readonly limitKey: string;
  readonly sessionRef: string | null;
  readonly resetsAt: string | null;
  readonly usedPercent: number | null;
  readonly observedAt: string;
}

/**
 * `dedupKey`: the first 32 hex characters of sha256 over
 * `(source.kind, accountRef, limitKey, sessionRef, resetsAt, usedPercent, observedAt)`.
 * A bare digest, not an event key: samples are not events.
 */
export function budgetDedupKey(input: DedupKeyInput): string {
  const tuple = JSON.stringify([
    input.sourceKind,
    input.accountRef,
    input.limitKey,
    input.sessionRef,
    input.resetsAt,
    input.usedPercent,
    input.observedAt,
  ]);
  return sha256Hex(tuple).slice(0, 32);
}

/** Operator-chosen account slug (Formats). */
export const ACCOUNT_REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertAccountRef(value: string, where: string): string {
  if (!ACCOUNT_REF_PATTERN.test(value)) {
    throw new StapleError(
      "validation",
      `${where} must be an account label: lowercase letters, digits and dashes, starting with a letter or digit, at most 64 characters (got "${value}"). It is a name you choose, never an email or an account id.`,
    );
  }
  return value;
}

/** A provider slug: lowercase, like `anthropic` or `openai`. */
export const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function assertProvider(value: string, where: string): string {
  if (!PROVIDER_PATTERN.test(value)) {
    throw new StapleError("validation", `${where} must be a lowercase provider slug such as "anthropic" or "openai" (got "${value}").`);
  }
  return value;
}

/**
 * A provider epoch-seconds value as a UTC instant, or null when it is not a finite
 * number. The conversion is exact to the millisecond, so the epoch is not kept.
 */
export function epochSecondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A strict ISO-8601 instant with a zone, normalized to `toISOString()`; null otherwise. */
export function normalizeInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // A zone is required: a local-time string would be read in this machine's zone and
  // mis-date the reading by the offset.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Add seconds to an instant, returning an instant. */
export function addSeconds(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1000).toISOString();
}

/**
 * A duration in the existing vocabulary (`90s`, `30m`, `2h`, `3d`), in seconds.
 * A bare number is refused here: next to an instant it could be read as epoch
 * seconds or as a duration, and guessing would mis-date a reset.
 */
export function parseRelativeSeconds(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(raw.trim());
  if (!match) return null;
  const scale = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "s" | "m" | "h" | "d"];
  return Number(match[1]) * scale;
}

/** A window's display label, derived from its length and never a key: `5h`, `7d`, `299m`. */
export function windowLabel(windowSeconds: number | null): string | null {
  if (windowSeconds === null || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return null;
  if (windowSeconds % 86400 === 0) return `${windowSeconds / 86400}d`;
  if (windowSeconds % 3600 === 0) return `${windowSeconds / 3600}h`;
  if (windowSeconds % 60 === 0) return `${windowSeconds / 60}m`;
  return `${windowSeconds}s`;
}
