/**
 * The settings editor's arithmetic — O7b (STA-141).
 *
 * Everything here is a pure function over plain data, so this suite needs no DOM, no
 * fetch and no React. What it is actually protecting is the two places a vocabulary
 * editor goes quietly wrong:
 *
 *   1. a reorder that is not a PERMUTATION (an element duplicated, dropped, or landing
 *      one place off), because the store takes the whole list and would faithfully store
 *      whatever it was handed;
 *   2. a removal whose migrate-to picker offers the row being removed, which is a request
 *      to move rows onto something that will not exist a microsecond later.
 *
 * Imports are relative for the reason commands.test.ts's are: the repo-root vitest config
 * carries the app's `@` alias now, but a relative import does not care either way.
 */
import { describe, expect, it } from "vitest";
import {
  addOp,
  kindRows,
  labelChanged,
  migrateCandidates,
  moveId,
  moveIndex,
  recategorizeOp,
  removeOp,
  renameOp,
  reorderOp,
  statusRows,
  validateVocabularyId,
  type VocabularyRow,
} from "./settings-ops";
import type { WorkspaceKind, WorkspaceStatus } from "../lib/types";

const rows = (...ids: string[]): VocabularyRow[] =>
  ids.map((id) => ({ id, label: id.toUpperCase(), isBuiltin: false }));

