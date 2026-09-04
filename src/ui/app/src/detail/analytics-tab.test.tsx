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
import { formatDuration } from "./analytics";
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
    // The 11h is the FIRST figure on the page (the spoken sentence before it is
    // `sr-only` text, not a figure — see "the headline is spoken" below).
    expect(html.indexOf(figure("11h"))).toBeLessThan(html.indexOf(">actual<"));
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

// ------------------------------------------------- the child's effective plan (R7c)

/**
 * R7c (STA-194). What "visual regression coverage" means in a suite with no
 * screenshot harness and no browser: a DOM stand-in for each state the ticket
 * names — nested estimates, no estimate, not started, partial coverage, narrow
 * width — pinned as structure, text and class lists. Pixels are not claimed;
 * there is no harness to claim them with, and none is added for this.
 */

/** Every child's `est` figure, in document order: `4h`, `—`, ... */
const childPlans = (html: string): string[] =>
  [...html.matchAll(/data-testid="child-plan">est ([^<]+)</g)].map((match) => match[1]!);

/** The reverse of `formatDuration` for the two units the fixtures use. */
const seconds = (text: string): number => {
  const hours = /(\d+)h/.exec(text);
  const minutes = /(\d+)m/.exec(text);
  return (hours ? Number(hours[1]) * 3600 : 0) + (minutes ? Number(minutes[1]) * 60 : 0);
};

/** The markup from the Per child heading down. */
const perChild = (html: string): string => html.slice(html.indexOf('aria-label="Per child"'));

describe("a child shows the plan its parent counts it as", () => {
  it("STA-157 under STA-156 reads est 11h, not an em dash", () => {
    const html = render(STA_156);
    const list = perChild(html);
    const sta157 = list.slice(list.indexOf("STA-157"), list.indexOf("STA-158"));
    expect(sta157).toContain('data-testid="child-plan">est 11h<');
    expect(sta157).not.toContain("est —");
    // The other five have nothing anywhere beneath them and say so.
    expect(childPlans(html)).toEqual(["11h", "—", "—", "—", "—", "—"]);
  });

  it("puts the provenance in a tooltip, never a third line", () => {
    const list = perChild(render(STA_156));
    expect(list).toContain('title="inherited from 3 of 3 descendants" data-testid="child-plan"');
    // Not as text: nothing between the tags says "inherited".
    expect(list).not.toMatch(/>[^<]*inherited/);
    // Two lines per child, six children — twelve `ChildLine` divs, and not one more. (The
    // identifier and status badge share a span with the same classes INSIDE line one.)
    expect((list.match(/<div class="flex items-center gap-2">/g) ?? []).length).toBe(12);
  });

  it("names an own estimate as own, so a typed 4h and a flowed-up 11h are told apart", () => {
    const list = perChild(render(STA_157));
    expect((list.match(/title="own estimate" data-testid="child-plan"/g) ?? []).length).toBe(3);
  });
});

describe("the parent total is the sum of the visible child plans", () => {
  it("STA-157: the 4h, 3h and 4h on the child lines add to the 11h headline", () => {
    const html = render(STA_157);
    const plans = childPlans(html);
    expect(plans).toEqual(["4h", "3h", "4h"]);
    const sum = plans.reduce((total, text) => total + seconds(text), 0);
    expect(sum).toBe(39_600);
    expect(html).toContain(figure(formatDuration(sum)));
  });

  it("STA-156: one inheriting child and five empty ones add to the same 11h", () => {
    const html = render(STA_156);
    const sum = childPlans(html)
      .filter((text) => text !== "—")
      .reduce((total, text) => total + seconds(text), 0);
    expect(sum).toBe(39_600);
    expect(html).toContain(figure(formatDuration(sum)));
  });
});

