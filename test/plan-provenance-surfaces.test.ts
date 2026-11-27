/**
 * Plan provenance on every surface (design/plan.md, "Provenance"): a scaffolded ticket names its
 * idea and row the same way in `staple show` (text and JSON), MCP get_task and the page's detail;
 * `staple idea new --sparked-by` and capture_idea's sparked_by keep the ticket on the idea, and the
 * ticket lists the ideas it sparked on each surface.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "provws";
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
  home = mkdtempSync(join(tmpdir(), "staple-provenance-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-provenance-cwd-"));
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

const PLAN = {
  goal: "G",
  acceptance: ["x"],
  breakdown: [
    { key: "R1", title: "First", estimate: "2h", dependsOn: [], acceptance: "a", owner: null, notes: null },
    { key: "R2", title: "Second", estimate: "1h", dependsOn: ["R1"], acceptance: "b", owner: null, notes: null },
  ],
};

describe("a scaffolded ticket on every surface", () => {
  it("names its idea and row alike in show, get_task and the page, and in its context document", async () => {
    const made = await http("/api/plan/capture", { title: "Checkout", maturity: "shaped", plan: PLAN });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const idea = (made.body.idea as { idea: { id: string; number: string } }).idea;
    const preview = JSON.parse((await cli("idea", "scaffold", idea.id, "--json")).stdout) as { fingerprint: string };
    const scaffolded = JSON.parse((await cli("idea", "scaffold", idea.id, "--confirm", preview.fingerprint, "--json")).stdout) as { tasks: Array<{ key: string; existing: string }> };
    const second = scaffolded.tasks.find((task) => task.key === "R2")!.existing;

    const text = await cli("show", second);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain(`from ${idea.number} · row R2: Checkout`);
    const terminal = (JSON.parse((await cli("show", second, "--json")).stdout) as { scaffoldedFrom: unknown }).scaffoldedFrom;
    expect(terminal).toMatchObject({ ideaId: idea.id, ideaNumber: idea.number, title: "Checkout", rowKey: "R2" });
    const agent = await mcp.call("get_task", { ws: WS, ref: second, include_documents: true });
    expect(agent.isError, JSON.stringify(agent)).toBeFalsy();
    const payload = toolPayload(agent) as { scaffoldedFrom: unknown; documents: Array<{ key: string; body: string }> };
    expect(payload.scaffoldedFrom).toEqual(terminal);
    expect(payload.documents.find((doc) => doc.key === "context")!.body).toContain(`Scaffolded from idea ${idea.number}, breakdown row R2.`);
    const page = await http(`/api/issue?ws=${WS}&ref=${second}`);
    expect(page.body.scaffoldedFrom).toEqual(terminal);
  });
});

describe("an idea sparked by a ticket on every surface", () => {
  it("keeps the ticket on the idea from the CLI and MCP, lists both ideas on the ticket, and refuses what is not a ticket", async () => {
    const ticket = JSON.parse((await cli("new", "Report screen", "--json")).stdout) as { identifier: string };
    const fromCli = await cli("idea", "new", "Bulk export", "--sparked-by", ticket.identifier, "--json");
    expect(fromCli.status, fromCli.stderr).toBe(0);
    const cliIdea = JSON.parse(fromCli.stdout) as { idea: { id: string; number: string }; sparkedBy: unknown };
    expect(cliIdea.sparkedBy).toEqual({ identifier: ticket.identifier, title: "Report screen", status: "backlog" });
    expect((await cli("idea", "show", cliIdea.idea.id)).stdout).toContain(`sparked by ${ticket.identifier}(backlog) Report screen`);

    const fromAgent = await mcp.call("capture_idea", { ws: WS, title: "Second thought", sparked_by: ticket.identifier });
    expect(fromAgent.isError, JSON.stringify(fromAgent)).toBeFalsy();
    const agentIdea = toolPayload(fromAgent) as { idea: { id: string; number: string }; sparkedBy: { identifier: string } };
    expect(agentIdea.sparkedBy.identifier).toBe(ticket.identifier);

    const listed = (toolPayload(await mcp.call("get_task", { ws: WS, ref: ticket.identifier })) as { sparked: Array<{ ideaNumber: string }> }).sparked;
    expect(listed.map((idea) => idea.ideaNumber)).toEqual([cliIdea.idea.number, agentIdea.idea.number]);
    expect(((await http(`/api/issue?ws=${WS}&ref=${ticket.identifier}`)).body.sparked as unknown[]).length).toBe(2);
    expect((await cli("show", ticket.identifier)).stdout).toContain(`sparked:    ${cliIdea.idea.number}(raw) Bulk export, ${agentIdea.idea.number}(raw) Second thought`);
    expect((await http(`/api/issue?ws=${WS}&ref=${cliIdea.idea.id}`)).body.sparkedBy).toEqual(cliIdea.sparkedBy);

    const byIdea = await mcp.call("capture_idea", { ws: WS, title: "Nope", sparked_by: cliIdea.idea.number });
    expect(byIdea.isError).toBe(true);
    expect(JSON.stringify(byIdea)).toContain("is an idea, not a ticket");
    const onSet = await cli("idea", "set", cliIdea.idea.id, "--sparked-by", ticket.identifier);
    expect(onSet.status).not.toBe(0);
    expect(onSet.stderr).toContain("--sparked-by goes with staple idea new");
  });
});
