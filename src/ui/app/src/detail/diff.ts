/**
 * Revision diffing — pure functions, no React, no fetch.
 *
 * One walk of `diffLines()` produces both projections the viewer offers:
 *
 *   unified()  one column, `-`/`+` gutter, both line numbers  (the default)
 *   split()    two columns, deletions left, insertions right  (the toggle)
 *
 * Unified is the default because the detail panel is a side aside — two 40-column
 * gutters in that width render as noise. Split stays available because a panel dragged
 * wide on a big monitor really is better read side by side, and it costs one extra
 * pass over the same parts array.
 *
 * `collapse()` folds long unchanged runs. A plan document is mostly unchanged between
 * revisions; without this, the diff of a 200-line plan is 195 lines of noise wrapped
 * around 5 lines of signal.
 *
 * Kept in detail/ rather than lib/ on purpose: nothing outside the document viewer
 * diffs anything, and lib/ is the shared surface three agents import from.
 */
import { diffLines } from "diff";

export type RowKind = "same" | "add" | "remove";

/** One line in the unified projection. Exactly one of the two numbers is null on a change. */
export interface UnifiedRow {
  kind: RowKind;
  /** Line number in the OLD body, or null for an insertion. */
  oldNo: number | null;
  /** Line number in the NEW body, or null for a deletion. */
  newNo: number | null;
  text: string;
}

export interface SplitCell {
  no: number;
  text: string;
}

/**
 * One row in the split projection. A paired edit has both sides and `changed: true`;
 * a pure deletion has `right: null`; a pure insertion has `left: null`.
 */
export interface SplitRow {
  left: SplitCell | null;
  right: SplitCell | null;
  changed: boolean;
}

/** A folded run of unchanged lines, in either projection. */
export interface SkipRow {
  kind: "skip";
  count: number;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export interface DocumentDiff {
  unified: UnifiedRow[];
  split: SplitRow[];
  stats: DiffStats;
  /** True when the two bodies are byte-identical — the viewer says so rather than drawing nothing. */
  identical: boolean;
}

/**
 * Split a chunk's value into lines without inventing a trailing blank.
 *
 * `diffLines` keeps the newline on the end of each chunk, so "a\nb\n".split("\n")
 * yields a spurious "" that would render as an empty line at every chunk boundary.
 */
function linesOf(value: string): string[] {
  if (value === "") return [];
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Diff two document bodies.
 *
 * Both projections are built from the same parts array so they can never disagree
 * about what changed — only about how it is laid out.
 */
export function diffBodies(before: string, after: string): DocumentDiff {
  const parts = diffLines(before ?? "", after ?? "");

  const unified: UnifiedRow[] = [];
  const split: SplitRow[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = 0;
  let newNo = 0;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const lines = linesOf(part.value);

    if (!part.added && !part.removed) {
      for (const text of lines) {
        oldNo += 1;
        newNo += 1;
        unified.push({ kind: "same", oldNo, newNo, text });
        split.push({ left: { no: oldNo, text }, right: { no: newNo, text }, changed: false });
      }
      continue;
    }

    if (part.removed) {
      // A removal immediately followed by an addition is an *edit*: pair the lines up
      // so the split view puts the before and after of the same line on one row.
      const next = parts[i + 1];
      const insertions = next?.added ? linesOf(next.value) : [];
      if (next?.added) i += 1;

      for (const text of lines) {
        oldNo += 1;
        removed += 1;
        unified.push({ kind: "remove", oldNo, newNo: null, text });
      }
      for (const text of insertions) {
        newNo += 1;
        added += 1;
        unified.push({ kind: "add", oldNo: null, newNo, text });
      }

      // Split rows walk the two runs in lockstep, padding whichever ran out first.
      const height = Math.max(lines.length, insertions.length);
      let leftNo = oldNo - lines.length;
      let rightNo = newNo - insertions.length;
      for (let r = 0; r < height; r += 1) {
        const left = lines[r];
        const right = insertions[r];
        split.push({
          left: left === undefined ? null : { no: (leftNo += 1), text: left },
          right: right === undefined ? null : { no: (rightNo += 1), text: right },
          changed: true,
        });
      }
      continue;
    }

    // A lone insertion (no removal before it).
    for (const text of lines) {
      newNo += 1;
      added += 1;
      unified.push({ kind: "add", oldNo: null, newNo, text });
      split.push({ left: null, right: { no: newNo, text }, changed: true });
    }
  }

  return { unified, split, stats: { added, removed }, identical: added === 0 && removed === 0 };
}

function isUnchanged(row: UnifiedRow | SplitRow): boolean {
  return "kind" in row ? row.kind === "same" : !row.changed;
}

/**
 * Fold runs of unchanged rows longer than `2 * context` into a single skip marker,
 * keeping `context` lines on each side of every change.
 *
 * Works on either projection because both are arrays whose "unchanged" test is the
 * only thing that differs, and `isUnchanged` absorbs that.
 */
export function collapse<T extends UnifiedRow | SplitRow>(rows: T[], context = 3): Array<T | SkipRow> {
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i += 1) {
    if (isUnchanged(rows[i]!)) continue;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j += 1) {
      keep[j] = true;
    }
  }

  const out: Array<T | SkipRow> = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({ kind: "skip", count: skipped });
        skipped = 0;
      }
      out.push(rows[i]!);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) out.push({ kind: "skip", count: skipped });
  return out;
}

export function isSkip(row: unknown): row is SkipRow {
  return typeof row === "object" && row !== null && (row as SkipRow).kind === "skip";
}
