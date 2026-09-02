import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";

let home: string;
let dbPath: string;

function staple(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/cli.ts", ...args, "--db", dbPath],
    {
      // NODE_NO_WARNINGS silences node:sqlite's ExperimentalWarning, which is
      // runtime noise on stderr and not part of staple's own output.
      env: { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "cli-test", NODE_NO_WARNINGS: "1" },
      encoding: "utf8",
    },
  );
  return { status: result.status ?? 0, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-cli-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "clitest" });
  dbPath = ws.dbPath;
  ws.store.createIssue({ title: "First task", assignee: "cli-test" });
  ws.store.createIssue({ title: "Second task" });
  ws.store.db.close();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("--json output", () => {
  it("ls --json emits a JSON array of issue objects", () => {
    const { status, stdout } = staple("ls", "--json");
    expect(status).toBe(0);
    const issues = JSON.parse(stdout);
    expect(Array.isArray(issues)).toBe(true);
    expect(issues).toHaveLength(2);
    expect(issues[0].identifier).toBe("CLI-1");
    expect(issues[0].title).toBe("First task");
  });

  it("emits full ISO-8601 timestamps with a Z suffix, not truncated", () => {
    const issues = JSON.parse(staple("ls", "--json").stdout);
    expect(issues[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("events --json emits NDJSON, one event object per line", () => {
    const { status, stdout } = staple("events", "--json");
    expect(status).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(lines[0]!).seq).toBe(1);
  });

  it("show --json emits the full context object", () => {
    const ctx = JSON.parse(staple("show", "CLI-1", "--json").stdout);
    expect(ctx.issue.identifier).toBe("CLI-1");
    expect(Array.isArray(ctx.comments)).toBe(true);
    expect(Array.isArray(ctx.documents)).toBe(true);
  });

  it("inbox --json splits ready and blocked", () => {
    const inbox = JSON.parse(staple("inbox", "--json").stdout);
    expect(Array.isArray(inbox.ready)).toBe(true);
    expect(Array.isArray(inbox.blocked)).toBe(true);
  });

  it("board --json keys issues by status without the terminal row cap", () => {
    const board = JSON.parse(staple("board", "--json").stdout);
    expect(board.backlog.length + board.todo.length).toBe(2);
  });

  it("tree --json emits nested issue nodes", () => {
    const tree = JSON.parse(staple("tree", "--json").stdout);
    expect(Array.isArray(tree)).toBe(true);
    expect(tree[0].issue.identifier).toBeDefined();
    expect(Array.isArray(tree[0].children)).toBe(true);
  });
});

describe("typed exit codes", () => {
  it("exits 3 with a single-line JSON error on stderr for not_found", () => {
    const { status, stdout, stderr } = staple("show", "CLI-999", "--json");
    expect(status).toBe(3);
    expect(stdout).toBe("");
    expect(stderr.trim().split("\n")).toHaveLength(1);
    const err = JSON.parse(stderr);
    expect(err.code).toBe("not_found");
    expect(err.retryable).toBe(false);
    expect(typeof err.message).toBe("string");
  });

  it("exits 4 on a checkout conflict and carries branchable detail", () => {
    expect(staple("start", "CLI-2", "--agent", "one").status).toBe(0);
    const { status, stderr } = staple("start", "CLI-2", "--agent", "two", "--json");
    expect(status).toBe(4);
    const err = JSON.parse(stderr);
    expect(err.code).toBe("conflict");
    expect(err.retryable).toBe(false);
    expect(err.detail.heldBy).toBe("one");
  });

  it("exits 5 on a duplicate title", () => {
    const { status, stderr } = staple("new", "First task", "--json");
    expect(status).toBe(5);
    expect(JSON.parse(stderr).code).toBe("duplicate");
  });

  it("exits 2 on validation failure", () => {
    const { status, stderr } = staple("status", "CLI-1", "not_a_status", "--json");
    expect(status).toBe(2);
    expect(JSON.parse(stderr).code).toBe("validation");
  });
});

describe("human output is unaffected", () => {
  it("prints the glyph line when --json is absent", () => {
    const { status, stdout } = staple("ls");
    expect(status).toBe(0);
    expect(stdout).toContain("CLI-1");
    expect(stdout).toContain("First task");
    expect(stdout).toMatch(/[◌○◐◑●⊘✕]/);
    expect(() => JSON.parse(stdout)).toThrow();
  });

  it("reports errors as prose, not JSON, when --json is absent", () => {
    const { status, stderr } = staple("show", "CLI-999");
    expect(status).toBe(3);
    expect(stderr).toContain("error(not_found)");
  });
});

describe("review pins: retry contract stays honest", () => {
  it("exits 7 on a stale document write, the only retryable code", () => {
    const doc = join(home, "plan.md");
    writeFileSync(doc, "# plan v1\n");
    expect(staple("doc", "CLI-1", "plan", "--put", doc).status).toBe(0);
    writeFileSync(doc, "# plan v2\n");
    expect(staple("doc", "CLI-1", "plan", "--put", doc, "--base", "1").status).toBe(0);
    const { status, stderr } = staple("doc", "CLI-1", "plan", "--put", doc, "--base", "1", "--json");
    expect(status).toBe(7);
    const err = JSON.parse(stderr);
    expect(err.code).toBe("revision_conflict");
    expect(err.retryable).toBe(true);
    expect(err.detail.currentRevision).toBe(2);
  });

  it("classifies an unknown option as validation, not a retryable unknown", () => {
    const { status, stderr } = staple("ls", "--jsonx", "--json");
    expect(status).toBe(2);
    const err = JSON.parse(stderr);
    expect(err.code).toBe("validation");
    expect(err.retryable).toBe(false);
  });

  it("emits a JSON envelope for an unknown command under --json", () => {
    const { status, stderr } = staple("bogus", "--json");
    expect(status).toBe(2);
    expect(JSON.parse(stderr).code).toBe("validation");
  });
});
