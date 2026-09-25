/**
 * The attempt write surfaces, driven as an agent drives them: `staple attempt …` and the
 * attempt flags on `checkout`, `status`, `done` and `release` as real child processes, and
 * MCP `record_attempt_event` over a real MCP connection, against one scratch staple home
 * (`docs/execution-telemetry.md`, "Surfaces").
 *
 *   - Every write returns its payload unchanged, plus `attempt`.
 *   - CLI `--json` and MCP answer the same shape, because both call `recordAttemptEvent`.
 *   - The refusals keep the existing envelope and exit codes (validation 2, conflict 4).
 */
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";
import { normalize, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

let home: string;
let mcp: McpHarness;
const WS = "surfaces";

function cli(...args: string[]): { status: number; json: Record<string, unknown>; stderr: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args, "--ws", WS, "--json"], {
    cwd: REPO_ROOT,
    env: bareEnv({ STAPLE_HOME: home, HOME: home, STAPLE_AGENT: "agent-cli" }),
    encoding: "utf8",
    timeout: 30_000,
  });
  const text = result.stdout.trim();
  return { status: result.status ?? -1, json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, stderr: result.stderr };
}

const attemptOf = (payload: Record<string, unknown>): Record<string, unknown> => payload.attempt as Record<string, unknown>;

beforeAll(async () => {
  home = tempDir("attempt-surfaces");
  const init = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "init", "--global", WS], {
    cwd: REPO_ROOT,
    env: bareEnv({ STAPLE_HOME: home, HOME: home }),
    encoding: "utf8",
  });
  expect(init.status).toBe(0);
  mcp = await startMcpClient({ home, cwd: home, agent: "agent-mcp" });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  removeDir(home);
});

describe("staple attempt and the attempt flags", () => {
  it("open, pause, resume, checkpoint, interrupt, resume by re-claim, fail, and complete an attempt", () => {
    const issue = cli("new", "Surface work", "--estimate", "1h").json;
    const ref = String(issue.identifier);

    const claimed = cli("checkout", ref, "--harness", "claude_code", "--harness-session", "s-1", "--model", "claude-x", "--attempt-key", "k-1");
    expect(claimed.status).toBe(0);
    expect(claimed.json).toMatchObject({ identifier: ref, checkoutAgent: "agent-cli" });
    expect(attemptOf(claimed.json)).toMatchObject({
      agent: "agent-cli",
      state: "running",
      openedBy: "checkout",
      idempotencyKey: "k-1",
      harness: { name: "claude_code", model: "claude-x", sessionRef: expect.stringMatching(/^[0-9a-f]{16}$/) },
      estimateAtStart: { estimatedSeconds: 3600, source: "own" },
      pausedSeconds: 0,
    });
    const first = String(attemptOf(claimed.json).id);

    expect(cli("attempt", "pause", ref, "--reason", "awaiting_reset").json).toMatchObject({ id: first, state: "paused" });
    expect(cli("attempt", "resume", ref).json).toMatchObject({ id: first, state: "running" });
    expect(cli("attempt", "milestone", ref, "-m", "half done").json).toMatchObject({ id: first, state: "running" });
    expect(cli("attempt", "interrupt", ref, "--reason", "provider_limit").json).toMatchObject({
      id: first,
      state: "ended",
      outcome: "interrupted",
      endReason: "provider_limit",
      endDetection: "reported",
    });

    // The claim is still held with no open attempt; the re-claim resumes the interrupted one.
    const again = cli("checkout", ref);
    expect(attemptOf(again.json)).toMatchObject({ openedBy: "reclaim", resumesAttemptId: first, ordinal: 2 });

    const failed = cli("release", ref, "--outcome", "failed", "--reason", "cannot reproduce");
    expect(failed.json).toMatchObject({ identifier: ref, status: "todo" });
    expect(attemptOf(failed.json)).toMatchObject({ outcome: "failed", endReason: "cannot reproduce", endDetection: "reported" });

    // A status write into active opens one with no claim; done completes it.
    const started = cli("status", ref, "in_progress");
    expect(attemptOf(started.json)).toMatchObject({ openedBy: "status", claim: { scope: "none" }, agent: "agent-cli" });
    const done = cli("done", ref);
    expect(done.json).toMatchObject({ status: "done" });
    expect(attemptOf(done.json)).toMatchObject({ outcome: "completed", endReason: "done" });
  }, 120_000);

  it("refuses with the existing envelope and exit codes", () => {
    const ref = String(cli("new", "Refusals").json.identifier);
    const none = cli("attempt", "pause", ref, "--reason", "operator");
    expect(none.status).toBe(4);
    expect(JSON.parse(none.stderr.trim())).toMatchObject({ code: "conflict" });
    cli("checkout", ref);
    const inferred = cli("attempt", "interrupt", ref, "--reason", "claim_stolen");
    expect(inferred.status).toBe(2);
    expect(JSON.parse(inferred.stderr.trim())).toMatchObject({ code: "validation" });
    const noSession = cli("release", ref, "--outcome", "failed");
    expect(noSession.status).toBe(2);
  }, 60_000);

  it("reconstructs history from events, once", () => {
    const first = cli("attempt", "reconstruct");
    expect(first.status).toBe(0);
    expect(first.json).toMatchObject({ reconstructed: expect.any(Number), alreadyPresent: expect.any(Number) });
    expect(cli("attempt", "reconstruct").json).toMatchObject({ reconstructed: 0 });
  }, 60_000);
});

