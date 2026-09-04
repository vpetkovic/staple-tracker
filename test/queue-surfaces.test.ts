/**
 * STA-168 — the pickup queue across the four surfaces.
 *
 * `store-queue.test.ts` pins the plan and `store-queue-resolver.test.ts` pins
 * what the order MEANS. This suite pins that the CLI (`--json`), the MCP tools,
 * the UI server's routes and the agent inbox are four projections of ONE shape
 * and ONE refusal table: the same `{revision, entries, effective}` after
 * normalization, the same revision and the same order on every surface, the
 * same `{code, retryable, detail}` triple for a stale base and for an
 * out-of-order checkout, and READY printed in effective order with its
 * positions. Every test name is the one docs/queue.md says pins the paragraph.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import {
  CONTRACT_AGENT,
  cliEnvelope,
  mcpEnvelope,
  normalize,
  runCli,
  startMcpClient,
  toolPayload,
  type CliResult,
  type McpHarness,
} from "./fixtures/contract-support.js";
import { CLI_EXIT_CODES, ERROR_CONTRACT, httpStatusFor, tripleOf } from "./fixtures/error-contract.js";

const WS = "queue";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]): CliResult {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

function cliJson(...args: string[]): Record<string, unknown> {
  const result = cli(...args, "--json");
  expect(result.stderr, result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function mcpJson(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await mcp.call(name, { ws: WS, ...args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result) as Record<string, unknown>;
}

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: CONTRACT_AGENT, ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function httpJson(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { status, body: payload } = await http(path, body);
  expect(status, JSON.stringify(payload)).toBe(200);
  return payload;
}

/** The one comparable projection: identifiers in order, with the revision. */
function shape(view: Record<string, unknown>): {
  revision: unknown;
  entries: string[];
  effective: string[];
} {
  return {
    revision: view.revision,
    entries: (view.entries as Array<{ identifier: string }>).map((e) => e.identifier),
    effective: (view.effective as Array<{ identifier: string; eligibility: string }>).map(
      (row) => `${row.identifier}:${row.eligibility}`,
    ),
  };
}

