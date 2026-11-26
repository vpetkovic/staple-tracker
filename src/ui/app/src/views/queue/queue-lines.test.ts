import { describe, expect, it } from "vitest";
import type { EffectiveQueueRow } from "@/lib/types";
import { effective, entry, queue } from "./fixtures";
import { planRows } from "./queue-model";
import { NO_FOLDS, revealOf, rowKey, sectionLayout, withReveal, type SectionFolds, type SectionInput } from "./queue-lines";

/** A plan: STA-1 an epic expanding to eight tasks (the next pick is the seventh), STA-2 a leaf; twelve open tasks after it. */
function input(over: { entries?: boolean } = {}): SectionInput {
  const expansion = Array.from({ length: 8 }, (_, i) =>
    effective({ identifier: `STA-1${i}`, position: i + 1, via: "STA-1", epicPath: ["STA-1"], eligibility: i === 6 ? "eligible" : "blocked" }),
  );
  const leaf = effective({ identifier: "STA-2", position: 9, eligibility: "blocked" });
  const after = Array.from({ length: 12 }, (_, i) => effective({ identifier: `STA-9${i}`, position: 10 + i, unqueued: true }));
  const withPlan = over.entries ?? true;
  const view = queue({
    entries: withPlan ? [entry({ identifier: "STA-1", kind: "epic", planPosition: 1 }), entry({ identifier: "STA-2", planPosition: 2 })] : [],
    effective: withPlan ? [...expansion, leaf, ...after] : after,
  });
  const next: EffectiveQueueRow | null = withPlan ? expansion[6]! : after[0]!;
  return { workspace: "staple", view, rows: planRows(view, [], "staple"), unqueued: after, next, known: new Map() };
}

const page: SectionFolds = NO_FOLDS;
const all: SectionFolds = { ...NO_FOLDS, containersOpen: false };

describe("which rows a section draws", () => {
  it("opens containers on a workspace page, five tasks first, with the rest counted", () => {
    const layout = sectionLayout(input(), page);
    const [epic, leaf] = layout.entries;
    expect(epic!.container).toBe(true);
    expect(epic!.open).toBe(true);
    expect(epic!.children.map((line) => (line.kind === "task" ? line.row.identifier : "caption"))).toEqual(["STA-10", "STA-11", "STA-12", "STA-13", "STA-14"]);
    expect(epic!.more).toEqual({ total: 8, page: 5, whole: false });
    expect(leaf!.container).toBe(false);
  });

  it("folds containers on All workspaces and marks the folded one holding the next pick", () => {
    const layout = sectionLayout(input(), all);
    expect(layout.entries[0]!.open).toBe(false);
    expect(layout.entries[0]!.children).toEqual([]);
    expect(layout.entries[0]!.holdsNext).toBe(true);
    expect(layout.keys).toEqual([rowKey("staple", "entry", "STA-1"), rowKey("staple", "entry", "STA-2")]);
  });

  it("shows every task once a container is shown whole, and marks the next pick's own row", () => {
    const layout = sectionLayout(input(), { ...page, whole: new Set(["STA-1"]) });
    const tasks = layout.entries[0]!.children.filter((line) => line.kind === "task");
    expect(tasks).toHaveLength(8);
    expect(tasks.filter((line) => line.isNext).map((line) => line.row.identifier)).toEqual(["STA-16"]);
    expect(layout.entries[0]!.holdsNext).toBe(false);
  });

  it("keeps the band after the plan folded while there is a plan, and pages it by ten when open", () => {
    expect(sectionLayout(input(), page).band).toMatchObject({ open: false, total: 12, rows: [] });
    const open = sectionLayout(input(), { ...page, bandOpen: true }).band!;
    expect(open.rows).toHaveLength(10);
    expect(open.more).toEqual({ total: 12, page: 10, whole: false });
  });

  it("opens the band with no plan on a workspace page, and not on All workspaces", () => {
    expect(sectionLayout(input({ entries: false }), page).band!.open).toBe(true);
    expect(sectionLayout(input({ entries: false }), all).band!.open).toBe(false);
  });

  it("lists every drawn row's key in page order: entries, their tasks, then the band", () => {
    const keys = sectionLayout(input(), { ...page, bandOpen: true }).keys;
    expect(keys[0]).toBe(rowKey("staple", "entry", "STA-1"));
    expect(keys[1]).toBe(rowKey("staple", "nested", "STA-10"));
    expect(keys[6]).toBe(rowKey("staple", "entry", "STA-2"));
    expect(keys.at(-1)).toBe(rowKey("staple", "band", "STA-99"));
    expect(keys).toHaveLength(2 + 5 + 10);
  });
});

describe("showing a task", () => {
  it("opens and pages the container that holds it", () => {
    const reveal = revealOf(input(), "STA-16")!;
    expect(reveal).toEqual({ place: "nested", entry: "STA-1", identifier: "STA-16", whole: true });
    const folds = withReveal(all, reveal);
    const layout = sectionLayout(input(), folds);
    expect(layout.keys).toContain(rowKey("staple", "nested", "STA-16"));
  });

  it("opens the band for a task after the plan, and finds a leaf entry as itself", () => {
    expect(revealOf(input(), "STA-91")).toEqual({ place: "band", identifier: "STA-91", whole: false });
    expect(revealOf(input(), "STA-2")).toEqual({ place: "entry", identifier: "STA-2" });
    expect(revealOf(input(), "NOPE-1")).toBeNull();
    expect(sectionLayout(input(), withReveal(page, revealOf(input(), "STA-91")!)).band!.open).toBe(true);
  });
});
