/**
 * The identifier moves a workspace recorded, carried to this machine's hub.
 *
 * A workspace database and the hub are two files, and the code that moves an identifier —
 * the sync applier, the seed, a conflict resolution — holds only the first. So a move is
 * recorded in the workspace (`identifier-moves.ts`) and carried to the hub here, by the
 * caller that knows which staple home it is running in: the end of every sync, and every
 * resolution.
 *
 * Best effort, and never at the workspace's expense: a hub that cannot be opened right
 * now leaves the moves pending, and the next sync carries them. A home with no hub has no
 * cross-links to follow, so its moves are simply settled.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Hub } from "./hub.js";
import { pendingIdentifierMoves, settleIdentifierMoves } from "./identifier-moves.js";

export function carryIdentifierMovesToHub(db: DatabaseSync, home: string): number {
  const moves = pendingIdentifierMoves(db);
  if (moves.length === 0) return 0;
  if (!existsSync(join(home, "hub.db"))) {
    settleIdentifierMoves(db, moves.length);
    return 0;
  }
  const slug = (db.prepare("SELECT value FROM meta WHERE key = 'slug'").get() as { value: string } | undefined)?.value;
  if (!slug) {
    settleIdentifierMoves(db, moves.length);
    return 0;
  }
  let hub: Hub;
  try {
    hub = Hub.openAt(home);
  } catch {
    return 0;
  }
  try {
    const followed = hub.followIdentifierMoves(slug, moves);
    settleIdentifierMoves(db, moves.length);
    return followed;
  } catch {
    return 0;
  } finally {
    hub.close();
  }
}
