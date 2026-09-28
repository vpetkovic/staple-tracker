import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 16: milestone goal mode (`src/core/milestone-goal.ts`, docs/runs.md "Goal mode").
 *
 * ## Criterion marks
 *
 * `milestone_criterion_marks` holds one row per judged criterion of a milestone: the
 * verdict an agent marked (`met`, `unmet` or `unknown`), the evidence it cited, who marked
 * it, from which run, and when. The criteria themselves are the milestone issue's own
 * `acceptance_criteria`, which already exist and already replicate; only the judgement is
 * new. A row is keyed by the criterion's 1-based position and keeps the TEXT it judged, so
 * a criterion reworded after it was marked reads `unknown` again instead of inheriting a
 * verdict about different words. No foreign key: like a run, a mark is a record of what
 * was judged, and the milestone's deletion leaves nothing that reads it.
 *
 * ## Three run columns
 *
 * A run over a milestone is a goal run. `goal_gate_owner` is the person the milestone is
 * gated to, `goal_child_cap` how many tickets the run may create itself (goal checks and
 * follow-ups), and `goal_gated_at` the `gate_requested_at` of the gate the run itself
 * opened, which is how the stop rules tell the run's own gate from one a person opened.
 * All three are null on a queue or epic run.
 *
 * ## What replicates
 *
 * The marks do: each is the milestone entity's field `criterion<n>` on the wire (docs/sync.md,
 * "What synchronizes"), so no new sync entity and no protocol change. The run columns do not:
 * like the run tables of 015, they describe which agent loops on this machine.
 *
 * ## Why a migration
 *
 * A verdict per criterion with its evidence is structured state the tracker judges on
 * every goal check; no existing table holds it (the issue's criteria are a JSON list of
 * strings, and documents are prose). Purely additive: one new table and three nullable
 * columns on `runs`, nothing seeded. As with 013 to 015, the number is the `schema` every
 * operation carries, so every device upgrades together.
 */
export const migration: Migration = {
  version: 16,
  name: "milestone-goals",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE runs ADD COLUMN goal_gate_owner TEXT;
      ALTER TABLE runs ADD COLUMN goal_child_cap INTEGER;
      ALTER TABLE runs ADD COLUMN goal_gated_at TEXT;

      CREATE TABLE milestone_criterion_marks (
        milestone_id TEXT    NOT NULL,
        position     INTEGER NOT NULL,
        criterion    TEXT    NOT NULL,
        verdict      TEXT    NOT NULL,
        evidence     TEXT    NOT NULL DEFAULT '[]',
        note         TEXT,
        marked_by    TEXT    NOT NULL,
        run_id       TEXT,
        marked_at    TEXT    NOT NULL,
        PRIMARY KEY (milestone_id, position)
      );
    `);
  },
};
