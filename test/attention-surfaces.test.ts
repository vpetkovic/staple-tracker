/**
 * The attention list on every surface: `staple attention`, the `attention` MCP tool and the
 * web view's `/api/attention` answer the same rows, in the same order, in hub mode across
 * every workspace and for one workspace; and a dismissal from the page takes a row off all
 * three.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hub } from "../src/core/hub.js";
import { resolveWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, type McpHarness } from "./fixtures/contract-support.js";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;
const refs: Record<string, string> = {};

async function cli(...args: string[]) {
  return await runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}
async function cliJson(...args: string[]): Promise<any> {
  const result = await cli(...args, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
async function http(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-staple-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function tool(args: Record<string, unknown>): Promise<any> {
  const result = await mcp.call("attention", args);
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent;
}
/** A row without its age, which each read stamps against its own clock. */
const stable = (list: { rows: Array<Record<string, unknown>> }) => list.rows.map(({ ageSeconds: _age, ...row }) => row);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-attention-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-attention-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await cli("init", "--global", "app")).status).toBe(0);
  expect((await cli("init", "--global", "web")).status).toBe(0);
  expect((await cli("init", "--global", "quiet")).status).toBe(0);

  const app = resolveWorkspace({ ws: "app" }).store;
  const web = resolveWorkspace({ ws: "web" }).store;
  try {
    const gate = app.createIssue({ title: "Schema design", kind: "epic" });
    app.createIssue({ title: "Tables", parent: gate.identifier });
    app.gateIssue(gate.identifier, { owner: "VP" }, "agent-a");
    refs.gate = gate.identifier;
    refs.review = web.createIssue({ title: "Login page" }).identifier;
    web.updateIssue(refs.review, { status: "in_review" }, "agent-a");
    const blocker = app.createIssue({ title: "Publish the SDK" });
    refs.waiting = web.createIssue({ title: "Use the SDK" }).identifier;
    const hub = Hub.open();
    try {
      hub.addCrossLink(blocker.identifier, refs.waiting);
      app.updateIssue(blocker.identifier, { status: "done" }, "agent-a");
      hub.notifyResolved("app", blocker.identifier);
    } finally {
      hub.close();
    }
    // In the pickup queue and ready: never a row.
    const ready = web.createIssue({ title: "Footer" });
    web.queue().enqueue(ready.identifier, {}, "VP");
  } finally {
    app.db.close();
    web.db.close();
  }

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  await new Promise<void>((resolve) => (ui ? ui.server.close(() => resolve()) : resolve()));
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("the attention list", () => {
  it("answers the same rows on the CLI, over MCP and over HTTP, across every workspace", async () => {
    const fromCli = await cliJson("attention", "--hub");
    const fromMcp = await tool({ hub: true });
    const fromHttp = (await http("/api/attention")).body;
    expect(stable(fromCli).map((row) => [row.workspace, row.kind, row.ref])).toEqual([
      ["app", "gate_pending", refs.gate],
      ["web", "in_review", refs.review],
      ["web", "unblocked", refs.waiting],
    ]);
    expect(stable(fromMcp)).toEqual(stable(fromCli));
    expect(stable(fromHttp)).toEqual(stable(fromCli));
    expect(fromCli.workspaces).toEqual(["app", "quiet", "web"]);
  });

  it("reads one workspace on each surface when one is named", async () => {
    const fromCli = await cliJson("attention", "--ws", "web");
    expect(stable(fromCli).map((row) => row.kind)).toEqual(["in_review", "unblocked"]);
    expect(stable(await tool({ ws: "web" }))).toEqual(stable(fromCli));
    expect(stable((await http("/api/attention?ws=web")).body)).toEqual(stable(fromCli));
  });

  it("is empty for a workspace nothing waits in, in words on the CLI", async () => {
    expect((await cliJson("attention", "--ws", "quiet")).rows).toEqual([]);
    const human = await cli("attention", "--ws", "quiet");
    expect(human.stdout.trim()).toBe("Nothing is waiting on a person.");
  });

  it("prints each row with its workspace, age and one action", async () => {
    const human = await cli("attention", "--hub");
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("GATES WAITING ON APPROVAL (1)");
    expect(human.stdout).toMatch(new RegExp(`${refs.gate}\\s+app\\s+\\d+s\\s+Schema design`));
    expect(human.stdout).toContain(`Approve or request changes: staple approve ${refs.gate} --ws app`);
  });

  it("takes a dismissed row off every surface, and refuses to dismiss a gate", async () => {
    const refused = await http("/api/attention/dismiss", { ws: "app", target: refs.gate, actor: "VP" });
    // The server answers every staple refusal but not_found with 409, the envelope naming the code.
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("validation");
    const dismissed = await http("/api/attention/dismiss", { ws: "web", target: refs.waiting, actor: "VP" });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.dismissed.kind).toBe("unblocked");
    expect(stable(await cliJson("attention", "--hub")).map((row) => row.kind)).toEqual(["gate_pending", "in_review"]);
    expect(stable(await tool({ hub: true })).map((row) => row.kind)).toEqual(["gate_pending", "in_review"]);
  });

  it("refuses hub with a named workspace", async () => {
    const result = await mcp.call("attention", { hub: true, ws: "web" });
    expect(result.isError).toBe(true);
    expect((await cli("attention", "--hub", "--ws", "web")).status).not.toBe(0);
  });
});
