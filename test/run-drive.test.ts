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
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBrief } from "../src/core/run-brief.js";
import { DRIVE_PROVIDERS, PLACEHOLDERS, type PlaceholderValues, sessionCommand } from "../src/core/run-driver.js";
import { mainLineGuardGap, mainLineMoves, mainLineSnapshot } from "../src/core/main-line-guard.js";
import { openWorkspace } from "../src/core/open.js";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, runCliAtAsync, tempDir } from "./fixtures/characterize-support.js";
import { startMcpClient, toolPayload } from "./fixtures/contract-support.js";

const FAKE = join(REPO_ROOT, "test/fixtures/run-drive/fake-agent.mjs");
const ACTOR = "drive-bot";
let home: string;
const cleanup: string[] = [];
/** Drivers started in the background: a failing test must not leave one running. */
const drivers: Array<{ child: ChildProcess; out: () => string }> = [];

beforeAll(() => {
  home = tempDir("run-drive-home");
});

afterAll(() => {
  // tsx runs the driver as its own child, and the driver's sessions lead their own groups:
  // kill each by the pids the driver reported, not only the wrapper.
  for (const { child, out } of drivers) {
    for (const event of lines(out())) {
      for (const pid of [event.event === "attached" ? Number(event.pid) : null, event.event === "session_started" ? -Number(event.pid) : null]) {
        if (pid === null) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    if (child.exitCode === null) child.kill("SIGKILL");
  }
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

/** The one file in `dir` named `<prefix>-<instant>.<suffix>`. */
function sessionFile(dir: string, prefix: string, suffix: string): string {
  const found = readdirSync(dir).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(suffix));
  expect(found, `${prefix}*${suffix} in ${dir}`).toHaveLength(1);
  return join(dir, found[0]!);
}

/** `run drive` as a background child, its stdout collected. */
function startDriver(dir: string, args: string[]): { child: ChildProcess; out: () => string; err: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, "run", "drive", ...args, "--json"], {
    cwd: dir,
    env: bareEnv(env()),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  drivers.push({ child, out: () => stdout });
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, out: () => stdout, err: () => stderr, exited };
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
}

function readPids(dir: string, ref: string): { session: number; grandchild: number } {
  return JSON.parse(readFileSync(join(dir, `${ref}.pids`), "utf8")) as { session: number; grandchild: number };
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
    const first = JSON.parse(readFileSync(sessionFile(logDir, `001-${refs[0]}`, ".stdout.log"), "utf8").split("\n")[0]!) as Record<string, any>;
    expect(first).toMatchObject({
      ref: refs[0],
      briefExists: true,
      cwd: dir,
      env: { STAPLE_AGENT: ACTOR, STAPLE_DB: join(dir, ".staple", "staple.db"), STAPLE_RUN: runId, STAPLE_RUN_TICKET: refs[0] },
    });
    expect(readFileSync(sessionFile(logDir, `002-${refs[1]}`, ".brief.md"), "utf8")).toContain(`ONE ticket, ${refs[1]}`);
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

  it("a ticket handed on without its review comment is failed as no_review", async () => {
    const { dir } = await workspace(["skips review"]);
    const drove = await cli(dir, ["run", "drive", "--scope", "queue", ...fake("unreviewed"), "--max-tickets", "1", "--retry-after", "0.2", "--poll", "0.2", "--json"]);
    expect(drove.status, drove.stderr).toBe(0);
    const events = lines(drove.stdout);
    const ended = events.filter((e) => e.event === "session_ended");
    expect(ended[0]).toMatchObject({ outcome: "failed" });
    expect(String(ended[0]!.reason)).toMatch(/^no_review: /);
  }, 60_000);

  it("the review is found however many comments came before the session", async () => {
    const { dir, refs } = await workspace(["long history"]);
    const opened = openWorkspace(join(dir, ".staple", "staple.db"));
    try {
      opened.store.journaled(() => {
        for (let i = 0; i < 1001; i++) opened.store.addComment(refs[0]!, `note ${i}`, "vp");
      });
    } finally {
      opened.store.db.close();
    }
    const drove = await cli(dir, ["run", "drive", "--scope", "queue", "--max-tickets", "1", ...fake("review"), "--poll", "0.2", "--json"]);
    expect(drove.status, drove.stderr).toBe(0);
    expect(lines(drove.stdout).find((e) => e.event === "session_ended")).toMatchObject({ outcome: null, reason: null });
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
    const { out, err, exited } = startDriver(dir, ["--scope", "queue", ...fake("sleep"), "--poll", "0.2"]);

    const pidsFile = join(dir, `${refs[0]}.pids`);
    for (let i = 0; i < 150 && !existsSync(pidsFile); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(pidsFile), err()).toBe(true);
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { session: number; grandchild: number };
    const runId = String(lines(out())[0]!.runId);
    const driverPid = Number(lines(out())[0]!.pid); // the node process tsx starts, not tsx itself

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

    const events = lines(out());
    expect(events.find((e) => e.event === "session_ended")).toMatchObject({ ended: "stopped", outcome: "failed" });
    // `run stop` itself failed and released the held ticket (every stop path does), so the
    // driver's own continue had nothing left to record.
    expect(events.at(-1)).toMatchObject({ event: "stop", reason: "stopped_by_human", recorded: null });
    expect(alive(pids.session)).toBe(false);
    expect(alive(pids.grandchild)).toBe(false);
    const issue = await showIssue(dir, refs[0]!);
    expect(issue.checkoutAgent).toBeNull();
    const after = await runOf(dir, runId);
    expect(after.run.tickets[0]).toMatchObject({ outcome: "failed", reason: "stopped_by_human: enough" });
    expect(after.driver).toBeNull();
  }, 60_000);

  it("an interrupted driver ends its session, leaves the ticket held and exits 130; the next driver resumes it", async () => {
    const { dir, refs } = await workspace(["resume me"]);
    const { out, exited } = startDriver(dir, ["--scope", "queue", ...fake("sleep"), "--poll", "0.2"]);
    const pidsFile = join(dir, `${refs[0]}.pids`);
    for (let i = 0; i < 150 && !existsSync(pidsFile); i++) await new Promise((r) => setTimeout(r, 100));
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { session: number; grandchild: number };
    const attached = lines(out())[0]!;
    process.kill(Number(attached.pid), "SIGINT");
    expect(await exited).toBe(130);
    expect(lines(out()).find((e) => e.event === "session_ended")).toMatchObject({ ended: "interrupted", outcome: null });
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
    // Two sessions of one ticket from two drivers: each keeps its own brief and logs, and
    // the second was told it is resuming.
    const logDir = String(attached.logDir);
    const briefs = readdirSync(logDir).filter((name) => name.startsWith(`001-${refs[0]}-`) && name.endsWith(".brief.md")).sort();
    expect(briefs).toHaveLength(2);
    expect(readFileSync(join(logDir, briefs[0]!), "utf8")).not.toContain("RESUMING");
    expect(readFileSync(join(logDir, briefs[1]!), "utf8")).toContain("RESUMING");
  }, 60_000);

  it("a wait sleeps and asks again; a stop during the wait ends the driver", async () => {
    const { dir, refs } = await workspace(["someone else's"]);
    expect((await cli(dir, ["checkout", refs[0]!, "--json"], "other-agent")).status).toBe(0);
    const { out, exited } = startDriver(dir, ["--scope", "queue", ...fake("review"), "--retry-after", "0.2", "--poll", "0.1"]);
    for (let i = 0; i < 150 && lines(out()).filter((e) => e.event === "wait").length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    const waits = lines(out()).filter((e) => e.event === "wait");
    expect(waits.length).toBeGreaterThanOrEqual(2); // asked again after the retry
    expect(waits[0]).toMatchObject({ reason: "waiting_on_others", retryAfterSeconds: 0.2 });
    const runId = String(lines(out())[0]!.runId);
    expect((await cli(dir, ["run", "stop", runId, "--json"], "vp")).status).toBe(0);
    expect(await exited).toBe(0);
    expect(lines(out()).at(-1)).toMatchObject({ event: "stop", reason: "stopped_by_human" });
    expect(lines(out()).some((e) => e.event === "session_started")).toBe(false);
  }, 60_000);
});


describe("nothing outlives its session", () => {
  it("a session that exits 0 takes the children it left running with it", async () => {
    const { dir, refs } = await workspace(["leaves a child"]);
    const drove = await cli(dir, ["run", "drive", "--scope", "queue", "--max-tickets", "1", ...fake("background"), "--poll", "0.2", "--json"]);
    expect(drove.status, drove.stderr).toBe(0);
    expect(lines(drove.stdout).find((e) => e.event === "session_ended")).toMatchObject({ ended: "exited", exitCode: 0, outcome: null });
    const pids = readPids(dir, refs[0]!);
    await until(() => !alive(pids.grandchild), 3_000);
    expect(alive(pids.grandchild)).toBe(false);
  }, 60_000);

  it("a driver killed with -9 leaves its session; the next driver refuses to kill what it cannot prove is its own, naming the group, so the ticket never has two sessions", async () => {
    const { dir, refs } = await workspace(["orphaned"]);
    const first = startDriver(dir, ["--scope", "queue", ...fake("sleep"), "--poll", "0.2"]);
    await until(() => existsSync(join(dir, `${refs[0]}.pids`)));
    const pids = readPids(dir, refs[0]!);
    const attached = lines(first.out())[0]!;
    process.kill(Number(attached.pid), "SIGKILL");
    await first.exited;
    expect(alive(pids.session)).toBe(true); // nobody ended it
    const runId = String(attached.runId);
    expect((await runOf(dir, runId)).driver).toMatchObject({ alive: false, sessionPid: expect.any(Number) });

    // The pgid could by now lead a stranger: the driver refuses, names it, and kills nothing.
    const refused = await cli(dir, ["run", "drive", "--run", runId, ...fake("sleep"), "--poll", "0.2", "--json"]);
    expect(refused.status).toBe(4);
    const error = JSON.parse(refused.stderr.trim().split("\n").at(-1)!) as { code: string; message: string; detail: Record<string, unknown> };
    expect(error).toMatchObject({ code: "conflict", detail: { pgid: pids.session, ticket: refs[0], driverPid: Number(attached.pid), sessionStartedAt: expect.any(String) } });
    expect(error.message).toContain(`kill -TERM -${pids.session}`);
    expect(error.message).toContain("--forget-stale-session");
    expect(alive(pids.session)).toBe(true);

    // A person who checked it: --forget-stale-session goes on, still killing nothing.
    const second = startDriver(dir, ["--run", runId, ...fake("sleep"), "--poll", "0.2", "--forget-stale-session"]);
    await until(() => lines(second.out()).some((e) => e.event === "session_started"));
    const events = lines(second.out());
    expect(events.find((e) => e.event === "stale_session_forgotten")).toMatchObject({ pid: pids.session, ticket: refs[0], driverPid: Number(attached.pid) });
    expect(events.find((e) => e.event === "take")).toMatchObject({ ref: refs[0], resumed: true });
    expect(alive(pids.session)).toBe(true);

    // The test started that orphan: end it, as the message says.
    process.kill(-pids.session, "SIGKILL");
    await until(() => !alive(pids.session) && !alive(pids.grandchild), 3_000);
    expect((await cli(dir, ["run", "stop", runId, "--json"], "vp")).status).toBe(0);
    expect(await second.exited).toBe(0);
  }, 60_000);

  it("a second Ctrl-C KILLs a session that ignores TERM at once, and the driver still cleans up", async () => {
    const { dir, refs } = await workspace(["stubborn"]);
    const driver = startDriver(dir, ["--scope", "queue", ...fake("stubborn"), "--poll", "0.2"]);
    await until(() => existsSync(join(dir, `${refs[0]}.pids`)));
    const pids = readPids(dir, refs[0]!);
    const attached = lines(driver.out())[0]!;
    const began = Date.now();
    process.kill(Number(attached.pid), "SIGINT");
    await new Promise((r) => setTimeout(r, 400));
    expect(alive(pids.session)).toBe(true); // TERM ignored; inside the five-second grace
    process.kill(Number(attached.pid), "SIGINT");
    expect(await driver.exited).toBe(130);
    expect(Date.now() - began).toBeLessThan(4_000); // did not wait out the grace
    expect(alive(pids.session)).toBe(false);
    expect(alive(pids.grandchild)).toBe(false);
    expect((await runOf(dir, String(attached.runId))).driver).toBeNull();
  }, 60_000);

  it("two drivers started on one run at the same instant: one attaches, the other is refused", async () => {
    const { dir } = await workspace(["contended"]);
    const started = await cli(dir, ["run", "start", "--scope", "queue", "--json"]);
    const runId = String((JSON.parse(started.stdout) as { id: string }).id);
    const a = startDriver(dir, ["--run", runId, ...fake("sleep"), "--poll", "0.2"]);
    const b = startDriver(dir, ["--run", runId, ...fake("sleep"), "--poll", "0.2"]);
    const loser = await Promise.race([a.exited.then(() => a), b.exited.then(() => b)]);
    const winner = loser === a ? b : a;
    expect(await loser.exited, loser.err()).toBe(4);
    expect(loser.err()).toContain("already has a driver");
    await until(() => lines(winner.out()).some((e) => e.event === "session_started"));
    expect(lines(winner.out()).filter((e) => e.event === "session_started")).toHaveLength(1);
    expect((await cli(dir, ["run", "stop", runId, "--json"], "vp")).status).toBe(0);
    expect(await winner.exited).toBe(0);
  }, 60_000);
});

describe("the driver lock", () => {
  it("a run whose lock a live process holds is refused, even with no driver.json yet; a dead owner's lock is taken over", async () => {
    const { dir } = await workspace(["locked"]);
    const started = await cli(dir, ["run", "start", "--scope", "queue", "--json"]);
    const runId = String((JSON.parse(started.stdout) as { id: string }).id);
    const runDir = join(dir, ".staple", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    // This test's own process: alive on this host, and no driver.json has been written.
    writeFileSync(join(runDir, "driver.lock"), JSON.stringify({ pid: process.pid, host: hostname() }));
    const refused = await cli(dir, ["run", "drive", "--run", runId, ...fake("done"), "--poll", "0.2", "--json"]);
    expect(refused.status).toBe(4);
    expect(refused.stderr).toContain(`pid ${process.pid}`);

    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(join(runDir, "driver.lock"), JSON.stringify({ pid: Number(dead.stdout), host: hostname() }));
    const drove = await cli(dir, ["run", "drive", "--run", runId, ...fake("done"), "--poll", "0.2", "--json"]);
    expect(drove.status, drove.stderr).toBe(0);
    expect(lines(drove.stdout).at(-1)).toMatchObject({ event: "stop", reason: "scope_empty" });
    expect(existsSync(join(runDir, "driver.lock"))).toBe(false); // released on exit
  }, 60_000);
});

describe("the main-line guard", () => {
  it("a session that moves master is failed touched_main_line and the run is stopped", async () => {
    const { dir, refs } = await workspace(["lands on master", "never reached"]);
    mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(dir, ".git", "refs", "heads", "master"), "1111111111111111111111111111111111111111\n");
    const drove = await cli(dir, ["run", "drive", "--scope", "queue", ...fake("mainline"), "--poll", "0.2", "--json"]);
    expect(drove.status, drove.stderr).toBe(0);
    const events = lines(drove.stdout);
    expect(events.find((e) => e.event === "main_line_moved")).toMatchObject({ ref: refs[0], moves: ["master 111111111111 -> 222222222222"] });
    expect(events.find((e) => e.event === "session_ended")).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/^touched_main_line: /) });
    expect(events.at(-1)).toMatchObject({ event: "stop", reason: "touched_main_line", recorded: { ref: refs[0], outcome: "failed" } });
    expect(events.filter((e) => e.event === "take")).toHaveLength(1); // nothing more ran
    const { run } = await runOf(dir, String(events[0]!.runId));
    expect(run.stop).toMatchObject({ reason: "touched_main_line", by: "staple run drive", note: expect.stringContaining("touched_main_line"), detail: { ticket: refs[0] } });
  }, 60_000);

  it("a driver interrupted after its session moved master still leaves the ticket failed and released", async () => {
    const { dir, refs } = await workspace(["lands and lingers"]);
    mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(dir, ".git", "refs", "heads", "master"), "1111111111111111111111111111111111111111\n");
    const driver = startDriver(dir, ["--scope", "queue", ...fake("mainline-sleep"), "--poll", "0.2"]);
    await until(() => existsSync(join(dir, `${refs[0]}.pids`)));
    const pids = readPids(dir, refs[0]!);
    process.kill(Number(lines(driver.out())[0]!.pid), "SIGINT");
    expect(await driver.exited).toBe(130);
    expect(alive(pids.session)).toBe(false);
    expect((await showIssue(dir, refs[0]!)).checkoutAgent).toBeNull();
    const { run } = await runOf(dir, String(lines(driver.out())[0]!.runId));
    expect(run).toMatchObject({ state: "stopped", stop: { reason: "touched_main_line" } });
    expect(run.tickets[0]).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/^touched_main_line: /) });
  }, 60_000);

  it("a driver interrupted after a session moved master and handed its ticket on still records it failed", async () => {
    const { dir, refs } = await workspace(["lands and hands on"]);
    mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(dir, ".git", "refs", "heads", "master"), "1111111111111111111111111111111111111111\n");
    const driver = startDriver(dir, ["--scope", "queue", ...fake("mainline-handed-on"), "--poll", "0.2"]);
    await until(() => existsSync(join(dir, `${refs[0]}.pids`)));
    // Not held any more, so run stop has nothing to release: only the driver knows it failed.
    for (let i = 0; i < 150 && (await showIssue(dir, refs[0]!)).status !== "in_review"; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await showIssue(dir, refs[0]!)).status).toBe("in_review");
    process.kill(Number(lines(driver.out())[0]!.pid), "SIGINT");
    expect(await driver.exited).toBe(130);
    const { run } = await runOf(dir, String(lines(driver.out())[0]!.runId));
    expect(run).toMatchObject({ state: "stopped", stop: { reason: "touched_main_line" } });
    expect(run.tickets[0]).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/^touched_main_line: /) });
  }, 60_000);

  it("says once, at attach, that a reftable repository's main line cannot be guarded", async () => {
    const { dir } = await workspace(["unguarded"]);
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = reftable\n");
    const drove = await cli(dir, ["run", "drive", "--scope", "queue", "--max-tickets", "1", ...fake("review"), "--poll", "0.2", "--json"]);
    expect(drove.status, drove.stderr).toBe(0);
    const events = lines(drove.stdout);
    expect(events.filter((e) => e.event === "main_line_unguarded")).toEqual([{ event: "main_line_unguarded", reason: expect.stringContaining("reftable") }]);
    expect(mainLineSnapshot(dir)).toBeNull();
  }, 60_000);

  it("knows a reftable repository by a quoted, commented setting and by its reftable directory", () => {
    const quoted = tempDir("run-drive-guard");
    cleanup.push(quoted);
    mkdirSync(join(quoted, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(quoted, ".git", "config"), '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = "reftable" ; set by init\n');
    expect(mainLineGuardGap(quoted)).toContain("reftable");
    expect(mainLineSnapshot(quoted)).toBeNull();
    const byDirectory = tempDir("run-drive-guard");
    cleanup.push(byDirectory);
    mkdirSync(join(byDirectory, ".git", "reftable"), { recursive: true });
    writeFileSync(join(byDirectory, ".git", "config"), "[core]\n\trepositoryformatversion = 1\n");
    expect(mainLineGuardGap(byDirectory)).toContain("reftable");
    const files = tempDir("run-drive-guard");
    cleanup.push(files);
    mkdirSync(join(files, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(files, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    expect(mainLineGuardGap(files)).toBeNull();
  });

  it("reads a linked worktree's shared refs and packed-refs, with no git process", () => {
    const root = tempDir("run-drive-guard");
    cleanup.push(root);
    const common = join(root, "main-checkout", ".git");
    const worktreeGitDir = join(common, "worktrees", "wt");
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(join(common, "refs", "heads"), { recursive: true });
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
    writeFileSync(join(common, "packed-refs"), "# pack-refs with: peeled\naaaa refs/heads/main\nbbbb refs/heads/feature\n");
    const wt = join(root, "wt");
    mkdirSync(join(wt, "sub"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${worktreeGitDir}\n`);
    expect(mainLineSnapshot(join(wt, "sub"))).toEqual({ master: null, main: "aaaa" });
    writeFileSync(join(common, "refs", "heads", "master"), "cccc\n");
    const after = mainLineSnapshot(wt);
    expect(after).toEqual({ master: "cccc", main: "aaaa" });
    expect(mainLineMoves({ master: null, main: "aaaa" }, after)).toEqual(["master (none) -> cccc"]);
    expect(mainLineSnapshot(root)).toBeNull();
  });
});

describe("run drive options", () => {
  it("--dry-run prints the exact command and the brief, and starts and claims nothing", async () => {
    const { dir, refs } = await workspace(["first"]);
    const dry = await cli(dir, ["run", "drive", "--scope", "queue", "--agent", "codex", "--model", "gpt-5-mini", "--dry-run", "--json"]);
    expect(dry.status, dry.stderr).toBe(0);
    const shown = JSON.parse(dry.stdout) as Record<string, any>;
    expect(shown).toMatchObject({ dryRun: true, next: { ref: refs[0] }, file: "codex", cwd: dir });
    expect(shown.args.slice(0, 5)).toEqual(["exec", "--color", "never", "-C", dir]);
    expect(shown.args.slice(-2)).toEqual(["-m", "gpt-5-mini"]);
    expect(shown.args[5]).toBe(shown.brief);
    expect(shown.command).toContain(`"$(cat `);
    const runs = await cli(dir, ["run", "status", "--all", "--json"]);
    expect(JSON.parse(runs.stdout)).toEqual({ runs: [] });
    expect((await showIssue(dir, refs[0]!)).checkoutAgent).toBeNull();
  }, 60_000);

  it("refuses an unknown agent, a custom agent without a template, --run with --scope, a zero poll and a zero retry, before starting a run", async () => {
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
    const spin = await cli(dir, ["run", "drive", "--scope", "queue", ...fake("review"), "--retry-after", "0", "--json"]);
    expect(spin.status).toBe(2);
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
    expect(command.args).toEqual(["-p", "the brief's text", "--output-format", "json", "--no-session-persistence", "--model", "haiku"]);
    expect(command.unsetEnv).toContain("CLAUDECODE");
  });

  it("adds no permission flag unless --full-access asks for one", () => {
    expect(sessionCommand("claude", null, values).args).not.toContain("--permission-mode");
    expect(sessionCommand("codex", null, values).args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(sessionCommand("claude", null, values, { fullAccess: true }).args).toContain("bypassPermissions");
    expect(sessionCommand("codex", null, values, { fullAccess: true }).args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(() => sessionCommand("custom", "run {ref}", values, { fullAccess: true })).toThrow(/--full-access applies to the built-in providers/);
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
  const DRIVER_SOURCES = ["src/core/run-driver.ts", "src/commands/run-drive.ts", "src/core/run-attachment.ts", "src/core/main-line-guard.ts"];

  /**
   * A lint, and knowingly only that: the guard test above is what catches a session that
   * lands work on the main line. This keeps the driver's own code from growing a second
   * way to start a process: one import of child_process, in one file, of `spawn` alone,
   * called once, with the provider's command; no dynamic import or require anywhere.
   */
  it("the driver's code starts one kind of process, the provider's session, and names no merge", () => {
    for (const file of [...DRIVER_SOURCES, "src/core/run-brief.ts"]) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      if (file !== "src/core/run-brief.ts") expect(text, file).not.toMatch(/merge/i);
      expect(text, file).not.toMatch(/["'`](git|gh)["'`]/);
      expect(text, file).not.toMatch(/\b(require|import)\s*\(/);
      expect(text, file).not.toMatch(/process\.binding|process\.dlopen|worker_threads|node:cluster/);
      const imports = [...text.matchAll(/import\s+([^;]*?)\s+from\s+["'](node:)?child_process["']/g)].map((m) => m[1]);
      expect(imports, file).toEqual(file === "src/core/run-driver.ts" ? ["{ spawn }"] : []);
    }
    const driver = readFileSync(join(REPO_ROOT, "src/core/run-driver.ts"), "utf8");
    // `spawn` used once, as a call, on the provider's command: never passed around or indexed.
    // (The child's "spawn" event name, quoted, is not the function.)
    expect([...driver.matchAll(/(?<!")\bspawn\b(?!")/g)].map((m) => driver.slice(m.index, m.index + 20))).toEqual([
      'spawn } from "node:c',
      "spawn(command.file, ",
    ]);
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
