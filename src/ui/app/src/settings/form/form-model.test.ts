/**
 * The settings form's decisions — R6c (STA-178).
 *
 * Pure functions over plain data, in the manner of settings-ops.test.ts: no DOM, no
 * fetch, no React. What this suite pins is the contract the primitives rest on —
 * when Save, Cancel and Reset are enabled; when leaving needs a choice; what counts
 * as an external revision; which row or field a refusal belongs to; where focus lands
 * after a keyboard move; and what a field control refuses before the round trip.
 */
import { describe, expect, it } from "vitest";
import {
  actionBarState,
  attributeRefusal,
  hasConflict,
  leaveDecision,
  parseFieldInput,
  reorderFocusTarget,
  sameValue,
  snapshotSignature,
  validateFieldValue,
} from "./form-model";

describe("actionBarState — save, cancel, reset and dirty state agree", () => {
  it("a clean form can do nothing", () => {
    expect(actionBarState({ dirty: false, status: "idle" })).toEqual({
      canSave: false,
      canCancel: false,
      canReset: false,
      saving: false,
    });
  });

  it("a dirty form can save and cancel", () => {
    expect(actionBarState({ dirty: true, status: "idle" })).toMatchObject({ canSave: true, canCancel: true });
  });

  it("a blocked form (inline error, unresolved conflict) keeps cancel but not save", () => {
    expect(actionBarState({ dirty: true, status: "idle", blocked: true })).toMatchObject({
      canSave: false,
      canCancel: true,
    });
  });

  it("nothing is enabled while a save is pending, and the bar says so", () => {
    expect(actionBarState({ dirty: true, status: "pending", resettable: true })).toEqual({
      canSave: false,
      canCancel: false,
      canReset: false,
      saving: true,
    });
  });

  it("a failed save leaves the draft editable and saveable again", () => {
    expect(actionBarState({ dirty: true, status: "failed" })).toMatchObject({ canSave: true, canCancel: true });
  });

  it("reset is offered when the form has something away from its defaults, dirty or not", () => {
    expect(actionBarState({ dirty: false, status: "idle", resettable: true }).canReset).toBe(true);
    expect(actionBarState({ dirty: true, status: "idle", resettable: false }).canReset).toBe(false);
  });
});

describe("leaveDecision — leaving with unsaved changes is a choice", () => {
  it("proceeds when clean and asks when dirty", () => {
    expect(leaveDecision(false)).toBe("proceed");
    expect(leaveDecision(true)).toBe("confirm");
  });
});

describe("external revisions", () => {
  const rows = [{ id: "todo", label: "Todo" }];

  it("the signature is the served rows and nothing else", () => {
    expect(snapshotSignature(rows)).toBe(snapshotSignature([{ id: "todo", label: "Todo" }]));
    expect(snapshotSignature(rows)).not.toBe(snapshotSignature([{ id: "todo", label: "To do" }]));
  });

  it("a moved signature is a conflict only while the draft is dirty", () => {
    const baseline = snapshotSignature(rows);
    const served = snapshotSignature([{ id: "todo", label: "To do" }]);
    expect(hasConflict({ dirty: true, baseline, served })).toBe(true);
    expect(hasConflict({ dirty: false, baseline, served })).toBe(false);
    expect(hasConflict({ dirty: true, baseline, served: baseline })).toBe(false);
  });
});

describe("attributeRefusal — a server error lands on what it names", () => {
  const targets = [
    { id: "in_progress", terms: ['"in_progress"', '"In Progress"', "in_progress"] },
    { id: "in", terms: ['"in"', '"In"', "in"] },
    { id: "review", terms: ['"review"', '"Review"', "review"] },
  ];

  it("finds the row the store's sentence quotes", () => {
    expect(attributeRefusal('Status "review" already exists in workspace staple', targets)).toBe("review");
  });

  it("prefers the longest match, so a short id cannot steal a refusal", () => {
    expect(attributeRefusal("Unknown status: in_progress", targets)).toBe("in_progress");
  });

  it("matches a setting key inside the store's validation sentence", () => {
    const fields = [{ id: "queue.policy", terms: ['"queue.policy"', "queue.policy", '"Queue policy"'] }];
    expect(attributeRefusal('workspace "staple": "queue.policy" must be one of advisory, strict, got "x"', fields)).toBe(
      "queue.policy",
    );
  });

  it("names nothing when the sentence names nothing, so the section owns it", () => {
    expect(attributeRefusal("the store was not reached", targets)).toBeNull();
    expect(attributeRefusal("anything", [{ id: "x", terms: ["", "  "] }])).toBeNull();
  });
});

describe("reorderFocusTarget — focus survives a keyboard move", () => {
  it("stays on the button that was pressed while it is still enabled", () => {
    expect(reorderFocusTarget({ id: "b", index: 1, count: 3, control: "up" })).toEqual({ id: "b", control: "up" });
    expect(reorderFocusTarget({ id: "b", index: 1, count: 3, control: "down" })).toEqual({ id: "b", control: "down" });
  });

  it("moves to the other button when the row reached an end, where the pressed one is disabled", () => {
    expect(reorderFocusTarget({ id: "a", index: 0, count: 3, control: "up" })).toEqual({ id: "a", control: "down" });
    expect(reorderFocusTarget({ id: "c", index: 2, count: 3, control: "down" })).toEqual({ id: "c", control: "up" });
  });
});

describe("validateFieldValue — the client half of the store's schema check", () => {
  it("booleans", () => {
    expect(validateFieldValue({ type: "boolean" }, true)).toBeNull();
    expect(validateFieldValue({ type: "boolean" }, "yes")).toBe("Must be on or off.");
  });

  it("integers with bounds", () => {
    const port = { type: "integer" as const, min: 1, max: 65535 };
    expect(validateFieldValue(port, 4400)).toBeNull();
    expect(validateFieldValue(port, 0)).toBe("Must be at least 1.");
    expect(validateFieldValue(port, 70000)).toBe("Must be at most 65535.");
    expect(validateFieldValue(port, 1.5)).toBe("Must be a whole number.");
    expect(validateFieldValue(port, "abc")).toBe("Must be a whole number.");
  });

  it("strings with a pattern, in the registry's own hint", () => {
    const schema = { type: "string" as const, pattern: "^[a-z]+$", patternHint: "Lowercase letters only." };
    expect(validateFieldValue(schema, "abc")).toBeNull();
    expect(validateFieldValue(schema, "ABC")).toBe("Lowercase letters only.");
    expect(validateFieldValue({ type: "string", pattern: "^x$" }, "y")).toBe("Not in the expected form.");
  });

  it("enums", () => {
    const schema = { type: "enum" as const, values: ["advisory", "strict"] };
    expect(validateFieldValue(schema, "strict")).toBeNull();
    expect(validateFieldValue(schema, "loose")).toBe("Must be one of advisory, strict.");
  });
});

describe("parseFieldInput and sameValue", () => {
  it("parses a number field's text into a number and leaves garbage as text", () => {
    expect(parseFieldInput({ type: "integer" }, " 42 ")).toBe(42);
    expect(parseFieldInput({ type: "integer" }, "abc")).toBe("abc");
    expect(parseFieldInput({ type: "integer" }, "")).toBe("");
    expect(parseFieldInput({ type: "string" }, "42")).toBe("42");
  });

  it("compares setting values structurally", () => {
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue("a", "b")).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1 })).toBe(true);
  });
});
