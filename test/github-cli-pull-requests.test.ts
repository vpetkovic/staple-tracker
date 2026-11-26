import { describe, expect, it, vi } from "vitest";
import { GitHubCliAdapter } from "../src/core/integrations/github-cli.js";
import type { GhRunner } from "../src/core/integrations/gh-process.js";
import { IntegrationReader } from "../src/core/integrations/provider.js";
import { StapleError } from "../src/core/types.js";

const repo = { id: 42, full_name: "team/project", html_url: "https://github.com/team/project" };
const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, body: null, state: "open", draft: false, merged_at: null,
  html_url: `${repo.html_url}/pull/${number}`, head: { ref: "feat/x", sha: sha(number), repo: { id: 42 } }, ...extra,
});
const done = (name: string, conclusion: string | null, at = "2026-11-25T11:00:00Z") => ({ name, status: "completed", conclusion, completed_at: at });
const commitStatus = (context: string, state: string, at = "2026-11-25T11:10:00Z") => ({ context, state, updated_at: at });
function response(data: unknown) { return `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`; }

/** One page of a paged list as GitHub serves it: `per_page` (default 30) and `page` from the query. */
function paged(all: unknown[], query: string | undefined) {
  const params = new URLSearchParams(query);
  const per = Number(params.get("per_page") ?? 30), page = Number(params.get("page") ?? 1);
  return all.slice((page - 1) * per, page * per);
}

function fixture(pulls: unknown[], runs: Record<string, unknown[]> = {}, statuses: Record<string, unknown[]> = {}) {
  const run = vi.fn<GhRunner>(async (command) => {
    if (command.kind === "version") return "gh version 2.46.0 (2024-03-20)";
    if (command.kind !== "get") throw new Error(`Unexpected ${command.kind}`);
    const [path, query] = command.endpoint.split("?");
    if (path === "user") return response({ login: "alice" });
    if (path === "repositories/42") return response(repo);
    if (path === "repos/team/project/pulls") {
      expect(query).toContain("state=all");
      return response(pulls);
    }
    const one = /^repos\/team\/project\/pulls\/(\d+)$/.exec(path!);
    if (one) return response(pulls.find((p) => (p as { number: number }).number === Number(one[1])));
    const checks = /^repos\/team\/project\/commits\/([0-9a-f]+)\/check-runs$/.exec(path!);
    if (checks && runs.unreadableAfterFirst && new URLSearchParams(query).get("page") !== "1") throw new StapleError("unavailable", "GitHub CLI timed out; try again");
    if (checks && runs.forbidden) throw new StapleError("forbidden", "GitHub denied access; check repository permissions and organization SSO");
    if (checks) {
      const all = runs[checks[1]!] ?? [];
      return response({ total_count: all.length, check_runs: paged(all, query) });
    }
    const status = /^repos\/team\/project\/commits\/([0-9a-f]+)\/status$/.exec(path!);
    if (status && statuses.forbidden) throw new StapleError("forbidden", "GitHub denied access; check repository permissions and organization SSO");
    if (status && statuses.limited) throw new StapleError("rate_limited", "GitHub rate limit reached; try again later");
    if (status) {
      const all = (statuses[status[1]!] ?? []) as Array<{ state: string }>;
      const state = all.some((s) => s.state === "failure" || s.state === "error") ? "failure" : all.length && all.every((s) => s.state === "success") ? "success" : "pending";
      return response({ state, sha: status[1], total_count: all.length, statuses: paged(all, query) });
    }
    if (path === "repos/team/project/issues/7") return response({ number: 7, title: "Draft", body: null, state: "open", draft: true, html_url: `${repo.html_url}/pull/7`, pull_request: { merged_at: null } });
    throw new Error(`Unexpected endpoint ${command.endpoint}`);
  });
  const adapter = new GitHubCliAdapter({ id: "work", host: "github.com", account: "alice" }, { run, now: () => new Date("2026-11-25T12:00:00Z") });
  return { run, reader: new IntegrationReader(adapter), adapter };
}

