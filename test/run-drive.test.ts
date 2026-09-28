/**
 * `staple run drive`, driven for real: the CLI as a child process over a scratch workspace
 * with the real store and migrations, and a fake headless agent
 * (`test/fixtures/run-drive/fake-agent.mjs`) as the provider. Never an LLM.
 *
 *   - Three tickets end to end: a fresh session per ticket, each with its brief, the run's
 *     actor and this workspace pinned in its environment, logs under the run directory.
 *   - Outcomes: a non-zero exit, a clean exit that leaves the ticket held, and a timeout
 *     are each failed with the reason; two in a row stop the run (failure_streak), exit 0.
 *   - `run stop` from another process ends a session mid-ticket: the session's whole
 *     process group dies, the ticket is released and recorded failed (stopped_by_human),
 *     the driver exits 0 and detaches. `run status` shows the driver while it is attached.
 *   - A wait sleeps and asks again; a stop during the wait ends the driver.
 *   - The provider rows, the custom template's quoting, --dry-run, and the refusals.
 *   - The driver's code runs no git and names no merge; the brief forbids merging and puts
 *     the adversarial review before the finish.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBrief } from "../src/core/run-brief.js";
import { DRIVE_PROVIDERS, PLACEHOLDERS, type PlaceholderValues, sessionCommand } from "../src/core/run-driver.js";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, runCliAtAsync, tempDir } from "./fixtures/characterize-support.js";
import { startMcpClient, toolPayload } from "./fixtures/contract-support.js";

const FAKE = join(REPO_ROOT, "test/fixtures/run-drive/fake-agent.mjs");
const ACTOR = "drive-bot";
let home: string;
const cleanup: string[] = [];
/** Drivers started in the background: a failing test must not leave one running. */
const drivers: ChildProcess[] = [];

beforeAll(() => {
  home = tempDir("run-drive-home");
});

afterAll(() => {
  for (const child of drivers) if (child.exitCode === null) child.kill("SIGKILL");
  for (const dir of cleanup) removeDir(dir);
  removeDir(home);
});

function env(agent = ACTOR): Record<string, string> {
  return { STAPLE_HOME: home, HOME: home, STAPLE_AGENT: agent };
}

async function cli(cwd: string, args: string[], agent = ACTOR, timeoutMs = 60_000) {
  return runCliAtAsync(cwd, args, env(agent), timeoutMs);
}

function lines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A scratch workspace in its own directory, with `titles` as tickets. */
async function workspace(titles: string[]): Promise<{ dir: string; refs: string[] }> {
  const dir = tempDir("run-drive-ws");
  cleanup.push(dir);
  const init = await cli(dir, ["init", "--json"], "vp");
  expect(init.status, init.stderr).toBe(0);
  const refs: string[] = [];
  for (const title of titles) {
    const created = await cli(dir, ["new", title, "--json"], "vp");
    expect(created.status, created.stderr).toBe(0);
    refs.push(String((JSON.parse(created.stdout) as { identifier: string }).identifier));
  }
  return { dir, refs };
}

function fake(mode: string): string[] {
  return ["--agent", "custom", "--command", `${process.execPath} ${FAKE} ${mode} {ref} {brief_file}`];
}

async function runOf(dir: string, id: string): Promise<{ run: Record<string, any>; driver: Record<string, any> | null }> {
  const status = await cli(dir, ["run", "status", id, "--json"]);
  expect(status.status, status.stderr).toBe(0);
  return JSON.parse(status.stdout) as { run: Record<string, any>; driver: Record<string, any> | null };
}