describe("the headline is spoken as one sentence in a fixed order", () => {
  const worked = {
    ...STA_156,
    timing: { ...STA_156.timing, activeSeconds: 18_000, childrenActiveSeconds: 18_000 },
  };

  it("says planned, actual, difference, coverage, source — before the figures", () => {
    const html = render(worked);
    const start = html.indexOf('<p class="sr-only" data-testid="summary-sentence">');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(html.indexOf(figure("11h")));
    const sentence = html.slice(start, html.indexOf("</p>", start));
    expect(sentence).toMatch(
      /Planned 11h\. Actual 5h[^.]*\. Difference 6h under \(55%\)\. Coverage 3 of 9 descendants planned\. Source inherited from descendants\./,
    );
    const at = (word: string) => {
      const index = sentence.indexOf(word);
      expect(index, word).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at("Planned ")).toBeLessThan(at("Actual "));
    expect(at("Actual ")).toBeLessThan(at("Difference "));
    expect(at("Difference ")).toBeLessThan(at("Coverage "));
    expect(at("Coverage ")).toBeLessThan(at("Source "));
  });

  it("hides the figure row from the accessibility tree, so the facts are heard once", () => {
    const html = render(STA_157);
    expect(html).toMatch(/<div class="flex flex-wrap items-end[^"]*" aria-hidden="true">/);
    expect((html.match(/data-testid="summary-sentence"/g) ?? []).length).toBe(1);
  });

  it("speaks the same absences the figures draw", () => {
    const html = render(detail({ identifier: "STA-1" }, timing()));
    expect(html).toContain(
      "Planned No estimate. Actual No work recorded. Difference No comparison. Coverage no descendants. Source no plan.",
    );
  });
});

describe("regression stand-ins for the five screenshot states", () => {
  it("nested estimates: STA-156 over STA-157 — headline 11h, one line est 11h, five lines est —", () => {
    const html = render(STA_156);
    expect(html).toContain(figure("11h"));
    expect(childPlans(html)).toEqual(["11h", "—", "—", "—", "—", "—"]);
    expect(html).toContain("5 of 6 children have no plan");
  });

  it("no estimate: a bare issue names the absence small and muted, with no child slot at all", () => {
    const html = render(detail({ identifier: "STA-1" }, timing()));
    expect(html).toContain(placeholder("No estimate"));
    expect(html).not.toContain('data-testid="child-plan"');
    expect(html).not.toContain("est —");
  });

  it("not started: three planned tasks each read `ran —`, and the actual is a named absence", () => {
    const html = render(STA_157);
    expect(html).toContain(placeholder("No work recorded"));
    expect((perChild(html).match(/ · ran —/g) ?? []).length).toBe(3);
    expect(html).not.toContain(figure("0s"));
  });

  it("partial coverage: one planned child of three, and the caveat agrees with the column", () => {
    const html = render(
      detail(
        { identifier: "STA-9", kind: "epic" },
        timing({
          childCount: 3,
          childrenEstimatedSeconds: 3600,
          subtreePlan: plan({
            estimatedSeconds: 3600,
            source: "descendants",
            descendantsEstimatedSeconds: 3600,
            contributingCount: 1,
            totalCount: 3,
          }),
        }),
        [
          issue({ identifier: "STA-10", estimatedSeconds: 3600 }),
          issue({ identifier: "STA-11" }),
          issue({ identifier: "STA-12" }),
        ],
        { "STA-10": timing({ estimatedSeconds: 3600, subtreePlan: plan({ estimatedSeconds: 3600, source: "own" }) }) },
      ),
    );
    expect(childPlans(html)).toEqual(["1h", "—", "—"]);
    expect(html).toContain(figure("1h"));
    expect(html).toContain("2 of 3 children have no plan");
    expect(html).toContain("Coverage 1 of 3 descendants planned.");
  });

  it("narrow width: child lines truncate the title and pin the figures; the headline wraps", () => {
    // The 440px drawer is a CSS fact. What the DOM can promise is the shape that survives
    // it — a `truncate` title in a `flex-1` cell with a `shrink-0` figure beside it, a
    // `flex-wrap` headline, and no fixed-width table anywhere for the figures to fall off.
    const html = render(STA_156);
    const list = perChild(html);
    expect(list).toContain('class="min-w-0 flex-1 truncate');
    expect(list).toContain('class="shrink-0 font-mono tabular-nums');
    expect(html).toContain("flex flex-wrap items-end");
    expect(html).not.toContain("<table");
  });
});
