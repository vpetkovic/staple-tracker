/**
 * A successful staple run says nothing on stderr.
 *
 * `node:sqlite` emits "ExperimentalWarning: SQLite is an experimental feature …" the
 * first time it loads, and Node prints it to stderr with a `--trace-warnings` hint.
 * Every staple process loads it, so every run, including a successful `--json` one
 * an agent parses, used to carry two lines of noise on stderr. Staple drops that one
 * warning and nothing else: real errors keep their exit code and their stderr
 * diagnostic, and any other warning, including another ExperimentalWarning, still
 * prints.
 *
 * Each case spawns a real entry: the source CLI (tsx src/cli.ts), the source MCP
 * server (tsx src/mcp.ts) and the packaged staple.mjs the installer runs, for both
 * its CLI and its `mcp` surface. The children get no NODE_NO_WARNINGS and no
 * NODE_OPTIONS, so Node's default warning printer is in play.
 *
 * The filter only works if it is installed before node:sqlite loads, so the last
 * case pins that the runtime source loads it in one place, src/core/sqlite.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { CLI_ENTRY, MCP_ENTRY, REPO_ROOT, TSX_CLI, bareEnv } from "./fixtures/characterize-support.js";
import { testPackageDir } from "./fixtures/package-payload.js";
import { readCode, sourceFiles } from "./fixtures/source-scan.js";

const SQLITE_WARNING = "SQLite is an experimental feature";

let home: string;
let preload: string;

/** The child environment: no staple variables except the scratch home, and Node's warning printer left on. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = bareEnv({ STAPLE_HOME: home, ...extra });
  delete env.NODE_NO_WARNINGS;
  delete env.NODE_OPTIONS;
  return env;
}

type Entry = { name: string; cli: string[]; mcp: string[] };

function entries(): Entry[] {
  const packaged = join(testPackageDir(), "staple.mjs");
  return [
    { name: "source entry (tsx src/cli.ts, tsx src/mcp.ts)", cli: [TSX_CLI, CLI_ENTRY], mcp: [TSX_CLI, MCP_ENTRY] },
    { name: "packaged staple.mjs", cli: [packaged], mcp: [packaged, "mcp"] },
  ];
}

function run(args: string[], options: { env?: Record<string, string>; input?: string } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: options.env ?? childEnv(),
    input: options.input,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const INITIALIZE = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "quiet-stderr", version: "0" } },
})}\n`;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-quiet-stderr-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "quiet" });
  ws.store.createIssue({ title: "First task" });
  ws.store.db.close();

  // Emits two warnings once the entry is running: a plain one and another
  // ExperimentalWarning. Neither is the SQLite one, so both must still print.
  // It goes in through NODE_OPTIONS, which tsx's launcher hands to the process that
  // runs src/cli.ts. The launcher loads it too and stays quiet, so what reaches
  // stderr came through staple's own process.
  preload = join(home, "emit-warnings.mjs");
  writeFileSync(
    preload,
    [
      "if (!/tsx[\\\\/]dist[\\\\/]cli\\.mjs$/.test(process.argv[1] ?? \"\")) {",
      '  setImmediate(() => process.emitWarning("deliberate test warning"));',
      '  setImmediate(() => process.emitWarning("Something else is experimental", "ExperimentalWarning"));',
      "}",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe.each(entries())("$name", (entry) => {
  it("a successful --json command prints parseable JSON on stdout and nothing on stderr", () => {
    const { status, stdout, stderr } = run([...entry.cli, "ls", "--ws", "quiet", "--json"]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const issues = JSON.parse(stdout) as Array<{ title: string }>;
    expect(issues.map((issue) => issue.title)).toEqual(["First task"]);
  });

  it("a failing --json command exits nonzero with its diagnostic, and only that, on stderr", () => {
    const { status, stdout, stderr } = run([...entry.cli, "show", "999", "--ws", "quiet", "--json"]);
    expect(status).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).not.toContain(SQLITE_WARNING);
    expect(JSON.parse(stderr)).toMatchObject({ code: "not_found" });
  });

  it("the MCP server answers on stdout and keeps only its own ready line on stderr", () => {
    const { status, stdout, stderr } = run(entry.mcp, { env: childEnv({ STAPLE_WS: "quiet" }), input: INITIALIZE });
    expect(status).toBe(0);
    expect(JSON.parse(stdout.trim().split("\n")[0]!)).toMatchObject({ id: 1, result: { serverInfo: { name: "staple" } } });
    expect(stderr).not.toContain(SQLITE_WARNING);
    expect(stderr.trim().split("\n")).toEqual([expect.stringMatching(/^staple mcp ready/)]);
  });

  it("every other warning still reaches stderr, another ExperimentalWarning included", () => {
    const { status, stdout, stderr } = run([...entry.cli, "ls", "--ws", "quiet", "--json"], {
      env: { ...childEnv(), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toHaveLength(1);
    expect(stderr).toContain("Warning: deliberate test warning");
    expect(stderr).toContain("ExperimentalWarning: Something else is experimental");
    expect(stderr).not.toContain(SQLITE_WARNING);
  });
});

describe("node:sqlite loads in one place", () => {
  it("no runtime module but src/core/sqlite.ts imports node:sqlite as a value", () => {
    // A static value import loads node:sqlite while the import graph resolves, before
    // the warning filter runs. Type-only imports, including the `import("node:sqlite")
    // .DatabaseSync` type position, are erased and load nothing.
    const valueImport = new RegExp(
      [
        String.raw`\bimport\s+(?!type\b)[^;]*?from\s*["']node:sqlite["']`,
        String.raw`\bawait\s+import\(\s*["']node:sqlite["']`,
        String.raw`\bimport\(\s*["']node:sqlite["']\s*\)\s*\.then\b`,
        String.raw`\brequire\(\s*["']node:sqlite["']`,
      ].join("|"),
    );
    const offenders = sourceFiles(join(REPO_ROOT, "src"))
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .filter((file) => valueImport.test(readCode(file)))
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
