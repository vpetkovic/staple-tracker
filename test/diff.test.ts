/**
 * The revision diff is a pure function, so it gets pure tests: no server, no DOM.
 *
 * These pin the two things a diff view can silently get wrong — line numbering across
 * a change, and which side a line lands on — plus the context collapsing, which is the
 * only part with an off-by-one worth guarding.
 */
import { describe, expect, it } from "vitest";
import { collapse, diffBodies, isSkip, type SkipRow, type UnifiedRow } from "../src/ui/app/src/detail/diff.js";

const lines = (...rows: string[]) => rows.join("\n") + "\n";

describe("diffBodies", () => {
  it("reports identical bodies as identical, with no counted changes", () => {
    const diff = diffBodies(lines("a", "b", "c"), lines("a", "b", "c"));
    expect(diff.identical).toBe(true);
    expect(diff.stats).toEqual({ added: 0, removed: 0 });
    expect(diff.unified.every((row) => row.kind === "same")).toBe(true);
  });

  it("does not invent a trailing blank line from the final newline", () => {
    const diff = diffBodies(lines("a", "b"), lines("a", "b"));
    expect(diff.unified).toHaveLength(2);
    expect(diff.unified.map((r) => r.text)).toEqual(["a", "b"]);
  });

  it("counts a pure insertion and numbers only the new side", () => {
    const diff = diffBodies(lines("a", "c"), lines("a", "b", "c"));
    expect(diff.stats).toEqual({ added: 1, removed: 0 });
    const inserted = diff.unified.find((row) => row.kind === "add")!;
    expect(inserted.text).toBe("b");
    expect(inserted.oldNo).toBeNull();
    expect(inserted.newNo).toBe(2);
    // The unchanged "c" moved down one line on the new side but not on the old.
    const c = diff.unified.find((row) => row.text === "c")!;
    expect(c).toMatchObject({ kind: "same", oldNo: 2, newNo: 3 });
  });

  it("counts a pure deletion and numbers only the old side", () => {
    const diff = diffBodies(lines("a", "b", "c"), lines("a", "c"));
    expect(diff.stats).toEqual({ added: 0, removed: 1 });
    const gone = diff.unified.find((row) => row.kind === "remove")!;
    expect(gone).toMatchObject({ text: "b", oldNo: 2, newNo: null });
  });

  it("pairs a replaced line onto one split row, before on the left and after on the right", () => {
    const diff = diffBodies(lines("a", "old", "c"), lines("a", "new", "c"));
    expect(diff.stats).toEqual({ added: 1, removed: 1 });
    const changed = diff.split.filter((row) => row.changed);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.left).toEqual({ no: 2, text: "old" });
    expect(changed[0]!.right).toEqual({ no: 2, text: "new" });
  });

  it("pads the shorter side when a block grows", () => {
    const diff = diffBodies(lines("a", "one", "z"), lines("a", "one-a", "one-b", "z"));
    const changed = diff.split.filter((row) => row.changed);
    expect(changed).toHaveLength(2);
    expect(changed[0]!.left).toEqual({ no: 2, text: "one" });
    expect(changed[0]!.right).toEqual({ no: 2, text: "one-a" });
    // The second inserted line has no counterpart on the left.
    expect(changed[1]!.left).toBeNull();
    expect(changed[1]!.right).toEqual({ no: 3, text: "one-b" });
  });

  it("keeps both projections telling the same story", () => {
    const before = lines("intro", "alpha", "beta", "gamma", "outro");
    const after = lines("intro", "alpha", "BETA", "gamma", "delta", "outro");
    const diff = diffBodies(before, after);
    const unifiedAdds = diff.unified.filter((r) => r.kind === "add").length;
    const splitAdds = diff.split.filter((r) => r.right && r.changed).length;
    expect(unifiedAdds).toBe(diff.stats.added);
    expect(splitAdds).toBe(diff.stats.added);
  });

  it("treats an empty document as an all-insert diff rather than throwing", () => {
    const diff = diffBodies("", lines("a", "b"));
    expect(diff.identical).toBe(false);
    expect(diff.stats).toEqual({ added: 2, removed: 0 });
  });
});

describe("collapse", () => {
  const same = (n: number): UnifiedRow => ({ kind: "same", oldNo: n, newNo: n, text: `line ${n}` });
  const add = (n: number): UnifiedRow => ({ kind: "add", oldNo: null, newNo: n, text: `new ${n}` });

  it("leaves a short unchanged run alone", () => {
    const rows = [same(1), same(2), add(3), same(4)];
    expect(collapse(rows, 3).filter(isSkip)).toHaveLength(0);
  });

  it("folds a long unchanged run into one marker and keeps the context lines", () => {
    const rows: UnifiedRow[] = [
      ...Array.from({ length: 20 }, (_, i) => same(i + 1)),
      add(21),
      ...Array.from({ length: 20 }, (_, i) => same(i + 22)),
    ];
    const out = collapse(rows, 3);
    const skips = out.filter(isSkip) as SkipRow[];
    expect(skips).toHaveLength(2);
    expect(skips[0]!.count).toBe(17);
    expect(skips[1]!.count).toBe(17);
    // 3 lines of context on each side of the change, plus the change itself.
    expect(out.filter((row) => !isSkip(row))).toHaveLength(7);
  });

  it("folds a wholly unchanged document into a single marker", () => {
    const rows = Array.from({ length: 10 }, (_, i) => same(i + 1));
    const out = collapse(rows, 3);
    expect(out).toHaveLength(1);
    expect(isSkip(out[0])).toBe(true);
  });

  it("collapses the split projection on the same rule", () => {
    const diff = diffBodies(
      Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
      Array.from({ length: 30 }, (_, i) => (i === 15 ? "CHANGED" : `line ${i}`)).join("\n"),
    );
    const out = collapse(diff.split, 3);
    expect(out.filter(isSkip).length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(diff.split.length);
  });
});
