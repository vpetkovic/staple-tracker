/**
 * What the task row keeps, and what it gives up first, at every width.
 *
 * ── ONE LADDER, ONE SOURCE ─────────────────────────────────────────────────────────────
 *
 * The row used to degrade through five viewport media queries in task-list.css plus a
 * label cap measured separately in TreeGrid. Each rung was right, but nothing said which
 * element goes before which: the order lived in a comment and the evidence was a
 * stylesheet read back by a test. Below 720px the row then became two lines, which is the
 * layout a phone gets most and the one that read worst (56px rows, badges wrapped under
 * the identifier, guide lines broken by the wrapped boxes).
 *
 * This module is the order. `COLLAPSE_LADDER` is a list of rungs, each a width below which
 * some elements drop, and `rowPlan(width)` is the fold of every rung at or above that
 * width. The row renders from the plan, so an element that has dropped is absent from the
 * DOM rather than hidden by a rule, and the precedence table in the PR is `rowPlan` printed
 * at four widths.
 *
 * ── WHAT NEVER DROPS ───────────────────────────────────────────────────────────────────
 *
 * Chevron, priority, status and title, left to right, on one line at any width; the kind
 * glyph of anything that is not a plain task; the identifier everywhere but a phone held
 * upright, where the detail sheet's header carries it. Right of the title: the blocker/warning cue (merged into one chip when narrow), the
 * claim (an avatar when narrow), the assignee, and a parent's `x/y` count. The title gets
 * every pixel the ladder frees.
 */

/** Elements the ladder can take away, in no particular order (the ladder gives the order). */
export type RowDrop =
  /** The second named label pill (two pills become one). */
  | "secondLabel"
  /** `#123` beside the PR glyph. */
  | "prNumber"
  /** Label names: pills become colour dots. */
  | "labelNames"
  /** The worklog freshness cue. */
  | "worklog"
  /** The updated date. */
  | "date"
  /** "Working…" beside the live claim's dot. */
  | "workingLabel"
  /** The parent's rolled-up estimate (`est 3h`). */
  | "rollupPlan"
  /** The ring-and-elbow glyph before a child's identifier; the indent already says it. */
  | "subtaskGlyph"
  /** The pickup cue's words ("plan #2", "next"): the glyph and the number stay. */
  | "cueWords"
  /** Separate blocked-by and blocks badges: they merge into one cue. */
  | "splitDeps"
  /** The PR badge itself. */
  | "prBadge"
  /**
   * A stale claim's full sentence (`held by opus-x · 2h · silent 46m`): it becomes the
   * holder's initials and the silence (`OX · 46m`), the part that IS the diagnosis. The
   * sentence stays the accessible name and the tooltip.
   */
  | "staleSentence"
  /** The label colour dots. */
  | "labelDots"
  /** The parent's 36px progress bar: it becomes a 12px ring beside the count. */
  | "rollupBar"
  /**
   * The identifier column. On a phone the detail sheet's header carries it, and 62px of
   * `STA-123` on every row is 62px of title; the identifier stays the row's screen-reader text.
   */
  | "identifier"
  /** The kind glyph of a plain task. An epic's or a bug's glyph stays: that one says something. */
  | "plainKindGlyph"
  /**
   * The pickup marks (`·` `▸` `⋯` `#2`): one plain pill takes their place, "Next" for the
   * task an agent would pick up now and "Queued" for a task in the plan. Every other state
   * says nothing on the row; the full sentence stays the pill's accessible text.
   */
  | "cueMarks"
  /** The milestone `◇`. The milestone is one tap away on the detail sheet. */
  | "milestoneMark";

export interface RowRung {
  /** The rung applies when the viewport is narrower than this, in CSS px. */
  below: number;
  drops: readonly RowDrop[];
}

/**
 * THE PRECEDENCE, least diagnostic first.
 *
 * The first four rungs are §14's existing ladder, unchanged in width and order, so every
 * desktop and tablet width renders what it rendered before. The last two are the phone:
 * below 720px the row stays ONE line (the two-line reflow is gone) and pays for it by
 * merging and shrinking rather than wrapping; below 480px — a phone held upright — the purely
 * decorative markers go, and so do the identifier column and a plain task's kind glyph (the
 * sheet header carries both), with the pickup marks replaced by one plain pill.
 */
export const COLLAPSE_LADDER: readonly RowRung[] = [
  { below: 1280, drops: ["secondLabel"] },
  { below: 1024, drops: ["prNumber", "labelNames", "staleSentence"] },
  { below: 960, drops: ["worklog"] },
  { below: 880, drops: ["date", "workingLabel"] },
  { below: 720, drops: ["rollupPlan", "subtaskGlyph", "cueWords", "splitDeps"] },
  { below: 480, drops: ["prBadge", "labelDots", "rollupBar", "identifier", "plainKindGlyph", "cueMarks", "milestoneMark"] },
];

/** Below this the row switches to the compact one-line geometry (48px, tighter indent). */
export const COMPACT_BELOW = 720;

/**
 * Where the tree hangs its children. Mirrored by nothing: the row sets these as inline
 * custom properties, and the rails are positioned from the same numbers, so the CSS cannot
 * disagree with the arithmetic.
 */
