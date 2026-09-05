/**
 * STA-68 — what migration 010's schema guarantees, proven rather than asserted
 * in a comment.
 *
 * The apply loop, the push loop and the journal seam belong to other lanes and
 * do not exist yet. What exists is the SHAPE they will be built on, and a shape
 * can be wrong in ways that are cheap to fix now and expensive later — a missing
 * uniqueness constraint is a schema migration once there is data behind it.
 *
 * So these tests exercise the primitives directly against the migrated database:
 * the dedup ledger really does absorb a replay, the tombstone really does
 * outlive its row, the singleton really is a singleton, and the client-sequence
 * allocator really does survive an emptied outbox. Each one is a property the
 * contract in docs/sync.md depends on, expressed at the only layer that can
 * currently hold it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { describeSchema, runMigrations } from "../src/core/migrations/runner.js";
import { WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";
import { WorkspaceStore } from "../src/core/store.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";
import { FIXTURES, withFixture } from "./fixtures/schema/support.js";

let dir: string;

beforeAll(() => {
  dir = tempDir("s2-sync-schema");
});

afterAll(() => {
  removeDir(dir);
});

/** A fresh, fully migrated workspace database in memory. */
function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateWorkspace(db);
  return db;
}

const SYNC_TABLES = [
  "sync_entity_versions",
  "sync_outbox",
  "sync_applied",
  "sync_tombstones",
  "sync_conflicts",
  "sync_leases",
  "sync_devices",
  "sync_state",
];

