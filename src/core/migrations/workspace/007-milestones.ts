import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 7 — milestones (STA-172, R3b; contract in docs/milestones.md).
 *
 * ## Why 7
 *
 * Latest on master is 006 (approval gates) and this is the next number the
 * dispatch assigned. The rule in `index.ts` still applies: if another branch
 * merges a 007 first, this one renumbers to latest+1 at merge time and never
 * skips ahead.
 *
 * ## Why two tables and not columns on `issues`
 *
 * A milestone is an ordinary issue of the reserved `milestone` kind; nothing
 * else marks it. Its two dates are meaningful on that one kind and null on
 * every other row, so they live in a side table keyed by `issue_id` rather
 * than widening `Issue` (and every `show` payload the contract tests pin) with
 * fields that are null nine times out of ten. `ON DELETE CASCADE` gives
 * deletion its semantics for free: deleting the milestone drops its metadata
 * and every membership row, and deleting a member drops only its own row.
 *
 * `milestone_members` is a RELATION, not a hierarchy: joining a milestone
 * touches nothing about the member — `parent_id`, `depth`, blockers, status,
 * claim and gate all stay where they were. `PRIMARY KEY (issue_id)` is the
 * "one direct milestone per issue" rule; `UNIQUE (milestone_id, rank)` plus a
 * midpoint computed inside an immediate transaction is what makes concurrent
 * inserts unable to collide. `rank` is the queue's sparse-integer encoding
 * (docs/queue.md, "Storage"), and `members_revision` is the per-milestone CAS
 * base every membership mutation bumps.
 *
 * The rows are created lazily — on the first `milestone set`, `milestone add`
 * or create-from-epic — so this migration creates the tables and seeds
 * nothing: every existing issue and every configured kind is preserved
 * untouched, and a milestone with no dates and no members is just an issue of
 * the `milestone` kind.
 */
export const migration: Migration = {
  version: 7,
  name: "milestones",
  up(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE milestone_meta (
         issue_id         TEXT    PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
         target_date      TEXT,
         start_date       TEXT,
         members_revision INTEGER NOT NULL DEFAULT 0,
         updated_at       TEXT    NOT NULL
       )`,
    );
    db.exec(
      `CREATE TABLE milestone_members (
         issue_id     TEXT    PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
         milestone_id TEXT    NOT NULL    REFERENCES issues(id) ON DELETE CASCADE,
         rank         INTEGER NOT NULL,
         added_by     TEXT    NOT NULL,
         added_at     TEXT    NOT NULL,
         note         TEXT,
         UNIQUE (milestone_id, rank)
       )`,
    );
    db.exec("CREATE INDEX milestone_members_milestone_idx ON milestone_members(milestone_id, rank)");
  },
};
