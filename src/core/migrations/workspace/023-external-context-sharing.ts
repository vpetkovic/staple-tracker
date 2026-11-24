import type { Migration } from "../types.js";

/** Private reads stay on this machine. Only explicitly shared context enters the log. */
export const migration: Migration = {
  version: 23,
  name: "external-context-sharing",
  up(db) {
    db.exec(`
      ALTER TABLE external_resources ADD COLUMN context_shared INTEGER NOT NULL DEFAULT 0 CHECK (context_shared IN (0,1));
      CREATE TABLE external_private_cache (
        resource_id TEXT PRIMARY KEY REFERENCES external_resources(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT,
        status_json TEXT,
        fetched_at TEXT NOT NULL
      );
      INSERT INTO external_private_cache (resource_id, title, body, status_json, fetched_at)
        SELECT id, title, body, status_json, fetched_at FROM external_resources WHERE title IS NOT NULL AND fetched_at IS NOT NULL;
      UPDATE external_resources SET title=NULL, body=NULL, status_json=NULL, fetched_at=NULL;
    `);
  },
};
