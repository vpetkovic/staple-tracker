/**
 * The mobile list lane — the row ladder, the compact one-line row, its hierarchy, and the
 * long-press that opens the row menu.
 *
 * Two kinds of evidence, as the rest of this folder: the PURE precedence (row-layout.ts,
 * long-press.ts) asserted as data, and the ROW rendered to markup through the real
 * `TaskRowLine` with a plan for each width, so what a phone gets is read off the DOM. The
 * measured half (48px rows, one line within ±4px, no overflow at 360/390 in a browser) is
 * the lane's Playwright evidence.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STALE_CLAIM_SECONDS } from "@/lib/claim";
import type { IssueDeps } from "@/lib/types";
import { flattenFlat } from "@/views/tree/tree-model";
import { TaskRowLine } from "./TaskRowLine";
import { resolveTaskListConfig, type TaskListPreset } from "./config";
import { claim, row } from "./fixtures";
import { IDLE, LONG_PRESS_SLOP, pressStep, swallowsClick, type PressState } from "./long-press";
import { elbowWidth, flatRow, guideX, indentPx, ROW_PAD_LEFT, type TaskRow } from "./model";
import {
  COLLAPSE_LADDER,
  COMPACT_BELOW,
  COMPACT_GEOMETRY,
  dropsAt,
  FULL_ROW_PLAN,
  ladderWidth,
  LINE_GEOMETRY,
  rowPlan,
  samePlan,
  type RowDrop,
} from "./row-layout";
import { mergedDependencySentence } from "./DependencyBadges";
import { rowCueShort } from "./row-cues";

const NOW = new Date("2026-09-01T01:00:00.000Z");

function render(
  line: TaskRow,
  width: number,
  over: { preset?: TaskListPreset; menu?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <TaskRowLine
      row={line}
      config={resolveTaskListConfig(over.preset ?? "tree", { plan: rowPlan(width) })}
      semantics="grid"
      now={NOW}
      onOpen={() => {}}
      actionsMenu={over.menu ? (trigger) => <span data-menu-host="">{trigger}</span> : undefined}
    />,
  );
}

const withDeps = (deps: IssueDeps) => flatRow({ ...row({ identifier: "STA-7", title: "Wire the thing" }), deps });

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the collapse ladder — precedence as data", () => {
  it("has strictly descending rungs, so 'narrower' always means 'at least as much dropped'", () => {
    const widths = COLLAPSE_LADDER.map((rung) => rung.below);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    expect(new Set(widths).size).toBe(widths.length);
    // Monotone: every drop at a width is still dropped at every narrower width.
    for (let w = 1400; w >= 300; w -= 10) {
      for (const drop of dropsAt(w)) expect(dropsAt(w - 10).has(drop), `${drop} at ${w - 10}`).toBe(true);
    }
  });

  it("never lists the elements that must survive every width", () => {
    const all = new Set<string>(COLLAPSE_LADDER.flatMap((rung) => rung.drops));
    for (const kept of ["chevron", "priority", "kind", "identifier", "status", "title", "claim", "assignee", "deps"]) {
      expect(all.has(kept), kept).toBe(false);
    }
  });

  it("drops the date and label names before anything a phone reader needs", () => {
    const order = COLLAPSE_LADDER.flatMap((rung) => rung.drops);
    const rank = (drop: RowDrop) => order.indexOf(drop);
    // Least diagnostic first: the PR number and label names, then the worklog, then the
    // date; the dependency badges only MERGE, and only on the compact line.
    expect(rank("prNumber")).toBeLessThan(rank("worklog"));
    expect(rank("labelNames")).toBeLessThan(rank("date"));
    expect(rank("worklog")).toBeLessThan(rank("date"));
    expect(rank("date")).toBeLessThan(rank("splitDeps"));
    expect(rank("splitDeps")).toBeLessThan(rank("labelDots"));
  });

  /** THE PRECEDENCE TABLE — the four widths the PR prints. */
  it("plans 360, 390, 768 and 1440 exactly as the table says", () => {
    const table = (w: number) => {
      const plan = rowPlan(w);
      return {
        layout: plan.layout,
        labels: plan.labels,
        date: plan.date,
        worklog: plan.worklog,
        pr: plan.prBadge ? (plan.prNumber ? "#n" : "glyph") : "none",
        claim: plan.claim === "avatar" ? "avatar" : plan.workingLabel ? "pill+word" : "pill",
        deps: plan.deps,
        rollup: plan.rollup + (plan.rollupPlan ? "+est" : ""),
        indent: `${plan.geometry.indentStep}px x${plan.geometry.maxIndentDepth}`,
        cue: plan.cueWords ? "words" : "glyph+n",
        stale: plan.staleClaim,
      };
    };
    expect(table(1440)).toEqual({
      layout: "line", labels: "pills", date: true, worklog: true, pr: "#n", claim: "pill+word",
      deps: "split", rollup: "bar+est", indent: "20px x6", cue: "words", stale: "sentence",
    });
    expect(table(768)).toEqual({
      layout: "line", labels: "dots", date: false, worklog: false, pr: "glyph", claim: "pill",
      deps: "split", rollup: "bar+est", indent: "20px x6", cue: "words", stale: "short",
    });
    for (const phone of [390, 360]) {
      expect(table(phone), `${phone}`).toEqual({
        layout: "compact", labels: "none", date: false, worklog: false, pr: "none", claim: "avatar",
        deps: "merged", rollup: "ring", indent: "14px x5", cue: "glyph+n", stale: "short",
      });
    }
    expect(rowPlan(1440).labelMax).toBe(2);
    expect(rowPlan(1100).labelMax).toBe(1);
    expect(rowPlan(768).labelMax).toBe(0);
  });

  it("switches to the compact line exactly at 720px", () => {
    expect(COMPACT_BELOW).toBe(720);
    expect(rowPlan(720).layout).toBe("line");
    expect(rowPlan(719).layout).toBe("compact");
  });

  it("reads the viewport through matchMedia thresholds, landing every rung as the real width would", () => {
    for (const real of [300, 360, 390, 479, 480, 600, 719, 720, 768, 879, 880, 959, 960, 1023, 1024, 1279, 1280, 1440, 2560]) {
      const seen = ladderWidth((min) => real >= min);
      expect(samePlan(rowPlan(seen), rowPlan(real)), `${real}px seen as ${seen}`).toBe(true);
    }
    expect(ladderWidth(null)).toBe(Number.POSITIVE_INFINITY);
    expect(samePlan(FULL_ROW_PLAN, rowPlan(1440))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the compact hierarchy — indentation and guide lines at 390px", () => {
  it("indents 14px a level to five levels, so a deep tree still leaves the title the row", () => {
    expect(indentPx(1, COMPACT_GEOMETRY)).toBe(14);
    expect(indentPx(5, COMPACT_GEOMETRY)).toBe(70);
    expect(indentPx(9, COMPACT_GEOMETRY)).toBe(70);
    expect(indentPx(9, LINE_GEOMETRY)).toBe(120);
  });

  it("hangs each rail left of the child's chevron column, and the elbow lands on it", () => {
    for (const geometry of [LINE_GEOMETRY, COMPACT_GEOMETRY]) {
      for (let level = 0; level < geometry.maxIndentDepth; level += 1) {
        const rail = guideX(level, false, geometry);
        const childColumn = ROW_PAD_LEFT + indentPx(level + 1, geometry);
        // Clear of the child's chevron, with air between them.
        expect(childColumn - rail, `level ${level}`).toBeGreaterThanOrEqual(8);
        // The elbow runs from the rail exactly to the child's column.
        expect(rail + elbowWidth(geometry)).toBe(childColumn);
        // The rail sits under the PARENT's chevron centre.
        expect(rail).toBe(ROW_PAD_LEFT + indentPx(level, geometry) + geometry.disclosure / 2);
      }
    }
  });

  /** The tree the phone renders: an epic, a task under it, a subtask under that. */
  function tree(): TaskRow[] {
    const all = [
      row({ identifier: "STA-1", kind: "epic", title: "The epic" }),
      row({ identifier: "STA-2", parentId: "id-1", title: "A task under it" }),
      row({ identifier: "STA-3", parentId: "id-2", title: "A subtask under that" }),
      row({ identifier: "STA-4", parentId: "id-1", title: "Its sibling" }),
    ];
    return flattenFlat(all, { isExpanded: () => true, showResolved: true, rollupSource: all });
  }

  it("keeps the desktop's levels at 390px — the same aria-levels, indented by the compact step", () => {
    const lines = tree();
    const levels = lines.map((line) => line.depth);
    expect(levels).toEqual([0, 1, 2, 1]);
    lines.forEach((line) => {
      const phone = render(line, 390);
      const desk = render(line, 1440);
      expect(/aria-level="(\d)"/.exec(phone)![1]).toBe(/aria-level="(\d)"/.exec(desk)![1]);
      expect(phone).toContain(`padding-left:${ROW_PAD_LEFT + 14 * line.depth}px`);
      expect(desk).toContain(`padding-left:${ROW_PAD_LEFT + 20 * line.depth}px`);
      expect(phone).toContain("--col-disclosure-w:12px");
      expect(phone).toContain("--guide-elbow-w:8px");
    });
  });

  it("draws the rails from the compact geometry, not the desktop's", () => {
    const subtask = tree()[2]!;
    const markup = render(subtask, 390);
    // Level-0 rail continues (a sibling follows at level 1) and the elbow hangs at level 1.
    expect(markup).toContain(`class="staple-guide-rail" style="left:${guideX(0, false, COMPACT_GEOMETRY)}px"`);
    expect(markup).toContain(`class="staple-guide-elbow" style="left:${guideX(1, false, COMPACT_GEOMETRY)}px"`);
    expect(markup).not.toContain(`class="staple-guide-elbow" style="left:${guideX(1, false, LINE_GEOMETRY)}px"`);
  });

  it("keeps the expand control on a parent at 390px, with the same accessible name", () => {
    const epic = tree()[0]!;
    const markup = render(epic, 390);
    expect(markup).toMatch(/<button type="button" class="staple-row-chevron" data-expanded="false" aria-label="Expand STA-1"/);
  });

  it("says 'Subtask' to a screen reader on a phone even though the glyph is gone", () => {
    const task = tree()[1]!;
    expect(render(task, 1440)).toContain('data-testid="subtask-glyph"');
    const phone = render(task, 390);
    expect(phone).not.toContain('data-testid="subtask-glyph"');
    expect(phone).toContain('<span class="sr-only">Subtask</span>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the compact row's cues — one line, the title first", () => {
  it("merges blocked-by and blocks into ONE cue with both counts, inside the meta cluster", () => {
    const line = withDeps({ blockedBy: ["STA-61"], blocks: ["STA-62", "STA-63", "STA-64"] });
    const phone = render(line, 390);
    const desk = render(line, 1440);

    expect((phone.match(/data-testid="dep-cue"/g) ?? []).length).toBe(1);
    expect(phone).not.toContain('data-testid="dep-badge-blocked-by"');
    expect(phone).not.toContain('data-testid="dep-badge-blocks"');
    expect(phone).toContain('aria-label="Blocked by 1 task, blocks 3 tasks"');
    expect(phone).toContain('title="Blocked by STA-61 · Blocks STA-62, STA-63, STA-64"');
    // One button, two counts, each behind its own glyph.
    const cue = /<button[^>]*data-testid="dep-cue"[^>]*>([\s\S]*?)<\/button>/.exec(phone)![1]!;
    expect(cue).toMatch(/data-kind="blocked-by"[\s\S]*>1<[\s\S]*data-kind="blocks"[\s\S]*>3</);
    // ...and it lives in the meta cluster on the row's own line (no second grid row).
    expect(phone.indexOf('data-testid="dep-cue"')).toBeGreaterThan(phone.indexOf("staple-row-meta"));

    expect(desk).toContain('data-testid="dep-badge-blocked-by"');
    expect(desk).toContain('data-testid="dep-badge-blocks"');
    expect(desk).not.toContain('data-testid="dep-cue"');
  });

  it("names a one-sided cue in the same sentence shape", () => {
    expect(mergedDependencySentence(2, 0)).toBe("Blocked by 2 tasks");
    expect(mergedDependencySentence(0, 1)).toBe("Blocks 1 task");
    expect(render(withDeps({ blockedBy: [], blocks: ["STA-9"] }), 360)).toContain('aria-label="Blocks 1 task"');
  });

  it("shows a live claim as an avatar with a breathing mark, the word only on wide rows", () => {
    const line = flatRow({ ...row({ identifier: "STA-8", checkoutAgent: "opus-x" }), claim: claim() });
    const phone = render(line, 390);
    expect(phone).toContain('class="staple-claim-avatar" data-state="working" data-testid="working-pill"');
    expect(phone).toContain("staple-claim-mark staple-working-dot");
    expect(phone).not.toContain("Working…");
    expect(render(line, 1440)).toContain("Working…");
    expect(render(line, 800)).not.toContain("Working…");
  });

  it("keeps a stale claim's diagnosis on a phone: who and how long silent", () => {
    const stale = claim({ heldBy: "opus-gone", idleSeconds: STALE_CLAIM_SECONDS + 600, heldSeconds: 7200 });
    const phone = render(flatRow({ ...row({ identifier: "STA-9" }), claim: stale }), 390);
    expect(phone).toContain('data-testid="stale-claim-cue"');
    expect(phone).toMatch(/aria-label="stale claim — held by opus-gone · 2h · silent 40m/);
    expect(phone).toMatch(/>OG · 40m</);
    // Beside a tablet's navigation rail the sentence would take the whole title, so below
    // 1024px it is the short form in the pill slot too; wide rows keep the sentence.
    const tablet = render(flatRow({ ...row({ identifier: "STA-9" }), claim: stale }), 768);
    expect(tablet).toContain('data-testid="stale-claim-cue"');
    expect(tablet).not.toContain(">held by opus-gone");
    const wide = render(flatRow({ ...row({ identifier: "STA-9" }), claim: stale }), 1440);
    expect(wide).toContain(">held by opus-gone · 2h · silent 40m<");
    expect(wide).not.toContain('data-testid="stale-claim-cue"');
  });

  it("draws one avatar, not two, when the holder is also the assignee", () => {
    const line = flatRow({ ...row({ identifier: "STA-10", assignee: "opus-x", checkoutAgent: "opus-x" }), claim: claim() });
    expect((render(line, 390).match(/class="staple-avatar/g) ?? []).length).toBe(1);
    expect(render(line, 1440)).toContain("staple-row-assignee");
    const other = flatRow({ ...row({ identifier: "STA-11", assignee: "vp", checkoutAgent: "opus-x" }), claim: claim() });
    expect(render(other, 390)).toContain("staple-row-assignee");
  });

  it("drops the date and every label below 480px, and the PR badge with them", () => {
    const line = flatRow({
      ...row({ identifier: "STA-12", labels: ["ui", "queue"] }),
      pullRequests: [{ number: 42, state: "open", url: "https://example.test/pr/42", title: "pr" }],
    } as never);
    const phone = render(line, 390);
    expect(phone).not.toContain("staple-row-date");
    expect(phone).not.toContain("staple-label-cluster");
    expect(phone).not.toContain('data-testid="pr-badge"');
    const tablet = render(line, 600);
    expect(tablet).toContain('data-testid="label-dots"');
    expect(tablet).toContain('data-testid="pr-badge"');
    expect(tablet).not.toContain("staple-pr-number");
    expect(render(line, 1440)).toContain('<span class="staple-pr-number">#42</span>');
  });

  it("keeps the pickup cue's glyph and number on a phone and drops only its words", () => {
    const queued = { state: "queued" as const, position: 2, scope: "plan" as const, reason: null };
    const next = { state: "pickable" as const, position: 1, scope: "effective" as const, reason: null };
    expect(rowCueShort(queued)).toBe("plan #2");
    expect(rowCueShort(queued, true)).toBe("2");
    expect(rowCueShort(next)).toBe("next");
    expect(rowCueShort(next, true)).toBe("");
    const line = flatRow({ ...row({ identifier: "STA-15" }), cues: { pickup: queued, milestone: null } });
    const phone = render(line, 390);
    const desk = render(line, 1440);
    expect(phone).toContain('<span aria-hidden="true">#</span><span aria-hidden="true">2</span>');
    expect(desk).toContain('<span aria-hidden="true">plan #2</span>');
    // The sentence — what the cue MEANS — is identical at both widths.
    const sentence = (m: string) => /<span class="sr-only">(Queued[^<]*)<\/span>/.exec(m)?.[1];
    expect(sentence(phone)).toBe(sentence(desk));
    expect(sentence(phone)).toContain("Plan position 2.");
  });

  it("marks the row compact below 720px and the full row everywhere without a plan", () => {
    const line = flatRow(row({ identifier: "STA-13" }));
    expect(render(line, 390)).toContain('data-layout="compact"');
    expect(render(line, 720)).toContain('data-layout="line"');
    const noPlan = renderToStaticMarkup(
      <TaskRowLine row={line} config={resolveTaskListConfig("tree")} semantics="grid" now={NOW} />,
    );
    expect(noPlan).toContain('data-layout="line"');
    expect(noPlan).toContain("staple-row-date");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the row menu on touch — a visible `⋯` and a long-press", () => {
  it("keeps the `⋯` on a phone row that has a menu, and drops a `⋯` that would only repeat the tap", () => {
    const line = flatRow(row({ identifier: "STA-14" }));
    expect(render(line, 390, { menu: true })).toContain('aria-label="Actions for STA-14"');
    expect(render(line, 390)).not.toContain("staple-row-actions");
    // Desktop keeps the open-details `⋯` it always had.
    expect(render(line, 1440)).toContain('aria-label="Open details for STA-14"');
  });

  it("draws the `⋯` without hover on a device that cannot hover", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./task-list.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const block = /@media \(hover: none\)\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/\.staple-row-actions\s*{\s*opacity:\s*1/);
  });

  const down = (pointerType = "touch") => ({ type: "down" as const, pointerType, x: 100, y: 100 });

  it("fires after a still hold on touch, and swallows the click that ends it", () => {
    let state: PressState = pressStep(IDLE, down());
    expect(state.kind).toBe("pressing");
    state = pressStep(state, { type: "move", x: 103, y: 102 });
    expect(state.kind).toBe("pressing");
    state = pressStep(state, { type: "timer" });
    expect(state.kind).toBe("fired");
    state = pressStep(state, { type: "up" });
    expect(swallowsClick(state)).toBe(true);
    expect(pressStep(state, { type: "click" })).toEqual(IDLE);
  });

  it("is a scroll, not a hold, once the finger travels past the slop", () => {
    const moved = pressStep(pressStep(IDLE, down()), { type: "move", x: 100, y: 100 + LONG_PRESS_SLOP + 1 });
    expect(moved).toEqual(IDLE);
    expect(pressStep(moved, { type: "timer" })).toEqual(IDLE);
  });

  it("never long-presses with a mouse, and a quick tap stays a tap", () => {
    expect(pressStep(IDLE, down("mouse"))).toEqual(IDLE);
    const tap = pressStep(pressStep(IDLE, down()), { type: "up" });
    expect(tap).toEqual(IDLE);
    expect(swallowsClick(tap)).toBe(false);
  });
});
