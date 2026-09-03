import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";

/**
 * O7a (STA-140) — `staple statuses` and `staple kinds`.
 *
 * Run through the real binary rather than against the store, because the value
 * of a CLI surface is the exit code, the parse and the printed shape, and none
 * of those are exercised by calling the store directly. `test/store-settings.test.ts`
 * owns the semantics; this owns the ergonomics.
 *
 * A fresh workspace per test: these commands change workspace-wide configuration,
 * so a shared fixture would make every test depend on the order the others ran in.
 */

let home: string;
let dbPath: string;

function staple(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/cli.ts", ...args, "--db", dbPath],
    {
      env: { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "cli-test", NODE_NO_WARNINGS: "1" },
      encoding: "utf8",
    },
  );
  return { status: result.status ?? 0, stdout: result.stdout, stderr: result.stderr };
}

const ids = (args: string[]) =>
  (JSON.parse(staple(...args).stdout) as Array<{ id: string }>).map((r) => r.id);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-cli-settings-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "vocab" });
  dbPath = ws.dbPath;
  ws.store.createIssue({ title: "First task" });
  ws.store.db.close();
});

afterEach(() => {
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("staple statuses", () => {
  it("lists the configured statuses with their categories", () => {
    const { status, stdout } = staple("statuses");
    expect(status).toBe(0);
    expect(stdout).toContain("backlog");
    expect(stdout).toContain("unstarted");
    expect(stdout).toContain("In Progress");
  });

  it("--json emits the rows a UI would render", () => {
    const { status, stdout } = staple("statuses", "ls", "--json");
    expect(status).toBe(0);
    const rows = JSON.parse(stdout);
    expect(ids(["statuses", "ls", "--json"])).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "blocked",
      "cancelled",
    ]);
    expect(rows[0]).toEqual({
      id: "backlog",
      label: "Backlog",
      category: "unstarted",
      sortOrder: 10,
      isBuiltin: true,
    });
  });

  it("adds a status after a named one and prints the full new list", () => {
    const { status, stdout } = staple(
      "statuses",
      "add",
      "awaiting_approval",
      "--category",
      "gated",
      "--after",
      "in_review",
      "--json",
    );
    expect(status).toBe(0);
    expect((JSON.parse(stdout) as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "awaiting_approval",
      "done",
      "blocked",
      "cancelled",
    ]);
  });

  it("refuses an add with no --category, and says what the categories are", () => {
    const { status, stderr } = staple("statuses", "add", "whatever");
    expect(status).toBe(2);
    expect(stderr).toMatch(/--category is required/);
    expect(stderr).toContain("unstarted");
    expect(stderr).toContain("gated");
  });

  it("renames and reorders", () => {
    expect(staple("statuses", "rename", "todo", "--label", "Ready").status).toBe(0);
    expect(
      (JSON.parse(staple("statuses", "ls", "--json").stdout) as Array<{ id: string; label: string }>)
        .find((r) => r.id === "todo")?.label,
    ).toBe("Ready");

    const reorder = staple(
      "statuses",
      "reorder",
      "in_progress,in_review,blocked,todo,backlog,done,cancelled",
      "--json",
    );
    expect(reorder.status).toBe(0);
    expect((JSON.parse(reorder.stdout) as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "in_progress",
      "in_review",
      "blocked",
      "todo",
      "backlog",
      "done",
      "cancelled",
    ]);
  });

  it("refuses a partial reorder with exit 2 rather than inventing the rest", () => {
    const { status, stderr } = staple("statuses", "reorder", "todo,backlog");
    expect(status).toBe(2);
    expect(stderr).toMatch(/must list every status/);
  });

  it("rm refuses while issues carry the status, then migrates them with --migrate-to", () => {
    expect(staple("statuses", "add", "on_hold", "--category", "blocked").status).toBe(0);
    expect(staple("status", "VOC-1", "on_hold").status).toBe(0);

    const refused = staple("statuses", "rm", "on_hold");
    expect(refused.status).toBe(4); // conflict
    expect(refused.stderr).toMatch(/Pass --migrate-to/);

    const migrated = staple("statuses", "rm", "on_hold", "--migrate-to", "backlog");
    expect(migrated.status).toBe(0);
    expect(migrated.stdout).toContain("moved 1 issue(s) to backlog");
    expect(JSON.parse(staple("show", "VOC-1", "--json").stdout).issue.status).toBe("backlog");
  });

  it("rm refuses to empty a category staple writes into", () => {
    const { status, stderr } = staple("statuses", "rm", "done", "--migrate-to", "cancelled");
    expect(status).toBe(2);
    expect(stderr).toMatch(/only status in the "done" category/);
  });

  it("names the valid subcommands when given a wrong one", () => {
    const { status, stderr } = staple("statuses", "frobnicate");
    expect(status).toBe(2);
    expect(stderr).toMatch(/ls, add, rename, recategorize, reorder, rm/);
  });
});

describe("staple kinds", () => {
  it("lists the seeded vocabulary O1a will consume", () => {
    expect(ids(["kinds", "ls", "--json"])).toEqual(["epic", "task", "bug", "chore", "spike"]);
  });

  it("adds, renames, reorders and removes", () => {
    expect(staple("kinds", "add", "milestone").status).toBe(0);
    expect(ids(["kinds", "ls", "--json"])).toContain("milestone");

    expect(staple("kinds", "rename", "milestone", "--label", "Milestone").status).toBe(0);
    expect(
      (JSON.parse(staple("kinds", "ls", "--json").stdout) as Array<{ id: string; label: string }>)
        .find((k) => k.id === "milestone")?.label,
    ).toBe("Milestone");

    expect(staple("kinds", "reorder", "task,epic,bug,chore,spike,milestone").status).toBe(0);
    expect(ids(["kinds", "ls", "--json"])[0]).toBe("task");

    expect(staple("kinds", "rm", "milestone").status).toBe(0);
    expect(ids(["kinds", "ls", "--json"])).not.toContain("milestone");
  });

  it("has no categories, and refuses recategorize instead of ignoring it", () => {
    const { status, stderr } = staple("kinds", "recategorize", "task", "--category", "ready");
    expect(status).toBe(2);
    expect(stderr).toMatch(/Kinds have no category/);
  });
});

describe("a configured status is a first-class status everywhere", () => {
  it("is settable, listable, boardable and claimable through the ordinary commands", () => {
    expect(staple("statuses", "add", "awaiting_approval", "--category", "gated").status).toBe(0);
    expect(staple("status", "VOC-1", "awaiting_approval").status).toBe(0);

    // ls prints it, with a glyph chosen by its CATEGORY rather than "?".
    const listed = staple("ls").stdout;
    expect(listed).toContain("awaiting_approval");
    expect(listed).not.toContain("? ");

    // board gives it a column of its own.
    expect(staple("board").stdout).toContain("AWAITING_APPROVAL (1)");

    // inbox parks it rather than offering it as ready work: `gated` is not workable.
    const inbox = JSON.parse(staple("inbox", "--json").stdout);
    expect(inbox.blocked.map((i: { identifier: string }) => i.identifier)).toContain("VOC-1");
    expect(inbox.ready).toHaveLength(0);
  });

  it("refuses a status the workspace does not configure, naming the ones it has", () => {
    const { status, stderr } = staple("status", "VOC-1", "shipped");
    expect(status).toBe(2);
    expect(stderr).toMatch(/Unknown status "shipped"/);
    expect(stderr).toContain("in_progress");
  });
});