async function everySurface(): Promise<Array<ReturnType<typeof shape>>> {
  return [
    shape(cliJson("queue", "--ws", WS)),
    shape(await mcpJson("list_queue", {})),
    shape(await httpJson(`/api/queue?ws=${WS}`)),
  ];
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-queue-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-queue-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  expect(cli("init", "--global", WS).status).toBe(0);
  // QUE-1 epic > QUE-2, QUE-3; QUE-4 a standalone task; QUE-5 blocks QUE-3.
  expect(cli("new", "S: continuity", "--kind", "epic", "--ws", WS).status).toBe(0);
  expect(cli("new", "S1", "--parent", "QUE-1", "--ws", WS).status).toBe(0);
  expect(cli("new", "S2", "--parent", "QUE-1", "--ws", WS).status).toBe(0);
  expect(cli("new", "Flake under load", "--ws", WS).status).toBe(0);
  expect(cli("new", "Upstream fix", "--ws", WS).status).toBe(0);
  expect(cli("blocked-by", "QUE-3", "QUE-5", "--ws", WS).status).toBe(0);

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
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

describe("every mutation has the same shape and refusal on every surface", () => {
  it("CLI, MCP, HTTP and inbox return the same revision and the same order", async () => {
    // One enqueue, read three ways. Nothing is normalised away here except the
    // shape reduction itself: the revision is compared as a number.
    expect(cli("queue", "add", "QUE-1", "--ws", WS).status).toBe(0);
    const [fromCli, fromMcp, fromHttp] = await everySurface();
    expect(fromCli).toEqual({
      revision: 1,
      entries: ["QUE-1"],
      // The epic is expanded, never emitted; QUE-3 waits on QUE-5, which is
      // itself real unqueued work; QUE-4 follows in presentation sort.
      effective: ["QUE-2:eligible", "QUE-3:blocked", "QUE-4:eligible", "QUE-5:eligible"],
    });
    expect(fromMcp).toEqual(fromCli);
    expect(fromHttp).toEqual(fromCli);

    // The inbox is the fourth surface and reads the same resolver.
    const inbox = (await mcpJson("inbox", {})) as {
      ready: Array<{ identifier: string; position: number | null }>;
    };
    expect(inbox.ready.map((row) => row.identifier)).toEqual(["QUE-1", "QUE-2", "QUE-4", "QUE-5"]);
    expect(cli("queue", "rm", "QUE-1", "--ws", WS).status).toBe(0);
  });

  it("enqueue, move, reorder, dequeue and prune agree on all three", async () => {
    // Each surface performs ONE verb and the next surface reads the result, so
    // a projection that quietly did something else would break the next step.
    expect(cliJson("queue", "add", "QUE-4", "--ws", WS).revision).toBe(3);
    expect((await mcpJson("enqueue_task", { ref: "QUE-1" })).revision).toBe(4);
    expect((await httpJson("/api/queue/enqueue", { ref: "QUE-5" })).revision).toBe(5);
    expect((await everySurface())[0]!.entries).toEqual(["QUE-4", "QUE-1", "QUE-5"]);

    // move on CLI, reorder on MCP, prune on HTTP.
    expect(cliJson("queue", "mv", "QUE-5", "--at", "1", "--ws", WS).revision).toBe(6);
    expect((await everySurface())[0]!.entries).toEqual(["QUE-5", "QUE-4", "QUE-1"]);
    await mcpJson("reorder_queue", { order: ["QUE-1", "QUE-4", "QUE-5"], base_revision: 6 });
    expect((await everySurface())[0]!.entries).toEqual(["QUE-1", "QUE-4", "QUE-5"]);

    expect(cli("done", "QUE-4", "--ws", WS).status).toBe(0);
    const pruned = await httpJson("/api/queue/prune", {});
    expect(shape(pruned).entries).toEqual(["QUE-1", "QUE-5"]);

    // Dequeue the rest, on the third surface again, and land back at empty.
    await mcpJson("dequeue_task", { ref: "QUE-1" });
    expect(cliJson("queue", "rm", "QUE-5", "--ws", WS).entries).toEqual([]);
    for (const view of await everySurface()) expect(view.entries).toEqual([]);
    expect(cli("status", "QUE-4", "todo", "--ws", WS).status).toBe(0);
  });

  it("reports plan position and effective position separately", async () => {
    expect(cli("queue", "add", "QUE-1", "--ws", WS).status).toBe(0);
    expect(cli("queue", "add", "QUE-4", "--ws", WS).status).toBe(0);
    const view = await httpJson(`/api/queue?ws=${WS}`);
    const rows = view.effective as Array<Record<string, unknown>>;
    // QUE-4 is PLAN row 2 and EFFECTIVE row 3, because the epic above it
    // expanded into two. Both numbers are on the row, side by side.
    expect(rows.find((row) => row.identifier === "QUE-4")).toMatchObject({
      planPosition: 2,
      position: 3,
      via: null,
      unqueued: false,
    });
    expect(rows.find((row) => row.identifier === "QUE-2")).toMatchObject({
      planPosition: 1,
      position: 1,
      via: "QUE-1",
    });
    // And the unqueued band carries no plan position at all.
    expect(rows.find((row) => row.identifier === "QUE-5")).toMatchObject({
      planPosition: null,
      unqueued: true,
    });
  });

  it("next is one shape on CLI, MCP and HTTP", async () => {
    const fromCli = normalize(cliJson("queue", "next", "--actor", "agent-1", "--ws", WS), [home]);
    const fromMcp = normalize(await mcpJson("next_task", { actor: "agent-1" }), [home]);
    const fromHttp = normalize(await httpJson(`/api/queue/next?ws=${WS}&actor=agent-1`), [home]);
    expect((fromCli as { next: { identifier: string } }).next.identifier).toBe("QUE-2");
    expect(fromMcp).toEqual(fromCli);
    expect(fromHttp).toEqual(fromCli);
  });

  it("a stale base is the same revision_conflict triple on every surface", async () => {
    // Read the base rather than counting the mutations above: what is pinned is
    // that all three surfaces answer the SAME triple, not which number it holds.
    const current = Number(cliJson("queue", "--ws", WS).revision);
    const expected = ERROR_CONTRACT.revisionConflict(current);
    const fromCli = cli("queue", "rm", "QUE-4", "--base", "0", "--ws", WS, "--json");
    expect(fromCli.status).toBe(CLI_EXIT_CODES.revision_conflict);
    expect(tripleOf(cliEnvelope(fromCli))).toEqual(expected);
    expect(tripleOf(mcpEnvelope(await mcp.call("dequeue_task", { ws: WS, ref: "QUE-4", base_revision: 0 })))).toEqual(
      expected,
    );
    const { status, body } = await http("/api/queue/remove", { ref: "QUE-4", baseRevision: 0 });
    expect(status).toBe(httpStatusFor("revision_conflict"));
    expect(tripleOf(body)).toEqual(expected);
    // A refused mutation changed nothing: the server order stands.
    expect((await everySurface())[0]!.entries).toEqual(["QUE-1", "QUE-4"]);
  });

  it("the reads are not writable and the verbs are not readable", async () => {
    // `/api/queue` and `/api/queue/next` share a prefix with five POST routes and
    // are still GET-only, which is the whole reason the method gate names the
    // verbs instead of the family.
    expect((await http("/api/queue", {})).status).toBe(405);
    expect((await http("/api/queue/next", {})).status).toBe(405);
    const read = await fetch(`${origin}/api/queue/prune?ws=${WS}`, { headers: { "x-staple-token": token } });
    expect(read.status).toBe(405);
  });
});

describe("strict refuses the same way on every surface", () => {
  beforeAll(() => {
    expect(cli("settings", "set", "queue.policy", "strict", "--ws", WS).status).toBe(0);
  });

  it("exits 10 with the out_of_order triple", () => {
    // QUE-4 is plan row 2; QUE-2 is the head of the effective order.
    const expected = ERROR_CONTRACT.checkoutOutOfOrder(["QUE-2"], 3, 1);
    const result = cli("checkout", "QUE-4", "--agent", "agent-1", "--ws", WS, "--json");
    expect(result.status).toBe(CLI_EXIT_CODES.out_of_order);
    expect(result.status).toBe(10);
    expect(tripleOf(cliEnvelope(result))).toEqual(expected);
    expect(cliEnvelope(result).message).toContain("Take QUE-2");
  });

  it("refuses the same way on MCP and HTTP", async () => {
    const expected = ERROR_CONTRACT.checkoutOutOfOrder(["QUE-2"], 3, 1);
    expect(
      tripleOf(mcpEnvelope(await mcp.call("checkout_task", { ws: WS, ref: "QUE-4", actor: "agent-1" }))),
    ).toEqual(expected);
    const { status, body } = await http("/api/action", { type: "checkout", ref: "QUE-4", actor: "agent-1" });
    // Not a not_found, so 409 — the same mapping every other refusal gets.
    expect(status).toBe(httpStatusFor("out_of_order"));
    expect(tripleOf(body)).toEqual(expected);
    expect(body.retryable).toBe(false);
  });

  it("--override without -m is refused", () => {
    const result = cli("checkout", "QUE-4", "--override", "--ws", WS, "--json");
    expect(result.status).toBe(CLI_EXIT_CODES.validation);
    expect(tripleOf(cliEnvelope(result))).toEqual(ERROR_CONTRACT.missingActor());
    expect(cliEnvelope(result).message).toContain("An override needs a reason");
  });

  it("an override with a reason succeeds on every surface and is recorded", async () => {
    // The override runs as the CLI's own identity, which is also what releases
    // it between the three attempts — `release` is the holder's command.
    expect(cli("checkout", "QUE-4", "--override", "-m", "CI is red for everyone", "--ws", WS).status).toBe(0);
    // `events --json` is NDJSON, one event per line, as it has always been.
    const log = cli("events", "--ws", WS, "--json");
    expect(log.status).toBe(0);
    const events = log.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; actor: string | null; payload: Record<string, unknown> });
    const overridden = events.filter((event) => event.kind === "queue_overridden");
    expect(overridden).toHaveLength(1);
    expect(overridden[0]).toMatchObject({
      actor: CONTRACT_AGENT,
      payload: { identifier: "QUE-4", reason: "CI is red for everyone", policy: "strict", expected: ["QUE-2"] },
    });
    // The plan is unchanged and QUE-2 is still the head row for the next agent.
    expect((await everySurface())[0]!.entries).toEqual(["QUE-1", "QUE-4"]);
    expect(((await mcpJson("next_task", { actor: "agent-1" })).next as { identifier: string }).identifier).toBe(
      "QUE-2",
    );

    // The MCP twin: override_reason on checkout_task, on a different row.
    expect(cli("release", "QUE-4", "--ws", WS).status).toBe(0);
    const viaMcp = await mcp.call("checkout_task", {
      ws: WS,
      ref: "QUE-4",
      actor: CONTRACT_AGENT,
      override_reason: "same call, other surface",
    });
    expect(viaMcp.isError).toBeFalsy();
    // …and the HTTP twin, which is the UI's confirm dialog.
    expect(cli("release", "QUE-4", "--ws", WS).status).toBe(0);
    const { status } = await http("/api/action", {
      type: "checkout",
      ref: "QUE-4",
      actor: CONTRACT_AGENT,
      overrideReason: "third surface",
    });
    expect(status).toBe(200);
    expect(cli("release", "QUE-4", "--ws", WS).status).toBe(0);
  });
});

