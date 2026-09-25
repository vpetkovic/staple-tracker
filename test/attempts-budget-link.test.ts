/**
 * A budget reading names the attempt it belongs to (`docs/execution-telemetry.md`, "Linking
 * samples to attempts"): exactly one effectively open attempt on this machine with the
 * reading's provider, account and harness session. Real workspaces registered in a scratch
 * home's hub, real ingestion of a real-shaped status line, the linker the CLI and MCP pass.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceStore } from "../src/core/store.js";
import { attemptLinkerFor } from "../src/core/telemetry/attempt-link.js";
import { attemptsOfIssue } from "../src/core/telemetry/attempt-records.js";
import { bindBudgetSource, setBudgetCapture } from "../src/core/telemetry/budget-config.js";
import { ingestBudget } from "../src/core/telemetry/ingest.js";
import { initWorkspace } from "../src/core/workspace.js";
import { STATUSLINE_SESSION_ID, after, epoch, sessionMetaLine, statusline, tokenCountLine, writeRollout } from "./fixtures/budget-support.js";
import { spawnSync } from "node:child_process";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv } from "./fixtures/characterize-support.js";
import { startMcpClient, toolPayload } from "./fixtures/contract-support.js";

let home: string;
let root: string;
let claudeDir: string;
const opened: WorkspaceStore[] = [];
const previous = { home: process.env.STAPLE_HOME, claude: process.env.CLAUDE_CONFIG_DIR };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-link-home-"));
  root = mkdtempSync(join(tmpdir(), "staple-link-root-"));
  claudeDir = join(home, "claude");
  mkdirSync(claudeDir);
  process.env.STAPLE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "claude_code_statusline", account: "personal-max", configDir: claudeDir });
});
afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.db.close();
    } catch {
      // closed by the test
    }
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [["STAPLE_HOME", previous.home], ["CLAUDE_CONFIG_DIR", previous.claude]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function workspace(slug: string): WorkspaceStore {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const { store } = initWorkspace({ dir, slug });
  opened.push(store);
  return store;
}

let used = 10;
/** Ingest one fresh reading from `session`, and return what the stored sample says about its attempt. */
function ingest(session: string = STATUSLINE_SESSION_ID): { attemptId: string | null; missing: Record<string, string> } {
  used += 1;
  const input = statusline({ session_id: session, rate_limits: { five_hour: { used_percentage: used, resets_at: 1790269200 } } });
  ingestBudget({ source: "claude-statusline", input, configDir: claudeDir }, { home, attemptLinker: attemptLinkerFor(home) });
  const hub = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
  try {
    const row = hub.prepare("SELECT attempt_id, missing FROM budget_samples ORDER BY recorded_at DESC, rowid DESC LIMIT 1").get() as {
      attempt_id: string | null;
      missing: string;
    };
    return { attemptId: row.attempt_id, missing: JSON.parse(row.missing) as Record<string, string> };
  } finally {
    hub.close();
  }
}

const claimFromSession = { harness: "claude_code", harnessSession: STATUSLINE_SESSION_ID } as const;