async function showIssue(dir: string, ref: string): Promise<Record<string, any>> {
  const shown = await cli(dir, ["show", ref, "--json"]);
  return (JSON.parse(shown.stdout) as { issue: Record<string, any> }).issue;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("run drive, end to end", () => {
  it("drives three tickets with a fresh session each, then stops on the budget", async () => {
    const { dir, refs } = await workspace(["create a.txt", "create b.txt", "create c.txt"]);
    const drove = await cli(dir, ["run", "drive", "--scope", "queue", "--max-tickets", "3", ...fake("review"), "--poll", "0.2", "--json"]);
    expect(drove.status, drove.stderr).toBe(0);
    const events = lines(drove.stdout);
    const attached = events[0]!;
    expect(attached).toMatchObject({ event: "attached", agent: "custom", pid: expect.any(Number) });
    const runId = String(attached.runId);
    expect(events.filter((e) => e.event === "take").map((e) => e.ref)).toEqual(refs);
    const ended = events.filter((e) => e.event === "session_ended");
    expect(ended).toHaveLength(3);
    for (const session of ended) expect(session).toMatchObject({ ended: "exited", exitCode: 0, outcome: null });
    // Three different session processes: a fresh session per ticket.
    expect(new Set(events.filter((e) => e.event === "session_started").map((e) => e.pid)).size).toBe(3);
    expect(events.at(-1)).toMatchObject({ event: "stop", reason: "budget", recorded: { ref: refs[2], outcome: "done" } });

    for (const ref of refs) expect(readFileSync(join(dir, `${ref}.txt`), "utf8")).toBe(`${ref}\n`);
    const { run, driver } = await runOf(dir, runId);
    expect(run.tickets.map((t: { outcome: string }) => t.outcome)).toEqual(["done", "done", "done"]);
    expect(driver).toBeNull(); // detached on exit

    const logDir = join(dir, ".staple", "runs", runId);
    expect(String(attached.logDir)).toBe(logDir);
    expect(readFileSync(join(dir, ".staple", "runs", ".gitignore"), "utf8")).toMatch(/^\*$/m);
    const first = JSON.parse(readFileSync(join(logDir, `001-${refs[0]}.stdout.log`), "utf8").split("\n")[0]!) as Record<string, any>;
    expect(first).toMatchObject({
      ref: refs[0],
      briefExists: true,
      cwd: dir,
      env: { STAPLE_AGENT: ACTOR, STAPLE_DB: join(dir, ".staple", "staple.db"), STAPLE_RUN: runId, STAPLE_RUN_TICKET: refs[0] },
    });
    expect(readFileSync(join(logDir, `002-${refs[1]}.brief.md`), "utf8")).toContain(`ONE ticket, ${refs[1]}`);
  }, 120_000);
});

describe("run drive outcomes", () => {
  it("a non-zero exit is failed with the exit code; the retry fails too and the run stops on the streak", async () => {
    const { dir, refs } = await workspace(["breaks"]);
    const drove = await cli(dir, ["run", "drive", "--scope", "queue", ...fake("fail"), "--poll", "0.2", "--json"]);
    expect(drove.status, drove.stderr).toBe(0);
    const events = lines(drove.stdout);
    expect(events.filter((e) => e.event === "session_ended").map((e) => [e.exitCode, e.outcome, e.reason])).toEqual([
      [3, "failed", "session exited 3"],
      [3, "failed", "session exited 3"],
    ]);
    expect(events.at(-1)).toMatchObject({ event: "stop", reason: "failure_streak" });
    expect((await showIssue(dir, refs[0]!)).checkoutAgent).toBeNull(); // released, back in the queue
  }, 60_000);

  it("a clean exit that leaves the ticket held is failed, not resumed forever", async () => {
    const { dir } = await workspace(["idles"]);
    const drove = await cli(dir, ["run", "drive", "--scope", "queue", ...fake("idle"), "--poll", "0.2", "--json"]);
    expect(drove.status, drove.stderr).toBe(0);
    const events = lines(drove.stdout);
    const ended = events.filter((e) => e.event === "session_ended");
    expect(ended).toHaveLength(2);
    expect(String(ended[0]!.reason)).toMatch(/^session exited 0 but left .+ and still held$/);
    expect(events.at(-1)).toMatchObject({ event: "stop", reason: "failure_streak" });
  }, 60_000);

  it("a session past --ticket-timeout is ended and failed", async () => {
    const { dir, refs } = await workspace(["hangs"]);
    const drove = await cli(dir, ["run", "drive", "--scope", "queue", ...fake("sleep"), "--ticket-timeout", "1s", "--poll", "0.2", "--json"]);
    expect(drove.status, drove.stderr).toBe(0);
    const events = lines(drove.stdout);
    const ended = events.filter((e) => e.event === "session_ended");
    expect(ended.map((e) => [e.ended, e.outcome])).toEqual([
      ["timeout", "failed"],
      ["timeout", "failed"],
    ]);
    expect(String(ended[0]!.reason)).toContain("timed out");
    const pids = JSON.parse(readFileSync(join(dir, `${refs[0]}.pids`), "utf8")) as { session: number; grandchild: number };
    expect(alive(pids.session)).toBe(false);
    expect(alive(pids.grandchild)).toBe(false);
  }, 60_000);
});

describe("run stop mid-ticket", () => {
  it("kills the session's process group, releases the ticket as failed stopped_by_human, and the driver exits 0", async () => {
    const { dir, refs } = await workspace(["long job"]);
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, "run", "drive", "--scope", "queue", ...fake("sleep"), "--poll", "0.2", "--json"], {
      cwd: dir,
      env: bareEnv(env()),
      stdio: ["ignore", "pipe", "pipe"],
    });
    drivers.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    const pidsFile = join(dir, `${refs[0]}.pids`);
    for (let i = 0; i < 150 && !existsSync(pidsFile); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(pidsFile), stderr).toBe(true);
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { session: number; grandchild: number };
    const runId = String(lines(stdout)[0]!.runId);
    const driverPid = Number(lines(stdout)[0]!.pid); // the node process tsx starts, not tsx itself

    // While the session works, run status shows the driver attached, on this ticket.
    const during = await runOf(dir, runId);
    expect(during.driver).toMatchObject({ pid: driverPid, alive: true, agent: "custom", ticket: refs[0], sessionPid: expect.any(Number) });

    // run_status over MCP answers the same driver.
    const mcp = await startMcpClient({ home, cwd: dir, agent: ACTOR });
    try {
      const result = await mcp.call("run_status", { run_id: runId });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect((toolPayload(result) as { runs: Array<{ driver: unknown }> }).runs[0]!.driver).toMatchObject({
        pid: driverPid,
        host: during.driver!.host,
        alive: true,
        ticket: refs[0],
        sessionPid: during.driver!.sessionPid,
        logDir: during.driver!.logDir,
      });
    } finally {
      await mcp.close();
    }

    // A second driver on the same run is refused while this one is alive.
    const second = await cli(dir, ["run", "drive", "--run", runId, ...fake("review"), "--json"]);
    expect(second.status).toBe(4);
    expect(second.stderr).toContain("already has a driver");

    const stopped = await cli(dir, ["run", "stop", runId, "-m", "enough", "--json"], "vp");
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(await exited).toBe(0);

    const events = lines(stdout);
    expect(events.find((e) => e.event === "session_ended")).toMatchObject({ ended: "stopped", outcome: "failed" });
    expect(events.at(-1)).toMatchObject({ event: "stop", reason: "stopped_by_human", recorded: { ref: refs[0], outcome: "failed", source: "stated" } });
    expect(String((events.at(-1)!.recorded as { reason: string }).reason)).toMatch(/^stopped_by_human: /);
    expect(alive(pids.session)).toBe(false);
    expect(alive(pids.grandchild)).toBe(false);
    const issue = await showIssue(dir, refs[0]!);
    expect(issue.checkoutAgent).toBeNull();
    const after = await runOf(dir, runId);
    expect(after.run.tickets[0]).toMatchObject({ outcome: "failed" });
    expect(after.driver).toBeNull();
  }, 60_000);

  it("an interrupted driver ends its session, leaves the ticket held and exits 130; the next driver resumes it", async () => {
    const { dir, refs } = await workspace(["resume me"]);
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, "run", "drive", "--scope", "queue", ...fake("sleep"), "--poll", "0.2", "--json"], {
      cwd: dir,
      env: bareEnv(env()),
      stdio: ["ignore", "pipe", "pipe"],
    });
    drivers.push(child);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const pidsFile = join(dir, `${refs[0]}.pids`);
    for (let i = 0; i < 150 && !existsSync(pidsFile); i++) await new Promise((r) => setTimeout(r, 100));
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { session: number; grandchild: number };
    const attached = lines(stdout)[0]!;
    process.kill(Number(attached.pid), "SIGINT");
    expect(await exited).toBe(130);
    expect(lines(stdout).find((e) => e.event === "session_ended")).toMatchObject({ ended: "interrupted", outcome: null });
    expect(alive(pids.session)).toBe(false);
    expect(alive(pids.grandchild)).toBe(false);
    expect((await showIssue(dir, refs[0]!)).checkoutAgent).toBe(ACTOR);
    const runId = String(attached.runId);
    const held = await runOf(dir, runId);
    expect(held.run).toMatchObject({ state: "active", counts: { open: 1, failed: 0 } });
    expect(held.driver).toBeNull();

    const resumed = await cli(dir, ["run", "drive", "--run", runId, "--max-tickets", "1", ...fake("review"), "--poll", "0.2", "--json"]);
    expect(resumed.status).toBe(2); // budget options start a run; they need --scope
    const again = await cli(dir, ["run", "drive", "--run", runId, ...fake("done"), "--poll", "0.2", "--json"]);
    expect(again.status, again.stderr).toBe(0);
    const events = lines(again.stdout);
    expect(events.find((e) => e.event === "take")).toMatchObject({ ref: refs[0], resumed: true });
    expect(events.at(-1)).toMatchObject({ event: "stop", reason: "scope_empty" });
  }, 60_000);

  it("a wait sleeps and asks again; a stop during the wait ends the driver", async () => {
    const { dir, refs } = await workspace(["someone else's"]);
    expect((await cli(dir, ["checkout", refs[0]!, "--json"], "other-agent")).status).toBe(0);
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, "run", "drive", "--scope", "queue", ...fake("review"), "--retry-after", "0.2", "--poll", "0.1", "--json"], {
      cwd: dir,
      env: bareEnv(env()),
      stdio: ["ignore", "pipe", "pipe"],
    });
    drivers.push(child);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    for (let i = 0; i < 150 && lines(stdout).filter((e) => e.event === "wait").length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    const waits = lines(stdout).filter((e) => e.event === "wait");
    expect(waits.length).toBeGreaterThanOrEqual(2); // asked again after the retry
    expect(waits[0]).toMatchObject({ reason: "waiting_on_others", retryAfterSeconds: 0.2 });
    const runId = String(lines(stdout)[0]!.runId);
    expect((await cli(dir, ["run", "stop", runId, "--json"], "vp")).status).toBe(0);
    expect(await exited).toBe(0);
    expect(lines(stdout).at(-1)).toMatchObject({ event: "stop", reason: "stopped_by_human" });
    expect(lines(stdout).some((e) => e.event === "session_started")).toBe(false);
  }, 60_000);
});

