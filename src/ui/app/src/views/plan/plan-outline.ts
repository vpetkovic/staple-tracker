/**
 * A horizon's tree as the outline draws it: the rows that are visible, in order, once groups
 * are folded or open and a parent's shipped leaves are gathered into one line; and what a key
 * does on a focused row. Pure, so it is pinned without a DOM. It computes no number: the rows
 * and their order are `planTree()`'s.
 */
import type { TreeRow } from "./plan-tree";

/** One visible line of the outline: an idea's row, or a parent's shipped leaves gathered into one. */
export type OutlineEntry =
  | { kind: "row"; key: string; row: TreeRow; depth: number; parent: string | null; open: boolean | null }
  | { kind: "shipped"; key: string; rows: TreeRow[]; depth: number; parent: string };

export interface OutlineState {
  /** Whether a group shows its sub-ideas. */
  isOpen: (id: string) => boolean;
  /** Parents whose shipped leaves the person opened. */
  shipOpen: ReadonlySet<string>;
  /** A focus or filter text is on: nothing is folded away. */
  unfold: boolean;
}

/** The key of the line that gathers a parent's shipped leaves. */
export const shippedKey = (parent: string) => `shipped:${parent}`;

/**
 * The visible lines, in plan order. A group's sub-ideas follow it while it is open. Two or more
 * shipped leaves under one parent are one line, ahead of the rest, until that line is opened;
 * a filter or focus folds nothing, so each shows on its own.
 */
export function outlineEntries(rows: readonly TreeRow[], state: OutlineState): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const walk = (row: TreeRow, depth: number, parent: string | null) => {
    const id = row.idea.id;
    const folds = row.children.length > 0;
    const open = folds ? state.unfold || state.isOpen(id) : null;
    out.push({ kind: "row", key: id, row, depth, parent, open });
    if (!open) return;
    const shipped = row.children.filter((child) => child.idea.state === "shipped" && child.children.length === 0);
    const gather = shipped.length >= 2 && !state.unfold && !state.shipOpen.has(id);
    if (gather) out.push({ kind: "shipped", key: shippedKey(id), rows: shipped, depth: depth + 1, parent: id });
    for (const child of row.children) if (!(gather && shipped.includes(child))) walk(child, depth + 1, id);
  };
  for (const row of rows) walk(row, 0, null);
  return out;
}

/** What a key does on the focused line: move focus to another line, open or fold a group, open the idea. */
export type OutlineMove = { focus: string } | { toggle: string } | { shipOpen: string } | { activate: string } | null;

/**
 * `folds` is false while a focus or filter is on: every group is shown open and nothing can fold,
 * so Left and Right only move focus (to the parent, to the first sub-idea).
 */
export function outlineKey(entries: readonly OutlineEntry[], current: string, key: string, folds = true): OutlineMove {
  const index = entries.findIndex((entry) => entry.key === current);
  if (index === -1) return null;
  const entry = entries[index]!;
  switch (key) {
    case "ArrowDown":
      return index < entries.length - 1 ? { focus: entries[index + 1]!.key } : null;
    case "ArrowUp":
      return index > 0 ? { focus: entries[index - 1]!.key } : null;
    case "Home":
      return { focus: entries[0]!.key };
    case "End":
      return { focus: entries[entries.length - 1]!.key };
    case "ArrowRight":
      if (entry.kind === "shipped") return { shipOpen: entry.parent };
      if (entry.open === false && folds) return { toggle: entry.key };
      // An open group: to its first sub-idea, which is the next line.
      if (entry.open === true && entries[index + 1]) return { focus: entries[index + 1]!.key };
      return null;
    case "ArrowLeft":
      if (entry.kind === "row" && entry.open === true && folds) return { toggle: entry.key };
      return entry.parent === null ? null : { focus: entry.parent };
    case "Enter":
    case " ":
      return entry.kind === "shipped" ? { shipOpen: entry.parent } : { activate: entry.key };
    default:
      return null;
  }
}