describe("a reading names its attempt", () => {
  it("when exactly one open attempt on this machine matches its account and session", () => {
    const store = workspace("alpha");
    const issue = store.createIssue({ title: "Linked" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: claimFromSession });
    const attempt = attemptsOfIssue(store.db, issue.id)[0]!;
    expect(attempt.providerBinding).toMatchObject({ provider: "anthropic", accountRef: "personal-max" });
    expect(ingest()).toEqual({ attemptId: attempt.id, missing: {} });
    // Another session on the same account belongs to no attempt here.
    expect(ingest("another-session")).toMatchObject({ attemptId: null, missing: { attemptId: "no_matching_attempt" } });
  });

  it("from a session an attempt gained later, too", () => {
    const store = workspace("alpha");
    const issue = store.createIssue({ title: "Second session" });
    store.checkoutIssue(issue.id, "claude", undefined, { attempt: { harness: "claude_code", harnessSession: "first-session" } });
    store.checkoutIssue(issue.id, "claude", undefined, { attempt: claimFromSession });
    expect(ingest().attemptId).toBe(attemptsOfIssue(store.db, issue.id)[0]!.id);
    expect(ingest("first-session").attemptId).toBe(attemptsOfIssue(store.db, issue.id)[0]!.id);
  });

  it("goes to the worker attempt when one session holds one in each lane, and to the orchestrator attempt once the worker's ends", () => {
    const store = workspace("alpha");
    const epic = store.createIssue({ title: "Coordinated" });
    const leaf = store.createIssue({ title: "Worked", parent: epic.id });
    store.createIssue({ title: "Keeps the epic open", parent: epic.id });
    const orchestrator = store.openOrchestratorAttempt(epic.id, "dual", "orchestrator", claimFromSession);
    expect(orchestrator.providerBinding).toMatchObject({ accountRef: "personal-max" });
    store.checkoutIssue(leaf.id, "dual", undefined, { attempt: claimFromSession });
    const worker = attemptsOfIssue(store.db, leaf.id)[0]!;
    expect(ingest()).toEqual({ attemptId: worker.id, missing: {} });
    store.releaseIssue(leaf.id, "dual");
    expect(ingest()).toEqual({ attemptId: orchestrator.id, missing: {} });
  });

  it("is ambiguous when two open attempts, in any of this machine's workspaces, match", () => {
    const one = workspace("alpha");
    const two = workspace("bravo");
    one.checkoutIssue(one.createIssue({ title: "One" }).id, "agent-a", undefined, { attempt: claimFromSession });
    two.checkoutIssue(two.createIssue({ title: "Two" }).id, "agent-a", undefined, { attempt: claimFromSession });
    expect(ingest()).toMatchObject({ attemptId: null, missing: { attemptId: "ambiguous_attempt" } });
  });

  it("names none once the attempt ended, and none the index still holds open but the workspace reads as orphaned", () => {
    const store = workspace("alpha");
    store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const ended = store.createIssue({ title: "Ended" });
    store.checkoutIssue(ended.id, "agent-a", undefined, { attempt: claimFromSession });
    store.releaseIssue(ended.id, "agent-a");
    expect(ingest()).toMatchObject({ attemptId: null, missing: { attemptId: "no_matching_attempt" } });

    const orphan = store.createIssue({ title: "Orphaned" });
    store.checkoutIssue(orphan.id, "agent-a", undefined, { attempt: claimFromSession });
    store.updateIssue(orphan.id, { status: "doing" }, "agent-a");
    // Recategorized by hand: no command ran since, so the index and the row still say running.
    store.db.prepare("UPDATE workspace_statuses SET category = 'review' WHERE id = 'doing'").run();
    expect(attemptsOfIssue(store.db, orphan.id)[0]!.state).toBe("running");
    expect(ingest()).toMatchObject({ attemptId: null, missing: { attemptId: "no_matching_attempt" } });
  });

  it("never matches an attempt on another account", () => {
    const store = workspace("alpha");
    const issue = store.createIssue({ title: "Other account" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: { ...claimFromSession, account: "work-team" } });
    expect(ingest()).toMatchObject({ attemptId: null, missing: { attemptId: "no_matching_attempt" } });
  });
});

