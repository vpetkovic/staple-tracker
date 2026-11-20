import { describe, expect, it, vi } from "vitest";
import { GitHubCliAdapter } from "../src/core/integrations/github-cli.js";
import type { GhCommand, GhRunner } from "../src/core/integrations/gh-process.js";
import { IntegrationReader } from "../src/core/integrations/provider.js";
import { StapleError } from "../src/core/types.js";
import { integrationReadContract } from "./fixtures/integration-contract.js";

const repo = { id: 42, full_name: "team/project", html_url: "https://github.example.com/team/project" };
const issue = (number = 1) => ({ number, title: `Source ${number}`, body: "Context", state: "open", html_url: `${repo.html_url}/issues/${number}` });

function fixture() {
  const run = vi.fn<GhRunner>(async (command) => {
    if (command.kind === "version") return "gh version 2.46.0 (2024-03-20)";
    const path = command.endpoint.split("?")[0];
    if (path === "user") return response({ login: "alice" });
    if (path === "user/repos") return response([repo]);
    if (path === "repositories/42" || path === "repos/team/project") return response(repo);
    if (path === "search/issues") return response({ total_count: 2, incomplete_results: false, items: [issue(1), issue(2)].map(i => ({ ...i, repository_url: "https://github.example.com/api/v3/repos/team/project" })) });
    if (path === "repos/team/project/issues/1") return response(issue());
    if (path === "repos/team/project/issues/2") return response(issue(2));
    throw new Error(`Unexpected fixture command ${command.endpoint}`);
  });
  const adapter = new GitHubCliAdapter({ id: "test", host: "github.example.com", account: "alice" }, { run, now: () => new Date("2026-11-20T12:00:00Z") });
  return { run, adapter, reader: new IntegrationReader(adapter) };
}

function response(data: unknown) { return `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`; }

integrationReadContract("GitHub gh", () => {
  const { adapter } = fixture();
  const items = [1, 2].map(number => ({
    ref: { ...adapter.scope, containerId: "42", id: String(number), kind: "issue" as const },
    key: `team/project#${number}`, url: `${repo.html_url}/issues/${number}`, title: `Source ${number}`, body: "Context",
    status: { id: "open", name: "open" }, fetchedAt: "2026-11-20T12:00:00.000Z",
  }));
  return { adapter, items };
});

