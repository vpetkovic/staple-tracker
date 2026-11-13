/**
 * Plan steps on every surface (design/plan.md, "Plan steps"): the CLI, the MCP tools and the
 * page's HTTP routes read one derivation, so a record's `nextStep` and a horizon's `planSteps`
 * read the same wherever they arrive, and a pickup answer carries the horizon's steps beside its
 * ticket. With planning off none of it appears: each surface answers byte for byte what it
 * answered before, whatever the plan underneath says.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlanStep } from "../src/core/plan-steps.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type CliResult, type McpHarness } from "./fixtures/contract-support.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const WS = "stepws";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;
let horizon: { id: string; identifier: string };
let ticket: string;
let ideas: { checkout: string; search: string; audit: string };

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

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-steps-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-steps-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await cli("init", "--global", WS)).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;

  // Now holds a ticket placed by hand, an idea with a question for the person, one to scaffold and one waiting.
  await planning(true);
  const now = ((await http(`/api/plan?ws=${WS}`)).body as unknown as { horizons: Array<{ id: string; identifier: string }> }).horizons[0]!;
  horizon = now;
  ticket = ((await cliJson("new", "Ledger")) as { identifier: string }).identifier;
  await cliJson("milestone", "add", now.identifier, ticket);
  const checkout = captured(await http("/api/plan/capture", { title: "Checkout API", maturity: "exploring", horizon: now.id }));
  expect((await cli("idea", "ask", checkout, "Which payment provider?", "--ws", WS)).status).toBe(0);
  const search = captured(await http("/api/plan/capture", { title: "Invoice search", maturity: "shaped", plan: READY_PLAN, horizon: now.id }));
  const audit = captured(await http("/api/plan/capture", { title: "Audit trail", maturity: "shaped", plan: READY_PLAN, horizon: now.id, plannedStart: "2099-01-05" }));
  ideas = { checkout, search, audit };
}, 90_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

const order = () => [
  [ideas.checkout, "answer_questions", "person"],
  [ideas.search, "scaffold", "agent"],
  [ideas.audit, "wait", "nobody"],
];
const needs = (steps: unknown) => (steps as PlanStep[]).map((step) => [step.ideaId, step.need, step.who]);

describe("plan steps on every surface, planning on", () => {
  it("a horizon's planSteps read the same on list_horizons, horizon ls, get_milestone, milestone show, /api/plan and /api/issue", async () => {
    const find = (list: unknown) => (list as Array<{ id: string; planSteps: PlanStep[] }>).find((h) => h.id === horizon.id)!.planSteps;
    const fromMcp = find(await tool("list_horizons"));
    expect(needs(fromMcp)).toEqual(order());
    expect(fromMcp[0]).toMatchObject({ questions: ["Which payment provider?"], parentId: null, horizonId: horizon.id });
    expect(fromMcp[2]).toMatchObject({ waitingOn: { start: "2099-01-05" } });
    const surfaces = [
      find(await cliJson("horizon", "ls")),
      ((await cliJson("milestone", "show", horizon.identifier)) as { planSteps: PlanStep[] }).planSteps,
      (await tool("get_milestone", { ref: horizon.identifier })).planSteps,
      find(((await http(`/api/plan?ws=${WS}`)).body as { horizons: unknown }).horizons),
      ((await http(`/api/issue?ws=${WS}&ref=${horizon.identifier}`)).body as { horizonPlan: { horizon: { planSteps: PlanStep[] } } }).horizonPlan.horizon.planSteps,
    ];
    for (const steps of surfaces) expect(steps).toEqual(fromMcp);
    expect((await cli("milestone", "show", horizon.identifier, "--ws", WS)).stdout).toMatch(/plan steps\n {2}answer_questions +person +Checkout API\n {2}scaffold +agent +Invoice search\n {2}wait +nobody +Audit trail/);
  });

  it("a record's nextStep reads the same on get_idea, list_ideas, idea show and /api/plan", async () => {
    const step = ((await tool("get_idea", { ref: ideas.search })) as { idea: { nextStep: PlanStep } }).idea.nextStep;
    expect(step).toMatchObject({ need: "scaffold", who: "agent", title: "Invoice search" });
    const listed = ((await tool("list_ideas")) as { ideas: Array<{ id: string; nextStep: PlanStep | null }> }).ideas.find((idea) => idea.id === ideas.search)!.nextStep;
    const shown = ((await cliJson("idea", "show", ideas.search)) as { idea: { nextStep: PlanStep } }).idea.nextStep;
    const page = ((await http(`/api/plan?ws=${WS}`)).body as { ideas: Array<{ id: string; nextStep: PlanStep }> }).ideas.find((idea) => idea.id === ideas.search)!.nextStep;
    for (const other of [listed, shown, page]) expect(other).toEqual(step);
    expect((await cli("idea", "show", ideas.search, "--ws", WS)).stdout).toContain("step     scaffold · agent: Its turn has come.");
  });

  it("queue next and next_task carry the steps beside the ticket, scoped and unscoped, and the horizon-plan instruction with it", async () => {
    const scopedCli = (await cliJson("queue", "next", "--scope", horizon.identifier)) as { next: { identifier: string }; planSteps: PlanStep[]; instructions: Array<{ key: string }> };
    const scopedMcp = (await tool("next_task", { scope: horizon.identifier })) as typeof scopedCli;
    expect(scopedCli.next.identifier).toBe(ticket);
    expect(needs(scopedCli.planSteps)).toEqual(order());
    expect(scopedMcp).toEqual(scopedCli);
    expect(scopedCli.instructions.map((entry) => entry.key)).toContain("horizon-plan");
    const unscopedCli = (await cliJson("queue", "next")) as typeof scopedCli;
    const unscopedMcp = (await tool("next_task")) as typeof scopedCli;
    expect(unscopedCli.next.identifier).toBe(ticket);
    expect(needs(unscopedCli.planSteps)).toEqual(order());
    expect(unscopedMcp).toEqual(unscopedCli);
  });

  it("with no ticket left, next is null and the steps remain", async () => {
    await cliJson("checkout", ticket);
    await cliJson("done", ticket, "-m", "landed");
    const answer = (await cliJson("queue", "next", "--scope", horizon.identifier)) as { next: null; planSteps: PlanStep[] };
    expect(answer.next).toBeNull();
    expect(needs(answer.planSteps)).toEqual(order());
    expect(await tool("next_task", { scope: horizon.identifier })).toEqual(answer);
    // The horizon keeps reading planned with nothing to queue: its steps are the plan's, not tickets.
    const listed = ((await tool("list_horizons")) as unknown as Array<{ id: string; state: string; shipped: boolean; actions: Array<{ id: string }> }>).find((h) => h.id === horizon.id)!;
    expect(listed).toMatchObject({ state: "planned", shipped: false });
    expect(listed.actions.map((action) => action.id)).not.toContain("queue");
  });
});

describe("planning off", () => {
  /** Every surface a step or the horizon-plan instruction could reach, as each answers. */
  const answers = async () => ({
    queueNextScoped: (await cli("queue", "next", "--scope", horizon.identifier, "--ws", WS, "--json")).stdout,
    queueNext: (await cli("queue", "next", "--ws", WS, "--json")).stdout,
    nextTaskScoped: JSON.stringify(await tool("next_task", { scope: horizon.identifier })),
    nextTask: JSON.stringify(await tool("next_task")),
    milestoneShow: (await cli("milestone", "show", horizon.identifier, "--ws", WS, "--json")).stdout,
    milestoneText: (await cli("milestone", "show", horizon.identifier, "--ws", WS)).stdout,
    getMilestone: JSON.stringify(await tool("get_milestone", { ref: horizon.identifier })),
    horizonTask: JSON.stringify((await tool("get_task", { ref: horizon.identifier })).instructions),
    horizonIssue: JSON.stringify(((await http(`/api/issue?ws=${WS}&ref=${horizon.identifier}`)).body as { instructions: unknown }).instructions),
    ticketTask: JSON.stringify((await tool("get_task", { ref: ticket })).instructions),
  });

  it("answers every surface byte for byte whatever the steps underneath say, with no step, field or instruction in it", async () => {
    // A second ticket keeps something eligible, so the pickup answers name one.
    const other = ((await cliJson("new", "Refund webhook")) as { identifier: string }).identifier;
    await cliJson("milestone", "add", horizon.identifier, other);
    await planning(false);
    const before = await answers();
    // The steps change under it: the question is answered (a write the store takes with planning off) and a waiting idea's turn comes.
    await planning(true);
    expect((await cli("idea", "resolve", ideas.checkout, "1", "--ws", WS)).status).toBe(0);
    expect((await http("/api/plan/update", { ref: ideas.audit, plannedStart: "2026-01-01" })).status).toBe(200);
    const changed = ((await tool("list_horizons")) as unknown as Array<{ id: string; planSteps: PlanStep[] }>).find((h) => h.id === horizon.id)!.planSteps;
    expect(needs(changed)).not.toEqual(order());
    await planning(false);
    const after = await answers();
    for (const [surface, text] of Object.entries(after)) {
      expect(text, surface).toBe(before[surface as keyof typeof before]);
      for (const word of ["planSteps", "nextStep", "horizon-plan", "planning_needed"]) expect(text, `${surface} ${word}`).not.toContain(word);
    }
    // The plan surfaces themselves refuse with planning off, as before.
    expect((await cli("horizon", "ls", "--ws", WS, "--json")).status).not.toBe(0);
    expect((await mcp.call("list_horizons", { ws: WS })).isError).toBe(true);
    expect((await http(`/api/plan?ws=${WS}`)).status).not.toBe(200);
  });
});
