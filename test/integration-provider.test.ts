import { describe, expect, it, vi } from "vitest";
import type { ExternalItem, ExternalItemRef, IntegrationAdapter } from "../src/core/integrations/contracts.js";
import { IntegrationReader, externalItemKey } from "../src/core/integrations/provider.js";
import { integrationReadContract } from "./fixtures/integration-contract.js";
import { StapleError } from "../src/core/types.js";

/** Two different provider models, with the same public read contract. No network or credentials. */
function fixture(providerId: string, host: string, mode: string, statuses: string[]) {
  const scope = { providerId, host, scopeId: "tenant-1" };
  const items: ExternalItem[] = statuses.map((status, index) => ({
    ref: { ...scope, containerId: "container-1", id: `immutable-${index}`, kind: "issue" },
    key: `${providerId}-${index + 1}`, url: `https://${host}/issues/${index + 1}`,
    title: `Issue ${index + 1}`, body: "Source context", status: { id: status, name: status },
    fetchedAt: "2026-11-20T02:00:00Z",
  }));
  const adapter: IntegrationAdapter = {
    scope, label: providerId, connection: { id: "local-binding", mode },
    validate: async () => ({ state: "ready" }), readContainer: async () => null,
    listContainers: async () => ({ items: [{ id: "container-1", name: "A project", url: `https://${host}/project` }], nextCursor: null }),
    searchIssues: vi.fn(async (query) => {
      const index = query.cursor === undefined ? 0 : Number(query.cursor.replace("opaque:", ""));
      return { items: [items[index]!], nextCursor: index + 1 < items.length ? `opaque:${index + 1}` : null };
    }),
    resolve: vi.fn(async () => ({ ref: items[0]!.ref, key: items[0]!.key, url: items[0]!.url })),
    readIssue: vi.fn(async (ref) => items.find((item) => item.ref.id === ref.id)!),
  };
  return { adapter, items, reader: new IntegrationReader(adapter) };
}

for (const [provider, host, mode, states] of [
  ["github", "github.example.com", "cli", ["open", "closed"]],
  ["linear", "linear.example.com", "api", ["triage", "building", "review"]],
] as const) {
  integrationReadContract(provider, () => fixture(provider, host, mode, [...states]));
  describe(`${provider} adapter read contract`, () => {
    it("makes unsupported PR reads/searches explicit while still allowing a PR URL reference", async () => {
      const { adapter, reader, items } = fixture(provider, host, mode, [...states]);
      const ref: ExternalItemRef = { ...items[0]!.ref, kind: "pull_request" };
      vi.mocked(adapter.resolve).mockResolvedValue({ ref, key: "PR-1", url: `https://${host}/pull/1` });
      expect(reader.capabilities).toEqual({ readPullRequests: false, searchPullRequests: false });
      expect((await reader.resolve({ url: `https://${host}/pull/1` }))!.ref.kind).toBe("pull_request");
      await expect(reader.read(ref)).rejects.toMatchObject({ code: "protocol_unsupported" });
      await expect(reader.search("pull_request", { text: "fix" })).rejects.toMatchObject({ code: "protocol_unsupported" });
    });
  });
}

