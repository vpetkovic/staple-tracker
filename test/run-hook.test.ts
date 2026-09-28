/**
 * `staple run hook`: the interactive stop-hook adapters, driven for real. The CLI runs as a
 * child process over a scratch workspace (real store, real migrations) in a temporary
 * home, and the provider's payload goes in on stdin exactly as the provider documents it
 * (`test/fixtures/run-hook/*.json` are the documentation's own samples).
 *
 *   - Claude Code: an unbound session is never touched; a bound one is handed the next
 *     ticket (already claimed), held to an unfinished ticket, asked for a missing review,
 *     and let go on wait and on stop with the reason shown. The loop guards (same reminder
 *     in a row, continuations in a row) let the session stop; a fresh prompt resets them.
 *     A failure of any kind exits 0 (exit 2 would be a block).
 *   - Sessions run drive started, sub-agents and runs a driver is attached to are left alone.
 *   - bind / unbind, and install: print, write with a backup, idempotent, refusals.
 *   - End to end: a scripted fake session that does what each block says, until the hook
 *     lets it stop, works a whole scope.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";

const ACTOR = "hook-bot";
const SAMPLE = JSON.parse(readFileSync(join(REPO_ROOT, "test/fixtures/run-hook/claude-stop.json"), "utf8")) as Record<string, unknown>;
const cleanup: string[] = [];
let home: string;

afterAll(() => {
  for (const dir of cleanup) removeDir(dir);
});

beforeEach(() => {
  home = tempDir("run-hook-home");
  cleanup.push(home);
});

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  const base = bareEnv({ STAPLE_HOME: join(home, ".staple"), HOME: home, STAPLE_AGENT: ACTOR, ...extra });
  // This suite may itself run inside an agent CLI's session: its variables must not leak in.
  for (const key of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME", "GEMINI_SESSION_ID"]) if (!(key in extra)) delete base[key];
  return base;
}

function cli(cwd: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}): Result {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd,
    env: env(options.env),
    input: options.input ?? "",
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function ok(cwd: string, args: string[], options: { env?: Record<string, string> } = {}): any {
  const result = cli(cwd, [...args, "--json"], options);
  expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

/** A scratch workspace with an epic and `titles` under it; returns the refs. */
function workspace(titles: string[]): { dir: string; epic: string; refs: string[] } {
  const dir = tempDir("run-hook-ws");
  cleanup.push(dir);
  ok(dir, ["init"]);
  const epic = ok(dir, ["new", "The epic", "--kind", "epic"]).identifier as string;
  const refs = titles.map((title) => ok(dir, ["new", title, "--parent", epic]).identifier as string);
  return { dir, epic, refs };
}

function startAndBind(dir: string, scope: string, session = "sess-1", extra: string[] = []): string {
  const run = ok(dir, ["run", "start", "--scope", scope, ...extra]);
  ok(dir, ["run", "hook", "bind", "--session", session]);
  return run.id as string;
}

/** The Claude Code hook with the documentation's sample payload, `session_id` and `stop_hook_active` set. */
function claudeStop(dir: string, overrides: Record<string, unknown>, options: { env?: Record<string, string>; args?: string[] } = {}): { status: number; answer: Record<string, any> | null; raw: string } {
  const payload = { ...SAMPLE, session_id: "sess-1", stop_hook_active: false, cwd: dir, ...overrides };
  const result = cli(dir, ["run", "hook", "claude-stop", ...(options.args ?? [])], { input: JSON.stringify(payload), env: options.env });
  return { status: result.status, answer: result.stdout.trim() === "" ? null : (JSON.parse(result.stdout) as Record<string, any>), raw: result.stdout };
}

function issue(dir: string, ref: string): Record<string, any> {
  return ok(dir, ["show", ref]).issue as Record<string, any>;
}

function runOf(dir: string, id: string): Record<string, any> {
  return ok(dir, ["run", "status", id]).run as Record<string, any>;
}

