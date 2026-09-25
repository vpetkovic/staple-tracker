import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 14: the attempt's lane, `attempts.role` (`docs/timing-semantics.md`, "The
 * orchestrator lane", and Q1 there).
 *
 * `worker` is a tenure spent doing the work: every attempt a checkout, a steal, a re-claim
 * or a status write opens. `orchestrator` is a tenure spent coordinating it, opened only
 * by `staple attempt open --role orchestrator`. `workSeconds` sums the first lane and
 * `orchestrationSeconds` the second, and no attempt is in both.
 *
 * ## One column, defaulted
 *
 * Every attempt that exists before this migration was opened by a mutation that can only
 * open a worker attempt, so `worker` is the truth for all of them and the default says so.
 * No CHECK: a value from a newer build is preserved verbatim (`docs/sync.md`, the
 * unknown-field rule), and a reader treats anything other than `orchestrator` as the
 * worker lane.
 *
 * ## Why 14, and what it costs
 *
 * 013 (execution attempts) is the latest. The number is the `schema` every operation
 * carries, so an upgraded device stamps its operations 14 and an older client refuses the
 * first page holding one with `schema_ahead`: every device upgrades together, as it did
 * for 013. The attempt create payload gains `role`; the service stores it verbatim.
 */
export const migration: Migration = {
  version: 14,
  name: "attempt-role",
  up(db: DatabaseSync): void {
    db.exec(`ALTER TABLE attempts ADD COLUMN role TEXT NOT NULL DEFAULT 'worker'`);
  },
};
