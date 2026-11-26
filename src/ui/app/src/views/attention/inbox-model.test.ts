/**
 * The Inbox's presentation model: the word on each row's action, the to-do a blocked row
 * carries, how a conflict's values print, which rows are drawn (and so walked by the keyboard
 * and the drawer), and what each key does on a focused row.
 */
import { describe, expect, it } from "vitest";
import type { AttentionRow } from "@/lib/types";
import { attentionSections } from "./attention-model";
import { actionWord, conflictValue, drawnRows, inboxKey, oldestAge, subjectCell, takesPlaceOf, unblockTodo } from "./inbox-model";

function row(over: Partial<AttentionRow> & Pick<AttentionRow, "key" | "kind">): AttentionRow {
  return {
    workspace: "app",
    label: over.kind,
    ref: "APP-1",
    runId: null,
    conflictId: null,
    conflict: null,
    title: "Title",
    detail: "detail",
    since: "2026-11-25T00:00:00.000Z",
    ageSeconds: 60,
    action: { verb: "open", label: "Open", command: "" },
    dismissible: false,
    ...over,
  };
}

describe("the action word", () => {
  it("is the verb's word, never the row's own label", () => {
    expect(actionWord("review")).toBe("Review");
    expect(actionWord("unblock")).toBe("Open");
    expect(actionWord("open")).toBe("Open");
    expect(actionWord("inspect")).toBe("View run");
    expect(actionWord("resolve")).toBe("Resolve");
  });
});

describe("the to-do a blocked row carries", () => {
  it("is the action's words on an unblock row, unless they are the bare verb", () => {
    expect(unblockTodo(row({ key: "a", kind: "person_blocked", action: { verb: "unblock", label: "Add the API key", command: "" } }))).toBe("Add the API key");
    expect(unblockTodo(row({ key: "b", kind: "person_blocked", action: { verb: "unblock", label: "Unblock", command: "" } }))).toBeNull();
    expect(unblockTodo(row({ key: "c", kind: "in_review", action: { verb: "review", label: "Open for review", command: "" } }))).toBeNull();
  });
});

describe("a conflict's values", () => {
  it("print strings as they are and anything else as JSON", () => {
    expect(conflictValue("in_review")).toBe("in_review");
    expect(conflictValue(3)).toBe("3");
    expect(conflictValue(null)).toBe("null");
    expect(conflictValue({ a: 1 })).toBe('{"a":1}');
    expect(conflictValue(undefined)).toBe("undefined");
  });
});

describe("the subject cell and the section's age", () => {
  it("names the ticket, or says run for a run with no ticket", () => {
    expect(subjectCell(row({ key: "a", kind: "gate_pending" }))).toBe("APP-1");
    expect(subjectCell(row({ key: "b", kind: "run_stopped", ref: null, runId: "0123456789ab" }))).toBe("run");
    expect(subjectCell(row({ key: "c", kind: "cloud_conflict", ref: null }))).toBe("");
  });

  it("is the longest wait in the section", () => {
    expect(oldestAge([row({ key: "a", kind: "x", ageSeconds: 5 }), row({ key: "b", kind: "x", ageSeconds: 90 })])).toBe(90);
  });
});

describe("the drawn rows", () => {
  const rows = [
    row({ key: "a", kind: "gate_pending", ref: "APP-1" }),
    row({ key: "b", kind: "in_review", ref: "APP-2", workspace: "web" }),
    row({ key: "c", kind: "run_stopped", ref: null, runId: "r1" }),
    row({ key: "d", kind: "run_stopped", ref: "APP-3", runId: "r2" }),
  ];
  const sections = attentionSections(rows);

  it("are every row of every open section, in order", () => {
    expect(drawnRows(sections, {}).map((r) => r.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("leave out a folded section's rows", () => {
    expect(drawnRows(sections, { in_review: true }).map((r) => r.key)).toEqual(["a", "c", "d"]);
  });
});

describe("the keyboard on a focused row", () => {
  const keys = ["a", "b", "c"];
  const plain = { dismissible: false, resolve: false, expanded: false };

  it("moves down and up with the arrows and j and k, and stops at the ends", () => {
    expect(inboxKey(keys, "a", "ArrowDown", plain)).toEqual({ focus: "b" });
    expect(inboxKey(keys, "a", "j", plain)).toEqual({ focus: "b" });
    expect(inboxKey(keys, "b", "ArrowUp", plain)).toEqual({ focus: "a" });
    expect(inboxKey(keys, "b", "k", plain)).toEqual({ focus: "a" });
    expect(inboxKey(keys, "c", "ArrowDown", plain)).toBeNull();
    expect(inboxKey(keys, "a", "ArrowUp", plain)).toBeNull();
  });

  it("jumps with Home and End", () => {
    expect(inboxKey(keys, "b", "Home", plain)).toEqual({ focus: "a" });
    expect(inboxKey(keys, "b", "End", plain)).toEqual({ focus: "c" });
  });

  it("acts on Enter and Space", () => {
    expect(inboxKey(keys, "b", "Enter", plain)).toEqual({ act: "b" });
    expect(inboxKey(keys, "b", " ", plain)).toEqual({ act: "b" });
  });

  it("dismisses on e, handing focus to the row that takes its place, else the one before", () => {
    const dismissible = { ...plain, dismissible: true };
    expect(inboxKey(keys, "b", "e", dismissible)).toEqual({ dismiss: "b", focus: "c" });
    expect(inboxKey(keys, "c", "e", dismissible)).toEqual({ dismiss: "c", focus: "b" });
    expect(inboxKey(["a"], "a", "e", dismissible)).toEqual({ dismiss: "a", focus: null });
    expect(inboxKey(keys, "b", "e", plain)).toBeNull();
  });

  it("opens a resolve row with Right and closes it with Left", () => {
    const resolve = { ...plain, resolve: true };
    expect(inboxKey(keys, "b", "ArrowRight", resolve)).toEqual({ expand: "b" });
    expect(inboxKey(keys, "b", "ArrowRight", { ...resolve, expanded: true })).toBeNull();
    expect(inboxKey(keys, "b", "ArrowLeft", { ...resolve, expanded: true })).toEqual({ collapse: "b" });
    expect(inboxKey(keys, "b", "ArrowLeft", resolve)).toBeNull();
    expect(inboxKey(keys, "b", "ArrowRight", plain)).toBeNull();
  });

  it("ignores a row it does not know and every other key", () => {
    expect(inboxKey(keys, "z", "ArrowDown", plain)).toBeNull();
    expect(inboxKey(keys, "a", "x", plain)).toBeNull();
  });
});

describe("the row that takes a departed row's place", () => {
  it("is the one now at its position, else the last, and none while the row is still listed", () => {
    expect(takesPlaceOf(["a", "b", "c"], ["a", "c"], "b")).toBe("c");
    expect(takesPlaceOf(["a", "b", "c"], ["a", "b"], "c")).toBe("b");
    // A refused write leaves the row where it was.
    expect(takesPlaceOf(["a", "b", "c"], ["a", "b", "c"], "b")).toBeNull();
    expect(takesPlaceOf(["a"], [], "a")).toBeNull();
  });
});