describe("GitHub pull requests by branch", () => {
  it("finds every pull request on the branch in one read, with draft, open, merged and closed told apart", async () => {
    const { reader, run } = fixture([
      pull(4, { draft: true }),
      pull(3),
      pull(2, { state: "closed", merged_at: "2026-11-24T10:00:00Z" }),
      pull(1, { state: "closed" }),
      pull(9, { head: { ref: "feat/other", sha: sha(9), repo: { id: 42 } } }),
      pull(8, { head: { ref: "feat/x", sha: sha(8), repo: { id: 77 } } }),
    ]);
    const items = await reader.pullRequestsForBranches("42", ["feat/x"]);
    expect(items.map((i) => [i.key, i.status?.id])).toEqual([
      ["team/project#4", "draft"], ["team/project#3", "open"], ["team/project#2", "merged"], ["team/project#1", "closed"],
    ]);
    expect(items[0]).toMatchObject({ ref: { kind: "pull_request", containerId: "42", id: "4" }, pullRequest: { headBranch: "feat/x", headSha: sha(4) } });
    // One list read for the repository, check runs only for pull requests that can still change.
    const endpoints = run.mock.calls.map(([c]) => (c.kind === "get" ? c.endpoint.split("?")[0] : c.kind));
    expect(endpoints.filter((e) => e === "repos/team/project/pulls")).toHaveLength(1);
    expect(endpoints.filter((e) => e?.endsWith("/check-runs"))).toEqual([`repos/team/project/commits/${sha(4)}/check-runs`, `repos/team/project/commits/${sha(3)}/check-runs`]);
    // Only GET requests, never a write.
    expect(run.mock.calls.every(([c]) => c.kind === "version" || c.kind === "get")).toBe(true);
  });

  it("sums up the checks on the head: any failure fails, else anything running is pending", async () => {
    const { reader } = fixture([pull(3), pull(5, { head: { ref: "feat/x", sha: sha(5), repo: { id: 42 } } }), pull(6, { head: { ref: "feat/x", sha: sha(6), repo: { id: 42 } } })], {
      [sha(3)]: [done("build", "success"), done("test", "failure", "2026-11-25T11:30:00Z"), { name: "lint", status: "in_progress", conclusion: null, completed_at: null }],
      [sha(5)]: [done("build", "success"), { name: "test", status: "queued", conclusion: null, completed_at: null }],
      [sha(6)]: [done("build", "success"), done("docs", "skipped")],
    });
    const items = await reader.pullRequestsForBranches("42", ["feat/x"]);
    expect(items.map((i) => i.pullRequest?.checks)).toEqual([
      { state: "failing", failing: ["test"], completedAt: "2026-11-25T11:30:00Z" },
      { state: "pending", failing: [], completedAt: "2026-11-25T11:00:00Z" },
      { state: "passing", failing: [], completedAt: "2026-11-25T11:00:00Z" },
    ]);
  });

  it("reads every page of check runs, so a failure past the first hundred fails", async () => {
    const runs = Array.from({ length: 150 }, (_, i) => done(`job ${i}`, "success"));
    runs[140] = done("late", "failure", "2026-11-25T11:40:00Z");
    const { reader, run } = fixture([pull(3)], { [sha(3)]: runs });
    const [item] = await reader.pullRequestsForBranches("42", ["feat/x"]);
    expect(item!.pullRequest?.checks).toEqual({ state: "failing", failing: ["late"], completedAt: "2026-11-25T11:40:00Z" });
    // A page only when total_count says more runs remain, and one commit status read.
    const reads = run.mock.calls.map(([c]) => (c.kind === "get" ? c.endpoint : "")).filter((e) => e.includes("/commits/"));
    expect(reads).toEqual([
      `repos/team/project/commits/${sha(3)}/check-runs?filter=latest&per_page=100&page=1`,
      `repos/team/project/commits/${sha(3)}/status?per_page=100&page=1`,
      `repos/team/project/commits/${sha(3)}/check-runs?filter=latest&per_page=100&page=2`,
    ]);
  });

  it("is pending, never passing, when there are more check runs than it reads", async () => {
    const { reader, run } = fixture([pull(3)], { [sha(3)]: Array.from({ length: 1100 }, (_, i) => done(`job ${i}`, "success")) });
    const [item] = await reader.pullRequestsForBranches("42", ["feat/x"]);
    expect(item!.pullRequest?.checks?.state).toBe("pending");
    expect(run.mock.calls.filter(([c]) => c.kind === "get" && c.endpoint.includes("/check-runs"))).toHaveLength(10);
  });

  it("keeps what it read when a later page of check runs cannot be read: a failure fails, else pending", async () => {
    const runs = Array.from({ length: 150 }, (_, i) => done(`job ${i}`, "success"));
    const { reader } = fixture([pull(3)], { [sha(3)]: runs, unreadableAfterFirst: [] });
    expect((await reader.pullRequestsForBranches("42", ["feat/x"]))[0]!.pullRequest?.checks?.state).toBe("pending");
    runs[5] = done("early", "failure");
    expect((await reader.pullRequestsForBranches("42", ["feat/x"]))[0]!.pullRequest?.checks).toMatchObject({ state: "failing", failing: ["early"] });
  });

  it("counts a stale run, or a finished run without a known conclusion, as pending", async () => {
    const { reader } = fixture([pull(3), pull(5, { head: { ref: "feat/x", sha: sha(5), repo: { id: 42 } } })], {
      [sha(3)]: [done("build", "success"), done("deploy", "stale")],
      [sha(5)]: [done("build", "success"), done("odd", null), done("new", "something_new")],
    });
    const items = await reader.pullRequestsForBranches("42", ["feat/x"]);
    expect(items.map((i) => i.pullRequest?.checks?.state)).toEqual(["pending", "pending"]);
  });

  it("reads commit statuses too: a failing status fails, a pending one pends, statuses alone pass", async () => {
    const head = (n: number) => pull(n, { head: { ref: "feat/x", sha: sha(n), repo: { id: 42 } } });
    const { reader } = fixture([head(3), head(5), head(6), head(1)], {
      [sha(3)]: [done("build", "success")], [sha(5)]: [done("build", "success")],
    }, {
      [sha(3)]: [commitStatus("ci/jenkins", "failure", "2026-11-25T11:50:00Z"), commitStatus("ci/lint", "error", "2026-11-25T11:20:00Z"), commitStatus("ci/docs", "success")],
      [sha(5)]: [commitStatus("ci/jenkins", "pending")],
      [sha(6)]: [commitStatus("ci/jenkins", "success", "2026-11-25T11:45:00Z")],
    });
    const items = await reader.pullRequestsForBranches("42", ["feat/x"]);
    expect(items.map((i) => [i.key, i.pullRequest?.checks])).toEqual([
      ["team/project#3", { state: "failing", failing: ["ci/jenkins", "ci/lint"], completedAt: "2026-11-25T11:50:00Z" }],
      ["team/project#5", { state: "pending", failing: [], completedAt: "2026-11-25T11:00:00Z" }],
      ["team/project#6", { state: "passing", failing: [], completedAt: "2026-11-25T11:45:00Z" }],
      // Neither check runs nor statuses: no checks, as before.
      ["team/project#1", null],
    ]);
  });

  it("keeps a failing check run failing when the commit statuses cannot be read, and never says passing", async () => {
    const { reader } = fixture([pull(3)], { [sha(3)]: [done("test", "failure")] }, { forbidden: [] });
    const [item] = await reader.pullRequestsForBranches("42", ["feat/x"]);
    expect(item!.pullRequest?.checks).toEqual({ state: "failing", failing: ["test"], completedAt: "2026-11-25T11:00:00Z" });
    const passing = fixture([pull(3)], { [sha(3)]: [done("test", "success")] }, { forbidden: [] });
    const [unconfirmed] = await passing.reader.pullRequestsForBranches("42", ["feat/x"]);
    // Half the answer is unknown, so the checks are unknown, as when check runs cannot be read.
    expect(unconfirmed!.pullRequest?.checks).toBeNull();
    // A rate limit still fails the read, as it does for check runs.
    await expect(fixture([pull(3)], { [sha(3)]: [done("test", "success")] }, { limited: [] }).reader.pullRequestsForBranches("42", ["feat/x"])).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("reads one linked pull request with its head and checks", async () => {
    const { reader } = fixture([pull(12, { head: { ref: "feat/stacked", sha: sha(12), repo: { id: 42 } } })]);
    const item = await reader.pullRequestDetails({ providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id: "12", kind: "pull_request" });
    expect(item).toMatchObject({ key: "team/project#12", status: { id: "open" }, pullRequest: { headBranch: "feat/stacked", checks: null } });
  });

  it("says a pull request read as an issue is a draft", async () => {
    const { reader } = fixture([]);
    const item = await reader.read({ providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id: "7", kind: "pull_request" });
    expect(item.status).toEqual({ id: "draft", name: "draft" });
  });

  it("still reads the pull requests when the account may not read their checks", async () => {
    const { reader } = fixture([pull(3)], { forbidden: [] });
    const items = await reader.pullRequestsForBranches("42", ["feat/x"]);
    expect(items.map((i) => [i.key, i.pullRequest?.checks])).toEqual([["team/project#3", null]]);
  });
});
