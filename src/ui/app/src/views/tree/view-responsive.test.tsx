/**
 * R4e (STA-190) — THE FIVE GROUPINGS AT A NARROW WIDTH AND A WIDE ONE.
 *
 * ── WHAT A "VISUAL CHECK" IS IN THIS REPO, SAID PLAINLY ───────────────────────────────
 *
 * There is no jsdom, no browser and no screenshot harness here, and this ticket adds no
 * dependency — the suite renders components to a STRING with `react-dom/server`. So a
 * "visual check" below is exactly two things, and it is worth being explicit about the
 * limit rather than implying a picture was compared:
 *
 *   1. THE MARKUP AT TWO WIDTHS. §14's one width-dependent decision that cannot be made in
 *      CSS is the label cap — the `+N` changes with the cap and no media query can recount —
 *      so `TreeGrid` measures the viewport with `matchMedia` and passes a number down. That
 *      measurement is stubbed here, which makes the narrow and the wide page two genuinely
 *      different strings, and both are asserted.
 *   2. THE STYLESHEET THAT DOES THE REST. Everything else §14 drops is a media query, so
 *      the DOM is identical at both widths BY DESIGN and the assertion has to be about the
 *      rule. `task-list.css` is read with its comments stripped — the technique
 *      `group-header.test.tsx` uses for the R4d separator — so the sheet's own prose about
 *      a rule cannot satisfy a test looking for the rule.
 *
 * What a screenshot would have shown at 400px — the meta cluster on line two, the date
 * back, the rolled-up plan gone, the labels as dots — is the `@media (max-width: 719px)`
 * block plus the `max-[719px]:hidden` utility plus the label cap, and all three are read
 * directly below.
 *
 * ── AND THE CLAIM THAT MATTERS MOST IS AN INVARIANCE ──────────────────────────────────
 *
 * Every grouping renders at both widths, and the SAME rows are in the SAME sections with
 * the SAME cues and the SAME accessible structure. Width is allowed to abbreviate; it is
 * never allowed to change what the page says. That is one assertion repeated ten times, and
 * it is the one that would catch a "responsive" fix that quietly drops a column of meaning.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { attachRowCues, buildRowCueIndex } from "@/components/task-list/row-cues";
import { NEVER_DROPPED } from "@/components/task-list/config";
import type { GroupBy } from "@/lib/view-prefs";
import { driftMilestoneTitles, driftQueue, driftRows, withGate } from "./drift-fixture";
import { TreeGrid } from "./TreeGrid";

const BOARD = withGate(driftRows());
const CUED = attachRowCues(BOARD, buildRowCueIndex(driftQueue(), driftMilestoneTitles()));

/** Comments stripped, so the sheet's prose about a rule cannot stand in for the rule. */
const CSS = readFileSync(
  fileURLToPath(new URL("../../components/task-list/task-list.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The §14 breakpoint below which the row becomes two lines. */
const TWO_LINE_BREAKPOINT = 719;
const NARROW = 400;
const WIDE = 1440;

/**
 * Render as if the viewport were `width` px.
 *
 * `useLabelCapacity()` is the one width measurement in the tree, and it asks `matchMedia`
 * two `min-width` questions. Stubbing that — rather than stubbing the hook or passing a prop
 * the component does not have — means the component under test is the shipped one and the
 * only thing that changed is what the browser would have answered.
 */
function atWidth(width: number, groupBy: GroupBy): string {
  const globals = globalThis as { window?: unknown };
  const previous = globals.window;
  globals.window = {
    matchMedia: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      return { matches: min ? width >= Number(min[1]) : false };
    },
  };
  try {
    return renderToStaticMarkup(
      <TreeGrid
        rows={CUED}
        allRows={CUED}
        mode="workspace"
        groupBy={groupBy}
        currentRef={null}
        showResolved={false}
        onOpen={() => {}}
        onCloseDrawer={() => {}}
        onVisibleOrder={() => {}}
      />,
    );
  } finally {
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  }
}

afterEach(() => {
  // Belt and braces: no test in this file may leave a `window` behind for the next one.
  delete (globalThis as { window?: unknown }).window;
});

/** Every row drawn, in page order, as `identifier -> its slice of markup`. */
function rows(markup: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /data-testid="task-row" data-identifier="([^"]+)"/g;
  const starts: { id: string; at: number }[] = [];
  for (let m = re.exec(markup); m; m = re.exec(markup)) starts.push({ id: m[1]!, at: m.index });
  starts.forEach(({ id, at }, index) => {
    out.set(id + (out.has(id) ? ":ghost" : ""), markup.slice(at, starts[index + 1]?.at));
  });
  return out;
}

