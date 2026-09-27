/**
 * The person's own name: read from `staple:me`, else the My tasks filter's `staple:me:v1`;
 * remembered in both; and field edits sign with it (else the server's "ui").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fieldTarget } from "../InlineProperties";
import { PERSON_KEY, personActor, readPersonName, rememberPersonName } from "./person";

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
  it("reads staple:me first, then the My tasks filter's staple:me:v1", () => {
    expect(readPersonName(fakeStore({ [PERSON_KEY]: "VP", "staple:me:v1": "vp-filter" }))).toBe("VP");
    expect(readPersonName(fakeStore({ "staple:me:v1": "vp-filter" }))).toBe("vp-filter");
    expect(readPersonName(fakeStore())).toBeNull();
  });

  it("never falls back to the working name", () => {
    expect(readPersonName(fakeStore({ "staple:actor": "codex-1" }))).toBeNull();
    expect(personActor(fakeStore({ "staple:actor": "codex-1" }))).toBeUndefined();
  });

  it("is remembered in both places, trimmed, and an empty name changes nothing", () => {
    const store = fakeStore();
    rememberPersonName("  VP ", store);
    expect([store.data.get(PERSON_KEY), store.data.get("staple:me:v1")]).toEqual(["VP", "VP"]);
    rememberPersonName("   ", store);
    expect(store.data.get(PERSON_KEY)).toBe("VP");
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
