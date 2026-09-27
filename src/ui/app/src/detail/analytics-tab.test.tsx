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
import { formatDuration, spokenDuration } from "./analytics";
import { AnalyticsTab } from "./tabs/AnalyticsTab";

const NOW = Date.now();
const agoIso = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function plan(over: Partial<SubtreePlan> = {}): SubtreePlan {
  return {
    estimatedSeconds: null,
    source: "none",
    descendantsEstimatedSeconds: null,
    contributingCount: 0,
    unplannedCount: 0,
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
    workSeconds: null,
    estimateRatio: null,
    quality: {
      work: { state: "missing", inputs: [], reasons: ["never_started"], coverage: null, missingInputs: [] },
      wall: { state: "missing", inputs: [], reasons: ["never_started"] },
    },
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

/** A real duration in the headline: words in the interface face, weighted — never mono. */
const figure = (text: string) => `class="font-semibold text-foreground">${text}</span>`;
/** A placeholder in the headline: the regular, secondary word. */
const placeholder = (text: string) => `class="font-normal text-text-secondary">${text}</span>`;

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
      unplannedCount: 0,
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
      unplannedCount: 6,
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
        unplannedCount: 0,
        totalCount: 3,
      }),
    }),
  },
);

describe("a parent leads with the rolled-up plan", () => {
  it("STA-157 leads with 11h planned, not with 'no estimate recorded'", () => {
    const html = render(STA_157);
    expect(html).toContain(figure("11 hours"));
    expect(html).toContain("inherited from 3 of 3 units");
    expect(html).not.toContain("no estimate recorded");
    // The 11h is the FIRST figure on the page (the spoken sentence before it is
    // `sr-only` text, not a figure — see "the headline is spoken" below).
    expect(html.indexOf(figure("11 hours"))).toBeLessThan(html.indexOf('data-figure="actual"'));
  });

  it("STA-156 leads with the recursive descendant plan, not with '0 of 6 estimated'", () => {
    const html = render(STA_156);
    expect(html).toContain(figure("11 hours"));
    expect(html).toContain("inherited from 3 of 9 units");
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
    expect((html.match(/data-figure="planned"/g) ?? []).length).toBe(1);
    expect((html.match(/data-figure="actual"/g) ?? []).length).toBe(1);
    expect((html.match(/data-figure="difference"/g) ?? []).length).toBe(1);
  });

  it("says the real durations and the difference in words, never in mono", () => {
    const html = render(leaf);
    expect(html).toContain(figure("2 hours"));
    expect(html).toContain(figure("1 hour"));
    // The spoken summary keeps the exact label; the visible line says what it means.
    expect(html).toContain("1h under (50%)");
    expect(html).toContain(
      '<p data-figure="difference" class="text-reading font-medium text-[var(--status-task-done)]">Finished 1 hour under the plan</p>',
    );
    expect(html).not.toContain("font-mono");
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
            unplannedCount: 0,
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
    expect(html).toContain("bottom-up, from 3 of 3 units");
    expect(html).toContain("aggregated from 3 children");
    // The headline is the own estimate; the disagreement with the children is visible, not summed.
    expect(html).toContain(figure("6 hours"));
    expect(html).toContain("descendants add up to 11h");
    expect(html).toContain("never added together");
  });

  it("names the absences in the rows, in words", () => {
    const html = render(STA_157);
    expect(html).toContain("no estimate set on this issue");
    expect(html).toContain("never worked directly");
    expect(html).toContain("bottom-up, from 3 of 3 units");
  });
});

