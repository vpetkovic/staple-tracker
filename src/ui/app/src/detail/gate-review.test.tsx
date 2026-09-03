/**
 * Q4 (STA-147) — the review-gate block's contract, in the two halves a test can hold.
 * Extended by Q5 (STA-154) for the tree, the implied subtree and the Send back copy.
 *
 * Rendered to a string with `react-dom/server`, following `components/task-list/
 * row-render.test.tsx`: the suite has no jsdom and does not want one. That bounds what
 * these tests can claim, and the boundary is drawn on purpose —
 *
 *   WHAT IS ASSERTED HERE: which elements exist, what their accessible names say, which
 *   are absent, which are disabled, and the PURE FUNCTIONS the layout hangs off.
 *   `gateIdWidth` is the reason the four columns align down the list and `indentSteps` is
 *   the reason a deep tree cannot eat the title track, so both are functions with tests
 *   rather than facts only a browser knows about.
 *
 *   WHAT IS NOT: layout. "One line at 420px", "no horizontal scroll", "every row the
 *   same height" are CSS facts about a real drawer in a real browser, and they are
 *   verified where they are true — in the screenshot + `page.evaluate` measurements
 *   recorded on the ticket's worklog. A jsdom assertion about `scrollWidth` would be a
 *   test of jsdom's layout engine, which does not have one.
 *
 *   ELIGIBILITY IS ALSO NOT HERE, and that is the Q5 change worth naming. Which rows a
 *   gate is holding is the STORE's rule now (`store.gateQueueOf`, pinned in
 *   test/store-gates.test.ts); this component renders the list it is handed. A test here
 *   that filtered done children would be asserting a second definition into existence.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GateQueueEntry, IssueGate } from "@/lib/types";
import {
  GateReview,
  MAX_ID_CH,
  MAX_INDENT_STEPS,
  MIN_ID_CH,
  gateIdWidth,
  gateStateSummary,
  indentSteps,
  sendBackContract,
} from "./GateReview";

const NOW = new Date("2026-09-02T12:00:00.000Z");

function row(
  identifier: string,
  title: string,
  over: Partial<GateQueueEntry> = {},
): GateQueueEntry {
  return {
    id: `id-${identifier}`,
    identifier,
    title,
    status: "todo",
    parentId: "id-parent",
    depth: 1,
    ...over,
  };
}

const PENDING: IssueGate = {
  state: "pending",
  owner: "VP",
  requestedBy: "claude",
  requestedAt: "2026-09-02T10:00:00.000Z",
  resolvedBy: null,
  resolvedAt: null,
};

const LONG =
  "Reconcile sweep for orphaned TaskLink rows after a workspace file is moved, renamed " +
  "or restored from backup, including the hub prefix reallocation path";

function render(gate: IssueGate, queue: readonly GateQueueEntry[]): string {
  return renderToStaticMarkup(
    <GateReview
      identifier="STA-142"
      gate={gate}
      queue={queue}
      busy={false}
      now={NOW}
      onApproveAll={() => {}}
      onApproveSelected={() => {}}
      onRequestChanges={() => {}}
    />,
  );
}

describe("gateIdWidth — the number the four columns align on", () => {
  it("takes the LONGEST identifier, so every row's track is the same width", () => {
    expect(gateIdWidth([{ identifier: "STA-9" }, { identifier: "STA-1234" }])).toBe(8);
  });

  it("never goes below the floor, so a workspace of WOR-1s still has a column", () => {
    expect(gateIdWidth([{ identifier: "WOR-1" }])).toBe(MIN_ID_CH);
    expect(gateIdWidth([])).toBe(MIN_ID_CH);
  });

  it("clamps, so a pathological prefix cannot eat the title's track", () => {
    expect(gateIdWidth([{ identifier: "VERYLONGPREFIX-123456" }])).toBe(MAX_ID_CH);
  });
});

describe("indentSteps — how far a row at `depth` steps in", () => {
  it("leaves the gate's own children flush: depth 1 is step 0", () => {
    expect(indentSteps(1)).toBe(0);
    expect(indentSteps(2)).toBe(1);
    expect(indentSteps(3)).toBe(2);
  });

  it("clamps, so a deep subtree cannot spend the title track on whitespace", () => {
    expect(indentSteps(50)).toBe(MAX_INDENT_STEPS);
  });

  it("never goes negative, whatever a payload claims", () => {
    expect(indentSteps(0)).toBe(0);
    expect(indentSteps(-4)).toBe(0);
    expect(indentSteps(Number.NaN)).toBe(0);
  });
});

describe("gateStateSummary — who has to act, and for how long", () => {
  it("names the owner and the age for a pending gate", () => {
    expect(gateStateSummary(PENDING, NOW)).toBe("awaiting VP · 2h");
  });

  it("does not let changes_requested read like a closed gate", () => {
    const summary = gateStateSummary(
      { ...PENDING, state: "changes_requested", resolvedBy: "VP", resolvedAt: "2026-09-02T11:55:00.000Z" },
      NOW,
    );
    expect(summary).toBe("changes requested by VP · 5m — still queued");
  });

  it("names the owner separately when somebody else objected", () => {
    const summary = gateStateSummary(
      { ...PENDING, state: "changes_requested", resolvedBy: "ada", resolvedAt: "2026-09-02T11:55:00.000Z" },
      NOW,
    );
    expect(summary).toBe("changes requested by ada · 5m — still awaiting VP");
  });

  it("omits the age rather than rendering a guess from an unparseable stamp", () => {
    expect(gateStateSummary({ ...PENDING, requestedAt: "not-a-date" }, NOW)).toBe("awaiting VP");
  });
});

describe("the queue list", () => {
  const rows = [row("STA-13", "GitHub Issues adapter"), row("STA-1234", LONG, { status: "in_progress" })];

  it("gives every row a real checkbox whose accessible name IS the row", () => {
    const html = render(PENDING, rows);
    expect(html).toContain('aria-label="Release STA-13: GitHub Issues adapter"');
    expect(html).toContain(`aria-label="Release STA-1234: ${LONG}"`);
    // Native controls, not `div role="checkbox"` — the keyboard behaviour is the UA's.
    expect(html).not.toContain('role="checkbox"');
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(2);
  });

  it("publishes the shared identifier width from the LONGEST identifier", () => {
    // 8, not 6: `STA-1234`. This is the alignment — see gateIdWidth.
    expect(render(PENDING, rows)).toContain("--gate-id-w:8ch");
  });

  it("keeps the full title in `title=`, which is what the ellipsis is paying for", () => {
    expect(render(PENDING, rows)).toContain(`title="${LONG}"`);
  });

  it("groups the boxes so they announce as one decision, not N unrelated ones", () => {
    const html = render(PENDING, rows);
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect(html).toContain("2 queued items");
  });

  it("says item, singular, for one", () => {
    expect(render(PENDING, [rows[0]!])).toContain("1 queued item");
  });

  /**
   * STA-154 rule (a). The tree is the whole reason a reviewer can see what a tick does:
   * the parent's children are drawn beneath it, indented, and the indent is a padding on
   * the row rather than a fifth grid track — so the four-track contract Q4 wrote is
   * untouched and no depth can bring back the horizontal scroll.
   */
  it("indents by depth, and leaves the gate's own children flush", () => {
    const html = render(PENDING, [
      row("STA-13", "Parent"),
      row("STA-14", "Child", { depth: 2 }),
      row("STA-15", "Grandchild", { depth: 3 }),
    ]);
    expect(html).toContain("--gate-depth:0");
    expect(html).toContain("--gate-depth:1");
    expect(html).toContain("--gate-depth:2");
  });
});

