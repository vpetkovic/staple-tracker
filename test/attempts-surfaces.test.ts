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
