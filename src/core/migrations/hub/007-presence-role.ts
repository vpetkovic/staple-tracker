import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Hub version 7: the presence index records each attempt's lane (`role`), so the
 * concurrency context can report how many open attempts on this machine are workers and
 * how many are orchestrators (`docs/timing-semantics.md`, "The orchestrator lane").
 *
 * Both lanes still count toward the totals, because both spend provider budget; the split
 * is reported beside them. Rows written before this migration are all workers, which is
 * what every attempt opened before workspace migration 014 is.
 *
 * ## Why 7
 *
 * 006 (the presence index) is the latest, and this is the next number.
 */
export const migration: Migration = {
  version: 7,
  name: "presence-role",
  up(db: DatabaseSync): void {
    db.exec(`ALTER TABLE attempt_presence ADD COLUMN role TEXT NOT NULL DEFAULT 'worker'`);
  },
};
