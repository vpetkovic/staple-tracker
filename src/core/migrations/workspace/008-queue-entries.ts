import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 8 — the pickup queue (STA-167, R2b; contract in docs/queue.md).
 *
 * ## Why 8
 *
 * `docs/queue.md` was written when 006 was the latest and said "007 at the time
 * of writing; R2b takes whatever number is next at merge". 007 (milestones,
 * STA-172) merged first, so this is 008. The rule in `index.ts` still applies:
 * if another branch merges an 008 before this one, this renumbers to latest+1
 * and never skips ahead.
 *
 * ## Why one table and no columns on `issues`
 *
 * Being in the plan is not a property of an issue, it is a ROW IN A LIST — the
 * list has an order of its own, an author, a timestamp and a note, and most
 * issues are not in it. A `queue_rank` column on `issues` would have to be null
 * for nearly every row, would be rewritten by an unrelated `UPDATE issues`, and
 * would give the plan no place to record who put a row there. A side table
 * keyed by `issue_id` also gives the lifecycle its semantics for free:
 * `ON DELETE CASCADE` drops the entry when the issue is deleted, and nothing
 * else does — a rename, a status change and a re-parent all leave the row
 * exactly where it was, because the entry references `issues.id` and never the
 * identifier, the title or the parent.
 *
 * `PRIMARY KEY (issue_id)` is the "an issue appears at most once in the plan"
 * rule, so a second enqueue is a replay or a move rather than a duplicate.
 * `UNIQUE (rank)` plus a midpoint computed inside an immediate transaction is
 * what makes concurrent inserts unable to collide. `rank` is the sparse-integer
 * encoding migration 004 already uses for statuses and kinds and 007 uses for
 * milestone membership, with the queue's wider step of 1024 (docs/queue.md,
 * "Storage"); the shared implementation is `rankBetween` / `renumberedRanks` in
 * `src/core/milestones.ts`. There is no separate rank index: `UNIQUE (rank)`
 * already builds one, and every read of the plan is an `ORDER BY rank` it
 * covers.
 *
 * ## What it seeds: nothing
 *
 * The initial queue is EMPTY. An upgraded workspace behaves exactly as it did —
 * `inbox` READY is still the presentation sort — until a human queues something,
 * which is the whole point of the queue being explicit rather than derived. So
 * this migration creates one table and touches no existing row. The plan's
 * `meta.queue_revision` is lazy in the same spirit: absent means `0`, the row
 * appears on the first mutation, and a freshly initialised workspace still has
 * exactly the three `meta` keys `characterize-layout.test.ts` pins.
 */
export const migration: Migration = {
  version: 8,
  name: "queue-entries",
  up(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE queue_entries (
         issue_id TEXT    PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
         rank     INTEGER NOT NULL UNIQUE,
         added_by TEXT    NOT NULL,
         added_at TEXT    NOT NULL,
         note     TEXT
       )`,
    );
  },
};
