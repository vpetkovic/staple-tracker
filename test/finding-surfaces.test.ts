/**
 * A finding filed through each door — `staple new --found-in [--blocks]`, MCP `create_task`
 * `found_in`/`blocks`, and the HTTP create the web UI posts — and read back through the
 * others: `foundIn` on the finding, `findings` on the origin, and the scope's blocker set.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, cliEnvelope, mcpEnvelope, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "contract";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

async function cli(...args: string[]) {
  return await runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

async function cliShow(ref: string): Promise<Record<string, any>> {
  const result = await cli("show", ref, "--ws", WS, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, any>;
}

async function httpJson(input: string, init?: RequestInit) {
  const response = await fetch(`${origin}${input}`, {
    ...init,
    headers: { "content-type": "application/json", "x-staple-token": token },
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const httpAction = (payload: Record<string, unknown>) => httpJson("/api/action", { method: "POST", body: JSON.stringify(payload) });

async function mcpGet(ref: string): Promise<Record<string, any>> {
  const result = await mcp.call("get_task", { ref, ws: WS });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result) as Record<string, any>;
}

const blockers = async (ref: string) => ((await cliShow(ref)).blockedBy as Array<{ identifier: string }>).map((b) => b.identifier);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-finding-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-finding-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await cli("init", "--no-planning", "--global", WS)).status).toBe(0);
  // CON-1 the epic, CON-2 the origin under it, CON-3 a sibling that keeps the epic open.
  expect((await cli("new", "Epic", "--ws", WS)).status).toBe(0);
  expect((await cli("new", "Origin", "--parent", "CON-1", "--ws", WS)).status).toBe(0);
  expect((await cli("new", "Sibling", "--parent", "CON-1", "--ws", WS)).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
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

describe("a finding filed through one door reads the same through the others", () => {
  it("CLI: --found-in with a bare --blocks blocks the found-in ticket", async () => {
    const made = await cli("new", "CLI blocker", "--found-in", "CON-2", "--blocks", "--ws", WS, "--json");
    expect(made.status, made.stderr).toBe(0);
    expect(JSON.parse(made.stdout).identifier).toBe("CON-4");
    expect(await blockers("CON-2")).toEqual(["CON-4"]);
    expect((await mcpGet("CON-4")).foundIn).toEqual({ identifier: "CON-2", title: "Origin", status: "backlog", disposition: "blocker" });
    // Human output names both ends.
    expect((await cli("show", "CON-4", "--ws", WS)).stdout).toContain("found in:   CON-2(backlog) as a blocker");
    expect((await cli("show", "CON-2", "--ws", WS)).stdout).toContain("findings:   CON-4(backlog, blocker)");
  });

  it("CLI: --found-in alone files a follow-up, and --blocks <scope> blocks the parent", async () => {
    expect((await cli("new", "CLI follow-up", "--found-in", "CON-2", "--ws", WS)).status).toBe(0);
    expect((await cli("new", "CLI scope blocker", "--found-in", "CON-2", "--blocks", "CON-1", "--ws", WS)).status).toBe(0);
    expect(await blockers("CON-2")).toEqual(["CON-4"]);
    expect(await blockers("CON-1")).toEqual(["CON-6"]);
  });

  it("MCP: found_in and blocks", async () => {
    const created = await mcp.call("create_task", { title: "MCP blocker", found_in: "CON-2", blocks: true, ws: WS });
    expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
    expect((toolPayload(created) as Record<string, any>).identifier).toBe("CON-7");
    const followUp = await mcp.call("create_task", { title: "MCP follow-up", found_in: "CON-2", ws: WS });
    expect(followUp.isError, JSON.stringify(followUp.content)).toBeFalsy();
    expect(await blockers("CON-2")).toEqual(["CON-4", "CON-7"]);
  });

  it("HTTP: foundIn and blocks, as the web UI posts them", async () => {
    const created = await httpAction({ type: "create", title: "HTTP blocker", foundIn: "CON-2", blocks: true });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.identifier).toBe("CON-9");
    const followUp = await httpAction({ type: "create", title: "HTTP follow-up", foundIn: "CON-2" });
    expect(followUp.status).toBe(200);
    expect(await blockers("CON-2")).toEqual(["CON-4", "CON-7", "CON-9"]);
  });

  it("every door lists the origin's findings with the same dispositions", async () => {
    const want = [
      ["CON-4", "blocker"],
      ["CON-5", "follow-up"],
      ["CON-6", "blocker"],
      ["CON-7", "blocker"],
      ["CON-8", "follow-up"],
      ["CON-9", "blocker"],
      ["CON-10", "follow-up"],
    ];
    const pairs = (findings: Array<{ identifier: string; disposition: string }>) => findings.map((f) => [f.identifier, f.disposition]);
    expect(pairs((await cliShow("CON-2")).findings)).toEqual(want);
    expect(pairs((await mcpGet("CON-2")).findings)).toEqual(want);
    expect(pairs((await httpJson("/api/issue?ref=CON-2")).body.findings)).toEqual(want);
    expect((await httpJson("/api/issue?ref=CON-10")).body.foundIn).toEqual({ identifier: "CON-2", title: "Origin", status: "backlog", disposition: "follow-up" });
  });
});

describe("a bare --blocks before the title", () => {
  it("takes only a ticket identifier as its scope, so the title's first word stays the title's", async () => {
    const made = await cli("new", "--found-in", "CON-2", "--blocks", "1", "tidy", "up", "--ws", WS, "--json");
    expect(made.status, made.stderr).toBe(0);
    const issue = JSON.parse(made.stdout) as { identifier: string; title: string };
    expect(issue.title).toBe("1 tidy up");
    expect((await cliShow(issue.identifier)).foundIn.disposition).toBe("blocker");
    expect(await blockers("CON-2")).toContain(issue.identifier);
    expect(await blockers("CON-1")).not.toContain(issue.identifier);
  });
});

describe("refusals read the same wherever they arrive", () => {
  it("blocking a resolved origin names the open parent to block instead", async () => {
    const merged = await cli("new", "Merged", "--parent", "CON-1", "--ws", WS, "--json");
    const ref = (JSON.parse(merged.stdout) as { identifier: string }).identifier;
    expect((await cli("status", ref, "done", "--ws", WS)).status).toBe(0);

    const viaCli = await cli("new", "Late", "--found-in", ref, "--blocks", "--ws", WS, "--json");
    expect(viaCli.status).not.toBe(0);
    const envelope = { error: cliEnvelope(viaCli) as { code: string; message: string } };
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.message).toContain(`${ref} is done`);
    expect(envelope.error.message).toContain("--blocks CON-1");

    const viaMcp = mcpEnvelope(await mcp.call("create_task", { title: "Late", found_in: ref, blocks: true, ws: WS }));
    expect(viaMcp.message).toBe(envelope.error.message);

    const viaHttp = await httpAction({ type: "create", title: "Late", foundIn: ref, blocks: true });
    expect(viaHttp.status).toBe(409);
    expect(viaHttp.body.message).toBe(envelope.error.message);
  });

  it("a found-in ticket that does not exist is not_found", async () => {
    const viaCli = await cli("new", "Orphan", "--found-in", "CON-404", "--ws", WS, "--json");
    expect(cliEnvelope(viaCli).code).toBe("not_found");
  });
});
