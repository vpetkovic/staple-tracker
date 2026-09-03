import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";
import { initWorkspace } from "../src/core/workspace.js";
import { DEFAULT_ISSUE_KIND, ISSUE_KINDS, KIND_RANK } from "../src/core/types.js";

/**
 * O1a (STA-124) — every issue declares a KIND.
 *
 * O7a made the kind VOCABULARY data (`workspace_kinds`). This ticket adds the
 * column that points into it, and the two claims worth testing are these:
 *
 * 1. Validation goes through the workspace's CONFIGURATION, not through a
 *    compile-time union. The proof is not reading the source — it is adding a
 *    kind the code has never heard of (`milestone`, which is what this ticket's
 *    own comment thread asked for) and watching create, update and filter all
 *    accept it. If any of them had a five-way literal left in it, that goes red.
 *
 * 2. Kind is DECLARED, not derived. Migration 005 backfills parents to `epic`
 *    ONCE, against rows that existed when it ran; after that a task that grows
 *    children stays a task. Both halves are tested, because the interesting bug
 *    is a recompute somebody adds later that quietly makes the first half look
 *    like a live rule.
 */

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
beforeEach(() => {
  store = memStore();
});

// --------------------------------------------------------------- the column

describe("the kind column", () => {
  it("defaults to task, and every seeded kind is accepted", () => {
    expect(store.createIssue({ title: "unlabelled" }).kind).toBe(DEFAULT_ISSUE_KIND);
    for (const kind of ISSUE_KINDS) {
      expect(store.createIssue({ title: `a ${kind}`, kind }).kind).toBe(kind);
    }
  });

  it("refuses a kind this workspace has not configured, naming the valid set", () => {
    expect(() => store.createIssue({ title: "nope", kind: "epicc" })).toThrowError(
      /Unknown kind "epicc".*epic, task, bug, chore, spike/s,
    );
    const issue = store.createIssue({ title: "real" });
    expect(() => store.updateIssue(issue.identifier, { kind: "saga" })).toThrowError(/Unknown kind "saga"/);
  });

  it("refuses BEFORE consuming an issue number, like status and priority do", () => {
    store.createIssue({ title: "first" });
    expect(() => store.createIssue({ title: "doomed", kind: "nonsense" })).toThrow();
    // The next good create takes -2, not -3: the rejected one never reached the
    // transaction that allocates a number.
    expect(store.createIssue({ title: "second" }).identifier).toBe("TST-2");
  });

  it("is re-declarable, and leaves the kind alone when the patch omits it", () => {
    const issue = store.createIssue({ title: "shifting", kind: "spike" });
    expect(store.updateIssue(issue.identifier, { kind: "bug" }).kind).toBe("bug");
    expect(store.updateIssue(issue.identifier, { title: "renamed" }).kind).toBe("bug");
  });
});

// -------------------------------------------------- configuration, not a union

describe("kind validation follows the workspace's configuration", () => {
  it("accepts a kind the code has never heard of, once it is configured", () => {
    // The ask on STA-124: "I want to add milestone as a kind." No code change.
    store.addKind({ id: "milestone", label: "Milestone" });
    const issue = store.createIssue({ title: "GA", kind: "milestone" });
    expect(issue.kind).toBe("milestone");
    expect(store.listIssues({ kind: ["milestone"] }).map((i) => i.identifier)).toEqual([
      issue.identifier,
    ]);
    expect(store.kindUsageCount("milestone")).toBe(1);
  });

  it("stops accepting a kind that was removed", () => {
    store.removeKind("spike");
    expect(() => store.createIssue({ title: "gone", kind: "spike" })).toThrowError(
      /Unknown kind "spike"/,
    );
  });

  it("falls back to the first configured kind when the default itself is removed", () => {
    // `removeKind` is allowed to delete `task`, so `defaultKind()` cannot just
    // return the constant — it would write rows that fail their own validation.
    store.removeKind("task", { migrateTo: "chore" });
    expect(store.defaultKind()).toBe("epic");
    expect(store.createIssue({ title: "orphaned default" }).kind).toBe("epic");
  });

  it("does not let REORDERING the vocabulary change what a new issue is", () => {
    // The booby trap `defaultKind()` exists to avoid: ordering is a display
    // decision, and it must not double as a semantic one.
    store.reorderKinds(["spike", "epic", "bug", "chore", "task"]);
    expect(store.kindOrder()).toEqual(["spike", "epic", "bug", "chore", "task"]);
    expect(store.createIssue({ title: "still a task" }).kind).toBe(DEFAULT_ISSUE_KIND);
  });

  it("exposes the configured order as the rank, with the seed mirror agreeing", () => {
    expect(store.kindOrder()).toEqual([...ISSUE_KINDS]);
    expect(store.kindOrder().indexOf("bug")).toBe(KIND_RANK.bug);
  });
});

// ------------------------------------------------------------- the migration