function bindingFiles(): string[] {
  const dir = join(home, ".staple", "run-sessions");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("claude-stop: a bound session works the run", () => {
  it("leaves an unbound session alone: no output, exit 0, nothing taken", () => {
    const { dir, epic, refs } = workspace(["one"]);
    ok(dir, ["run", "start", "--scope", epic]);
    const answer = claudeStop(dir, {});
    expect(answer).toMatchObject({ status: 0, answer: null });
    expect(issue(dir, refs[0]!).checkoutAgent).toBeNull();
  });

  it("hands the next ticket as a block, already claimed by the run's actor", () => {
    const { dir, epic, refs } = workspace(["one", "two"]);
    const runId = startAndBind(dir, epic);
    const { status, answer } = claudeStop(dir, {});
    expect(status).toBe(0);
    expect(answer?.decision).toBe("block");
    expect(answer?.reason).toContain(`next ticket ${refs[0]} "one"`);
    expect(answer?.reason).toContain("do not check it out again");
    expect(answer?.reason).toMatch(/never merge to master or main/i);
    expect(answer?.reason).toContain(`staple comment ${refs[0]} "review: ...`);
    expect(answer?.reason).toContain(`STAPLE_AGENT=${ACTOR}`);
    expect(issue(dir, refs[0]!)).toMatchObject({ checkoutAgent: ACTOR, status: "in_progress" });
    expect(runOf(dir, runId).tickets.map((ticket: any) => ticket.identifier)).toEqual([refs[0]]);
  });

  it("holds the session to an unfinished ticket without recording anything, then lets go after the repeat limit", () => {
    const { dir, epic, refs } = workspace(["one", "two"]);
    const runId = startAndBind(dir, epic);
    claudeStop(dir, {});
    const first = claudeStop(dir, { stop_hook_active: true });
    expect(first.answer?.decision).toBe("block");
    expect(first.answer?.reason).toContain(`${refs[0]} "one" is still checked out to ${ACTOR} and in_progress`);
    expect(first.answer?.reason).toContain(`--outcome failed`);
    const second = claudeStop(dir, { stop_hook_active: true });
    expect(second.answer?.decision).toBe("block");
    const third = claudeStop(dir, { stop_hook_active: true });
    expect(third.status).toBe(0);
    expect(third.answer?.decision).toBeUndefined();
    expect(third.answer?.systemMessage).toContain(`2 reminders in a row about ${refs[0]}`);
    // Nothing was recorded or released: the run and the claim are as they were.
    expect(runOf(dir, runId)).toMatchObject({ state: "active", tickets: [{ identifier: refs[0], outcome: null }] });
    expect(issue(dir, refs[0]!).checkoutAgent).toBe(ACTOR);
    // A fresh prompt from the person (stop_hook_active false) resets the guard.
    expect(claudeStop(dir, {}).answer?.decision).toBe("block");
    // A lower limit on the command line is honoured.
    const limited = claudeStop(dir, { stop_hook_active: true }, { args: ["--max-repeats", "1"] });
    expect(limited.answer?.systemMessage).toContain("1 reminders in a row");
  });

  it("asks for the review when the ticket was handed on without one, then takes the next once it is there", () => {
    const { dir, epic, refs } = workspace(["one", "two"]);
    startAndBind(dir, epic);
    claudeStop(dir, {});
    ok(dir, ["status", refs[0]!, "in_review"]);
    const unreviewed = claudeStop(dir, { stop_hook_active: true });
    expect(unreviewed.answer?.decision).toBe("block");
    expect(unreviewed.answer?.reason).toContain(`${refs[0]} is in_review but has no review since the run took it`);
    expect(issue(dir, refs[1]!).checkoutAgent).toBeNull();
    ok(dir, ["comment", refs[0]!, "review: reproduced each criterion; nothing found"]);
    const next = claudeStop(dir, { stop_hook_active: true });
    expect(next.answer?.reason).toContain(`next ticket ${refs[1]} "two"`);
    expect(issue(dir, refs[1]!).checkoutAgent).toBe(ACTOR);
  });

  it("lets the session stop on a stop answer, shows who stopped it and why, and unbinds", () => {
    const { dir, epic, refs } = workspace(["one", "two"]);
    const runId = startAndBind(dir, epic);
    claudeStop(dir, {});
    // A person stops it, from anywhere, by id.
    const stopped = cli(dir, ["run", "stop", runId, "-m", "going home", "--json"], { env: { STAPLE_AGENT: "vp" } });
    expect(stopped.status).toBe(0);
    const answer = claudeStop(dir, { stop_hook_active: true });
    expect(answer.status).toBe(0);
    expect(answer.answer?.decision).toBeUndefined();
    expect(answer.answer?.systemMessage).toContain("ended: stopped_by_human");
    expect(answer.answer?.systemMessage).toContain("going home");
    expect(bindingFiles()).toEqual([]);
    expect(issue(dir, refs[0]!).checkoutAgent).toBeNull();
    // Unbound now: the next stop is silent.
    expect(claudeStop(dir, {}).answer).toBeNull();
  });

  it("lets the session stop on a wait, taking nothing, and keeps the binding", () => {
    const { dir, epic, refs } = workspace(["one"]);
    const runId = startAndBind(dir, epic);
    ok(dir, ["run", "pause", runId]);
    const answer = claudeStop(dir, {});
    expect(answer.answer?.systemMessage).toContain("waits (paused)");
    expect(issue(dir, refs[0]!).checkoutAgent).toBeNull();
    expect(bindingFiles()).toHaveLength(1);
    ok(dir, ["run", "resume", runId]);
    expect(claudeStop(dir, {}).answer?.decision).toBe("block");
  });

  it("asks for no more continuations in a row than --max-blocks, and claims nothing past it", () => {
    const { dir, epic, refs } = workspace(["one", "two"]);
    startAndBind(dir, epic);
    expect(claudeStop(dir, {}, { args: ["--max-blocks", "1"] }).answer?.decision).toBe("block");
    ok(dir, ["comment", refs[0]!, "review: fine"]);
    ok(dir, ["status", refs[0]!, "in_review"]);
    const guarded = claudeStop(dir, { stop_hook_active: true }, { args: ["--max-blocks", "1"] });
    expect(guarded.answer?.systemMessage).toContain("after 1 continuations in a row");
    expect(issue(dir, refs[1]!).checkoutAgent).toBeNull();
  });
});

describe("claude-stop: --max-blocks caps every kind of block", () => {
  it("an agent that flips its ticket between in_progress and in_review without a review is let go at the cap", () => {
    const { dir, epic, refs } = workspace(["one", "two"]);
    startAndBind(dir, epic);
    const args = ["--max-blocks", "3", "--max-repeats", "50"];
    expect(claudeStop(dir, {}, { args }).answer?.decision).toBe("block");
    const whys: string[] = [];
    let released: Record<string, any> | null = null;
    for (let turn = 0; turn < 8; turn++) {
      // Alternate the reason: unfinished (held, in_progress), then no_review (in_review).
      if (turn % 2 === 0) ok(dir, ["status", refs[0]!, "in_review"]);
      else {
        ok(dir, ["status", refs[0]!, "todo"]);
        ok(dir, ["checkout", refs[0]!]);
      }
      const answer = claudeStop(dir, { stop_hook_active: true }, { args }).answer;
      if (answer?.decision !== "block") {
        released = answer;
        break;
      }
      whys.push(/still checked out/.test(answer.reason) ? "unfinished" : /no review/.test(answer.reason) ? "no_review" : "other");
    }
    // One take and two reminders make three blocks; the fourth is refused.
    expect(whys).toEqual(["no_review", "unfinished"]);
    expect(released?.systemMessage).toContain("after 3 continuations in a row");
    expect(issue(dir, refs[1]!).checkoutAgent).toBeNull();
  });
});

describe("claude-stop: what it never touches, and never fails on", () => {
  it("a session run drive started, a sub-agent, another event, and a run a live driver is attached to", () => {
    const { dir, epic, refs } = workspace(["one"]);
    const runId = startAndBind(dir, epic);
    expect(claudeStop(dir, {}, { env: { STAPLE_RUN_TICKET: refs[0]! } }).answer).toBeNull();
    expect(claudeStop(dir, { agent_id: "agent-1", agent_type: "Explore" }).answer).toBeNull();
    expect(claudeStop(dir, { hook_event_name: "SubagentStop" }).answer).toBeNull();
    const runDir = join(dir, ".staple", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(runDir, "driver.json"), JSON.stringify({ pid: process.pid, host: hostname(), agent: "claude", startedAt: now, heartbeatAt: now, ticket: null, sessionPid: null, logDir: runDir }));
    expect(claudeStop(dir, {}).answer).toBeNull();
    expect(issue(dir, refs[0]!).checkoutAgent).toBeNull();
    // And bind refuses it while that driver is attached.
    const bind = cli(dir, ["run", "hook", "bind", "--session", "sess-2", "--json"]);
    expect(bind.status).toBe(4);
    expect(bind.stderr).toContain("being driven by staple run drive");
  });

  it("exits 0 on a payload that is not JSON, with the failure shown to the person (exit 2 would block)", () => {
    const { dir, epic } = workspace(["one"]);
    startAndBind(dir, epic);
    const result = cli(dir, ["run", "hook", "claude-stop"], { input: "{not json" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain("failed, so the session may stop");
    const badFlag = cli(dir, ["run", "hook", "claude-stop", "--max-blocks", "x"], { input: JSON.stringify(SAMPLE) });
    expect(badFlag.status).toBe(0);
    expect(JSON.parse(badFlag.stdout).systemMessage).toContain("--max-blocks takes a whole number");
  });

  it("reads the session id from CLAUDE_CODE_SESSION_ID when the payload has none", () => {
    const { dir, epic } = workspace(["one"]);
    startAndBind(dir, epic, "from-env");
    const payload = { ...SAMPLE, stop_hook_active: false };
    delete (payload as Record<string, unknown>).session_id;
    const result = cli(dir, ["run", "hook", "claude-stop"], { input: JSON.stringify(payload), env: { CLAUDE_CODE_SESSION_ID: "from-env" } });
    expect(JSON.parse(result.stdout).decision).toBe("block");
  });
});

describe("bind and unbind", () => {
  it("binds the session named by CLAUDE_CODE_SESSION_ID to the actor's live run, and unbinds it", () => {
    const { dir, epic } = workspace(["one"]);
    const run = ok(dir, ["run", "start", "--scope", epic]);
    const bound = ok(dir, ["run", "hook", "bind"], { env: { CLAUDE_CODE_SESSION_ID: "abc/1" } });
    expect(bound).toMatchObject({ provider: "claude", session: "abc/1", runId: run.id, actor: ACTOR });
    expect(bound.db).toMatch(/\.staple\/staple\.db$/);
    expect(bound.file).toBe(join(home, ".staple", "run-sessions", "claude-abc_1.json"));
    expect(ok(dir, ["run", "hook", "unbind"], { env: { CLAUDE_CODE_SESSION_ID: "abc/1" } })).toMatchObject({ unbound: true });
    expect(ok(dir, ["run", "hook", "unbind", "--session", "abc/1"])).toMatchObject({ unbound: false });
  });

  it("refuses an ended run", () => {
    const { dir, epic } = workspace(["one"]);
    const run = ok(dir, ["run", "start", "--scope", epic]);
    ok(dir, ["run", "stop", run.id]);
    const ended = cli(dir, ["run", "hook", "bind", "--run", run.id, "--session", "s", "--json"]);
    expect(ended.status).toBe(4);
    expect(ended.stderr).toContain("only a live run can be bound");
  });
});

describe("pending bindings: a CLI that exports no session id", () => {
  function codexStop(dir: string, cwd: string, session: string): Record<string, any> | null {
    const payload = { ...fixture("codex-stop.json"), session_id: session, cwd, stop_hook_active: false };
    const result = cli(dir, ["run", "hook", "codex-stop"], { input: JSON.stringify(payload) });
    expect(result.status).toBe(0);
    return result.stdout.trim() === "" ? null : (JSON.parse(result.stdout) as Record<string, any>);
  }

  it("is claimed by the first stop in the directory it was made in (or below it), never above it, and once", () => {
    const { dir, epic, refs } = workspace(["one", "two"]);
    ok(dir, ["run", "start", "--scope", epic]);
    const sub = join(dir, "src");
    mkdirSync(sub);
    const pending = ok(dir, ["run", "hook", "bind", "--provider", "codex"]);
    expect(pending).toMatchObject({ pending: true, session: null, provider: "codex" });
    // A session somewhere else, in a parent directory, or at the root does not claim it.
    const elsewhere = tempDir("run-hook-elsewhere");
    cleanup.push(elsewhere);
    expect(codexStop(dir, elsewhere, "other-session")).toBeNull();
    expect(codexStop(dir, dirname(dir), "parent-session")).toBeNull();
    expect(codexStop(dir, "/", "root-session")).toBeNull();
    expect(issue(dir, refs[0]!).checkoutAgent).toBeNull();
    // The session working below where bind ran does.
    expect(codexStop(dir, sub, "codex-1")?.reason).toContain(`next ticket ${refs[0]}`);
    expect(bindingFiles()).toEqual(["codex-codex-1.json"]);
    // Claimed once: a second session in the same directory is not bound.
    expect(codexStop(dir, dir, "codex-2")).toBeNull();
    expect(issue(dir, refs[1]!).checkoutAgent).toBeNull();
  });

  it("one run, one session: a second binding is refused, a pending one is not claimed past a session, unbind --run frees it", () => {
    const { dir, epic, refs } = workspace(["one", "two"]);
    const run = ok(dir, ["run", "start", "--scope", epic]);
    ok(dir, ["run", "hook", "bind", "--session", "first"]);
    // Rebinding the same session is fine.
    ok(dir, ["run", "hook", "bind", "--session", "first"]);
    const second = cli(dir, ["run", "hook", "bind", "--session", "second", "--json"]);
    expect(second.status).toBe(4);
    expect(second.stderr).toContain("already bound to claude session first");
    expect(second.stderr).toContain(`staple run hook unbind --run ${run.id}`);
    const pendingRefused = cli(dir, ["run", "hook", "bind", "--provider", "codex", "--json"]);
    expect(pendingRefused.status).toBe(4);
    expect(ok(dir, ["run", "hook", "unbind", "--run", run.id.slice(0, 8)])).toMatchObject({ runId: run.id, unbound: 1 });
    // Free again: a pending binding, then the first session binds exactly: the pending one
    // is refused its claim, since the run is worked.
    ok(dir, ["run", "hook", "bind", "--provider", "codex"]);
    const exact = cli(dir, ["run", "hook", "bind", "--session", "first", "--json"]);
    expect(exact.status).toBe(4);
    expect(exact.stderr).toContain("a pending codex binding");
    expect(codexStop(dir, dir, "codex-1")?.reason).toContain(`next ticket ${refs[0]}`);
    expect(claudeStop(dir, { session_id: "first" }).answer).toBeNull();
    expect(bindingFiles()).toEqual(["codex-codex-1.json"]);
  });

  it("never claims a pending binding for a run a session already works, even one written in a race", () => {
    const { dir, epic, refs } = workspace(["one"]);
    const run = ok(dir, ["run", "start", "--scope", epic]);
    const pending = ok(dir, ["run", "hook", "bind", "--provider", "codex"]);
    const raced = readFileSync(pending.file, "utf8");
    ok(dir, ["run", "hook", "unbind", "--run", run.id]);
    ok(dir, ["run", "hook", "bind", "--session", "first"]);
    writeFileSync(pending.file, raced);
    expect(codexStop(dir, dir, "codex-1")).toBeNull();
    expect(bindingFiles().filter((name) => !name.includes("pending"))).toEqual(["claude-first.json"]);
    expect(claudeStop(dir, { session_id: "first" }).answer?.reason).toContain(`next ticket ${refs[0]}`);
  });

  it("expires unclaimed, and unbind without a session removes it", () => {
    const { dir, epic, refs } = workspace(["one"]);
    ok(dir, ["run", "start", "--scope", epic]);
    const pending = ok(dir, ["run", "hook", "bind", "--provider", "codex"]);
    writeFileSync(pending.file, JSON.stringify({ ...pending, expiresAt: "2020-01-01T00:00:00.000Z" }));
    expect(codexStop(dir, dir, "late")).toBeNull();
    expect(bindingFiles()).toEqual([]);
    expect(issue(dir, refs[0]!).checkoutAgent).toBeNull();
    ok(dir, ["run", "hook", "bind", "--provider", "codex"]);
    expect(ok(dir, ["run", "hook", "unbind", "--provider", "codex"])).toMatchObject({ unbound: true, session: null });
    expect(bindingFiles()).toEqual([]);
  });
});

/**
 * Every provider row, over its documented sample payload: its session field, its loop
 * signal, its answer format. `session` and `continuing` write the provider's own fields.
 */
const PROVIDERS: Array<{
  name: string;
  fixture: string;
  session: (payload: Record<string, unknown>, id: string) => void;
  continuing: (payload: Record<string, unknown>, on: boolean) => void;
  block: (answer: Record<string, any> | null) => string | undefined;
  allowed: (answer: Record<string, any> | null) => boolean;
  eventPath: string[];
}> = [
  ...["claude", "codex", "droid", "qwen"].map((name) => ({
    name,
    fixture: `${name}-stop.json`,
    session: (payload: Record<string, unknown>, id: string) => void (payload.session_id = id),
    continuing: (payload: Record<string, unknown>, on: boolean) => void (payload.stop_hook_active = on),
    block: (answer: Record<string, any> | null) => (answer?.decision === "block" ? String(answer.reason) : undefined),
    allowed: (answer: Record<string, any> | null) => answer === null || answer.decision === undefined,
    eventPath: name === "droid" ? ["Stop"] : ["hooks", "Stop"],
  })),
  {
    name: "gemini",
    fixture: "gemini-after-agent.json",
    session: (payload, id) => void (payload.session_id = id),
    continuing: (payload, on) => void (payload.stop_hook_active = on),
    block: (answer) => (answer?.decision === "deny" ? String(answer.reason) : undefined),
    allowed: (answer) => answer?.decision === "allow",
    eventPath: ["hooks", "AfterAgent"],
  },
  {
    name: "cursor",
    fixture: "cursor-stop.json",
    session: (payload, id) => void (payload.conversation_id = id),
    continuing: (payload, on) => void (payload.loop_count = on ? 1 : 0),
    block: (answer) => (typeof answer?.followup_message === "string" ? answer.followup_message : undefined),
    allowed: (answer) => answer !== null && answer.followup_message === undefined,
    eventPath: ["hooks", "stop"],
  },
  {
    name: "copilot",
    fixture: "copilot-agent-stop.json",
    session: (payload, id) => void (payload.sessionId = id),
    continuing: (payload, on) => void (payload.stop_hook_active = on),
    block: (answer) => (answer?.decision === "block" ? String(answer.reason) : undefined),
    allowed: (answer) => answer === null || answer.decision === undefined,
    eventPath: ["hooks", "agentStop"],
  },
];

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, "test/fixtures/run-hook", name), "utf8")) as Record<string, unknown>;
}

