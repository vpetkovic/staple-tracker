import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 15: autopilot runs (`src/core/run-store.ts`).
 *
 * ## Two tables
 *
 * `runs` holds one row per run: who drives it, over what scope, under which budget, in
 * which state, and why it ended. `run_tickets` holds one row per ticket the run took, in
 * the order it took them, with the outcome once one is recorded (null while the ticket
 * is still being worked). The failure streak and the ticket budget are read off it.
 *
 * `scope_key` is the scope as one comparable value (`queue`, or the scope issue's id), so
 * "one live run per actor per scope" is a partial UNIQUE index rather than a check a
 * racing second start could slip past. Live means `active` or `paused`: a paused run
 * still owns its scope. An ended run keeps its row, so its history and stop reason stay
 * readable.
 *
 * `scope_issue_id` has no foreign key: a run is a record of what happened, and it
 * outlives a scope issue somebody deletes. `run_tickets` does cascade from its run.
 *
 * ## Never replicated
 *
 * A run is a machine-local driver: which agent on which machine is looping over the
 * work. Neither table is a sync entity, so no mutation journals it and no pull writes
 * it. What another device sees of a run is its effect: the claims, statuses and attempts
 * its tickets produce, which replicate as they always did.
 *
 * ## Why 15, and what it costs
 *
 * 014 (the lifecycle work) is the latest. As with 013 and 014, the number is the `schema`
 * every operation carries, so an upgraded device stamps its operations 15 and an older
 * client refuses them with `schema_ahead`: every device upgrades together. Purely
 * additive: two new tables, no existing table touched, nothing seeded.
 */
export const migration: Migration = {
  version: 15,
  name: "autopilot-runs",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE runs (
        id              TEXT PRIMARY KEY,
        actor           TEXT NOT NULL,
        scope_kind      TEXT NOT NULL,
        scope_key       TEXT NOT NULL,
        scope_issue_id  TEXT,
        state           TEXT NOT NULL,
        max_tickets     INTEGER,
        until_at        TEXT,
        ceiling_percent REAL,
        ceiling_account TEXT,
        stop_reason     TEXT,
        stop_detail     TEXT NOT NULL DEFAULT '{}',
        stopped_by      TEXT,
        stop_note       TEXT,
        started_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        ended_at        TEXT
      );
      CREATE UNIQUE INDEX runs_live_scope_uq ON runs (actor, scope_key) WHERE state IN ('active', 'paused');
      CREATE INDEX runs_started_idx ON runs (started_at, id);

      CREATE TABLE run_tickets (
        run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        issue_id    TEXT NOT NULL,
        identifier  TEXT NOT NULL,
        taken_at    TEXT NOT NULL,
        outcome     TEXT,
        reason      TEXT,
        attempt_id  TEXT,
        recorded_at TEXT,
        PRIMARY KEY (run_id, seq)
      );
    `);
  },
};
