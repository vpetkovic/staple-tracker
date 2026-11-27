/**
 * An agent holding a ticket outside an autopilot run is reminded to checkpoint on its progress
 * writes and refused when it hands the ticket on without a current worklog, through the CLI and
 * through MCP alike. A person (not the holder) and a cancel are not held to it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveWorkspace } from "../src/core/workspace.js";
import { CONTRACT_AGENT, cliEnvelope, runCliAsync, startMcpClient, type McpHarness } from "./fixtures/contract-support.js";

let home: string;
let emptyDir: string;
let mcp: McpHarness;

async function cli(...args: string[]) {
  return await runCliAsync([...args, "--ws", "app"], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}
async function cliJson(...args: string[]): Promise<any> {
  const result = await cli(...args, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
async function claimed(title: string): Promise<string> {
  const ref = (await cliJson("new", title, "--assignee", CONTRACT_AGENT)).identifier as string;
  await cliJson("checkout", ref);
  return ref;
}
const checkpoint = (ref: string) => cliJson("checkpoint", ref, "--done", "Parsed it.", "--next", "Review.", "--files", "src/a.ts");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-worklog-handoff-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-worklog-handoff-cwd-"));
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", "app"], { STAPLE_HOME: home })).status).toBe(0);
  const previous = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = home;
  resolveWorkspace({ ws: "app" }).store.db.close();
  if (previous === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previous;
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("the CLI", () => {
  it("answers checkout and the holder's comments with the worklog to write, until it is written", async () => {
    const ref = (await cliJson("new", "Remind me", "--assignee", CONTRACT_AGENT)).identifier as string;
    const taken = await cliJson("checkout", ref);
    expect(taken.worklog).toMatchObject({ state: "missing", revision: null });
    expect((await cliJson("comment", ref, "milestone: parsed")).worklog.action).toContain(`staple checkpoint ${ref}`);
    const prose = await cli("comment", ref, "milestone: wired");
    expect(prose.stdout).toBe("commented.\n");
    expect(prose.stderr).toContain(`worklog missing: ${ref} has no worklog yet.`);
    await checkpoint(ref);
    expect((await cliJson("comment", ref, "milestone: reviewed")).worklog).toBeUndefined();
    // Somebody else's comment is not the holder's progress.
    expect((await cliJson("comment", ref, "looks good", "--author", "vp")).worklog).toBeUndefined();
  });

  it.each([
    ["status in_review", ["status", "in_review"]],
    ["done", ["done"]],
    ["block", ["block", "--owner", "vp", "--action", "decide"]],
    ["release", ["release"]],
  ])("refuses the holder's %s without a worklog, and takes it after a checkpoint", async (_name, verb) => {
    const ref = await claimed(`Hand on: ${verb[0]}`);
    const [command, ...rest] = verb;
    const refused = await cli(command!, ref, ...rest, "--json");
    expect(refused.status).toBe(2);
    expect(cliEnvelope(refused)).toMatchObject({ code: "validation", detail: { worklog: { state: "missing" } } });
    const shown = await cliJson("show", ref);
    expect(shown.issue.status).toBe("in_progress");
    await checkpoint(ref);
    await cliJson(command!, ref, ...rest);
  });

  it("lets a person close an agent's ticket, and anyone cancel", async () => {
    const closed = await claimed("Closed by a person");
    expect((await cliJson("done", closed, "--agent", "vp")).status).toBe("done");
    const cancelled = await claimed("Dropped");
    expect((await cliJson("cancel", cancelled)).status).toBe("cancelled");
  });
});

describe("MCP", () => {
  it("answers checkout, comments, documents and milestones with the worklog to write", async () => {
    const ref = (await cliJson("new", "Remind me over MCP", "--assignee", CONTRACT_AGENT)).identifier as string;
    const taken = await mcp.call("checkout_task", { ws: "app", ref });
    expect(taken.isError, JSON.stringify(taken.content)).toBeFalsy();
    expect((taken.structuredContent as any).worklog).toMatchObject({ state: "missing" });
    const comment = await mcp.call("add_comment", { ws: "app", ref, body: "milestone: parsed" });
    expect((comment.structuredContent as any).worklog.action).toContain(`staple checkpoint ${ref}`);
    const plan = await mcp.call("put_document", { ws: "app", ref, key: "plan", body: "Plan." });
    expect((plan.structuredContent as any).worklog.state).toBe("missing");
    const milestone = await mcp.call("record_attempt_event", { ws: "app", ref, event: "milestone", label: "parsed" });
    expect(milestone.isError, JSON.stringify(milestone.content)).toBeFalsy();
    expect((milestone.structuredContent as any).worklog.state).toBe("missing");
    const thin = await mcp.call("put_document", { ws: "app", ref, key: "worklog", body: "## Done\n- Parsed.\n## Next\n## Files touched\n" });
    expect((thin.structuredContent as any).worklog.state).toBe("incomplete");
    await mcp.call("checkpoint", { ws: "app", ref, done: "Parsed.", next: "Review.", filesTouched: "src/a.ts" });
    expect(((await mcp.call("add_comment", { ws: "app", ref, body: "milestone: done" })).structuredContent as any).worklog).toBeUndefined();
  });

  it("refuses update_task to in_review and release_task without a worklog, then takes them", async () => {
    const review = await claimed("Review over MCP");
    const refused = await mcp.call("update_task", { ws: "app", ref: review, status: "in_review" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("Checkpoint before you hand this on (status in_review)");
    // Other edits by the holder are not a handoff.
    expect((await mcp.call("update_task", { ws: "app", ref: review, title: "Review over MCP, renamed" })).isError).toBeFalsy();
    await mcp.call("checkpoint", { ws: "app", ref: review, done: "d", next: "n", filesTouched: "f" });
    expect((await mcp.call("update_task", { ws: "app", ref: review, status: "in_review" })).isError).toBeFalsy();

    const released = await claimed("Release over MCP");
    expect((await mcp.call("release_task", { ws: "app", ref: released })).isError).toBe(true);
    await mcp.call("checkpoint", { ws: "app", ref: released, done: "d", next: "n", filesTouched: "f" });
    expect((await mcp.call("release_task", { ws: "app", ref: released })).isError).toBeFalsy();
  });
});
