import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { ProbeCache } from "../src/core/integrations/health.js";
import type { ExternalItem, ExternalSearch, IntegrationAdapter } from "../src/core/integrations/contracts.js";
import type { WorkspaceHandle } from "../src/core/integrations/mapping.js";
import type { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (previous === undefined) delete process.env.STAPLE_HOME; else process.env.STAPLE_HOME = previous;
});

const issue = (repo: string, n = 1): ExternalItem => ({
  ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: repo, id: String(n), kind: "issue" },
  key: `team/repo${repo}#${n}`, url: `https://github.com/team/repo${repo}/issues/${n}`, title: `Issue ${n} in ${repo}`, body: null,
  status: { id: "open", name: "open" }, fetchedAt: "2026-11-24T00:00:00Z",
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "staple-mapping-")); dirs.push(home); process.env.STAPLE_HOME = home;
  const handles: WorkspaceHandle[] = ["alpha", "beta", "gamma"].map(slug => ({ slug, store: initWorkspace({ global: true, slug }).store }));
  const failing = new Set<string>();
  const adapter: IntegrationAdapter = {
    scope: { providerId: "github", host: "github.com", scopeId: "host" }, label: "GitHub", connection: { id: "gh", mode: "cli" },
    validate: vi.fn(async () => ({ state: "ready" as const, identity: { login: "vpetkovic" } })),
    listContainers: vi.fn(async () => ({ items: ["42", "43", "44"].map(id => ({ id, name: `team/repo${id}`, url: `https://github.com/team/repo${id}` })), nextCursor: null })),
    readContainer: vi.fn(async (id: string) => ({ id, name: `team/repo${id}`, url: `https://github.com/team/repo${id}` })),
    searchIssues: vi.fn(async (q: ExternalSearch) => {
      if (!q.containerId) throw new Error("searched all of github.com");
      if (failing.has(q.containerId)) throw new StapleError("auth", "Sign in to GitHub CLI on this machine for the configured host");
      return { items: [issue(q.containerId)], nextCursor: q.cursor ? null : `more-${q.containerId}` };
    }),
    resolve: vi.fn(async ({ url }: { url: string }) => {
      const repo = /repo([0-9]+)\/issues\/([0-9]+)/.exec(url)!;
      const item = issue(repo[1]!, Number(repo[2]));
      return { ref: item.ref, key: item.key, url: item.url };
    }),
    readIssue: vi.fn(async (ref) => issue(ref.containerId, Number(ref.id))),
  };
  const caches = { health: new ProbeCache<never>(), detection: new ProbeCache<Array<{ host: string; login: string }>>() } as never;
  const ops = (store: WorkspaceStore) => new IntegrationOperations(store, { home, factories: new Map([["github:cli", () => adapter]]), caches,
    gh: async () => "", workspaces: () => handles });
  const [alpha, beta, gamma] = handles.map(h => ops(h.store)) as [IntegrationOperations, IntegrationOperations, IntegrationOperations];
  return { handles, adapter, failing, alpha, beta, gamma };
}
type Search = { remote: Array<{ targetKey: string; item: ExternalItem }>; nextCursor: string | null; scope: { mode: string; workspaces: string[]; targets: Array<{ key: string }> };
  failures: Array<{ connectionId: string | null; targetKeys: string[]; state: string }> };
const searched = (adapter: IntegrationAdapter) => vi.mocked(adapter.searchIssues).mock.calls.map(([q]) => q.containerId).sort();

async function connectAndMap(t: ReturnType<typeof setup>) {
  const { id } = await t.alpha.execute({ action: "configure", host: "github.com", account: "vpetkovic" }) as { id: string };
  await t.alpha.execute({ action: "map", connectionId: id, containerId: "42", actor: "ada" });
  await t.beta.execute({ action: "map", connectionId: id, containerId: "43", actor: "ada" });
  vi.mocked(t.adapter.searchIssues).mockClear();
  return id;
}

describe("workspace mapping", () => {
  it("maps and unmaps a repository with its stored name, retiring the legacy list", async () => {
    const t = setup();
    const { id } = await t.alpha.execute({ action: "configure", host: "github.com", account: "vpetkovic" }) as { id: string };
    t.handles[0]!.store.setSetting("integrations.repositories", "github.com/44", "ada");
    const mapped = await t.alpha.execute({ action: "map", connectionId: id, containerId: "42", actor: "ada" });
    expect(mapped).toEqual({ workspace: "alpha", targets: [
      { key: "github.com/44", providerId: "github", host: "github.com", scopeId: "host", kind: "repository", containerId: "44", name: null, url: null, connectionId: id },
      { key: "github.com/42", providerId: "github", host: "github.com", scopeId: "host", kind: "repository", containerId: "42", name: "team/repo42", url: "https://github.com/team/repo42", connectionId: id },
    ] });
    expect(t.handles[0]!.store.getSetting("integrations.repositories")).toBe("");
    expect(JSON.parse(String(t.handles[0]!.store.getSetting("integrations.mapping")))).toHaveLength(2);
    // Reading fills the name the legacy entry never stored.
    expect((await t.alpha.execute({ action: "mapping" }) as { targets: Array<{ key: string; name: string | null }> }).targets.map(x => x.name)).toEqual(["team/repo44", "team/repo42"]);
    await t.alpha.execute({ action: "unmap", targetKey: "github.com/44", actor: "ada" });
    const all = await t.alpha.execute({ action: "mapping", allWorkspaces: true }) as { workspaces: Array<{ workspace: string; targets: Array<{ key: string }> }> };
    expect(all.workspaces.map(w => [w.workspace, w.targets.map(x => x.key)])).toEqual([["alpha", ["github.com/42"]], ["beta", []], ["gamma", []]]);
  });

  it("names a legacy entry from an issue already linked in that repository", async () => {
    const t = setup();
    t.handles[1]!.store.setSetting("integrations.repositories", "github.com/43", "ada");
    t.handles[1]!.store.externalLinks().remember(issue("43", 7));
    const mapping = await t.beta.execute({ action: "mapping" }) as { targets: Array<{ name: string | null }> };
    expect(mapping.targets[0]!.name).toBe("team/repo43");
  });
});