describe.each(PROVIDERS)("provider $name: its documented payload and answer", (row) => {
  function hook(dir: string, continuing: boolean, args: string[] = [], edit: (payload: Record<string, unknown>) => void = () => {}): Record<string, any> | null {
    const payload = fixture(row.fixture);
    row.session(payload, "p-session");
    row.continuing(payload, continuing);
    edit(payload);
    const result = cli(dir, ["run", "hook", `${row.name}-stop`, ...args], { input: JSON.stringify(payload) });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim() === "" ? null : (JSON.parse(result.stdout) as Record<string, any>);
  }

  it("takes, holds with its loop signal, lets go, and installs under its own event", () => {
    const { dir, epic, refs } = workspace(["one"]);
    const run = ok(dir, ["run", "start", "--scope", epic]);
    ok(dir, ["run", "hook", "bind", "--provider", row.name, "--session", "p-session"]);
    expect(row.block(hook(dir, false))).toContain(`next ticket ${refs[0]}`);
    expect(issue(dir, refs[0]!).checkoutAgent).toBe(ACTOR);
    expect(row.block(hook(dir, true, ["--max-repeats", "1"]))).toContain("is still checked out");
    // The loop signal is read: the same reminder a second time in a row is not given.
    expect(row.allowed(hook(dir, true, ["--max-repeats", "1"]))).toBe(true);
    ok(dir, ["run", "stop", run.id]);
    expect(row.allowed(hook(dir, false))).toBe(true);
    expect(bindingFiles()).toEqual([]);

    const stanza = JSON.parse(cli(dir, ["run", "hook", "install", row.name]).stdout) as Record<string, any>;
    const entries = row.eventPath.reduce<any>((node, key) => node?.[key], stanza) as unknown[];
    expect(JSON.stringify(entries)).toContain(`staple run hook ${row.name}-stop`);
  });
});

