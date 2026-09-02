import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { normalizedSchema, replayableStatements, schemaRows } from "../src/core/migrations/dump.js";
import type { MigrationTarget } from "../src/core/migrations/types.js";
import { WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";
import { HUB_TARGET } from "../src/core/migrations/hub/index.js";

/**
 * The fresh-create fast path must be indistinguishable from the long way round.
 *
 * A new database executes a consolidated snapshot and stamps the latest
 * version, skipping the migration walk entirely. That is only safe if the two
 * paths land on the same schema — otherwise the product quietly ships two
 * different databases, one for new users and one for upgraded ones, and every
 * future migration has to handle both. Today's code already has that split (a
 * fresh `comments` table gets `idempotency_key` in the middle, a migrated one
 * gets it appended), which is exactly the drift this test exists to prevent
 * from ever happening again.
 */

function walked(target: MigrationTarget): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of [...target.migrations].sort((a, b) => a.version - b.version)) {
    migration.up(db);
  }
  return db;
}

function consolidated(target: MigrationTarget): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(target.consolidated);
  return db;
}

function regenerationHint(target: MigrationTarget): string {
  const db = walked(target);
  try {
    return (
      `\n\nThe consolidated snapshot for the ${target.label} has drifted from the ` +
      `migration list. Regenerate it:\n\n` +
      `    npx tsx scripts/regen-migration-snapshots.ts\n\n` +
      `Expected snapshot content:\n\n${replayableStatements(db).join("\n\n")}\n`
    );
  } finally {
    db.close();
  }
}

describe.each([
  ["workspace", WORKSPACE_TARGET],
  ["hub", HUB_TARGET],
] as const)("%s: consolidated vs walked", (_label, target) => {
  it("produces a byte-identical sqlite_master", () => {
    const a = walked(target);
    const b = consolidated(target);
    try {
      // Full rows, including the internal objects a lazier comparison would
      // drop: `sqlite_autoindex_*` proves the UNIQUE and PRIMARY KEY
      // constraints survived, `sqlite_sequence` proves AUTOINCREMENT did.
      expect(normalizedSchema(b), regenerationHint(target)).toBe(normalizedSchema(a));
    } finally {
      a.close();
      b.close();
    }
  });

  it("produces the same objects in the same creation order", () => {
    // Creation order is not semantically load-bearing, but a snapshot that
    // reorders statements is a snapshot somebody edited by hand.
    const a = walked(target);
    const b = consolidated(target);
    try {
      expect(schemaRows(b).map((r) => r.name)).toEqual(schemaRows(a).map((r) => r.name));
    } finally {
      a.close();
      b.close();
    }
  });

  it("produces identical column order, types, and nullability for every table", () => {
    // `sqlite_master` compares the stored CREATE text; `table_info` compares
    // what SQLite actually parsed out of it. Both, because a snapshot could in
    // principle match textually and still be read differently.
    const a = walked(target);
    const b = consolidated(target);
    try {
      const tables = schemaRows(a)
        .filter((r) => r.type === "table" && !r.name.startsWith("sqlite_"))
        .map((r) => r.name);
      expect(tables.length).toBeGreaterThan(0);

      for (const table of tables) {
        const info = (db: DatabaseSync) => db.prepare(`PRAGMA table_info(${table})`).all();
        expect(info(b), `table_info mismatch on ${table}`).toEqual(info(a));

        const fks = (db: DatabaseSync) => db.prepare(`PRAGMA foreign_key_list(${table})`).all();
        expect(fks(b), `foreign keys mismatch on ${table}`).toEqual(fks(a));

        const indexes = (db: DatabaseSync) => db.prepare(`PRAGMA index_list(${table})`).all();
        expect(indexes(b), `indexes mismatch on ${table}`).toEqual(indexes(a));
      }
    } finally {
      a.close();
      b.close();
    }
  });

  it("carries no IF NOT EXISTS, so it cannot silently no-op on a populated file", () => {
    // The runner only reaches the snapshot when detection proved the file has
    // no tables. If that guard ever regresses, the snapshot must fail loudly
    // rather than quietly leave an old schema in place.
    expect(target.consolidated).not.toMatch(/IF\s+NOT\s+EXISTS/i);

    const db = walked(target);
    try {
      expect(() => db.exec(target.consolidated)).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("the shape that makes this test necessary", () => {
  it("keeps the ALTER-appended tail SQLite itself wrote for comments", () => {
    /**
     * `ALTER TABLE ... ADD COLUMN` appends the new column to the stored CREATE
     * text rather than re-rendering the statement, so a walked v2 `comments`
     * table ends `created_at TEXT NOT NULL\n, idempotency_key TEXT)`. Nobody
     * would write that by hand — and that is the point. The snapshot is a dump
     * of SQLite's own text, so it matches by construction; hand-written
     * consolidated DDL would have drifted here on day one.
     */
    expect(WORKSPACE_TARGET.consolidated).toContain(", idempotency_key TEXT)");

    const db = consolidated(WORKSPACE_TARGET);
    try {
      const columns = (
        db.prepare("PRAGMA table_info(comments)").all() as unknown as Array<{ name: string }>
      ).map((c) => c.name);
      expect(columns).toEqual([
        "id",
        "issue_id",
        "author",
        "author_type",
        "body",
        "deleted_at",
        "created_at",
        "idempotency_key",
      ]);
    } finally {
      db.close();
    }
  });
});
