import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 1 — the original workspace schema.
 *
 * A trimmed port of Paperclip's issue tables: same semantics, ~10 tables
 * instead of 122. jsonb -> TEXT JSON, trigram search -> LIKE (FTS5 later),
 * FOR UPDATE -> BEGIN IMMEDIATE + single-statement claims.
 *
 * This is the schema as it shipped, reconstructed exactly: `comments` has NO
 * `idempotency_key` and there is no `comments_idempotency_uq`. Those arrive in
 * 002. Do not "tidy" this file — a v1 database in the wild was created by this
 * text, and `test/fixtures/schema/workspace-v1.sqlite` is generated from it.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS issues_idempotency_uq
  ON issues(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Open-issue duplicate guard support (checked in-transaction; index keeps it fast)
CREATE INDEX IF NOT EXISTS issues_normalized_title_open_idx
  ON issues(normalized_title) WHERE status NOT IN ('done','cancelled');
-- One live machine-origin issue per source (Paperclip's origin dedup pattern)
CREATE UNIQUE INDEX IF NOT EXISTS issues_live_origin_uq
  ON issues(origin_kind, origin_id)
  WHERE origin_kind <> 'manual' AND origin_id IS NOT NULL
    AND status NOT IN ('done','cancelled');
CREATE INDEX IF NOT EXISTS issues_status_idx ON issues(status);
CREATE INDEX IF NOT EXISTS issues_parent_idx ON issues(parent_id);
CREATE INDEX IF NOT EXISTS issues_assignee_status_idx ON issues(assignee, status);
CREATE INDEX IF NOT EXISTS issues_updated_idx ON issues(updated_at);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'blocks',
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (blocker_id, blocked_id, type)
);
CREATE INDEX IF NOT EXISTS relations_blocked_idx ON relations(blocked_id);
CREATE INDEX IF NOT EXISTS relations_blocker_idx ON relations(blocker_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'user',
  body TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_issue_idx ON comments(issue_id, created_at);

CREATE TABLE IF NOT EXISTS documents (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  title TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, key)
);

CREATE TABLE IF NOT EXISTS document_revisions (
  issue_id TEXT NOT NULL,
  key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  author TEXT,
  change_summary TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, key, revision)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  issue_id TEXT,
  actor TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  dedup_key TEXT,
  created_at TEXT NOT NULL
);
-- Level-triggered wake dedup (Paperclip's issue-dependency-wakeups key idea)
CREATE UNIQUE INDEX IF NOT EXISTS events_dedup_uq
  ON events(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_issue_idx ON events(issue_id, seq);
`;

export const migration: Migration = {
  version: 1,
  name: "initial-schema",
  up(db: DatabaseSync): void {
    db.exec(DDL);
  },
};