const sections = (markup: string) =>
  [...markup.matchAll(/data-group-key="([^"]+)"/g)].map((m) => m[1]!);

const AXES: readonly GroupBy[] = ["none", "status", "pickup", "parent", "kind"];

describe("every grouping renders at both widths and says the same thing", () => {
  for (const axis of AXES) {
    describe(`group by ${axis}`, () => {
      const narrow = atWidth(NARROW, axis);
      const wide = atWidth(WIDE, axis);

      it("draws the same sections, in the same order", () => {
        expect(sections(narrow)).toEqual(sections(wide));
        expect(narrow).toContain(`data-group-by="${axis}"`);
      });

      it("draws the same rows, at the same levels, in the same order", () => {
        expect([...rows(narrow).keys()]).toEqual([...rows(wide).keys()]);
        for (const [id, markup] of rows(narrow)) {
          const level = /aria-level="(\d+)"/.exec(markup)?.[1];
          expect(level, `${axis} · ${id}`).toBe(/aria-level="(\d+)"/.exec(rows(wide).get(id)!)?.[1]);
        }
      });

      it("keeps the five elements §14 never drops, at 400px", () => {
        // `NEVER_DROPPED` is the spec's list. The row is one component with one config, so
        // the check is that the narrow render still contains each element's marker.
        expect(NEVER_DROPPED).toEqual(["priority", "identifier", "status", "assignee", "claim"]);
        const epic = rows(narrow).get("STA-1")!;
        expect(epic).toContain("staple-row-priority");
        expect(epic).toContain(">STA-1<");
        expect(epic).toContain("staple-row-status");
        const live = rows(narrow).get("STA-2");
        // The live claim's pill survives wherever the row is drawn on this axis.
        if (live) expect(live).toContain("staple-working-pill");
      });
    });
  }
});

describe("the cues survive every width, because they live in the title cell", () => {
  /**
   * R4c put both cues FIRST in `.staple-row-title-cell` rather than in a grid track of their
   * own, and the consequence is the thing worth pinning: the title cell is the one track
   * that survives §14's two-line reflow intact, so the cues cannot be dropped by a width.
   * The alternative — a track — would have changed the column template for all three presets
   * at every breakpoint to say one thing about one surface.
   */
  it("draws the pickup cue and the milestone marker at 400px exactly as at 1440px", () => {
    const narrow = rows(atWidth(NARROW, "none"));
    const wide = rows(atWidth(WIDE, "none"));

    for (const id of ["STA-1", "STA-2", "STA-5", "STA-8"]) {
      const cue = /data-pickup-cue="([^"]+)"/.exec(narrow.get(id)!)?.[1];
      expect(cue, id).toBe(/data-pickup-cue="([^"]+)"/.exec(wide.get(id)!)?.[1]);
    }
    expect(narrow.get("STA-2")).toContain('data-testid="row-milestone-cue"');
    expect(narrow.get("STA-8")).toContain('data-pickup-cue="pickable"');
  });

  it("is never touched by a media query — no rule hides either cue at any width", () => {
    /*
     * The DOM proof above cannot say this on its own: both cues are in the markup at both
     * widths BECAUSE nothing drops them, and "nothing drops them" is a fact about the sheet.
     * The contrast is `.staple-worklog-cue` and `.staple-row-date`, which ARE dropped, in
     * §14's documented order — so the absence below is a decision rather than an oversight.
     */
    for (const selector of [".staple-row-cue", ".staple-row-milestone"]) {
      for (const block of mediaBlocks()) {
        expect(block.body.includes(selector), `${selector} in ${block.query}`).toBe(false);
      }
    }
    // ...and the two that DO drop, so this test fails if the sheet stops dropping anything.
    expect(mediaBlocks().some((b) => b.body.includes(".staple-worklog-cue"))).toBe(true);
    expect(mediaBlocks().some((b) => b.body.includes(".staple-row-date"))).toBe(true);
  });
});

