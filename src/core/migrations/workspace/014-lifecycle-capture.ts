import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 14: what closing the lifecycle capture gaps needs stored
 * (`docs/timing-semantics.md`).
 *
 * ## `attempts.role`, the attempt's lane
 *
 * `worker` is a tenure spent doing the work: every attempt a checkout, a steal, a re-claim or
 * a status write opens. `orchestrator` is a tenure spent coordinating it, opened only by
 * `staple attempt open --role orchestrator`. `workSeconds` sums the first lane and
 * `orchestrationSeconds` the second, and no attempt is in both. Every attempt that exists
 * before this migration was opened by a mutation that can only open a worker attempt, so
 * `worker` is the truth for all of them and the default says so. No CHECK: a value from a
 * newer build is preserved verbatim (`docs/sync.md`, the unknown-field rule), and a reader
 * treats anything other than `orchestrator` as the worker lane.
 *
 * ## `events.origin_device` and `events.origin_seq`, one order on every device
 *
 * A pulled operation re-emits its events dated at the origin's instant (`cloud/reemit.ts`), so
 * the timing replay orders by time. Two events of one issue in the same millisecond need a
 * tie-break every device computes alike, and the local `seq` is not one. Each event records
 * the device that wrote it first and that device's `seq` for it: a local event its own device
 * (null on an unconnected one) and no `origin_seq` (its own `seq` stands in), a re-emitted one
 * the origin's. The replay orders by `(created_at, origin_device, origin_seq or seq)`. Events
 * never replicate, so these columns are this device's own record.
 *
 * ## `sync_conflicts.decided_seq`
 *
 * The log position of the decision a record holds. Two devices can resolve one record offline
 * to different values; every device keeps the decision with the higher seq, a device whose own
 * decision lost included, so the rows converge (`applyConflictOperation`).
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
  name: "lifecycle-capture",
  up(db: DatabaseSync): void {
    db.exec(`ALTER TABLE attempts ADD COLUMN role TEXT NOT NULL DEFAULT 'worker'`);
    db.exec(`ALTER TABLE events ADD COLUMN origin_device TEXT`);
    db.exec(`ALTER TABLE events ADD COLUMN origin_seq INTEGER`);
    db.exec(`ALTER TABLE sync_conflicts ADD COLUMN decided_seq INTEGER`);
  },
};
