import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceAttention } from "../src/core/attention.js";
import type { ExternalItem, ExternalItemRef, IntegrationAdapter } from "../src/core/integrations/contracts.js";
import type { GhRunner } from "../src/core/integrations/gh-process.js";
import { GitHubCliAdapter } from "../src/core/integrations/github-cli.js";
import { ProbeCache } from "../src/core/integrations/health.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { rowPullRequests } from "../src/core/integrations/pr-discovery.js";
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

  it("leaves a pull request a person unlinked, and one opened before the ticket existed, unlinked", async () => {
    let created: string | null = null;
    const { store, service } = await setup(() => [
      { ...pr(4, "open"), pullRequest: { ...pr(4, "open").pullRequest!, createdAt: created } },
      { ...pr(70, "merged"), pullRequest: { ...pr(70, "merged").pullRequest!, createdAt: "2020-01-01T00:00:00Z" } },
    ]);
    await service.execute({ action: "map", connectionId: "work", containerId: "42", actor: "ada" });
    const task = store.createIssue({ title: "Reused branch name" });
    setTicketBranch(store, task.id, { branch: "feat/x" }, "ada");
    created = new Date(Date.now() + 1000).toISOString();
    await service.execute({ action: "discover" });
    // #70 merged in 2020 on a branch of the same name: somebody else's work.
    expect(store.externalLinks().pullRequests().get(task.id)!.map((p) => p.key)).toEqual(["team/repo#4"]);
    const resource = store.externalLinks().list(task.id)[0]!.resource.id;
    await service.execute({ action: "unlink", ref: task.id, resourceId: resource, actor: "ada" });
    const again = (await service.execute({ action: "discover" })) as { linked: unknown[] };
    expect(again.linked).toEqual([]);
    expect(store.externalLinks().pullRequests().get(task.id)).toBeUndefined();
    store.db.close();
  });

  it("still reads the other repositories when one is forbidden", async () => {
    const { store, service, forBranches } = await setup(() => [pr(4, "open")]);
    await service.execute({ action: "map", connectionId: "work", containerId: "41", actor: "ada" });
    await service.execute({ action: "map", connectionId: "work", containerId: "42", actor: "ada" });
    const task = store.createIssue({ title: "Two repositories" });
    setTicketBranch(store, task.id, { branch: "feat/x" }, "ada");
    forBranches.mockImplementation(async (container: string) => {
      if (container === "41") throw new StapleError("forbidden", "GitHub denied access; check repository permissions and organization SSO");
      return [pr(4, "open")];
    });
    const report = (await service.execute({ action: "discover" })) as { failures: Array<{ state: string }>; linked: unknown[] };
    expect(report.failures).toEqual([expect.objectContaining({ state: "forbidden" })]);
    expect(report.linked).toHaveLength(1);
    const next = (await service.execute({ action: "discover" })) as { failures: Array<{ state: string }> };
    expect(forBranches).toHaveBeenCalledTimes(4);
    expect(next.failures).toEqual([expect.objectContaining({ state: "forbidden" })]);
    store.db.close();
  });

  it("reads a linked pull request again on a ticket with no branch, so a failing check clears", async () => {
    const { store, service, details } = await setup(() => []);
    await service.execute({ action: "map", connectionId: "work", containerId: "42", actor: "ada" });
    const task = store.createIssue({ title: "No branch" });
    store.externalLinks().link(task.id, pr(80, "open", "feat/y", { state: "failing", failing: ["ci"], completedAt: "2026-11-25T11:00:00Z" }), "ada");
    details.mockResolvedValueOnce({ ...pr(80, "open", "feat/y", { state: "passing", failing: [], completedAt: "2026-11-25T12:00:00Z" }), fetchedAt: new Date(Date.now() + 1000).toISOString() });
    await service.execute({ action: "discover" });
    expect(details).toHaveBeenCalledTimes(1);
    expect(store.externalLinks().pullRequests().get(task.id)![0]!.checks?.state).toBe("passing");
    store.db.close();
  });
});

