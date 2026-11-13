/**
 * The shaped gate and Scaffold on every surface (design/plan.md, "Scaffold"): the page (HTTP, as
 * the person), the CLI with --person, and an agent over MCP refuse shaping a plan the gate does
 * not pass, naming what is missing; the three previews of one idea agree; and a confirm creates
 * the tasks once, whichever surface retries.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";
import { buildBrief } from "../src/core/run-brief.js";
import type { ResolvedInstruction } from "../src/core/instructions.js";

const WS = "scaffws";
let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: "VP", ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const cli = (...args: string[]) => runCliAsync([...args, "--ws", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });

async function capture(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const made = await http("/api/plan/capture", { title, ...extra });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return (made.body.idea as { idea: { id: string } }).idea.id;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-scaffold-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-scaffold-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
  expect((await runCliAsync(["config", "set", "humanName", "VP"], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  expect((await http("/api/settings", { target: "settings", ops: [{ op: "set", key: "features.planning", value: true }] })).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("the shaped gate on every surface", () => {
  it("refuses shaping a thin plan on the page and the CLI, naming what is missing, and lets a ready one through", async () => {
    const thin = await capture("Thin plan", { maturity: "exploring" });
    const page = await http("/api/plan/update", { ref: thin, maturity: "shaped" });
    expect(page.status).toBe(409);
    expect(JSON.stringify(page.body)).toContain("cannot be marked shaped yet: it needs a goal, a task breakdown and acceptance criteria");
    const terminal = await cli("idea", "set", thin, "--maturity", "shaped", "--person");
    expect(terminal.status).not.toBe(0);
    expect(terminal.stderr).toContain("cannot be marked shaped yet");
    // An agent may write the plan; shaping stays the person's.
    expect((await mcp.call("update_idea", { ws: WS, ref: thin, plan: READY_PLAN })).isError).toBeFalsy();
    const agent = await mcp.call("update_idea", { ws: WS, ref: thin, maturity: "shaped" });
    expect(JSON.stringify(agent.content)).toContain("the person's call");
    expect((await http("/api/plan/update", { ref: thin, maturity: "shaped" })).status).toBe(200);
  });

  it("shows what shaping needs on the idea itself", async () => {
    const thin = await capture("Still thin", { maturity: "exploring", plan: { goal: "Something" } });
    const detail = toolPayload(await mcp.call("get_idea", { ws: WS, ref: thin })) as { missingForShaped: string[]; idea: { actions: Array<{ id: string; disabledReason?: string }> } };
    expect(detail.missingForShaped).toEqual(["a task breakdown", "acceptance criteria"]);
    expect(detail.idea.actions.find((action) => action.id === "shape")?.disabledReason).toContain("a task breakdown and acceptance criteria");
  });
});

describe("Scaffold on every surface", () => {
  const PLAN = {
    goal: "Two tasks.",
    acceptance: ["Both done"],
    breakdown: [
      { key: "1", title: "First", estimate: "2h", dependsOn: [], acceptance: "First done", owner: null, notes: null },
      { key: "2", title: "Second", estimate: "1h", dependsOn: ["1"], acceptance: "Second done", owner: null, notes: null },
    ],
  };

  it("previews the same on the page, the CLI and MCP, writes nothing, and creates once on confirm", async () => {
    const id = await capture("Scaffold me", { maturity: "shaped", plan: PLAN });
    const page = (await http("/api/plan/scaffold", { ref: id, preview: true })).body.scaffold;
    const terminal = JSON.parse((await cli("idea", "scaffold", id, "--preview", "--json")).stdout) as unknown;
    const agent = (toolPayload(await mcp.call("scaffold_idea", { ws: WS, ref: id })) as { preview: boolean; scaffold: unknown }).scaffold;
    expect(terminal).toEqual(page);
    expect(agent).toEqual(page);
    expect((await mcp.call("get_idea", { ws: WS, ref: id })).isError).toBeFalsy();
    const before = toolPayload(await mcp.call("list_tasks", { ws: WS })) as { items: unknown[] };

    const fingerprint = (agent as { fingerprint: string }).fingerprint;
    const confirmed = toolPayload(await mcp.call("scaffold_idea", { ws: WS, ref: id, confirm: true, fingerprint })) as { scaffold: { tasks: Array<{ existing: string }>; epic: { identifier: string } } };
    expect(confirmed.scaffold.epic.identifier).toMatch(/^[A-Z]+-\d+$/);
    const numbers = confirmed.scaffold.tasks.map((task) => task.existing);
    expect(numbers.every((n) => /^[A-Z]+-\d+$/.test(n))).toBe(true);
    // A retry from another surface creates nothing.
    const again = JSON.parse((await cli("idea", "scaffold", id, "--json")).stdout) as { fingerprint: string };
    const retried = JSON.parse((await cli("idea", "scaffold", id, "--confirm", again.fingerprint, "--json")).stdout) as { tasks: Array<{ existing: string }> };
    expect(retried.tasks.map((task) => task.existing)).toEqual(numbers);
    const after = toolPayload(await mcp.call("list_tasks", { ws: WS })) as { items: unknown[] };
    expect(after.items.length - before.items.length).toBe(3);
    const second = toolPayload(await mcp.call("get_task", { ws: WS, ref: numbers[1] })) as { blockedBy: Array<{ identifier: string }>; documents: Array<{ key: string }> };
    expect(second.blockedBy.map((b) => b.identifier)).toEqual([numbers[0]]);
    expect(second.documents.map((d) => d.key)).toContain("context");
  });

  it("imports a plan file from the CLI, saying what it read", async () => {
    const file = join(emptyDir, "PLAN-7-checkout.md");
    writeFileSync(file, "# PLAN-7 — Checkout\n\n## Goal\n\nShip it.\n\n## Task breakdown\n\n| # | Task | Est. |\n|---|---|---|\n| 7.1 | Spike | 3h |\n\n## Acceptance criteria\n\n- Works\n");
    const result = await cli("idea", "import", file);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^imported PLAN-7 — Checkout \(idea [0-9a-f-]{36}\): 1 task, 4\/10 sections/);
  });
});

describe("the scaffold confirm on every surface", () => {
  const PLAN = {
    goal: "Two tasks.",
    acceptance: ["Both done"],
    breakdown: [
      { key: "1", title: "First", estimate: "2h", dependsOn: [], acceptance: "First done", owner: null, notes: null },
      { key: "2", title: "Second", estimate: "1h", dependsOn: ["1"], acceptance: "Second done", owner: null, notes: null },
    ],
  };
  const tasksOf = async (id: string) => ((toolPayload(await mcp.call("list_tasks", { ws: WS })) as { items: Array<{ parentId?: string; parent?: unknown }> }).items ?? []).length;

  it("refuses a confirm without a preview's fingerprint on the page, MCP and the CLI, creating nothing", async () => {
    const id = await capture("No preview", { maturity: "shaped", plan: PLAN });
    const before = await tasksOf(id);
    const page = await http("/api/plan/scaffold", { ref: id });
    expect(page.status).not.toBe(200);
    expect(JSON.stringify(page.body)).toContain("Preview");
    const agent = await mcp.call("scaffold_idea", { ws: WS, ref: id, confirm: true });
    expect(agent.isError).toBe(true);
    expect(JSON.stringify(agent.content)).toContain("Preview");
    // On the CLI, no --confirm is the preview itself: it writes nothing and prints how to confirm.
    const terminal = await cli("idea", "scaffold", id);
    expect(terminal.status, terminal.stderr).toBe(0);
    expect(terminal.stdout).toMatch(/confirm with: staple idea scaffold \S+ --confirm [0-9a-f]{16}/);
    expect(await tasksOf(id)).toBe(before);
  });

  it("refuses a confirm whose plan changed since the preview on every surface", async () => {
    const id = await capture("Stale preview", { maturity: "shaped", plan: PLAN });
    const preview = toolPayload(await mcp.call("scaffold_idea", { ws: WS, ref: id })) as { scaffold: { fingerprint: string } };
    expect((await mcp.call("update_idea", { ws: WS, ref: id, plan: { breakdown: [{ key: "9", title: "Delete prod data", acceptance: "gone" }] } })).isError).toBeFalsy();
    const fingerprint = preview.scaffold.fingerprint;
    const agent = await mcp.call("scaffold_idea", { ws: WS, ref: id, confirm: true, fingerprint });
    expect(JSON.stringify(agent.content)).toContain("the plan changed since the preview");
    const page = await http("/api/plan/scaffold", { ref: id, fingerprint });
    expect(JSON.stringify(page.body)).toContain("the plan changed since the preview");
    const terminal = await cli("idea", "scaffold", id, "--confirm", fingerprint);
    expect(terminal.status).not.toBe(0);
    expect(terminal.stderr).toContain("the plan changed since the preview");
  });

  it("refuses a preview for a raw idea, as its confirm is refused", async () => {
    const raw = await capture("Raw, no scaffold", { plan: PLAN });
    const agent = await mcp.call("scaffold_idea", { ws: WS, ref: raw });
    expect(agent.isError).toBe(true);
    expect(JSON.stringify(agent.content)).toContain("is raw; it cannot be scaffolded");
    expect((await http("/api/plan/scaffold", { ref: raw, preview: true })).status).not.toBe(200);
  });
});

describe("plan writes are checked whole on every surface", () => {
  it("refuses a malformed plan on the page, leaving the shaped idea's breakdown as it was", async () => {
    const id = await capture("Malformed", { maturity: "shaped", plan: READY_PLAN });
    const write = await http("/api/plan/update", { ref: id, plan: { breakdown: "oops", acceptance: "one criterion" } });
    expect(write.status).not.toBe(200);
    expect(JSON.stringify(write.body)).toContain("plan.acceptance must be a list of text");
    const detail = toolPayload(await mcp.call("get_idea", { ws: WS, ref: id })) as { plan: { breakdown: unknown[]; acceptance: string[] } };
    expect(detail.plan.breakdown).toHaveLength(1);
    expect(detail.plan.acceptance).toEqual(READY_PLAN.acceptance);
  });

  it("refuses a raw document write to the breakdown over MCP, and shows a hollowed shaped plan as incomplete to the agent", async () => {
    const id = await capture("Raw doc", { maturity: "shaped", plan: READY_PLAN });
    const put = await mcp.call("put_document", { ws: WS, ref: id, key: "breakdown", body: "| 1 | not json |" });
    expect(put.isError).toBe(true);
    expect(JSON.stringify(put.content)).toContain("structured rows, not a document");
    expect((await mcp.call("update_idea", { ws: WS, ref: id, plan: { goal: null }, add_question: "Is this even right?" })).isError).toBeFalsy();
    const detail = toolPayload(await mcp.call("get_idea", { ws: WS, ref: id })) as { idea: { state: string; planIncomplete: string[]; actions: Array<{ id: string; disabledReason?: string }> } };
    expect(detail.idea.state).toBe("shaped");
    expect(detail.idea.planIncomplete).toEqual(["a goal", "1 open question answered or deferred"]);
    expect(detail.idea.actions.find((action) => action.id === "scaffold")?.disabledReason).toContain("Plan incomplete");
  });

  it("refuses a CLI import into shaped while the file holds an open question, and creates nothing", async () => {
    const file = join(emptyDir, "q.md");
    writeFileSync(file, "# Q plan\n\n## Goal\n\ng\n\n## Task breakdown\n\n| # | Task | Done when |\n|---|---|---|\n| 1.1 | Do | done |\n\n## Acceptance criteria\n\n- ok\n\n## Open questions\n\n- Who pays?\n");
    const before = ((toolPayload(await mcp.call("list_ideas", { ws: WS })) as { ideas: unknown[] }).ideas ?? []).length;
    const person = await cli("idea", "import", file, "--maturity", "shaped", "--person");
    expect(person.status).not.toBe(0);
    expect(person.stderr).toContain("1 open question answered or deferred");
    expect(((toolPayload(await mcp.call("list_ideas", { ws: WS })) as { ideas: unknown[] }).ideas ?? []).length).toBe(before);
  });
});

describe("the page confirms what it previewed", () => {
  it("creates the epic and its tasks over HTTP with the preview's fingerprint", async () => {
    const id = await capture("Page confirm", { maturity: "shaped", plan: READY_PLAN });
    const preview = (await http("/api/plan/scaffold", { ref: id, preview: true })).body.scaffold as { fingerprint: string };
    const confirmed = await http("/api/plan/scaffold", { ref: id, fingerprint: preview.fingerprint });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const made = confirmed.body.scaffold as { epic: { identifier: string }; tasks: Array<{ existing: string | null }> };
    expect(made.epic.identifier).toMatch(/^[A-Z]+-\d+$/);
    expect(made.tasks.every((task) => task.existing !== null)).toBe(true);
  });
});

describe("the task list reads each row's horizon", () => {
  it("gives every row of a scaffolded epic the epic's horizon, and a row on none nothing", async () => {
    const plan = (await http("/api/plan")).body as { plan?: { horizons: Array<{ id: string; name: string; identifier: string }> }; horizons?: Array<{ id: string; name: string; identifier: string }> };
    const horizons = plan.horizons ?? plan.plan!.horizons;
    const now = horizons.find((h) => h.name === "Now")!;
    const id = await capture("Rows on Now", { maturity: "shaped", plan: READY_PLAN, horizon: now.id });
    const preview = (await http("/api/plan/scaffold", { ref: id, preview: true })).body.scaffold as { fingerprint: string };
    const done = await http("/api/plan/scaffold", { ref: id, fingerprint: preview.fingerprint });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const loose = (await mcp.call("create_task", { ws: WS, title: "On no horizon" })) as unknown;
    expect(loose).toBeTruthy();
    const response = await fetch(`${origin}/api/issues?ws=${WS}`, { headers: { "x-staple-token": token } });
    const rows = (await response.json()) as Array<{ issue: { id: string; title: string; parentId: string | null }; horizon: { identifier: string; name: string } | null }>;
    const epic = rows.find((row) => row.issue.id === id)!;
    const tasks = rows.filter((row) => row.issue.parentId === id);
    expect(epic.horizon).toMatchObject({ identifier: now.identifier, name: "Now" });
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) expect(task.horizon?.identifier).toBe(now.identifier);
    expect(rows.find((row) => row.issue.title === "On no horizon")!.horizon).toBeNull();
  });

  it("leaves the horizons themselves out of the rows, empty ones included, and keeps a plain milestone", async () => {
    expect((await mcp.call("create_milestone", { ws: WS, title: "A plain milestone" })).isError).toBeFalsy();
    const response = await fetch(`${origin}/api/issues?ws=${WS}`, { headers: { "x-staple-token": token } });
    const rows = (await response.json()) as Array<{ issue: { identifier: string; title: string; kind: string } }>;
    const plan = (await http("/api/plan")).body as { horizons?: Array<{ identifier: string }>; plan?: { horizons: Array<{ identifier: string }> } };
    const horizons = new Set((plan.horizons ?? plan.plan!.horizons).map((h) => h.identifier));
    expect(horizons.size).toBeGreaterThan(0);
    expect(rows.filter((row) => horizons.has(row.issue.identifier))).toEqual([]);
    expect(rows.some((row) => row.issue.title === "A plain milestone" && row.issue.kind === "milestone")).toBe(true);
  });
});

describe("a horizon's run setting on every surface", () => {
  it("is set by the person on the page and the CLI, read by an agent with every ticket of the horizon, and honoured by a goal run", async () => {
    const plan = (await http("/api/plan")).body as { horizons?: Array<{ id: string; name: string; identifier: string }>; plan?: { horizons: Array<{ id: string; name: string; identifier: string }> } };
    const next = (plan.horizons ?? plan.plan!.horizons).find((h) => h.name === "Next")!;
    const id = await capture("Work on Next", { maturity: "shaped", plan: READY_PLAN, horizon: next.id });
    const preview = (await http("/api/plan/scaffold", { ref: id, preview: true })).body.scaffold as { fingerprint: string };
    expect((await http("/api/plan/scaffold", { ref: id, fingerprint: preview.fingerprint })).status).toBe(200);
    const page = await http("/api/plan/horizon-run", { ref: next.id, mode: "work", goal: ["Every Next ticket landed"] });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    // An agent reads it with each ticket it takes.
    const rows = (await (await fetch(`${origin}/api/issues?ws=${WS}`, { headers: { "x-staple-token": token } })).json()) as Array<{ issue: { identifier: string; parentId: string | null } }>;
    const child = rows.find((row) => row.issue.parentId === id)!.issue.identifier;
    const ticket = toolPayload(await mcp.call("get_task", { ws: WS, ref: child })) as { instructions: Array<{ key: string; body: string }> };
    const run = ticket.instructions.find((entry) => entry.key === "horizon-run")!;
    expect(run.body).toContain("Until its work is done");
    expect(run.body).toContain("Every Next ticket landed");
    const queued = await http("/api/plan/horizon-queue", { ref: next.id });
    expect(queued.status).toBe(200);
    const nextCli = JSON.parse((await cli("queue", "next", "--scope", next.identifier, "--json")).stdout) as { next: { identifier: string }; instructions: ResolvedInstruction[] };
    const nextMcp = toolPayload(await mcp.call("next_task", { ws: WS, scope: next.identifier })) as { next: { identifier: string }; instructions: ResolvedInstruction[] };
    expect(nextMcp.next.identifier).toBe(child);
    expect(nextMcp.instructions).toEqual(nextCli.instructions);
    expect(nextMcp.instructions.find((entry) => entry.key === "horizon-run")?.body).toBe(run.body);
    const forAgents = await http(`/api/agent-context?ws=${WS}&ref=${child}`);
    expect((forAgents.body.instructions as ResolvedInstruction[]).find((entry) => entry.key === "horizon-run")?.body).toBe(run.body);
    // A goal run over it is refused, as the setting says; set to goal, it is allowed.
    const refusedRun = await mcp.call("start_run", { ws: WS, scope: next.identifier });
    expect(refusedRun.isError).toBe(true);
    expect(JSON.stringify(refusedRun.content)).toContain("until its work is done");
    // The CLI sets it only as the person.
    expect((await cli("horizon", "set", next.identifier, "--run", "goal")).status).not.toBe(0);
    const person = await cli("horizon", "set", next.identifier, "--run", "goal", "--goal", "Every Next ticket landed", "--person");
    expect(person.status, person.stderr).toBe(0);
    expect(person.stdout).toContain("runs goal · 1 goal criterion");
    const started = toolPayload(await mcp.call("start_run", { ws: WS, scope: next.identifier })) as { id: string };
    const take = toolPayload(await mcp.call("continue_run", { ws: WS, run: started.id })) as { action: string; ref: string; instructions: ResolvedInstruction[] };
    expect(take.action).toBe("take");
    const setting = take.instructions.find((entry) => entry.key === "horizon-run")!;
    expect(setting.body).toContain("Until its goal is met");
    expect(setting.body).toContain("Every Next ticket landed");
    const brief = buildBrief({ ref: take.ref, title: "Work", workspace: "/scratch", db: "/scratch/fixture.db", runId: started.id, actor: CONTRACT_AGENT, finish: "in_review", instructions: null, ticketInstructions: take.instructions });
    expect(brief).toContain(setting.body);
    expect((await mcp.call("stop_run", { ws: WS, run: started.id })).isError).toBeFalsy();
  });
});
