/**
 * C1 — stale-claim semantics across MCP, CLI, and HTTP.
 *
 * store-stale-claim.test.ts owns the semantics. This suite owns the CONTRACT:
 * that all three surfaces accept the same explicit takeover, refuse a live
 * holder with the same sentence, and report the same liveness numbers. The three
 * surfaces reach the store by three different paths and format their own
 * envelopes, so a regression in one is invisible to a single-surface test.
 *
 * The design principle under test is negative as much as positive: nothing here
 * takes a claim without being asked to. Every takeover names a threshold the
 * caller chose.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// This file spawns real CLI processes and drives a real UI server. Under full-suite
// load (40+ files doing the same) the box saturates: subprocesses run 5-10x slower
// and the kernel can refuse a connection the server would otherwise accept. Longer
// budgets + one connection retry keep this suite honest without masking real bugs —
// an assertion failure still fails identically.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { openDb } from "../src/core/db.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import {
  cliEnvelope,
  mcpEnvelope,
  runCli,
  startMcpClient,
  toolPayload,
  type McpHarness,
} from "./fixtures/contract-support.js";

const WS = "stale";
const HOLDER = "dead-agent";
const RESCUER = "rescue-agent";

let home: string;
let emptyDir: string;
let dbPath: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]) {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: RESCUER });
}

/** Create a fresh task and park it under HOLDER's claim. Returns the identifier. */
function newHeldTask(title: string): string {
  expect(cli("new", title, "--ws", WS).status).toBe(0);
  const created = JSON.parse(cli("ls", "--ws", WS, "--json").stdout) as Array<{
    identifier: string;
    title: string;
  }>;
  const ref = created.find((i) => i.title === title)!.identifier;
  expect(cli("start", ref, "--agent", HOLDER, "--ws", WS).status).toBe(0);
  return ref;
}

/**
 * Age a claim by rewriting its checkout AND the events its holder left, straight
 * in SQL. Production has no clock injection and must not grow any: staleness that
 * tests can fake but a real usage-limit death cannot would be worthless.
 */
function backdate(ref: string, secondsAgo: number): string {
  const at = new Date(Date.now() - secondsAgo * 1000).toISOString();
  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT id FROM issues WHERE identifier = ?").get(ref) as { id: string };
    db.prepare("UPDATE issues SET checkout_at = ? WHERE id = ?").run(at, row.id);
    db.prepare("UPDATE events SET created_at = ? WHERE issue_id = ?").run(at, row.id);
  } finally {
    db.close();
  }
  return at;
}

async function httpJson(input: string, init?: RequestInit) {
  const attempt = () =>
    fetch(`${origin}${input}`, {
      ...init,
      headers: { "x-staple-token": token, ...(init?.headers as Record<string, string> | undefined) },
    });
  let response: Response;
  try {
    response = await attempt();
  } catch {
    // Connection-level failure (load-induced refusal), not an HTTP answer — one retry.
    await new Promise((r) => setTimeout(r, 250));
    response = await attempt();
  }
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function action(body: Record<string, unknown>) {
  return httpJson("/api/action", { method: "POST", body: JSON.stringify(body) });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-stale-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-stale-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  dbPath = join(home, "workspaces", `${WS}.db`);

  expect(cli("init", "--global", WS).status).toBe(0);

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: RESCUER });
  ui = startUiServer({ port: 0, hub: false, ws: WS });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ refusals

/**
 * ONE golden sentence per verb, asserted on all three surfaces. If a surface
 * ever reformats a refusal, this is where it shows up.
 */
const CHECKOUT_REFUSAL = `Checkout refused: held by ${HOLDER}, active 3m ago. Pick a different task.`;
const RELEASE_REFUSAL = `Release refused: held by ${HOLDER}, active 3m ago. Pick a different task.`;

