import { describe, expect, it } from "vitest";
import { browserStorage, keepFolds, loadPlanMemory, savePlanMemory, readPlanLens, withPlanLens } from "../src/ui/app/src/views/plan/plan-memory.js";

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } } as Storage;
}
describe("Plan memory", () => {
  it("restores lens, record, both scroll axes and phone column per workspace", () => {
    const store = storage();
    const memory = { lens: "timeline" as const, record: "idea-id", scroll: { timeline: { left: 800, top: 160 } }, column: { horizons: "h:launch" }, folded: { launch: true, none: false } };
    savePlanMemory("larkspur", memory, store);
    expect(loadPlanMemory("larkspur", store)).toEqual(memory);
    expect(loadPlanMemory("other", store)).toEqual({ lens: "ideas", record: null, scroll: {}, column: {}, folded: {} });
    savePlanMemory("larkspur", { ...memory, record: null }, store);
    expect(loadPlanMemory("larkspur", store).record).toBeNull();
  });
  it("fails safe on malformed or refused storage and a refused localStorage getter", () => {
    const store = storage();
    store.setItem("staple:plan:v1:larkspur", '{"lens":"broken","record":12,"scroll":{"timeline":{"left":-5,"top":8},"ideas":{"left":"oops","top":7}}}');
    expect(loadPlanMemory("larkspur", store)).toEqual({ lens: "ideas", record: null, scroll: { timeline: { left: 0, top: 8 } }, column: {}, folded: {} });
    store.setItem("staple:plan:v1:larkspur", "{");
    expect(loadPlanMemory("larkspur", store).lens).toBe("ideas");
    const refused = { getItem() { throw Error("denied"); }, setItem() { throw Error("full"); } } as unknown as Storage;
    expect(loadPlanMemory("larkspur", refused).record).toBeNull();
    expect(() => savePlanMemory("larkspur", loadPlanMemory("larkspur", store), refused)).not.toThrow();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage() { throw Error("denied"); } } });
    try { expect(browserStorage()).toBeUndefined(); expect(loadPlanMemory("larkspur").lens).toBe("ideas"); }
    finally { if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window"); }
  });
  it("keeps only a section's yes or no fold, whatever else the stored folds hold", () => {
    const store = storage();
    store.setItem("staple:plan:v1:larkspur", '{"folded":{"launch":true,"later":false,"none":true,"bad":"yes","worse":1,"":true,"nested":{"a":true}}}');
    expect(loadPlanMemory("larkspur", store).folded).toEqual({ launch: true, later: false, none: true });
    for (const folded of ["[true]", '"launch"', "null", "7", "[]"]) {
      store.setItem("staple:plan:v1:larkspur", `{"lens":"horizons","folded":${folded}}`);
      const memory = loadPlanMemory("larkspur", store);
      expect(memory.lens, folded).toBe("horizons");
      expect(memory.folded, folded).toEqual({});
    }
  });
  it("drops on save the folds of sections the plan no longer has", () => {
    expect(keepFolds({ launch: true, gone: false, none: true }, { later: true }, ["launch", "later", "none"])).toEqual({ launch: true, later: true, none: true });
    expect(keepFolds({ gone: true, none: false }, { none: true }, ["none"])).toEqual({ none: true });
  });
  it("reads a shareable lens, keeping workspace, filters and drawer URL intact", () => {
    expect(readPlanLens("?plan-lens=horizons")).toBe("horizons");
    expect(readPlanLens("?plan-lens=broken")).toBeNull();
    const url = new URL(withPlanLens("https://example.test/?ws=larkspur&view=plan&q=checkout&issue=idea-id", "timeline"));
    expect(url.searchParams.get("plan-lens")).toBe("timeline");
    expect(url.searchParams.get("q")).toBe("checkout");
    expect(url.searchParams.get("issue")).toBe("idea-id");
  });
});
