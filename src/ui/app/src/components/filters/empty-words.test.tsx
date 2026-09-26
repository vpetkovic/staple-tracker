/**
 * The empty filtered page, in plain words, with its fixes one tap away (empty-words.ts,
 * FilterEmptyState.tsx). The decision is `explainNoMatches`; these pin what it SAYS.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters, type FilterState } from "@/lib/filters";
import type { Issue, IssueRow } from "@/lib/types";
import { plainEmptyExplanation } from "./empty-words";
import { FilterExplanation } from "./FilterEmptyState";

const row = (identifier: string, over: Partial<Issue>): IssueRow =>
  ({
    workspace: "staple",
    claim: null,
    issue: {
      id: identifier, identifier, title: identifier, description: null, status: "todo", statusVersion: 1, kind: "task",
      priority: "medium", parentId: null, depth: 0, assignee: null, createdBy: null, labels: [], acceptanceCriteria: null,
      blockParentUntilDone: false, unblockOwner: null, unblockAction: null, originKind: "human", originId: null,
      idempotencyKey: null, checkoutAgent: null, checkoutAt: null, blockedTransitionAt: null, startedAt: null,
      completedAt: null, cancelledAt: null, estimatedSeconds: null, createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z", ...over,
    },
  }) as IssueRow;

const ROWS = [
  row("A", { status: "in_progress", priority: "low", labels: ["ui"] }),
  row("B", { status: "in_progress", priority: "low" }),
  row("C", { status: "todo", priority: "high", kind: "bug" }),
];
const context = buildFilterContext(ROWS);
const state = (over: Partial<FilterState>): FilterState => ({ ...emptyFilters(), ...over });
const FIELD_NAMES = /\b(Status|Priority|Label|Kind|Pickup state|Assignee|Gate|Handoff|Claim|Search)\b/;

describe("the headline says it in the chips' own words", () => {
  it("names the one filter worth removing, and what removing it would show", () => {
    const why = plainEmptyExplanation(ROWS, state({ dims: { status: ["in_progress"], priority: ["high"] } }), context)!;
    expect(why.kind).toBe("narrowed");
    expect(why.headline).toBe("No task matches all of these filters. Removing one of them would bring tasks back:");
    expect(why.actions.map((a) => a.label)).toEqual(["Remove “In progress” · 1 task", "Remove “High priority” · 2 tasks"]);
    expect(why.headline).not.toMatch(FIELD_NAMES);
  });

  it("says a single fix as a sentence", () => {
    const why = plainEmptyExplanation(ROWS, state({ dims: { kind: ["bug"], label: ["ui"] } }), context)!;
    expect(why.headline).not.toMatch(FIELD_NAMES);
    expect(why.actions.every((a) => !FIELD_NAMES.test(a.label))).toBe(true);
  });

  it("calls an impossible pair impossible, with the reason in plain words", () => {
    const why = plainEmptyExplanation(ROWS, state({ dims: { status: ["done"], pickup: ["pickable"] }, showDone: true }), context)!;
    expect(why.kind).toBe("impossible");
    expect(why.headline).toBe(
      "“Done” and “Ready to pick up” cannot both be true — finished work is never waiting to be picked up. Remove one of them.",
    );
    expect(why.actions.map((a) => a.id)).toEqual(["status", "pickup"]);
    // The model's own sentence is kept for Show details.
    expect(why.detail).toContain("Status and Pickup state cannot both be true");
  });

  it("says plainly when only the combination is empty", () => {
    const why = plainEmptyExplanation(ROWS, state({ dims: { status: ["todo"], priority: ["low"] }, text: "zzz" }), context)!;
    expect(why.kind).toBe("together");
    expect(why.headline).toContain("removing any one of them still leaves nothing");
    expect(why.actions).toEqual([]);
  });

  it("is nothing when nothing is filtering", () => {
    expect(plainEmptyExplanation(ROWS, emptyFilters(), context)).toBeNull();
  });
});

describe("the fix is one tap", () => {
  it("each action removes exactly its filter", () => {
    const asked = state({ dims: { status: ["in_progress"], priority: ["high"] } });
    const why = plainEmptyExplanation(ROWS, asked, context)!;
    expect(why.actions[0]!.apply(asked).dims).toEqual({ priority: ["high"] });
    const search = plainEmptyExplanation(ROWS, state({ text: "zzz" }), context)!;
    expect(search.actions[0]!.apply(state({ text: "zzz" })).text).toBe("");
  });

  it("renders a button per fix and Clear all right there, with the technical sentence behind Show details", () => {
    const asked = state({ dims: { status: ["in_progress"], priority: ["high"] } });
    const markup = renderToStaticMarkup(<FilterExplanation rows={ROWS} state={asked} context={context} onChange={() => {}} />);
    expect(markup).toContain('data-filter-explanation-action="status"');
    expect(markup).toContain('data-filter-explanation-action="priority"');
    expect(markup).toContain("data-filter-explanation-clear");
    expect(markup).toContain(">Clear all<");
    const headline = /data-filter-explanation-headline[^>]*>([^<]*)</.exec(markup)?.[1] ?? "";
    expect(headline).not.toMatch(FIELD_NAMES);
    expect(markup.indexOf("Show details")).toBeLessThan(markup.indexOf("data-filter-explanation-detail"));
  });
});
