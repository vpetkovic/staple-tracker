/**
 * The person's own name: read from `staple:me`, else the My tasks filter's `staple:me:v1`;
 * remembered in both; and field edits sign with it (else the server's "ui").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fieldTarget } from "../InlineProperties";
import { PERSON_KEY, SEEN_FILTER_KEY, personActor, readPersonName, rememberPersonName } from "./person";

function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("the person's own name", () => {
  it("uses the detail's name, or the My tasks filter's when the detail has none", () => {
    expect(readPersonName(fakeStore({ [PERSON_KEY]: "VP" }))).toBe("VP");
    expect(readPersonName(fakeStore({ "staple:me:v1": "vp-filter" }))).toBe("vp-filter");
    expect(readPersonName(fakeStore())).toBeNull();
  });

  it("never falls back to the working name", () => {
    expect(readPersonName(fakeStore({ "staple:actor": "codex-1" }))).toBeNull();
    expect(personActor(fakeStore({ "staple:actor": "codex-1" }))).toBeUndefined();
  });

  it("never writes the My tasks filter's name (a free-text name would filter to nobody)", () => {
    const store = fakeStore();
    rememberPersonName("  Vlad P ", store);
    expect(store.data.get(PERSON_KEY)).toBe("Vlad P");
    expect(store.data.has("staple:me:v1")).toBe(false);
    rememberPersonName("   ", store);
    expect(store.data.get(PERSON_KEY)).toBe("Vlad P");
  });

  it("uses whichever of the two was set most recently", () => {
    const store = fakeStore({ "staple:me:v1": "vuk" });
    // The detail is given a name after the filter's: the detail's is newer.
    rememberPersonName("VP", store);
    expect(readPersonName(store)).toBe("VP");
    // The name is then corrected through the filter: the filter's is newer.
    store.setItem("staple:me:v1", "vpetkovic");
    expect(readPersonName(store)).toBe("vpetkovic");
    // And given again in the detail: the detail's is newer again.
    rememberPersonName("Vlad P", store);
    expect(readPersonName(store)).toBe("Vlad P");
  });

  it("notices a filter name set for the first time after the detail's", () => {
    const store = fakeStore();
    rememberPersonName("Vlad P", store);
    expect(store.data.has(SEEN_FILTER_KEY)).toBe(false);
    store.setItem("staple:me:v1", "vpetkovic");
    expect(readPersonName(store)).toBe("vpetkovic");
  });
});

describe("field edits sign as the person", () => {
  it("carry the person's name when set, and no actor (the server's 'ui') otherwise", () => {
    vi.stubGlobal("localStorage", fakeStore({ [PERSON_KEY]: "VP", "staple:actor": "codex-1" }));
    expect(fieldTarget("staple", "id-1")).toEqual({ ws: "staple", ref: "id-1", actor: "VP" });
    vi.stubGlobal("localStorage", fakeStore({ "staple:actor": "codex-1" }));
    expect(fieldTarget("staple", "id-1")).toEqual({ ws: "staple", ref: "id-1" });
  });
});
