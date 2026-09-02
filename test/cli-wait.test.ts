import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";

let home: string;
let dbPath: string;
let hook: string;
let hookArgFile: string;
let hookEnvFile: string;

/** Issues minted in beforeAll; identifiers are captured, never hardcoded. */
let free: string;
let finished: string;
let blockerA: string;
let gatedA: string;
let blockerB: string;
let gatedB: string;

const CLI = ["node_modules/tsx/dist/cli.mjs", "src/cli.ts"];

function childEnv(): NodeJS.ProcessEnv {
  // NODE_NO_WARNINGS silences node:sqlite's ExperimentalWarning, which is
  // runtime noise on stderr and not part of staple's own output.
  return { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "wait-test", NODE_NO_WARNINGS: "1" };
}

function staple(...args: string[]) {
  const result = spawnSync(process.execPath, [...CLI, ...args, "--db", dbPath], {
    env: childEnv(),
    encoding: "utf8",
  });
  return { status: result.status ?? 0, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A one-shot command can lose the open race against a running poller: openDb
 * runs `PRAGMA journal_mode=WAL` before busy_timeout is armed (src/core/db.ts),
 * so a concurrent connection can fail the open outright. The polling commands
 * retry that internally; these test-side writers do the same instead of flaking.
 */
function stapleRetry(...args: string[]) {
  let result = staple(...args);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (result.status === 0 || !/database is locked/.test(result.stderr)) return result;
    result = staple(...args);
  }
  return result;
}

/** Non-blocking variant: `wait` and `--follow` must be observed while still running. */
function stapleAsync(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [...CLI, ...args, "--db", dbPath], { env: childEnv() });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ status: code ?? 0, stdout, stderr }));
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lastSeq(): number {
  const lines = stapleRetry("events", "--json").stdout.trim().split("\n").filter(Boolean);
  return lines.length === 0 ? 0 : (JSON.parse(lines[lines.length - 1]!).seq as number);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-wait-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "waittest" });
  dbPath = ws.dbPath;

  free = ws.store.createIssue({ title: "Free task" }).identifier;
  finished = ws.store.createIssue({ title: "Finished task" }).identifier;
  blockerA = ws.store.createIssue({ title: "Blocker A" }).identifier;
  gatedA = ws.store.createIssue({ title: "Gated A", blockedBy: [blockerA] }).identifier;
  blockerB = ws.store.createIssue({ title: "Blocker B" }).identifier;
  gatedB = ws.store.createIssue({ title: "Gated B", blockedBy: [blockerB] }).identifier;
  ws.store.updateIssue(finished, { status: "done" }, "wait-test");
  ws.store.db.close();

  hookArgFile = join(home, "hook-arg.json");
  hookEnvFile = join(home, "hook-env.json");
  hook = join(home, "hook.sh");
  writeFileSync(
    hook,
    `#!/bin/sh\nprintf '%s' "$1" > "${hookArgFile}"\nprintf '%s' "$STAPLE_EVENT" > "${hookEnvFile}"\n`,
  );
  chmodSync(hook, 0o755);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("staple wait", () => {
  it("exits 0 immediately when the issue has no unresolved blockers", () => {
    const { status, stdout } = staple("wait", free, "--timeout", "5", "--json");
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.identifier).toBe(free);
    expect(result.ready).toBe(true);
    expect(result.reason).toBe("ready");
    expect(result.unresolvedBlockers).toEqual([]);
  });

  it("exits 0 for an already finished issue instead of hanging", () => {
    const { status, stdout } = staple("wait", finished, "--timeout", "5", "--json");
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.reason).toBe("finished");
    expect(result.status).toBe("done");
  });

  it("exits 8 with a single-line timeout envelope when blockers stay unresolved", () => {
    const { status, stdout, stderr } = staple(
      "wait",
      gatedA,
      "--timeout",
      "1",
      "--interval",
      "50",
      "--json",
    );
    expect(status).toBe(8);
    expect(stdout).toBe("");
    expect(stderr.trim().split("\n")).toHaveLength(1);
    const err = JSON.parse(stderr);
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(err.detail.identifier).toBe(gatedA);
    expect(err.detail.unresolvedBlockers).toEqual([blockerA]);
  });

  it("reports the timeout as prose, not JSON, when --json is absent", () => {
    const { status, stderr } = staple("wait", gatedA, "--timeout", "1", "--interval", "50");
    expect(status).toBe(8);
    expect(stderr).toContain("error(timeout)");
    expect(stderr).toContain(blockerA);
  });

  it("wakes and exits 0 when the blocker completes mid-wait", async () => {
    const pending = stapleAsync("wait", gatedB, "--timeout", "30", "--interval", "25", "--json");
    await delay(500);
    const unblock = stapleRetry("done", blockerB, "-m", "unblocking");
    expect(unblock.status, unblock.stderr).toBe(0);
    const { status, stdout } = await pending;
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.identifier).toBe(gatedB);
    expect(result.ready).toBe(true);
    expect(result.unresolvedBlockers).toEqual([]);
    expect(result.waitedMs).toBeGreaterThan(0);
  }, 45_000);

  it("exits 3 for an unknown ref", () => {
    const { status, stderr } = staple("wait", "WAI-9999", "--timeout", "1", "--json");
    expect(status).toBe(3);
    expect(JSON.parse(stderr).code).toBe("not_found");
  });

  it("exits 2 on a non-positive interval", () => {
    const { status, stderr } = staple("wait", free, "--interval", "0", "--json");
    expect(status).toBe(2);
    expect(JSON.parse(stderr).code).toBe("validation");
  });
});

