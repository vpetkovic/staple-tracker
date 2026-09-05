/**
 * U5 — the part of the create dialog that can be quietly wrong.
 *
 * A dialog is easy to eyeball; the translation from the form's state into one
 * ActionPayload is not. The properties pinned here are the ones a reviewer cannot see
 * by opening the page: which keys are OMITTED (an untouched field must not become `""`
 * or `[]`, because the store reads "absent" and "empty" differently), and that a blank
 * title is still sent so the STORE gets to refuse it in its own words rather than the
 * form quietly inventing a rule.
 *
 * R7 (STA-103) widened the form's state — `labels` and `blockedBy` are lists now that
 * they are chosen from a dropdown rather than typed into a box, and `blocking` joined
 * them. The PAYLOAD assertions below are unchanged from U5 on purpose: the shape that
 * reaches `store.createIssue` is a contract, and R7 only added a key to it.
 *
 * Relative imports, no "@/…": these predate the vitest alias and a relative import does
 * not care that one now exists.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_CREATE_FORM,
  buildCreatePayload,
  createFormDefaultKind,
  labelOptions,
  parentOptions,
  relationOptions,
  splitLabels,
  withoutValues,
  splitRefs,
  type CreateFormState,
} from "./createIssueForm";
import type { Issue, IssueRow } from "../lib/types";

function form(over: Partial<CreateFormState> = {}): CreateFormState {
  return { ...EMPTY_CREATE_FORM, ...over };
}

describe("splitLabels", () => {
  it("splits on commas and keeps multi-word labels intact", () => {
    expect(splitLabels("needs review, ui, back end")).toEqual(["needs review", "ui", "back end"]);
  });

  it("drops blanks left by a trailing or doubled comma", () => {
    expect(splitLabels("ui,,api,")).toEqual(["ui", "api"]);
  });

  it("de-duplicates, keeping first-seen order", () => {
    expect(splitLabels("ui, api, ui")).toEqual(["ui", "api"]);
  });

  it("is empty for an empty or whitespace-only box", () => {
    expect(splitLabels("")).toEqual([]);
    expect(splitLabels("   ")).toEqual([]);
  });
});

describe("splitRefs", () => {
  it("accepts commas, spaces, or both between refs", () => {
    expect(splitRefs("STA-1, STA-2 STA-3")).toEqual(["STA-1", "STA-2", "STA-3"]);
  });

  it("de-duplicates, keeping first-seen order", () => {
    expect(splitRefs("STA-2 STA-1 STA-2")).toEqual(["STA-2", "STA-1"]);
  });

  it("leaves case alone — the store resolves refs, not this form", () => {
    expect(splitRefs("sta-4")).toEqual(["sta-4"]);
  });
});

describe("buildCreatePayload", () => {
  it("sends only type, title, priority and kind when nothing else was filled in", () => {
    expect(buildCreatePayload(form({ title: "Ship the thing" }))).toEqual({
      type: "create",
      title: "Ship the thing",
      priority: "medium",
      // O1b (STA-125). Always present, like `priority`, because both come from a select
      // that is never empty — and both agree with the store's own create-time default,
      // so an untouched form produces what `staple new` with no flags produces.
      kind: "task",
    });
  });

  it("omits empty optional fields rather than sending empty strings or lists", () => {
    const payload = buildCreatePayload(
      form({ title: "t", description: "  ", parent: " ", labels: [], blockedBy: [], blocking: [] }),
    );
    // `kind` joined `priority` in the always-sent set with O1b (STA-125), and for the
    // same reason: both come from a select that is never empty, so there is no untouched
    // state to omit. The optional fields above are still omitted rather than blanked.
    expect(Object.keys(payload).sort()).toEqual(["kind", "priority", "title", "type"]);
  });

  it("carries every field through when they are filled in", () => {
    expect(
      buildCreatePayload(
        form({
          title: "  Add the create dialog  ",
          description: "  table stakes  ",
          priority: "high",
          kind: "bug",
          parent: " STA-12 ",
          labels: ["ui", "u5"],
          blockedBy: ["STA-13", "STA-9"],
          blocking: ["STA-20"],
        }),
      ),
    ).toEqual({
      type: "create",
      title: "Add the create dialog",
      description: "table stakes",
      priority: "high",
      kind: "bug",
      parent: "STA-12",
      labels: ["ui", "u5"],
      blockedBy: ["STA-13", "STA-9"],
      blocking: ["STA-20"],
    });
  });

  /**
   * The lists arrive from a dropdown now, so they cannot contain blanks — but they CAN
   * contain a duplicate, because a chip can be added, removed and re-added while a stale
   * option list is still on screen. Tidying here keeps that out of the store.
   */
  it("tidies the lists, since a chip set can still repeat itself", () => {
    const payload = buildCreatePayload(
      form({ title: "t", labels: ["ui", " ui ", "", "api"], blockedBy: ["STA-1", "STA-1"] }),
    );
    expect(payload.labels).toEqual(["ui", "api"]);
    expect(payload.blockedBy).toEqual(["STA-1"]);
  });

  /**
   * The load-bearing one. The form does NOT pre-check the title: `store.createIssue`
   * throws "Title is required", and that sentence is the one the user should read.
   * A client-side "please enter a title" would be a second copy of a rule that lives
   * in the store, and the two could drift.
   */
  it("still sends a blank title, so the store is the thing that refuses it", () => {
    expect(buildCreatePayload(form({ title: "   " }))).toEqual({
      type: "create",
      title: "",
      priority: "medium",
      kind: "task",
    });
  });
});

