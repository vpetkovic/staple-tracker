/**
 * GENERATED — do not edit by hand.
 * Regenerate with: npx tsx scripts/regen-migration-snapshots.ts
 *
 * The `sqlite_master` dump of a hub database that walked migrations
 * 001, 002, 003, 004. Executed verbatim by the runner when — and only when —
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
, repository_id TEXT);

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

CREATE INDEX workspaces_repository_id_idx
  ON workspaces(repository_id) WHERE repository_id IS NOT NULL;

CREATE TABLE registry_optouts (
  repository_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'unregistered',
  created_at TEXT NOT NULL
);

CREATE TABLE cross_link_changes (
  link_key TEXT PRIMARY KEY,
  blocker_repository_id TEXT NOT NULL,
  blocker_identifier TEXT NOT NULL,
  blocked_repository_id TEXT NOT NULL,
  blocked_identifier TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  sent_epoch INTEGER,
  sent_version INTEGER,
  changed_at TEXT NOT NULL
);
`;