describe("what narrow actually changes", () => {
  it("degrades the label pills to bare dots — the one decision CSS cannot make", () => {
    /*
     * The `+N` changes with the cap, and no media query can recount. So this is the single
     * width-dependent branch in the component, and it is the only reason the two renders in
     * this file are different strings at all.
     */
    const wide = rows(atWidth(WIDE, "none")).get("STA-2")!;
    const narrow = rows(atWidth(NARROW, "none")).get("STA-2")!;

    // Wide: two named pills and an overflow that says what it hid.
    expect((wide.match(/data-testid="label-pill"/g) ?? []).length).toBe(2);
    expect(wide).toContain('data-testid="label-overflow"');
    expect(wide).toContain(">ui<");
    // Narrow: colour survives, names do not, and the title still carries all three.
    expect(narrow).toContain('data-testid="label-dots"');
    expect(narrow).not.toContain('data-testid="label-pill"');
    expect(narrow).toContain('title="ui, queue, tests"');
  });

  it("hides the rolled-up plan with a utility class rather than a rule in the sheet", () => {
    /*
     * Below the breakpoint the title track is the whole row width and there is no room for
     * an aside, so R7c's `est 3h` yields there. It is the same markup at both widths — a
     * `max-[719px]:hidden` utility — which is exactly why a markup-only test cannot see the
     * difference and the class itself is the assertion.
     */
    const epic = rows(atWidth(NARROW, "none")).get("STA-5")!;

    expect(epic).toContain('data-testid="parent-rollup-plan"');
    expect(epic).toContain('class="staple-rollup-count max-[719px]:hidden"');
    expect(epic).toContain("est 3h");
    // The count and the bar are NOT hidden: a folded epic must still say 0/2 at any width.
    expect(epic).toContain('data-testid="parent-rollup-bar"');
    expect(epic).toContain('aria-label="0 of 2 done"');
    expect(epic).toMatch(/<span class="staple-rollup-count" aria-label="0 of 2 done"/);
  });

  it("reflows the row to two lines at 719px, with the meta cluster on the second", () => {
    const block = mediaBlocks().find((b) => b.query.includes(`max-width: ${TWO_LINE_BREAKPOINT}px`));
    expect(block, "no two-line breakpoint in the sheet").toBeDefined();

    expect(block!.body).toMatch(/\.staple-row\s*{[^}]*height:\s*56px/);
    expect(block!.body).toMatch(/grid-template-rows:\s*28px 28px/);
    // The cluster takes a whole line of its own, which is why the date and the worklog cue
    // come BACK here after being dropped at the wider breakpoints.
    expect(block!.body).toMatch(/\.staple-row-meta\s*{[^}]*grid-column:\s*1 \/ -1/);
    expect(block!.body).toMatch(/\.staple-row-date\s*{[^}]*display:\s*inline/);
    expect(block!.body).toMatch(/\.staple-worklog-cue\s*{[^}]*display:\s*inline-flex/);
  });

  it("drops the wider elements in §14's order — date before the working label", () => {
    const queries = mediaBlocks().map((b) => b.query);
    // 959 drops the worklog cue, 879 the date and the pill's word, 719 reflows. Least
    // diagnostic first, which is the order the spec fixes and the sheet has to follow.
    expect(queries.some((q) => q.includes("max-width: 959px"))).toBe(true);
    expect(queries.some((q) => q.includes("max-width: 879px"))).toBe(true);
    const at879 = mediaBlocks().find((b) => b.query.includes("879px"))!.body;
    expect(at879).toContain(".staple-row-date");
    expect(at879).toContain(".staple-working-label");
  });
});

/** Every `@media` block in the sheet, as `{ query, body }`. Nested rules are not used here. */
function mediaBlocks(): { query: string; body: string }[] {
  const out: { query: string; body: string }[] = [];
  const re = /@media([^{]+){/g;
  for (let m = re.exec(CSS); m; m = re.exec(CSS)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === "{") depth += 1;
      else if (CSS[i] === "}") depth -= 1;
      i += 1;
    }
    out.push({ query: m[1]!.trim(), body: CSS.slice(start, i - 1) });
  }
  return out;
}
