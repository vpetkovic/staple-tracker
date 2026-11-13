/**
 * What the plan's tree reads from the server (design/plan.md, "Presentation"): each record's own
 * units, whether it is an umbrella and which horizon carries it; each horizon's count of steps
 * waiting on the person; and a horizon's detail carries every record its tree draws, with the
 * horizons' names. Every surface reads the same derivation, and with planning off none of it
 * appears.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type CliResult, type McpHarness } from "./fixtures/contract-support.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const WS = "treews";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;
let now: { id: string; identifier: string };
let later: { id: string; identifier: string; name: string };
let ids: { parent: string; carried: string; elsewhere: string; question: string; other: string };

async function cli(...args: string[]): Promise<CliResult> {
  return await runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

async function cliJson(...args: string[]): Promise<unknown> {
  const result = await cli(...args, "--ws", WS, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: "VP", ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const tool = async (name: string, args: Record<string, unknown> = {}) => toolPayload(await mcp.call(name, { ws: WS, ...args })) as Record<string, unknown>;
const planning = async (on: boolean) => expect((await http("/api/settings", { target: "settings", ops: [{ op: "set", key: "features.planning", value: on }] })).status).toBe(200);
const captured = (response: { body: Record<string, unknown> }) => (response.body as { idea: { idea: { id: string } } }).idea.idea.id;

interface TreeFields {
  id: string;
  own: { done: number; open: number; planned: number; total: number };
  umbrella: boolean;
  carriedBy: string | null;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-tree-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-tree-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await cli("init", "--global", WS)).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;

  // Now carries an umbrella with two sub-ideas, one scheduled on no horizon (so carried through
  // its parent) and one on Later; a record with a question for the person; and nothing else.
  await planning(true);
  now = ((await http(`/api/plan?ws=${WS}`)).body as unknown as { horizons: Array<{ id: string; identifier: string }> }).horizons[0]!;
  const created = await http("/api/plan/horizon-create", { name: "Later", date: "2099-06-30" });
  expect(created.status).toBe(200);
  later = ((await http(`/api/plan?ws=${WS}`)).body as unknown as { horizons: Array<{ id: string; identifier: string; name: string }> }).horizons.find((h) => h.name === "Later")!;
  const parent = captured(await http("/api/plan/capture", { title: "Checkout API", maturity: "shaped", plan: READY_PLAN, horizon: now.id }));
  const carried = captured(await http("/api/plan/capture", { title: "Card payments", maturity: "shaped", plan: READY_PLAN, parent }));
  const elsewhere = captured(await http("/api/plan/capture", { title: "Refunds", maturity: "shaped", plan: READY_PLAN, parent, horizon: later.id }));
  const question = captured(await http("/api/plan/capture", { title: "Billing export", maturity: "exploring", horizon: now.id }));
  expect((await cli("idea", "ask", question, "Which file format?", "--ws", WS)).status).toBe(0);
  const other = captured(await http("/api/plan/capture", { title: "Audit trail", maturity: "shaped", plan: READY_PLAN, horizon: later.id }));
  ids = { parent, carried, elsewhere, question, other };
}, 90_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

const pick = (ideas: unknown, id: string): TreeFields => {
  const found = (ideas as TreeFields[]).find((idea) => idea.id === id)!;
  return { id: found.id, own: found.own, umbrella: found.umbrella, carriedBy: found.carriedBy };
};

describe("the tree's fields, planning on", () => {
  it("gives each record its own units, whether it is an umbrella and the horizon carrying it, the same on every surface", async () => {
    const rows = READY_PLAN.breakdown.length;
    const expected: TreeFields[] = [
      // An umbrella: its sub-ideas carry its size, so its own rows are not counted beside theirs.
      { id: ids.parent, own: { done: 0, open: 0, planned: 0, total: 0 }, umbrella: true, carriedBy: now.id },
      // Scheduled on no horizon: carried through its parent.
      { id: ids.carried, own: { done: 0, open: 0, planned: rows, total: rows }, umbrella: false, carriedBy: now.id },
      { id: ids.elsewhere, own: { done: 0, open: 0, planned: rows, total: rows }, umbrella: false, carriedBy: later.id },
      { id: ids.question, own: { done: 0, open: 0, planned: 0, total: 0 }, umbrella: false, carriedBy: now.id },
    ];
    const page = ((await http(`/api/plan?ws=${WS}`)).body as { ideas: unknown }).ideas;
    const listed = (await tool("list_ideas")).ideas;
    for (const want of expected) {
      expect(pick(page, want.id)).toEqual(want);
      expect(pick(listed, want.id)).toEqual(want);
      expect(pick([((await tool("get_idea", { ref: want.id })) as { idea: unknown }).idea], want.id)).toEqual(want);
      expect(pick([((await cliJson("idea", "show", want.id)) as { idea: unknown }).idea], want.id)).toEqual(want);
    }
  });

  it("counts a horizon's steps that wait on the person, the same on list_horizons, horizon ls and the page", async () => {
    const count = (list: unknown, id: string) => (list as Array<{ id: string; needsYou: number }>).find((h) => h.id === id)!.needsYou;
    // Now: the question waits on the person; the scaffold steps are an agent's.
    for (const list of [await tool("list_horizons"), await cliJson("horizon", "ls"), ((await http(`/api/plan?ws=${WS}`)).body as { horizons: unknown }).horizons]) {
      expect(count(list, now.id)).toBe(1);
      expect(count(list, later.id)).toBe(0);
    }
  });

  it("hands a horizon's detail every record its tree draws, sub-ideas carried elsewhere included, and the horizons' names", async () => {
    const plan = ((await http(`/api/issue?ws=${WS}&ref=${now.identifier}`)).body as { horizonPlan: { ideas: Array<{ id: string }>; horizons: Array<{ id: string; name: string }> } }).horizonPlan;
    expect(plan.ideas.map((idea) => idea.id).sort()).toEqual([ids.parent, ids.carried, ids.elsewhere, ids.question].sort());
    expect(plan.ideas.map((idea) => idea.id)).not.toContain(ids.other);
    expect(plan.horizons).toEqual(expect.arrayContaining([{ id: now.id, name: expect.any(String) }, { id: later.id, name: "Later" }]));
  });
});

describe("planning off", () => {
  it("carries none of the tree's fields on any surface that still answers", async () => {
    await planning(false);
    try {
      const surfaces = [
        (await http(`/api/issue?ws=${WS}&ref=${now.identifier}`)).body,
        await tool("get_milestone", { ref: now.identifier }),
        await cliJson("milestone", "show", now.identifier),
        await tool("list_milestones"),
        await cliJson("milestone", "ls"),
      ];
      for (const surface of surfaces) {
        const text = JSON.stringify(surface);
        for (const field of ['"own"', '"umbrella"', '"carriedBy"', '"needsYou"', '"horizonPlan"']) expect(text).not.toContain(field);
      }
    } finally {
      await planning(true);
    }
  });
});
