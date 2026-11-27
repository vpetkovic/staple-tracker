/**
 * Idea blockers and sub-idea readiness on every surface (design/plan.md, "Sub-ideas and
 * blockers"): `staple idea block|unblock`, update_idea's add_blockers and remove_blockers and the
 * page's `/api/plan/blocker` write the same edge and read it back alike; a shaped sub-idea under an
 * exploring parent reads `shaped · waiting on parent` and its Scaffold is refused with that reason
 * on the CLI and MCP; and a scaffolded ticket under a parent that went back to exploring is flagged
 * in `staple show`, get_task and the page's issue.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "blockws";
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

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-blockers-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-blockers-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
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

const PLAN = { goal: "G", acceptance: ["x"], breakdown: [{ key: "R1", title: "First", estimate: "2h", dependsOn: [], acceptance: "a", owner: null, notes: null }] };

type Idea = { id: string; number: string; blockedBy: string[]; heldBy: unknown; actions: Array<{ id: string; disabledReason?: string }> };
async function capture(title: string, extra: Record<string, unknown> = {}): Promise<Idea> {
  const made = await http("/api/plan/capture", { title, ...extra });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return (made.body.idea as { idea: Idea }).idea;
}

describe("blocker edges on every surface", () => {
  it("are written and read alike by the CLI, MCP and the page", async () => {
    const audit = await capture("Audit log", { maturity: "exploring" });
    const search = await capture("Search", { maturity: "exploring" });
    const target = await capture("Export", { maturity: "shaped", plan: PLAN });

    const blocked = await cli("idea", "block", target.number, audit.number);
    expect(blocked.status, blocked.stderr).toBe(0);
    expect(blocked.stdout).toContain(`  blocked by ${audit.number} Audit log (exploring)`);
    expect(blocked.stdout).toContain('shaped · waiting on blocker: blocker "Audit log" (exploring)');

    const agent = await mcp.call("update_idea", { ws: WS, ref: target.number, add_blockers: [search.number], actor: CONTRACT_AGENT });
    expect(agent.isError, JSON.stringify(agent)).toBeFalsy();
    const detail = toolPayload(agent) as { idea: Idea; blockedBy: Array<{ id: string; title: string }> };
    expect([...detail.idea.blockedBy].sort()).toEqual([audit.id, search.id].sort());
    expect(detail.blockedBy.map((entry) => entry.title).sort()).toEqual(["Audit log", "Search"]);

    const page = await http("/api/plan/blocker", { ref: target.id, blocker: audit.id, remove: true });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect((page.body.idea as { idea: Idea }).idea.blockedBy).toEqual([search.id]);

    const removed = await mcp.call("update_idea", { ws: WS, ref: target.number, remove_blockers: [search.number], actor: CONTRACT_AGENT });
    expect((toolPayload(removed) as { idea: Idea }).idea).toMatchObject({ blockedBy: [], heldBy: null });

    const back = await http("/api/plan/blocker", { ref: target.id, blocker: audit.id });
    expect((back.body.idea as { idea: Idea }).idea.blockedBy).toEqual([audit.id]);
    const json = JSON.parse((await cli("idea", "show", target.number, "--json")).stdout) as { idea: Idea; blockedBy: Array<{ id: string }> };
    expect(json.idea.blockedBy).toEqual([audit.id]);
    expect(json.blockedBy.map((entry) => entry.id)).toEqual([audit.id]);
    expect((await cli("idea", "unblock", target.number, audit.number)).status).toBe(0);

    // A refusal says why, on each surface.
    const self = await cli("idea", "block", target.number, target.number);
    expect(self.status).not.toBe(0);
    expect(self.stderr).toContain("cannot be blocked by itself");
    const loop = await mcp.call("update_idea", { ws: WS, ref: audit.number, add_blockers: [target.number], actor: CONTRACT_AGENT });
    expect(loop.isError).toBeFalsy();
    const looped = await mcp.call("update_idea", { ws: WS, ref: target.number, add_blockers: [audit.number], actor: CONTRACT_AGENT });
    expect(looped.isError).toBe(true);
    expect(JSON.stringify(looped)).toContain("already waits on it");
  });
});

describe("a shaped sub-idea under an exploring parent on every surface", () => {
  it("reads shaped · waiting on parent, and its Scaffold is refused with the reason", async () => {
    const parent = await capture("SSO", { maturity: "exploring" });
    const child = await capture("Passkeys", { maturity: "shaped", parent: parent.id, plan: PLAN });
    expect(child.actions.find((action) => action.id === "scaffold")?.disabledReason).toBe('Waiting on parent: parent "SSO" (exploring).');

    const shown = await cli("idea", "show", child.number);
    expect(shown.stdout).toContain('shaped · waiting on parent: parent "SSO" (exploring)');
    expect((await cli("idea", "ls")).stdout).toMatch(/Passkeys.*\[waiting on parent\]/);

    const preview = await cli("idea", "scaffold", child.number);
    expect(preview.stdout).toContain('held back: waiting on parent: parent "SSO" (exploring)');
    const fingerprint = (JSON.parse((await cli("idea", "scaffold", child.number, "--json")).stdout) as { fingerprint: string }).fingerprint;
    const refused = await cli("idea", "scaffold", child.number, "--confirm", fingerprint);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("cannot be scaffolded yet: it is shaped · waiting on parent");
    const agent = await mcp.call("scaffold_idea", { ws: WS, ref: child.number, confirm: true, fingerprint, actor: CONTRACT_AGENT });
    expect(agent.isError).toBe(true);
    expect(JSON.stringify(agent)).toContain("cannot be scaffolded yet: it is shaped · waiting on parent");
    const promoted = await mcp.call("start_idea", { ws: WS, ref: child.number, actor: CONTRACT_AGENT });
    expect(promoted.isError).toBe(true);
    expect(JSON.stringify(promoted)).toContain("cannot be promoted yet");

    // Scheduling it stays open, on any horizon.
    const horizons = ((await http("/api/plan")).body.horizons as Array<{ id: string; name: string }>);
    const next = horizons.find((horizon) => horizon.name === "Next")!;
    const scheduled = await http("/api/plan/update", { ref: child.id, horizon: next.id });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    expect((scheduled.body.idea as { idea: { horizonId: string; nextStep: { need: string; waitingOn: unknown } } }).idea).toMatchObject({
      horizonId: next.id,
      nextStep: { need: "wait", waitingOn: { parents: [{ id: parent.id, title: "SSO", maturity: "exploring" }] } },
    });
  });
});

describe("a scaffolded ticket under a parent that went back to exploring", () => {
  it("is flagged alike in show, get_task and the page's issue", async () => {
    const parent = await capture("Billing", { maturity: "shaped", plan: PLAN });
    const child = await capture("Invoices", { maturity: "shaped", parent: parent.id, plan: PLAN });
    const fingerprint = (JSON.parse((await cli("idea", "scaffold", child.number, "--json")).stdout) as { fingerprint: string }).fingerprint;
    const made = JSON.parse((await cli("idea", "scaffold", child.number, "--confirm", fingerprint, "--json")).stdout) as { tasks: Array<{ existing: string }> };
    const task = made.tasks[0]!.existing;
    expect((await http("/api/plan/update", { ref: parent.id, maturity: "exploring" })).status).toBe(200);

    const text = await cli("show", task);
    expect(text.stdout).toContain('flagged:    its parent idea "Billing" went back to exploring since this was scaffolded; nothing was cancelled');
    const flag = { ideaId: parent.id, ideaNumber: parent.number, identifier: null, title: "Billing", maturity: "exploring" };
    expect((JSON.parse((await cli("show", task, "--json")).stdout) as { scaffoldedFrom: { parentUnsettled: unknown } }).scaffoldedFrom.parentUnsettled).toEqual(flag);
    const agent = await mcp.call("get_task", { ws: WS, ref: task });
    expect(agent.isError, JSON.stringify(agent)).toBeFalsy();
    expect((toolPayload(agent) as { scaffoldedFrom: { parentUnsettled: unknown } }).scaffoldedFrom.parentUnsettled).toEqual(flag);
    const page = await http(`/api/issue?ws=${WS}&ref=${task}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect((page.body as { scaffoldedFrom: { parentUnsettled: unknown } }).scaffoldedFrom.parentUnsettled).toEqual(flag);
  });
});