describe("the surfaces pass the linker", () => {
  it("staple budget ingest and MCP record_budget_sample both name the attempt", async () => {
    const store = workspace("alpha");
    const issue = store.createIssue({ title: "Through the surfaces" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: claimFromSession });
    const attemptId = attemptsOfIssue(store.db, issue.id)[0]!.id;
    const env = bareEnv({ STAPLE_HOME: home, HOME: home, CLAUDE_CONFIG_DIR: claudeDir });
    const viaCli = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "budget", "ingest", "--source", "claude-statusline", "--json"], {
      cwd: REPO_ROOT,
      env,
      input: statusline({ rate_limits: { five_hour: { used_percentage: 61, resets_at: 1790269200 } } }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(viaCli.status, viaCli.stderr).toBe(0);
    expect(JSON.stringify(JSON.parse(viaCli.stdout))).toContain(attemptId);

    const mcp = await startMcpClient({ home, cwd: home, agent: "agent-mcp", env: { CLAUDE_CONFIG_DIR: claudeDir } });
    try {
      const result = toolPayload(
        await mcp.call("record_budget_sample", {
          source: "claude-statusline",
          input: statusline({ rate_limits: { five_hour: { used_percentage: 62, resets_at: 1790269200 } } }),
          config_dir: claudeDir,
        }),
      );
      expect(JSON.stringify(result)).toContain(attemptId);
    } finally {
      await mcp.close();
    }
  }, 120_000);
});

describe("a backfill", () => {
  it("links only the readings observed while the attempt ran, never ones from before it started", () => {
    const codexHome = join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    bindBudgetSource(home, { source: "codex_rollout", account: "codex-plus", codexHome });
    const session = "66666666-0000-7000-8000-000000000001";
    const store = workspace("alpha");
    const issue = store.createIssue({ title: "Backfilled" });
    // Checked out from a Codex process, which runs with its home in CODEX_HOME.
    const previousCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: { harness: "codex", harnessSession: session } });
    } finally {
      if (previousCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodex;
    }
    const attempt = attemptsOfIssue(store.db, issue.id)[0]!;
    expect(attempt.providerBinding).toMatchObject({ provider: "openai", accountRef: "codex-plus", source: "machine_binding" });
    // One reading an hour before the attempt started, one after it.
    const before = new Date(Date.parse(attempt.startedAt) - 3_600_000).toISOString();
    const during = after(attempt.startedAt, 1_000);
    const resets = epoch(after(attempt.startedAt, 3 * 3_600_000));
    const limit = (used: number) => ({ used_percent: used, window_minutes: 300, resets_at: resets });
    const file = writeRollout(codexHome, session, before, [
      sessionMetaLine({ id: session, timestamp: before }),
      tokenCountLine({ timestamp: after(before, 5_000), primary: limit(10), secondary: null }),
      tokenCountLine({ timestamp: during, primary: limit(20), secondary: null }),
    ]);
    ingestBudget({ source: "codex-rollout", file }, { home, attemptLinker: attemptLinkerFor(home) });
    const hub = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
    try {
      const rows = hub.prepare("SELECT used_percent, attempt_id, missing FROM budget_samples ORDER BY observed_at").all() as Array<{
        used_percent: number;
        attempt_id: string | null;
        missing: string;
      }>;
      expect(rows.map((row) => [row.used_percent, row.attempt_id, JSON.parse(row.missing).attemptId ?? null])).toEqual([
        [10, null, "no_matching_attempt"],
        [20, attempt.id, null],
      ]);
    } finally {
      hub.close();
    }
  });
});

describe("one linker, one ingestion call", () => {
  it("reads the index and each workspace once for the call, and a new call reads them again", () => {
    const store = workspace("alpha");
    const issue = store.createIssue({ title: "Cached" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: claimFromSession });
    const attemptId = attemptsOfIssue(store.db, issue.id)[0]!.id;
    const reading = { provider: "anthropic", accountRef: "personal-max", sessionRef: attemptsOfIssue(store.db, issue.id)[0]!.harness!.sessionRef };
    const call = attemptLinkerFor(home);
    expect(call(reading)).toEqual({ attemptId });
    store.releaseIssue(issue.id, "agent-a");
    // The same call keeps what it read; the next call sees the release.
    expect(call(reading)).toEqual({ attemptId });
    expect(attemptLinkerFor(home)(reading)).toEqual({ reason: "no_matching_attempt" });
  });
});
