/**
 * V4 (STA-89) — the filter system's contract.
 *
 * What is worth pinning here is not "applyFilters returns an array". It is the handful
 * of ways a filter system quietly becomes a liar:
 *
 *   1. **Silently hiding work.** The single worst outcome for a tracker. Two shapes of
 *      it are tested: a done PARENT must not take its live children off the page with
 *      it, and an empty selection in a dimension must mean "no constraint", never
 *      "match nothing".
 *   2. **AND/OR getting swapped.** Values inside one dimension are alternatives (status
 *      is todo OR blocked); dimensions are conjunctions (todo AND @kim). Invert either
 *      and the result is still a plausible-looking list that answers a question nobody
 *      asked.
 *   3. **The done default becoming absolute.** Hiding done by default is right; refusing
 *      to show it when the user explicitly filters FOR Done is a bug that reads as the
 *      filter being broken.
 *   4. **Persistence losing state it does not recognise.** The stored envelope is
 *      versioned and keyed for future saved sets. A round trip must be lossless, and a
 *      dimension this build has never heard of must survive being read and written by
 *      it — otherwise shipping dimension seven silently wipes it for anyone who opens
 *      an older tab.
 *   5. **Claim-state inventing its own idea of stale.** There is exactly one threshold
 *      in this app for LIVENESS (`STALE_CLAIM_SECONDS`) and the filter must be downstream
 *      of it.
 *   6. **Handoff risk collapsing back into liveness.** W5 (STA-117) adds a second, wholly
 *      separate judgement — is the WORKLOG behind the work — owned by `lib/worklog.ts` and
 *      its own margin. §4 of the STA-108 spec exists because the two come apart, so the
 *      three cells of its table are pinned individually below. If a future edit makes
 *      `handoff` agree with `claim` on all three, the feature has been deleted while
 *      still compiling.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so the
 * app's `@` alias (src/ui/app/vite.config.ts) does not exist at test time.
 */
import { afterEach, describe, expect, it } from "vitest";
import { STALE_CLAIM_SECONDS } from "./claim.ts";
import {
  publishWorkspaceSettings,
  resetWorkspaceSettings,
  SEED_SETTINGS,
} from "./settings.ts";
import { WORKLOG_STALE_MARGIN_SECONDS } from "./worklog.ts";
import {
  DEFAULT_FILTER_SET,
  FILTERS_STORAGE_KEY,
  FILTER_DIMENSIONS,
  HANDOFF_RISKS,
  UNASSIGNED,
  activeChips,
  applyFilters,
  claimStateOf,
  countActive,
  decodeFilters,
  dimensionOptions,
  emptyFilters,
  encodeFilters,
  hiddenParents,
  isFiltering,
  loadFilters,
  saveFilters,
  handoffRiskOf,
  toggleValue,
  retainDimensionValues,
  withDimension,
} from "./filters.ts";
import type { FilterState } from "./filters.ts";
import type {
  ClaimActivity,
  Issue,
  IssuePriority,
  IssueRow,
  IssueStatus,
  WorklogSummary,
} from "./types.ts";

// ---------- fixtures ----------

let seq = 0;

