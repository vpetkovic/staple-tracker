/**
 * Where plan work came from (design/plan.md, "Provenance"): the idea and breakdown row a
 * scaffolded ticket was made from, and the ticket whose work sparked an idea.
 *
 * Both ride on the issue's origin columns, the way a finding names the ticket it was found in:
 * written once, in the record's own create, so the operation that makes the record carries its
 * provenance to every device, and a device that hydrates it later reads the same thing.
 *
 * - A scaffolded task: `origin_kind` {@link SCAFFOLD_ORIGIN_KIND}, `origin_id` `<idea id>/<row id>`.
 *   Its id follows from the same pair (`scaffoldTaskId`), so two devices scaffolding one idea
 *   offline write one identical create, and the origin never contends with another record's.
 * - A sparked idea: `origin_kind` {@link SPARKED_ORIGIN_KIND}, `origin_id` `<ticket id>/<idea id>`,
 *   unique by construction, so one ticket may spark any number of ideas.
 *
 * Read on a record's detail only (one record, a constant number of reads); no list reads it.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isIdeaNumber } from "./idea-numbers.js";

export const SCAFFOLD_ORIGIN_KIND = "plan-row";
export const SPARKED_ORIGIN_KIND = "sparked";

/**
 * The task Scaffold makes from a breakdown row has an id that follows from the idea's and the
 * row's, the same on every device: two devices scaffolding one idea offline create the same
 * records, and sync merges them as one (design/plan.md, "Scaffold").
 */