describe("run drive options", () => {
  it("--dry-run prints the exact command and the brief, and starts and claims nothing", async () => {
    const { dir, refs } = await workspace(["first"]);
    const dry = await cli(dir, ["run", "drive", "--scope", "queue", "--agent", "codex", "--model", "gpt-5-mini", "--dry-run", "--json"]);
    expect(dry.status, dry.stderr).toBe(0);
    const shown = JSON.parse(dry.stdout) as Record<string, any>;
    expect(shown).toMatchObject({ dryRun: true, next: { ref: refs[0] }, file: "codex", cwd: dir });
    expect(shown.args.slice(0, 6)).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox", "--color", "never", "-C", dir]);
    expect(shown.args.slice(-2)).toEqual(["-m", "gpt-5-mini"]);
    expect(shown.args[6]).toBe(shown.brief);
    expect(shown.command).toContain(`"$(cat `);
    const runs = await cli(dir, ["run", "status", "--all", "--json"]);
    expect(JSON.parse(runs.stdout)).toEqual({ runs: [] });
    expect((await showIssue(dir, refs[0]!)).checkoutAgent).toBeNull();
  }, 60_000);

  it("refuses an unknown agent, a custom agent without a template, --run with --scope and a zero poll, before starting a run", async () => {
    const { dir } = await workspace(["x"]);
    const unknown = await cli(dir, ["run", "drive", "--scope", "queue", "--agent", "nope", "--json"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("Unknown --agent");
    const bare = await cli(dir, ["run", "drive", "--scope", "queue", "--agent", "custom", "--json"]);
    expect(bare.status).toBe(2);
    const both = await cli(dir, ["run", "drive", "--scope", "queue", "--run", "abcdefgh", "--agent", "claude", "--json"]);
    expect(both.status).toBe(2);
    const busy = await cli(dir, ["run", "drive", "--scope", "queue", ...fake("review"), "--poll", "0", "--json"]);
    expect(busy.status).toBe(2);
    const runs = await cli(dir, ["run", "status", "--all", "--json"]);
    expect(JSON.parse(runs.stdout)).toEqual({ runs: [] });
  }, 60_000);
});

describe("provider rows", () => {
  const values: PlaceholderValues = {
    ref: "ABC-1",
    title: "t",
    brief: "the brief's text",
    brief_file: "/w/.staple/runs/r/001-ABC-1.brief.md",
    workspace: "/w",
    db: "/w/.staple/staple.db",
    run: "r",
    actor: "bot",
    model: "haiku",
    log_dir: "/w/.staple/runs/r",
  };

  it("claude runs headless with the brief, JSON output and the model", () => {
    const command = sessionCommand("claude", null, values);
    expect(command.file).toBe("claude");
    expect(command.args).toEqual(["-p", "the brief's text", "--output-format", "json", "--permission-mode", "bypassPermissions", "--no-session-persistence", "--model", "haiku"]);
    expect(command.unsetEnv).toContain("CLAUDECODE");
  });

  it("a model flag is left out when no model is given", () => {
    expect(sessionCommand("claude", null, { ...values, model: "" }).args).not.toContain("--model");
  });

  it("a custom template substitutes every placeholder shell-quoted", () => {
    const template = PLACEHOLDERS.map((name) => `{${name}}`).join(" ");
    const command = sessionCommand("custom", template, values);
    expect(command.file).toBe("/bin/sh");
    expect(command.args[1]).toBe(`ABC-1 t 'the brief'\\''s text' /w/.staple/runs/r/001-ABC-1.brief.md /w /w/.staple/staple.db r bot haiku /w/.staple/runs/r`);
  });

  it("every row names only placeholders the driver fills", () => {
    for (const row of Object.values(DRIVE_PROVIDERS)) {
      for (const arg of [...row.args, ...row.modelArgs]) {
        for (const [, name] of arg.matchAll(/\{([a-z_]+)\}/g)) expect(PLACEHOLDERS).toContain(name);
      }
    }
  });
});

describe("no merge path", () => {
  const DRIVER_SOURCES = ["src/core/run-driver.ts", "src/commands/run-drive.ts", "src/core/run-attachment.ts"];

  it("the driver's code names no merge and runs no git: its only spawn is the provider's session", () => {
    for (const file of DRIVER_SOURCES) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(text, file).not.toMatch(/merge/i);
      expect(text, file).not.toMatch(/["'`](git|gh)["'`]/);
      expect(text, file).not.toMatch(/\b(exec|execSync|execFile|execFileSync|spawnSync)\s*\(/);
    }
    const driver = readFileSync(join(REPO_ROOT, "src/core/run-driver.ts"), "utf8");
    expect([...driver.matchAll(/\bspawn\s*\(/g)].map((m) => driver.slice(m.index, m.index + 35))).toEqual(["spawn(command.file, command.args, {"]);
  });

  it("the brief forbids merging and puts the adversarial review before the finish", () => {
    const brief = buildBrief({ ref: "ABC-1", title: "t", workspace: "/w", db: "/w/.staple/staple.db", runId: "r", actor: "bot", finish: "in_review", instructions: null });
    expect(brief).toContain("NEVER merge anything into master or main");
    expect(brief).toContain("gh pr merge");
    const review = brief.indexOf("Adversarial review, before you finish");
    const finish = brief.indexOf("staple status ABC-1 in_review");
    expect(review).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(review);
    expect(brief).toContain("Reproduce, do not read");
    expect(brief).toContain("ALREADY CHECKED OUT");
    expect(brief).toContain("STAPLE_AGENT=bot");
    expect(buildBrief({ ref: "ABC-1", title: "t", workspace: "/w", db: "/d", runId: "r", actor: "bot", finish: "done", instructions: "run make check" })).toMatch(
      /staple done ABC-1[\s\S]*run make check/,
    );
  });
});
