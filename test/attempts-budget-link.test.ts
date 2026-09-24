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
import { STATUSLINE_SESSION_ID, statusline } from "./fixtures/budget-support.js";
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
