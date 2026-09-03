/**
 * R7b (STA-193) — what the Analytics tab actually puts in the DOM.
 *
 * Rendered to a string with `react-dom/server`, following `gate-review.test.tsx`
 * and `components/task-list/row-render.test.tsx`: the suite has no jsdom and does
 * not want one. That bounds what is claimed here, on purpose —
 *
 *   WHAT IS ASSERTED: which sections exist, in what ORDER, which words each figure
 *   sits beside, and which class list a value wears — a real duration is the large
 *   tabular figure, a placeholder is the small muted word. The arithmetic and the
 *   sentences are analytics.ts's and are pinned in analytics.test.ts.
 *
 *   WHAT IS NOT: pixels. "Fits at 440px" is a CSS fact about a browser. The
 *   reading-order claim across drawer, desktop and full-screen IS provable here,
 *   because the tab is one component in one column that never reads the detail
 *   mode: the order this string has is the order every layout has.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { issue } from "@/components/task-list/fixtures";
import type { Issue, IssueDetail, IssueTiming, SubtreePlan } from "@/lib/types";
import { AnalyticsTab } from "./tabs/AnalyticsTab";

const NOW = Date.now();
const agoIso = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function plan(over: Partial<SubtreePlan> = {}): SubtreePlan {
  return {
    estimatedSeconds: null,
    source: "none",
    descendantsEstimatedSeconds: null,
    contributingCount: 0,
    totalCount: 0,
    ...over,
  };
}

function timing(over: Partial<IssueTiming> = {}): IssueTiming {
  return {
    estimatedSeconds: null,
    ownActiveSeconds: null,
    activeSeconds: null,
    reviewSeconds: null,
    approximate: false,
    countedThrough: null,
    childCount: 0,
    childrenEstimatedSeconds: null,
    childrenActiveSeconds: null,
    childStatusCounts: {
      backlog: 0, todo: 0, in_progress: 0, in_review: 0, awaiting_approval: 0, done: 0, blocked: 0, cancelled: 0,
    },
    subtreePlan: plan(),
    ...over,
  };
}

function detail(
  over: Partial<Issue>,
  issueTiming: IssueTiming,
  children: Issue[] = [],
  childrenTiming: Record<string, IssueTiming> = {},
): IssueDetail {
  return {
    workspace: "staple",
    issue: issue(over),
    ancestors: [],
    children,
    blockedBy: [],
    blocks: [],
    comments: [],
    documents: [],
    crossBlockers: [],
    claim: null,
    timing: issueTiming,
    childrenTiming,
    gate: null,
    queuedBy: null,
    childrenQueued: [],
  };
}

function render(d: IssueDetail): string {
  return renderToStaticMarkup(
    <AnalyticsTab detail={d} workspace="staple" onAuthError={() => {}} refresh={() => {}} />,
  );
}

/** A real duration in the headline: the large tabular figure. */
const figure = (text: string) => `<div class="font-mono text-2xl leading-tight tabular-nums">${text}</div>`;
/** A placeholder in the headline: the small muted word, in the interface face. */
const placeholder = (text: string) => `<div class="text-xs text-muted-foreground">${text}</div>`;

// ------------------------------------------------------------------ the two cases

/**
 * STA-157: an epic nobody estimated over three tasks at 4h/3h/4h, none started.
 * The plan is 11h and the tab must SAY 11h, not "no estimate recorded".
 */
const STA_157 = detail(
  { identifier: "STA-157", kind: "epic" },
  timing({
    childCount: 3,
    childrenEstimatedSeconds: 39_600,
    subtreePlan: plan({
      estimatedSeconds: 39_600,
      source: "descendants",
      descendantsEstimatedSeconds: 39_600,
      contributingCount: 3,
      totalCount: 3,
    }),
  }),
  [
    issue({ identifier: "STA-165", estimatedSeconds: 14_400 }),
    issue({ identifier: "STA-166", estimatedSeconds: 10_800 }),
    issue({ identifier: "STA-167", estimatedSeconds: 14_400 }),
  ],
  {
    "STA-165": timing({ estimatedSeconds: 14_400, subtreePlan: plan({ estimatedSeconds: 14_400, source: "own" }) }),
    "STA-166": timing({ estimatedSeconds: 10_800, subtreePlan: plan({ estimatedSeconds: 10_800, source: "own" }) }),
    "STA-167": timing({ estimatedSeconds: 14_400, subtreePlan: plan({ estimatedSeconds: 14_400, source: "own" }) }),
  },
);

/**
 * STA-156: six unestimated direct children, one of which (STA-157) inherits 11h
 * from ITS children. Depth-1 sees nothing; the recursive plan sees 11h.
 */
