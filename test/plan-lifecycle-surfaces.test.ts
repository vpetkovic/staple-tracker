/**
 * One lifecycle table, every surface (design/plan.md, "Lifecycle"). For every idea state and
 * every write, and every horizon state and action, this walks the HTTP routes (the page, as the
 * person), the MCP tools (an agent), the CLI with --person and without it, and the page's own
 * item builders, and holds each to what `src/core/plan-lifecycle.ts` says: a write the state does
 * not offer is refused on every surface naming the state; one it offers succeeds for whoever may
 * take it and is refused as the person's call for an agent when it is the person's; and the
 * actions a record's payload carries, which the drawer and the card menus render, are exactly the
 * table's row for its state. The page's half (items built from those actions alone) is
 * `src/ui/app/src/detail/plan-lifecycle-ui.test.ts`, against the same table.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HORIZON_ACTIONS,
  HORIZON_LIFECYCLE,
  HORIZON_STATES,
  IDEA_ACTIONS,
  IDEA_LIFECYCLE,
  IDEA_STATES,
  horizonOffers,
  ideaOffered,
  ideaOffers,
  maturityAction,
  type HorizonAction,
  type HorizonState,
  type IdeaAction,
  type IdeaState,
} from "../src/core/plan-lifecycle.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "cyclews";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

interface Offered {
  id: string;
  label: string;
  who: "anyone" | "person";
  disabledReason?: string;
}
interface IdeaRow {
  id: string;
  title: string;
  state: IdeaState;
  maturity: string;
  horizonId: string | null;
  promoted: boolean;
  actions: Offered[];
}
interface HorizonRow {
  id: string;
  identifier: string;
  name: string;
  state: HorizonState;
  memberCount: number;
  actions: Offered[];
}
interface Plan {
  horizons: HorizonRow[];
  ideas: IdeaRow[];
}

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: "VP", ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function plan(): Promise<Plan> {
  return (await http(`/api/plan?ws=${WS}`)).body as unknown as Plan;
}

async function cli(person: boolean, ...args: string[]) {
  return await runCliAsync([...args, "--ws", WS, ...(person ? ["--person"] : [])], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  return await mcp.call(name, { ws: WS, ...args });
}

let counter = 0;
const unique = (what: string) => `${what} ${(counter += 1)}`;

/** A fresh tracker task, by its number. */
async function task(done = false): Promise<string> {
  const made = toolPayload(await mcpCall("create_task", { title: unique("Task") })) as { identifier: string };
  if (done) {
    await mcpCall("checkout_task", { ref: made.identifier });
    await mcpCall("update_task", { ref: made.identifier, status: "done" });
  }
  return made.identifier;
}

/** The maturity a fixture in `state` has. */
const maturityOf = (state: IdeaState) => (state === "raw" ? "raw" : state === "exploring" ? "exploring" : state === "dropped" ? "dropped" : "shaped");

/** A fresh idea in `state`, made as the person; its id, and the task it links when it has one. */
async function fixture(state: IdeaState): Promise<{ id: string; linked: string | null }> {
  const maturity = maturityOf(state);
  // Every fixture carries a plan that passes the shaped gate, so a shaping cell measures the lifecycle alone.
  const captured = await http("/api/plan/capture", { title: unique(`A ${state} idea`), maturity, brief: "The first brief.", plan: READY_PLAN });
  expect(captured.status, JSON.stringify(captured.body)).toBe(200);
  const id = (captured.body.idea as { idea: { id: string } }).idea.id;
  let linked: string | null = null;
  if (state === "started" || state === "shipped") {
    linked = await task(state === "shipped");
    expect((await http("/api/plan/adopt", { ref: id, issue: linked })).status).toBe(200);
  }
  return { id, linked };
}

