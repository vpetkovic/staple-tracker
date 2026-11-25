import { describe, expect, it, vi } from "vitest";
import { GitHubCliAdapter } from "../src/core/integrations/github-cli.js";
import type { GhRunner } from "../src/core/integrations/gh-process.js";
import { IntegrationReader } from "../src/core/integrations/provider.js";

const repo = { id: 42, full_name: "team/project", html_url: "https://github.com/team/project" };
const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, body: null, state: "open", draft: false, merged_at: null,
  html_url: `${repo.html_url}/pull/${number}`, head: { ref: "feat/x", sha: sha(number), repo: { id: 42 } }, ...extra,
});
function response(data: unknown) { return `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`; }

function fixture(pulls: unknown[], runs: Record<string, unknown[]> = {}) {
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
    if (checks) return response({ total_count: (runs[checks[1]!] ?? []).length, check_runs: runs[checks[1]!] ?? [] });
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
    const done = (name: string, conclusion: string, at = "2026-11-25T11:00:00Z") => ({ name, status: "completed", conclusion, completed_at: at });
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
});