describe("search and link scope", () => {
  it("searches only the selected workspace's mapping, or every mapping from All workspaces or an unmapped workspace", async () => {
    const t = setup();
    await connectAndMap(t);
    const alpha = await t.alpha.execute({ action: "search", text: "x" }) as Search;
    expect([alpha.scope.mode, alpha.scope.workspaces, alpha.remote.map(r => r.targetKey)]).toEqual(["workspace", ["alpha"], ["github.com/42"]]);
    expect(searched(t.adapter)).toEqual(["42"]);
    vi.mocked(t.adapter.searchIssues).mockClear();
    const gamma = await t.gamma.execute({ action: "search", text: "x" }) as Search;
    expect([gamma.scope.mode, gamma.scope.workspaces]).toEqual(["configured", ["alpha", "beta"]]);
    expect(searched(t.adapter)).toEqual(["42", "43"]);
    vi.mocked(t.adapter.searchIssues).mockClear();
    const all = await t.alpha.execute({ action: "search", text: "x", allWorkspaces: true }) as Search;
    expect(all.scope.mode).toBe("all");
    expect(searched(t.adapter)).toEqual(["42", "43"]);
    await expect(t.alpha.execute({ action: "search", text: "x", containerKey: "github.com/43" })).rejects.toMatchObject({ code: "validation" });
  });

  it("never searches live with nothing mapped anywhere", async () => {
    const t = setup();
    await t.alpha.execute({ action: "configure", host: "github.com", account: "vpetkovic" });
    const result = await t.alpha.execute({ action: "search", text: "staple" }) as Search;
    expect(result).toMatchObject({ remote: [], nextCursor: null, failures: [], scope: { mode: "none", targets: [] } });
    expect(t.adapter.searchIssues).not.toHaveBeenCalled();
  });

  it("pages each target on its own cursor and returns a failed source as data", async () => {
    const t = setup();
    const id = await connectAndMap(t);
    t.failing.add("43");
    const first = await t.gamma.execute({ action: "search", text: "x" }) as Search;
    expect(first.remote.map(r => r.targetKey)).toEqual(["github.com/42"]);
    expect(first.failures).toEqual([{ connectionId: id, targetKeys: ["github.com/43"], state: "unauthenticated", message: expect.any(String),
      action: "Run gh auth login --hostname github.com on the computer running Staple." }]);
    vi.mocked(t.adapter.searchIssues).mockClear();
    const second = await t.gamma.execute({ action: "search", text: "x", cursor: first.nextCursor! }) as Search;
    expect(searched(t.adapter)).toEqual(["42"]);
    expect(second.nextCursor).toBeNull();
    await expect(t.gamma.execute({ action: "search", text: "other", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "cursor_invalid" });
  });

  it("links only what the same scope would search, naming the target to map when refused", async () => {
    const t = setup();
    const id = await connectAndMap(t);
    const ticket = t.handles[0]!.store.createIssue({ title: "Local work" });
    const url = "https://github.com/team/repo43/issues/5";
    const refused = await t.alpha.execute({ action: "link", url, ref: ticket.id, confirmed: true, actor: "ada" }).catch(e => e);
    expect(refused).toMatchObject({ code: "validation", detail: { reason: "outside_scope",
      target: { key: "github.com/43", name: "team/repo43", kind: "repository", containerId: "43", connectionId: id } } });
    await expect(t.alpha.execute({ action: "preview", url: "https://github.com/team/repo42/issues/5" })).resolves.toBeTruthy();
    await expect(t.alpha.execute({ action: "link", url, ref: ticket.id, confirmed: true, actor: "ada", allWorkspaces: true })).resolves.toBeTruthy();
    // Already linked: the cached resource is never refused.
    const resourceId = t.handles[0]!.store.externalLinks().list(ticket.id)[0]!.resource.id;
    const other = t.handles[0]!.store.createIssue({ title: "Second" });
    await expect(t.alpha.execute({ action: "link", resourceId, ref: other.id, confirmed: true, actor: "ada" })).resolves.toBeTruthy();
  });

  it("links any exact URL while nothing is mapped", async () => {
    const t = setup();
    await t.alpha.execute({ action: "configure", host: "github.com", account: "vpetkovic" });
    await expect(t.alpha.execute({ action: "preview", url: "https://github.com/team/repo99/issues/1" })).resolves.toBeTruthy();
  });
});