/** A record promoted in place, started (nothing under it yet) or shipped (its one task landed). */
async function promotedFixture(state: "started" | "shipped"): Promise<{ id: string; identifier: string }> {
  const { id } = await fixture("shaped");
  const promoted = await http("/api/plan/promote", { ref: id });
  expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
  const identifier = ((await plan()).ideas.find((idea) => idea.id === id) as IdeaRow & { identifier: string }).identifier;
  if (state === "shipped") {
    const made = toolPayload(await mcpCall("create_task", { title: unique("Its task"), parent: identifier })) as { identifier: string };
    await mcpCall("checkout_task", { ref: made.identifier });
    await mcpCall("update_task", { ref: made.identifier, status: "done" });
  }
  return { id, identifier };
}

/** Every write a surface can make on an idea, and the lifecycle action it is from a given state. */
interface Write {
  key: string;
  action: (state: IdeaState) => IdeaAction | null;
  /** The write on each surface; null where the surface has no such write. */
  http: (ref: string, ctx: Ctx) => [string, Record<string, unknown>];
  mcp: ((ref: string, ctx: Ctx) => [string, Record<string, unknown>]) | null;
  cli: (ref: string, ctx: Ctx) => string[];
}
interface Ctx {
  horizon: string;
  other: string;
  parent: string;
  linked: string | null;
  adoptable: string;
}

const maturityWrite = (target: string): Write => ({
  key: `maturity:${target}`,
  action: (state) => maturityAction({ state, maturity: maturityOf(state) }, target),
  http: (ref) => ["update", { ref, maturity: target }],
  mcp: (ref) => ["update_idea", { ref, maturity: target }],
  cli: (ref) => ["idea", "set", ref, "--maturity", target],
});

const WRITES: Write[] = [
  { key: "edit", action: () => "edit", http: (ref) => ["update", { ref, title: unique("Renamed") }], mcp: (ref) => ["update_idea", { ref, title: unique("Renamed") }], cli: (ref) => ["idea", "set", ref, "--title", unique("Renamed")] },
  { key: "ask", action: () => "ask", http: (ref) => ["question", { ref, text: "Why?" }], mcp: (ref) => ["update_idea", { ref, add_question: "Why?" }], cli: (ref) => ["idea", "ask", ref, "Why?"] },
  { key: "decide", action: () => "decide", http: (ref) => ["decision", { ref, text: "This way" }], mcp: (ref) => ["update_idea", { ref, add_decision: "This way" }], cli: (ref) => ["idea", "decide", ref, "This way"] },
  ...["raw", "exploring", "shaped", "dropped"].map(maturityWrite),
  { key: "schedule", action: () => "schedule", http: (ref, c) => ["update", { ref, horizon: c.horizon }], mcp: (ref, c) => ["update_idea", { ref, horizon: c.horizon }], cli: (ref, c) => ["idea", "set", ref, "--horizon", c.horizon] },
  { key: "plan_dates", action: () => "plan_dates", http: (ref) => ["update", { ref, plannedTarget: "2027-02-01" }], mcp: (ref) => ["update_idea", { ref, planned_target: "2027-02-01" }], cli: (ref) => ["idea", "set", ref, "--target", "2027-02-01"] },
  { key: "reorder", action: () => "reorder", http: (ref, c) => ["update", { ref, before: c.other }], mcp: null, cli: (ref, c) => ["idea", "set", ref, "--before", c.other] },
  { key: "reparent", action: () => "reparent", http: (ref, c) => ["update", { ref, parent: c.parent }], mcp: (ref, c) => ["update_idea", { ref, parent: c.parent }], cli: (ref, c) => ["idea", "set", ref, "--parent", c.parent] },
  { key: "promote", action: () => "promote", http: (ref) => ["promote", { ref }], mcp: (ref) => ["start_idea", { ref }], cli: (ref) => ["idea", "promote", ref] },
  { key: "adopt", action: () => "adopt", http: (ref, c) => ["adopt", { ref, issue: c.adoptable }], mcp: (ref, c) => ["start_idea", { ref, adopt: c.adoptable }], cli: (ref, c) => ["idea", "adopt", ref, c.adoptable] },
  { key: "unlink", action: () => "unlink", http: (ref, c) => ["unlink", { ref, issue: c.linked ?? c.adoptable }], mcp: (ref, c) => ["unlink_idea", { ref, issue: c.linked ?? c.adoptable }], cli: (ref, c) => ["idea", "unlink", ref, c.linked ?? c.adoptable] },
  { key: "reset_baseline", action: () => "reset_baseline", http: (ref) => ["reset-baseline", { ref }], mcp: null, cli: (ref) => ["idea", "reset-baseline", ref] },
];

