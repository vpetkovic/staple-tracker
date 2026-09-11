/**
 * Every time an issue's identifier changes, the old one is remembered.
 *
 * An identifier is a display allocation, not an identity (`docs/sync.md`: *"`issues.id` is
 * the sync identity of an issue … `issues.identifier` is a display allocation"*), and it
 * can change after people have started using it: sync renumbers an issue two devices
 * numbered alike, a joining workspace yields numbers the repository already uses, and a
 * conflict resolution moves an incumbent aside. By then the old identifier is in commit
 * messages, handoffs and hub cross-links, so a change that forgot it would turn every one
 * of those into a reference to nothing — or, worse, to whichever issue holds the number
 * next.
 *
 * So each move is recorded twice, in `meta`, which never synchronizes (every device makes
 * its own record of the moves it applied):
 *
 *   - `identifier_alias:<from>` — the issue the old identifier meant, consulted by lookups
 *     only when no issue holds that identifier any more. An identifier another issue now
 *     holds means that issue; the alias never overrules a live row.
 *   - `identifier_moves_pending` — the moves not yet carried to this machine's hub, whose
 *     cross-links name issues by identifier (`Hub.followIdentifierMoves`).
 *
 * Neither is a column or a table, on purpose: a workspace migration moves the schema
 * number every operation carries, and receivers refuse operations stamped above their own
 * schema — one bookkeeping table would make every older device refuse everything this
 * build sends.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./types.js";

export interface IdentifierMove {
  readonly issueId: string;
  readonly from: string;
  readonly to: string;
  readonly at: string;
}

const ALIAS_PREFIX = "identifier_alias:";
const PENDING_KEY = "identifier_moves_pending";

/**
 * Give an existing issue a new identifier, and remember the old one.
 *
 * The one writer of `issues.identifier` on an existing row, so that no path can move an
 * issue without leaving the alias and the hub record behind. A no-op when the issue
 * already carries `to`.
 */
export function moveIdentifier(db: DatabaseSync, issueId: string, to: string, at: string = nowIso()): IdentifierMove | null {
  const row = db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string } | undefined;
  if (!row || row.identifier === to) return null;
  db.prepare("UPDATE issues SET identifier = ? WHERE id = ?").run(to, issueId);
  const move = { issueId, from: row.identifier, to, at };
  recordIdentifierMove(db, move);
  return move;
}

/** Record a move that has already been written to `issues`. */
export function recordIdentifierMove(db: DatabaseSync, move: IdentifierMove): void {
  if (move.from === move.to) return;
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(`${ALIAS_PREFIX}${move.from}`, JSON.stringify({ issueId: move.issueId, to: move.to, at: move.at }));
  const pending = readPending(db);
  pending.push(move);
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PENDING_KEY, JSON.stringify(pending));
}

/**
 * The issue an identifier used to name, when no issue names it now.
 *
 * Follows a chain — `TST-2` moved to `TST-2+1`, which moved to `TST-9` — to the issue at the
 * end of it; the alias records the issue id, so the chain is one read however long it is.
 */
export function aliasedIssueId(db: DatabaseSync, identifier: string): string | null {
  const held = db.prepare("SELECT 1 AS hit FROM issues WHERE identifier = ?").get(identifier);
  if (held) return null;
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`${ALIAS_PREFIX}${identifier}`) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { issueId?: unknown };
    if (typeof parsed.issueId !== "string") return null;
    const exists = db.prepare("SELECT 1 AS hit FROM issues WHERE id = ?").get(parsed.issueId);
    return exists ? parsed.issueId : null;
  } catch {
    return null;
  }
}

/** Every move not yet carried to the hub, oldest first. */
export function pendingIdentifierMoves(db: DatabaseSync): IdentifierMove[] {
  return readPending(db);
}

/** Forget the first `count` pending moves, once the hub has them. */
export function settleIdentifierMoves(db: DatabaseSync, count: number): void {
  const rest = readPending(db).slice(count);
  if (rest.length === 0) {
    db.prepare("DELETE FROM meta WHERE key = ?").run(PENDING_KEY);
    return;
  }
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(rest), PENDING_KEY);
}

function readPending(db: DatabaseSync): IdentifierMove[] {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(PENDING_KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? (parsed as IdentifierMove[]) : [];
  } catch {
    return [];
  }
}
