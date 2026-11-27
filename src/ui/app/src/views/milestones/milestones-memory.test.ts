/**
 * What the Milestones page remembers per workspace: the folds a person chose and the Finished
 * shelf, read back tolerantly, pruned of milestones that no longer exist, and the defaults and
 * the Collapse all / Expand all control that read it.
 */
import { describe, expect, it } from "vitest";
import { foldAllAction, loadMilestonesMemory, milestonesMemoryKey, saveMilestonesMemory, sectionFolded, withAllFolded } from "./milestones-memory";

function memoryStorage(initial: Record<string, string> = {}): Storage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    get length() {
      return Object.keys(data).length;
    },
    clear: () => Object.keys(data).forEach((key) => delete data[key]),
    getItem: (key) => data[key] ?? null,
    key: (index) => Object.keys(data)[index] ?? null,
    removeItem: (key) => void delete data[key],
    setItem: (key, value) => void (data[key] = value),
  };
}

describe("the Milestones page's memory", () => {
  it("reads back what was saved, per workspace", () => {
    const storage = memoryStorage();
    saveMilestonesMemory("staple", { folded: { a: true, b: false }, finished: true }, ["a", "b"], storage);
    expect(loadMilestonesMemory("staple", storage)).toEqual({ folded: { a: true, b: false }, finished: true });
    expect(storage.data[milestonesMemoryKey("staple")]).toBeDefined();
    // Another workspace has its own, and nothing yet.
    expect(loadMilestonesMemory("exercises-api", storage)).toEqual({ folded: {}, finished: false });
  });

  it("drops the choice for a milestone that no longer exists when it saves", () => {
    const storage = memoryStorage();
    saveMilestonesMemory("staple", { folded: { kept: true, gone: false }, finished: false }, ["kept"], storage);
    expect(loadMilestonesMemory("staple", storage).folded).toEqual({ kept: true });
  });

  it("reads bad or missing data as no choice, keeping whatever entries are sound", () => {
    const key = milestonesMemoryKey("staple");
    expect(loadMilestonesMemory("staple", memoryStorage())).toEqual({ folded: {}, finished: false });
    expect(loadMilestonesMemory("staple", memoryStorage({ [key]: "{not json" }))).toEqual({ folded: {}, finished: false });
    expect(loadMilestonesMemory("staple", memoryStorage({ [key]: "[1,2]" }))).toEqual({ folded: {}, finished: false });
    expect(loadMilestonesMemory("staple", memoryStorage({ [key]: JSON.stringify({ folded: ["a"], finished: "yes" }) }))).toEqual({ folded: {}, finished: false });
    expect(loadMilestonesMemory("staple", memoryStorage({ [key]: JSON.stringify({ folded: { a: true, b: "no", c: 1 }, finished: true }) }))).toEqual({ folded: { a: true }, finished: true });
    // No storage at all (a private window), and storage that throws: nothing remembered, nothing thrown.
    expect(loadMilestonesMemory("staple", undefined)).toEqual({ folded: {}, finished: false });
    const throwing = { ...memoryStorage(), getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } } as Storage;
    expect(loadMilestonesMemory("staple", throwing)).toEqual({ folded: {}, finished: false });
    expect(() => saveMilestonesMemory("staple", { folded: { a: true }, finished: true }, ["a"], throwing)).not.toThrow();
  });

  it("folds a section with no remembered choice under the narrow width only, and a choice wins either way", () => {
    expect(sectionFolded({ folded: {} }, "a", true)).toBe(true);
    expect(sectionFolded({ folded: {} }, "a", false)).toBe(false);
    expect(sectionFolded({ folded: { a: false } }, "a", true)).toBe(false);
    expect(sectionFolded({ folded: { a: true } }, "a", false)).toBe(true);
  });

  it("collapses while any open section is unfolded, else expands, and writes the choice for every one", () => {
    expect(foldAllAction(["a", "b"], (id) => id === "a")).toBe("collapse");
    expect(foldAllAction(["a", "b"], () => true)).toBe("expand");
    const memory = { folded: { a: false, other: false }, finished: true };
    expect(withAllFolded(memory, ["a", "b"], true)).toEqual({ folded: { a: true, b: true, other: false }, finished: true });
    expect(withAllFolded(memory, ["a", "b"], false).folded).toMatchObject({ a: false, b: false });
  });
});