describe("migration 005 backfills parents as epics, exactly once", () => {
  /** A workspace walked only as far as version 4 — the shape before this ticket. */
  function walkedToV4(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const migration of [...WORKSPACE_TARGET.migrations].sort((a, b) => a.version - b.version)) {
      if (migration.version >= 5) break;
      migration.up(db);
    }
    return db;
  }

  it("gives a row with children epic and every other row task", () => {
    const db = walkedToV4();
    /**
     * Raw INSERTs, deliberately, and not `WorkspaceStore.createIssue`. The
     * current store writes `issues.kind`, so pointing it at a v4 database is
     * exactly the mistake this migration exists to make unnecessary — it fails
     * on "no column named kind" and tests nothing. A migration's subject is
     * ROWS THAT PREDATE IT, and the only honest way to produce those is SQL.
     */
    const insert = db.prepare(
      `INSERT INTO issues (id, identifier, title, normalized_title, parent_id, depth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    );
    insert.run("p", "OLD-1", "Big thing", "big thing", null, 0);
    insert.run("c", "OLD-2", "Small thing", "small thing", "p", 1);
    insert.run("l", "OLD-3", "Standalone", "standalone", null, 0);

    const m005 = WORKSPACE_TARGET.migrations.find((m) => m.version === 5)!;
    expect(m005.name).toBe("issue-kind");
    m005.up(db);

    const kindOf = (identifier: string) =>
      (
        db.prepare("SELECT kind FROM issues WHERE identifier = ?").get(identifier) as {
          kind: string;
        }
      ).kind;
    expect(kindOf("OLD-1")).toBe("epic");
    // A CHILD is not an epic, and neither is a childless root. Only "had at
    // least one child" earns the promotion.
    expect(kindOf("OLD-2")).toBe("task");
    expect(kindOf("OLD-3")).toBe("task");
    db.close();
  });

  it("does not promote a task that grows children AFTER the migration", () => {
    // The whole "declared, not derived" claim in one assertion. If anybody ever
    // adds a recompute to createIssue, this goes red.
    const parent = store.createIssue({ title: "Parent by accident" });
    store.createIssue({ title: "Child", parent: parent.identifier });
    expect(store.getIssue(parent.identifier).kind).toBe(DEFAULT_ISSUE_KIND);
  });
});

// --------------------------------------------------------------- the filter

describe("listing by kind", () => {
  it("narrows to one kind and to several", () => {
    store.createIssue({ title: "An epic", kind: "epic" });
    store.createIssue({ title: "A bug", kind: "bug" });
    store.createIssue({ title: "A chore", kind: "chore" });
    store.createIssue({ title: "A plain task" });

    const titles = (kind?: string[]) => store.listIssues({ kind }).map((i) => i.title).sort();
    expect(titles(["epic"])).toEqual(["An epic"]);
    expect(titles(["bug", "chore"])).toEqual(["A bug", "A chore"]);
    // An empty array is not a filter — it must not silently match nothing.
    expect(titles([])).toHaveLength(4);
    expect(titles(undefined)).toHaveLength(4);
  });
});

// ------------------------------------------------------------------ the CLI

describe("staple new --kind / staple ls --kind", () => {
  let home: string;
  let dbPath: string;

  function staple(...args: string[]) {
    const result = spawnSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/cli.ts", ...args, "--db", dbPath],
      {
        env: { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "kind-test", NODE_NO_WARNINGS: "1" },
        encoding: "utf8",
      },
    );
    return { status: result.status ?? 0, stdout: result.stdout, stderr: result.stderr };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "staple-issue-kind-"));
    process.env.STAPLE_HOME = home;
    const ws = initWorkspace({ global: true, slug: "kinds" });
    dbPath = ws.dbPath;
    ws.store.db.close();
  });

  afterEach(() => {
    delete process.env.STAPLE_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("creates a bug and lists only the epics", () => {
    expect(staple("new", "A defect", "--kind", "bug").status).toBe(0);
    expect(staple("new", "A big thing", "--kind", "epic").status).toBe(0);
    expect(staple("new", "Ordinary work").status).toBe(0);

    const epics = JSON.parse(staple("ls", "--kind", "epic", "--json").stdout) as Array<{
      title: string;
      kind: string;
    }>;
    expect(epics.map((i) => i.title)).toEqual(["A big thing"]);
    expect(epics[0]!.kind).toBe("epic");

    // Comma-separated, like --status.
    const two = JSON.parse(staple("ls", "--kind", "bug,epic", "--json").stdout) as Array<{
      title: string;
    }>;
    expect(two.map((i) => i.title).sort()).toEqual(["A big thing", "A defect"]);
  });

  it("marks a non-default kind on the row and leaves a plain task bare", () => {
    staple("new", "A defect", "--kind", "bug");
    staple("new", "Ordinary work");
    const rows = staple("ls").stdout.trim().split("\n");
    const bug = rows.find((r) => r.includes("A defect"))!;
    const task = rows.find((r) => r.includes("Ordinary work"))!;
    expect(bug).toContain("A defect · bug");
    // The default is SUPPRESSED — a bare row is a task, and the line is
    // byte-identical to what it was before this ticket.
    expect(task).toMatch(/ Ordinary work$/);
  });

  it("names the kind on show even when it is the default", () => {
    staple("new", "Ordinary work");
    expect(staple("show", "KIN-1").stdout).toContain("· kind task ·");
    staple("new", "A big thing", "--kind", "epic");
    expect(staple("show", "KIN-2").stdout).toContain("· kind epic ·");
  });

  it("refuses an unconfigured kind with the validation exit code", () => {
    const { status, stderr } = staple("new", "Nope", "--kind", "saga");
    expect(status).toBe(2);
    expect(stderr).toContain('Unknown kind "saga"');
  });

  it("accepts a kind added through staple kinds add", () => {
    expect(staple("kinds", "add", "milestone", "--label", "Milestone").status).toBe(0);
    expect(staple("new", "GA", "--kind", "milestone").status).toBe(0);
    const rows = JSON.parse(staple("ls", "--kind", "milestone", "--json").stdout) as Array<{
      kind: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("milestone");
  });
});