describe("the inbox is derived from the shared resolver", () => {
  it("READY is in effective order and carries positions", async () => {
    // The plan is QUE-1 (the epic) then QUE-4. QUE-4's priority and created_at
    // would put it elsewhere under presentation sort; the plan wins.
    expect(cli("queue", "mv", "QUE-4", "--at", "1", "--ws", WS).status).toBe(0);
    const inbox = (await mcpJson("inbox", {})) as {
      ready: Array<{ identifier: string; position: number | null; planPosition: number | null }>;
    };
    expect(inbox.ready.map((row) => row.identifier)).toEqual(["QUE-4", "QUE-1", "QUE-2", "QUE-5"]);
    expect(inbox.ready.map((row) => [row.identifier, row.position, row.planPosition])).toEqual([
      ["QUE-4", 1, 1],
      // A container is in the inbox but is NOT an effective row, so it has no
      // position of its own; it ranks where its earliest descendant does.
      ["QUE-1", null, 2],
      ["QUE-2", 2, 2],
      // Unqueued work keeps presentation sort, after the plan.
      ["QUE-5", 4, null],
    ]);
    expect(cli("queue", "mv", "QUE-4", "--at", "2", "--ws", WS).status).toBe(0);
  });

  it("a queued-but-gated row stays in QUEUED with its plan position", async () => {
    expect(cli("gate", "QUE-1", "--owner", "vp", "--ws", WS).status).toBe(0);
    const inbox = (await mcpJson("inbox", {})) as {
      ready: Array<{ identifier: string }>;
      queued: Array<{ identifier: string; planPosition: number | null; queuedBy: unknown }>;
    };
    // Membership is unchanged by the queue: the gate still decides the bucket.
    expect(inbox.queued.map((row) => row.identifier)).toEqual(["QUE-1", "QUE-2", "QUE-3"]);
    expect(inbox.queued.find((row) => row.identifier === "QUE-2")).toMatchObject({ planPosition: 1 });
    expect(inbox.ready.map((row) => row.identifier)).toEqual(["QUE-4", "QUE-5"]);
    expect(cli("approve", "QUE-1", "--ws", WS).status).toBe(0);
  });
});