function issue(over: Partial<Issue> = {}): Issue {
  seq += 1;
  const identifier = over.identifier ?? `STA-${seq}`;
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

function claim(
  idleSeconds: number,
  heldBy = "opus-x",
  // W5 needs this to vary: `worklogStaleness` compares the worklog's timestamp against
  // THIS one, so a fixture that pins it can only ever exercise one side of the comparison.
  lastActivityAt = "2026-09-01T00:00:00Z",
): ClaimActivity {
  return {
    heldBy,
    checkoutAt: "2026-09-01T00:00:00Z",
    lastActivityAt,
    heldSeconds: idleSeconds + 60,
    idleSeconds,
  };
}

/** A worklog summary as the server sends it. Only `updatedAt` is load-bearing here. */
function checkpoint(updatedAt: string, revisions = 3): WorklogSummary {
  return { key: "worklog", revisions, updatedAt, author: "opus-x" };
}

function row(
  over: Partial<Issue> = {},
  activity: ClaimActivity | null = null,
  // OMITTED by default rather than null — `worklog` is optional on IssueRow precisely so
  // that a caller holding no summary has to be handled, and most fixtures here are that
  // caller. Passing an explicit `null` is a different fixture and gets its own test.
  worklog?: WorklogSummary | null,
): IssueRow {
  const summary = worklog === undefined ? {} : { worklog };
  return { workspace: "staple", issue: issue(over), claim: activity, ...summary };
}

/** Just the identifiers, which is what every assertion below is actually about. */
const ids = (rows: readonly IssueRow[]): string[] => rows.map((r) => r.issue.identifier);

/** A state with one dimension set, spelled out so no test depends on helper behaviour. */
function state(over: Partial<FilterState> = {}): FilterState {
  return { ...emptyFilters(), ...over };
}

// ---------- the default, and the empty case ----------

describe("emptyFilters", () => {
  it("hides done out of the box — that is the whole ClickUp behaviour", () => {
    expect(emptyFilters().showDone).toBe(false);
  });

  it("constrains nothing else", () => {
    const empty = emptyFilters();
    expect(empty.dims).toEqual({});
    expect(empty.text).toBe("");
    expect(isFiltering(empty)).toBe(false);
    expect(countActive(empty)).toBe(0);
  });

  it("passes every open row through untouched", () => {
    const rows = [row({ identifier: "A" }), row({ identifier: "B" }), row({ identifier: "C" })];
    expect(ids(applyFilters(rows, emptyFilters()))).toEqual(["A", "B", "C"]);
  });

  it("treats an EMPTY selection as no constraint, not as match-nothing", () => {
    const rows = [row({ identifier: "A" }), row({ identifier: "B" })];
    expect(ids(applyFilters(rows, state({ dims: { status: [] } })))).toEqual(["A", "B"]);
  });
});

// ---------- done / closed ----------

describe("the done default", () => {
  const rows = () => [
    row({ identifier: "OPEN", status: "in_progress" }),
    row({ identifier: "DONE", status: "done" }),
    row({ identifier: "CANX", status: "cancelled" }),
  ];

  it("drops done AND cancelled by default", () => {
    expect(ids(applyFilters(rows(), emptyFilters()))).toEqual(["OPEN"]);
  });

  it("shows them on explicit opt-in", () => {
    expect(ids(applyFilters(rows(), state({ showDone: true })))).toEqual(["OPEN", "DONE", "CANX"]);
  });

  it("lets an explicit status filter override the default hide", () => {
    // Asking for Done and being shown nothing is the single most confusing thing this
    // system could do. Selecting a resolved status IS the opt-in.
    const asked = state({ dims: { status: ["done"] } });
    expect(asked.showDone).toBe(false);
    expect(ids(applyFilters(rows(), asked))).toEqual(["DONE"]);
  });

  it("does not let asking for `done` smuggle `cancelled` back in", () => {
    const asked = state({ dims: { status: ["done", "in_progress"] } });
    expect(ids(applyFilters(rows(), asked))).toEqual(["OPEN", "DONE"]);
  });
});

// ---------- the six dimensions ----------

describe("status", () => {
  it("ORs the values within the dimension", () => {
    const rows = [
      row({ identifier: "A", status: "todo" }),
      row({ identifier: "B", status: "blocked" }),
      row({ identifier: "C", status: "backlog" }),
    ];
    expect(ids(applyFilters(rows, state({ dims: { status: ["todo", "blocked"] } })))).toEqual(["A", "B"]);
  });
});

/**
 * KIND — O1c (STA-130). The dimension that is shaped like `assignee` and reads like
 * `status`, which is the thing to keep straight about it.
 *
 * It is an OPEN set (only the kinds on the page are offered, so a workspace with a dozen
 * configured kinds does not get ten zero-count menu rows), and it is ORDERED and LABELLED
 * by the workspace vocabulary rather than alphabetically or by the raw wire id. Every test
 * below is one half of that sentence.
 */
describe("kind", () => {
  afterEach(() => resetWorkspaceSettings());

  /** The seed vocabulary with a different order and one renamed label. */
  function vocabulary(ids: readonly [string, string][]) {
    publishWorkspaceSettings({
      ...SEED_SETTINGS,
      kinds: ids.map(([id, label], sortOrder) => ({ id, label, sortOrder, isBuiltin: true })),
    });
  }

  it("offers one option per kind PRESENT, and none for a kind nobody uses", () => {
    // The acceptance criterion, and the deliberate contrast with `status`/`priority` two
    // describes down, which list every member whether or not a row uses one. Kinds became
    // workspace DATA in O7a; a closed list of a dozen would be mostly zeroes.
    const rows = [row({ kind: "epic" }), row({ kind: "bug" }), row({ kind: "bug" })];
    const options = dimensionOptions("kind", rows);

    expect(options.map((o) => o.value)).toEqual(["epic", "bug"]);
    expect(options.map((o) => o.count)).toEqual([1, 2]);
    // `task` is a seeded kind and it is NOT offered, because no row on this page is one.
    expect(options.map((o) => o.value)).not.toContain("task");
  });

  it("orders the options by the CONFIGURED order, not alphabetically", () => {
    // Alphabetical would be bug, chore, epic, spike, task; the seed order is
    // epic, task, bug, chore, spike. They disagree on every position, which is what makes
    // this assertion able to fail.
    const rows = ["spike", "bug", "task", "epic", "chore"].map((kind) => row({ kind }));

    expect(dimensionOptions("kind", rows).map((o) => o.value)).toEqual([
      "epic",
      "task",
      "bug",
      "chore",
      "spike",
    ]);
  });

  it("follows the workspace when the workspace reorders or renames a kind", () => {
    // The menu must not be the one surface still painting the seed. Both halves move:
    // the ORDER comes from `configuredKindOrder()` and the LABEL from `kindLabel()`.
    vocabulary([
      ["bug", "Defect"],
      ["epic", "Initiative"],
    ]);
    const rows = [row({ kind: "epic" }), row({ kind: "bug" })];
    const options = dimensionOptions("kind", rows);

    expect(options.map((o) => o.value)).toEqual(["bug", "epic"]);
    expect(options.map((o) => o.label)).toEqual(["Defect", "Initiative"]);
  });

  it("offers a kind the vocabulary has not got LAST, rather than dropping it", () => {
    // The second between another tab adding a kind and /api/settings catching up. A row
    // carrying it is on the page, so the value has to be selectable — a menu that cannot
    // name a row it is showing is worse than one whose order is briefly odd.
    const rows = [row({ kind: "task" }), row({ kind: "zeta" }), row({ kind: "milestone" })];
    const options = dimensionOptions("kind", rows).map((o) => o.value);

    expect(options[0]).toBe("task");
    // Both are unranked by `KIND_RANK`, so the id breaks the tie — a total order, because
    // a group order that is not total reshuffles on the 1.5s poll.
    expect(options.slice(1)).toEqual(["milestone", "zeta"]);
  });

  it("labels an unknown kind by title-casing it rather than showing the wire value", () => {
    expect(dimensionOptions("kind", [row({ kind: "tech_debt" })])[0]!.label).toBe("Tech Debt");
  });

  it("matches exactly, and ORs the values within the dimension", () => {
    const rows = [row({ kind: "epic" }), row({ kind: "bug" }), row({ kind: "task" })];
    const kept = applyFilters(rows, state({ dims: { kind: ["epic", "bug"] } }));

    expect(kept.map((r) => r.issue.kind)).toEqual(["epic", "bug"]);
    // A kind id is a controlled vocabulary value, not a name a human typed, so unlike
    // `assignee` there is no casing to be generous about.
    expect(applyFilters(rows, state({ dims: { kind: ["Epic"] } }))).toEqual([]);
  });

  it("ANDs with the other dimensions like every other constraint", () => {
    const rows = [
      row({ kind: "bug", priority: "high" }),
      row({ kind: "bug", priority: "low" }),
      row({ kind: "task", priority: "high" }),
    ];
    const kept = applyFilters(rows, state({ dims: { kind: ["bug"], priority: ["high"] } }));

    expect(kept).toHaveLength(1);
    expect(kept[0]!.issue.priority).toBe("high");
  });

  it("prints a chip that reads 'Kind: Epic' — the label, never the wire id", () => {
    // STA-130's chip criterion. The DIMENSION prefix is what stops "epic" being read as a
    // label called `epic` (FilterChips.tsx's stated reason for the prefix), and the value
    // is `kindLabel`'s answer because this file's rule is that the wire value is never
    // shown to a human — the same reason `critical` prints as "Urgent".
    const chips = activeChips(state({ dims: { kind: ["epic"] } }));

    expect(chips).toHaveLength(1);
    expect(chips[0]!.dimensionLabel).toBe("Kind");
    expect(chips[0]!.label).toBe("Epic");
  });

  it("prints a RENAMED kind's chip with the new name", () => {
    // The reason the chip formats through `kindLabel` and not a frozen map: a workspace
    // that renamed `spike` to "Investigation" must be heard saying so here too.
    vocabulary([["spike", "Investigation"]]);
    expect(activeChips(state({ dims: { kind: ["spike"] } }))[0]!.label).toBe("Investigation");
  });
});

describe("assignee", () => {
  it("matches exactly, and is case-insensitive", () => {
    const rows = [
      row({ identifier: "A", assignee: "kim" }),
      row({ identifier: "B", assignee: "Kim" }),
      row({ identifier: "C", assignee: "kimberly" }),
    ];
    expect(ids(applyFilters(rows, state({ dims: { assignee: ["kim"] } })))).toEqual(["A", "B"]);
  });

  it("has a first-class unassigned bucket", () => {
    const rows = [row({ identifier: "A", assignee: "kim" }), row({ identifier: "B", assignee: null })];
    expect(ids(applyFilters(rows, state({ dims: { assignee: [UNASSIGNED] } })))).toEqual(["B"]);
  });
});

describe("priority", () => {
  it("filters on the wire value, whatever the menu calls it", () => {
    const rows = [
      row({ identifier: "A", priority: "critical" }),
      row({ identifier: "B", priority: "low" }),
    ];
    expect(ids(applyFilters(rows, state({ dims: { priority: ["critical"] } })))).toEqual(["A"]);
  });

  it("renders `critical` as Urgent, per the STA-97 row spec", () => {
    const priority = FILTER_DIMENSIONS.find((d) => d.id === "priority");
    expect(priority?.format("critical")).toBe("Urgent");
  });
});

describe("label", () => {
  it("matches a row carrying ANY of the selected labels", () => {
    const rows = [
      row({ identifier: "A", labels: ["ui", "chore"] }),
      row({ identifier: "B", labels: ["infra"] }),
      row({ identifier: "C", labels: [] }),
    ];
    expect(ids(applyFilters(rows, state({ dims: { label: ["ui", "infra"] } })))).toEqual(["A", "B"]);
  });
});

describe("claim state", () => {
  const rows = () => [
    row({ identifier: "LIVE", status: "in_progress", checkoutAgent: "opus-x" }, claim(30)),
    row(
      { identifier: "STALE", status: "in_progress", checkoutAgent: "opus-y" },
      claim(STALE_CLAIM_SECONDS + 1, "opus-y"),
    ),
    row({ identifier: "HELD", status: "in_progress", checkoutAgent: "opus-z" }, null),
    row({ identifier: "FREE", status: "todo" }, null),
  ];

  it("splits the four states the row spec names, and they do not overlap", () => {
    expect(ids(applyFilters(rows(), state({ dims: { claim: ["live"] } })))).toEqual(["LIVE"]);
    expect(ids(applyFilters(rows(), state({ dims: { claim: ["stale"] } })))).toEqual(["STALE"]);
    expect(ids(applyFilters(rows(), state({ dims: { claim: ["held"] } })))).toEqual(["HELD"]);
    expect(ids(applyFilters(rows(), state({ dims: { claim: ["free"] } })))).toEqual(["FREE"]);
  });

  it("is downstream of STALE_CLAIM_SECONDS rather than owning a threshold", () => {
    // One second under the shared threshold is live; at it, stale. If this test starts
    // failing because someone tuned a number in filters.ts, that is the bug.
    const boundary = [
      row({ identifier: "UNDER", status: "in_progress" }, claim(STALE_CLAIM_SECONDS - 1)),
      row({ identifier: "AT", status: "in_progress" }, claim(STALE_CLAIM_SECONDS)),
    ];
    expect(ids(applyFilters(boundary, state({ dims: { claim: ["live"] } })))).toEqual(["UNDER"]);
    expect(ids(applyFilters(boundary, state({ dims: { claim: ["stale"] } })))).toEqual(["AT"]);
  });

  it("covers every row exactly once across the four states", () => {
    const all = rows();
    const everything = state({ dims: { claim: ["live", "stale", "held", "free"] } });
    expect(applyFilters(all, everything)).toHaveLength(all.length);
  });
});

// ---------- handoff risk — W5 (STA-117), STA-108 spec §3F and the §4 table ----------

describe("handoff risk", () => {
  /** The one clock reading the whole block is written against. */
  const ACTIVE = "2026-09-01T12:00:00Z";
  /** N seconds before ACTIVE, as an ISO string. */
  const before = (seconds: number) => new Date(Date.parse(ACTIVE) - seconds * 1000).toISOString();

  const HOUR = 60 * 60;

  /**
   * §4's table, verbatim, as three rows. Each one is a case where a reasonable-looking
   * implementation gets the answer wrong, which is why they are asserted one at a time
   * rather than as a single "returns the right thing" test.
   */
  const table = () => [
    // Case 1 — busy and no longer checkpointing. The claim badge says "working now" and
    // is right; the handoff is four hours behind and nothing else on the board can see it.
    row(
      { identifier: "BUSY_BEHIND", status: "in_progress", checkoutAgent: "opus-a" },
      claim(30, "opus-a", ACTIVE),
      checkpoint(before(4 * HOUR)),
    ),
    // Case 2 — the agent died, but wrote its handoff on the way out. NOT a risk. This is
    // the cell that proves the two thresholds are separate judgements: the claim is stale
    // by lib/claim.ts's 30 minutes and the row is still perfectly safe to resume.
    row(
      { identifier: "DEAD_DOCUMENTED", status: "in_progress", checkoutAgent: "opus-b" },
      claim(STALE_CLAIM_SECONDS + 1, "opus-b", ACTIVE),
      checkpoint(before(15 * 60)),
    ),
    // Case 3 — §4's "worst cell in the table": hours of work, nothing written down.
    row(
      { identifier: "SILENT_UNWRITTEN", status: "in_progress", checkoutAgent: "opus-c" },
      claim(60, "opus-c", ACTIVE),
    ),
    // Not held at all. A backlog ticket with no worklog is not a finding.
    row({ identifier: "FREE", status: "todo" }),
  ];

  it("case 1 · a live claim with a stale worklog is a risk the claim badge cannot see", () => {
    expect(handoffRiskOf(table()[0]!)).toBe("stale");
    expect(claimStateOf(table()[0]!)).toBe("live");
  });

  it("case 2 · a stale claim with a fresh worklog is NOT a risk", () => {
    // Both judgements are asked here on purpose. If this ever returns "stale", someone has
    // wired handoff risk to `claim.idleSeconds` and the feature is now a second liveness
    // badge — the exact thing §4 rule 1 forbids.
    expect(claimStateOf(table()[1]!)).toBe("stale");
    expect(handoffRiskOf(table()[1]!)).toBeNull();
  });

  it("case 3 · held with no worklog at all is the loudest cell", () => {
    expect(handoffRiskOf(table()[2]!)).toBe("none");
  });

  it("says nothing about a ticket nobody is holding", () => {
    expect(handoffRiskOf(table()[3]!)).toBeNull();
  });

  it("treats an undefined worklog and an explicit null as the same answer", () => {
    const held = { status: "in_progress" as const, checkoutAgent: "opus-c" };
    expect(handoffRiskOf(row(held, claim(60, "opus-c", ACTIVE), null))).toBe("none");
    expect(handoffRiskOf(row(held, claim(60, "opus-c", ACTIVE)))).toBe("none");
  });

  it("counts a bare checkoutAgent as held, exactly as the claim dimension does", () => {
    // A payload that carried no liveness reading still says somebody has the ticket. If
    // this row fell through to null, a whole endpoint's worth of handoff risks would be
    // invisible to the filter while the row cue drew them.
    expect(handoffRiskOf(row({ status: "in_progress", checkoutAgent: "opus-z" }, null))).toBe("none");
  });

  it("is downstream of WORKLOG_STALE_MARGIN_SECONDS rather than owning a threshold", () => {
    // The mirror of the STALE_CLAIM_SECONDS test above. If this starts failing because
    // someone tuned a number in filters.ts, that is the bug — the margin belongs to
    // lib/worklog.ts, which argues it, and to nowhere else.
    const held = { status: "in_progress" as const, checkoutAgent: "opus-a" };
    const at = row(held, claim(30, "opus-a", ACTIVE), checkpoint(before(WORKLOG_STALE_MARGIN_SECONDS)));
    const under = row(held, claim(30, "opus-a", ACTIVE), checkpoint(before(WORKLOG_STALE_MARGIN_SECONDS - 1)));
    expect(handoffRiskOf(at)).toBe("stale");
    expect(handoffRiskOf(under)).toBeNull();
  });

  it("does not reuse STALE_CLAIM_SECONDS", () => {
    // Half an hour past the last checkpoint is over the claim threshold and under the
    // worklog margin. A build that borrowed 30 minutes would call this stale.
    const borrowed = row(
      { status: "in_progress", checkoutAgent: "opus-a" },
      claim(30, "opus-a", ACTIVE),
      checkpoint(before(STALE_CLAIM_SECONDS)),
    );
    expect(STALE_CLAIM_SECONDS).toBeLessThan(WORKLOG_STALE_MARGIN_SECONDS);
    expect(handoffRiskOf(borrowed)).toBeNull();
  });

  it("filters the board down to exactly the risks, and ORs the two within the dimension", () => {
    expect(ids(applyFilters(table(), state({ dims: { handoff: ["stale"] } })))).toEqual(["BUSY_BEHIND"]);
    expect(ids(applyFilters(table(), state({ dims: { handoff: ["none"] } })))).toEqual(["SILENT_UNWRITTEN"]);
    expect(ids(applyFilters(table(), state({ dims: { handoff: [...HANDOFF_RISKS] } })))).toEqual([
      "BUSY_BEHIND",
      "SILENT_UNWRITTEN",
    ]);
  });

  it("offers both risks in the menu with honest counts, even at zero", () => {
    const options = dimensionOptions("handoff", table());
    expect(options.map((o) => o.value)).toEqual(["stale", "none"]);
    expect(new Map(options.map((o) => [o.value, o.count]))).toEqual(
      new Map([
        ["stale", 1],
        ["none", 1],
      ]),
    );
    // A board with nothing wrong with it still has to offer the question, or you can
    // never confirm that nothing is at risk.
    expect(dimensionOptions("handoff", []).map((o) => o.count)).toEqual([0, 0]);
  });

  it("prints a chip that names the finding, not the wire value", () => {
    const chips = activeChips(state({ dims: { handoff: ["none"] } }));
    expect(chips).toHaveLength(1);
    expect(chips[0]!.dimensionLabel).toBe("Handoff");
    expect(chips[0]!.label).toBe("No worklog");
    // Removable through the registry's own mechanism — no chip-specific wiring anywhere.
    expect(chips[0]!.remove(state({ dims: { handoff: ["none"] } })).dims).toEqual({});
  });

  it("ANDs with the other dimensions like every other constraint", () => {
    const both = state({ dims: { handoff: [...HANDOFF_RISKS], assignee: [UNASSIGNED] } });
    expect(ids(applyFilters(table(), both))).toEqual(["BUSY_BEHIND", "SILENT_UNWRITTEN"]);
    const nobody = state({ dims: { handoff: [...HANDOFF_RISKS], assignee: ["kim"] } });
    expect(applyFilters(table(), nobody)).toEqual([]);
  });
});

describe("retainDimensionValues", () => {
  const allowed = new Set(["p-docs", "p-site"]);

  it("drops the values that are no longer allowed and keeps the rest in order", () => {
    const state = withDimension(emptyFilters(), "project", ["p-gone", "p-docs", "p-old", "p-site"]);
    expect(retainDimensionValues(state, "project", allowed).dims.project).toEqual(["p-docs", "p-site"]);
  });

  it("removes the dimension outright when nothing survives, so no empty constraint lingers", () => {
    const state = withDimension(emptyFilters(), "project", ["p-gone"]);
    expect(retainDimensionValues(state, "project", allowed).dims).toEqual({});
  });

  it("returns the same state object when nothing changes, and touches no other dimension", () => {
    const state = withDimension(withDimension(emptyFilters(), "project", ["p-docs"]), "status", ["todo"]);
    expect(retainDimensionValues(state, "project", allowed)).toBe(state);
    expect(retainDimensionValues(emptyFilters(), "project", allowed).dims).toEqual({});
    const pruned = retainDimensionValues(withDimension(state, "project", ["p-gone"]), "project", allowed);
    expect(pruned.dims.status).toEqual(["todo"]);
  });
});

describe("text", () => {
  it("searches identifier, title, assignee and labels", () => {
    const rows = [
      row({ identifier: "STA-1", title: "rebuild the header" }),
      row({ identifier: "STA-2", title: "unrelated", assignee: "marcus" }),
      row({ identifier: "STA-3", title: "unrelated", labels: ["header"] }),
      row({ identifier: "STA-4", title: "nothing here" }),
    ];
    expect(ids(applyFilters(rows, state({ text: "header" })))).toEqual(["STA-1", "STA-3"]);
    expect(ids(applyFilters(rows, state({ text: "marcus" })))).toEqual(["STA-2"]);
    expect(ids(applyFilters(rows, state({ text: "sta-4" })))).toEqual(["STA-4"]);
  });

  it("ignores case and surrounding whitespace", () => {
    const rows = [row({ identifier: "A", title: "Rebuild The Header" })];
    expect(ids(applyFilters(rows, state({ text: "  the HEADER " })))).toEqual(["A"]);
  });
});

// ---------- combination ----------

describe("combining dimensions", () => {
  it("ANDs across dimensions while ORing within each", () => {
    const rows = [
      row({ identifier: "HIT", status: "todo", assignee: "kim", priority: "high" }),
      row({ identifier: "WRONG_STATUS", status: "backlog", assignee: "kim", priority: "high" }),
      row({ identifier: "WRONG_WHO", status: "todo", assignee: "sam", priority: "high" }),
      row({ identifier: "WRONG_PRI", status: "blocked", assignee: "kim", priority: "low" }),
    ];
    const combined = state({
      dims: { status: ["todo", "blocked"], assignee: ["kim"], priority: ["high", "critical"] },
    });
    expect(ids(applyFilters(rows, combined))).toEqual(["HIT"]);
  });

  it("ANDs text with the dimensions", () => {
    const rows = [
      row({ identifier: "A", status: "todo", title: "header work" }),
      row({ identifier: "B", status: "todo", title: "footer work" }),
    ];
    expect(ids(applyFilters(rows, state({ dims: { status: ["todo"] }, text: "header" })))).toEqual(["A"]);
  });

  it("can exclude everything — an empty result is a real answer, not a bug", () => {
    const rows = [row({ identifier: "A", status: "todo" })];
    expect(applyFilters(rows, state({ dims: { status: ["blocked"] } }))).toEqual([]);
  });

  it("ignores a dimension this build does not know about", () => {
    // Forward compatibility: a state written by a newer build must not blank the list.
    const rows = [row({ identifier: "A" }), row({ identifier: "B" })];
    expect(ids(applyFilters(rows, state({ dims: { sprint: ["s-12"] } })))).toEqual(["A", "B"]);
  });
});

// ---------- the STA-97 invariant ----------

describe("the hidden-parent invariant (STA-97)", () => {
  const tree = () => {
    const parent = issue({ identifier: "EPIC", status: "done" });
    const child = issue({ identifier: "KID", status: "in_progress", parentId: parent.id });
    const grandchild = issue({ identifier: "GRANDKID", status: "todo", parentId: child.id });
    return [
      { workspace: "staple", issue: parent, claim: null },
      { workspace: "staple", issue: child, claim: null },
      { workspace: "staple", issue: grandchild, claim: null },
    ];
  };

  it("keeps live children when their done parent is filtered out", () => {
    // The parent goes. The children are open work and MUST stay on the page.
    expect(ids(applyFilters(tree(), emptyFilters()))).toEqual(["KID", "GRANDKID"]);
  });

  it("reports the filtered-out parent so a row can render a breadcrumb", () => {
    const all = tree();
    const visible = applyFilters(all, emptyFilters());
    const orphans = hiddenParents(visible, all);
    const kid = visible.find((r) => r.issue.identifier === "KID");
    expect(kid).toBeDefined();
    expect(orphans.get(kid!.issue.id)?.identifier).toBe("EPIC");
    // GRANDKID's parent survived the filter, so it is not orphaned and needs no chip.
    const grandkid = visible.find((r) => r.issue.identifier === "GRANDKID");
    expect(orphans.has(grandkid!.issue.id)).toBe(false);
  });

  it("reports nothing when nothing was filtered out", () => {
    const all = tree();
    expect(hiddenParents(all, all).size).toBe(0);
  });
});

// ---------- the registry ----------

describe("the dimension registry", () => {
  it("carries the eight menu dimensions (text has its own box)", () => {
    // Order is the menu order AND the chip order. `handoff` sits directly after `claim`
    // because that is the pair it means something in — see the note on the entry.
    //
    // O1c (STA-130) INSERTED `kind` after `status` rather than appending it: they are the
    // two per-workspace vocabularies and the two facts an issue declares about itself, and
    // appending would have made `handoff`'s "Last, and directly after Claim" false. This is
    // the opposite of `GROUP_BY_OPTIONS`'s append-only rule, and deliberately so — that
    // registry states the rule, this one argues its order entry by entry.
    //
    // `gate` (STA-144) is last, for the reason its own entry gives, and stays last: it is
    // the only dimension about a decision somebody owes rather than about the issue.
    expect(FILTER_DIMENSIONS.map((d) => d.id)).toEqual([
      "status",
      "kind",
      "assignee",
      "priority",
      "label",
      "claim",
      "handoff",
      "gate",
    ]);
  });

  it("derives assignee and label options from the rows on hand", () => {
    const rows = [
      row({ assignee: "kim", labels: ["ui", "chore"] }),
      row({ assignee: "sam", labels: ["ui"] }),
      row({ assignee: null, labels: [] }),
    ];
    const assignees = dimensionOptions("assignee", rows).map((o) => o.value);
    expect(assignees).toContain("kim");
    expect(assignees).toContain("sam");
    expect(assignees).toContain(UNASSIGNED);
    const labels = dimensionOptions("label", rows).map((o) => o.value);
    expect(labels).toEqual(["chore", "ui"]);
  });

  it("counts how many rows each option would match", () => {
    const rows = [row({ status: "todo" }), row({ status: "todo" }), row({ status: "blocked" })];
    const byValue = new Map(dimensionOptions("status", rows).map((o) => [o.value, o.count]));
    expect(byValue.get("todo")).toBe(2);
    expect(byValue.get("blocked")).toBe(1);
  });

  it("offers the closed enums in full even when no row uses them", () => {
    // A status nobody is in still has to be selectable; otherwise you can never filter
    // for "blocked" to confirm that nothing is blocked.
    const values = dimensionOptions("status", [row({ status: "todo" })]).map((o) => o.value);
    const statuses: IssueStatus[] = [
      "in_progress",
      "in_review",
      // Q2 (STA-144) moved the parked status here, directly after `in_review`,
      // where `ISSUE_STATUSES` puts it. It is filterable like any other — "show
      // me everything waiting on a human" is one of the more useful things this
      // control can be asked, and it is a DIFFERENT question from the Gate
      // dimension below, which also catches the queued work underneath.
      "awaiting_approval",
      "blocked",
      "todo",
      "backlog",
      "done",
      "cancelled",
    ];
    expect(values).toEqual(statuses);
    const priorities: IssuePriority[] = ["critical", "high", "medium", "low"];
    expect(dimensionOptions("priority", []).map((o) => o.value)).toEqual(priorities);
  });
});

// ---------- state helpers the bar is built on ----------

describe("state helpers", () => {
  it("toggles a value in and back out of a dimension", () => {
    const on = toggleValue(emptyFilters(), "status", "todo");
    expect(on.dims.status).toEqual(["todo"]);
    const off = toggleValue(on, "status", "todo");
    expect(off.dims.status ?? []).toEqual([]);
    expect(isFiltering(off)).toBe(false);
  });

  it("never mutates the state it was given", () => {
    const before = emptyFilters();
    toggleValue(before, "status", "todo");
    expect(before.dims).toEqual({});
  });

  it("drops a dimension entirely when its last value is removed", () => {
    const cleared = withDimension(toggleValue(emptyFilters(), "status", "todo"), "status", []);
    expect("status" in cleared.dims).toBe(false);
  });

  it("counts text and each selected value as one active filter each", () => {
    const busy = state({ dims: { status: ["todo", "blocked"], assignee: ["kim"] }, text: "header" });
    expect(countActive(busy)).toBe(4);
    expect(isFiltering(busy)).toBe(true);
  });

  it("does not count `showDone` as a filter — it is a default being lifted", () => {
    expect(isFiltering(state({ showDone: true }))).toBe(false);
    expect(countActive(state({ showDone: true }))).toBe(0);
  });

  it("describes every active value as its own removable chip", () => {
    const busy = state({ dims: { status: ["todo", "done"], assignee: [UNASSIGNED] }, text: "hi" });
    const chips = activeChips(busy);
    expect(chips.map((c) => c.dimension)).toEqual(["status", "status", "assignee", "text"]);
    expect(chips.map((c) => c.label)).toEqual(["To Do", "Done", "Unassigned", '"hi"']);
    // Removing a chip must remove exactly that value and leave the rest alone.
    const first = chips[0]!;
    const after = first.remove(busy);
    expect(after.dims.status).toEqual(["done"]);
    expect(after.dims.assignee).toEqual([UNASSIGNED]);
    expect(after.text).toBe("hi");
  });
});

// ---------- persistence ----------

/** The three Storage methods this module touches, and nothing else. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("persistence", () => {
  it("round-trips a full state losslessly", () => {
    const before = state({
      dims: { status: ["todo", "blocked"], assignee: ["kim", UNASSIGNED], label: ["ui"], claim: ["live"] },
      text: "header",
      showDone: true,
    });
    expect(decodeFilters(encodeFilters(before))).toEqual(before);
  });

  it("round-trips through a Storage — set, reload, still applied", () => {
    // This is the reload, modelled: a second `loadFilters` against the same storage is
    // exactly what a fresh page load does.
    const storage = memoryStorage();
    const before = state({ dims: { status: ["blocked"], assignee: ["kim"] }, text: "x", showDone: true });
    saveFilters(storage, before);
    expect(loadFilters(storage)).toEqual(before);

    const rows = [
      row({ identifier: "HIT", status: "blocked", assignee: "kim", title: "x marks it" }),
      row({ identifier: "MISS", status: "todo", assignee: "kim", title: "x marks it" }),
    ];
    expect(ids(applyFilters(rows, loadFilters(storage)))).toEqual(["HIT"]);
  });

  it("persists the done opt-in specifically", () => {
    const storage = memoryStorage();
    saveFilters(storage, state({ showDone: true }));
    expect(loadFilters(storage).showDone).toBe(true);

    saveFilters(storage, state({ showDone: false }));
    expect(loadFilters(storage).showDone).toBe(false);
  });

  it("writes one key, under an envelope with room for named sets", () => {
    const storage = memoryStorage();
    saveFilters(storage, state({ text: "hi" }));
    const raw = storage.getItem(FILTERS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const envelope = JSON.parse(raw!) as { version: number; active: string; sets: Record<string, unknown> };
    expect(envelope.version).toBe(1);
    expect(envelope.active).toBe(DEFAULT_FILTER_SET);
    expect(Object.keys(envelope.sets)).toEqual([DEFAULT_FILTER_SET]);
  });

  it("preserves a dimension it has never heard of across a round trip", () => {
    // Shipping dimension seven must not wipe it for anyone still on an older tab.
    const future = state({ dims: { status: ["todo"], sprint: ["s-12"] } });
    expect(decodeFilters(encodeFilters(future)).dims.sprint).toEqual(["s-12"]);
  });

  it("round-trips the kind dimension through the envelope, like every other", () => {
    // O1c (STA-130). Nothing in the persistence path was edited for this — `dims` is an
    // open record and `sanitize` keeps every well-formed key — so what this really pins is
    // that adding an entry did not disturb that. It would fail the day somebody
    // "tightens" `sanitize` into a whitelist of known dimension ids.
    const storage = memoryStorage();
    saveFilters(storage, state({ dims: { kind: ["epic", "bug"], status: ["todo"] } }));

    const back = loadFilters(storage);
    expect(back.dims.kind).toEqual(["epic", "bug"]);
    expect(back.dims.status).toEqual(["todo"]);
    // And it still applies after the reload, which is the criterion as a user would state it.
    const rows = [row({ kind: "epic" }), row({ kind: "task", status: "todo" })];
    expect(applyFilters(rows, back).map((r) => r.issue.kind)).toEqual(["epic"]);
  });

  it("falls back to the default when there is nothing stored", () => {
    expect(loadFilters(memoryStorage())).toEqual(emptyFilters());
  });

  it("falls back to the default on garbage rather than throwing", () => {
    expect(decodeFilters("not json at all")).toEqual(emptyFilters());
    expect(decodeFilters(null)).toEqual(emptyFilters());
    expect(decodeFilters("[1,2,3]")).toEqual(emptyFilters());
    expect(loadFilters(memoryStorage({ [FILTERS_STORAGE_KEY]: "{" }))).toEqual(emptyFilters());
  });

  it("repairs a partially-wrong stored shape instead of discarding the good parts", () => {
    const raw = JSON.stringify({
      version: 1,
      active: DEFAULT_FILTER_SET,
      sets: {
        [DEFAULT_FILTER_SET]: {
          dims: { status: ["todo", 7, null], assignee: "not-an-array" },
          text: 42,
          showDone: "yes",
        },
      },
    });
    const repaired = decodeFilters(raw);
    expect(repaired.dims.status).toEqual(["todo"]);
    expect(repaired.dims.assignee).toBeUndefined();
    expect(repaired.text).toBe("");
    expect(repaired.showDone).toBe(false);
  });

  it("survives a storage that throws on every call (private mode)", () => {
    const hostile = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("nope");
      },
    } as unknown as Storage;
    expect(loadFilters(hostile)).toEqual(emptyFilters());
    expect(() => saveFilters(hostile, emptyFilters())).not.toThrow();
  });
});

// ---------- the gate dimension (STA-144) ----------

/** A row parked behind its own review gate. */
function parkedRow(identifier: string, owner = "VP"): IssueRow {
  return {
    ...row({ identifier, status: "awaiting_approval" }),
    gate: {
      state: "pending",
      owner,
      requestedBy: "opus-q1",
      requestedAt: "2026-09-02T10:00:00Z",
      resolvedBy: null,
      resolvedAt: null,
    },
  };
}

/** A row standing in someone else's queue. */
function queuedRow(identifier: string, on = "STA-108", owner = "VP"): IssueRow {
  return { ...row({ identifier }), queuedBy: { identifier: on, owner } };
}

describe("gate", () => {
  it("offers both values always, because a closed enum must be selectable when empty", () => {
    // "Is anything parked?" has to be answerable, and the answer "no" is only reachable
    // if the option exists to select when the count is zero.
    const options = dimensionOptions("gate", [row({ identifier: "A" })]);
    expect(options.map((o) => o.value)).toEqual(["awaiting", "queued"]);
    expect(options.map((o) => o.count)).toEqual([0, 0]);
  });

  it("separates the gate from the work it is holding", () => {
    const rows = [parkedRow("A"), queuedRow("B"), queuedRow("C"), row({ identifier: "D" })];

    const awaiting = applyFilters(rows, { ...emptyFilters(), dims: { gate: ["awaiting"] } });
    expect(awaiting.map((r) => r.issue.identifier)).toEqual(["A"]);

    const queued = applyFilters(rows, { ...emptyFilters(), dims: { gate: ["queued"] } });
    expect(queued.map((r) => r.issue.identifier)).toEqual(["B", "C"]);
  });

  it("ORs the two values into the whole gated set — the parent and its queue", () => {
    // The combination the dimension exists for: "show me the review and everything it
    // is holding up", which is one screen and two clicks away from being unblocked.
    const rows = [parkedRow("A"), queuedRow("B"), row({ identifier: "C" })];
    const both = applyFilters(rows, { ...emptyFilters(), dims: { gate: ["awaiting", "queued"] } });
    expect(both.map((r) => r.issue.identifier)).toEqual(["A", "B"]);
  });

  it("ignores a gate that is no longer active", () => {
    const base = parkedRow("A");
    const approved: IssueRow = {
      ...base,
      issue: { ...base.issue, status: "todo" },
      gate: { ...base.gate!, state: "approved", resolvedBy: "VP" },
    };
    expect(dimensionOptions("gate", [approved]).map((o) => o.count)).toEqual([0, 0]);
  });

  it("counts what each value would match, like every other dimension", () => {
    const byValue = new Map(
      dimensionOptions("gate", [parkedRow("A"), queuedRow("B"), queuedRow("C")]).map((o) => [
        o.value,
        o.count,
      ]),
    );
    expect(byValue.get("awaiting")).toBe(1);
    expect(byValue.get("queued")).toBe(2);
  });

  it("prints a chip a reader can act on", () => {
    const dimension = FILTER_DIMENSIONS.find((d) => d.id === "gate")!;
    expect(dimension.label).toBe("Gate");
    expect(dimension.format("awaiting")).toBe("Awaiting approval");
    expect(dimension.format("queued")).toBe("Queued behind a gate");
  });
});