describe("provider specifics", () => {
  it("cursor: an aborted or failed loop is never answered with more work", () => {
    const { dir, epic, refs } = workspace(["one"]);
    ok(dir, ["run", "start", "--scope", epic]);
    ok(dir, ["run", "hook", "bind", "--provider", "cursor", "--session", "conv-1"]);
    for (const status of ["aborted", "error"]) {
      const result = cli(dir, ["run", "hook", "cursor-stop"], { input: JSON.stringify({ ...fixture("cursor-stop.json"), conversation_id: "conv-1", status }) });
      expect(JSON.parse(result.stdout)).toEqual({});
    }
    expect(issue(dir, refs[0]!).checkoutAgent).toBeNull();
    const stanza = JSON.parse(cli(dir, ["run", "hook", "install", "cursor"]).stdout);
    expect(stanza).toEqual({ version: 1, hooks: { stop: [{ command: "staple run hook cursor-stop", timeout: 60, loop_limit: null }] } });
  });

  it("gemini and copilot: the stanza each CLI documents; codex and copilot: where each keeps it", () => {
    const dir = tempDir("run-hook-install");
    cleanup.push(dir);
    expect(JSON.parse(cli(dir, ["run", "hook", "install", "gemini"]).stdout)).toEqual({
      hooks: { AfterAgent: [{ matcher: "*", hooks: [{ name: "staple-autopilot", type: "command", command: "staple run hook gemini-stop", timeout: 60_000 }] }] },
    });
    expect(JSON.parse(cli(dir, ["run", "hook", "install", "copilot"]).stdout)).toEqual({
      version: 1,
      hooks: { agentStop: [{ type: "command", bash: "staple run hook copilot-stop", timeoutSec: 60 }] },
    });
    expect(ok(dir, ["run", "hook", "install", "copilot", "--project"]).path).toBe(join(dir, ".github", "hooks", "staple-autopilot.json"));
    expect(ok(dir, ["run", "hook", "install", "codex", "--user"]).path).toBe(join(home, ".codex", "hooks.json"));
    const local = cli(dir, ["run", "hook", "install", "codex", "--local"]);
    expect(local.status).toBe(2);
    expect(local.stderr).toContain("has no local settings file");
  });
});