/**
 * O1b (STA-125) — the declared kind.
 *
 * Three properties, and the third is an acceptance criterion in its own right.
 */
describe("kind on the create form", () => {
  it("starts a fresh form on task, which is the store's own create-time default", () => {
    expect(EMPTY_CREATE_FORM.kind).toBe("task");
    expect(buildCreatePayload(form({ title: "t" })).kind).toBe("task");
  });

  it("sends whatever the select holds, since the select is never empty", () => {
    expect(buildCreatePayload(form({ title: "t", kind: "epic" })).kind).toBe("epic");
    // A kind the operator added is a legal value here. This module validates NOTHING —
    // `store.assertConfiguredKind()` owns that sentence, exactly as it owns the one about
    // an empty title.
    expect(buildCreatePayload(form({ title: "t", kind: "milestone" })).kind).toBe("milestone");
  });

  it("omits a blank kind rather than sending an empty string", () => {
    // Unreachable from the control, reachable from a caller assembling this state by
    // hand — and an empty string would be REFUSED, where an absent key is the store
    // applying its own default. Rule 1 at the top of createIssueForm.ts.
    expect(buildCreatePayload(form({ title: "t", kind: "   " })).kind).toBeUndefined();
  });

  /**
   * THE CRITERION: "choosing a parent does not change it."
   *
   * STA-120's premise is that a kind is DECLARED, never derived. Filing a ticket under
   * an epic does not make it a sub-anything, and the tempting little convenience — "you
   * picked a parent, so you must mean a task" — is exactly the derivation the whole epic
   * exists to refuse. It is one assertion because it is one line of code NOT being
   * written, and this is what keeps it unwritten.
   */
  it("is untouched by choosing a parent, in either direction", () => {
    const withParent = form({ title: "t", kind: "epic", parent: "STA-1" });
    expect(buildCreatePayload(withParent).kind).toBe("epic");
    expect(buildCreatePayload(withParent).parent).toBe("STA-1");

    // …and a parentless bug does not become a task on its way out either.
    expect(buildCreatePayload(form({ title: "t", kind: "bug" })).kind).toBe("bug");
  });
});

describe("createFormDefaultKind", () => {
  it("picks task whenever the workspace still has it, wherever it sits in the order", () => {
    expect(createFormDefaultKind(["epic", "task", "bug", "chore", "spike"])).toBe("task");
    // Ordering is a DISPLAY decision and must not double as a semantic one — the same
    // argument `store.defaultKind()` makes. Moving `epic` to the front of the vocabulary
    // to sort it first on a board must not make everything anyone files an epic.
    expect(createFormDefaultKind(["spike", "chore", "task"])).toBe("task");
  });

  it("falls back to the first kind only when the operator removed task", () => {
    expect(createFormDefaultKind(["story", "defect"])).toBe("story");
  });

  it("answers the constant before the vocabulary has arrived", () => {
    // The dialog can mount inside the first paint, before /api/settings resolves. A form
    // that opened on nothing would be worse than one that opens on the built-in default
    // and corrects itself — which is what the dialog does when the list lands.
    expect(createFormDefaultKind([])).toBe("task");
  });
});

