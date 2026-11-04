import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 18: a typed file on an issue (`design/sync.md`, "Attachments").
 *
 * Two tables. `attachments` is the metadata and it is the `attachment` entity:
 * filename, sniffed media type, size, SHA-256, author, caption, whether the bytes
 * travel (`inline` or `local`), and when it was attached. `attachment_bytes` is the
 * bytes, keyed by the hash, and it does not travel as a table. An inlined file's
 * bytes ride inside the create operation; a local file's bytes stay on the device
 * that attached it. The trigger drops a blob once nothing names its hash, including
 * when the issue it hung from is deleted and the attachment cascades away.
 *
 * Additive. The number is the `schema` every operation carries, so a device that
 * has not migrated refuses a page stamped 18 with `schema_ahead`. Protocol 4 is
 * what admits the entity itself.
 */
export const migration: Migration = {
  version: 18,
  name: "attachments",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        author TEXT,
        caption TEXT,
        byte_sync TEXT NOT NULL CHECK (byte_sync IN ('inline', 'local')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX attachments_issue_idx ON attachments(issue_id);
      CREATE INDEX attachments_sha_idx ON attachments(sha256);

      CREATE TABLE attachment_bytes (
        sha256 TEXT PRIMARY KEY,
        bytes BLOB NOT NULL
      );

      CREATE TRIGGER attachments_drop_bytes
      AFTER DELETE ON attachments
      WHEN NOT EXISTS (SELECT 1 FROM attachments WHERE sha256 = OLD.sha256)
      BEGIN
        DELETE FROM attachment_bytes WHERE sha256 = OLD.sha256;
      END;
    `);
  },
};
