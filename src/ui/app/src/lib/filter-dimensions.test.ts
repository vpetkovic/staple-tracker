/**
 * R4b (STA-187) — the dimensions that need more than one row to answer.
 *
 * What is worth pinning here is not "the predicate returns a boolean". It is the handful of
 * decisions a future edit could quietly undo:
 *
 *   1. MILESTONE IS MEMBERSHIP, NEVER THE TREE. A member that is not a child, and a child
 *      that is not a member, are both in this file — they are the two rows a `parentId`
 *      implementation would get wrong, in opposite directions.
 *   2. THE SERVED PICKUP STATE WINS, and the fallback derives four of the five without it.
 *      A build that started re-deriving over the top of the resolver would disagree with
 *      the CLI about what is pickable, and nothing on screen would say so.
 *   3. OR WITHIN, AND ACROSS, unchanged from V4 — asserted on the new dimensions, mixed with
 *      the old ones, because the composition of two registries is exactly where it could
 *      break without either registry being wrong.
 *   4. THE EMPTY PAGE EXPLAINS ITSELF, including the combinations that cannot match anything
 *      whatever the data says.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  publishWorkspaceSettings,
  resetWorkspaceSettings,
  SEED_SETTINGS,
  settingValue,
  workspaceSettings,
} from "./settings.ts";
import {
  ALL_FILTER_DIMENSIONS,
  activeFilterChips,
  applyFilterDimensions,
  buildFilterContext,
  countActiveFilters,
  EMPTY_FILTER_CONTEXT,
  explainNoMatches,
  filterDimensionOptions,
  findFilterDimension,
  isFilteringNow,
  pickupStateOf,
  type FilterContext,
  type MilestoneFacts,
} from "./filter-dimensions.ts";
import { clearFilters, emptyFilters, toggleValue, withDimension } from "./filters.ts";
import type { FilterState } from "./filters.ts";
import { PICKUP_STATES } from "./types.ts";
import type { ClaimActivity, Issue, IssueRow, PickupState } from "./types.ts";

// ---------- fixtures ----------

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

function row(over: Partial<Issue> = {}, extra: Partial<IssueRow> = {}): IssueRow {
  return { workspace: "staple", issue: issue(over), claim: null, ...extra };
}

const claim = (heldBy = "opus-x"): ClaimActivity => ({
  heldBy,
  checkoutAt: "2026-09-01T00:00:00Z",
  lastActivityAt: "2026-09-01T00:00:00Z",
  heldSeconds: 120,
  idleSeconds: 60,
});

const ids = (rows: readonly IssueRow[]): string[] => rows.map((r) => r.issue.identifier);

const state = (over: Partial<FilterState> = {}): FilterState => ({ ...emptyFilters(), ...over });

/**
 * A three-generation tree: one epic, one task under it, one grandchild — plus a second,
 * unrelated root. Enough to tell "top-level ancestor" apart from "parent".
 */
function tree(): IssueRow[] {
  return [
    row({ identifier: "EPIC", id: "epic", kind: "epic", title: "R: work orchestration" }),
    row({ identifier: "KID", id: "kid", parentId: "epic", depth: 1 }),
    row({ identifier: "GRANDKID", id: "grandkid", parentId: "kid", depth: 2 }),
    row({ identifier: "OTHER", id: "other", title: "Q: approval gates", kind: "epic" }),
  ];
}

const milestone = (over: Partial<MilestoneFacts> = {}): MilestoneFacts => ({
  identifier: "M-1",
  title: "Release 1.0",
  memberCount: 2,
  members: null,
  ...over,
});

// ---------- the context ----------

describe("the filter context", () => {
  it("maps every row to its TOP-LEVEL ancestor, not to its parent", () => {
    const context = buildFilterContext(tree());
    expect(context.epicOf.get("grandkid")).toBe("EPIC");
    expect(context.epicOf.get("kid")).toBe("EPIC");
    // A root is its own epic, which is what makes selecting one keep the epic AND its work.
    expect(context.epicOf.get("epic")).toBe("EPIC");
    expect(context.epicTitle.get("EPIC")).toBe("R: work orchestration");
  });

  it("treats a row whose parent was never loaded as its own root", () => {
    // The alternative is filing it under an epic nobody on this page can see.
    const orphan = [row({ identifier: "LOST", id: "lost", parentId: "nowhere", depth: 1 })];
    expect(buildFilterContext(orphan).epicOf.get("lost")).toBe("LOST");
  });

  it("terminates on a parent cycle instead of hanging the render", () => {
    const cycle = [
      row({ identifier: "A", id: "a", parentId: "b" }),
      row({ identifier: "B", id: "b", parentId: "a" }),
    ];
    expect(() => buildFilterContext(cycle)).not.toThrow();
  });
});

