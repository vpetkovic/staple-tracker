import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.js";
import { migrateHub, migrateWorkspace } from "../src/core/schema.js";
import { describeSchema } from "../src/core/migrations/runner.js";
import { normalizedSchema } from "../src/core/migrations/dump.js";
import { WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";
import { HUB_TARGET } from "../src/core/migrations/hub/index.js";
import { WorkspaceStore } from "../src/core/store.js";
import { FIXTURES, schemaObjects, withFixture } from "./fixtures/schema/support.js";

/**
 * Real old-format database files, walked forward.
 *
 * The fixtures in `test/fixtures/schema/` were written by running a PREFIX of
 * the migration list and then leaving them alone — they are artefacts, not
 * reconstructions. A test that rebuilds "what v1 looked like" from today's
 * source drifts with today's source and stops being evidence about the files
 * already sitting on people's disks. These are copied to a temp directory
 * before every open, so the checked-in originals never get upgraded.
 *
 * The bar for each: the schema ends up identical to a fresh database, the rows
 * survive untouched, the new guarantees work on the upgraded file, and doing it
 * again changes nothing.
 */

/** The schema a database created today has — the target every upgrade converges on. */
function freshWorkspaceSchema(): string {
  const db = new DatabaseSync(":memory:");
  try {
    migrateWorkspace(db);
    return normalizedSchema(db);
  } finally {
    db.close();
  }
}

function freshHubSchema(): string {
  const db = new DatabaseSync(":memory:");
  try {
    migrateHub(db);
    return normalizedSchema(db);
  } finally {
    db.close();
  }
}

describe.each([
  ["stamped '1'", FIXTURES.workspaceV1],
  ["present but never stamped", FIXTURES.workspaceV1Unstamped],
])("a v1 workspace (%s)", (_label, fixture) => {
  it("is detected as version 1 with migrations 2 and 3 pending", () => {
    withFixture(fixture, (path) => {
      const db = new DatabaseSync(path);
      try {
        const state = describeSchema(db, WORKSPACE_TARGET);
        expect(state.current).toBe(1);
        expect(state.latest).toBe(3);
        // Ordered and complete: a v1 file has to walk BOTH steps, and it has to
        // walk them in this order — 003 assumes 002 already ran. This list
        // grows by one every time a migration is appended, and that is the
        // point: a migration that never reaches an old file is the bug this
        // assertion exists to catch.
        expect(state.pending).toEqual([2, 3]);
      } finally {
        db.close();
      }
    });
  });

  it("walks forward to exactly the schema a fresh database has", () => {
    withFixture(fixture, (path) => {
      const db = openDb(path);
      try {
        migrateWorkspace(db);
        expect(normalizedSchema(db)).toBe(freshWorkspaceSchema());
      } finally {
        db.close();
      }
      // …and the object list matches the characterization pin, from the other
      // direction: an upgraded file is indistinguishable from an `init` one.
      expect(schemaObjects(path)).toContain("index:comments_idempotency_uq");
    });
  });

  it("keeps every row it had, in every table", () => {
    withFixture(fixture, (path) => {
      const db = openDb(path);
      try {
        migrateWorkspace(db);
        const store = new WorkspaceStore(db, "legacyrepo", "LEG");

        // Raw, not `listIssues()`: that filters to open statuses and LEG-2 is
        // done, and the question here is whether the ROWS survived.
        expect(db.prepare("SELECT identifier FROM issues ORDER BY identifier").all()).toEqual([
          { identifier: "LEG-1" },
          { identifier: "LEG-2" },
        ]);
        expect(store.listIssues().map((i) => i.identifier)).toEqual(["LEG-1"]);

        const parent = store.getIssue("LEG-1");
        expect(parent.title).toBe("Existing work");
        expect(parent.status).toBe("in_progress");
        expect(parent.statusVersion).toBe(3);
        expect(parent.assignee).toBe("claude");
        expect(parent.labels).toEqual(["legacy"]);

        const comments = store.listComments(parent.id);
        expect(comments).toHaveLength(1);
        expect(comments[0]!.body).toBe("historic note");
        // The column arrived empty for rows that predate it, rather than
        // defaulting to something that would collide with a real key later.
        expect(comments[0]!.idempotencyKey).toBeNull();

        expect(store.getDocument(parent.id, "plan")?.body).toBe("# Legacy plan");
        expect(
          (db.prepare("SELECT count(*) AS n FROM relations").get() as { n: number }).n,
        ).toBe(1);
        expect((db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("gains the guarantee migration 002 exists for", () => {
    withFixture(fixture, (path) => {
      const db = openDb(path);
      try {
        migrateWorkspace(db);
        const store = new WorkspaceStore(db, "legacyrepo", "LEG");
        const issue = store.getIssue("LEG-1");

        const first = store.addCommentResult(issue.id, "retry me", "claude", "agent", {
          idempotencyKey: "r1",
        });
        const retry = store.addCommentResult(issue.id, "retry me", "claude", "agent", {
          idempotencyKey: "r1",
        });
        expect(retry.replayed).toBe(true);
        expect(retry.comment.id).toBe(first.comment.id);
        expect(store.listComments(issue.id)).toHaveLength(2); // historic + one new
      } finally {
        db.close();
      }
    });
  });

  it("is stamped '3' as TEXT, the representation an old binary can still read", () => {
    withFixture(fixture, (path) => {
      const db = openDb(path);
      try {
        migrateWorkspace(db);
        const row = db
          .prepare("SELECT typeof(value) AS t, value FROM meta WHERE key='schema_version'")
          .get() as { t: string; value: string };
        // TEXT is the load-bearing half of this assertion, not the number: an
        // older binary reads the stamp as a string, and an INTEGER here would
        // make it unreadable rather than merely too new.
        expect(row).toEqual({ t: "text", value: "3" });
      } finally {
        db.close();
      }
    });
  });

  it("reopens as a no-op — schema and data byte-stable across four opens", () => {
    withFixture(fixture, (path) => {
      let schema = "";
      let commentCount = 0;
      for (let i = 0; i < 4; i += 1) {
        const db = openDb(path);
        try {
          migrateWorkspace(db);
          const next = normalizedSchema(db);
          const count = (db.prepare("SELECT count(*) AS n FROM comments").get() as { n: number }).n;
          if (i === 0) {
            schema = next;
            commentCount = count;
          } else {
            expect(next).toBe(schema);
            expect(count).toBe(commentCount);
          }
        } finally {
          db.close();
        }
      }
    });
  });
});

/**
 * STA-81: this fixture is now the PRE-ESTIMATE artefact.
 *
 * It was written by walking migrations 001 and 002 and then left alone, so it is
 * a real file from before `estimated_seconds` existed — exactly the kind of
 * database sitting in repos that adopted staple before this feature landed. What
 * matters is not that it upgrades, but that upgrading it leaves every row it
 * already had untouched and every issue correctly reading as UN-estimated rather
 * than estimated-at-zero.
 */
describe("a v2 workspace — the last shape before estimates", () => {
  it("is detected as version 2 with migration 3 pending", () => {
    withFixture(FIXTURES.workspaceV2, (path) => {
      const db = new DatabaseSync(path);
      try {
        expect(describeSchema(db, WORKSPACE_TARGET)).toEqual({
          current: 2,
          latest: 3,
          pending: [3],
          detection: "stamped",
        });
      } finally {
        db.close();
      }
    });
  });

  it("has no estimate column at all before the walk", () => {
    withFixture(FIXTURES.workspaceV2, (path) => {
      const db = new DatabaseSync(path);
      try {
        const columns = (
          db.prepare("PRAGMA table_info(issues)").all() as unknown as Array<{ name: string }>
        ).map((c) => c.name);
        expect(columns).not.toContain("estimated_seconds");
      } finally {
        db.close();
      }
    });
  });

  it("walks forward keeping every existing row, with estimates NULL not zero", () => {
    withFixture(FIXTURES.workspaceV2, (path) => {
      const before = schemaObjects(path);
      const db = openDb(path);
      try {
        migrateWorkspace(db);
        const store = new WorkspaceStore(db, "legacyrepo", "LEG");
        const issue = store.getIssue("LEG-1");

        // Everything the fixture carried is still exactly as it was.
        expect(store.listComments(issue.id)[0]!.idempotencyKey).toBe("seed-key-1");
        expect(issue.title).toBe("Existing work");
        expect(issue.status).toBe("in_progress");

        // The whole reason the column is nullable with no DEFAULT: a task
        // written before estimates existed has NO estimate, which is a different
        // fact from "estimated at 0" and must not be reported as one.
        expect(issue.estimatedSeconds).toBeNull();
        for (const row of store.listIssues({ includeResolved: true })) {
          expect(row.estimatedSeconds).toBeNull();
        }

        // Derived timing works on the upgraded file: LEG-1 is in_progress with
        // a started_at, LEG-2 is done but was never started.
        const timing = store.timing("LEG-1");
        expect(timing.estimatedSeconds).toBeNull();
        expect(timing.childCount).toBe(1);
        expect(timing.childrenEstimatedSeconds).toBeNull();
        expect(store.timing("LEG-2").activeSeconds).toBeNull();
        /**
         * STA-90: this legacy fixture is exactly the case the fallback exists
         * for. Its rows were written by hand with no event log at all, so the
         * interval replay has nothing to replay and the struct must SAY the
         * number is approximate rather than quietly reporting a reconstructed
         * figure it did not reconstruct. A migrated-in workspace from another
         * tool lands here too.
         */
        expect(timing.approximate).toBe(true);
        expect(store.timing("LEG-2").approximate).toBe(true);

        // And the new write path lands on the old file.
        store.updateIssue("LEG-1", { estimatedSeconds: 5400 }, "vlad");
        expect(store.getIssue("LEG-1").estimatedSeconds).toBe(5400);
        expect(store.timing("LEG-1").estimatedSeconds).toBe(5400);
      } finally {
        db.close();
      }
      // ADD COLUMN appends to the stored CREATE text; it mints no new
      // sqlite_master entries, so the object list is untouched.
      expect(schemaObjects(path)).toEqual(before);
    });
  });

  it("reaches exactly the schema a fresh database has", () => {
    withFixture(FIXTURES.workspaceV2, (path) => {
      const db = openDb(path);
      try {
        migrateWorkspace(db);
        expect(normalizedSchema(db)).toBe(freshWorkspaceSchema());
      } finally {
        db.close();
      }
    });
  });
});

describe("a v2 workspace created by the SHIPPED pre-A4 fresh-create path", () => {
  /**
   * Version 2 shipped as two different physical layouts. The old code created a
   * fresh database from one `CREATE ... IF NOT EXISTS` blob with
   * `idempotency_key` declared inline in `comments`, while an UPGRADED database
   * got the same column appended by `ALTER TABLE`. Both stamped '2'. Databases
   * with each layout exist on disk right now.
   *
   * The runner must leave both alone. Rewriting a table to normalise column
   * order would be a far bigger risk — a full table copy under a write lock,
   * on live data — than the inconsistency it fixes, and nothing depends on the
   * order (every query in `store.ts` names its columns; `SELECT *` results are
   * read as objects). New databases converge on the walked layout from here on;
   * existing ones stay as they are.
   */
  it("takes the estimate migration without its old column order being disturbed", () => {
    withFixture(FIXTURES.workspaceV2LegacyDdl, (path) => {
      const before = schemaObjects(path);
      const db = openDb(path);
      try {
        // STA-81: this used to be `[]`. The legacy layout is still version 2, so
        // it walks 003 like any other v2 file — which is the point. A shape the
        // runner "recognises as current" must not become a shape it forgets to
        // migrate the moment a new column is appended.
        expect(describeSchema(db, WORKSPACE_TARGET).pending).toEqual([3]);
        expect(() => migrateWorkspace(db)).not.toThrow();

        // The layout really is the old one: idempotency_key sits in the middle.
        const columns = (
          db.prepare("PRAGMA table_info(comments)").all() as unknown as Array<{ name: string }>
        ).map((c) => c.name);
        expect(columns).toEqual([
          "id",
          "issue_id",
          "author",
          "author_type",
          "body",
          "idempotency_key",
          "deleted_at",
          "created_at",
        ]);
      } finally {
        db.close();
      }
      expect(schemaObjects(path)).toEqual(before);
    });
  });

  it("behaves identically to the walked layout for every guarantee that matters", () => {
    withFixture(FIXTURES.workspaceV2LegacyDdl, (path) => {
      const db = openDb(path);
      try {
        migrateWorkspace(db);
        const store = new WorkspaceStore(db, "legacyrepo", "LEG");
        const issue = store.getIssue("LEG-1");

        expect(store.listComments(issue.id)[0]!.idempotencyKey).toBe("seed-key-1");
        const first = store.addCommentResult(issue.id, "retry me", "claude", "agent", {
          idempotencyKey: "r1",
        });
        const retry = store.addCommentResult(issue.id, "retry me", "claude", "agent", {
          idempotencyKey: "r1",
        });
        expect(retry.comment.id).toBe(first.comment.id);
      } finally {
        db.close();
      }
    });
  });

  it("has the same object list as the walked layout, differing only in column order", () => {
    withFixture(FIXTURES.workspaceV2LegacyDdl, (legacy) => {
      withFixture(FIXTURES.workspaceV2, (walked) => {
        expect(schemaObjects(legacy)).toEqual(schemaObjects(walked));
      });
    });
  });
});

describe("a pre-A4 hub (no meta table at all)", () => {
  it("is detected as version 1, inferred from the sentinel table", () => {
    withFixture(FIXTURES.hubV1, (path) => {
      const db = new DatabaseSync(path);
      try {
        expect(describeSchema(db, HUB_TARGET)).toEqual({
          current: 1,
          latest: 2,
          pending: [2],
          detection: "unstamped",
        });
        // Nothing to read: this is the quirk A4 exists to close.
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").all(),
        ).toEqual([]);
      } finally {
        db.close();
      }
    });
  });

  it("gains meta and a version, and matches a fresh hub exactly", () => {
    withFixture(FIXTURES.hubV1, (path) => {
      const db = openDb(path);
      try {
        migrateHub(db);
        expect(normalizedSchema(db)).toBe(freshHubSchema());
        const row = db
          .prepare("SELECT typeof(value) AS t, value FROM meta WHERE key='schema_version'")
          .get() as { t: string; value: string };
        expect(row).toEqual({ t: "text", value: "2" });
      } finally {
        db.close();
      }
    });
  });

  it("keeps its registry, links, and events", () => {
    withFixture(FIXTURES.hubV1, (path) => {
      const db = openDb(path);
      try {
        migrateHub(db);
        expect(db.prepare("SELECT slug, prefix, kind FROM workspaces").all()).toEqual([
          { slug: "legacyrepo", prefix: "LEG", kind: "repo" },
        ]);
        expect(
          (db.prepare("SELECT count(*) AS n FROM cross_links").get() as { n: number }).n,
        ).toBe(1);
        expect(
          (db.prepare("SELECT count(*) AS n FROM hub_events").get() as { n: number }).n,
        ).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("reopens as a no-op", () => {
    withFixture(FIXTURES.hubV1, (path) => {
      const db = openDb(path);
      try {
        migrateHub(db);
        const schema = normalizedSchema(db);
        migrateHub(db);
        migrateHub(db);
        expect(normalizedSchema(db)).toBe(schema);
      } finally {
        db.close();
      }
    });
  });
});
