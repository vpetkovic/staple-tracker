import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalItem, ExternalItemRef, IntegrationAdapter } from "../src/core/integrations/contracts.js";
import { ProbeCache } from "../src/core/integrations/health.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { setTicketBranch } from "../src/core/ticket-branch.js";
import { StapleError } from "../src/core/types.js";
import { initWorkspace } from "../src/core/workspace.js";

const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  if (previous === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previous;
});

const ref = (id: number, containerId = "42"): ExternalItemRef => ({ providerId: "github", host: "github.com", scopeId: "host", containerId, id: String(id), kind: "pull_request" });
function pr(id: number, state: string, branch = "feat/x", checks: NonNullable<ExternalItem["pullRequest"]>["checks"] = null): ExternalItem {
  return {
    ref: ref(id), key: `team/repo#${id}`, url: `https://github.com/team/repo/pull/${id}`, title: `PR ${id}`, body: null,
    status: { id: state, name: state }, fetchedAt: "2026-11-25T12:00:00.000Z",
    pullRequest: { headBranch: branch, headSha: "a".repeat(40), checks },
  };
}

async function setup(found: () => ExternalItem[]) {
  const home = mkdtempSync(join(tmpdir(), "staple-pr-discovery-"));
  dirs.push(home);
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "discovery-tests" });
  const forBranches = vi.fn(async (_container: string, branches: readonly string[]) => found().filter((item) => branches.includes(item.pullRequest!.headBranch)));
  const details = vi.fn(async (r: ExternalItemRef) => pr(Number(r.id), "open", "feat/stacked", { state: "failing", failing: ["test"], completedAt: "2026-11-25T11:00:00Z" }));
  const adapter: IntegrationAdapter = {
    scope: { providerId: "github", host: "github.com", scopeId: "host" }, label: "GitHub", connection: { id: "work", mode: "cli" },
    validate: vi.fn(async () => ({ state: "ready" as const })), listContainers: vi.fn(async () => ({ items: [], nextCursor: null })),
    readContainer: vi.fn(async (id: string) => ({ id, name: "team/repo", url: "https://github.com/team/repo" })),
    searchIssues: vi.fn(async () => ({ items: [], nextCursor: null })), resolve: vi.fn(async () => null), readIssue: vi.fn(),
    pullRequests: { read: vi.fn(), forBranches, details },
  };
  const caches = { health: new ProbeCache<never>() as never, detection: new ProbeCache<Array<{ host: string; login: string }>>() };
  const service = new IntegrationOperations(ws.store, { home, caches, factories: new Map([["github:cli", () => adapter]]) });
  await service.execute({ action: "configure", connectionId: "work", host: "github.com", account: "ada" });
  return { ws, store: ws.store, service, forBranches, details, caches };
}

