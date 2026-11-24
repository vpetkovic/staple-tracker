import { afterEach, describe, expect, it, vi } from "vitest";
import { loadKindFilter, saveKindFilter } from "./last-kind";

afterEach(() => vi.unstubAllGlobals());
const memory = () => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
  return data;
};

describe("the link dialog's last-used filter", () => {
  it("defaults to All and remembers the last filter used in this browser", () => {
    const data = memory();
    expect(loadKindFilter()).toBe("all");
    saveKindFilter("pull_request");
    expect(loadKindFilter()).toBe("pull_request");
    expect([...data.entries()]).toEqual([["staple:link-kind:v1", "pull_request"]]);
  });
  it("ignores a stored value it does not know", () => {
    vi.stubGlobal("localStorage", { getItem: () => "repository" });
    expect(loadKindFilter()).toBe("all");
  });
  it("survives unavailable browser storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw Error("denied"); }, setItem: () => { throw Error("denied"); } });
    expect(loadKindFilter()).toBe("all");
    expect(() => saveKindFilter("issue")).not.toThrow();
  });
});