// ---------- pickup state ----------

describe("pickup state", () => {
  it("USES THE SERVED VALUE, and does not re-derive over the top of it", () => {
    // The row looks locally pickable in every way. The resolver says it is queued behind an
    // earlier row, and the resolver is the one that can see the order.
    const served = row({ identifier: "A" }, { pickupState: "queued" });
    expect(pickupStateOf(served)).toBe("queued");
  });

  it("ignores a served value that is not one of the five", () => {
    const junk = row({ identifier: "A" }, { pickupState: "nonsense" as PickupState });
    expect(pickupStateOf(junk)).toBe("pickable");
  });

  it("derives GATED from the row's own gate and from the gate it stands behind", () => {
    const parked = row(
      { identifier: "P", status: "awaiting_approval" },
      {
        gate: {
          state: "pending",
          owner: "VP",
          requestedBy: "opus-q1",
          requestedAt: "2026-09-02T10:00:00Z",
          resolvedBy: null,
          resolvedAt: null,
        },
      },
    );
    const behind = row({ identifier: "Q" }, { queuedBy: { identifier: "STA-108", owner: "VP" } });
    expect(pickupStateOf(parked)).toBe("gated");
    expect(pickupStateOf(behind)).toBe("gated");
  });

  it("names the gate BEFORE the blocker, exactly as the resolver's ladder does", () => {
    const both = row(
      { identifier: "B", status: "blocked" },
      { queuedBy: { identifier: "STA-108", owner: "VP" }, deps: { blockedBy: ["STA-9"], blocks: [] } },
    );
    expect(pickupStateOf(both)).toBe("gated");
  });

  it("derives WAITING from an unresolved blocker or a blocked status", () => {
    expect(pickupStateOf(row({ identifier: "A", status: "blocked" }))).toBe("waiting");
    expect(
      pickupStateOf(row({ identifier: "B" }, { deps: { blockedBy: ["STA-9"], blocks: [] } })),
    ).toBe("waiting");
  });

  it("derives IN FLIGHT from a claim, a bare checkout, or a working status", () => {
    expect(pickupStateOf(row({ identifier: "A" }, { claim: claim() }))).toBe("in_flight");
    // A `checkoutAgent` with no liveness reading still says somebody has it.
    expect(pickupStateOf(row({ identifier: "B", checkoutAgent: "opus-x" }))).toBe("in_flight");
    // Moved by hand without a checkout — still not free to take.
    expect(pickupStateOf(row({ identifier: "C", status: "in_progress" }))).toBe("in_flight");
    expect(pickupStateOf(row({ identifier: "D", status: "in_review" }))).toBe("in_flight");
  });

  it("gives a RESOLVED row no pickup state at all", () => {
    // Finished work is not waiting for anything, and filing it as "not pickable" would put
    // it beside work that is stuck.
    expect(pickupStateOf(row({ identifier: "A", status: "done" }))).toBeNull();
    expect(pickupStateOf(row({ identifier: "B", status: "cancelled" }))).toBeNull();
  });

  it("never derives QUEUED locally — order is the resolver's knowledge", () => {
    const rows = [
      row({ identifier: "A" }, { queuePosition: 4 }),
      row({ identifier: "B" }, { planPosition: 2 }),
    ];
    expect(rows.map(pickupStateOf)).toEqual(["pickable", "pickable"]);
    // And the served field is the only way to reach it.
    expect(pickupStateOf(row({ identifier: "C" }, { pickupState: "queued" }))).toBe("queued");
  });

  it("filters by every state, ORing alternatives inside the dimension", () => {
    const rows = [
      row({ identifier: "FREE" }),
      row({ identifier: "HELD" }, { claim: claim() }),
      row({ identifier: "STUCK", status: "blocked" }),
      row({ identifier: "QUEUED" }, { pickupState: "queued" }),
    ];
    const only = (values: string[]) =>
      ids(applyFilterDimensions(rows, state({ dims: { pickup: values } })));

    expect(only(["pickable"])).toEqual(["FREE"]);
    expect(only(["in_flight"])).toEqual(["HELD"]);
    expect(only(["waiting"])).toEqual(["STUCK"]);
    expect(only(["queued"])).toEqual(["QUEUED"]);
    expect(only(["pickable", "waiting"])).toEqual(["FREE", "STUCK"]);
  });

  it("offers all five states even at zero, and explains each one", () => {
    const options = filterDimensionOptions("pickup", [row({ identifier: "A", status: "done" })]);
    expect(options.map((o) => o.value)).toEqual([...PICKUP_STATES]);
    expect(options.map((o) => o.count)).toEqual([0, 0, 0, 0, 0]);
    expect(options.every((o) => (o.hint ?? "").length > 0)).toBe(true);
  });
});

