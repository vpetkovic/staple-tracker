/**
 * Instruction documents: the text the tracker hands to every ticket beneath an issue and to
 * every run that takes one (`design/runs.md`, "Instruction documents").
 *
 * A document is an instruction document when its head revision carries the flag (migration
 * 019; `staple doc <ref> <key> --put <file> --instructions`). A run carries instructions of
 * its own (`run start --instructions <file>`), which are machine-local like the run.
 *
 * ## Which apply to a ticket, nearest first
 *
 *  1. `self`: the ticket's own instruction documents.
 *  2. `parent`: each ancestor's, by the parent chain, the nearest first.
 *  3. `milestone`: the ticket's milestone's. Membership is not ancestry, so this is the
 *     effective milestone: the ticket's own membership, else its nearest ancestor's
 *     (`nearestMilestone`). A member epic's descendants are covered this way.
 *  4. `run`: the run's own, when the ticket is read for a run.
 *
 * Two sources holding the same key conflict, and the nearest wins: the farther one is still
 * listed, with `effective: false` and `shadowedBy` naming the winner, so a reader sees what
 * was set and where, not only the result.
 */

import type { DatabaseSync } from "node:sqlite";
import { MILESTONE_MEMBERSHIP, nearestMilestone } from "./milestones.js";
import { MAX_TREE_DEPTH, StapleError } from "./types.js";

export const INSTRUCTION_SOURCE_KINDS = ["self", "parent", "milestone", "run"] as const;
export type InstructionSourceKind = (typeof INSTRUCTION_SOURCE_KINDS)[number];

/** Where one instruction comes from. */
export interface InstructionSource {
  kind: InstructionSourceKind;
  /** The issue's identifier; null for a run's own. */
  ref: string | null;
  issueId: string | null;
  /** The issue's title; null for a run's own. */
  title: string | null;
  /** The run; null for an issue's document. */
  runId: string | null;
}

export interface ResolvedInstruction {
  key: string;
  /** The document's head revision; null for a run's own, which has no revisions. */
  revision: number | null;
  /** The document's title, when it has one. */
  title: string | null;
  body: string;
  author: string | null;
  updatedAt: string | null;
  source: InstructionSource;
  /** False when a nearer source holds the same key. */
  effective: boolean;
  /** The nearer source that wins this key; null when this one is effective. */
  shadowedBy: InstructionSource | null;
}

/** One run instruction as `runs.instructions` holds it. */
export interface RunInstruction {
  key: string;
  body: string;
}

const RUN_KEY = /^[a-z0-9._-]{1,64}$/;

/**
 * A run instruction's key from its file name: `rules.md` is `rules`. Lower-cased, anything
 * outside a document key's alphabet replaced, so it can shadow and be shadowed by a document
 * of the same key.
 */
export function runInstructionKey(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const stem = base.replace(/\.[^.]+$/, "");
  const key = stem.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return key === "" ? "run" : key;
}

/** Validate and normalize run instructions before they are stored. Keys must be distinct. */
export function normalizeRunInstructions(input: readonly RunInstruction[]): RunInstruction[] {
  const seen = new Set<string>();
  const out: RunInstruction[] = [];
  for (const entry of input) {
    const key = entry.key.trim().toLowerCase();
    if (!RUN_KEY.test(key)) throw new StapleError("validation", `Run instruction key must be 1-64 chars of a-z 0-9 . _ -: ${entry.key}`);
    if (seen.has(key)) throw new StapleError("validation", `Two run instructions share the key "${key}". Give each file its own name.`);
    if (entry.body.trim() === "") throw new StapleError("validation", `Run instruction "${key}" is empty.`);
    seen.add(key);
    out.push({ key, body: entry.body });
  }
  return out;
}

/** `runs.instructions` as read, tolerating a null or a malformed value as none. */
export function parseRunInstructions(raw: string | null): RunInstruction[] {
  if (raw === null || raw === "") return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is RunInstruction => typeof entry === "object" && entry !== null && typeof entry.key === "string" && typeof entry.body === "string",
    );
  } catch {
    return [];
  }
}

interface ChainRow {
  id: string;
  identifier: string;
  title: string;
  parent_id: string | null;
}

