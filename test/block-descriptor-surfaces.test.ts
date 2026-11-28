/**
 * The unblock descriptor through MCP `update_task`, the agent's door to it. The store owns the
 * rule (`store.test.ts`, "written whole or not at all") and `cli-settings.test.ts` owns
 * `staple block`; this pins that the MCP door refuses half a descriptor as validation and
 * writes nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACT_AGENT, mcpEnvelope, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "contract";

let home: string;
let emptyDir: string;
let mcp: McpHarness;

async function mcpCall(tool: string, input: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await mcp.call(tool, { ...input, ws: WS });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result) as Record<string, any>;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-block-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-block-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", WS], { STAPLE_HOME: home })).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("update_task and the unblock descriptor", () => {
  it.each([
    ["an owner without an action", { status: "blocked", unblock_owner: "ops" }, ["unblockAction"]],
    ["a blank owner", { unblock_owner: " ", unblock_action: "decide" }, ["unblockOwner"]],
    ["one half cleared", { unblock_action: null }, ["unblockOwner", "unblockAction"]],
  ])("refuses %s as validation and keeps the descriptor", async (label, patch, fields) => {
    const t = await mcpCall("create_task", { title: `Waits on a person: ${label}` });
    await mcpCall("update_task", { ref: t.identifier, status: "blocked", unblock_owner: "vp", unblock_action: "approve" });
    const refused = await mcp.call("update_task", { ref: t.identifier, ...patch, ws: WS });
    expect(refused.isError).toBe(true);
    expect(mcpEnvelope(refused)).toMatchObject({ code: "validation", detail: { fields } });
    const shown = await mcpCall("get_task", { ref: t.identifier });
    expect(shown.issue).toMatchObject({ status: "blocked", unblockOwner: "vp", unblockAction: "approve" });
  });

  it("sets both together and clears both together", async () => {
    const t = await mcpCall("create_task", { title: "Changes hands" });
    const set = await mcpCall("update_task", { ref: t.identifier, status: "blocked", unblock_owner: "ops", unblock_action: "grant access" });
    expect(set).toMatchObject({ unblockOwner: "ops", unblockAction: "grant access" });
    const cleared = await mcpCall("update_task", { ref: t.identifier, unblock_owner: null, unblock_action: null });
    expect(cleared).toMatchObject({ status: "blocked", unblockOwner: null, unblockAction: null });
  });
});
