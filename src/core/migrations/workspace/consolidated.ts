/**
 * GENERATED — do not edit by hand.
 * Regenerate with: npx tsx scripts/regen-migration-snapshots.ts
 *
 * The `sqlite_master` dump of a workspace database that walked migrations
 * 001, 002, 003, 004, 005. Executed verbatim by the runner when — and only when —
 * version detection proved the file has no tables at all.
 *
 * No `IF NOT EXISTS` anywhere, deliberately: reaching this text with tables
 * already present is a bug in the runner, and it should fail rather than
 * silently no-op. Statement order is SQLite's own creation order, so replaying
 * it recreates the internal `sqlite_autoindex_*` and `sqlite_sequence` rows at
 * the same points the walk did.
 */
export const CONSOLIDATED_DDL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  status_version INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'medium',
  parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  assignee TEXT,
  created_by TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria TEXT,
  block_parent_until_done INTEGER NOT NULL DEFAULT 0,
  unblock_owner TEXT,
  unblock_action TEXT,
  origin_kind TEXT NOT NULL DEFAULT 'manual',
  origin_id TEXT,
  idempotency_key TEXT,
  checkout_agent TEXT,
  checkout_at TEXT,
  blocked_transition_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, estimated_seconds INTEGER, kind TEXT NOT NULL DEFAULT 'task');

CREATE UNIQUE INDEX issues_idempotency_uq
  ON issues(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX issues_normalized_title_open_idx
  ON issues(normalized_title) WHERE status NOT IN ('done','cancelled');

CREATE UNIQUE INDEX issues_live_origin_uq
  ON issues(origin_kind, origin_id)
  WHERE origin_kind <> 'manual' AND origin_id IS NOT NULL
    AND status NOT IN ('done','cancelled');

CREATE INDEX issues_status_idx ON issues(status);

CREATE INDEX issues_parent_idx ON issues(parent_id);

CREATE INDEX issues_assignee_status_idx ON issues(assignee, status);

CREATE INDEX issues_updated_idx ON issues(updated_at);

CREATE TABLE relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'blocks',
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (blocker_id, blocked_id, type)
);

CREATE INDEX relations_blocked_idx ON relations(blocked_id);

CREATE INDEX relations_blocker_idx ON relations(blocker_id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'user',
  body TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL
, idempotency_key TEXT);

CREATE INDEX comments_issue_idx ON comments(issue_id, created_at);

CREATE TABLE documents (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  title TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, key)
);

CREATE TABLE document_revisions (
  issue_id TEXT NOT NULL,
  key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  author TEXT,
  change_summary TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, key, revision)
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  issue_id TEXT,
  actor TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  dedup_key TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX events_dedup_uq
  ON events(dedup_key) WHERE dedup_key IS NOT NULL;

CREATE INDEX events_issue_idx ON events(issue_id, seq);

CREATE UNIQUE INDEX comments_idempotency_uq
         ON comments(issue_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE workspace_statuses (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX workspace_statuses_order_idx ON workspace_statuses(sort_order);

CREATE TABLE workspace_kinds (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX workspace_kinds_order_idx ON workspace_kinds(sort_order);
`;
