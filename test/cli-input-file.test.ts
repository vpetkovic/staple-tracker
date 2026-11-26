/**
 * A file the user names on the command line is read through one helper, so a blank,
 * missing or unreadable path is a refusal that names the path, in the CLI's normal
 * error envelope, instead of a raw Node stack trace with exit 1.
 *
 * Blank and unreadable (a directory, no permission) are `validation`, exit 2. A path
 * that does not exist is `not_found`, exit 3. `doc --put -` still reads stdin.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bareEnv, CLI_ENTRY, runCliAt, tempDir, TSX_CLI, type CliResult } from "./fixtures/characterize-support.js";
import { startMcpClient } from "./fixtures/contract-support.js";

let home: string;
let repo: string;
let ref: string;
let env: Record<string, string>;
let missing: string;
let directory: string;

function cli(...args: string[]): CliResult {
  return runCliAt(repo, args, env);
}

/** A refusal: the exit code, nothing on stdout, one error line naming the path, no stack. */
function expectRefusal(result: CliResult, status: number, code: string, ...mentions: string[]): void {
  expect(result.status, result.stderr).toBe(status);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toMatch(/\n\s+at /);
  expect(result.stderr).not.toMatch(/errno|syscall/);
  expect(result.stderr.trim()).toMatch(new RegExp(`^error\\(${code}\\): `));
  for (const mention of mentions) expect(result.stderr).toContain(mention);
}

/** The same refusal under --json: the envelope on stderr. */
function expectJsonRefusal(result: CliResult, status: number, code: string, ...mentions: string[]): void {
  expect(result.status, result.stderr).toBe(status);
  expect(result.stdout).toBe("");
  const envelope = JSON.parse(result.stderr) as { code: string; message: string; retryable: boolean };
  expect(envelope.code).toBe(code);
  expect(envelope.retryable).toBe(false);
  for (const mention of mentions) expect(envelope.message).toContain(mention);
}

beforeAll(() => {
  home = tempDir("input-file-home");
  repo = tempDir("input-file-repo");
  env = { STAPLE_HOME: home, STAPLE_AGENT: "ada" };
  expect(cli("init").status).toBe(0);
  const created = cli("new", "a task with notes", "--json");
  expect(created.status, created.stderr).toBe(0);
  ref = (JSON.parse(created.stdout) as { identifier: string }).identifier;
  missing = join(repo, "no-such-file.md");
  directory = join(repo, "somedir");
  mkdirSync(directory);
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("doc --put <file>", () => {
  it("refuses a blank path as validation, exit 2", () => {
    expectRefusal(cli("doc", ref, "notes", "--put", ""), 2, "validation", "--put", "file path");
    expectJsonRefusal(cli("doc", ref, "notes", "--put", "", "--json"), 2, "validation", "--put", "file path");
  });

  it("refuses a missing file as not_found, exit 3, naming the path", () => {
    expectRefusal(cli("doc", ref, "notes", "--put", missing), 3, "not_found", "--put", missing);
    expectJsonRefusal(cli("doc", ref, "notes", "--put", missing, "--json"), 3, "not_found", "--put", missing);
  });

  it("refuses a directory as validation, exit 2, naming the path and why", () => {
    expectRefusal(cli("doc", ref, "notes", "--put", directory), 2, "validation", directory, "directory");
    expectJsonRefusal(cli("doc", ref, "notes", "--put", directory, "--json"), 2, "validation", directory, "directory");
  });

  // Root reads a 000 file anyway, so there is nothing to refuse.
  it.skipIf(process.getuid?.() === 0)("refuses a file it may not read as validation, exit 2, naming the path and why", () => {
    const locked = join(repo, "locked.md");
    writeFileSync(locked, "secret\n");
    chmodSync(locked, 0o000);
    try {
      expectRefusal(cli("doc", ref, "notes", "--put", locked), 2, "validation", locked, "permission denied");
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  it("writes nothing on a refusal, and still reads a real file and stdin", () => {
    expect(cli("doc", ref, "notes", "--put", missing).status).toBe(3);
    expect(cli("doc", ref, "notes", "--json").status).toBe(3);

    const source = join(repo, "notes.md");
    writeFileSync(source, "from a file\n");
    const put = cli("doc", ref, "notes", "--put", source);
    expect(put.status, put.stderr).toBe(0);
    expect(put.stdout).toContain("notes @ revision 1");

    const piped = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "doc", ref, "notes", "--put", "-"], {
      cwd: repo,
      env: bareEnv(env),
      input: "from stdin\n",
      encoding: "utf8",
    });
    expect(piped.status, piped.stderr).toBe(0);
    expect(piped.stdout).toContain("notes @ revision 2");
    const read = cli("doc", ref, "notes", "--json");
    expect((JSON.parse(read.stdout) as { body: string }).body).toBe("from stdin\n");
  }, 60_000);
});

describe("every other flag that reads a file the user named", () => {
  it("file attach refuses a missing file and a directory", () => {
    expectRefusal(cli("file", "attach", ref, missing), 3, "not_found", missing);
    expectJsonRefusal(cli("file", "attach", ref, directory, "--json"), 2, "validation", directory, "directory");
  });

  it("run start --instructions refuses a missing file as not_found", () => {
    expectRefusal(cli("run", "start", "--scope", ref, "--instructions", missing), 3, "not_found", "--instructions", missing);
  });

  it("run drive --instructions refuses a missing file as not_found", () => {
    expectRefusal(cli("run", "drive", "--scope", ref, "--agent", "claude", "--instructions", missing), 3, "not_found", "--instructions", missing);
  });

  it("idea import refuses a missing plan file as not_found", () => {
    expect(cli("config", "set", "humanName", "Ada Person").status).toBe(0);
    expect(cli("settings", "set", "features.planning", "true", "--person").status).toBe(0);
    expectRefusal(cli("idea", "import", missing), 3, "not_found", missing);
  });

  it("MCP attach_file refuses a missing path as not_found", async () => {
    const harness = await startMcpClient({ home, cwd: repo, agent: "ada" });
    try {
      const result = await harness.call("attach_file", { ref, path: missing, actor: "ada" });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result);
      expect(text).toContain("not_found");
      expect(text).toContain(missing.replaceAll("\\", "\\\\"));
    } finally {
      await harness.close();
    }
  }, 60_000);
});