describe("a live holder is refused, identically, on every surface", () => {
  let ref: string;
  beforeAll(() => {
    ref = newHeldTask("Live holder");
    backdate(ref, 180);
  });

  it("MCP checkout_task refuses and names the holder and their last activity", async () => {
    const envelope = mcpEnvelope(
      await mcp.call("checkout_task", { ref, ws: WS, steal_if_idle_seconds: 3600 }),
    );
    expect(envelope.code).toBe("conflict");
    expect(envelope.message).toBe(CHECKOUT_REFUSAL);
    // A refused steal is NOT retryable — it is the same "pick another task"
    // contract as an ordinary checkout conflict.
    expect(envelope.retryable).toBe(false);
    expect((envelope.detail as Record<string, unknown>).heldBy).toBe(HOLDER);
  });

  it("CLI --steal-if-stale refuses with exit 4 and the same sentence", () => {
    const result = cli("start", ref, "--ws", WS, "--steal-if-stale", "1h", "--json");
    expect(result.status).toBe(4);
    const envelope = cliEnvelope(result);
    expect(envelope.code).toBe("conflict");
    expect(envelope.message).toBe(CHECKOUT_REFUSAL);
    expect(envelope.retryable).toBe(false);
  });

  it("HTTP /api/action refuses with 409 and the same sentence", async () => {
    const { status, body } = await action({
      type: "checkout",
      ref,
      actor: RESCUER,
      stealIfIdleSeconds: 3600,
    });
    expect(status).toBe(409);
    expect(body.code).toBe("conflict");
    expect(body.message).toBe(CHECKOUT_REFUSAL);
  });

  it("refuses release-if-stale the same way, on every surface", async () => {
    const viaMcp = mcpEnvelope(
      await mcp.call("release_task", { ref, ws: WS, if_idle_seconds: 3600 }),
    );
    expect(viaMcp.message).toBe(RELEASE_REFUSAL);

    const viaCli = cli("release", ref, "--ws", WS, "--if-stale", "1h", "--json");
    expect(viaCli.status).toBe(4);
    expect(cliEnvelope(viaCli).message).toBe(RELEASE_REFUSAL);

    const viaHttp = await action({ type: "release", ref, actor: RESCUER, ifIdleSeconds: 3600 });
    expect(viaHttp.status).toBe(409);
    expect(viaHttp.body.message).toBe(RELEASE_REFUSAL);
  });

  it("leaves the claim standing after all of that", () => {
    const rows = JSON.parse(cli("ls", "--ws", WS, "--json").stdout) as Array<{
      identifier: string;
      checkoutAgent: string | null;
    }>;
    expect(rows.find((r) => r.identifier === ref)!.checkoutAgent).toBe(HOLDER);
  });
});

// ----------------------------------------------------------------- takeovers