export function scaffoldTaskId(ideaId: string, rowId: string): string {
  const hex = createHash("sha256").update(`staple:plan-scaffold:${ideaId}:${rowId}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The scaffolded task's origin id, `<idea id>/<row id>`. */
export function scaffoldOriginId(ideaId: string, rowId: string): string {
  return `${ideaId}/${rowId}`;
}

/** The sparked idea's origin id, `<ticket id>/<idea id>`. */
export function sparkedOriginId(ticketId: string, ideaId: string): string {
  return `${ticketId}/${ideaId}`;
}

/** The idea and breakdown row a scaffolded ticket came from. */
export interface ScaffoldedFrom {
  /** The idea's record: since scaffold, the ticket's epic. */
  ideaId: string;
  /** Its permanent idea number, I-<PREFIX>-<n>; null on a record an earlier build left unnumbered. */
  ideaNumber: string | null;
  /** Its ticket number once promoted; null while it is an unpromoted idea. */
  identifier: string | null;
  title: string;
  rowId: string;
  /** The row's key as the breakdown holds it now; null once the row was removed from the breakdown. */
  rowKey: string | null;
}

/** The ticket whose work sparked an idea. */
export interface SparkedBy {
  identifier: string;
  title: string;
  status: string;
}

/** An idea a ticket's work sparked. */
export interface SparkedIdea {
  id: string;
  ideaNumber: string | null;
  /** Its ticket number once promoted; null while it is an idea. */
  identifier: string | null;
  title: string;
  /** Its maturity: raw, exploring, shaped or dropped. */
  maturity: string | null;
}

interface RecordRow {
  id: string;
  identifier: string;
  title: string;
  kind: string;
  status: string;
  plan_maturity: string | null;
  plan_idea_number: string | null;
}

interface OriginRow {
  id: string;
  parent_id: string | null;
  origin_kind: string;
  origin_id: string | null;
}

const RECORD_COLUMNS = "id, identifier, title, kind, status, plan_maturity, plan_idea_number";

function ideaNumberOf(row: RecordRow): string | null {
  return row.plan_idea_number ?? (isIdeaNumber(row.identifier) ? row.identifier : null);
}

/** An unpromoted idea has no ticket number to show: its identifier is its idea number. */
function ticketNumberOf(row: RecordRow): string | null {
  return isIdeaNumber(row.identifier) || row.identifier === row.id ? null : row.identifier;
}

/** Split `<a>/<b>`; null when it is not one. */
function pair(originId: string | null): [string, string] | null {
  if (originId === null) return null;
  const at = originId.indexOf("/");
  return at > 0 && at < originId.length - 1 ? [originId.slice(0, at), originId.slice(at + 1)] : null;
}

function rowKeyOf(db: DatabaseSync, ideaId: string, rowId: string): string | null {
  const row = db.prepare("SELECT body FROM plan_rows WHERE idea_id = ? AND row_id = ?").get(ideaId, rowId) as { body: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.body) as { key?: unknown };
    return typeof value.key === "string" ? value.key : null;
  } catch {
    return null;
  }
}

/**
 * The idea and row a ticket was scaffolded from, or null. Read from its origin; a ticket an
 * earlier build scaffolded carries none, so its parent record's rows are matched to its id
 * instead (the id follows from the idea and the row), while that row is still in the breakdown.
 */
export function scaffoldedFromOf(db: DatabaseSync, issue: OriginRow): ScaffoldedFrom | null {
  let ideaId: string | null = null;
  let rowId: string | null = null;
  if (issue.origin_kind === SCAFFOLD_ORIGIN_KIND) {
    const both = pair(issue.origin_id);
    if (both) [ideaId, rowId] = both;
  } else if (issue.origin_kind === "manual" && issue.parent_id !== null) {
    const rows = db.prepare("SELECT row_id FROM plan_rows WHERE idea_id = ?").all(issue.parent_id) as Array<{ row_id: string }>;
    const match = rows.find((row) => scaffoldTaskId(issue.parent_id!, row.row_id) === issue.id);
    if (match) [ideaId, rowId] = [issue.parent_id, match.row_id];
  }
  if (ideaId === null || rowId === null) return null;
  const idea = db.prepare(`SELECT ${RECORD_COLUMNS} FROM issues WHERE id = ?`).get(ideaId) as RecordRow | undefined;
  if (!idea) return null;
  return {
    ideaId: idea.id,
    ideaNumber: ideaNumberOf(idea),
    identifier: ticketNumberOf(idea),
    title: idea.title,
    rowId,
    rowKey: rowKeyOf(db, idea.id, rowId),
  };
}

/** The ticket whose work sparked this idea, or null (none was named, or it is gone from this device). */
export function sparkedByOf(db: DatabaseSync, record: OriginRow): SparkedBy | null {
  if (record.origin_kind !== SPARKED_ORIGIN_KIND) return null;
  const both = pair(record.origin_id);
  if (!both) return null;
  const ticket = db.prepare(`SELECT ${RECORD_COLUMNS} FROM issues WHERE id = ?`).get(both[0]) as RecordRow | undefined;
  return ticket ? { identifier: ticket.identifier, title: ticket.title, status: ticket.status } : null;
}

/** The ideas this ticket's work sparked, oldest first. */
export function sparkedIdeasOf(db: DatabaseSync, ticketId: string): SparkedIdea[] {
  const prefix = `${ticketId}/`;
  const rows = db
    .prepare(`SELECT ${RECORD_COLUMNS} FROM issues WHERE origin_kind = ? AND substr(origin_id, 1, ?) = ? ORDER BY created_at, id`)
    .all(SPARKED_ORIGIN_KIND, prefix.length, prefix) as unknown as RecordRow[];
  return rows.map((row) => ({
    id: row.id,
    ideaNumber: ideaNumberOf(row),
    identifier: ticketNumberOf(row),
    title: row.title,
    maturity: row.plan_maturity,
  }));
}

/** The provenance chip's words, as every surface prints them: `from I-STA-4 · row R2`. */
export function scaffoldedFromWords(from: ScaffoldedFrom): string {
  const idea = from.ideaNumber ?? from.identifier ?? "an idea";
  return from.rowKey === null ? `from ${idea} · a removed row` : `from ${idea} · row ${from.rowKey}`;
}

/** A sparked idea's reference: its idea number, with its ticket number once promoted. */
export function sparkedIdeaWords(idea: SparkedIdea): string {
  const number = idea.ideaNumber ?? "idea";
  return idea.identifier === null ? `${number}(${idea.maturity ?? "idea"})` : `${idea.identifier} · ${number}`;
}