/**
 * STA-154 rule (a), second half: ticking a parent releases its subtree, so the subtree
 * must SAY it is coming along. Rendered to static markup, so the selection under test is
 * the initial one — the "+n" and the disabled-implied rows are asserted through their
 * pure functions in lib/derived-queued.test.ts, and what is pinned here is that nothing
 * is pre-ticked and every box starts live.
 */
describe("the initial selection", () => {
  it("starts with nothing ticked and nothing implied", () => {
    const html = render(PENDING, [row("STA-13", "Parent"), row("STA-14", "Child", { depth: 2 })]);
    expect(html).not.toContain("checked=");
    expect(html).not.toContain("staple-gate-row-implied");
    expect(html).not.toContain("released with its parent");
  });
});

describe("the actions", () => {
  const rows = [row("STA-13", "GitHub Issues adapter")];

  it("offers Approve selected disabled at zero ticked, with the count in the label", () => {
    const html = render(PENDING, rows);
    expect(html).toContain("Approve selected (0)");
    expect(html).toContain("Tick at least one queued item");
    expect(html).toContain("Approve all");
  });

  /** STA-154 (3): the action is named for what it does to the ticket. */
  it("calls it Send back, not Request changes", () => {
    const html = render(PENDING, rows);
    expect(html).toContain("Send back");
    expect(html).not.toContain("Request changes");
  });

  it("carries the contract on the button, so it is readable before the click", () => {
    const html = render(PENDING, rows);
    expect(html).toContain(sendBackContract("STA-142").replace(/&/g, "&amp;"));
  });

  it("keeps the note box shut until Send back is pressed", () => {
    const html = render(PENDING, rows);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Note to the agent");
    expect(html).not.toContain("Send back with note");
  });
});

/**
 * STA-154 (3). The sentence is the fix: VP could not tell whether a note was processed or
 * "just a comment", and all three consequences — the comment, the status move, the queue
 * staying put — are now stated in the one place a reviewer reads before typing.
 */
describe("the Send back contract sentence", () => {
  it("names the ticket, the comment, the status move and the queue", () => {
    expect(sendBackContract("STA-142")).toBe(
      "Posts your note as a comment on STA-142, returns it to todo for the next agent, " +
        "and keeps the queued children parked until you approve.",
    );
  });
});

describe("the empty state", () => {
  it("says so in a sentence and drops the button that would have no subject", () => {
    const html = render(PENDING, []);
    expect(html).toContain("Nothing left to release — no open work is queued behind this gate.");
    expect(html).not.toContain("<fieldset");
    expect(html).not.toContain("Approve selected");
  });

  /**
   * Rule (d). The store call is the same one "Approve all" makes, but the DECISION is a
   * different one — closing a review rather than releasing a queue — so the label is the
   * decision and not the mechanism. "Approve all" with nothing listed is a button whose
   * noun is not on the screen.
   */
  it("offers closing the gate instead of approving a list that is not there", () => {
    const html = render(PENDING, []);
    expect(html).toContain("Approve and close gate");
    expect(html).not.toContain(">Approve all<");
  });
});
