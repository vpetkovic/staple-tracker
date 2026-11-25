/**
 * A reader that stops early (`staple show <ref> | head`) closes the CLI's stdout while it is
 * still writing. That is a normal end for a command-line tool, not a crash: the CLI must exit
 * quietly instead of printing Node's unhandled-EPIPE stack trace to stderr.
 *
 * Run through the real binary with stdout as a pipe the test closes after the first chunk,
 * which is exactly what `head` does. The ticket's description is far larger than a pipe
 * buffer, so the CLI is guaranteed to still be writing when the reader goes away.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";

let home: string;
let dbPath: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-cli-pipe-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "pipes" });
  dbPath = ws.dbPath;
  const description = Array.from({ length: 20_000 }, (_, i) => `line ${i} of a long description`).join("\n");
  ws.store.createIssue({ title: "Long one", kind: "task", description });
  ws.store.db.close();
});

afterAll(() => {
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** Run the CLI, close its stdout after the first chunk, and report how it ended. */
function stapleIntoClosedPipe(...args: string[]): Promise<{ code: number | null; stderr: string; firstChunk: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args, "--db", dbPath],
      {
        env: { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "pipe-test", NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let firstChunk = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdout.once("data", (chunk: Buffer) => {
      firstChunk = chunk.toString("utf8");
      child.stdout.destroy();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, firstChunk }));
  });
}

describe("a reader that closes the pipe early ends the CLI quietly", () => {
  it("text output: no stack trace, exit 0", async () => {
    const result = await stapleIntoClosedPipe("show", "PIP-1");
    expect(result.firstChunk).toContain("PIP-1");
    expect(result.stderr).not.toMatch(/EPIPE|Unhandled 'error' event|at /);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("JSON output: no stack trace, exit 0", async () => {
    const result = await stapleIntoClosedPipe("show", "PIP-1", "--json");
    expect(result.firstChunk).toMatch(/^\{"issue":/);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });
});