// ------------------------------------------------------------------ options

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    identifier: "STA-1",
    title: "A task",
    description: null,
    status: "backlog",
    statusVersion: 0,
    kind: "task",
    priority: "medium",
    parentId: null,
    depth: 0,
    assignee: null,
    createdBy: null,
    labels: [],
    acceptanceCriteria: null,
    blockParentUntilDone: false,
    unblockOwner: null,
    unblockAction: null,
    originKind: "manual",
    originId: null,
    idempotencyKey: null,
    checkoutAgent: null,
    checkoutAt: null,
    blockedTransitionAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    estimatedSeconds: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...over,
  };
}

const row = (workspace: string, over: Partial<Issue>): IssueRow => ({
  workspace,
  issue: issue(over),
  claim: null,
});

const ROWS: IssueRow[] = [
  row("staple", { id: "a", identifier: "STA-1", title: "Ship it", labels: ["ui", "api"] }),
  row("staple", { id: "b", identifier: "STA-2", title: "Done thing", status: "done", labels: ["ui"] }),
  row("pinecone", { id: "c", identifier: "PC-1", title: "Import", labels: ["ui", "import"] }),
];

describe("parentOptions", () => {
  /**
   * R8 (STA-110) narrowed this claim rather than dropping it, and the narrowing is the
   * finding. BLOCKERS can cross a workspace — the hub has an edge for that, and
   * relationOptions below now offers them. A PARENT cannot, and there is nowhere to put
   * one: `issues.parent_id` is a local row id set from `requireRow(input.parent).id`,
   * `depth` is derived as `parent.depth + 1` in the same transaction, and the hub's
   * `cross_links` table has exactly one type, `blocks`. So this list stays restricted,
   * and stays restricted for a reason that is about storage rather than about policy.
   */
  it("offers only the target workspace, because a parent cannot live in another one", () => {
    expect(parentOptions(ROWS, "staple").map((o) => o.value)).toEqual(["STA-1", "STA-2"]);
    expect(parentOptions(ROWS, "pinecone").map((o) => o.value)).toEqual(["PC-1"]);
  });

  it("carries the workspace as a pill even though every option shares it", () => {
    expect(parentOptions(ROWS, "staple").every((o) => o.pill === "staple")).toBe(true);
  });

  it("carries the title as the hint, which is what makes it searchable by words", () => {
    expect(parentOptions(ROWS, "staple")[0]).toMatchObject({
      value: "STA-1",
      label: "STA-1",
      hint: "Ship it",
    });
  });

  it("carries the status, so the option can show the icon the main list shows", () => {
    expect(parentOptions(ROWS, "staple").map((o) => o.status)).toEqual(["backlog", "done"]);
  });

  it("is empty for a workspace with nothing in it, rather than falling back to everything", () => {
    expect(parentOptions(ROWS, "nowhere")).toEqual([]);
  });

  /** Nothing to point at yet is not the same as "point at anything". */
  it("is empty when no target workspace is known", () => {
    expect(parentOptions(ROWS, "")).toEqual([]);
  });
});