describe("a dead holder can be taken over, explicitly, on every surface", () => {
  it("MCP checkout_task steals, reassigns, and reports the new holder", async () => {
    const ref = newHeldTask("MCP takeover");
    backdate(ref, 7200);
    const issue = toolPayload(
      await mcp.call("checkout_task", { ref, ws: WS, steal_if_idle_seconds: 3600 }),
    ) as Record<string, unknown>;
    expect(issue.checkoutAgent).toBe(RESCUER);
    expect(issue.assignee).toBe(RESCUER);
    expect(issue.status).toBe("in_progress");
  });

  it("CLI --steal-if-stale steals and says whose work it took", () => {
    const ref = newHeldTask("CLI takeover");
    backdate(ref, 7200);
    const result = cli("start", ref, "--ws", WS, "--steal-if-stale", "30m");
    expect(result.status).toBe(0);
    // Not a silent "claimed": a takeover has to read as a takeover.
    expect(result.stdout).toContain("stole");
    expect(result.stdout).toContain(`was ${HOLDER}`);
    expect(result.stdout).toContain("silent 2h");
  });

  it("CLI accepts seconds, minutes, and hours for the same threshold", () => {
    for (const duration of ["1800", "30m", "0.5h"]) {
      const ref = newHeldTask(`CLI duration ${duration}`);
      backdate(ref, 7200);
      const result = cli("start", ref, "--ws", WS, "--steal-if-stale", duration, "--json");
      expect(result.status).toBe(0);
      expect((JSON.parse(result.stdout) as { checkoutAgent: string }).checkoutAgent).toBe(RESCUER);
    }
  });

  it("CLI rejects a malformed duration instead of stealing anything", () => {
    const ref = newHeldTask("CLI bad duration");
    backdate(ref, 7200);
    const result = cli("start", ref, "--ws", WS, "--steal-if-stale", "soon", "--json");
    expect(result.status).toBe(2);
    expect(cliEnvelope(result).code).toBe("validation");
    const rows = JSON.parse(cli("ls", "--ws", WS, "--json").stdout) as Array<{
      identifier: string;
      checkoutAgent: string | null;
    }>;
    expect(rows.find((r) => r.identifier === ref)!.checkoutAgent).toBe(HOLDER);
  });

  it("HTTP /api/action steals and returns the reassigned issue", async () => {
    const ref = newHeldTask("HTTP takeover");
    backdate(ref, 7200);
    const { status, body } = await action({
      type: "checkout",
      ref,
      actor: RESCUER,
      stealIfIdleSeconds: 3600,
    });
    expect(status).toBe(200);
    expect(body.checkoutAgent).toBe(RESCUER);
    expect(body.assignee).toBe(RESCUER);
  });

  it("HTTP rejects a non-numeric threshold rather than silently plain-checking-out", async () => {
    const ref = newHeldTask("HTTP bad threshold");
    backdate(ref, 7200);
    const { status, body } = await action({
      type: "checkout",
      ref,
      actor: RESCUER,
      stealIfIdleSeconds: "soon",
    });
    // KNOWN: this surface maps every StapleError except not_found to 409
    // (server.ts catch), so a validation failure is 409 here while the CLI exits
    // 2. Pinned as-is — the C1 work did not touch the status mapping.
    expect(status).toBe(409);
    expect(body.code).toBe("validation");
    // The point of the assertion: a bad threshold must not degrade into a plain
    // checkout that reports success while quietly stealing nothing.
    expect(body.retryable).toBe(false);
  });

  it("release --if-stale frees a dead claim on every surface", async () => {
    const viaCli = newHeldTask("CLI stale release");
    backdate(viaCli, 7200);
    expect(cli("release", viaCli, "--ws", WS, "--if-stale", "30m").status).toBe(0);

    const viaMcp = newHeldTask("MCP stale release");
    backdate(viaMcp, 7200);
    // release_task declares no outputSchema, so success is "not an error result"
    // rather than a structured payload.
    const mcpResult = await mcp.call("release_task", { ref: viaMcp, ws: WS, if_idle_seconds: 1800 });
    expect(mcpResult.isError ?? false).toBe(false);

    const viaHttp = newHeldTask("HTTP stale release");
    backdate(viaHttp, 7200);
    const http = await action({ type: "release", ref: viaHttp, actor: RESCUER, ifIdleSeconds: 1800 });
    expect(http.status).toBe(200);
    expect(http.body.status).toBe("todo");
    expect(http.body.checkoutAgent).toBeNull();
  });

  it("logs claim_stolen and claim_released_stale, not a bare checkout or release", () => {
    const stolen = newHeldTask("Event shape steal");
    backdate(stolen, 7200);
    expect(cli("start", stolen, "--ws", WS, "--steal-if-stale", "30m").status).toBe(0);
    expect(cli("release", stolen, "--ws", WS, "--if-stale", "0").status).toBe(0);

    const events = cli("events", "--ws", WS, "--json")
      .stdout.trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; actor: string | null; payload: Record<string, unknown> });

    const steal = events.filter((e) => e.kind === "claim_stolen").at(-1)!;
    expect(steal.actor).toBe(RESCUER);
    expect(steal.payload.previousHolder).toBe(HOLDER);
    expect(steal.payload.stealIfIdleSeconds).toBe(1800);

    const release = events.filter((e) => e.kind === "claim_released_stale").at(-1)!;
    expect(release.actor).toBe(RESCUER);
    expect(release.payload.previousHolder).toBe(RESCUER);
  });
});

// ------------------------------------------------------------- liveness reads