// ---------- milestone ----------

describe("milestone", () => {
  /**
   * THE TWO ROWS A `parentId` IMPLEMENTATION WOULD GET WRONG. `KID` is a child of `EPIC` and
   * is NOT a member; `OTHER` is unrelated to `EPIC` in the tree and IS one. A filter that
   * read the tree would return exactly the wrong pair.
   */
  const context = (): FilterContext => ({
    ...buildFilterContext(tree()),
    milestones: [milestone({ members: ["EPIC", "OTHER"], memberCount: 2 })],
  });

  it("matches MEMBERSHIP, never the tree", () => {
    const kept = applyFilterDimensions(tree(), state({ dims: { milestone: ["M-1"] } }), context());
    expect(ids(kept)).toEqual(["EPIC", "OTHER"]);
  });

  it("offers every served milestone by title, counting the members ON THE PAGE", () => {
    const options = filterDimensionOptions("milestone", tree(), context());
    expect(options).toEqual([{ value: "M-1", label: "Release 1.0", count: 2 }]);
  });

  it("falls back to the served memberCount while the members are still unfetched", () => {
    // "I have not looked" is not "it is empty", and a 0 in the menu would say the second.
    const unloaded: FilterContext = { ...EMPTY_FILTER_CONTEXT, milestones: [milestone()] };
    expect(filterDimensionOptions("milestone", tree(), unloaded)[0]!.count).toBe(2);
    // And no row can be claimed as a member on the strength of a count.
    expect(applyFilterDimensions(tree(), state({ dims: { milestone: ["M-1"] } }), unloaded)).toEqual(
      [],
    );
  });

  it("ORs two milestones and prints each chip with its TITLE", () => {
    const two: FilterContext = {
      ...buildFilterContext(tree()),
      milestones: [
        milestone({ members: ["EPIC"] }),
        milestone({ identifier: "M-2", title: "Release 1.1", members: ["KID"] }),
      ],
    };
    const kept = applyFilterDimensions(tree(), state({ dims: { milestone: ["M-1", "M-2"] } }), two);
    expect(ids(kept)).toEqual(["EPIC", "KID"]);

    const chips = activeFilterChips(state({ dims: { milestone: ["M-2"] } }), two);
    expect(chips[0]).toMatchObject({ dimension: "milestone", dimensionLabel: "Milestone", label: "Release 1.1" });
  });
});

// ---------- epic ----------

describe("epic", () => {
  const context = () => buildFilterContext(tree());

  it("keeps the whole family — the epic, its child and its grandchild", () => {
    const kept = applyFilterDimensions(tree(), state({ dims: { epic: ["EPIC"] } }), context());
    expect(ids(kept)).toEqual(["EPIC", "KID", "GRANDKID"]);
  });

  it("offers the top-level ancestors present, by title, with their subtree counts", () => {
    const options = filterDimensionOptions("epic", tree(), context());
    expect(options).toEqual([
      { value: "OTHER", label: "Q: approval gates", count: 1 },
      { value: "EPIC", label: "R: work orchestration", count: 3 },
    ]);
  });
});

// ---------- composition ----------