describe("finding the pull requests opened for a ticket's branch", () => {
  it("links every pull request on the branch, replaced or not, and never changes the ticket's status", async () => {
    const { store, service, forBranches } = await setup(() => [pr(4, "draft"), pr(3, "merged"), pr(2, "closed"), pr(9, "open", "feat/someone-else")]);
    await service.execute({ action: "map", connectionId: "work", containerId: "42", actor: "ada" });
    const task = store.createIssue({ title: "Work" });
    const idle = store.createIssue({ title: "No branch" });
    setTicketBranch(store, task.id, { branch: "feat/x" }, "ada");
    const before = store.getIssue(task.id);
    const report = (await service.execute({ action: "discover", actor: "ada" })) as { linked: unknown[]; tickets: Array<{ ref: string; pullRequests: Array<{ key: string; state: string }> }> };
    expect(forBranches).toHaveBeenCalledWith("42", ["feat/x"], undefined);
    expect(report.linked).toHaveLength(3);
    expect(report.tickets).toHaveLength(1);
    expect(report.tickets[0]!.pullRequests.map((p) => [p.key, p.state])).toEqual([["team/repo#4", "draft"], ["team/repo#3", "merged"], ["team/repo#2", "closed"]]);
    expect(store.externalLinks().list(idle.id)).toEqual([]);
    // A merged pull request is a fact on the ticket, not a status change.
    expect(store.getIssue(task.id).status).toBe(before.status);
    expect(store.getIssue(task.id).completedAt).toBeNull();
    // Running again links nothing new and shows each pull request once.
    const again = (await service.execute({ action: "discover", ref: task.identifier })) as { linked: unknown[]; tickets: Array<{ pullRequests: unknown[] }> };
    expect(again.linked).toEqual([]);
    expect(again.tickets[0]!.pullRequests).toHaveLength(3);
    store.db.close();
  });

  it("fills the branch from an existing branch-pointer comment", async () => {
    const { store, service } = await setup(() => [pr(5, "open", "feat/pointer")]);
    await service.execute({ action: "map", connectionId: "work", containerId: "42", actor: "ada" });
    const task = store.createIssue({ title: "Pointer" });
    store.addComment(task.id, "Branch pointer: branch feat/pointer, base 3f2a1bc.", "eng-1");
    const report = (await service.execute({ action: "discover" })) as { tickets: Array<{ branch: { name: string; source: string }; pullRequests: unknown[] }> };
    expect(report.tickets[0]).toMatchObject({ branch: { name: "feat/pointer", source: "comment" }, pullRequests: [{ key: "team/repo#5" }] });
    store.db.close();
  });

  it("reads a ticket's other live pull requests again, so a stacked one's failing check is saved", async () => {
    const { store, service, details } = await setup(() => [pr(3, "merged")]);
    await service.execute({ action: "map", connectionId: "work", containerId: "42", actor: "ada" });
    const task = store.createIssue({ title: "Stacked" });
    setTicketBranch(store, task.id, { branch: "feat/x" }, "ada");
    store.externalLinks().link(task.id, { ref: ref(12), key: "team/repo#12", url: "https://github.com/team/repo/pull/12" }, "ada");
    // A pull request in a repository this workspace does not map is never read.
    store.externalLinks().link(task.id, { ref: ref(13, "99"), key: "elsewhere/repo#13", url: "https://github.com/elsewhere/repo/pull/13" }, "ada");
    const report = (await service.execute({ action: "discover" })) as { refreshed: number };
    expect(report.refreshed).toBe(1);
    expect(details).toHaveBeenCalledTimes(1);
    expect(store.externalLinks().pullRequests().get(task.id)!.find((p) => p.key === "team/repo#12")).toMatchObject({ state: "open", checks: { state: "failing", failing: ["test"] } });
    store.db.close();
  });

  it("finds nothing, and says why, when gh is not signed in or nothing is mapped", async () => {
    const { store, service, forBranches } = await setup(() => [pr(4, "open")]);
    const task = store.createIssue({ title: "Unmapped" });
    setTicketBranch(store, task.id, { branch: "feat/x" }, "ada");
    const unmapped = (await service.execute({ action: "discover" })) as { note: string; failures: unknown[]; tickets: Array<{ pullRequests: unknown[] }> };
    expect(unmapped.note).toMatch(/No GitHub repository is mapped/);
    expect(unmapped.tickets[0]!.pullRequests).toEqual([]);
    expect(forBranches).not.toHaveBeenCalled();

    await service.execute({ action: "map", connectionId: "work", containerId: "42", actor: "ada" });
    forBranches.mockRejectedValueOnce(new StapleError("auth", "Sign in to GitHub CLI on this machine for the configured host"));
    const signedOut = (await service.execute({ action: "discover" })) as { failures: Array<{ state: string; action: string }>; tickets: Array<{ pullRequests: unknown[] }> };
    expect(signedOut.failures).toEqual([expect.objectContaining({ connectionId: "work", state: "unauthenticated", action: "Run gh auth login --hostname github.com on the computer running Staple." })]);
    expect(signedOut.tickets[0]!.pullRequests).toEqual([]);
    // The failure is the connection's health now, so the next run does not ask gh again yet.
    const held = (await service.execute({ action: "discover" })) as { failures: Array<{ state: string }> };
    expect(held.failures).toEqual([expect.objectContaining({ state: "unauthenticated" })]);
    expect(forBranches).toHaveBeenCalledTimes(1);
    store.db.close();
  });
});