describe("staple events --follow", () => {
  it("streams a new event as NDJSON and stops after --max", async () => {
    const before = lastSeq();
    const pending = stapleAsync("events", "--follow", "--max", "1", "--interval", "25", "--json");
    let closed = false;
    const captured = pending.then((result) => {
      closed = true;
      return result;
    });
    // The follower starts at the current max seq, so keep producing until it
    // has booted and consumed one - this races nothing and bounds the test.
    for (let i = 0; i < 40 && !closed; i += 1) {
      stapleRetry("new", `Follow trigger ${i}`);
      await delay(200);
    }
    const { status, stdout, stderr } = await captured;
    expect(status, stderr).toBe(0);
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!);
    expect(event.kind).toBe("issue_created");
    expect(event.seq).toBeGreaterThan(before);
  }, 45_000);

  it("hands each event to --exec as the final argument and as STAPLE_EVENT", async () => {
    const before = lastSeq();
    // --since pins the cursor, so the trigger below cannot outrun the follower's boot.
    const pending = stapleAsync(
      "events",
      "--follow",
      "--since",
      String(before),
      "--max",
      "1",
      "--interval",
      "25",
      "--exec",
      hook,
      "--json",
    );
    expect(stapleRetry("new", "Exec trigger").status).toBe(0);
    const { status, stderr } = await pending;
    expect(status, stderr).toBe(0);
    const fromArg = JSON.parse(readFileSync(hookArgFile, "utf8"));
    const fromEnv = JSON.parse(readFileSync(hookEnvFile, "utf8"));
    expect(fromArg.kind).toBe("issue_created");
    expect(fromArg.seq).toBeGreaterThan(before);
    expect(fromEnv.seq).toBe(fromArg.seq);
  }, 45_000);

  it("survives a failing --exec and still streams", async () => {
    const before = lastSeq();
    const pending = stapleAsync(
      "events",
      "--follow",
      "--since",
      String(before),
      "--max",
      "1",
      "--interval",
      "25",
      "--exec",
      "exit 3",
      "--json",
    );
    expect(stapleRetry("new", "Exec failure trigger").status).toBe(0);
    const { status, stdout, stderr } = await pending;
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split("\n")[0]!).kind).toBe("issue_created");
  }, 45_000);
});

describe("one-shot events output is unchanged", () => {
  it("keeps the padded human line format", () => {
    const { status, stdout } = staple("events");
    expect(status).toBe(0);
    const first = stdout.split("\n")[0]!;
    expect(first).toMatch(/^ {3}1 {2}\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} {2}issue_created {7}\{/);
  });
});