describe("OR within a dimension, AND across dimensions", () => {
  const rows = () => [
    row({ identifier: "A", id: "a", kind: "epic", priority: "high" }),
    row({ identifier: "B", id: "b", parentId: "a", priority: "low" }),
    row({ identifier: "C", id: "c", priority: "high" }),
  ];

  it("ANDs a NEW dimension with an OLD one", () => {
    const context = buildFilterContext(rows());
    const kept = applyFilterDimensions(
      rows(),
      state({ dims: { epic: ["A"], priority: ["high"] } }),
      context,
    );
    expect(ids(kept)).toEqual(["A"]);
  });

  it("leaves the V4 predicate in charge of everything it already owned", () => {
    // The done default, the search box and the eight original dimensions all still apply
    // through `applyFilters`; this only narrows what survived.
    const done = [row({ identifier: "D", status: "done" }), row({ identifier: "O" })];
    expect(ids(applyFilterDimensions(done, emptyFilters()))).toEqual(["O"]);
    expect(ids(applyFilterDimensions(done, state({ text: "STA" })))).toEqual([]);
  });

  it("treats an empty selection as no constraint, not as `match nothing`", () => {
    expect(ids(applyFilterDimensions(rows(), state({ dims: { milestone: [] } })))).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("ignores a dimension neither registry knows, so an older build shows MORE not less", () => {
    expect(ids(applyFilterDimensions(rows(), state({ dims: { sprint: ["s-12"] } })))).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});

describe("the registry, the count and the chips", () => {
  it("offers every dimension the ticket asks for, the three new ones last", () => {
    expect(ALL_FILTER_DIMENSIONS.map((d) => d.id)).toEqual([
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
    ]);
    // Every one of them has a heading; a menu of bare ids makes the user guess.
    expect(ALL_FILTER_DIMENSIONS.every((d) => d.label.length > 0)).toBe(true);
    expect(findFilterDimension("pickup")?.label).toBe("Pickup state");
  });

  it("COUNTS the new dimensions — the V4 counter cannot see them", () => {
    const only = state({ dims: { milestone: ["M-1"] } });
    expect(countActiveFilters(only)).toBe(1);
    // The strip has to render, or there is no way to remove the constraint that emptied
    // the page.
    expect(isFilteringNow(only)).toBe(true);
    expect(countActiveFilters(state({ dims: { status: ["todo"], pickup: ["gated", "waiting"] } }))).toBe(3);
  });

  it("emits one removable chip per value, and each remove is surgical", () => {
    const busy = state({ dims: { pickup: ["gated", "waiting"], epic: ["EPIC"] }, text: "auth" });
    const chips = activeFilterChips(busy, buildFilterContext(tree()));
    expect(chips.map((c) => [c.dimension, c.label])).toEqual([
      ["pickup", "Gated"],
      ["pickup", "Waiting"],
      ["epic", "R: work orchestration"],
      ["text", '"auth"'],
    ]);
    const withoutGated = chips[0]!.remove(busy);
    expect(withoutGated.dims.pickup).toEqual(["waiting"]);
    expect(withoutGated.dims.epic).toEqual(["EPIC"]);
    expect(chips[3]!.remove(busy).text).toBe("");
  });

  it("CLEAR ALL clears the new dimensions too, because they live in the same record", () => {
    const busy = state({ dims: { pickup: ["gated"], milestone: ["M-1"] } });
    expect(isFilteringNow(clearFilters())).toBe(false);
    expect(countActiveFilters(busy)).toBe(2);
    expect(clearFilters().dims).toEqual({});
  });

  it("never mutates the state it is handed", () => {
    const before = state({ dims: { pickup: ["gated"] } });
    const snapshot = JSON.stringify(before);
    applyFilterDimensions(tree(), before, EMPTY_FILTER_CONTEXT);
    activeFilterChips(before);
    toggleValue(before, "pickup", "waiting");
    withDimension(before, "epic", ["EPIC"]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

// ---------- the empty page ----------

describe("explaining an empty page", () => {
  const rows = () => [
    row({ identifier: "A", status: "todo", priority: "high" }),
    row({ identifier: "B", status: "in_progress", priority: "low" }, { claim: claim() }),
  ];

  it("says nothing at all when nothing is filtering", () => {
    expect(explainNoMatches(rows(), emptyFilters()).sentence).toBe("");
  });

  it("calls DONE + PICKABLE impossible, and names both dimensions", () => {
    const asked = state({ dims: { status: ["done"], pickup: ["pickable"] }, showDone: true });
    const why = explainNoMatches(rows(), asked);
    expect(why.impossible).toBe(true);
    expect(why.dimensions).toEqual(["status", "pickup"]);
    expect(why.sentence).toContain("Status and Pickup state cannot both be true");
    expect(why.sentence).toContain("finished work has no pickup state");
  });

  it("calls a GATE + PICKABLE pair impossible for the same reason", () => {
    const asked = state({ dims: { gate: ["awaiting"], pickup: ["pickable"] } });
    expect(explainNoMatches(rows(), asked).impossible).toBe(true);
  });

  it("does NOT call it impossible when the dimension offers a satisfiable alternative", () => {
    // `pickup` also names `gated`, which a gated row satisfies — the OR inside the dimension
    // is what makes this combination merely empty rather than contradictory.
    const asked = state({ dims: { gate: ["awaiting"], pickup: ["pickable", "gated"] } });
    expect(explainNoMatches(rows(), asked).impossible).toBe(false);
  });

  it("names the ONE dimension worth removing, and what removing it would show", () => {
    const asked = state({ dims: { pickup: ["pickable"], priority: ["critical"] } });
    const why = explainNoMatches(rows(), asked);
    expect(why.dimensions).toEqual(["priority"]);
    expect(why.sentence).toBe(
      "Nothing matches. Removing Priority (1) would bring rows back — the number is what each would show.",
    );
  });

  it("blames the search box like any other constraint", () => {
    const why = explainNoMatches(rows(), state({ text: "nothing-like-this" }));
    expect(why.dimensions).toEqual(["text"]);
    expect(why.sentence).toContain("Search");
  });

  it("says so plainly when no SINGLE removal helps and only the combination is empty", () => {
    const asked = state({ dims: { pickup: ["waiting"], priority: ["critical"] } });
    const why = explainNoMatches(rows(), asked);
    expect(why.impossible).toBe(false);
    // Registry order, not selection order: Priority is one of V4's eight and Pickup state
    // is appended after them, so the sentence reads in the same order the menu does.
    expect(why.sentence).toBe(
      "Nothing matches: Priority and Pickup state exclude every row together, so no single one of them explains it.",
    );
  });
});

/**
 * "Filters persist and round-trip WITHOUT CHANGING QUEUE POLICY" — the ticket's last
 * criterion, and the one that would be most expensive to discover the hard way.
 *
 * docs/queue.md is explicit that presentation is not the queue: the list may display and
 * order by the resolver's answers and may never set them. This file is where that could go
 * wrong, because it is the one that reads `queue.policy`'s neighbourhood — the settings
 * envelope — and the one whose functions run on every keystroke in the search box.
 */
describe("filtering changes nothing but the filter", () => {
  const policied = () => ({
    ...SEED_SETTINGS,
    values: {
      "queue.policy": {
        key: "queue.policy",
        scope: "workspace" as const,
        value: "strict",
        source: "workspace" as const,
        version: 3,
      },
    },
  });

  afterEach(() => resetWorkspaceSettings());

  it("leaves the settings envelope — queue.policy included — byte for byte alone", () => {
    publishWorkspaceSettings(policied());
    const before = JSON.stringify(workspaceSettings());

    const rows = [row({ identifier: "A" }), row({ identifier: "B" }, { pickupState: "queued" })];
    const busy = state({ dims: { pickup: ["queued"], milestone: ["M-1"] }, text: "a" });
    applyFilterDimensions(rows, busy, EMPTY_FILTER_CONTEXT);
    activeFilterChips(busy);
    explainNoMatches(rows, busy, EMPTY_FILTER_CONTEXT);
    filterDimensionOptions("pickup", rows);
    countActiveFilters(busy);

    expect(JSON.stringify(workspaceSettings())).toBe(before);
    expect(settingValue("queue.policy")?.value).toBe("strict");
  });

  it("READS the resolver's answer and never writes one back onto the row", () => {
    // The row is the wire's; a filter that mutated `pickupState` or `queuePosition` would be
    // the browser editing the plan.
    const served = row({ identifier: "A" }, { pickupState: "queued", queuePosition: 4 });
    const snapshot = JSON.stringify(served);
    applyFilterDimensions([served], state({ dims: { pickup: ["queued"] } }));
    pickupStateOf(served);
    expect(JSON.stringify(served)).toBe(snapshot);
  });
});