/** The issue first, then its parent, then the grandparent: as far as `MAX_TREE_DEPTH` reaches. */
function chainOf(db: DatabaseSync, issueId: string): ChainRow[] {
  const read = db.prepare("SELECT id, identifier, title, parent_id FROM issues WHERE id = ?");
  const chain: ChainRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = issueId;
  while (cursor !== null && chain.length <= MAX_TREE_DEPTH && !seen.has(cursor)) {
    const row = read.get(cursor) as ChainRow | undefined;
    if (row === undefined) break;
    chain.push(row);
    seen.add(row.id);
    cursor = row.parent_id;
  }
  return chain;
}

/** The issues whose instruction documents reach `issueId`, nearest first, with how each reaches it. */
export function instructionSources(db: DatabaseSync, issueId: string): Array<{ kind: Exclude<InstructionSourceKind, "run">; row: ChainRow }> {
  const chain = chainOf(db, issueId);
  if (chain.length === 0) return [];
  const sources: Array<{ kind: Exclude<InstructionSourceKind, "run">; row: ChainRow }> = chain.map((row, index) => ({
    kind: index === 0 ? "self" : "parent",
    row,
  }));
  const memberRows = db
    .prepare(`SELECT issue_id, milestone_id FROM ${MILESTONE_MEMBERSHIP} WHERE issue_id IN (${chain.map(() => "?").join(",")})`)
    .all(...chain.map((row) => row.id)) as Array<{ issue_id: string; milestone_id: string }>;
  const memberOf = new Map(memberRows.map((row) => [row.issue_id, row.milestone_id]));
  const milestoneId = nearestMilestone(
    chain.map((row) => row.id),
    memberOf,
  );
  // A ticket filed under its milestone already reads it as a parent.
  if (milestoneId !== null && !chain.some((row) => row.id === milestoneId)) {
    const row = db.prepare("SELECT id, identifier, title, parent_id FROM issues WHERE id = ?").get(milestoneId) as ChainRow | undefined;
    if (row !== undefined) sources.push({ kind: "milestone", row });
  }
  return sources;
}

/** The instruction documents on one issue, by key. */
function instructionDocumentsOf(
  db: DatabaseSync,
  issueId: string,
): Array<{ key: string; revision: number; title: string | null; body: string; author: string | null; createdAt: string }> {
  return db
    .prepare(
      `SELECT d.key, d.current_revision AS revision, d.title, r.body, r.author, r.created_at AS createdAt
         FROM documents d
         JOIN document_revisions r ON r.issue_id = d.issue_id AND r.key = d.key AND r.revision = d.current_revision
        WHERE d.issue_id = ? AND r.instructions = 1
        ORDER BY d.key`,
    )
    .all(issueId) as Array<{ key: string; revision: number; title: string | null; body: string; author: string | null; createdAt: string }>;
}

/** A run's own instructions and when it started, or null when there is no such run. */
function runInstructionsOf(db: DatabaseSync, runId: string): { instructions: RunInstruction[]; startedAt: string; actor: string } | null {
  const row = db.prepare("SELECT instructions, started_at, actor FROM runs WHERE id = ?").get(runId) as
    | { instructions: string | null; started_at: string; actor: string }
    | undefined;
  if (row === undefined) return null;
  return { instructions: parseRunInstructions(row.instructions), startedAt: row.started_at, actor: row.actor };
}

/**
 * Every instruction that applies to `issueId`, nearest first, with the source of each and
 * whether it is the one in effect for its key. With `runId`, the run's own come last.
 */
export function resolveInstructions(db: DatabaseSync, issueId: string, options: { runId?: string | null } = {}): ResolvedInstruction[] {
  const out: ResolvedInstruction[] = [];
  const winners = new Map<string, InstructionSource>();
  const add = (entry: Omit<ResolvedInstruction, "effective" | "shadowedBy">): void => {
    const winner = winners.get(entry.key);
    if (winner === undefined) winners.set(entry.key, entry.source);
    out.push({ ...entry, effective: winner === undefined, shadowedBy: winner ?? null });
  };
  for (const { kind, row } of instructionSources(db, issueId)) {
    const source: InstructionSource = { kind, ref: row.identifier, issueId: row.id, title: row.title, runId: null };
    for (const doc of instructionDocumentsOf(db, row.id)) {
      add({ key: doc.key, revision: doc.revision, title: doc.title, body: doc.body, author: doc.author, updatedAt: doc.createdAt, source });
    }
  }
  const runId = options.runId ?? null;
  if (runId !== null) {
    const held = runInstructionsOf(db, runId);
    if (held !== null) return withRunInstructions(out, held.instructions, { runId, actor: held.actor, startedAt: held.startedAt });
  }
  return out;
}