const STA_156_CHILDREN = ["STA-157", "STA-158", "STA-159", "STA-160", "STA-161", "STA-162"].map((identifier) =>
  issue({ identifier, kind: "epic" }),
);
const STA_156 = detail(
  { identifier: "STA-156", kind: "epic" },
  timing({
    childCount: 6,
    childrenEstimatedSeconds: null,
    subtreePlan: plan({
      estimatedSeconds: 39_600,
      source: "descendants",
      descendantsEstimatedSeconds: 39_600,
      contributingCount: 3,
      totalCount: 9,
    }),
  }),
  STA_156_CHILDREN,
  {
    "STA-157": timing({
      childCount: 3,
      childrenEstimatedSeconds: 39_600,
      subtreePlan: plan({
        estimatedSeconds: 39_600,
        source: "descendants",
        descendantsEstimatedSeconds: 39_600,
        contributingCount: 3,
        totalCount: 3,
      }),
    }),
  },
);

describe("a parent leads with the rolled-up plan", () => {
  it("STA-157 leads with 11h planned, not with 'no estimate recorded'", () => {
    const html = render(STA_157);
    expect(html).toContain(figure("11h"));
    expect(html).toContain("inherited from 3 of 3 descendants");
    expect(html).not.toContain("no estimate recorded");
    // The 11h is the FIRST figure on the page.
    expect(html.indexOf(figure("11h"))).toBeLessThan(html.indexOf("aggregated from 3 children"));
  });

  it("STA-156 leads with the recursive descendant plan, not with '0 of 6 estimated'", () => {
    const html = render(STA_156);
    expect(html).toContain(figure("11h"));
    expect(html).toContain("inherited from 3 of 9 descendants");
    expect(html).not.toContain("0 of 6");
    expect(html).not.toContain("6 of 6");
    // The coverage caveat measures PLANS, so STA-157 counts as planned.
    expect(html).toContain("5 of 6 children have no plan");
  });

  it("gives a parent exactly one summary and one breakdown", () => {
    const html = render(STA_157);
    expect((html.match(/aria-label="Summary"/g) ?? []).length).toBe(1);
    expect((html.match(/aria-label="Breakdown"/g) ?? []).length).toBe(1);
    expect(html).not.toContain("estimated total");
    expect(html).not.toContain("actual total");
  });
});