describe("moveIndex", () => {
  it("moves an element down and keeps the list a permutation", () => {
    expect(moveIndex(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("moves an element up", () => {
    expect(moveIndex(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op for a move onto itself", () => {
    expect(moveIndex(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });

  /**
   * The keyboard buttons ask for `index - 1` at the top and `index + 1` at the bottom,
   * and a drag can finish past the last row. Clamping makes both a no-op rather than an
   * error the user has to interpret — and, crucially, never drops the element.
   */
  it("clamps an out-of-range target instead of losing the element", () => {
    expect(moveIndex(["a", "b", "c"], 0, -5)).toEqual(["a", "b", "c"]);
    expect(moveIndex(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
  });

  it("ignores an out-of-range source", () => {
    expect(moveIndex(["a", "b"], 7, 0)).toEqual(["a", "b"]);
  });

  it("never mutates its input", () => {
    const list = ["a", "b", "c"];
    moveIndex(list, 0, 2);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("keeps every id exactly once, for every pair of indices", () => {
    const list = ["a", "b", "c", "d", "e"];
    for (let from = 0; from < list.length; from += 1) {
      for (let to = 0; to < list.length; to += 1) {
        expect([...moveIndex(list, from, to)].sort()).toEqual([...list].sort());
      }
    }
  });
});

describe("moveId", () => {
  it("moves the dragged row to where the row it was dropped on sits", () => {
    expect(moveId(rows("a", "b", "c"), "c", "a").map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when the drop target is the row itself, or is unknown", () => {
    expect(moveId(rows("a", "b"), "a", "a").map((r) => r.id)).toEqual(["a", "b"]);
    expect(moveId(rows("a", "b"), "a", "nope").map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("op builders", () => {
  it("reorder carries EVERY id, in order — never a delta", () => {
    expect(reorderOp(rows("c", "a", "b"))).toEqual({ op: "reorder", ids: ["c", "a", "b"] });
  });

  it("rename trims, because a trailing space is not a rename anyone meant", () => {
    expect(renameOp("todo", "  Queued  ")).toEqual({ op: "rename", id: "todo", label: "Queued" });
  });

  it("recategorize carries the category and nothing else", () => {
    expect(recategorizeOp("todo", "active")).toEqual({ op: "recategorize", id: "todo", category: "active" });
  });

  /**
   * An empty label is OMITTED rather than sent as "". The store derives
   * `awaiting_qa` -> `Awaiting QA` itself, and the dialog only previews that derivation —
   * sending a label this client title-cased would be a second implementation of it.
   */
  it("add omits an empty label so the store derives one", () => {
    expect(addOp({ id: "awaiting_qa", label: "   ", category: "review", after: "in_review" })).toEqual({
      op: "add",
      id: "awaiting_qa",
      category: "review",
      after: "in_review",
    });
  });

  it("add keeps a label the user actually typed", () => {
    expect(addOp({ id: "pairing", label: "Pairing", category: "active" })).toEqual({
      op: "add",
      id: "pairing",
      label: "Pairing",
      category: "active",
    });
  });

  /**
   * `migrateTo` is absent rather than null when there is no target. The two are the same
   * thing to the store, and expressing it by omission keeps the wire body the same shape
   * the MCP tool documents.
   */
  it("remove omits migrateTo when there is no target", () => {
    expect(removeOp("spike")).toEqual({ op: "remove", id: "spike" });
    expect(removeOp("spike", null)).toEqual({ op: "remove", id: "spike" });
    expect(removeOp("spike", "")).toEqual({ op: "remove", id: "spike" });
    expect(removeOp("spike", "task")).toEqual({ op: "remove", id: "spike", migrateTo: "task" });
  });
});

describe("migrateCandidates", () => {
  it("never offers the row being removed as its own target", () => {
    expect(migrateCandidates(rows("backlog", "todo", "done"), "todo").map((r) => r.id)).toEqual([
      "backlog",
      "done",
    ]);
  });

  it("keeps configured order", () => {
    expect(migrateCandidates(rows("c", "a", "b"), "a").map((r) => r.id)).toEqual(["c", "b"]);
  });
});

describe("validateVocabularyId", () => {
  const existing = rows("backlog", "todo");

  it("accepts lowercase snake_case starting with a letter", () => {
    expect(validateVocabularyId("awaiting_qa", existing)).toBeNull();
    expect(validateVocabularyId("a", existing)).toBeNull();
  });

  it("refuses an empty id", () => {
    expect(validateVocabularyId("   ", existing)).toBe("An id is required.");
  });

  it.each(["Todo", "in-progress", "9lives", "with space", "_leading", "a".repeat(33)])(
    "refuses %s",
    (id) => {
      expect(validateVocabularyId(id, existing)).toContain("lowercase");
    },
  );

  /**
   * The duplicate check is a courtesy, not the authority — the store refuses a duplicate
   * primary key independently. It exists so the form can say so without a round trip.
   */
  it("names an id that already exists", () => {
    expect(validateVocabularyId("todo", existing)).toBe('"todo" already exists.');
  });

  it("says nothing about a valid id rather than saying ok", () => {
    expect(validateVocabularyId("pairing", existing)).toBeNull();
  });
});

describe("labelChanged", () => {
  const row: VocabularyRow = { id: "todo", label: "Todo", isBuiltin: true };

  /**
   * The label field commits on BLUR, so without this every tab through the list would
   * fire a rename — a write, an event-log entry and a settings-revision bump for nothing.
   */
  it("is false for the same label, with or without surrounding space", () => {
    expect(labelChanged(row, "Todo")).toBe(false);
    expect(labelChanged(row, "  Todo  ")).toBe(false);
  });

  it("is false for an emptied field, because clearing a label is not a rename", () => {
    expect(labelChanged(row, "")).toBe(false);
    expect(labelChanged(row, "   ")).toBe(false);
  });

  it("is true for an actual change", () => {
    expect(labelChanged(row, "Queued")).toBe(true);
  });
});

describe("row projections", () => {
  it("statusRows keeps the category; kindRows has none to keep", () => {
    const statuses: WorkspaceStatus[] = [
      { id: "todo", label: "Todo", category: "ready", sortOrder: 0, isBuiltin: true },
    ];
    const kinds: WorkspaceKind[] = [{ id: "task", label: "Task", sortOrder: 0, isBuiltin: true }];
    expect(statusRows(statuses)).toEqual([
      { id: "todo", label: "Todo", isBuiltin: true, category: "ready" },
    ]);
    expect(kindRows(kinds)).toEqual([{ id: "task", label: "Task", isBuiltin: true }]);
  });
});
