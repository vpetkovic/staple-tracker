/**
 * Why a ticket's branch has no pull request, on the ticket detail. The web UI's poll runs
 * discovery in the background; when gh is signed out, `/api/issue` carries the failure's message
 * and the connection's action for a ticket whose branch was looked for, and nothing for a ticket
 * with no branch. The reason lives in memory, not the database, so the poll's fingerprint moves
 * when it appears and an open detail refetches. Nothing here calls GitHub.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExternalItem, IntegrationAdapter } from "../src/core/integrations/contracts.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { setTicketBranch } from "../src/core/ticket-branch.js";
import { StapleError } from "../src/core/types.js";
import { resolveWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync } from "./fixtures/contract-support.js";

let home: string;
let ui: UiHandle;
let origin: string;
let withBranch: string;
let withoutBranch: string;
let finished: string;

// The words gh-process.ts maps a signed-out gh to.
const SIGNED_OUT = "Sign in to GitHub CLI on this machine for the configured host";
const forBranches = vi.fn(async (): Promise<ExternalItem[]> => {
  throw new StapleError("auth", SIGNED_OUT);
});
const adapter: IntegrationAdapter = {
  scope: { providerId: "github", host: "github.com", scopeId: "host" }, label: "GitHub", connection: { id: "work", mode: "cli" },
  validate: async () => ({ state: "ready" }), listContainers: async () => ({ items: [], nextCursor: null }),
  readContainer: async (id) => ({ id, name: "team/repo", url: "https://github.com/team/repo" }),
  searchIssues: async () => ({ items: [], nextCursor: null }), resolve: async () => null, readIssue: vi.fn(),
  pullRequests: { read: vi.fn(), forBranches, details: vi.fn() },
};
const factories = new Map([["github:cli", () => adapter]]);

async function http(path: string): Promise<any> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status).toBe(200);
  return response.json();
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-discovery-notice-home-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", "app"], { STAPLE_HOME: home })).status).toBe(0);
  const { store } = resolveWorkspace({ ws: "app" });
  try {
    withBranch = store.createIssue({ title: "Has a branch" }).identifier;
    withoutBranch = store.createIssue({ title: "No branch" }).identifier;
    finished = store.createIssue({ title: "Finished on a branch" }).identifier;
    setTicketBranch(store, finished, { branch: "feat/finished" }, CONTRACT_AGENT);
    store.updateIssue(withBranch, { status: "in_progress", assignee: CONTRACT_AGENT }, CONTRACT_AGENT);
    setTicketBranch(store, withBranch, { branch: "feat/notice" }, CONTRACT_AGENT);
    const ops = new IntegrationOperations(store, { home, factories });
    await ops.execute({ action: "configure", connectionId: "work", host: "github.com", account: "ada" });
    await ops.execute({ action: "map", connectionId: "work", containerId: "42", actor: "ada" });
  } finally {
    store.db.close();
  }
  ui = startUiServer({ port: 0, hub: false, ws: "app", discoveryFactories: factories });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (ui ? ui.server.close(() => resolve()) : resolve()));
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("the ticket detail when no pull request was found for its branch", () => {
  it("says gh is signed out and how to sign in, and the poll's fingerprint moves when it does", async () => {
    const before = (await http("/api/poll")).fingerprint as string;
    await vi.waitFor(async () => {
      const detail = await http(`/api/issue?ws=app&ref=${withBranch}`);
      expect(detail.pullRequestDiscovery).toEqual({
        note: null,
        failures: [{ message: SIGNED_OUT, action: "Run gh auth login --hostname github.com on the computer running Staple." }],
      });
    }, { timeout: 10_000, interval: 100 });
    expect(forBranches).toHaveBeenCalledTimes(1);
    const after = (await http("/api/poll")).fingerprint as string;
    expect(after).not.toBe(before);
    // Nothing changed since: the fingerprint holds, so the page does not refetch for nothing.
    expect((await http("/api/poll")).fingerprint).toBe(after);
  });

  it("says nothing on a ticket with no branch, nor on one finished since the run", async () => {
    const detail = await http(`/api/issue?ws=app&ref=${withoutBranch}`);
    expect(detail).not.toHaveProperty("pullRequestDiscovery");
    expect((await http(`/api/issue?ws=app&ref=${finished}`)).pullRequestDiscovery).toMatchObject({ failures: [{ message: SIGNED_OUT }] });
    const done = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "x-staple-token": ui.token, "content-type": "application/json" },
      body: JSON.stringify({ ws: "app", ref: finished, type: "status", status: "done", actor: CONTRACT_AGENT }),
    });
    expect(done.status, await done.text()).toBe(200);
    expect(await http(`/api/issue?ws=app&ref=${finished}`)).not.toHaveProperty("pullRequestDiscovery");
  });

  it("looks again on the next poll once the connection is checked again, and the signed-out line goes", { timeout: 30_000 }, async () => {
    forBranches.mockResolvedValue([]);
    // A forced check younger than HEALTH_FORCE_FLOOR_MS (5 s) is answered from the cache; a
    // person signing in to gh first is well past it.
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const checked = await fetch(`${origin}/api/integrations/read`, {
      method: "POST",
      headers: { "x-staple-token": ui.token, "content-type": "application/json" },
      body: JSON.stringify({ ws: "app", action: "health", connectionId: "work", force: true }),
    });
    expect(checked.status, await checked.text()).toBe(200);
    await http("/api/poll");
    await vi.waitFor(async () => {
      expect((await http(`/api/issue?ws=app&ref=${withBranch}`)).pullRequestDiscovery).toEqual({ note: null, failures: [] });
    }, { timeout: 10_000, interval: 100 });
    expect(forBranches).toHaveBeenCalledTimes(2);
  });

  it("holds the fingerprint across a run that explains the same thing again", async () => {
    const mapped = await fetch(`${origin}/api/integrations/write`, {
      method: "POST",
      headers: { "x-staple-token": ui.token, "content-type": "application/json" },
      body: JSON.stringify({ ws: "app", action: "map", connectionId: "work", containerId: "43", actor: "ada" }),
    });
    expect(mapped.status, await mapped.text()).toBe(200);
    // This poll starts the run the mapping asked for; its fingerprint already carries the mapping.
    const before = (await http("/api/poll")).fingerprint as string;
    await vi.waitFor(() => expect(forBranches).toHaveBeenCalledTimes(4), { timeout: 10_000, interval: 50 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await http("/api/issue?ws=app&ref=" + withBranch)).pullRequestDiscovery).toEqual({ note: null, failures: [] });
    expect((await http("/api/poll")).fingerprint).toBe(before);
  });
});
