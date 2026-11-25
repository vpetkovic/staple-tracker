/**
 * A ticket's branch and pull requests on every surface: `staple branch` and the `set_branch`
 * MCP tool record and answer the same thing; the web UI's poll finds the branch's pull
 * requests through a stubbed gh adapter and links them; `/api/issues` lights the row badge,
 * `/api/issue` names the branch, and a failing check reaches the attention list. Nothing
 * here calls GitHub, and nothing changes the ticket's status.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExternalItem, IntegrationAdapter } from "../src/core/integrations/contracts.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { resolveWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, type McpHarness } from "./fixtures/contract-support.js";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let ref: string;

function pr(id: number, state: string, checks: "failing" | "passing" | null = null): ExternalItem {
  return {
    ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id: String(id), kind: "pull_request" },
    key: `team/repo#${id}`, url: `https://github.com/team/repo/pull/${id}`, title: `PR ${id}`, body: null,
    status: { id: state, name: state }, fetchedAt: new Date().toISOString(),
    pullRequest: { headBranch: "feat/surfaces", headSha: "c".repeat(40), checks: checks && { state: checks, failing: checks === "failing" ? ["test"] : [], completedAt: "2026-11-25T10:00:00.000Z" } },
  };
}
const forBranches = vi.fn(async () => [pr(12, "open", "failing"), pr(11, "merged"), pr(10, "closed")]);
const adapter: IntegrationAdapter = {
  scope: { providerId: "github", host: "github.com", scopeId: "host" }, label: "GitHub", connection: { id: "work", mode: "cli" },
  validate: async () => ({ state: "ready" }), listContainers: async () => ({ items: [], nextCursor: null }),
  readContainer: async (id) => ({ id, name: "team/repo", url: "https://github.com/team/repo" }),
  searchIssues: async () => ({ items: [], nextCursor: null }), resolve: async () => null, readIssue: vi.fn(),
  pullRequests: { read: vi.fn(), forBranches, details: vi.fn() },
};
const factories = new Map([["github:cli", () => adapter]]);

/**
 * Every CLI call names the scratch workspace. The CLI runs with this checkout as its working
 * directory, and without --ws it would resolve the checkout's own workspace instead.
 */
async function cli(...args: string[]) {
  return await runCliAsync([...args, "--ws", "app"], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}
async function cliJson(...args: string[]): Promise<any> {
  const result = await cli(...args, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
async function http(path: string): Promise<any> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status).toBe(200);
  return response.json();
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-pr-surfaces-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-pr-surfaces-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", "app"], { STAPLE_HOME: home })).status).toBe(0);
  const { store } = resolveWorkspace({ ws: "app" });
  try {
    ref = store.createIssue({ title: "Surfaces" }).identifier;
    store.updateIssue(ref, { status: "in_progress", assignee: CONTRACT_AGENT }, CONTRACT_AGENT);
    const ops = new IntegrationOperations(store, { home, factories });
    await ops.execute({ action: "configure", connectionId: "work", host: "github.com", account: "ada" });
    await ops.execute({ action: "map", connectionId: "work", containerId: "42", actor: "ada" });
  } finally {
    store.db.close();
  }
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: false, ws: "app", discoveryFactories: factories });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  await new Promise<void>((resolve) => (ui ? ui.server.close(() => resolve()) : resolve()));
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("a ticket's branch and pull requests", () => {
  it("records the branch the same way on the CLI and over MCP", async () => {
    const fromCli = await cliJson("branch", ref, "feat/surfaces", "--base", "ABC1234");
    expect(fromCli).toMatchObject({ ref, changed: true, branch: { name: "feat/surfaces", base: "abc1234", source: "field", setBy: CONTRACT_AGENT }, pullRequests: [], discovery: null });
    const result = await mcp.call("set_branch", { ref, branch: "feat/surfaces", ws: "app" });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const { discovery: _none, ...cliAnswer } = fromCli;
    expect(result.structuredContent).toEqual({ ...cliAnswer, changed: false });
  });

  it("finds the branch's pull requests on the page's poll, and every surface lists them", async () => {
    await http("/api/poll");
    await vi.waitFor(async () => {
      const rows = (await http("/api/issues?ws=app")) as Array<{ issue: { identifier: string }; pullRequests?: unknown[] }>;
      expect(rows.find((row) => row.issue.identifier === ref)?.pullRequests).toHaveLength(3);
    }, { timeout: 10_000, interval: 100 });
    expect(forBranches).toHaveBeenCalledWith("42", ["feat/surfaces"], undefined);
    // The poll asks again every 1.5 s; discovery runs once per interval.
    await http("/api/poll");
    expect(forBranches).toHaveBeenCalledTimes(1);

    const rows = (await http("/api/issues?ws=app")) as Array<{ issue: { identifier: string; status: string }; pullRequests: Array<{ number: number; state: string }> }>;
    const row = rows.find((r) => r.issue.identifier === ref)!;
    expect(row.pullRequests.map((p) => [p.number, p.state])).toEqual([[12, "open"], [11, "merged"], [10, "closed"]]);
    // A merged pull request never finishes the ticket by itself.
    expect(row.issue.status).toBe("in_progress");

    const detail = await http(`/api/issue?ws=app&ref=${ref}`);
    expect(detail.branch).toMatchObject({ name: "feat/surfaces", base: "abc1234", source: "field" });

    const fromCli = await cliJson("branch", ref);
    expect(fromCli.pullRequests.map((p: { key: string; state: string }) => [p.key, p.state])).toEqual([["team/repo#12", "open"], ["team/repo#11", "merged"], ["team/repo#10", "closed"]]);
    const fromMcp = await mcp.call("set_branch", { ref, branch: "feat/surfaces", ws: "app" });
    expect((fromMcp.structuredContent as { pullRequests: unknown[] }).pullRequests).toEqual(fromCli.pullRequests);
  });

  it("puts the failing check on the attention list, on the CLI and over HTTP", async () => {
    const fromCli = await cliJson("attention");
    const rows = fromCli.rows.filter((r: { kind: string }) => r.kind === "pr_checks_failing");
    expect(rows).toEqual([expect.objectContaining({ ref, detail: "checks failing on team/repo#12: test", action: expect.objectContaining({ command: "gh pr checks https://github.com/team/repo/pull/12" }) })]);
    const fromHttp = await http("/api/attention?ws=app");
    expect(fromHttp.rows.filter((r: { kind: string }) => r.kind === "pr_checks_failing").map((r: { key: string }) => r.key)).toEqual(rows.map((r: { key: string }) => r.key));
  });

  it("prints the branch, every pull request and the Mark done hint in the terminal", async () => {
    const human = await cli("branch", ref);
    expect(human.stdout).toContain(`${ref}  branch feat/surfaces · base abc1234`);
    expect(human.stdout).toContain("open    team/repo#12  PR 12 · checks failing (test)");
    expect(human.stdout).toContain(`A pull request is merged. If the work is finished: staple done ${ref}`);
  });
});
