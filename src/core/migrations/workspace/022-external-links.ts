import type { Migration } from "../types.js";

/** Permanent provider identities and local associations. Credentials never live here. */
export const migration: Migration = {
  version: 22,
  name: "external-links",
  up(db) {
    db.exec(`
      CREATE TABLE external_resources (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        host TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        container_id TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull_request')),
        display_key TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        body TEXT,
        status_json TEXT,
        fetched_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider_id, host, scope_id, container_id, kind, remote_id)
      );
      CREATE TABLE external_links (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES external_resources(id),
        parent_resource_id TEXT REFERENCES external_resources(id),
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (issue_id, resource_id),
        CHECK (parent_resource_id IS NULL OR parent_resource_id <> resource_id)
      );
      CREATE INDEX external_links_resource_idx ON external_links(resource_id);
    `);
  },
};
