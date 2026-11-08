/**
 * The plan layer on every surface (design/plan.md): the CLI, the MCP tools and the HTTP
 * routes read one plan, refuse an agent's steering with the same `validation`, and let the
 * person steer from the page (HTTP) and from the CLI with `--person`.
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

const WS = "planws";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

async function cli(...args: string[]): Promise<CliResult> {
  return await runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

async function cliJson(...args: string[]): Promise<unknown> {
  const result = await cli(...args, "--ws", WS, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  return await mcp.call(name, { ws: WS, ...args });
}

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: "VP", ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface Idea {
  id: string;
  identifier: string | null;
  promoted: boolean;
  title: string;
  maturity: string;
  stage: string;
  horizonId: string | null;
  planned: { start: string | null; target: string | null };
  baseline: { start: string | null; target: string | null } | null;
}
interface Plan {
  enabled: boolean;
  horizons: Array<{ id: string; identifier: string; name: string }>;
  ideas: Idea[];
}

const byId = (plan: Plan, id: string) => plan.ideas.find((idea) => idea.id === id)!;

/** An idea has no ticket number before it is promoted: a test names it by its id, found by title. */
const ids: Record<string, string> = {};
const ref = (title: string) => ids[title]!;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-plan-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-plan-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await cli("init", "--global", WS)).status).toBe(0);
  expect((await cli("new", "Existing epic", "--kind", "epic", "--ws", WS)).status).toBe(0);
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

