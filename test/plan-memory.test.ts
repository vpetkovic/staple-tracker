import { describe, expect, it } from "vitest";
import { browserStorage, loadPlanMemory, savePlanMemory, readPlanLens, withPlanLens } from "../src/ui/app/src/views/plan/plan-memory.js";

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } } as Storage;
}
describe("Plan memory", () => {
  it("restores lens, record, both scroll axes and phone column per workspace", () => {
    const store = storage();
    const memory = { lens: "timeline" as const, record: "idea-id", scroll: { timeline: { left: 800, top: 160 } }, column: { horizons: "h:launch" } };
    savePlanMemory("larkspur", memory, store);
    expect(loadPlanMemory("larkspur", store)).toEqual(memory);
    expect(loadPlanMemory("other", store)).toEqual({ lens: "ideas", record: null, scroll: {}, column: {} });
    savePlanMemory("larkspur", { ...memory, record: null }, store);
    expect(loadPlanMemory("larkspur", store).record).toBeNull();
  });
  it("fails safe on malformed or refused storage and a refused localStorage getter", () => {
    const store = storage();
    store.setItem("staple:plan:v1:larkspur", '{"lens":"broken","record":12,"scroll":{"timeline":{"left":-5,"top":8},"ideas":{"left":"oops","top":7}}}');
    expect(loadPlanMemory("larkspur", store)).toEqual({ lens: "ideas", record: null, scroll: { timeline: { left: 0, top: 8 } }, column: {} });
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
  it("reads a shareable lens, keeping workspace, filters and drawer URL intact", () => {
    expect(readPlanLens("?plan-lens=horizons")).toBe("horizons");
    expect(readPlanLens("?plan-lens=broken")).toBeNull();
    const url = new URL(withPlanLens("https://example.test/?ws=larkspur&view=plan&q=checkout&issue=idea-id", "timeline"));
    expect(url.searchParams.get("plan-lens")).toBe("timeline");
    expect(url.searchParams.get("q")).toBe("checkout");
    expect(url.searchParams.get("issue")).toBe("idea-id");
  });
});