describe("the row's pull requests", () => {
  it("draws every pull request, one never read as unknown, the ones still moving first", () => {
    const linked = (n: number, state: string | null) => ({ resourceId: String(n), providerId: "github", key: `t/r#${n}`, url: `https://github.com/t/r/pull/${n}`, number: n, state, title: null, checks: null, fetchedAt: null, linkedAt: "" });
    expect(rowPullRequests([linked(1, "merged"), linked(2, null), linked(3, "open")]).pullRequests!.map((p) => [p.number, p.state])).toEqual([[3, "open"], [2, "unknown"], [1, "merged"]]);
    expect(rowPullRequests([])).toEqual({});
  });

  it("sends no sync operation for a shared pull request a read finds unchanged", async () => {
    const { store } = await setup(() => []);
    const task = store.createIssue({ title: "Shared" });
    const links = store.externalLinks();
    const first = links.link(task.id, pr(90, "merged"), "ada");
    links.shareContext(first.resource.id, true, "ada");
    const record = vi.spyOn(store.journal, "record");
    links.remember({ ...pr(90, "merged"), fetchedAt: new Date(Date.now() + 5000).toISOString() }, "staple");
    expect(record.mock.calls.filter(([op]) => op.entity === "externalResource")).toEqual([]);
    links.remember({ ...pr(90, "merged"), title: "Renamed", fetchedAt: new Date(Date.now() + 9000).toISOString() }, "staple");
    expect(record.mock.calls.filter(([op]) => op.entity === "externalResource")).toHaveLength(1);
    store.db.close();
  });
});

describe("a pull request whose only failure is a commit status", () => {
  it("is a row on the attention list, read through gh like any other failing check", async () => {
    const home = mkdtempSync(join(tmpdir(), "staple-pr-discovery-"));
    dirs.push(home);
    process.env.STAPLE_HOME = home;
    const ws = initWorkspace({ global: true, slug: "discovery-status" });
    const repo = { id: 42, full_name: "team/repo", html_url: "https://github.com/team/repo" };
    const head = "d".repeat(40);
    const ok = (data: unknown) => `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`;
    // Every check run passes; an external CI reports its failure only as a commit status.
    const run = vi.fn<GhRunner>(async (command) => {
      if (command.kind === "version") return "gh version 2.46.0 (2024-03-20)";
      if (command.kind !== "get") throw new Error(`Unexpected ${command.kind}`);
      const path = command.endpoint.split("?")[0];
      if (path === "user") return ok({ login: "ada" });
      if (path === "repositories/42") return ok(repo);
      if (path === "repos/team/repo/pulls") return ok([{ number: 31, title: "PR 31", body: null, state: "open", draft: false, merged_at: null, html_url: "https://github.com/team/repo/pull/31", head: { ref: "feat/status", sha: head, repo: { id: 42 } } }]);
      if (path === `repos/team/repo/commits/${head}/check-runs`) return ok({ total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "success", completed_at: "2026-11-25T11:00:00Z" }] });
      if (path === `repos/team/repo/commits/${head}/status`) return ok({ state: "failure", sha: head, total_count: 1, statuses: [{ context: "ci/jenkins", state: "failure", updated_at: "2026-11-25T11:30:00Z" }] });
      throw new Error(`Unexpected endpoint ${command.endpoint}`);
    });
    const adapter = new GitHubCliAdapter({ id: "work", host: "github.com", account: "ada" }, { run });
    const caches = { health: new ProbeCache<never>() as never, detection: new ProbeCache<Array<{ host: string; login: string }>>() };
    const service = new IntegrationOperations(ws.store, { home, caches, factories: new Map([["github:cli", () => adapter]]) });
    await service.execute({ action: "configure", connectionId: "work", host: "github.com", account: "ada" });
    await service.execute({ action: "map", connectionId: "work", containerId: "42", actor: "ada" });
    const task = ws.store.createIssue({ title: "External CI" });
    setTicketBranch(ws.store, task.id, { branch: "feat/status" }, "ada");
    await service.execute({ action: "discover" });
    expect(workspaceAttention(ws.store).filter((row) => row.kind === "pr_checks_failing")).toEqual([
      expect.objectContaining({ ref: task.identifier, detail: "checks failing on team/repo#31: ci/jenkins", since: "2026-11-25T11:30:00Z" }),
    ]);
    ws.store.db.close();
  });
});
