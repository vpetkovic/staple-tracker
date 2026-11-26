/**
 * What a run is called and the issues it names, as they stand now: the web UI's autopilot page
 * shows a run by its name and each ticket with its status and title, not as bare identifiers.
 *
 * ## The title
 *
 * A run over an epic or a milestone is called what its scope is called. A run over the queue
 * has no scope to name, so it is named after the work it took: the parent each ticket came
 * from (the ticket itself when it has none), in the order it took them — "Queue: R3 OpenAPI
 * and C#/TS SDKs", "Queue: R3 OpenAPI and C#/TS SDKs and 2 more". Before it takes anything it
 * is "The whole queue". The first ticket's identifier is never a name: it says nothing about
 * what the run is doing.
 *
 * ## The issues
 *
 * Every issue the run's status names, wherever it names it: the scope, the tickets taken, the
 * facts (workable, waiting, gates, person blocks), the stop's detail, the decision and the goal.
 * An identifier the run recorded for one of its tickets is that ticket (by its issueId), even
 * once another issue holds the number; any other identifier is the issue holding it now, else
 * the issue that moved off it (`identifier-moves.ts`).
 * Each is read once, now, with its CURRENT identifier, title, status and category. A ticket
 * records the identifier it had when it was taken, which a renumber from another device
 * moves; the page joins on `issueId` and opens what this list says. An issue deleted since is
 * absent, and the page says so.
 *
 * References are collected by shape rather than by a list of fields: any `issueId` string, and
 * any string that is an issue identifier. Adding a field that names an issue to a run's status
 * then needs nothing here.
 */
import { aliasedIssueId } from "./identifier-moves.js";
import type { Run, RunStatus } from "./run-store.js";
import type { WorkspaceStore } from "./store.js";
import type { StatusCategory } from "./types.js";

export interface RunIssue {
  issueId: string;
  identifier: string;
  title: string;
  status: string;
  /** The status's category (`active`, `review`, `done`, …); null for a status the vocabulary no longer has. */
  category: StatusCategory | null;
  kind: string;
}

export interface RunReferences {
  title: string;
  issues: RunIssue[];
}

/** An issue identifier as the tracker mints them: a prefix, a dash, a number. */
const IDENTIFIER = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;

/** The issue ids and identifiers anywhere in `value`. */
function collect(value: unknown, ids: Set<string>, identifiers: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (key === "issueId") ids.add(value);
    else if (IDENTIFIER.test(value)) identifiers.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, ids, identifiers, key);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) collect(child, ids, identifiers, childKey);
  }
}

interface IssueRow {
  id: string;
  identifier: string;
  title: string;
  status: string;
  kind: string;
  parent_id: string | null;
}

/** The run's name (see the file header), from its scope and tickets and those issues' rows. */
function runTitle(run: Pick<Run, "scope" | "tickets">, byId: ReadonlyMap<string, Pick<IssueRow, "title" | "parent_id">>): string {
  if (run.scope.kind !== "queue") return byId.get(run.scope.issueId)?.title ?? `${run.scope.identifier ?? "A deleted issue"}`;
  const names: string[] = [];
  for (const ticket of run.tickets) {
    const issue = byId.get(ticket.issueId);
    const parent = issue?.parent_id ? byId.get(issue.parent_id) : undefined;
    const name = parent?.title ?? issue?.title ?? ticket.identifier;
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return "The whole queue";
  return names.length === 1 ? `Queue: ${names[0]}` : `Queue: ${names[0]} and ${names.length - 1} more`;
}

/** The rows of the issues whose `column` is one of `values`, by id. */
function rowsWhere(store: WorkspaceStore, column: "id" | "identifier", values: readonly string[]): Map<string, IssueRow> {
  const rows = new Map<string, IssueRow>();
  if (values.length === 0) return rows;
  const found = store.db
    .prepare(`SELECT id, identifier, title, status, kind, parent_id FROM issues WHERE ${column} IN (${values.map(() => "?").join(", ")})`)
    .all(...values) as unknown as IssueRow[];
  for (const row of found) rows.set(row.id, row);
  return rows;
}

/** `rows` with the parents of the queue tickets in it, which a queue run is named after. */
function withParents(store: WorkspaceStore, rows: Map<string, IssueRow>, run: Pick<Run, "tickets">): Map<string, IssueRow> {
  const parents = [...new Set(run.tickets.flatMap((ticket) => rows.get(ticket.issueId)?.parent_id ?? []))].filter((id) => !rows.has(id));
  return new Map([...rows, ...rowsWhere(store, "id", parents)]);
}

/**
 * The run's name alone, for a surface that lists runs without their issues (the attention
 * list): the scope and the tickets' parents, two small reads.
 */
export function runName(store: WorkspaceStore, run: Pick<Run, "scope" | "tickets">): string {
  if (run.scope.kind !== "queue") return runTitle(run, rowsWhere(store, "id", [run.scope.issueId]));
  return runTitle(run, withParents(store, rowsWhere(store, "id", [...new Set(run.tickets.map((ticket) => ticket.issueId))]), run));
}

export function runReferences(store: WorkspaceStore, status: RunStatus): RunReferences {
  const ids = new Set<string>();
  const identifiers = new Set<string>();
  collect({ run: status.run, decision: status.decision, facts: status.facts, goal: status.goal }, ids, identifiers);
  if (status.run.scope.kind !== "queue") ids.add(status.run.scope.issueId);

  // An identifier the run recorded for a ticket it took means THAT ticket, which its issueId
  // already names: after a renumber another issue may hold the number, and is not the ticket.
  const taken = new Set(status.run.tickets.map((ticket) => ticket.identifier));
  const byId = rowsWhere(store, "id", [...ids]);
  const known = new Set([...byId.values()].map((row) => row.identifier));
  const asked = [...identifiers].filter((ref) => !known.has(ref) && !taken.has(ref));
  const byIdentifier = rowsWhere(store, "identifier", asked);
  // One nobody holds any more is the issue that moved off it, if it still exists.
  const held = new Set([...byIdentifier.values()].map((row) => row.identifier));
  const moved = asked.filter((ref) => !held.has(ref)).flatMap((ref) => aliasedIssueId(store.db, ref) ?? []);
  const rows = withParents(store, new Map([...byId, ...byIdentifier, ...rowsWhere(store, "id", moved)]), status.run);

  const issues = [...rows.values()].map((row) => ({
    issueId: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    category: store.categoryOf(row.status),
    kind: row.kind,
  }));
  return { title: runTitle(status.run, rows), issues };
}