describe("install", () => {
  it("prints the Claude Code Stop stanza by default and writes nothing", () => {
    const dir = tempDir("run-hook-install");
    cleanup.push(dir);
    const printed = cli(dir, ["run", "hook", "install", "claude"]);
    expect(printed.status).toBe(0);
    expect(JSON.parse(printed.stdout)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "staple run hook claude-stop", timeout: 60 }] }] } });
    expect(existsSync(join(home, ".claude"))).toBe(false);
    const custom = cli(dir, ["run", "hook", "install", "claude", "--staple", "/opt/my staple/bin/staple"]);
    expect(JSON.parse(custom.stdout).hooks.Stop[0].hooks[0].command).toBe("'/opt/my staple/bin/staple' run hook claude-stop");
  });

  it("adds the hook to the user's settings keeping everything else, with a backup, once", () => {
    const dir = tempDir("run-hook-install");
    cleanup.push(dir);
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const existing = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }], PreToolUse: [] } };
    writeFileSync(settings, JSON.stringify(existing));
    const preview = ok(dir, ["run", "hook", "install", "claude", "--user", "--print"]);
    expect(preview.action).toBe("would_install");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(existing);
    const installed = ok(dir, ["run", "hook", "install", "claude", "--user"]);
    expect(installed).toMatchObject({ action: "installed", path: settings });
    expect(JSON.parse(readFileSync(installed.backup, "utf8"))).toEqual(existing);
    const written = JSON.parse(readFileSync(settings, "utf8"));
    expect(written.model).toBe("opus");
    expect(written.hooks.PreToolUse).toEqual([]);
    expect(written.hooks.Stop).toEqual([...existing.hooks.Stop, { hooks: [{ type: "command", command: "staple run hook claude-stop", timeout: 60 }] }]);
    expect(ok(dir, ["run", "hook", "install", "claude", "--user"]).action).toBe("already_installed");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(written);
  });

  it("refuses a hooks member of the wrong shape, and knows its own hook by the exact command", () => {
    const dir = tempDir("run-hook-install");
    cleanup.push(dir);
    const settings = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    for (const wrong of [{ hooks: "none" }, { hooks: { Stop: { hooks: [] } } }, { hooks: [] }]) {
      writeFileSync(settings, JSON.stringify(wrong));
      const refused = cli(dir, ["run", "hook", "install", "claude", "--project", "--json"]);
      expect(refused.status, JSON.stringify(wrong)).toBe(2);
      expect(refused.stderr).toMatch(/not an (object|array); nothing was written/);
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(wrong);
    }
    // Somebody else's hook whose command merely contains ours is not ours.
    const lookalike = { hooks: { Stop: [{ hooks: [{ type: "command", command: "staple run hook claude-stop-old" }] }] } };
    writeFileSync(settings, JSON.stringify(lookalike));
    expect(ok(dir, ["run", "hook", "install", "claude", "--project"]).action).toBe("installed");
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks.Stop).toHaveLength(2);
    // Ours, installed with another staple path, is.
    const ours = { hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/staple run hook claude-stop", timeout: 60 }] }] } };
    writeFileSync(settings, JSON.stringify(ours));
    expect(ok(dir, ["run", "hook", "install", "claude", "--project"]).action).toBe("already_installed");
  });

  it("writes a project's settings file, honours CLAUDE_CONFIG_DIR, and refuses a file that is not JSON", () => {
    const dir = tempDir("run-hook-install");
    cleanup.push(dir);
    expect(ok(dir, ["run", "hook", "install", "claude", "--project"]).path).toBe(join(dir, ".claude", "settings.json"));
    expect(ok(dir, ["run", "hook", "install", "claude", "--local"]).path).toBe(join(dir, ".claude", "settings.local.json"));
    const config = join(home, "elsewhere");
    expect(ok(dir, ["run", "hook", "install", "claude", "--user"], { env: { CLAUDE_CONFIG_DIR: config } }).path).toBe(join(config, "settings.json"));
    writeFileSync(join(dir, ".claude", "settings.json"), "{ broken");
    const refused = cli(dir, ["run", "hook", "install", "claude", "--project", "--json"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("is not valid JSON");
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe("{ broken");
    expect(cli(dir, ["run", "hook", "install", "claude", "--user", "--project"]).status).toBe(2);
  });
});