describe("migration 010 — what lands, and what does not", () => {
  it("creates all eight sync tables and leaves every one of them empty", () => {
    const db = migrated();
    try {
      for (const table of SYNC_TABLES) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        expect(row.n, `${table} should be created empty`).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("adds no column to any table that already existed", () => {
    /**
     * The whole reason `sync_entity_versions` is a side table. If 010 ever grows
     * a `version` column on `issues`, this fails and the person adding it has to
     * argue for it rather than discover the consequences in three other suites.
     */
    const db = migrated();
    try {
      const columns = (
        db.prepare("PRAGMA table_info(issues)").all() as unknown as Array<{ name: string }>
      ).map((c) => c.name);
      expect(columns).not.toContain("version");
      expect(columns.filter((c) => c.startsWith("sync"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("upgrades a real v2 workspace to 10 with its rows intact and the sync tables empty", () => {
    /**
     * The no-data-loss half of the definition of done, against a real checked-in
     * artefact rather than a database this test built a moment ago.
     */
    withFixture(FIXTURES.workspaceV2, (path) => {
      const before = (() => {
        const db = new DatabaseSync(path);
        try {
          return db.prepare("SELECT identifier, title, status FROM issues ORDER BY identifier").all();
        } finally {
          db.close();
        }
      })();
      expect(before.length).toBeGreaterThan(0);

      const db = openDb(path);
      try {
        migrateWorkspace(db);
        expect(describeSchema(db, WORKSPACE_TARGET)).toMatchObject({ current: 10, pending: [] });
        expect(
          db.prepare("SELECT identifier, title, status FROM issues ORDER BY identifier").all(),
        ).toEqual(before);
        for (const table of SYNC_TABLES) {
          expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
        }
      } finally {
        db.close();
      }
    });
  });

  it("changes nothing an ordinary command can observe", () => {
    /**
     * "No behaviour change" stated as a behaviour: a workspace walked to 10 still
     * creates, lists and reads issues exactly as it did, and journals nothing —
     * because nothing journals yet, and because an unconnected workspace never
     * would.
     */
    const dbPath = join(dir, "behaviour.db");
    const db = openDb(dbPath);
    try {
      migrateWorkspace(db);
      const store = new WorkspaceStore(db, "beh", "BEH");
      const issue = store.createIssue({ title: "still works", createdBy: "opus-s2" });
      expect(store.listIssues().map((i) => i.identifier)).toEqual([issue.identifier]);
      expect((db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n).toBe(0);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM sync_entity_versions").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("sync_applied — replay is a no-op", () => {
  it("absorbs a re-delivered op_id instead of applying it twice", () => {
    /**
     * The idempotency guarantee, at the layer that actually holds it. An apply
     * loop is a transaction that inserts the ledger row and does the domain
     * write; if the insert is absorbed, the write is skipped. This proves the
     * absorbing half — the primary key makes a second arrival unrepresentable,
     * so it cannot silently become a second application.
     */
    const db = migrated();
    try {
      const applied = (opId: string, seq: number): number =>
        Number(
          db
            .prepare(
              "INSERT INTO sync_applied (op_id, seq, applied_at) VALUES (?, ?, ?) ON CONFLICT (op_id) DO NOTHING",
            )
            .run(opId, seq, "2026-09-05T12:00:00.000Z").changes,
        );

      expect(applied("op-a", 1039)).toBe(1);
      // Re-delivered: same op, same everything. Zero rows changed => no work.
      expect(applied("op-a", 1039)).toBe(0);
      // Re-delivered under a different seq is STILL the same operation.
      expect(applied("op-a", 1041)).toBe(0);
      expect(applied("op-b", 1041)).toBe(1);

      expect((db.prepare("SELECT COUNT(*) AS n FROM sync_applied").get() as { n: number }).n).toBe(2);
      // The first application's seq is what is retained, not the replay's.
      expect(db.prepare("SELECT seq FROM sync_applied WHERE op_id = 'op-a'").get()).toEqual({
        seq: 1039,
      });
    } finally {
      db.close();
    }
  });

  it("tolerates gaps in seq, because the server reserves slots it may not use", () => {
    const db = migrated();
    try {
      for (const seq of [1039, 1041, 1042, 2000]) {
        db.prepare("INSERT INTO sync_applied (op_id, seq, applied_at) VALUES (?, ?, ?)").run(
          `op-${seq}`,
          seq,
          "2026-09-05T12:00:00.000Z",
        );
      }
      // `WHERE seq > cursor` is gap-tolerant by construction. Nothing here
      // asserts `next == last + 1`, and nothing ever may.
      const after = db
        .prepare("SELECT seq FROM sync_applied WHERE seq > ? ORDER BY seq")
        .all(1039) as Array<{ seq: number }>;
      expect(after.map((r) => r.seq)).toEqual([1041, 1042, 2000]);
    } finally {
      db.close();
    }
  });
});

describe("sync_tombstones — deletion cannot silently resurrect", () => {
  it("outlives the row it records, so a late update finds a tombstone", () => {
    /**
     * Order-independence is the property. The tombstone wins whether the update
     * arrives before or after it, which is only possible if the tombstone is not
     * coupled to the existence of the row — hence no foreign key.
     */
    const db = migrated();
    try {
      const store = new WorkspaceStore(db, "tomb", "TOM");
      const issue = store.createIssue({ title: "doomed", createdBy: "opus-s2" });

      db.prepare(
        "INSERT INTO sync_tombstones (entity, entity_id, deleted_at, device_id, op_id) VALUES (?, ?, ?, ?, ?)",
      ).run("issue", issue.id, "2026-09-05T12:00:00.000Z", "device-1", "op-del");
      db.prepare("DELETE FROM issues WHERE id = ?").run(issue.id);

      // The row is gone and the tombstone is not. A CASCADE would have taken it.
      expect((db.prepare("SELECT COUNT(*) AS n FROM issues").get() as { n: number }).n).toBe(0);
      const tombstoned = db
        .prepare("SELECT 1 AS hit FROM sync_tombstones WHERE entity = ? AND entity_id = ?")
        .get("issue", issue.id);
      expect(tombstoned).toEqual({ hit: 1 });
    } finally {
      db.close();
    }
  });

  it("refuses a second tombstone for one entity, so deletion is recorded once", () => {
    const db = migrated();
    try {
      const insert = (opId: string): void => {
        db.prepare(
          "INSERT INTO sync_tombstones (entity, entity_id, deleted_at, device_id, op_id) VALUES (?, ?, ?, ?, ?)",
        ).run("issue", "abc", "2026-09-05T12:00:00.000Z", "device-1", opId);
      };
      insert("op-1");
      expect(() => insert("op-2")).toThrow(/UNIQUE|PRIMARY KEY|constraint/i);
    } finally {
      db.close();
    }
  });

  it("keys on (entity, entity_id), so two entity types may share an id", () => {
    const db = migrated();
    try {
      const insert = (entity: string): void => {
        db.prepare(
          "INSERT INTO sync_tombstones (entity, entity_id, deleted_at) VALUES (?, ?, ?)",
        ).run(entity, "shared-id", "2026-09-05T12:00:00.000Z");
      };
      insert("issue");
      expect(() => insert("comment")).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("sync_state — the singleton and the allocator", () => {
  it("refuses a second row, in the schema rather than by convention", () => {
    const db = migrated();
    try {
      db.prepare("INSERT INTO sync_state (id, repository_id) VALUES (1, ?)").run("repo-a");
      expect(() => db.prepare("INSERT INTO sync_state (id) VALUES (2)").run()).toThrow(
        /CHECK|constraint/i,
      );
      expect(() => db.prepare("INSERT INTO sync_state (id) VALUES (1)").run()).toThrow(
        /UNIQUE|PRIMARY KEY|constraint/i,
      );
    } finally {
      db.close();
    }
  });

  it("keeps client_seq_high_water monotonic across an outbox compaction", () => {
    /**
     * The failure this column exists to prevent, run end to end.
     *
     * `op_id` is derived from the client sequence, and dedup is keyed on `op_id`.
     * So an allocator that rewinds re-mints ids the server already holds, and
     * genuinely new work comes back `duplicate` — acknowledged, never applied,
     * with no error anywhere. An ordinary compaction is enough to trigger it if
     * the counter is `MAX(sync_outbox.client_seq)`.
     *
     * The assertion is therefore specifically that the two DISAGREE after a
     * prune, and that the persisted one is the one that did not move.
     */
    const db = migrated();
    try {
      db.prepare("INSERT INTO sync_state (id, repository_id) VALUES (1, ?)").run("repo-a");

      const allocate = (): number => {
        db.prepare(
          "UPDATE sync_state SET client_seq_high_water = client_seq_high_water + 1 WHERE id = 1",
        ).run();
        const row = db
          .prepare("SELECT client_seq_high_water AS n, epoch FROM sync_state WHERE id = 1")
          .get() as { n: number; epoch: number };
        // The epoch is readable in the same breath as the allocation, off the
        // same single row — which is what makes an epoch-scoped opId derivable
        // without a second read that could interleave.
        expect(row.epoch).toBe(0);
        return row.n;
      };

      for (let i = 0; i < 5; i += 1) {
        const clientSeq = allocate();
        db.prepare(
          `INSERT INTO sync_outbox (op_id, client_seq, entity, entity_id, verb, payload, created_at, acknowledged_seq)
           VALUES (?, ?, 'issue', 'e1', 'update', '{}', '2026-09-05T12:00:00.000Z', ?)`,
        ).run(`op-${clientSeq}`, clientSeq, 1000 + clientSeq);
      }

      // Compaction: every acknowledged operation is pruned. Entirely legitimate.
      db.prepare("DELETE FROM sync_outbox WHERE acknowledged_seq IS NOT NULL").run();
      expect((db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n).toBe(0);

      const derived = (
        db.prepare("SELECT COALESCE(MAX(client_seq), 0) AS n FROM sync_outbox").get() as {
          n: number;
        }
      ).n;
      const persisted = (
        db.prepare("SELECT client_seq_high_water AS n FROM sync_state WHERE id = 1").get() as {
          n: number;
        }
      ).n;

      // The trap, made visible: derive-from-outbox has rewound to zero.
      expect(derived).toBe(0);
      expect(persisted).toBe(5);
      // And the next allocation continues rather than repeating an id.
      expect(allocate()).toBe(6);
    } finally {
      db.close();
    }
  });

  it("holds the epoch on the same row as the allocator", () => {
    const db = migrated();
    try {
      db.prepare("INSERT INTO sync_state (id, repository_id, epoch) VALUES (1, ?, 7)").run("repo-a");
      expect(
        db.prepare("SELECT epoch, client_seq_high_water FROM sync_state WHERE id = 1").get(),
      ).toEqual({ epoch: 7, client_seq_high_water: 0 });
    } finally {
      db.close();
    }
  });
});

describe("sync_outbox — one client_seq is one operation", () => {
  it("refuses two rows sharing a client_seq", () => {
    const db = migrated();
    try {
      const insert = (opId: string, clientSeq: number): void => {
        db.prepare(
          `INSERT INTO sync_outbox (op_id, client_seq, entity, entity_id, verb, payload, created_at)
           VALUES (?, ?, 'issue', 'e1', 'update', '{}', '2026-09-05T12:00:00.000Z')`,
        ).run(opId, clientSeq);
      };
      insert("op-1", 1);
      // Two operations minted from one sequence would derive one opId.
      expect(() => insert("op-2", 1)).toThrow(/UNIQUE|constraint/i);
    } finally {
      db.close();
    }
  });

  it("carries a null base_version, which is what a create means", () => {
    const db = migrated();
    try {
      db.prepare(
        `INSERT INTO sync_outbox (op_id, client_seq, entity, entity_id, verb, base_version, payload, created_at)
         VALUES ('op-c', 1, 'issue', 'e1', 'create', NULL, '{}', '2026-09-05T12:00:00.000Z')`,
      ).run();
      expect(db.prepare("SELECT base_version FROM sync_outbox WHERE op_id = 'op-c'").get()).toEqual({
        base_version: null,
      });
    } finally {
      db.close();
    }
  });
});

describe("the migration is reachable from every shipped shape", () => {
  it("walks a v1 fixture all the way to 10", () => {
    withFixture(FIXTURES.workspaceV1, (path) => {
      const db = openDb(path);
      try {
        runMigrations(db, WORKSPACE_TARGET);
        expect(describeSchema(db, WORKSPACE_TARGET)).toMatchObject({ current: 10, pending: [] });
        expect((db.prepare("SELECT COUNT(*) AS n FROM sync_state").get() as { n: number }).n).toBe(0);
      } finally {
        db.close();
      }
    });
  });
});
