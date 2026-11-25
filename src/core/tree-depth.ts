/**
 * `issues.depth` is derived: a row's parent's depth plus one. A move writes the moved row's
 * depth from its new parent, and this carries the change down its subtree. Its own module,
 * importing only the depth cap, because the store's move and the sync applier (`cloud/apply.ts`) both need it.
 */
import type { DatabaseSync } from "node:sqlite";
import { MAX_TREE_DEPTH } from "./types.js";

/**
 * Re-derive the depth of every descendant of `rootId` from the root's stored depth. Bounded by
 * the depth cap, so a `parent_id` loop (two devices moving each under the other) cannot hang it.
 */
export function rederiveSubtreeDepths(db: DatabaseSync, rootId: string): void {
  db.prepare(
    `WITH RECURSIVE sub(id, depth, hops) AS (
       SELECT id, depth, 0 FROM issues WHERE id = ?
       UNION ALL
       SELECT i.id, sub.depth + 1, sub.hops + 1 FROM issues i JOIN sub ON i.parent_id = sub.id WHERE sub.hops < ?
     ),
     settled(id, depth) AS (SELECT id, MIN(depth) FROM sub GROUP BY id)
     UPDATE issues SET depth = (SELECT depth FROM settled WHERE settled.id = issues.id)
      WHERE id IN (SELECT id FROM settled WHERE id <> ?)
        AND depth IS NOT (SELECT depth FROM settled WHERE settled.id = issues.id)`,
  ).run(rootId, MAX_TREE_DEPTH, rootId);
}

/** How many levels sit below `rootId`: 0 for a leaf. Bounded as above. */
export function subtreeHeight(db: DatabaseSync, rootId: string): number {
  const row = db
    .prepare(
      `WITH RECURSIVE sub(id, hops) AS (
         SELECT id, 0 FROM issues WHERE id = ?
         UNION ALL
         SELECT i.id, sub.hops + 1 FROM issues i JOIN sub ON i.parent_id = sub.id WHERE sub.hops < ?
       )
       SELECT MAX(hops) AS height FROM sub`,
    )
    .get(rootId, MAX_TREE_DEPTH) as { height: number | null };
  return row.height ?? 0;
}