describe("provider-independent safety and identity", () => {
  it("keeps identity through transport, display and URL changes but distinguishes resource scopes", () => {
    const { adapter, items } = fixture("github", "github.example.com", "cli", ["open"]);
    const ref = items[0]!.ref;
    const api = { ...adapter, connection: { id: "other-binding", mode: "api" } };
    expect(externalItemKey(ref)).toBe(externalItemKey({ ...ref, host: "GITHUB.EXAMPLE.COM:443" }));
    expect(externalItemKey(ref)).toBe(externalItemKey({ ...ref, ...api.scope }));
    for (const change of [{ providerId: "other" }, { scopeId: "other" }, { containerId: "other" }, { id: "other" }, { kind: "pull_request" as const }]) {
      expect(externalItemKey({ ...ref, ...change })).not.toBe(externalItemKey(ref));
    }
  });

  it.each([
    "https://untrusted.example/issues/1", "http://github.example.com/issues/1",
    "https://user:secret@github.example.com/issues/1", "file:///tmp/issue", "not a url",
  ])("refuses unsafe or wrong-host URLs before the adapter runs: %s", async (url) => {
    const { adapter, reader } = fixture("github", "github.example.com", "cli", ["open"]);
    await expect(reader.resolve({ url })).rejects.toMatchObject({ code: "validation" });
    expect(adapter.resolve).not.toHaveBeenCalled();
  });

  it("passes cancellation and provider errors through without converting them to empty results", async () => {
    const { adapter, reader } = fixture("linear", "linear.example.com", "api", ["building"]);
    const options = { signal: new AbortController().signal };
    const failure = new StapleError("rate_limited", "Rate limited", { retryAfterSeconds: 30 });
    vi.mocked(adapter.searchIssues).mockRejectedValue(failure);
    await expect(reader.search("issue", { text: "fix" }, options)).rejects.toBe(failure);
    expect(adapter.searchIssues).toHaveBeenCalledWith({ text: "fix" }, options);
  });

  it("rejects cross-scope reads and mismatched adapter responses", async () => {
    const { adapter, reader, items } = fixture("github", "github.example.com", "cli", ["open"]);
    const ref = items[0]!.ref;
    await expect(reader.read({ ...ref, scopeId: "other" })).rejects.toMatchObject({ code: "validation" });
    expect(adapter.readIssue).not.toHaveBeenCalled();
    vi.mocked(adapter.readIssue).mockResolvedValue({ ...items[0]!, ref: { ...ref, id: "wrong-item" } });
    await expect(reader.read(ref)).rejects.toMatchObject({ code: "validation" });
  });

  it("uses optional PR metadata/search only when supplied by the adapter", async () => {
    const { adapter, items } = fixture("github", "github.example.com", "cli", ["open"]);
    const pr: ExternalItem = { ...items[0]!, ref: { ...items[0]!.ref, kind: "pull_request" } };
    const read = vi.fn(async () => pr);
    const search = vi.fn(async () => ({ items: [pr], nextCursor: null }));
    const reader = new IntegrationReader({ ...adapter, pullRequests: { read, search } });
    expect(reader.capabilities).toEqual({ readPullRequests: true, searchPullRequests: true });
    expect(await reader.read(pr.ref)).toBe(pr);
    expect((await reader.search("pull_request", { text: "fix" })).items).toEqual([pr]);
  });

  it("allows read-only PR metadata without requiring PR search", async () => {
    const { adapter, items } = fixture("github", "github.example.com", "api", ["open"]);
    const pr = { ...items[0]!, ref: { ...items[0]!.ref, kind: "pull_request" as const } };
    const reader = new IntegrationReader({ ...adapter, pullRequests: { read: async () => pr } });
    expect(reader.capabilities).toEqual({ readPullRequests: true, searchPullRequests: false });
    expect(await reader.read(pr.ref)).toEqual(pr);
    await expect(reader.search("pull_request", { text: "fix" })).rejects.toMatchObject({ code: "protocol_unsupported" });
  });

  it("keeps unavailable health and unknown references explicit", async () => {
    const { adapter, reader } = fixture("github", "github.example.com", "cli", ["open"]);
    adapter.validate = async () => ({ state: "missing_cli", message: "Install GitHub CLI on this machine" });
    vi.mocked(adapter.resolve).mockResolvedValue(null);
    expect(await reader.validate()).toMatchObject({ state: "missing_cli" });
    expect(await reader.resolve({ key: "missing", containerId: "container-1" })).toBeNull();
  });

  it("preserves provider-specific query parameters when resolving a pasted URL", async () => {
    const { adapter, reader, items } = fixture("github", "github.example.com", "cli", ["open"]);
    const url = `${items[0]!.url}?itemId=142#comment-1`;
    await reader.resolve({ url });
    expect(adapter.resolve).toHaveBeenCalledWith({ url }, undefined);
  });

  it("refuses leaked search results and display-key lookups from other containers", async () => {
    const { adapter, reader, items } = fixture("github", "github.example.com", "cli", ["open"]);
    await expect(reader.search("issue", { text: "source", containerId: "another" })).rejects.toMatchObject({ code: "validation" });
    await expect(reader.resolve({ key: "GH-1", containerId: "another" })).rejects.toMatchObject({ code: "validation" });
    vi.mocked(adapter.searchIssues).mockResolvedValue({ items: [{ ...items[0]!, ref: { ...items[0]!.ref, kind: "pull_request" } }], nextCursor: null });
    await expect(reader.search("issue", { text: "source" })).rejects.toMatchObject({ code: "validation" });
  });

  it("does not accept unsafe URLs or wrong provider identities returned by an adapter", async () => {
    const { adapter, reader, items } = fixture("github", "github.example.com", "cli", ["open"]);
    vi.mocked(adapter.resolve).mockResolvedValue({ ...items[0]!, url: "https://other.example/issues/1" });
    await expect(reader.resolve({ url: items[0]!.url })).rejects.toMatchObject({ code: "validation" });
    vi.mocked(adapter.resolve).mockResolvedValue({ ...items[0]!, ref: { ...items[0]!.ref, providerId: "other" } });
    await expect(reader.resolve({ url: items[0]!.url })).rejects.toMatchObject({ code: "validation" });
  });

  it("normalizes URL hosts without mutating provider-owned read results", async () => {
    const { adapter, reader, items } = fixture("linear", "linear.example.com", "api", ["building"]);
    const source = { ...items[0]!, url: "https://LINEAR.EXAMPLE.COM/work?itemId=142" };
    vi.mocked(adapter.readIssue).mockResolvedValue(source);
    const result = await reader.read(source.ref);
    expect(result.url).toBe("https://linear.example.com/work?itemId=142");
    expect(source.url).toContain("LINEAR.EXAMPLE.COM");
  });
});
