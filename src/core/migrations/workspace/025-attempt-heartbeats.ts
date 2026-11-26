import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 25: the attempt heartbeat (`staple attempt heartbeat`, `design/execution-telemetry.md`,
 * "Heartbeat").
 *
 * One row per attempt: the newest instant its agent said the session is still alive. It is
 * upserted, never appended, so a session beating every minute for a day is still one row. A
 * claim's `lastActivityAt` reads it for the holder's open attempt (`WorkspaceStore.claimActivityFor`),
 * so a session that is working without writing anything stays live, and one that has exited
 * goes quiet.
 *
 * ## Never replicated
 *
 * Like `runs` (015), this is machine-local: no operation names it, no mutation journals it,
 * no pull writes it, and a heartbeat records no event and no transition. A heartbeat is a
 * statement about a process on this machine, and replicating one per beat would flood the
 * sync log and the timeline with nothing. Another device sees the claim by the holder's
 * synced writes, as before.
 *
 * No foreign key, as with `attempts`: the row is read only through a join on an open attempt,
 * so one left by an attempt that ended or was removed is simply never read.
 *
 * ## What it costs
 *
 * As with 015, the number is the `schema` every operation carries: an upgraded device stamps
 * its operations 25 and an older client refuses them with `schema_ahead`. Purely additive: one
 * new table, nothing seeded, no existing table touched.
 */
export const migration: Migration = {
  version: 25,
  name: "attempt-heartbeats",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE attempt_heartbeats (
        attempt_id TEXT PRIMARY KEY,
        at         TEXT NOT NULL
      );
    `);
  },
};
