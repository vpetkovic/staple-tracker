/**
 * The vocabulary draft — R6c (STA-178). "Statuses and Kinds retain every current
 * operation" made executable: each op settings-ops.ts builds is applied to a draft
 * here, and the draft shows what Save will produce, with the op queued for the batch.
 */
import { describe, expect, it } from "vitest";
import { addOp, recategorizeOp, removeOp, renameOp, reorderOp, type VocabularyRow } from "../settings-ops";
import { applyDraftOp, draftRefusalTargets, emptyDraft, isDraftDirty, moveDraftRow } from "./vocabulary-draft";

const rows = (...ids: string[]): VocabularyRow[] =>
  ids.map((id) => ({ id, label: id.toUpperCase(), isBuiltin: false, category: "unstarted" as const }));

const ids = (draft: { rows: VocabularyRow[] }) => draft.rows.map((r) => r.id);

describe("a fresh draft", () => {
  it("is the served rows, clean, with no ops queued", () => {
    const draft = emptyDraft(rows("a", "b"), { a: 2, b: 0 });
    expect(ids(draft)).toEqual(["a", "b"]);
    expect(draft.ops).toEqual([]);
    expect(isDraftDirty(draft)).toBe(false);
  });
});

describe("every operation is retained and projected", () => {
  const base = emptyDraft(rows("todo", "done"), { todo: 3, done: 1 });

  it("add — after a row, with the label the store would derive", () => {
    const next = applyDraftOp(base, addOp({ id: "awaiting_qa", after: "todo" }));
    expect(ids(next)).toEqual(["todo", "awaiting_qa", "done"]);
    expect(next.rows[1]).toMatchObject({ id: "awaiting_qa", label: "Awaiting Qa", isBuiltin: false });
    expect(next.usage["awaiting_qa"]).toBe(0);
    expect(next.ops).toEqual([{ op: "add", id: "awaiting_qa", after: "todo" }]);
    expect(isDraftDirty(next)).toBe(true);
  });

  it("add — appended with an explicit label and category", () => {
    const next = applyDraftOp(base, addOp({ id: "pairing", label: "Pairing", category: "active", after: null }));
    expect(ids(next)).toEqual(["todo", "done", "pairing"]);
    expect(next.rows[2]).toMatchObject({ label: "Pairing", category: "active" });
  });

  it("rename", () => {
    const next = applyDraftOp(base, renameOp("todo", " To do "));
    expect(next.rows[0]!.label).toBe("To do");
    expect(next.ops).toEqual([{ op: "rename", id: "todo", label: "To do" }]);
  });

  it("recategorize", () => {
    const next = applyDraftOp(base, recategorizeOp("todo", "ready"));
    expect(next.rows[0]!.category).toBe("ready");
    expect(next.ops).toEqual([{ op: "recategorize", id: "todo", category: "ready" }]);
  });

  it("reorder — the whole order, as the store wants it", () => {
    const next = applyDraftOp(base, reorderOp([{ id: "done" }, { id: "todo" }]));
    expect(ids(next)).toEqual(["done", "todo"]);
    expect(next.ops).toEqual([{ op: "reorder", ids: ["done", "todo"] }]);
  });

  it("reorder — a row the order did not name stays, at the end, for the store to judge", () => {
    const next = applyDraftOp(base, reorderOp([{ id: "done" }]));
    expect(ids(next)).toEqual(["done", "todo"]);
  });

  it("remove with migrate-to — the row goes and its count moves onto the target", () => {
    const next = applyDraftOp(base, removeOp("todo", "done"));
    expect(ids(next)).toEqual(["done"]);
    expect(next.usage).toEqual({ done: 4 });
    expect(next.ops).toEqual([{ op: "remove", id: "todo", migrateTo: "done" }]);
  });

  it("remove without a target — sent as the store expects, count dropped", () => {
    const next = applyDraftOp(base, removeOp("done", null));
    expect(ids(next)).toEqual(["todo"]);
    expect(next.usage).toEqual({ todo: 3 });
    expect(next.ops).toEqual([{ op: "remove", id: "done" }]);
  });

  it("never mutates the draft it was given, so Cancel is dropping a reference", () => {
    applyDraftOp(base, removeOp("todo", "done"));
    applyDraftOp(base, renameOp("todo", "x"));
    expect(ids(base)).toEqual(["todo", "done"]);
    expect(base.usage).toEqual({ todo: 3, done: 1 });
    expect(base.ops).toEqual([]);
  });
});

describe("ops accumulate in order", () => {
  it("a keyboard move, a rename and an add form one ordered batch", () => {
    let draft = emptyDraft(rows("a", "b", "c"), {});
    draft = moveDraftRow(draft, 2, 0);
    draft = applyDraftOp(draft, renameOp("c", "C!"));
    draft = applyDraftOp(draft, addOp({ id: "d", after: "a" }));
    expect(ids(draft)).toEqual(["c", "a", "d", "b"]);
    expect(draft.ops.map((op) => op.op)).toEqual(["reorder", "rename", "add"]);
  });

  it("a move off either end is a no-op and queues nothing", () => {
    const draft = emptyDraft(rows("a", "b"), {});
    expect(moveDraftRow(draft, 0, -1)).toBe(draft);
    expect(moveDraftRow(draft, 1, 2)).toBe(draft);
    expect(moveDraftRow(draft, 1, 1)).toBe(draft);
  });
});

describe("draftRefusalTargets", () => {
  it("offers every id, quoted and bare, plus the current label — including a removed id", () => {
    let draft = emptyDraft(rows("todo", "done"), { todo: 0, done: 0 });
    draft = applyDraftOp(draft, removeOp("todo"));
    const targets = draftRefusalTargets(draft);
    expect(targets.map((t) => t.id).sort()).toEqual(["done", "todo"]);
    expect(targets.find((t) => t.id === "done")!.terms).toEqual(['"done"', '"DONE"', "done"]);
    expect(targets.find((t) => t.id === "todo")!.terms).toEqual(['"todo"', "todo"]);
  });
});
