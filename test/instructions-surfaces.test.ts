/**
 * Instruction documents on the CLI and over MCP, driven as an agent drives them: real
 * `staple` child processes and a real MCP connection against one scratch staple home.
 *
 *   - `doc --put --instructions` and MCP `put_document instructions` flag a document.
 *   - `show --json`, `instructions --json` and `get_task` carry one list, nearest first.
 *   - checkout (CLI and `checkout_task`), `queue next` / `next_task` hand it over with the work.
 *   - `run start --instructions` and `start_run instructions` give a run its own, and the
 *     take (`run continue` / `continue_run`) carries them after the ticket's.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";
import { startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";
import { spawnAsync } from "./fixtures/spawn-async.js";

let home: string;
let mcp: McpHarness;
const WS = "instr";

async function run(agent: string, args: string[], json = true): Promise<{ status: number; stdout: string; stderr: string; json: Record<string, unknown> }> {
  const result = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args, "--ws", WS, ...(json ? ["--json"] : [])], {
    cwd: REPO_ROOT,
    env: bareEnv({ STAPLE_HOME: home, HOME: home, STAPLE_AGENT: agent }),
    encoding: "utf8",
    timeout: 30_000,
  });
  const text = result.stdout.trim();
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, json: json && text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const cli = (...args: string[]) => run("agent-cli", args);

async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await mcp.call(name, { ws: WS, ...args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result) as Record<string, unknown>;
}

type Entry = { key: string; body: string; effective: boolean; source: { kind: string; ref: string | null } };
const keys = (list: unknown): string[] => (list as Entry[]).map((entry) => `${entry.source.kind}:${entry.source.ref ?? "-"}:${entry.key}:${entry.effective ? "on" : "off"}`);

let epic = "";
let a = "";
let b = "";
let c = "";
let rulesFile = "";

beforeAll(async () => {
  home = tempDir("instruction-surfaces");
  const init = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, "init", "--global", WS], {
    cwd: REPO_ROOT,
    env: bareEnv({ STAPLE_HOME: home, HOME: home }),
    encoding: "utf8",
  });
  expect(init.status).toBe(0);
  epic = String((await cli("new", "Epic", "--kind", "epic")).json.identifier);
  a = String((await cli("new", "A", "--parent", epic)).json.identifier);
  b = String((await cli("new", "B", "--parent", epic)).json.identifier);
  c = String((await cli("new", "C", "--parent", epic)).json.identifier);
  rulesFile = join(home, "rules.md");
  writeFileSync(rulesFile, "Stack every PR on the last one.\n");
  mcp = await startMcpClient({ home, cwd: home, agent: "agent-mcp" });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  removeDir(home);
});

describe("flagging a document", () => {
  it("is doc --put --instructions on the CLI, and refused without --put", async () => {
    const put = await cli("doc", epic, "rules", "--put", rulesFile, "--instructions");
    expect(put.status, put.stderr).toBe(0);
    expect(put.json).toEqual({ key: "rules", revision: 1, instructions: true });
    const read = await cli("doc", epic, "rules");
    expect(read.json).toMatchObject({ revision: 1, instructions: true });
    const bare = await cli("doc", epic, "rules", "--instructions");
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/pass them with --put/);
    const both = await cli("doc", epic, "rules", "--put", rulesFile, "--instructions", "--no-instructions");
    expect(both.status).toBe(2);
  });

  it("is put_document instructions over MCP, and --no-instructions clears it", async () => {
    expect(await tool("put_document", { ref: a, key: "local", body: "Only A.", instructions: true })).toEqual({ key: "local", revision: 1, instructions: true });
    const off = join(home, "off.md");
    writeFileSync(off, "No longer a rule.\n");
    expect((await cli("doc", a, "local", "--put", off, "--no-instructions")).json).toEqual({ key: "local", revision: 2, instructions: false });
    expect(await tool("put_document", { ref: a, key: "local", body: "Only A, again.", instructions: true })).toMatchObject({ revision: 3, instructions: true });
  });
});

describe("reading what applies", () => {
  it("is one list on show --json, instructions --json and get_task, nearest first", async () => {
    const shown = await cli("show", a);
    const listed = await cli("instructions", a);
    const fromMcp = await tool("get_task", { ref: a });
    expect(keys(shown.json.instructions)).toEqual([`self:${a}:local:on`, `parent:${epic}:rules:on`]);
    expect(listed.json.instructions).toEqual(shown.json.instructions);
    expect(fromMcp.instructions).toEqual(shown.json.instructions);
    expect((shown.json.documents as Array<{ key: string; instructions: boolean }>).map((doc) => [doc.key, doc.instructions])).toEqual([["local", true]]);
  });

  it("prints them on the human show, under their source", async () => {
    const human = await run("agent-cli", ["show", b], false);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("instructions (follow these while you work it):");
    expect(human.stdout).toContain(`### rules (parent ${epic}, r1)`);
    expect(human.stdout).toContain("Stack every PR on the last one.");
    const none = await run("agent-cli", ["instructions", epic.replace(/\d+$/, "999")], false);
    expect(none.status).toBe(3);
  });

  it("is handed over with the work: next and checkout carry it on both surfaces", async () => {
    const nextCli = await cli("queue", "next", "--scope", epic, "--actor", "agent-cli");
    const nextMcp = await tool("next_task", { scope: epic, actor: "agent-mcp" });
    expect((nextCli.json.next as { identifier: string }).identifier).toBe(a);
    expect(keys(nextCli.json.instructions)).toEqual([`self:${a}:local:on`, `parent:${epic}:rules:on`]);
    expect(nextMcp.instructions).toEqual(nextCli.json.instructions);

    const claimedMcp = await tool("checkout_task", { ref: a });
    expect(keys(claimedMcp.instructions)).toEqual([`self:${a}:local:on`, `parent:${epic}:rules:on`]);
    const claimedCli = await cli("checkout", b);
    expect(claimedCli.status, claimedCli.stderr).toBe(0);
    expect(keys(claimedCli.json.instructions)).toEqual([`parent:${epic}:rules:on`]);
    // Hand both back so the runs below can take them.
    await tool("release_task", { ref: a });
    expect((await cli("release", b)).status).toBe(0);
  });
});

describe("a run's own instructions", () => {
  it("are given at run start and carried by every take, after the ticket's own", async () => {
    const gates = join(home, "gates.md");
    writeFileSync(gates, "Run npm test before handing on.\n");
    const shadow = join(home, "rules.txt");
    writeFileSync(shadow, "Run-level rules lose to the epic's.\n");
    const started = await run("agent-run", ["run", "start", "--scope", epic, "--instructions", gates, "--instructions", shadow]);
    expect(started.status, started.stderr).toBe(0);
    expect(started.json.instructions).toEqual([
      { key: "gates", body: "Run npm test before handing on.\n" },
      { key: "rules", body: "Run-level rules lose to the epic's.\n" },
    ]);
    const take = await run("agent-run", ["run", "continue"]);
    expect(take.json.action).toBe("take");
    expect(take.json.ref).toBe(a);
    expect(keys(take.json.instructions)).toEqual([`self:${a}:local:on`, `parent:${epic}:rules:on`, "run:-:gates:on", "run:-:rules:off"]);
    expect(take.json.instructionsChanged).toEqual([]);
    const status = await run("agent-run", ["run", "status", String(started.json.id)]);
    expect((status.json.run as { instructions: unknown[] }).instructions).toHaveLength(2);
    expect(status.json.instructionsChanged).toEqual([]);
    // show --run adds them, as the take did.
    const shown = await run("agent-run", ["show", a, "--run", String(started.json.id)]);
    expect(shown.json.instructions).toEqual(take.json.instructions);
    expect((await run("agent-run", ["run", "stop", String(started.json.id)])).status).toBe(0);
  });

  it("are start_run instructions over MCP, and continue_run's take carries them and the news", async () => {
    const started = await tool("start_run", { scope: epic, instructions: [{ key: "review", body: "A skeptic reviews it." }] });
    expect(started.instructions).toEqual([{ key: "review", body: "A skeptic reviews it." }]);
    // Edited after the run started: news to its next take.
    await tool("put_document", { ref: epic, key: "rules", body: "Stack, and say so in the PR.", actor: "vp" });
    const take = await tool("continue_run", {});
    expect(take.action).toBe("take");
    const list = take.instructions as Entry[];
    expect(list.map((entry) => `${entry.source.kind}:${entry.key}`)).toContain("run:review");
    expect(list.find((entry) => entry.key === "rules")?.body).toBe("Stack, and say so in the PR.");
    expect(take.instructionsChanged).toMatchObject([{ ref: epic, key: "rules", revision: 2, instructions: true }]);
    const withRun = await tool("get_task", { ref: String(take.ref), run_id: String((started as { id: string }).id) });
    expect(withRun.instructions).toEqual(take.instructions);
    await tool("stop_run", {});
  });
});

describe("the hand-off a stop hook gives", () => {
  it("names the instructions in effect and the command that prints them", async () => {
    // Exercised through the core with a real answer: the hook's reason is text, so the test reads text.
    const { takeReason } = await import("../src/core/run-hook.js");
    const reason = takeReason({
      answer: {
        action: "take",
        ref: c,
        issueId: "id",
        title: "C",
        why: "next",
        resumed: false,
        recorded: null,
        run: { id: "12345678-aaaa", actor: "bot", goal: null } as never,
        goal: null,
        instructions: [{ key: "rules", revision: 1, title: null, body: "x", author: null, updatedAt: null, source: { kind: "parent", ref: epic, issueId: "e", title: "Epic", runId: null }, effective: true, shadowedBy: null }],
        instructionsChanged: [],
      },
      db: "/w/db",
    });
    expect(reason).toContain(`Instructions bind this ticket: rules (parent ${epic}).`);
    expect(reason).toContain(`staple instructions ${c} --run 12345678-aaaa`);
  });
});