describe("history before capture, at the boundary", () => {
  /**
   * An older build's claim: the checkout the CLI makes, with the attempt rows it wrote taken
   * away again — the events stay, as an older build left them.
   */
  function claimedByAnOlderBuild(title: string, agent: string): string {
    const ref = String(cli("new", title).json.identifier);
    expect(cli("checkout", ref, "--agent", agent).status).toBe(0);
    const db = new DatabaseSync(join(home, "workspaces", `${WS}.db`));
    try {
      const id = (db.prepare("SELECT id FROM issues WHERE identifier = ?").get(ref) as { id: string }).id;
      db.prepare("DELETE FROM attempt_transitions WHERE attempt_id IN (SELECT id FROM attempts WHERE issue_id = ?)").run(id);
      db.prepare("DELETE FROM attempts WHERE issue_id = ?").run(id);
      // And the events of the claim that predate the upgrade, a minute before it.
      db.prepare("UPDATE events SET created_at = ? WHERE issue_id = ?").run(new Date(Date.now() - 60_000).toISOString(), id);
      db.prepare("UPDATE issues SET checkout_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), id);
    } finally {
      db.close();
    }
    return ref;
  }

  const rows = (ref: string): Array<Record<string, unknown>> => {
    const db = new DatabaseSync(join(home, "workspaces", `${WS}.db`), { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT a.agent, a.provenance, a.opened_by, a.state, a.outcome, a.end_reason, a.end_detection, a.resumes_attempt_id
             FROM attempts a JOIN issues i ON i.id = a.issue_id WHERE i.identifier = ? ORDER BY a.started_at, a.id`,
        )
        .all(ref) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  };

  it("a steal after the upgrade: the older build's tenure was interrupted, and a later command writes nothing over it", () => {
    const ref = claimedByAnOlderBuild("Stolen after the upgrade", "agent-old");
    expect(cli("checkout", ref, "--agent", "agent-new", "--steal-if-stale", "0s").status).toBe(0);
    expect(cli("attempt", "reconstruct").json).toMatchObject({ reconstructed: 1 });
    expect(cli("comment", ref, "a command after").status).toBe(0);
    // Dated at the holder's last activity, as the steal's own event recorded it — not at the steal.
    const db = new DatabaseSync(join(home, "workspaces", `${WS}.db`), { readOnly: true });
    try {
      const stolen = JSON.parse((db.prepare("SELECT e.payload FROM events e JOIN issues i ON i.id = e.issue_id WHERE i.identifier = ? AND e.kind = 'claim_stolen'").get(ref) as { payload: string }).payload);
      const ended = db
        .prepare("SELECT a.ended_at, a.ended_at_source FROM attempts a JOIN issues i ON i.id = a.issue_id WHERE i.identifier = ? AND a.provenance = 'reconstructed'")
        .get(ref);
      expect(ended).toEqual({ ended_at: stolen.previousLastActivityAt, ended_at_source: "last_activity" });
    } finally {
      db.close();
    }
    expect(rows(ref)).toEqual([
      { agent: "agent-old", provenance: "reconstructed", opened_by: "reconstructed", state: "ended", outcome: "interrupted", end_reason: "claim_stolen", end_detection: "reconstructed", resumes_attempt_id: null },
      { agent: "agent-new", provenance: "recorded", opened_by: "steal", state: "running", outcome: null, end_reason: null, end_detection: null, resumes_attempt_id: null },
    ]);
  }, 60_000);

  it("the holder re-claiming after the upgrade: the tenure continued, and no interruption is ever written", () => {
    const ref = claimedByAnOlderBuild("Re-claimed after the upgrade", "agent-old");
    expect(cli("checkout", ref, "--agent", "agent-old").status).toBe(0);
    expect(cli("attempt", "reconstruct").json).toMatchObject({ reconstructed: 1 });
    expect(cli("comment", ref, "a command after").status).toBe(0);
    expect(rows(ref)).toEqual([
      { agent: "agent-old", provenance: "reconstructed", opened_by: "reconstructed", state: "ended", outcome: "yielded", end_reason: "capture_began", end_detection: "reconstructed", resumes_attempt_id: null },
      { agent: "agent-old", provenance: "recorded", opened_by: "reclaim", state: "running", outcome: null, end_reason: null, end_detection: null, resumes_attempt_id: null },
    ]);
  }, 60_000);
});

describe("MCP record_attempt_event", () => {
  it("answers the same shape as the CLI, from the same store method", async () => {
    const viaCli = String(cli("new", "CLI milestone").json.identifier);
    const viaMcp = String(cli("new", "MCP milestone").json.identifier);
    cli("checkout", viaCli, "--agent", "agent-mcp");
    cli("checkout", viaMcp, "--agent", "agent-mcp");

    const fromCli = cli("attempt", "milestone", viaCli, "-m", "checkpoint", "--agent", "agent-mcp").json;
    const fromMcp = toolPayload(await mcp.call("record_attempt_event", { ref: viaMcp, event: "milestone", label: "checkpoint", ws: WS })) as Record<string, unknown>;
    const shape = (payload: Record<string, unknown>) => normalize({ ...payload, identifier: "<ref>" });
    expect(shape(fromMcp)).toEqual(shape(fromCli));
    expect(fromMcp).toMatchObject({ agent: "agent-mcp", state: "running" });

    // The attempt fields on checkout_task and release_task reach the same store method.
    const third = String(cli("new", "MCP claim").json.identifier);
    const claimed = toolPayload(await mcp.call("checkout_task", { ref: third, harness: "codex", model: "gpt-x", ws: WS })) as Record<string, unknown>;
    expect(attemptOf(claimed)).toMatchObject({ agent: "agent-mcp", harness: { name: "codex", model: "gpt-x" } });
    const released = toolPayload(await mcp.call("release_task", { ref: third, outcome: "failed", reason: "blocked upstream", ws: WS })) as Record<string, unknown>;
    expect(attemptOf(released)).toMatchObject({ outcome: "failed", endReason: "blocked upstream" });
    const refused = await mcp.call("record_attempt_event", { ref: third, event: "interrupt", reason: "released_stale", ws: WS });
    expect(refused.isError).toBe(true);
  }, 120_000);
});

describe("the orchestrator lane on the CLI and MCP", () => {
  it("opens and ends by attempt open|end --role orchestrator, and every claim write refuses a role", async () => {
    const epic = String(cli("new", "Coordinated epic").json.identifier);
    const opened = cli("attempt", "open", epic, "--role", "orchestrator", "--agent", "orch-cli", "--harness", "claude_code", "--harness-session", "o-1");
    expect(opened.status).toBe(0);
    expect(opened.json).toMatchObject({ role: "orchestrator", openedBy: "orchestrate", agent: "orch-cli", state: "running", claim: { scope: "none" } });
    // No claim, no status change.
    const shown = cli("show", epic).json;
    expect(shown.issue).toMatchObject({ status: "backlog", checkoutAgent: null });
    expect(shown.orchestration).toMatchObject({ count: 1, current: { id: opened.json.id } });
    expect((shown.attempts as Record<string, unknown>).count).toBe(0);
    const ended = cli("attempt", "end", epic, "--role", "orchestrator", "--agent", "orch-cli");
    expect(ended.json).toMatchObject({ id: opened.json.id, state: "ended", outcome: "yielded", endReason: "coordination_ended", endDetection: "reported" });

    // Any other role, or none, is refused; so is a role on a claim write.
    expect(cli("attempt", "open", epic, "--agent", "orch-cli").status).toBe(2);
    expect(cli("attempt", "open", epic, "--role", "worker", "--agent", "orch-cli").status).toBe(2);
    const leaf = String(cli("new", "Leaf").json.identifier);
    expect(cli("checkout", leaf, "--role", "orchestrator").status).toBe(2);
    expect(cli("status", leaf, "in_progress", "--role", "orchestrator").status).toBe(2);

    // MCP: the same verbs through record_attempt_event, and the claim tools refuse a role by name.
    const viaMcp = toolPayload(await mcp.call("record_attempt_event", { ref: epic, event: "open", role: "orchestrator", ws: WS })) as Record<string, unknown>;
    expect(viaMcp).toMatchObject({ role: "orchestrator", agent: "agent-mcp", openedBy: "orchestrate" });
    const task = toolPayload(await mcp.call("get_task", { ref: epic, ws: WS })) as Record<string, unknown>;
    expect(task.orchestration).toMatchObject({ count: 2, current: { id: viaMcp.id } });
    expect((await mcp.call("checkout_task", { ref: leaf, role: "orchestrator", ws: WS })).isError).toBe(true);
    const endedViaMcp = toolPayload(await mcp.call("record_attempt_event", { ref: epic, event: "end", role: "orchestrator", ws: WS })) as Record<string, unknown>;
    expect(endedViaMcp).toMatchObject({ id: viaMcp.id, endReason: "coordination_ended" });
  }, 120_000);
});

describe("HTTP /api/action", () => {
  let ui: UiHandle | null = null;
  afterAll(() => ui?.close());

  it("status, checkout and release return `attempt` beside the issue, as the CLI does", async () => {
    const previous = process.env.STAPLE_HOME;
    process.env.STAPLE_HOME = home;
    try {
      ui = startUiServer({ port: 0, hub: false, ws: WS });
      await once(ui.server, "listening");
      const origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
      const post = async (body: Record<string, unknown>) =>
        (await (
          await fetch(`${origin}/api/action`, {
            method: "POST",
            headers: { "x-staple-token": ui!.token, "content-type": "application/json" },
            body: JSON.stringify({ ws: WS, actor: "agent-http", ...body }),
          })
        ).json()) as Record<string, unknown>;
      const viaHttp = String(cli("new", "HTTP work").json.identifier);
      const viaCli = String(cli("new", "CLI work").json.identifier);

      const claimed = await post({ type: "checkout", ref: viaHttp });
      const fromCli = cli("checkout", viaCli, "--agent", "agent-http").json;
      const shape = (payload: Record<string, unknown>) => normalize({ ...payload, identifier: "<ref>", title: "<title>", attempt: { ...attemptOf(payload), identifier: "<ref>" } });
      expect(shape(claimed)).toEqual(shape(fromCli));
      expect(attemptOf(claimed)).toMatchObject({ agent: "agent-http", openedBy: "checkout", state: "running" });

      const released = await post({ type: "release", ref: viaHttp });
      expect(attemptOf(released)).toMatchObject({ outcome: "yielded", endReason: "released", endDetection: "reported" });
      const started = await post({ type: "status", ref: viaHttp, status: "in_progress" });
      expect(attemptOf(started)).toMatchObject({ openedBy: "status", claim: { scope: "none" } });
      const done = await post({ type: "status", ref: viaHttp, status: "done" });
      expect(attemptOf(done)).toMatchObject({ outcome: "completed", endReason: "done" });
    } finally {
      if (previous === undefined) delete process.env.STAPLE_HOME;
      else process.env.STAPLE_HOME = previous;
    }
  }, 120_000);
});

describe("resumeGapSeconds on every read surface", () => {
  let ui: UiHandle | null = null;
  afterAll(() => ui?.close());

  it("show, get_task and /api/issue carry timing.resumeGaps; attempt <id> and get_attempt carry chain[].resumeGapSeconds", async () => {
    const ref = String(cli("new", "Interrupted and resumed").json.identifier);
    const first = String(attemptOf(cli("checkout", ref).json).id);
    cli("attempt", "interrupt", ref, "--reason", "provider_limit");
    const second = String(attemptOf(cli("checkout", ref).json).id);
    const link = { attemptId: first, resumedByAttemptId: second, resumeGapSeconds: expect.any(Number), clockSkew: false };

    const shown = cli("show", ref).json;
    expect((shown.timing as Record<string, unknown>).resumeGaps).toEqual([expect.objectContaining(link)]);
    const task = toolPayload(await mcp.call("get_task", { ref, ws: WS })) as Record<string, unknown>;
    expect((task.timing as Record<string, unknown>).resumeGaps).toEqual([expect.objectContaining(link)]);

    const detail = cli("attempt", first).json;
    const viaMcp = toolPayload(await mcp.call("get_attempt", { attempt_id: first, ws: WS })) as Record<string, unknown>;
    for (const payload of [detail, viaMcp]) {
      const chain = payload.chain as Array<Record<string, unknown>>;
      expect(chain.map((entry) => entry.id)).toEqual([first, second]);
      expect(chain[0]!.resumeGapSeconds).toEqual(expect.any(Number));
      // Nothing has resumed the second attempt yet.
      expect(chain[1]!.resumeGapSeconds).toBeNull();
    }

    const previous = process.env.STAPLE_HOME;
    process.env.STAPLE_HOME = home;
    try {
      ui = startUiServer({ port: 0, hub: false, ws: WS });
      await once(ui.server, "listening");
      const origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
      const body = (await (await fetch(`${origin}/api/issue?ref=${ref}&ws=${WS}`, { headers: { "x-staple-token": ui.token } })).json()) as Record<string, unknown>;
      expect((body.timing as Record<string, unknown>).resumeGaps).toEqual([expect.objectContaining(link)]);
    } finally {
      if (previous === undefined) delete process.env.STAPLE_HOME;
      else process.env.STAPLE_HOME = previous;
    }
  }, 120_000);
});