describe("GitHub CLI adapter", () => {
  it("checks the effective account before every read, without changing authentication", async () => {
    const { run, adapter } = fixture();
    await adapter.listContainers();
    run.mockImplementation(async command => command.kind === "version" ? "gh version 2.46.0" : response({ login: "bob" }));
    await expect(adapter.listContainers()).rejects.toMatchObject({ code: "auth" });
    expect(run.mock.calls.every(([c]) => c.kind === "version" || c.kind === "get")).toBe(true);
  });

  it.each([
    ["missing_cli", new StapleError("unavailable", "Install gh", { reason: "missing_cli" })],
    ["unauthenticated", new StapleError("auth", "Login required")],
    ["forbidden", new StapleError("forbidden", "Access denied")],
    ["unavailable", new StapleError("offline", "Offline")],
  ])("reports %s health without exposing raw provider errors", async (state, error) => {
    const { adapter, run } = fixture();
    run.mockRejectedValue(error);
    expect(await adapter.validate()).toMatchObject({ state });
  });

  it("reports an unsupported CLI version", async () => {
    const { adapter, run } = fixture();
    run.mockResolvedValue("gh version 1.9.0");
    expect(await adapter.validate()).toMatchObject({ state: "unsupported_version" });
  });

  it("pins the Enterprise host and resolves canonical issue and PR references", async () => {
    const { adapter, run } = fixture();
    run.mockImplementation(async c => {
      if (c.kind === "version") return "gh version 2.46.0";
      if (c.endpoint === "user") return response({ login: "alice" });
      if (c.endpoint === "repos/team/project") return response(repo);
      return response({ ...issue(), html_url: `${repo.html_url}/pull/1`, pull_request: { url: "ignored" } });
    });
    expect((await adapter.resolve({ url: `${repo.html_url}/pull/1?utm_source=test#comment` }))?.ref.kind).toBe("pull_request");
    expect(run.mock.calls.filter(([c]) => c.kind === "get").every(([c]) => (c as Extract<GhCommand, {kind:"get"}>).host === "github.example.com")).toBe(true);
  });

  it("rejects arbitrary URLs, credential URLs and cross-host paths before any subprocess", async () => {
    const { adapter, run } = fixture();
    for (const url of ["https://evil.test/team/project/issues/1", "https://user:secret@github.example.com/team/project/issues/1", `${repo.html_url}/issues/1/extra`, `${repo.html_url}/issues/1?token=secret`, "http://github.example.com/team/project/issues/1"]) {
      await expect(adapter.resolve({ url })).rejects.toMatchObject({ code: "validation" });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("requires a separator between a repository key and its issue number", async () => {
    const { adapter, run } = fixture();
    await expect(adapter.resolve({ key: "team/project1", containerId: "42" })).rejects.toMatchObject({ code: "validation" });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns null only for not-found references and preserves rate-limit failures", async () => {
    const { adapter, run } = fixture();
    const base = run.getMockImplementation()!;
    run.mockImplementation(async (c, o) => c.kind === "get" && c.endpoint.startsWith("repos/team/") ? Promise.reject(new StapleError("not_found", "Unknown")) : base(c, o));
    expect(await adapter.resolve({ url: `${repo.html_url}/issues/1` })).toBeNull();
    run.mockImplementation(async (c, o) => c.kind === "get" && c.endpoint.startsWith("repos/team/") ? Promise.reject(new StapleError("rate_limited", "Wait", { retryAfterSeconds: 60 })) : base(c, o));
    await expect(adapter.resolve({ url: `${repo.html_url}/issues/1` })).rejects.toMatchObject({ code: "rate_limited", detail: { retryAfterSeconds: 60 } });
  });

  it("keeps issue search separate from PR references and treats malformed metadata as unavailable", async () => {
    const { adapter, run } = fixture();
    const base = run.getMockImplementation()!;
    run.mockImplementation(async (c, o) => c.kind === "get" && c.endpoint.startsWith("search/issues") ? response({ total_count: 1, incomplete_results: false, items: [{ ...issue(), pull_request: {}, repository_url: "https://github.example.com/api/v3/repos/team/project" }] }) : base(c, o));
    expect((await adapter.searchIssues({ text: "source" })).items).toEqual([]);
    run.mockImplementation(async (c, o) => c.kind === "get" && c.endpoint === "repos/team/project/issues/1" ? response({ title: "incomplete" }) : base(c, o));
    await expect(adapter.resolve({ url: `${repo.html_url}/issues/1` })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("advances search pages and rejects cursors reused for another query or resource kind", async () => {
    const { adapter, run } = fixture();
    const base = run.getMockImplementation()!;
    run.mockImplementation(async (c, o) => {
      if (c.kind !== "get" || !c.endpoint.startsWith("search/issues")) return base(c, o);
      const page = Number(new URL(`https://example.test/${c.endpoint}`).searchParams.get("page"));
      const items = page === 1 ? Array.from({ length: 50 }, (_, i) => issue(i + 1)) : [issue(51)];
      return response({ total_count: 51, incomplete_results: false, items: items.map(i => ({ ...i, repository_url: "https://github.example.com/api/v3/repos/team/project" })) });
    });
    const first = await adapter.searchIssues({ text: "source", containerId: "42" });
    expect(first.items).toHaveLength(50);
    const second = await adapter.searchIssues({ text: "source", containerId: "42", cursor: first.nextCursor! });
    expect(second.items[0]?.ref.id).toBe("51");
    expect(second.nextCursor).toBeNull();
    run.mockClear();
    await expect(adapter.searchIssues({ text: "other", containerId: "42", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(adapter.pullRequests.search({ text: "source", containerId: "42", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "cursor_invalid" });
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves merged PR status and excludes issues from PR search", async () => {
    const { adapter, run } = fixture();
    const base = run.getMockImplementation()!;
    const pr = { ...issue(), html_url: `${repo.html_url}/pull/1`, pull_request: { merged_at: "2026-11-19T12:00:00Z" }, repository_url: "https://github.example.com/api/v3/repos/team/project" };
    run.mockImplementation(async (c, o) => c.kind === "get" && c.endpoint.startsWith("search/issues")
      ? response({ total_count: 2, incomplete_results: false, items: [pr, issue(2)] }) : base(c, o));
    const result = await adapter.pullRequests.search({ text: "source" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status?.id).toBe("merged");
  });

  it("rejects partial/over-limit search results and cross-repository refreshes", async () => {
    const { adapter, run } = fixture();
    const base = run.getMockImplementation()!;
    for (const data of [
      { total_count: 1, incomplete_results: true, items: [] },
      { total_count: 1001, incomplete_results: false, items: [] },
    ]) {
      run.mockImplementation(async (c, o) => c.kind === "get" && c.endpoint.startsWith("search/issues") ? response(data) : base(c, o));
      await expect(adapter.searchIssues({ text: "source" })).rejects.toBeInstanceOf(StapleError);
    }
    run.mockImplementation(async (c, o) => c.kind === "get" && c.endpoint === "repositories/42" ? response({ ...repo, id: 99 }) : base(c, o));
    await expect(adapter.readIssue({ ...adapter.scope, containerId: "42", id: "1", kind: "issue" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not silently refresh an issue transferred to a different repository", async () => {
    const { adapter, run } = fixture();
    const base = run.getMockImplementation()!;
    run.mockImplementation(async (c, o) => c.kind === "get" && c.endpoint === "repos/team/project/issues/1"
      ? response({ ...issue(), html_url: "https://github.example.com/team/elsewhere/issues/2" }) : base(c, o));
    await expect(adapter.readIssue({ ...adapter.scope, containerId: "42", id: "1", kind: "issue" })).rejects.toMatchObject({ code: "unavailable" });
  });
});
