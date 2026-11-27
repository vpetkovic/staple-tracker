/**
 * Converting a misfiled ticket into an idea on the CLI and MCP (design/plan.md, "Converting a
 * ticket into an idea"): both answer the same conversion, the old number names the idea on both,
 * and both refuse a claimed ticket with the same reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type CliResult, type McpHarness } from "./fixtures/contract-support.js";

const WS = "convertws";

let home: string;
let emptyDir: string;
let mcp: McpHarness;

async function cli(...args: string[]): Promise<CliResult> {
  return await runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

async function cliJson(...args: string[]): Promise<Record<string, unknown>> {
  const result = await cli(...args, "--ws", WS, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-convert-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-convert-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await cli("init", "--global", WS)).status).toBe(0);
  expect((await cli("config", "set", "humanName", "Ada Person")).status).toBe(0);
  expect((await cli("settings", "set", "features.planning", "true", "--person", "--ws", WS)).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("convert on every surface", () => {
  it("converts on the CLI and MCP, and the old number names the idea on both", async () => {
    const first = (await cliJson("new", "Brainstorm filed as work")) as { identifier: string; id: string };
    const second = (await cliJson("new", "Another misfiled one")) as { identifier: string; id: string };

    const text = await cli("idea", "convert", first.identifier, "--ws", WS);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain(`converted ${first.identifier} into the raw idea I-CON-1: Brainstorm filed as work. ${first.identifier} still names it.`);

    const viaMcp = toolPayload(await mcp.call("convert_to_idea", { ws: WS, ref: second.identifier })) as {
      converted: Array<{ from: string; to: string }>;
      idea: { idea: { id: string; number: string; maturity: string } };
    };
    expect(viaMcp.converted).toEqual([{ from: second.identifier, to: "I-CON-2", title: "Another misfiled one" }]);
    expect(viaMcp.idea.idea).toMatchObject({ id: second.id, number: "I-CON-2", maturity: "raw" });

    const shown = await cli("show", first.identifier, "--ws", WS);
    expect(shown.stdout).toContain(`I-CON-1 · was ${first.identifier} · Brainstorm filed as work`);
    const task = toolPayload(await mcp.call("get_task", { ws: WS, ref: second.identifier })) as { issue: { id: string; ticketNumber: string; kind: string } };
    expect(task.issue).toMatchObject({ id: second.id, ticketNumber: second.identifier, kind: "idea" });
  });

  it("refuses a claimed ticket on both with the same reason", async () => {
    const claimed = (await cliJson("new", "Already being worked")) as { identifier: string };
    expect((await cli("checkout", claimed.identifier, "--ws", WS)).status).toBe(0);
    const text = await cli("idea", "convert", claimed.identifier, "--ws", WS);
    expect(text.status).not.toBe(0);
    expect(text.stderr).toContain(`is checked out by ${CONTRACT_AGENT}`);
    const viaMcp = await mcp.call("convert_to_idea", { ws: WS, ref: claimed.identifier });
    expect(viaMcp.isError).toBe(true);
    expect(JSON.stringify(viaMcp.content)).toContain(`is checked out by ${CONTRACT_AGENT}`);
  });
});