/**
 * `list` with a run's own instructions added last, shadowed by any nearer source with the same
 * key. What `resolveInstructions` does for a stored run, and what a dry run previews for a run
 * not started yet.
 */
export function withRunInstructions(
  list: readonly ResolvedInstruction[],
  entries: readonly RunInstruction[],
  run: { runId: string; actor: string | null; startedAt: string | null },
): ResolvedInstruction[] {
  const out = [...list];
  const winners = new Map<string, InstructionSource>();
  for (const entry of list) if (entry.effective) winners.set(entry.key, entry.source);
  const source: InstructionSource = { kind: "run", ref: null, issueId: null, title: null, runId: run.runId };
  for (const entry of entries) {
    const winner = winners.get(entry.key);
    if (winner === undefined) winners.set(entry.key, source);
    out.push({ key: entry.key, revision: null, title: null, body: entry.body, author: run.actor, updatedAt: run.startedAt, source, effective: winner === undefined, shadowedBy: winner ?? null });
  }
  return out;
}

/** One `instructions_changed` event as a run reports it. */
export interface InstructionChange {
  seq: number;
  ref: string | null;
  issueId: string;
  key: string;
  revision: number | null;
  /** Whether the document is instructions after the change: false means it stopped being one. */
  instructions: boolean;
  actor: string | null;
  at: string;
}

/** The newest event seq, the watermark a run starts from. */
export function latestEventSeq(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null };
  return row.seq ?? 0;
}

/**
 * The `instructions_changed` events after `afterSeq`, oldest first, limited to `issueIds`
 * when given (the sources a ticket reads, or a run's scope).
 */
export function instructionChangesSince(db: DatabaseSync, afterSeq: number, issueIds?: ReadonlySet<string> | null): InstructionChange[] {
  const rows = db
    .prepare(
      `SELECT e.seq, e.issue_id, e.actor, e.payload, e.created_at, i.identifier
         FROM events e LEFT JOIN issues i ON i.id = e.issue_id
        WHERE e.kind = 'instructions_changed' AND e.seq > ?
        ORDER BY e.seq`,
    )
    .all(afterSeq) as Array<{ seq: number; issue_id: string | null; actor: string | null; payload: string; created_at: string; identifier: string | null }>;
  const out: InstructionChange[] = [];
  for (const row of rows) {
    if (row.issue_id === null) continue;
    if (issueIds && !issueIds.has(row.issue_id)) continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    out.push({
      seq: row.seq,
      ref: row.identifier,
      issueId: row.issue_id,
      key: typeof payload.key === "string" ? payload.key : "",
      revision: typeof payload.revision === "number" ? payload.revision : null,
      instructions: payload.instructions === true,
      actor: row.actor,
      at: row.created_at,
    });
  }
  return out;
}

/** The issue ids whose instruction documents reach `issueId`: what a change must touch to be news to it. */
export function instructionSourceIds(db: DatabaseSync, issueId: string): Set<string> {
  return new Set(instructionSources(db, issueId).map(({ row }) => row.id));
}

/**
 * Instructions as text a session reads: every effective one, nearest first, each under a
 * heading naming its source. Shadowed ones are named, not repeated. Empty when none apply.
 */
export function renderInstructions(list: readonly ResolvedInstruction[]): string {
  const effective = list.filter((entry) => entry.effective);
  if (effective.length === 0) return "";
  const lines: string[] = [];
  for (const entry of effective) {
    lines.push(`### ${entry.key} (${describeSource(entry.source)}${entry.revision !== null ? `, r${entry.revision}` : ""})`, "", entry.body.trim(), "");
  }
  const shadowed = list.filter((entry) => !entry.effective);
  if (shadowed.length > 0) {
    lines.push(
      "Overridden (a nearer source sets the same key):",
      ...shadowed.map((entry) => `- ${entry.key} from ${describeSource(entry.source)}, overridden by ${describeSource(entry.shadowedBy!)}`),
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

/** `parent STA-12 "Title"`, `this ticket`, `run 1a2b3c4d`. */
export function describeSource(source: InstructionSource): string {
  switch (source.kind) {
    case "self":
      return `this ticket ${source.ref ?? ""}`.trim();
    case "parent":
      return `parent ${source.ref}`;
    case "milestone":
      return `milestone ${source.ref}`;
    case "run":
      return `run ${(source.runId ?? "").slice(0, 8)}`;
  }
}