describe("the plan on every surface", () => {
  it("is off until enabled, and every surface says so the same way", async () => {
    expect((await cliJson("plan", "show")) as Plan).toMatchObject({ enabled: false });
    expect(toolPayload(await mcpCall("list_ideas", {}))).toMatchObject({ enabled: false });
    expect((await http(`/api/plan?ws=${WS}`)).body).toMatchObject({ enabled: false });
    const refused = await mcpCall("capture_idea", { title: "too early" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("staple plan enable");
    expect((await cliJson("plan", "enable")) as Plan).toMatchObject({ enabled: true });
  });

  it("captures on every surface and reads the same plan three ways", async () => {
    await cliJson("idea", "new", "From the CLI");
    expect((await mcpCall("capture_idea", { title: "From MCP", brief: "why" })).isError).toBeFalsy();
    expect((await http("/api/plan/capture", { title: "From the page", maturity: "shaped", plan: READY_PLAN })).status).toBe(200);
    const fromCli = (await cliJson("plan", "show")) as Plan;
    const fromMcp = toolPayload(await mcpCall("list_ideas", {})) as Plan;
    const fromHttp = (await http(`/api/plan?ws=${WS}`)).body as unknown as Plan;
    for (const idea of fromCli.ideas) ids[idea.title] = idea.id;
    const shape = (plan: Plan) => plan.ideas.map((idea) => [idea.title, idea.identifier, idea.maturity, idea.stage]);
    expect(shape(fromCli)).toEqual([
      ["From the CLI", null, "raw", "raw"],
      ["From MCP", null, "raw", "raw"],
      ["From the page", null, "shaped", "shaped"],
    ]);
    // Captures took no ticket number: the next issue is the one after the epic and the three horizons.
    const next = (await cliJson("new", "Next ticket")) as { identifier: string };
    expect(next.identifier).toBe("PLA-5");
    // And no surface shows the draft identifier an idea is stored under.
    for (const text of [JSON.stringify(fromCli), JSON.stringify(fromMcp), JSON.stringify(fromHttp), (await cli("idea", "list", "--ws", WS)).stdout]) {
      expect(text).not.toMatch(/"?~[0-9a-f]{32}/);
    }
    expect(shape(fromMcp)).toEqual(shape(fromCli));
    expect(shape(fromHttp)).toEqual(shape(fromCli));
    // Ideas never reach a task view.
    const tasks = toolPayload(await mcpCall("list_tasks", {})) as { items: Array<{ identifier: string; title: string }> };
    expect(tasks.items.map((task) => task.identifier)).not.toContain(null);
    for (const title of ["From the CLI", "From MCP", "From the page"]) expect(tasks.items.map((task) => task.title)).not.toContain(title);
    // The shared drawer's payload for an idea: no number (null, draft), its plan, never the stored key.
    const drawer = await http(`/api/issue?ws=${WS}&ref=${ref("From the page")}`);
    expect(drawer.status).toBe(200);
    expect(JSON.stringify(drawer.body)).not.toMatch(/~[0-9a-f]{32}/);
    expect(drawer.body.issue).toMatchObject({ id: ref("From the page"), identifier: null, draft: true });
    expect(drawer.body.planRecord).toMatchObject({ idea: { id: ref("From the page"), state: "shaped", identifier: null } });
    const now = (fromCli.horizons[0] as { identifier: string; id: string });
    const horizonDrawer = await http(`/api/issue?ws=${WS}&ref=${now.identifier}`);
    expect(horizonDrawer.body.horizonPlan).toMatchObject({ horizon: { id: now.id, state: "planned" } });
  });

  it("refuses an agent's steering on the CLI and over MCP, naming why", async () => {
    for (const result of [
      await cli("idea", "set", ref("From the CLI"), "--maturity", "shaped", "--ws", WS),
      await cli("horizon", "new", "Q2", "--ws", WS),
      await cli("idea", "reset-baseline", ref("From the CLI"), "--ws", WS),
    ]) {
      expect(result.status).not.toBe(0);
      // Refused for the person rule, or first by the lifecycle (a raw idea is not scheduled or re-baselined).
      expect(result.stderr).toMatch(/the person's call|is raw; it cannot be/);
    }
    for (const args of [{ maturity: "shaped" }, { horizon: "Now" }, { planned_target: "2026-12-01" }, { parent: ref("From MCP") }]) {
      const result = await mcpCall("update_idea", { ref: ref("From the CLI"), ...args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/the person's call|is raw; it cannot be/);
    }
    const start = await mcpCall("start_idea", { ref: ref("From the CLI") });
    expect(start.isError).toBe(true);
    expect(JSON.stringify(start.content)).toContain("is raw; it cannot be promoted");
    const plan = (await cliJson("plan", "show")) as Plan;
    expect(byId(plan, ref("From the CLI"))).toMatchObject({ maturity: "raw", horizonId: null, identifier: null, planned: { start: null, target: null } });
  });

  it("holds the person rule through the plain tracker tools too", async () => {
    const plan = (await cliJson("plan", "show")) as Plan;
    const now = plan.horizons[0]!;
    for (const [tool, args, words] of [
      ["update_task", { ref: now.identifier, title: "Renamed by an agent" }, "the person's call"],
      ["update_milestone", { ref: now.identifier, target_date: "2026-12-31" }, "the person's call"],
      ["update_task", { ref: now.identifier, status: "cancelled" }, "the person's call"],
      ["update_task", { ref: ref("From the CLI"), status: "cancelled" }, "its status does not move"],
      ["set_blocked_by", { ref: "PLA-1", blockers: [ref("From the CLI")] }, "cannot be a blocker"],
    ] as const) {
      const result = await mcpCall(tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(JSON.stringify(result.content)).toContain(words);
    }
    const made = toolPayload(await mcpCall("create_task", { title: "Agent idea via create_task", kind: "idea" })) as { id: string };
    const after = (await cliJson("plan", "show")) as Plan;
    expect(byId(after, made.id)).toMatchObject({ maturity: "raw", stage: "raw", identifier: null });
    // A milestone an agent makes is an ordinary milestone, never a column.
    expect(toolPayload(await mcpCall("create_task", { title: "Autopilot milestone", kind: "milestone" }))).toMatchObject({ kind: "milestone" });
    expect(after.horizons.map((h) => h.name)).toEqual(plan.horizons.map((h) => h.name));
  });

  it("lets the agent do the capture-side edits and link work over MCP", async () => {
    const edited = toolPayload(await mcpCall("update_idea", { ref: ref("From MCP"), title: "From MCP, renamed", add_question: "Who?", add_decision: "Keep it small" })) as {
      idea: { title: string };
      questions: unknown[];
      decisions: string[];
    };
    expect(edited.idea.title).toBe("From MCP, renamed");
    expect(edited.questions).toEqual([{ text: "Who?", resolved: false }]);
    expect(edited.decisions).toHaveLength(1);
    // Linking work is a shaped idea's: a raw one refuses it, naming its state.
    const early = await mcpCall("start_idea", { ref: ref("From MCP"), adopt: "PLA-1" });
    expect(JSON.stringify(early.content)).toContain("is raw; it cannot be linked to work");
    const adopted = toolPayload(await mcpCall("start_idea", { ref: ref("From the page"), adopt: "PLA-1" })) as { idea: { idea: Idea }; promoted: null };
    expect(adopted.idea.idea).toMatchObject({ stage: "started", identifier: null, promoted: false });
    expect(adopted.promoted).toBeNull();
    const unlinked = toolPayload(await mcpCall("unlink_idea", { ref: ref("From the page"), issue: "PLA-1" })) as { idea: Idea };
    expect(unlinked.idea.stage).toBe("shaped");
  });

  it("lets the person steer from the page, and an agent promote what the person shaped", async () => {
    const plan = (await http(`/api/plan?ws=${WS}`)).body as unknown as Plan;
    const now = plan.horizons[0]!;
    const steered = await http("/api/plan/update", { ref: ref("From the page"), horizon: now.id, plannedStart: "2026-10-01", plannedTarget: "2026-11-30" });
    expect(steered.status).toBe(200);
    expect(byId(steered.body.plan as Plan, ref("From the page"))).toMatchObject({ horizonId: now.id, stage: "scheduled" });
    const started = toolPayload(await mcpCall("start_idea", { ref: ref("From the page") })) as {
      idea: { idea: Idea };
      promoted: { id: string; identifier: string; kind: string };
    };
    expect(started.idea.idea).toMatchObject({ stage: "started", promoted: true, baseline: { start: "2026-10-01", target: "2026-11-30" } });
    // Promoted in place: the same record, now an epic with the next ticket number, in its horizon's milestone.
    expect(started.promoted).toMatchObject({ id: ref("From the page"), identifier: "PLA-7", kind: "epic" });
    const epic = (await cliJson("show", started.promoted.identifier)) as { issue: { id: string; kind: string } };
    expect(epic.issue).toMatchObject({ id: ref("From the page"), kind: "epic" });
    const milestone = toolPayload(await mcpCall("get_milestone", { ref: now.identifier })) as { members: Array<{ identifier: string }> };
    expect(milestone.members.map((member) => member.identifier)).toContain("PLA-7");
    // A re-plan moves the plan and keeps the baseline; the page's reset moves the baseline.
    await http("/api/plan/update", { ref: ref("From the page"), plannedTarget: "2026-12-20" });
    const replanned = (await http(`/api/plan-idea?ws=${WS}&ref=${ref("From the page")}`)).body as unknown as { idea: Idea };
    expect(replanned.idea.planned.target).toBe("2026-12-20");
    expect(replanned.idea.baseline).toEqual({ start: "2026-10-01", target: "2026-11-30" });
    const reset = await http("/api/plan/reset-baseline", { ref: ref("From the page") });
    expect(byId(reset.body.plan as Plan, ref("From the page")).baseline).toEqual({ start: "2026-10-01", target: "2026-12-20" });
  });

  it("lets a person at the terminal steer with --person, under the configured name", async () => {
    const before = await cli("idea", "set", ref("From the CLI"), "--maturity", "exploring", "--person", "--ws", WS);
    expect(before.status).not.toBe(0);
    expect(before.stderr).toContain("humanName");
    expect((await cli("config", "set", "humanName", "VP")).status).toBe(0);
    const detail = (await cliJson("idea", "set", ref("From the CLI"), "--maturity", "exploring", "--person")) as { idea: Idea };
    expect(detail.idea.maturity).toBe("exploring");
    const horizons = (await cliJson("horizon", "new", "Q2", "--date", "2027-06-30", "--person")) as Array<{ name: string }>;
    // A dated horizon goes in date order ahead of the undated ones.
    expect(horizons.map((h) => h.name)).toEqual(["Q2", "Now", "Next", "Later"]);
  });

  it("keeps the baseline reset away from the model: the MCP tool is app-only", async () => {
    const tools = await mcp.listTools();
    const reset = tools.find((tool) => tool.name === "reset_idea_baseline") as { _meta?: { ui?: { visibility?: string[] } } } | undefined;
    expect(reset?._meta?.ui?.visibility).toEqual(["app"]);
  });
});

describe("no surface shows an unpromoted idea's draft identifier", () => {
  const DRAFT = /~[0-9a-f]{32}/;

  /** Every object in a JSON value that describes the given issue. */
  function issueObjects(value: unknown, id: string, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (Array.isArray(value)) for (const item of value) issueObjects(item, id, out);
    else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.id === id && "identifier" in record) out.push(record);
      for (const inner of Object.values(record)) issueObjects(inner, id, out);
    }
    return out;
  }

  it("walks the CLI, the MCP tools and the HTTP routes that print or serialize an issue", async () => {
    const madeText = await cli("new", "Captured through new", "--kind", "idea", "--ws", WS);
    expect(madeText.status, madeText.stderr).toBe(0);
    const made = (await cliJson("new", "Captured through new, as JSON", "--kind", "idea")) as { id: string };
    const id = made.id;
    const texts: Array<[string, string]> = [["cli new", madeText.stdout]];
    const documents: Array<[string, unknown]> = [["cli new --json", made]];

    for (const args of [["ls", "--kind", "idea"], ["show", id], ["events"], ["idea", "show", id], ["inbox"]]) {
      const label = args.filter((arg) => arg !== id).join(" ");
      const text = await cli(...args, "--ws", WS);
      expect(text.status, `${args.join(" ")}: ${text.stderr}`).toBe(0);
      texts.push([`cli ${label}`, text.stdout + text.stderr]);
      const json = await cli(...args, "--ws", WS, "--json");
      expect(json.status, `${args.join(" ")} --json: ${json.stderr}`).toBe(0);
      texts.push([`cli ${label} --json`, json.stdout]);
      for (const line of json.stdout.trim().split("\n").filter(Boolean)) documents.push([`cli ${label} --json`, JSON.parse(line)]);
    }
    // A refusal names the idea too.
    const refused = await cli("checkout", id, "--ws", WS);
    expect(refused.status).not.toBe(0);
    texts.push(["cli refusal", refused.stdout + refused.stderr]);

    for (const [name, args] of [
      ["get_task", { ref: id }],
      ["list_tasks", { kind: ["idea"] }],
      ["show_ticket", { ref: id }],
      ["events_since", { since: 0, limit: 500 }],
      ["inbox", {}],
      ["checkout_task", { ref: id }],
    ] as const) {
      const result = await mcpCall(name, args);
      texts.push([`mcp ${name}`, JSON.stringify(result)]);
      if (!result.isError) documents.push([`mcp ${name}`, (result as { structuredContent?: unknown }).structuredContent ?? toolPayload(result)]);
    }

    for (const path of [`/api/issue?ws=${WS}&ref=${id}`, `/api/issues?ws=${WS}&kind=idea`, `/api/events?ws=${WS}`, `/api/bootstrap?ws=${WS}`, `/api/graph?ws=${WS}`]) {
      const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
      const body = await response.text();
      texts.push([`http ${path}`, body]);
      if (response.ok) documents.push([`http ${path}`, JSON.parse(body)]);
    }

    for (const [where, text] of texts) expect(DRAFT.test(text), `${where} shows a draft: ${text.match(DRAFT)?.[0]}`).toBe(false);
    const described = documents.flatMap(([where, document]) => issueObjects(document, id).map((issue) => [where, issue] as const));
    expect(described.map(([where]) => where)).toEqual(expect.arrayContaining(["cli new --json", "cli show --json", "cli ls --kind idea --json", "cli idea show --json", "mcp get_task", `http /api/issue?ws=${WS}&ref=${id}`]));
    // An issue says it is a draft; the plan's own view of an idea says so as `promoted: false`.
    for (const [where, issue] of described) {
      const flag = "promoted" in issue ? { promoted: issue.promoted } : { draft: issue.draft };
      expect({ where, identifier: issue.identifier, ...flag }).toEqual({ where, identifier: null, ...("promoted" in issue ? { promoted: false } : { draft: true }) });
    }
    // The text names it by its id.
    expect(texts.find(([where]) => where === "cli show")?.[1]).toContain(id);
  });
});
