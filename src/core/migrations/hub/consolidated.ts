/**
 * GENERATED — do not edit by hand.
 * Regenerate with: npx tsx scripts/regen-migration-snapshots.ts
 *
 * The `sqlite_master` dump of a hub database that walked migrations
 * 001, 002. Executed verbatim by the runner when — and only when —
 * version detection proved the file has no tables at all.
 *
 * No `IF NOT EXISTS` anywhere, deliberately: reaching this text with tables
 * already present is a bug in the runner, and it should fail rather than
 * silently no-op. Statement order is SQLite's own creation order, so replaying
 * it recreates the internal `sqlite_autoindex_*` and `sqlite_sequence` rows at
 * the same points the walk did.
 */
export const CONSOLIDATED_DDL = `
CREATE TABLE workspaces (
  slug TEXT PRIMARY KEY,
  prefix TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'repo',
  added_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE cross_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_ws TEXT NOT NULL,
  blocker_identifier TEXT NOT NULL,
  blocked_ws TEXT NOT NULL,
  blocked_identifier TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'blocks',
  created_at TEXT NOT NULL,
  UNIQUE (blocker_ws, blocker_identifier, blocked_ws, blocked_identifier, type)
);

CREATE INDEX cross_links_blocked_idx ON cross_links(blocked_ws, blocked_identifier);

CREATE INDEX cross_links_blocker_idx ON cross_links(blocker_ws, blocker_identifier);

CREATE TABLE hub_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedup_key TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX hub_events_dedup_uq
  ON hub_events(dedup_key) WHERE dedup_key IS NOT NULL;

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
