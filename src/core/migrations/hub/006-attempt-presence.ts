import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Hub version 6 — the machine-local presence index of execution attempts
 * (`docs/execution-telemetry.md`, "Concurrency context").
 *
 * Every attempt transition records how many attempts this machine started that are still
 * open, across every repository it works in, and how many of those spend from the same
 * account. Opening every registered workspace database on every transition would make one
 * transition cost as much as the number of repositories, so the hub keeps one row per
 * attempt opened on this machine and both counts are one indexed query.
 *
 * ## A cache, and machine state
 *
 * The workspace rows are the record; this table is derived from them and never
 * replicates. It is written after the workspace transaction commits, best effort and
 * outside the journal seam, from every change to an attempt this machine opened — a
 * pulled end and a stored orphan end included — and any command in a workspace refreshes
 * that workspace's rows. It stores open and ended, not the read-time orphan state, so the
 * counts it gives can be too high; the fields that carry them say `storedOpen`.
 *
 * ## Keyed by the registered slug
 *
 * `workspace` is the hub's own key for the workspace (`workspaces.slug`), so a row of a
 * workspace since unregistered is excluded by a join, and one whose database has moved
 * away by its registered path.
 *
 * ## Why 6
 *
 * 005 (limit windows and budget samples) is the latest, and this is the next number.
 */
export const migration: Migration = {
  version: 6,
  name: "attempt-presence",
  up(db: DatabaseSync): void {
    db.exec(`CREATE TABLE attempt_presence (
  workspace TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  account_ref TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (workspace, attempt_id)
)`);
    db.exec(`CREATE INDEX attempt_presence_open_idx ON attempt_presence (account_ref) WHERE ended_at IS NULL`);
  },
};
