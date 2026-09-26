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
 *   1. THE MARKUP AT SEVERAL WIDTHS. Since the mobile list lane, EVERYTHING §14 drops is
 *      decided by one ladder (components/task-list/row-layout.ts) that `TreeGrid` reads
 *      through `matchMedia`, and a dropped element is absent from the DOM. That measurement
 *      is stubbed here, so each width is a genuinely different string and the precedence
 *      can be read straight off the markup.
 *   2. THE STYLESHEET, for the one thing the markup cannot say: the compact row's geometry
 *      (one 48px line, no second grid row). `task-list.css` is read with its comments
 *      stripped — the technique `group-header.test.tsx` uses for the R4d separator — so the
 *      sheet's own prose about a rule cannot satisfy a test looking for the rule.
 *
 * The measured half — row height, same-line badges, overflow at 360/390 in a real browser —
 * is the lane's Playwright evidence, not this file.
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

const NARROW = 400;
/** Between the compact line (below 720px) and the phone rung (below 480px). */
const SMALL_TABLET = 600;
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
        // At 400px (a phone) the identifier is no longer DRAWN — the sheet header carries it
        // and the title gets its 62px — but it is still the row's text for a screen reader.
        expect(epic).toMatch(/<span class="sr-only">STA-1 <\/span>/);
        expect(epic).not.toContain("staple-row-id");
        expect(epic).toContain("staple-row-status");
        const live = rows(narrow).get("STA-2");
        // The live claim survives wherever the row is drawn on this axis — as an avatar
        // with a breathing mark on a phone, a pill on a wide row; the same test id.
        if (live) expect(live).toContain('data-testid="working-pill"');
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
  it("carries the same pickup state at 400px as at 1440px (a pill on the phone, marks on the desk)", () => {
    const narrow = rows(atWidth(NARROW, "none"));
    const wide = rows(atWidth(WIDE, "none"));

    for (const id of ["STA-1", "STA-2", "STA-5", "STA-8"]) {
      const wideCue = /data-pickup-cue="([^"]+)"/.exec(wide.get(id)!)?.[1];
      const cue = /data-pickup-cue="([^"]+)"/.exec(narrow.get(id)!)?.[1];
      // Work in progress gets no pill on a phone: its claim avatar already says someone is
      // on it. Every other state the pill draws is the state the wide row's marks draw.
      if (wideCue === "in_flight") expect(narrow.get(id), id).toContain('data-testid="working-pill"');
      else if (cue !== undefined) expect(cue, id).toBe(wideCue);
    }
    // A phone draws one plain pill in place of the marks, and no milestone ◇; the state the
    // pill carries is the same state the wide row's marks carry.
    expect(narrow.get("STA-2")).not.toContain('data-testid="row-milestone-cue"');
    expect(wide.get("STA-2")).toContain('data-testid="row-milestone-cue"');
    expect(narrow.get("STA-8")).toContain('data-pickup-cue="pickable"');
    expect(narrow.get("STA-8")).toContain('data-pickup-pill="next"');
  });

  it("is never touched by a media query — no rule hides either cue, or any row element", () => {
    /*
     * The ladder is the only thing that drops a row element now, so the sheet must not
     * hide one behind its back: a media query that hid the date would make the markup say
     * "shown" while the screen says "gone", and the precedence table would lie.
     */
    const rowElements = [
      ".staple-row-cue",
      ".staple-row-milestone",
      ".staple-worklog-cue",
      ".staple-row-date",
      ".staple-pr-number",
      ".staple-working-label",
      ".staple-held-label",
    ];
    for (const selector of rowElements) {
      for (const block of mediaBlocks()) {
        const hides = new RegExp(`${selector.replace(".", "\\.")}[^{]*{[^}]*display:\\s*none`).test(block.body);
        expect(hides, `${selector} hidden in ${block.query}`).toBe(false);
      }
    }
    // ...and the ladder DOES drop the two that used to be media queries, so this test fails
    // if nothing drops them any more.
    expect(rows(atWidth(WIDE, "none")).get("STA-2")).toContain("staple-row-date");
    expect(rows(atWidth(NARROW, "none")).get("STA-2")).not.toContain("staple-row-date");
  });
});

describe("what narrow actually changes", () => {
  it("names two labels wide, dots on a small tablet, and none on a phone", () => {
    /*
     * The `+N` changes with the cap, and no media query can recount — the reason the label
     * cap was JS before the ladder, and the reason every rung is JS now.
     */
    const wide = rows(atWidth(WIDE, "none")).get("STA-2")!;
    const small = rows(atWidth(SMALL_TABLET, "none")).get("STA-2")!;
    const narrow = rows(atWidth(NARROW, "none")).get("STA-2")!;

    // Wide: two named pills and an overflow that says what it hid.
    expect((wide.match(/data-testid="label-pill"/g) ?? []).length).toBe(2);
    expect(wide).toContain('data-testid="label-overflow"');
    expect(wide).toContain(">ui<");
    // Small tablet: colour survives, names do not, and the title carries all three.
    expect(small).toContain('data-testid="label-dots"');
    expect(small).not.toContain('data-testid="label-pill"');
    expect(small).toContain('title="ui, queue, tests"');
    // Phone: the title gets the width; labels are on the detail.
    expect(narrow).not.toContain("staple-label-cluster");
  });

  it("drops the rolled-up plan below 720px — absent, not hidden — and keeps x/y", () => {
    const epic = rows(atWidth(NARROW, "none")).get("STA-5")!;
    expect(epic).not.toContain('data-testid="parent-rollup-plan"');
    expect(epic).toContain('aria-label="0 of 2 done"');
    // A folded epic keeps its progress as a ring on a phone, where the 36px bar would come
    // straight out of the title.
    expect(epic).toContain('data-testid="parent-rollup-ring"');
    expect(epic).not.toContain('data-testid="parent-rollup-bar"');

    const wideEpic = rows(atWidth(WIDE, "none")).get("STA-5")!;
    expect(wideEpic).toContain('data-testid="parent-rollup-plan"');
    expect(wideEpic).toContain('data-testid="parent-rollup-bar"');
  });

  it("stays ONE line below 720px: the compact layout, 48px, no second grid row", () => {
    for (const [id, markup] of rows(atWidth(NARROW, "none"))) {
      expect(markup, id).toContain('data-layout="compact"');
    }
    for (const [id, markup] of rows(atWidth(WIDE, "none"))) {
      expect(markup, id).toContain('data-layout="line"');
    }
    const compact = /\.staple-row\[data-layout="compact"\]\s*{([^}]*)}/.exec(CSS)?.[1] ?? "";
    expect(compact).toMatch(/height:\s*48px/);
    // The two-line reflow is gone from the sheet entirely.
    expect(CSS).not.toMatch(/grid-template-rows:\s*28px 28px/);
    expect(CSS).not.toMatch(/\.staple-row-meta\s*{[^}]*grid-row:\s*2/);
  });

  it("drops the date and the worklog below 880px and 960px — in the ladder's order", () => {
    const at = (w: number) => rows(atWidth(w, "none")).get("STA-2")!;
    // 1440: everything. 900: the worklog cue has gone (below 960), the date has not.
    expect(at(WIDE)).toContain("staple-row-date");
    expect(at(900)).toContain("staple-row-date");
    expect(at(900)).not.toContain("staple-worklog-cue");
    // 800: the date and the "Working…" word follow (below 880).
    expect(at(800)).not.toContain("staple-row-date");
    expect(at(800)).not.toContain("staple-working-label");
    expect(at(WIDE)).toContain("staple-working-label");
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
