/**
 * A parent's subtree pull requests on every surface: `staple show` (terminal and --json), MCP
 * `get_task` and `show_ticket`, `/api/agent-context`, the detail (`/api/issue`) and the row
 * (`/api/issues`) all carry the same set, read from the one core function. A leaf keeps only
 * its own pull requests, and a parent with none shows nothing.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExternalItem } from "../src/core/integrations/contracts.js";
import { resolveWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, type McpHarness } from "./fixtures/contract-support.js";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
const refs = { epic: "", a: "", b: "", quiet: "", quietChild: "" };

function pr(id: number, state: string): ExternalItem {
  return {
    ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id: String(id), kind: "pull_request" },
    key: `team/repo#${id}`, url: `https://github.com/team/repo/pull/${id}`, title: `PR ${id}`, body: null,
    status: { id: state, name: state }, fetchedAt: "2026-11-25T12:00:00.000Z",
  };
}

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
const brief = (set: Array<{ key: string; own: boolean; tickets: Array<{ identifier: string }> }>) => set.map((p) => [p.key, p.own, p.tickets.map((t) => t.identifier)]);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-subtree-prs-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-subtree-prs-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", "app"], { STAPLE_HOME: home })).status).toBe(0);
  const { store } = resolveWorkspace({ ws: "app" });
  try {
    const epic = store.createIssue({ title: "Epic", kind: "epic" });
    const a = store.createIssue({ title: "Child A", parent: epic.id });
    const b = store.createIssue({ title: "Child B", parent: epic.id });
    const quiet = store.createIssue({ title: "Quiet parent" });
    const quietChild = store.createIssue({ title: "Quiet child", parent: quiet.id });
    Object.assign(refs, { epic: epic.identifier, a: a.identifier, b: b.identifier, quiet: quiet.identifier, quietChild: quietChild.identifier });
    const links = store.externalLinks();
    links.link(epic.id, pr(10, "open"), "ada");
    links.link(a.id, pr(20, "merged"), "ada");
    links.link(a.id, pr(30, "draft"), "ada");
    links.link(b.id, pr(30, "draft"), "ada");
  } finally {
    store.db.close();
  }
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: false, ws: "app", discoverPullRequests: false });
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

describe("a parent's subtree pull requests on every surface", () => {
  const expected = () => [
    ["team/repo#10", true, [refs.epic]],
    ["team/repo#20", false, [refs.a]],
    ["team/repo#30", false, [refs.a, refs.b]],
  ];

  it("staple show --json and get_task carry the set; a leaf carries none", async () => {
    const shown = await cliJson("show", refs.epic);
    expect(brief(shown.subtreePullRequests)).toEqual(expected());
    const task = await mcp.call("get_task", { ref: refs.epic, ws: "app" });
    expect(task.isError, JSON.stringify(task.content)).toBeFalsy();
    const structured = task.structuredContent as { subtreePullRequests: typeof shown.subtreePullRequests };
    expect(structured.subtreePullRequests).toEqual(shown.subtreePullRequests);
    // The agent pane shows exactly what get_task answers, field for field.
    const pane = await http(`/api/agent-context?ws=app&ref=${refs.epic}`);
    expect(pane.subtreePullRequests).toEqual(shown.subtreePullRequests);

    expect((await cliJson("show", refs.a)).subtreePullRequests).toBeUndefined();
    expect(((await mcp.call("get_task", { ref: refs.a, ws: "app" })).structuredContent as Record<string, unknown>).subtreePullRequests).toBeUndefined();
    // A parent with none says so with an empty set.
    expect((await cliJson("show", refs.quiet)).subtreePullRequests).toEqual([]);
  });

  it("staple show prints the set with the ticket each is on", async () => {
    const human = (await cli("show", refs.epic)).stdout;
    expect(human).toContain("pull requests (this ticket and its descendants):");
    expect(human).toContain(`  open    team/repo#10  PR 10 · ${refs.epic}`);
    expect(human).toContain(`  merged  team/repo#20  PR 20 · ${refs.a}`);
    expect(human).toContain(`  draft   team/repo#30  PR 30 · ${refs.a}, ${refs.b}`);
    expect((await cli("show", refs.quiet)).stdout).not.toContain("pull requests");
    expect((await cli("show", refs.a)).stdout).not.toContain("pull requests");
  });

  it("show_ticket carries the set and names each ticket in its text", async () => {
    const card = await mcp.call("show_ticket", { ref: refs.epic, ws: "app" });
    expect(card.isError, JSON.stringify(card.content)).toBeFalsy();
    const ticket = (card.structuredContent as { ticket: { subtreePullRequests: Array<{ key: string; own: boolean; tickets: Array<{ identifier: string }> }> } }).ticket;
    expect(brief(ticket.subtreePullRequests)).toEqual(expected());
    const text = (card.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain(`Pull requests: team/repo#10 open (${refs.epic}); team/repo#20 merged (${refs.a}); team/repo#30 draft (${refs.a}, ${refs.b}).`);
    const leaf = await mcp.call("show_ticket", { ref: refs.a, ws: "app" });
    expect((leaf.structuredContent as { ticket: Record<string, unknown> }).ticket.subtreePullRequests).toBeNull();
  });

  it("the detail carries the set and the row draws it; a leaf row keeps its own", async () => {
    const detail = await http(`/api/issue?ws=app&ref=${refs.epic}`);
    expect(brief(detail.subtreePullRequests)).toEqual(expected());
    expect((await http(`/api/issue?ws=app&ref=${refs.b}`)).subtreePullRequests).toBeUndefined();

    const rows = (await http("/api/issues?ws=app")) as Array<{ issue: { identifier: string }; pullRequests?: Array<{ number: number; state: string; tickets?: string[] }> }>;
    const row = (ref: string) => rows.find((r) => r.issue.identifier === ref)!;
    expect(row(refs.epic).pullRequests!.map((p) => [p.number, p.state, p.tickets])).toEqual([
      [10, "open", [refs.epic]],
      [30, "draft", [refs.a, refs.b]],
      [20, "merged", [refs.a]],
    ]);
    expect(row(refs.b).pullRequests!.map((p) => p.number)).toEqual([30]);
    expect(row(refs.quiet).pullRequests).toBeUndefined();
    expect(row(refs.quietChild).pullRequests).toBeUndefined();
  });
});