describe("held rows carry their liveness on every read surface", () => {
  let ref: string;
  beforeAll(() => {
    ref = newHeldTask("Liveness read");
    backdate(ref, 7200);
  });

  it("CLI ls --json carries claim on the held row and null elsewhere", () => {
    const rows = JSON.parse(cli("ls", "--ws", WS, "--all", "--json").stdout) as Array<{
      identifier: string;
      status: string;
      claim: { heldBy: string; idleSeconds: number; heldSeconds: number } | null;
    }>;
    const held = rows.find((r) => r.identifier === ref)!;
    expect(held.claim!.heldBy).toBe(HOLDER);
    expect(held.claim!.idleSeconds).toBeGreaterThanOrEqual(7200);
    expect(held.claim!.heldSeconds).toBeGreaterThanOrEqual(7200);
    // Nothing that is not in_progress pretends to be held.
    for (const row of rows.filter((r) => r.status !== "in_progress")) {
      expect(row.claim).toBeNull();
    }
  });

  it("CLI ls and show render held-for and silent-for as prose", () => {
    expect(cli("ls", "--ws", WS).stdout).toContain("held 2h · silent 2h");
    const show = cli("show", ref, "--ws", WS).stdout;
    expect(show).toContain(`held by ${HOLDER}`);
    expect(show).toContain("held 2h · silent 2h");
  });

  it("MCP get_task, list_tasks, and inbox all carry the same claim", async () => {
    const detail = toolPayload(await mcp.call("get_task", { ref, ws: WS })) as {
      claim: { heldBy: string; idleSeconds: number };
    };
    expect(detail.claim.heldBy).toBe(HOLDER);
    expect(detail.claim.idleSeconds).toBeGreaterThanOrEqual(7200);

    const list = toolPayload(await mcp.call("list_tasks", { ws: WS, limit: 200 })) as {
      items: Array<{ identifier: string; claim: { heldBy: string } | null }>;
    };
    expect(list.items.find((i) => i.identifier === ref)!.claim!.heldBy).toBe(HOLDER);

    const inbox = toolPayload(await mcp.call("inbox", { ws: WS, limit: 200 })) as {
      ready: Array<{ identifier: string; claim: { heldBy: string } | null }>;
      blocked: Array<{ identifier: string; claim: { heldBy: string } | null }>;
    };
    const entry = [...inbox.ready, ...inbox.blocked].find((i) => i.identifier === ref)!;
    expect(entry.claim!.heldBy).toBe(HOLDER);
  });

  it("HTTP /api/issue and /api/issues carry the same claim", async () => {
    const detail = await httpJson(`/api/issue?ref=${encodeURIComponent(ref)}`);
    expect((detail.body.claim as { heldBy: string }).heldBy).toBe(HOLDER);

    const list = await httpJson("/api/issues");
    const rows = list.body as unknown as Array<{
      issue: { identifier: string };
      claim: { heldBy: string } | null;
    }>;
    expect(rows.find((r) => r.issue.identifier === ref)!.claim!.heldBy).toBe(HOLDER);
  });

  it("an unheld issue reports claim: null rather than omitting the field", async () => {
    expect(cli("new", "Never started", "--ws", WS).status).toBe(0);
    const rows = JSON.parse(cli("ls", "--ws", WS, "--json").stdout) as Array<{
      identifier: string;
      title: string;
      claim: unknown;
    }>;
    const free = rows.find((r) => r.title === "Never started")!;
    expect(free.claim).toBeNull();
    const detail = toolPayload(await mcp.call("get_task", { ref: free.identifier, ws: WS })) as {
      claim: unknown;
    };
    expect(detail.claim).toBeNull();
  });
});

// --------------------------------------------------------- nothing is automatic

describe("no claim ever changes hands without being asked", () => {
  it("an ordinary checkout of a long-dead claim is still refused", () => {
    const ref = newHeldTask("No opt-in");
    backdate(ref, 86_400);
    const result = cli("start", ref, "--ws", WS, "--json");
    expect(result.status).toBe(4);
    expect(cliEnvelope(result).message).toContain("do not retry");
  });

  it("an ordinary release of someone else's dead claim is still refused", () => {
    const ref = newHeldTask("No opt-in release");
    backdate(ref, 86_400);
    const result = cli("release", ref, "--ws", WS, "--json");
    expect(result.status).toBe(4);
    expect(cliEnvelope(result).message).toContain(`held by ${HOLDER}`);
  });

  it("merely reading a stale claim never mutates it", async () => {
    const ref = newHeldTask("Read is not a write");
    backdate(ref, 86_400);
    await mcp.call("get_task", { ref, ws: WS });
    await mcp.call("inbox", { ws: WS, limit: 200 });
    await httpJson("/api/issues");
    cli("ls", "--ws", WS);
    const rows = JSON.parse(cli("ls", "--ws", WS, "--json").stdout) as Array<{
      identifier: string;
      status: string;
      checkoutAgent: string | null;
    }>;
    const row = rows.find((r) => r.identifier === ref)!;
    expect(row.status).toBe("in_progress");
    expect(row.checkoutAgent).toBe(HOLDER);
  });
});