describe("end to end: a scripted session works a whole scope through the hook", () => {
  it("does what each block says until the hook lets it stop, and the run completes", () => {
    const { dir, epic, refs } = workspace(["one", "two", "three"]);
    const runId = startAndBind(dir, epic, "e2e-session");
    const worked: string[] = [];
    let continuing = false;
    let last: Record<string, any> | null = null;
    // The fake session: a turn ends, the hook answers; a block is the next prompt.
    for (let turn = 0; turn < 12; turn++) {
      last = claudeStop(dir, { session_id: "e2e-session", stop_hook_active: continuing }).answer;
      if (last?.decision !== "block") break;
      const ref = /next ticket (\S+) /.exec(String(last.reason))?.[1];
      expect(ref, String(last.reason)).toBeDefined();
      worked.push(ref!);
      ok(dir, ["comment", ref!, "review: reproduced it; nothing found"]);
      ok(dir, ["done", ref!, "-m", "evidence: it works"]);
      continuing = true;
    }
    expect(worked).toEqual(refs);
    expect(last?.systemMessage).toContain("ended: scope_empty");
    expect(runOf(dir, runId)).toMatchObject({ state: "completed", counts: { taken: 3, done: 3, failed: 0 } });
    expect(bindingFiles()).toEqual([]);
  });
});
