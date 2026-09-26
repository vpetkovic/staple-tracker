import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Hub version 8: the readings an operator removed (`staple budget forget`,
 * docs/execution-telemetry.md, "Removing a reading").
 *
 * A removed reading has to stay removed. A reading's `dedup_key` is a hash over the
 * reading's own fields, its `observedAt` included, and a Codex rollout carries the
 * provider's timestamps. So when the collector reads a rollout again, which it does
 * after a lost cursor, it gets the same key a second time. A bare DELETE would let that
 * replay store the reading again. This table keeps the key of every forgotten reading,
 * and `BudgetStore.record` skips a reading whose key is here with reason `forgotten`.
 * A new observation has a new `observedAt`, so it gets a new key and is stored as
 * usual.
 *
 * Like the rest of the budget tables, this is machine state: it lives in `hub.db`,
 * never replicates, and nothing in the sync code reads it.
 *
 * ## Why 8
 *
 * 007 (the presence role) is the latest, and this is the next number.
 */
export const migration: Migration = {
  version: 8,
  name: "budget-forgotten",
  up(db: DatabaseSync): void {
    db.exec(`CREATE TABLE budget_forgotten (
  dedup_key TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL,
  forgotten_at TEXT NOT NULL
)`);
  },
};
