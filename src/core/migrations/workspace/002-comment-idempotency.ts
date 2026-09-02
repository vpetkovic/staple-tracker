import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 2 — comment idempotency.
 *
 * A retried `add_comment` (agent crashes between the write and the ack, MCP
 * client resends) must not double-post. The key is scoped per issue, mirroring
 * `issues_idempotency_uq`.
 *
 * The index has to be created AFTER the column exists, which is the whole
 * reason the old `ADDED_COLUMNS` probe needed a separate `POST_MIGRATION_DDL`
 * block. Ordered migrations put both statements in one file, in order, where
 * the dependency is visible.
 */
export const migration: Migration = {
  version: 2,
  name: "comment-idempotency",
  up(db: DatabaseSync): void {
    db.exec("ALTER TABLE comments ADD COLUMN idempotency_key TEXT");
    db.exec(
      `CREATE UNIQUE INDEX comments_idempotency_uq
         ON comments(issue_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
    );
  },
};