describe("relationOptions", () => {
  /**
   * The R8 correction, pinned. Cross-referencing across workspaces is what a hub is FOR,
   * and `Hub.addCrossLink` has always been able to hold the edge — HTTP just never
   * exposed it. R7 restricted these lists to one workspace; that was the wrong call and
   * this test is what stops it coming back.
   */
  it("offers every workspace, not just the target one", () => {
    expect(relationOptions(ROWS, "staple").map((o) => o.value)).toEqual([
      "STA-1",
      "STA-2",
      "PC-1",
    ]);
  });

  /**
   * Target workspace first. Same-workspace is the common case and stays one glance away;
   * ordering by workspace also keeps the foreign items grouped rather than interleaved,
   * which is what makes the pill scannable instead of decorative.
   */
  it("puts the target workspace first and keeps the rest after it", () => {
    expect(relationOptions(ROWS, "pinecone").map((o) => o.value)).toEqual([
      "PC-1",
      "STA-1",
      "STA-2",
    ]);
  });

  it("still offers everything when the target workspace is unknown", () => {
    expect(relationOptions(ROWS, "").map((o) => o.value)).toEqual(["STA-1", "STA-2", "PC-1"]);
  });

  it("pills each option with its OWN workspace, which is now load-bearing", () => {
    expect(relationOptions(ROWS, "staple").map((o) => o.pill)).toEqual([
      "staple",
      "staple",
      "pinecone",
    ]);
  });

  it("carries the status for the icon", () => {
    expect(relationOptions(ROWS, "staple").map((o) => o.status)).toEqual([
      "backlog",
      "done",
      "backlog",
    ]);
  });

  it("is stable under reordering of the input rows", () => {
    const shuffled: IssueRow[] = [ROWS[2]!, ROWS[0]!, ROWS[1]!];
    expect(relationOptions(shuffled, "staple").map((o) => o.value)).toEqual([
      "STA-1",
      "STA-2",
      "PC-1",
    ]);
  });
});

describe("withoutValues", () => {
  const options = parentOptions(ROWS, "staple");

  it("is everything when nothing is taken", () => {
    expect(withoutValues(options, [])).toHaveLength(2);
  });

  /**
   * The rule this encodes: a ref named as BOTH a blocker and a blockee is a two-node
   * cycle by construction. The store catches it — but only after the task exists, so
   * the refusal arrives attached to a task the user now has to clean up. Removing the
   * option is the only place that contradiction can be prevented rather than reported.
   */
  it("removes what the other relation already holds", () => {
    expect(withoutValues(options, ["STA-1"]).map((o) => o.value)).toEqual(["STA-2"]);
  });

  it("ignores a taken value that is not an option", () => {
    expect(withoutValues(options, ["PC-1"]).map((o) => o.value)).toEqual(["STA-1", "STA-2"]);
  });

  it("can empty the list, which is correct rather than a bug", () => {
    expect(withoutValues(options, ["STA-1", "STA-2"])).toEqual([]);
  });

  it("does not mutate the options it was given", () => {
    withoutValues(options, ["STA-1"]);
    expect(options).toHaveLength(2);
  });
});

describe("labelOptions", () => {
  /**
   * Labels are plain strings on the issue row — no join, no foreign key — so unlike
   * refs they are safe to gather from every workspace in scope. That asymmetry is the
   * whole reason these are two functions rather than one with a flag.
   */
  it("gathers every distinct label across all rows in scope", () => {
    expect(labelOptions(ROWS).map((o) => o.value).sort()).toEqual(["api", "import", "ui"]);
  });

  it("orders by how many issues carry the label, commonest first", () => {
    expect(labelOptions(ROWS)[0]).toMatchObject({ value: "ui", count: 3 });
  });

  it("breaks a count tie alphabetically, so the list does not shuffle between polls", () => {
    expect(labelOptions(ROWS).map((o) => o.value)).toEqual(["ui", "api", "import"]);
  });

  it("carries no pill — a label is not owned by a workspace", () => {
    expect(labelOptions(ROWS).every((o) => o.pill === undefined)).toBe(true);
  });

  it("is empty when nothing is labelled", () => {
    expect(labelOptions([row("staple", { labels: [] })])).toEqual([]);
  });
});

describe("project on the create form", () => {
  it("starts on no project, and omits the key rather than sending an empty string", () => {
    expect(EMPTY_CREATE_FORM.project).toBe("");
    expect(buildCreatePayload(form({ title: "t" }))).not.toHaveProperty("project");
    expect(buildCreatePayload(form({ title: "t", project: "  " }))).not.toHaveProperty("project");
  });

  it("sends the chosen project's id", () => {
    expect(buildCreatePayload(form({ title: "t", project: "p-docs" })).project).toBe("p-docs");
  });
});