describe("placeholders are muted words in the interface face, never figures", () => {
  const empty = detail({ identifier: "STA-1" }, timing());

  it("renders 'No estimate' and 'No work recorded' as regular secondary words, never as figures", () => {
    const html = render(empty);
    expect(html).toContain(placeholder("No estimate"));
    expect(html).toContain(placeholder("No work recorded"));
    // No difference line at all without both sides; the caveat says why.
    expect(html).not.toContain('data-figure="difference"');
    expect(html).not.toContain(figure("No estimate"));
    expect(html).not.toContain(figure("No work recorded"));
    expect(html).not.toContain("data-plan-bar");
    expect(html).toContain("No estimate and no time recorded yet.");
  });

  it("never draws a placeholder as a dash that reads as zero in the headline", () => {
    const html = render(empty);
    expect(html).not.toContain(figure("—"));
    expect(html).not.toContain(figure("0 seconds"));
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
            unplannedCount: 2,
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
    expect(html).toContain("still running, so its difference can still change");
    expect(html).toContain("unfinished but idle: its clock stopped");
    expect(html).toContain('data-child-activity="running"> so far<');
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
    expect(at('aria-label="Summary"')).toBeLessThan(at('data-figure="planned"'));
    expect(at('data-figure="planned"')).toBeLessThan(at('data-figure="actual"'));
    expect(at('data-figure="actual"')).toBeLessThan(at('aria-label="Breakdown"'));
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

/** Every child's plan, in document order: `4 hours`, `—` (for "No plan"), ... */
const childPlans = (html: string): string[] =>
  [...html.matchAll(/data-testid="child-plan">([^<]+)</g)].map((match) =>
    match[1] === "No plan" ? "—" : match[1]!.replace(/^Planned /, ""),
  );

/** The reverse of `spokenDuration` for the two units the fixtures use. */
const seconds = (text: string): number => {
  const hours = /(\d+) hours?/.exec(text);
  const minutes = /(\d+) minutes?/.exec(text);
  return (hours ? Number(hours[1]) * 3600 : 0) + (minutes ? Number(minutes[1]) * 60 : 0);
};

/** The markup from the Per child heading down. */
const perChild = (html: string): string => html.slice(html.indexOf('aria-label="Per child"'));

describe("a child shows the plan its parent counts it as", () => {
  it("STA-157 under STA-156 reads Planned 11 hours, not No plan", () => {
    const html = render(STA_156);
    const list = perChild(html);
    const sta157 = list.slice(list.indexOf("STA-157"), list.indexOf("STA-158"));
    expect(sta157).toContain('data-testid="child-plan">Planned 11 hours<');
    expect(sta157).not.toContain(">No plan<");
    // The other five have nothing anywhere beneath them and say so.
    expect(childPlans(html)).toEqual(["11 hours", "—", "—", "—", "—", "—"]);
  });

  it("puts the provenance in a tooltip, never a third line", () => {
    const list = perChild(render(STA_156));
    expect(list).toContain('title="inherited from 3 of 3 units" data-testid="child-plan"');
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
  it("STA-157: the 4, 3 and 4 hours on the child lines add to the 11-hour headline", () => {
    const html = render(STA_157);
    const plans = childPlans(html);
    expect(plans).toEqual(["4 hours", "3 hours", "4 hours"]);
    const sum = plans.reduce((total, text) => total + seconds(text), 0);
    expect(sum).toBe(39_600);
    expect(html).toContain(figure(spokenDuration(sum)));
  });

  it("STA-156: one inheriting child and five empty ones add to the same 11h", () => {
    const html = render(STA_156);
    const sum = childPlans(html)
      .filter((text) => text !== "—")
      .reduce((total, text) => total + seconds(text), 0);
    expect(sum).toBe(39_600);
    expect(html).toContain(figure(spokenDuration(sum)));
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
    expect(start).toBeLessThan(html.indexOf(figure("11 hours")));
    const sentence = html.slice(start, html.indexOf("</p>", start));
    expect(sentence).toMatch(
      /Planned 11h\. Actual 5h[^.]*\. Difference 6h under \(55%\)\. Coverage 3 of 9 units planned\. Source inherited from descendants\./,
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
  it("nested estimates: STA-156 over STA-157 — headline 11 hours, one line planned 11 hours, five with no plan", () => {
    const html = render(STA_156);
    expect(html).toContain(figure("11 hours"));
    expect(childPlans(html)).toEqual(["11 hours", "—", "—", "—", "—", "—"]);
    expect(html).toContain("5 of 6 children have no plan");
  });

  it("no estimate: a bare issue names the absence small and muted, with no child slot at all", () => {
    const html = render(detail({ identifier: "STA-1" }, timing()));
    expect(html).toContain(placeholder("No estimate"));
    expect(html).not.toContain('data-testid="child-plan"');
    expect(html).not.toContain(">No plan<");
  });

  it("not started: three planned tasks each read `not started`, and the actual is a named absence", () => {
    const html = render(STA_157);
    expect(html).toContain(placeholder("No work recorded"));
    expect((perChild(html).match(/ · not started/g) ?? []).length).toBe(3);
    expect(html).not.toContain(figure("0 seconds"));
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
            unplannedCount: 2,
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
    expect(childPlans(html)).toEqual(["1 hour", "—", "—"]);
    expect(html).toContain(figure("1 hour"));
    expect(html).toContain("2 of 3 children have no plan");
    expect(html).toContain("Coverage 1 of 3 units planned.");
  });

  it("narrow width: child lines truncate the title and pin the figures; the headline wraps", () => {
    // The 440px drawer is a CSS fact. What the DOM can promise is the shape that survives
    // it — a `truncate` title in a `flex-1` cell with a `shrink-0` figure beside it, a
    // `flex-wrap` headline, and no fixed-width table anywhere for the figures to fall off.
    const html = render(STA_156);
    const list = perChild(html);
    expect(list).toContain('class="min-w-0 flex-1 truncate');
    expect(list).toContain('class="shrink-0 tabular-nums');
    expect(html).not.toContain("font-mono");
    expect(html).toContain("flex flex-wrap items-end");
    expect(html).not.toContain("<table");
  });
});

// ------------------------------------------------------------------ measurement quality

describe("each record says how far it can be trusted", () => {
  it("names the work state beside the work figure, and the elapsed state, after the per-child rows", () => {
    const html = render(
      detail(
        { identifier: "STA-20" },
        timing({
          workSeconds: 2400,
          quality: {
            work: { state: "approximate", inputs: ["sparse"], reasons: ["sparse"], coverage: null, missingInputs: [] },
            wall: { state: "exact", inputs: [], reasons: [] },
          },
        }),
      ),
    );
    expect(html).toContain('aria-label="Measurement quality"');
    expect(html).toContain(`data-testid="quality-work">${formatDuration(2400)} · approximate · silences over 30 min<`);
    expect(html).toContain('data-testid="quality-wall">exact<');
  });

  it("labels every child with its state, a timing-floor child included", () => {
    const html = render(
      detail(
        { identifier: "STA-30", kind: "epic" },
        timing({ childCount: 2 }),
        [issue({ identifier: "STA-31" }), issue({ identifier: "STA-32" })],
        {
          "STA-31": timing({ activeSeconds: 1323, workSeconds: 30, quality: { work: { state: "timing-floor", inputs: [], reasons: ["timing_floor"], coverage: null, missingInputs: [] }, wall: { state: "exact", inputs: [], reasons: [] } } }),
          "STA-32": timing({ quality: { work: { state: "exact", inputs: [], reasons: [], coverage: null, missingInputs: [] }, wall: { state: "exact", inputs: [], reasons: [] } } }),
        },
      ),
    );
    // The state qualifies the work figure, which sits beside it; the row's "ran" is category time.
    expect([...html.matchAll(/data-testid="child-quality">([^<]+)</g)].map((match) => match[1])).toEqual(["work 30s · under a minute", "exact"]);
    // The measurement section sits after the per-child rows: it qualifies them, it does not lead.
    expect(html.indexOf('aria-label="Per child"')).toBeLessThan(html.indexOf('aria-label="Measurement quality"'));
  });
});