/**
 * STA-174 (R3d) — the two path fields, last on purpose: this suite adds the
 * `milestone` kind and a milestone to the fixture, and every describe above it
 * pins an exact issue list.
 */
describe("the milestone and epic path ride on every effective row", () => {
  it("reports the milestone and epic path for every effective row on every surface", async () => {
    // QUE-1 is the epic over QUE-2/QUE-3; a milestone holds it, so both leaves
    // inherit the milestone and name the epic they came through. (R3d, STA-174.)
    expect(cli("kinds", "add", "milestone", "--label", "Milestone", "--ws", WS).status).toBe(0);
    expect(cli("milestone", "new", "October cut", "--ws", WS).status).toBe(0);
    expect(cli("milestone", "add", "QUE-6", "QUE-1", "--ws", WS).status).toBe(0);

    const paths = (view: Record<string, unknown>): Array<[string, string[], string[]]> =>
      (view.effective as Array<{ identifier: string; milestonePath: string[]; epicPath: string[] }>).map((row) => [
        row.identifier,
        row.milestonePath,
        row.epicPath,
      ]);
    const fromCli = paths(cliJson("queue", "--ws", WS));
    expect(fromCli).toEqual([
      ["QUE-2", ["QUE-6"], ["QUE-1"]],
      ["QUE-3", ["QUE-6"], ["QUE-1"]],
      // Work outside every epic and every milestone carries two empty paths
      // rather than nulls: the fields are always there to read.
      ["QUE-4", [], []],
      ["QUE-5", [], []],
    ]);
    expect(paths(await mcpJson("list_queue", {}))).toEqual(fromCli);
    expect(paths(await httpJson(`/api/queue?ws=${WS}`))).toEqual(fromCli);
    // `next` is the same row on the same shape, path fields included.
    expect(((await mcpJson("next_task", {})).next as { milestonePath: string[] }).milestonePath).toEqual(["QUE-6"]);
    // The milestone is a container: it is never itself an effective row.
    expect(fromCli.map(([identifier]) => identifier)).not.toContain("QUE-6");
  });
});
