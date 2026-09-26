/**
 * Quick filters (presets.ts) and the words on the chips (chip-words.ts). A preset is an
 * ordinary filter with a name, so every assertion here is about the FilterState it produces.
 */
import { describe, expect, it } from "vitest";
import { activeFilterChips, buildFilterContext } from "@/lib/filter-dimensions";
import { UNASSIGNED, emptyFilters, withDimension, type FilterState } from "@/lib/filters";
import { chipPhrase, dimensionWords, pluralKind, sentenceCase } from "./chip-words";
import {
  ME_STORAGE_KEY,
  coveredByPresets,
  filterPresets,
  loadMe,
  presetActive,
  saveMe,
  togglePreset,
  type PresetContext,
} from "./presets";

const SEED: PresetContext = {
  statuses: [
    { id: "backlog", category: "unstarted" },
    { id: "todo", category: "ready" },
    { id: "in_progress", category: "active" },
    { id: "pairing", category: "active" },
    { id: "in_review", category: "review" },
    { id: "blocked", category: "blocked" },
    { id: "done", category: "done" },
  ],
  kinds: ["task", "bug", "epic"],
  me: null,
};
const preset = (id: string, context = SEED) => filterPresets(context).find((p) => p.id === id)!;

describe("the quick filters", () => {
  it("cover the common questions, in a fixed order", () => {
    expect(filterPresets(SEED).map((p) => p.label)).toEqual([
      "My tasks",
      "In progress",
      "Blocked",
      "High priority",
      "Bugs",
      "Unassigned",
    ]);
  });

  it("follow the workspace's configured statuses by category — a custom active status is in progress too", () => {
    expect(preset("in-progress").dims).toEqual({ status: ["in_progress", "pairing"] });
    expect(preset("blocked").dims).toEqual({ status: ["blocked"] });
    // A vocabulary not loaded yet falls back to the built-in id rather than to nothing.
    expect(preset("in-progress", { ...SEED, statuses: [] }).dims).toEqual({ status: ["in_progress"] });
  });

  it("offer Bugs only where bug is a configured kind", () => {
    expect(filterPresets({ ...SEED, kinds: ["task", "epic"] }).map((p) => p.id)).not.toContain("bugs");
  });

  it("make High priority mean urgent or high, and Unassigned mean nobody", () => {
    expect(preset("high-priority").dims).toEqual({ priority: ["critical", "high"] });
    expect(preset("unassigned").dims).toEqual({ assignee: [UNASSIGNED] });
  });

  it("need to know who 'me' is before My tasks filters anything", () => {
    expect(preset("mine").dims).toEqual({});
    expect(presetActive(emptyFilters(), preset("mine"))).toBe(false);
    expect(preset("mine", { ...SEED, me: "vp" }).dims).toEqual({ assignee: ["vp"] });
  });
});

describe("one tap", () => {
  it("switches a preset on, and a second tap switches it off, back to exactly where it was", () => {
    const start = withDimension(emptyFilters(), "label", ["ui"]);
    const on = togglePreset(start, preset("high-priority"));
    expect(on.dims).toEqual({ label: ["ui"], priority: ["critical", "high"] });
    expect(presetActive(on, preset("high-priority"))).toBe(true);
    expect(togglePreset(on, preset("high-priority"))).toEqual(start);
  });

  it("replaces the dimension it owns: Blocked after In progress means blocked, not both", () => {
    const next = togglePreset(togglePreset(emptyFilters(), preset("in-progress")), preset("blocked"));
    expect(next.dims.status).toEqual(["blocked"]);
    expect(presetActive(next, preset("in-progress"))).toBe(false);
  });

  it("combines presets on different dimensions", () => {
    const next = togglePreset(togglePreset(emptyFilters(), preset("bugs")), preset("high-priority"));
    expect(next.dims).toEqual({ kind: ["bug"], priority: ["critical", "high"] });
  });

  it("is lit only by exactly its values — a hand-built superset is not the preset", () => {
    const superset: FilterState = withDimension(emptyFilters(), "priority", ["critical", "high", "medium"]);
    expect(presetActive(superset, preset("high-priority"))).toBe(false);
    const sameInAnotherOrder = withDimension(emptyFilters(), "priority", ["high", "critical"]);
    expect(presetActive(sameInAnotherOrder, preset("high-priority"))).toBe(true);
  });

  it("does not repeat a lit preset's values as chips beside it", () => {
    const on = togglePreset(withDimension(emptyFilters(), "label", ["ui"]), preset("high-priority"));
    const covered = coveredByPresets(on, filterPresets(SEED));
    expect([...covered].sort()).toEqual(["priority:critical", "priority:high"]);
    const chips = activeFilterChips(on, buildFilterContext([])).filter((c) => !covered.has(`${c.dimension}:${c.value}`));
    expect(chips.map((c) => c.dimension)).toEqual(["label"]);
  });
});

describe("'me' is remembered in this browser", () => {
  it("round-trips, and forgets on null", () => {
    const map = new Map<string, string>();
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    expect(loadMe(store)).toBeNull();
    saveMe("vp", store);
    expect(map.get(ME_STORAGE_KEY)).toBe("vp");
    expect(loadMe(store)).toBe("vp");
    saveMe(null, store);
    expect(loadMe(store)).toBeNull();
  });
});

describe("the words on a chip", () => {
  const phrase = (dimension: string, value: string, label = value) => chipPhrase({ dimension, value, label });

  it("say what the filter does, with no field name in front", () => {
    expect(phrase("status", "in_progress", "In Progress")).toBe("In progress");
    expect(phrase("kind", "bug", "Bug")).toBe("Bugs");
    expect(phrase("assignee", "vp")).toBe("Assigned to vp");
    expect(phrase("assignee", UNASSIGNED, "Unassigned")).toBe("Unassigned");
    expect(phrase("priority", "critical", "Urgent")).toBe("Urgent priority");
    expect(phrase("label", "done")).toBe("Tagged “done”");
    expect(phrase("milestone", "M-1", "Release 1.0")).toBe("In Release 1.0");
    expect(phrase("epic", "E", "R: orchestration")).toBe("Part of R: orchestration");
    expect(phrase("project", "p", "Docs")).toBe("In project Docs");
    expect(phrase("pickup", "gated", "Gated")).toBe("Waiting for approval");
    expect(phrase("text", "login", '"login"')).toBe("Matches “login”");
  });

  it("never let a label read as a status, which is what the old dimension prefix was for", () => {
    expect(phrase("label", "done")).not.toBe(phrase("status", "done", "Done"));
  });

  it("give the menu's headings plain names", () => {
    expect(dimensionWords("pickup", "Pickup state")).toBe("Ready for an agent");
    expect(dimensionWords("claim", "Claim")).toBe("Who is working on it");
    expect(dimensionWords("unknown", "Unknown")).toBe("Unknown");
  });

  it("pluralise and sentence-case the way a person would", () => {
    expect(pluralKind("Story")).toBe("Stories");
    expect(pluralKind("Chores")).toBe("Chores");
    expect(sentenceCase("Awaiting Approval")).toBe("Awaiting approval");
  });
});