type Outcome = "ok" | "lifecycle" | "person";

function expected(state: IdeaState, action: IdeaAction, agent: boolean): Outcome {
  if (!ideaOffers(state, action)) return "lifecycle";
  return agent && IDEA_ACTIONS[action].who === "person" ? "person" : "ok";
}

function outcomeOf(ok: boolean, message: string, state: string): Outcome | `unexpected: ${string}` {
  if (ok) return "ok";
  if (message.includes(`is ${state}; it cannot be`)) return "lifecycle";
  // An active horizon's removal is refused by the check that names the open work to move first.
  if (state === "active" && message.includes("holds open work, which removing it would leave")) return "lifecycle";
  if (message.includes("the person's call")) return "person";
  return `unexpected: ${message.slice(0, 160)}`;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-cycle-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-cycle-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
  expect((await runCliAsync(["config", "set", "humanName", "VP"], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  expect((await http("/api/plan/enable", {})).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("the idea lifecycle on every surface", () => {
  it("carries exactly the table's actions for each state", async () => {
    for (const state of IDEA_STATES) {
      const { id } = await fixture(state);
      const row = (await plan()).ideas.find((idea) => idea.id === id)!;
      expect(row.state).toBe(state);
      // The epic opens once promoted; a started record scaffolds again only if it was scaffolded.
      const table = ideaOffered(state, row.promoted).filter((action) => (action !== "open_epic" || row.promoted) && !(action === "scaffold" && state === "started"));
      expect(row.actions.map((action) => action.id), state).toEqual(table);
      for (const action of row.actions) expect(action.who, `${state}/${action.id}`).toBe(IDEA_ACTIONS[action.id as IdeaAction].who);
    }
  }, 60_000);

  it("holds every (state, write) cell to the table on HTTP, MCP, and the CLI with and without --person", async () => {
    const horizons = (await plan()).horizons;
    const failures: string[] = [];
    let cells = 0;
    // Records the writes point at but never change in a way that matters: shared by every cell.
    const other = (await fixture("raw")).id;
    const parent = (await fixture("shaped")).id;
    const jobs: Array<() => Promise<void>> = [];
    for (const state of IDEA_STATES) {
      for (const write of WRITES) {
        const action = write.action(state);
        if (action === null) continue; // not a change from this state
        const surfaces: Array<{ name: string; agent: boolean; run: (ref: string, ctx: Ctx) => Promise<{ ok: boolean; message: string }> }> = [
          {
            name: "http",
            agent: false,
            run: async (ref, ctx) => {
              const [verb, body] = write.http(ref, ctx);
              const result = await http(`/api/plan/${verb}`, body);
              return { ok: result.status === 200, message: JSON.stringify(result.body) };
            },
          },
          {
            name: "cli --person",
            agent: false,
            run: async (ref, ctx) => {
              const result = await cli(true, ...write.cli(ref, ctx));
              return { ok: result.status === 0, message: result.stderr };
            },
          },
          {
            name: "cli",
            agent: true,
            run: async (ref, ctx) => {
              const result = await cli(false, ...write.cli(ref, ctx));
              return { ok: result.status === 0, message: result.stderr };
            },
          },
        ];
        if (write.mcp) {
          const call = write.mcp;
          surfaces.push({
            name: "mcp",
            agent: true,
            run: async (ref, ctx) => {
              const [tool, args] = call(ref, ctx);
              const result = await mcpCall(tool, args);
              return { ok: !result.isError, message: JSON.stringify(result.content) };
            },
          });
        }
        for (const surface of surfaces) {
          jobs.push(async () => {
            const { id, linked } = await fixture(state);
            const adoptable = write.key === "adopt" || (write.key === "unlink" && linked === null) ? await task() : "";
            const ctx: Ctx = { horizon: horizons[0]!.id, other, parent, linked, adoptable };
            const result = await surface.run(id, ctx);
            const got = outcomeOf(result.ok, result.message, state);
            const want = expected(state, action, surface.agent);
            cells += 1;
            if (got !== want) failures.push(`${state} × ${write.key} (${action}) on ${surface.name}: expected ${want}, got ${got}`);
          });
        }
      }
    }
    // Every cell on its own record, so they run side by side, a few at a time.
    for (let next = 0; next < jobs.length; next += 12) await Promise.all(jobs.slice(next, next + 12).map((job) => job()));
    expect(failures).toEqual([]);
    expect(cells).toBeGreaterThan(250);
  }, 300_000);
});

describe("promoted records and parents with sub-ideas on every surface", () => {
  it("carries a promoted record's row with the epic's own edits added", async () => {
    for (const state of ["started", "shipped"] as const) {
      const { id } = await promotedFixture(state);
      const row = (await plan()).ideas.find((idea) => idea.id === id)!;
      expect(row).toMatchObject({ state, promoted: true });
      expect(row.actions.map((action) => action.id), state).toEqual([...ideaOffered(state, true)]);
    }
  }, 60_000);

  it("gives a parent its own row, whatever its sub-ideas' work is doing", async () => {
    const cases: Array<{ parent: IdeaState; child: "started" | "shipped" }> = [
      { parent: "raw", child: "started" },
      { parent: "raw", child: "shipped" },
      { parent: "exploring", child: "shipped" },
      { parent: "shaped", child: "started" },
      { parent: "dropped", child: "started" },
    ];
    for (const { parent, child } of cases) {
      const { id } = await fixture(parent === "dropped" ? "shaped" : parent);
      const sub = await http("/api/plan/capture", { title: unique("A sub-idea"), maturity: "shaped", parent: id });
      const subId = (sub.body.idea as { idea: { id: string } }).idea.id;
      expect((await http("/api/plan/adopt", { ref: subId, issue: await task(child === "shipped") })).status).toBe(200);
      if (parent === "dropped") expect((await http("/api/plan/update", { ref: id, maturity: "dropped" })).status).toBe(200);
      const row = (await plan()).ideas.find((idea) => idea.id === id)!;
      expect(row.state, `${parent} parent, ${child} child`).toBe(parent);
      expect(row.actions.map((action) => action.id)).toEqual([...IDEA_LIFECYCLE[parent]]);
      // And on the agent's surface too.
      const got = toolPayload(await mcpCall("get_idea", { ref: id })) as { idea: { state: string } };
      expect(got.idea.state).toBe(parent);
    }
  }, 60_000);

  it("accepts a maturity a record already has as no change, on every surface", async () => {
    const { id } = await fixture("started");
    expect((await http("/api/plan/update", { ref: id, maturity: "shaped" })).status).toBe(200);
    expect((await mcpCall("update_idea", { ref: id, maturity: "shaped" })).isError).toBeFalsy();
    expect((await cli(true, "idea", "set", id, "--maturity", "shaped")).status).toBe(0);
  }, 60_000);
});

describe("an idea's documents and files on every surface", () => {
  /** Every surface that writes an idea's own content, outside the plan's own tools. */
  const CONTENT: Array<{ name: string; run: (ref: string) => Promise<{ ok: boolean; message: string }> }> = [
    {
      name: "mcp put_document",
      run: async (ref) => {
        const result = await mcpCall("put_document", { ref, key: "risks", body: "A plan section." });
        return { ok: !result.isError, message: JSON.stringify(result.content) };
      },
    },
    {
      name: "http doc_restore",
      run: async (ref) => {
        const result = await http("/api/action", { ref, type: "doc_restore", key: "brief", revision: 1 });
        return { ok: result.status === 200, message: JSON.stringify(result.body) };
      },
    },
    {
      name: "cli doc --put",
      run: async (ref) => {
        const file = join(home, `${unique("body")}.md`);
        writeFileSync(file, "Notes from the CLI.");
        const result = await cli(false, "doc", ref, "notes", "--put", file);
        return { ok: result.status === 0, message: result.stderr };
      },
    },
    {
      name: "mcp attach_file",
      run: async (ref) => {
        const result = await mcpCall("attach_file", { ref, filename: "sketch.txt", bytes_base64: Buffer.from("a sketch").toString("base64"), actor: CONTRACT_AGENT });
        return { ok: !result.isError, message: JSON.stringify(result.content) };
      },
    },
  ];

  it("holds every document and file write to the idea's edit cell", async () => {
    const failures: string[] = [];
    for (const state of IDEA_STATES) {
      for (const surface of CONTENT) {
        const { id } = await fixture(state);
        const result = await surface.run(id);
        const want: Outcome = ideaOffers(state, "edit") ? "ok" : "lifecycle";
        const got = outcomeOf(result.ok, result.message, state);
        if (got !== want) failures.push(`${state} × ${surface.name}: expected ${want}, got ${got}`);
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it("takes them on a promoted record in every state, as on any epic", async () => {
    for (const state of ["started", "shipped"] as const) {
      const { id } = await promotedFixture(state);
      for (const surface of CONTENT) {
        const result = await surface.run(id);
        expect(result.ok, `${state} × ${surface.name}: ${result.message.slice(0, 200)}`).toBe(true);
      }
    }
  }, 120_000);
});

describe("a horizon's milestone route", () => {
  it("refuses a start date before writing anything, in words that blame nobody", async () => {
    const created = await http("/api/plan/horizon-create", { name: unique("Dated horizon"), date: "2027-03-01" });
    const made = (created.body.plan as Plan).horizons.find((h) => h.name.startsWith("Dated horizon"))!;
    const both = await http("/api/milestone/update", { ref: made.identifier, targetDate: "2027-04-01", startDate: "2027-02-01" });
    expect(both.status).not.toBe(200);
    const message = JSON.stringify(both.body);
    expect(message).toContain("a horizon has one date, its due date");
    expect(message).not.toMatch(/agent/i);
    expect(((await plan()).horizons.find((h) => h.id === made.id) as HorizonRow & { date: string }).date).toBe("2027-03-01");
    const dated = await http("/api/milestone/update", { ref: made.identifier, targetDate: "2027-04-01" });
    expect(dated.status, JSON.stringify(dated.body)).toBe(200);
    expect(((await plan()).horizons.find((h) => h.id === made.id) as HorizonRow & { date: string }).date).toBe("2027-04-01");
  }, 60_000);
});

describe("the horizon lifecycle on every surface", () => {
  /** A fresh horizon in `state`, made as the person. */
  async function horizon(state: HorizonState): Promise<HorizonRow> {
    const created = await http("/api/plan/horizon-create", { name: unique(`A ${state} horizon`) });
    expect(created.status).toBe(200);
    const made = (created.body.plan as Plan).horizons.find((h) => h.state === "planned" && h.name.startsWith(`A ${state} horizon`))!;
    if (state !== "planned") {
      const idea = (await fixture("shaped")).id;
      expect((await http("/api/plan/update", { ref: idea, horizon: made.id })).status).toBe(200);
      const work = await task();
      expect((await http("/api/plan/adopt", { ref: idea, issue: work })).status).toBe(200);
      if (state === "shipped") {
        // Its work landing is what closes the milestone, as for any milestone.
        await mcpCall("checkout_task", { ref: work });
        await mcpCall("update_task", { ref: work, status: "done" });
      }
    }
    const row = (await plan()).horizons.find((h) => h.id === made.id) ?? null;
    // A shipped horizon is a done milestone; only a cancelled one leaves the columns.
    expect(row?.state).toBe(state);
    return row!;
  }

  const ACTIONS: Array<{ action: HorizonAction; http: (h: HorizonRow) => [string, Record<string, unknown>]; cli: ((h: HorizonRow) => string[]) | null; mcp: ((h: HorizonRow) => [string, Record<string, unknown>]) | null }> = [
    { action: "rename", http: (h) => ["horizon-update", { ref: h.id, name: unique("Renamed") }], cli: (h) => ["horizon", "set", h.identifier, "--name", unique("Renamed")], mcp: null },
    { action: "date", http: (h) => ["horizon-update", { ref: h.id, date: "2027-09-30" }], cli: (h) => ["horizon", "set", h.identifier, "--date", "2027-09-30"], mcp: (h) => ["update_milestone", { ref: h.identifier, target_date: "2027-09-30" }] },
    { action: "reorder", http: (h) => ["horizon-update", { ref: h.id, before: null }], cli: (h) => ["horizon", "mv", h.identifier, "--end"], mcp: null },
    { action: "remove", http: (h) => ["horizon-remove", { ref: h.id }], cli: (h) => ["horizon", "rm", h.identifier], mcp: null },
    { action: "queue", http: (h) => ["horizon-queue", { ref: h.id }], cli: (h) => ["queue", "add", h.identifier], mcp: (h) => ["enqueue_task", { ref: h.identifier }] },
  ];

  it("carries exactly the table's actions for each state", async () => {
    for (const state of HORIZON_STATES) {
      const row = await horizon(state);
      expect(row.actions.map((action) => action.id), state).toEqual([...HORIZON_LIFECYCLE[state]]);
    }
  }, 60_000);

  it("holds every (state, action) cell to the table on HTTP, MCP and the CLI", async () => {
    const failures: string[] = [];
    for (const state of HORIZON_STATES) {
      for (const entry of ACTIONS) {
        const runs: Array<{ name: string; agent: boolean; go: (h: HorizonRow) => Promise<{ ok: boolean; message: string }> }> = [
          { name: "http", agent: false, go: async (h) => {
            const [verb, body] = entry.http(h);
            const result = await http(`/api/plan/${verb}`, body);
            return { ok: result.status === 200, message: JSON.stringify(result.body) };
          } },
        ];
        if (entry.cli) {
          const args = entry.cli;
          // The queue's own command carries no --person: queueing is anyone's.
          const person = entry.action !== "queue";
          runs.push({ name: person ? "cli --person" : "cli", agent: !person, go: async (h) => {
            const result = await cli(person, ...args(h));
            return { ok: result.status === 0, message: result.stderr };
          } });
        }
        if (entry.mcp) {
          const call = entry.mcp;
          runs.push({ name: "mcp", agent: true, go: async (h) => {
            const [tool, args] = call(h);
            const result = await mcpCall(tool, args);
            return { ok: !result.isError, message: JSON.stringify(result.content) };
          } });
        }
        for (const run of runs) {
          const row = await horizon(state);
          const result = await run.go(row);
          const offered = horizonOffers(state, entry.action);
          const personOnly = HORIZON_ACTIONS[entry.action].who === "person";
          const want: Outcome = run.agent && personOnly ? "person" : offered ? "ok" : "lifecycle";
          const got = outcomeOf(result.ok, result.message, state);
          if (got !== want) failures.push(`horizon ${state} × ${entry.action} on ${run.name}: expected ${want}, got ${got}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
