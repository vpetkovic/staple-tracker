/**
 * R4b (STA-187) — the filter surfaces, rendered.
 *
 * Rendered to a string with `react-dom/server`, like every other component test in this
 * repo: there is no jsdom here, and every claim below is about which elements exist and what
 * their labels say, which is exactly what a string can answer.
 *
 * The menu BODY and the chip STRIP are asserted through `FilterMenuBody` and
 * `FilterChipStrip` rather than through the components that read the session and open a
 * Radix popover — the same split `components/view-options/sort-by-menu.test.tsx` and
 * `views/milestones/milestones-render.test.tsx` make, for the same two reasons: a closed
 * popover has no markup, and a session-reading component cannot be rendered without a
 * session.
 *
 * What is worth pinning, in order of how quietly it would break:
 *
 *   1. EVERY DIMENSION IS IN THE MENU. The ticket's first criterion, and the failure mode is
 *      a dimension that filters correctly and cannot be reached.
 *   2. A CHIP NAMES ITS DIMENSION AND ITS VALUE, and each has its own remove control. A strip
 *      that says "Release 1.0" without saying "Milestone" is ambiguous exactly when it
 *      matters — a label, an assignee and a milestone can all be called the same thing.
 *   3. THE EMPTY PAGE EXPLAINS ITSELF, and says whether the combination is merely empty or
 *      impossible.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildFilterContext, type FilterContext } from "@/lib/filter-dimensions";
import { emptyFilters, type FilterState } from "@/lib/filters";
import type { Issue, IssueRow } from "@/lib/types";
import { FilterChipStrip } from "./FilterChips";
import { FilterExplanation } from "./FilterEmptyState";
import { FilterMenuBody } from "./FilterMenu";

const noop = () => {};

function issue(over: Partial<Issue> = {}): Issue {
  const identifier = over.identifier ?? "STA-1";
  return {
    id: over.id ?? `id-${identifier}`,
    identifier,
    title: `task ${identifier}`,
    description: null,
    status: "todo",
    statusVersion: 1,
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
    originKind: "human",
    originId: null,
    idempotencyKey: null,
    checkoutAgent: null,
    checkoutAt: null,
    blockedTransitionAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    estimatedSeconds: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

const row = (over: Partial<Issue> = {}): IssueRow => ({
  workspace: "staple",
  issue: issue(over),
  claim: null,
});

const rows: IssueRow[] = [
  row({ identifier: "EPIC", id: "epic", kind: "epic", title: "R: work orchestration" }),
  row({ identifier: "KID", id: "kid", parentId: "epic", depth: 1 }),
];

const context: FilterContext = {
  ...buildFilterContext(rows),
  milestones: [{ identifier: "M-1", title: "Release 1.0", memberCount: 1, members: ["KID"] }],
};

const state = (over: Partial<FilterState> = {}): FilterState => ({ ...emptyFilters(), ...over });

const menu = (page: string | null, filters = emptyFilters()) =>
  renderToStaticMarkup(
    <FilterMenuBody
      rows={rows}
      state={filters}
      context={context}
      onChange={noop}
      page={page}
      onPage={noop}
    />,
  );

describe("the filter menu lists every dimension", () => {
  it("offers all twelve, including the three this ticket adds and the project dimension", () => {
    const markup = menu(null);
    for (const id of [
      "status",
      "kind",
      "assignee",
      "priority",
      "label",
      "claim",
      "handoff",
      "gate",
      "pickup",
      "milestone",
      "epic",
      "project",
    ]) {
      expect(markup).toContain(`data-filter-dimension="${id}"`);
    }
    expect(markup).toContain("Pickup state");
    expect(markup).toContain("Milestone");
  });

  it("shows how many values a dimension already has on, so re-opening says where you were", () => {
    expect(menu(null, state({ dims: { pickup: ["gated", "waiting"] } }))).toMatch(
      /data-filter-dimension="pickup"[\s\S]*?>2</,
    );
  });

  it("offers the five pickup states, each with the sentence that says what it means", () => {
    const markup = menu("pickup");
    expect(markup).toContain('data-filter-menu="pickup"');
    for (const value of ["pickable", "queued", "waiting", "gated", "in_flight"]) {
      expect(markup).toContain(`data-filter-option="${value}"`);
    }
    expect(markup).toContain("an agent could check it out now");
  });

  it("offers milestones by TITLE and epics by title, from served data", () => {
    expect(menu("milestone")).toContain("Release 1.0");
    expect(menu("epic")).toContain("R: work orchestration");
  });

  it("checks the values already selected, so the menu is a readout as well as a control", () => {
    const markup = menu("pickup", state({ dims: { pickup: ["gated"] } }));
    expect(markup).toMatch(/data-filter-option="gated" data-checked=""/);
    expect(markup).not.toMatch(/data-filter-option="waiting" data-checked=""/);
  });

  it("falls back to the picker for a dimension this build has never heard of", () => {
    // A chip written by a newer build must not land the reader in an empty menu with no
    // way out.
    expect(menu("sprint")).toContain('data-filter-menu="root"');
  });
});

describe("the chip strip", () => {
  const strip = (filters: FilterState) =>
    renderToStaticMarkup(
      <FilterChipStrip rows={rows} state={filters} context={context} onChange={noop} />,
    );

  it("is not rendered at all when nothing is filtering", () => {
    expect(strip(emptyFilters())).toBe("");
  });

  it("RENDERS for a new dimension alone — the V4 check would have hidden it", () => {
    const markup = strip(state({ dims: { milestone: ["M-1"] } }));
    expect(markup).toContain('data-filter-chip="milestone"');
  });

  it("names the dimension AND the value, and offers a remove for each", () => {
    const markup = strip(state({ dims: { pickup: ["gated"], epic: ["EPIC"] } }));
    expect(markup).toContain("Pickup state");
    expect(markup).toContain("Gated");
    expect(markup).toContain("R: work orchestration");
    expect(markup).toContain('aria-label="Remove filter Pickup state Gated"');
    expect(markup).toContain('aria-label="Remove filter Epic R: work orchestration"');
  });

  it("keeps Clear all, which resets the new dimensions with the old ones", () => {
    expect(strip(state({ dims: { milestone: ["M-1"] } }))).toContain("data-filter-clear");
  });
});

describe("the empty page explains itself", () => {
  const explain = (filters: FilterState) =>
    renderToStaticMarkup(<FilterExplanation rows={rows} state={filters} context={context} />);

  it("says nothing when nothing is filtering", () => {
    expect(explain(emptyFilters())).toBe("");
  });

  it("marks an impossible combination as impossible, and names both dimensions", () => {
    const markup = explain(
      state({ dims: { status: ["done"], pickup: ["pickable"] }, showDone: true }),
    );
    expect(markup).toContain('data-filter-explanation="impossible"');
    expect(markup).toContain("Status and Pickup state cannot both be true");
  });

  it("names the dimension worth removing when the combination is merely empty", () => {
    const markup = explain(state({ dims: { pickup: ["waiting"] } }));
    expect(markup).toContain('data-filter-explanation="narrowed"');
    expect(markup).toContain("Pickup state");
  });
});
