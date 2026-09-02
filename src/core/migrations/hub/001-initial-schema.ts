import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 1 — the original hub schema: registry plus cross-workspace linking.
 * Derived state only; the authoritative slug/prefix live in each workspace file
 * and every hub read degrades gracefully when a registered file is missing.
 *
 * This is exactly what `migrateHub` execed before A4, and exactly what a hub
 * database on disk today contains — note there is no `meta` table, which is why
 * version detection treats "has `workspaces`, has no version row" as version 1.
 * `test/fixtures/schema/hub-v1.sqlite` is generated from this file.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS workspaces (
  slug TEXT PRIMARY KEY,
  prefix TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'repo',
  added_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS cross_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_ws TEXT NOT NULL,
  blocker_identifier TEXT NOT NULL,
  blocked_ws TEXT NOT NULL,
  blocked_identifier TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'blocks',
  created_at TEXT NOT NULL,
  UNIQUE (blocker_ws, blocker_identifier, blocked_ws, blocked_identifier, type)
);
CREATE INDEX IF NOT EXISTS cross_links_blocked_idx ON cross_links(blocked_ws, blocked_identifier);
CREATE INDEX IF NOT EXISTS cross_links_blocker_idx ON cross_links(blocker_ws, blocker_identifier);

CREATE TABLE IF NOT EXISTS hub_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedup_key TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS hub_events_dedup_uq
  ON hub_events(dedup_key) WHERE dedup_key IS NOT NULL;
`;

export const migration: Migration = {
  version: 1,
  name: "initial-schema",
  up(db: DatabaseSync): void {
    db.exec(DDL);
  },
};
