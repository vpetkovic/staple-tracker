/**
 * U5 — the part of the create dialog that can be quietly wrong.
 *
 * A dialog is easy to eyeball; the translation from six text boxes into one
 * ActionPayload is not. The properties pinned here are the ones a reviewer cannot see
 * by opening the page: which keys are OMITTED (an empty box must not become `""` or
 * `[]`, because the store reads "absent" and "empty" differently), and that a blank
 * title is still sent so the STORE gets to refuse it in its own words rather than the
 * form quietly inventing a rule.
 *
 * Relative imports, no "@/…": there is no vitest config at the repo root, so the app's
 * alias does not exist at test time.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_CREATE_FORM,
  buildCreatePayload,
  splitLabels,
  splitRefs,
  type CreateFormState,
} from "./createIssueForm";

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
  it("sends only type, title and priority when nothing else was filled in", () => {
    expect(buildCreatePayload(form({ title: "Ship the thing" }))).toEqual({
      type: "create",
      title: "Ship the thing",
      priority: "medium",
    });
  });

  it("omits empty optional fields rather than sending empty strings or lists", () => {
    const payload = buildCreatePayload(form({ title: "t", description: "  ", parent: " ", labels: ",", blockedBy: "" }));
    expect(Object.keys(payload).sort()).toEqual(["priority", "title", "type"]);
  });

  it("carries every field through when they are filled in", () => {
    expect(
      buildCreatePayload(
        form({
          title: "  Add the create dialog  ",
          description: "  table stakes  ",
          priority: "high",
          parent: " STA-12 ",
          labels: "ui, u5",
          blockedBy: "STA-13, STA-9",
        }),
      ),
    ).toEqual({
      type: "create",
      title: "Add the create dialog",
      description: "table stakes",
      priority: "high",
      parent: "STA-12",
      labels: ["ui", "u5"],
      blockedBy: ["STA-13", "STA-9"],
    });
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
    });
  });
});