describe("a leaf gets one summary and nothing else", () => {
  const leaf = detail(
    { identifier: "STA-42", status: "done" },
    timing({
      estimatedSeconds: 7200,
      ownActiveSeconds: 3600,
      activeSeconds: 3600,
      subtreePlan: plan({ estimatedSeconds: 7200, source: "own" }),
    }),
  );

  it("never renders a duplicate total card", () => {
    const html = render(leaf);
    expect((html.match(/aria-label="Summary"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('aria-label="Breakdown"');
    expect(html).not.toContain('aria-label="Per child"');
    expect((html.match(/>planned</g) ?? []).length).toBe(1);
    expect((html.match(/>actual</g) ?? []).length).toBe(1);
    expect((html.match(/>difference</g) ?? []).length).toBe(1);
  });

  it("sets the real durations and the delta as large tabular figures", () => {
    const html = render(leaf);
    expect(html).toContain(figure("2h"));
    expect(html).toContain(figure("1h"));
    expect(html).toContain("1h under (50%)");
    expect(html).toContain('class="font-mono text-2xl leading-tight tabular-nums text-[var(--status-task-done)]"');
  });
});

describe("the This issue and Children rows state the source of each number", () => {
  it("labels the top-down estimate, the bottom-up plan, and both actuals", () => {
    const html = render(
      detail(
        { identifier: "STA-9", kind: "epic" },
        timing({
          estimatedSeconds: 21_600,
          ownActiveSeconds: 900,
          activeSeconds: 18_000,
          childCount: 3,
          childrenActiveSeconds: 18_000,
          subtreePlan: plan({
            estimatedSeconds: 21_600,
            source: "own",
            descendantsEstimatedSeconds: 39_600,
            contributingCount: 3,
            totalCount: 3,
          }),
        }),
        [issue({ identifier: "STA-10", estimatedSeconds: 39_600 })],
        { "STA-10": timing({ estimatedSeconds: 39_600, activeSeconds: 18_000, subtreePlan: plan({ estimatedSeconds: 39_600, source: "own" }) }) },
      ),
    );
    expect(html).toContain("This issue");
    expect(html).toContain("top-down, set on this issue");
    expect(html).toContain("worked directly — not in the headline");
    expect(html).toContain("Children");
    expect(html).toContain("bottom-up, from 3 of 3 descendants");
    expect(html).toContain("aggregated from 3 children");
    // The headline is the own estimate; the disagreement with the children is visible, not summed.
    expect(html).toContain(figure("6h"));
    expect(html).toContain("descendants add up to 11h");
    expect(html).toContain("never added together");
  });

  it("names the absences in the rows, in words", () => {
    const html = render(STA_157);
    expect(html).toContain("no estimate set on this issue");
    expect(html).toContain("never worked directly");
    expect(html).toContain("bottom-up, from 3 of 3 descendants");
  });
});

describe("placeholders are muted words in the interface face, never figures", () => {
  const empty = detail({ identifier: "STA-1" }, timing());

  it("renders 'No estimate' and 'No work recorded' small, muted and un-mono", () => {
    const html = render(empty);
    expect(html).toContain(placeholder("No estimate"));
    expect(html).toContain(placeholder("No work recorded"));
    expect(html).toContain(placeholder("No comparison"));
    expect(html).not.toContain("tabular-nums\">No estimate");
    expect(html).not.toContain("tabular-nums\">No work recorded");
    expect(html).not.toContain("text-2xl");
    expect(html).toContain("No estimate and no time recorded yet.");
  });

  it("never draws a placeholder as a dash that reads as zero in the headline", () => {
    const html = render(empty);
    expect(html).not.toContain(figure("—"));
    expect(html).not.toContain(figure("0s"));
  });
});

describe("the caveats stay visible but concise", () => {
  it("says still running, and calls the delta provisional, on a live leaf", () => {
    const html = render(
      detail(
        { identifier: "STA-1", status: "in_progress" },
        timing({
          estimatedSeconds: 7200,
          ownActiveSeconds: 1800,
          activeSeconds: 1800,
          countedThrough: agoIso(30),
          subtreePlan: plan({ estimatedSeconds: 7200, source: "own" }),
        }),
      ),
    );
    expect(html).toContain("still running");
    expect(html).toContain("provisional — not finished");
  });

  it("says idle, with how long, on a stalled leaf", () => {
    const html = render(
      detail(
        { identifier: "STA-1", status: "in_progress" },
        timing({ activeSeconds: 1800, countedThrough: agoIso(7200) }),
      ),
    );
    expect(html).toContain("idle 2h — clock stopped at last activity");
  });

  it("names approximation and review time as one-sentence caveats, not figures", () => {
    const html = render(
      detail(
        { identifier: "STA-1", status: "done" },
        timing({
          estimatedSeconds: 3600,
          ownActiveSeconds: 3600,
          activeSeconds: 3600,
          reviewSeconds: 1800,
          approximate: true,
          subtreePlan: plan({ estimatedSeconds: 3600, source: "own" }),
        }),
      ),
    );
    expect(html).toContain("Approximate — no usable history");
    expect(html).toContain("30m in review, not counted as active time.");
    expect(html).not.toContain(">in review<");
  });

  it("keeps the parent's running, idle and partial-coverage notes", () => {
    const html = render(
      detail(
        { identifier: "STA-9", kind: "epic", status: "in_progress" },
        timing({
          childCount: 3,
          childrenEstimatedSeconds: 3600,
          childrenActiveSeconds: 900,
          activeSeconds: 900,
          subtreePlan: plan({
            estimatedSeconds: 3600,
            source: "descendants",
            descendantsEstimatedSeconds: 3600,
            contributingCount: 1,
            totalCount: 3,
          }),
        }),
        [
          issue({ identifier: "STA-10", estimatedSeconds: 3600, status: "in_progress" }),
          issue({ identifier: "STA-11", status: "in_progress" }),
          issue({ identifier: "STA-12" }),
        ],
        {
          "STA-10": timing({ estimatedSeconds: 3600, activeSeconds: 900, countedThrough: agoIso(30), subtreePlan: plan({ estimatedSeconds: 3600, source: "own" }) }),
          "STA-11": timing({ countedThrough: agoIso(7200) }),
        },
      ),
    );
    expect(html).toContain("2 of 3 children have no plan");
    expect(html).toContain("1 still running");
    expect(html).toContain("1 unfinished but idle");
    expect(html).toContain("* still running");
    expect(html).toContain("‡ unfinished but idle");
  });
});

describe("the reading order is the same in every layout", () => {
  it("goes headline (planned, actual, difference), then breakdown, then per child", () => {
    // One component, one column, no consultation of the detail mode — so the
    // order in this string is the order in the drawer, on the desktop, and full-screen.
    const html = render(STA_157);
    const at = (needle: string) => {
      const index = html.indexOf(needle);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at('aria-label="Summary"')).toBeLessThan(at(">planned<"));
    expect(at(">planned<")).toBeLessThan(at(">actual<"));
    expect(at(">actual<")).toBeLessThan(at(">difference<"));
    expect(at(">difference<")).toBeLessThan(at('aria-label="Breakdown"'));
    expect(at('aria-label="Breakdown"')).toBeLessThan(at(">This issue<"));
    expect(at(">This issue<")).toBeLessThan(at(">Children<"));
    expect(at(">Children<")).toBeLessThan(at('aria-label="Per child"'));
    expect(at('aria-label="Per child"')).toBeLessThan(at("STA-165"));
  });
});
