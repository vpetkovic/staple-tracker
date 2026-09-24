import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 5: provider limit windows and budget samples (docs/execution-telemetry.md,
 * "Limit windows" and "Budget samples").
 *
 * ## Why the hub and not the workspace
 *
 * A subscription belongs to an account, and an account spans every repository on the
 * machine. These rows are machine state: they live in `hub.db`, they never replicate,
 * and nothing in the sync code reads them. Copying them through a repository log would
 * send one person's subscription usage to every repository they connect.
 *
 * ## `limit_windows`: one instance of a provider limit
 *
 * A row is minted when the first sample of a new window instance is ingested. It is
 * keyed by `(provider, account_ref, limit_key)` and an absolute `resets_at`, and a
 * sample joins it when its own reset is within the tolerance. `superseded_by` is the one
 * field written after creation: the window that replaced this one before it reset, with
 * `superseded_reason` saying why (`reset_moved`). `label`, `status`, `first_sample_at`
 * and `last_sample_at` are derived at read from `window_seconds`, the clock and the
 * samples, so they have no columns.
 *
 * ## `budget_samples`: one reading
 *
 * Every sample is stored as reported: `used_percent` is never clamped or rounded, and a
 * reading lower than an earlier one in the same window stays as it is (regressions are
 * derived at read). `dedup_key` is the first 32 hex characters of the sha256 over the
 * contract's tuple, so replaying the same rollout stores nothing twice. `missing` is the
 * record's missingness map as JSON: every NULL measurable column has an entry there with
 * its reason, and a NULL never means zero.
 *
 * ## No CHECK on enumerations
 *
 * Only the two booleans are constrained. An enum value from a newer build (a new
 * `source_kind`, a new `confidence`) must be preserved and shown verbatim, never refused
 * or coerced, so the columns take any text.
 */
export const migration: Migration = {
  version: 5,
  name: "budget-samples",
  up(db: DatabaseSync): void {
    db.exec(`CREATE TABLE limit_windows (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  limit_key TEXT NOT NULL,
  window_seconds INTEGER,
  window_seconds_source TEXT,
  anchor TEXT NOT NULL DEFAULT 'unknown',
  resets_at TEXT,
  resets_at_source TEXT,
  starts_at TEXT,
  plan_tier TEXT,
  superseded_by TEXT REFERENCES limit_windows(id),
  superseded_reason TEXT,
  missing TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
)`);
    db.exec(`CREATE INDEX limit_windows_limit_idx
  ON limit_windows(provider, account_ref, limit_key, resets_at)`);
    db.exec(`CREATE TABLE budget_samples (
  id TEXT PRIMARY KEY,
  window_id TEXT REFERENCES limit_windows(id),
  provider TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  limit_key TEXT NOT NULL,
  unit TEXT NOT NULL,
  used_percent REAL,
  remaining_percent REAL,
  exceeded INTEGER CHECK (exceeded IN (0, 1)),
  resets_at TEXT,
  resets_at_source TEXT,
  window_seconds INTEGER,
  window_seconds_source TEXT,
  method TEXT NOT NULL,
  confidence TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_harness_version TEXT,
  source_field TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_at_source TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  attempt_id TEXT,
  session_ref TEXT,
  heartbeat INTEGER NOT NULL DEFAULT 0 CHECK (heartbeat IN (0, 1)),
  dedup_key TEXT NOT NULL UNIQUE,
  missing TEXT NOT NULL DEFAULT '{}'
)`);
    db.exec(`CREATE INDEX budget_samples_window_session_idx
  ON budget_samples(window_id, session_ref, observed_at)`);
    db.exec(`CREATE INDEX budget_samples_limit_idx
  ON budget_samples(provider, account_ref, limit_key, observed_at)`);
  },
};