export interface RowGeometry {
  /** Indent per level. */
  indentStep: number;
  /** Past this depth the indent stops growing. */
  maxIndentDepth: number;
  /** Width of the disclosure (chevron) column. */
  disclosure: number;
}

/** Desktop: 20px per level to six levels, a 16px chevron column (row spec §11.1). */
export const LINE_GEOMETRY: RowGeometry = { indentStep: 20, maxIndentDepth: 6, disclosure: 16 };

/**
 * Phone: 14px per level to five levels, a 12px chevron column.
 *
 * The step has to clear half the chevron column plus a hairline of air, or the parent's
 * rail runs through the child's chevron: 14 − 12/2 leaves 8px between the rail and the
 * child's column, and the elbow is exactly that 8px. Five levels cost at most 70px, so a
 * deep tree still leaves the title more than half of a 360px row.
 */
export const COMPACT_GEOMETRY: RowGeometry = { indentStep: 14, maxIndentDepth: 5, disclosure: 12 };

export type RowLayout = "line" | "compact";

export interface RowPlan {
  layout: RowLayout;
  geometry: RowGeometry;
  /** Named label pills allowed (2, 1, or 0 for dots/none). */
  labelMax: number;
  labels: "pills" | "dots" | "none";
  prBadge: boolean;
  prNumber: boolean;
  worklog: boolean;
  date: boolean;
  workingLabel: boolean;
  rollupPlan: boolean;
  subtaskGlyph: boolean;
  deps: "split" | "merged";
  rollup: "bar" | "ring";
  /**
   * The claim as a pill (avatar, dot, and on wide rows a word or the stale sentence) or as
   * an avatar with a status mark. Compact rows use the avatar: the stale sentence alone is
   * ~150px, which on a phone is the whole title.
   */
  claim: "pill" | "avatar";
  /** The pickup cue with its words, or glyph and number only. */
  cueWords: boolean;
  /** A stale claim as its whole sentence, or as initials and silence. */
  staleClaim: "sentence" | "short";
  /** The identifier column is drawn (it is always in the accessible text). */
  identifier: boolean;
  /** A plain task's kind glyph is drawn. Other kinds always keep theirs. */
  plainKindGlyph: boolean;
  /** The pickup cue as its marks, or as one plain "Next"/"Queued" pill. */
  cues: "marks" | "pill";
  /** The milestone marker is drawn. */
  milestoneMark: boolean;
}

/** Every drop that applies at `width`. */
export function dropsAt(width: number): Set<RowDrop> {
  const out = new Set<RowDrop>();
  for (const rung of COLLAPSE_LADDER) {
    if (width < rung.below) for (const drop of rung.drops) out.add(drop);
  }
  return out;
}

export function rowPlan(width: number): RowPlan {
  const drops = dropsAt(width);
  const has = (drop: RowDrop) => !drops.has(drop);
  const compact = width < COMPACT_BELOW;
  const labelMax = !has("labelNames") ? 0 : !has("secondLabel") ? 1 : 2;
  return {
    layout: compact ? "compact" : "line",
    geometry: compact ? COMPACT_GEOMETRY : LINE_GEOMETRY,
    labelMax,
    labels: labelMax > 0 ? "pills" : has("labelDots") ? "dots" : "none",
    prBadge: has("prBadge"),
    prNumber: has("prNumber"),
    worklog: has("worklog"),
    date: has("date"),
    workingLabel: has("workingLabel"),
    rollupPlan: has("rollupPlan"),
    subtaskGlyph: has("subtaskGlyph"),
    deps: has("splitDeps") ? "split" : "merged",
    rollup: has("rollupBar") ? "bar" : "ring",
    claim: compact ? "avatar" : "pill",
    cueWords: has("cueWords"),
    staleClaim: has("staleSentence") ? "sentence" : "short",
    identifier: has("identifier"),
    plainKindGlyph: has("plainKindGlyph"),
    cues: has("cueMarks") ? "marks" : "pill",
    milestoneMark: has("milestoneMark"),
  };
}

/** The full row, for every surface that is not width-aware (the palette, a fixture). */
export const FULL_ROW_PLAN: RowPlan = rowPlan(Number.POSITIVE_INFINITY);

/** Two plans say the same thing. Lets a resize that crosses no rung keep the same object. */
export function samePlan(a: RowPlan, b: RowPlan): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The viewport width as the ladder sees it, asked through `matchMedia` one threshold at a
 * time — the question TreeGrid's label cap always asked, so a test can stub the browser's
 * answer rather than the hook. Returns the widest threshold the viewport reaches, which
 * lands every rung exactly as the real width would; `Infinity` when there is no browser.
 */
export function ladderWidth(matches: ((minWidth: number) => boolean) | null): number {
  if (!matches) return Number.POSITIVE_INFINITY;
  const thresholds = [...new Set(COLLAPSE_LADDER.map((rung) => rung.below))].sort((a, b) => b - a);
  for (const threshold of thresholds) {
    if (matches(threshold)) return threshold;
  }
  return 0;
}
