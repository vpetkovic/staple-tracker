import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLinkDefaults, saveLinkDefaults, resolveLinkDefaults, loadPickerDefaults, rememberLinkChoices } from "./link-defaults";
import type { ProviderConnection } from "../../../../core/integrations/connections";
const connections = [{ id: "work", host: "github.com" }, { id: "private", host: "git.example" }] as ProviderConnection[];
const saved = { connectionId: "work", repository: "github.com/42", kind: "pull_request" as const };
afterEach(() => vi.unstubAllGlobals());
describe("link dialog defaults", () => {
  it("persists only selections, isolated by workspace", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    expect(saveLinkDefaults("one", { ...saved, search: "private source text" } as typeof saved)).toBe(true);
    expect(loadLinkDefaults("one")).toEqual(saved);
    expect(loadLinkDefaults("two")).toBeNull();
    expect([...data.values()][0]).not.toContain("private source text");
  });
  it("uses saved defaults until first use, remembers choices only when enabled, and can return to saved defaults", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    const last = { connectionId: "private", repository: "git.example/7", kind: "issue" as const };
    saveLinkDefaults("one", saved);
    expect(rememberLinkChoices("one", last)).toBe(false);
    expect(loadPickerDefaults("one", connections, [saved.repository, last.repository])).toEqual(saved);
    saveLinkDefaults("one", { ...saved, rememberLastUsed: true });
    expect(loadPickerDefaults("one", connections, [saved.repository, last.repository])).toEqual({ ...saved, rememberLastUsed: true });
    expect(rememberLinkChoices("one", last)).toBe(true);
    expect(loadPickerDefaults("one", connections, [saved.repository, last.repository])).toEqual(last);
    expect(loadPickerDefaults("two", connections, [last.repository]).connectionId).toBe("");
    saveLinkDefaults("one", saved);
    expect(loadPickerDefaults("one", connections, [saved.repository, last.repository])).toEqual(saved);
  });
  it("survives corrupt or unavailable browser storage and reports failed saves", () => {
    vi.stubGlobal("localStorage", { getItem: () => '{"kind":"invalid"}' });
    expect(loadLinkDefaults("one")).toBeNull();
    vi.stubGlobal("localStorage", { getItem: () => { throw Error("denied"); }, setItem: () => { throw Error("denied"); } });
    expect(loadLinkDefaults("one")).toBeNull();
    expect(saveLinkDefaults("one", saved)).toBe(false);
  });
  it("restores a configured connection and repository", () => {
    expect(resolveLinkDefaults(saved, connections, ["github.com/42"])).toEqual(saved);
  });
  it("falls back to cached-only after account removal, without choosing the sole remaining account", () => {
    expect(resolveLinkDefaults(saved, connections.slice(1), ["github.com/42"]))
      .toEqual({ connectionId: "", repository: "", kind: "pull_request" });
  });
  it("drops removed and foreign-host repositories while preserving type", () => {
    expect(resolveLinkDefaults(saved, connections, []).repository).toBe("");
    expect(resolveLinkDefaults({ ...saved, connectionId: "private" }, connections, [saved.repository]).repository).toBe("");
  });
  it("preserves explicit cached-only; auto-selects a sole connection only without saved defaults", () => {
    expect(resolveLinkDefaults({ ...saved, connectionId: "" }, connections.slice(0, 1), []).connectionId).toBe("");
    expect(resolveLinkDefaults(null, connections.slice(0, 1), []).connectionId).toBe("work");
    expect(resolveLinkDefaults(null, connections, []).connectionId).toBe("");
  });
});
