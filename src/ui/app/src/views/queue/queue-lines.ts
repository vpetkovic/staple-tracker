/**
 * Which rows a queue section draws, given what is folded and paged: the plan entries, each with
 * its note and (open) expansion, then the band after the plan. The keys are the page's one
 * roving list. Pure; `queue-lines.test.ts` pins it.
 */
import type { EffectiveQueueRow, IssueKind, IssueRow, QueueView } from "@/lib/types";
import type { PlanRow } from "./queue-model";
import { BAND_PAGE, coveredBy, EXPANSION_PAGE, expansionLines, paged } from "./queue-words";

/** A row's key in the page's roving list: its workspace, where it sits, and its reference. */
export type RowPlace = "entry" | "nested" | "band";

export function rowKey(workspace: string, place: RowPlace, identifier: string): string {
  return `${workspace}\u0000${place}\u0000${identifier}`;
}

/** What the reader folded, opened and paged in one section. View state; never written anywhere. */
export interface SectionFolds {
  /** Containers start open on a workspace page and folded on All workspaces. */
  containersOpen: boolean;
  /** Containers the reader flipped away from that default. */
  flipped: ReadonlySet<string>;
  /** Containers showing every row instead of the first page. */
  whole: ReadonlySet<string>;
  /** The band after the plan: null means its default (open only with no plan, on a workspace page). */
  bandOpen: boolean | null;
  bandWhole: boolean;
}

export const NO_FOLDS: SectionFolds = { containersOpen: true, flipped: new Set(), whole: new Set(), bandOpen: null, bandWhole: false };

export function isContainerOpen(folds: SectionFolds, identifier: string): boolean {
  return folds.containersOpen !== folds.flipped.has(identifier);
}

export interface TaskLine {
  kind: "task";
  key: string;
  row: EffectiveQueueRow;
  /** The next pick's own row. */
  isNext: boolean;
}

export interface CaptionLine {
  kind: "caption";
  key: string;
  identifier: string;
  title: string;
  issueKind: IssueKind;
}

export interface MoreLine {
  /** Every row there is, the page size, and whether every row is shown. */
  total: number;
  page: number;
  whole: boolean;
}

export interface EntryBlock {
  key: string;
  /** 0-based plan index: what `move(from, to)` takes. */
  index: number;
  plan: PlanRow;
  /** It expands to tasks: a fold arrow, a roll-up, rows under it. */
  container: boolean;
  open: boolean;
  /** Its work came out of an earlier entry. */
  covered: { position: number; via: string; identifier: string } | null;
  /** The next pick is this entry's own row. */
  isNext: boolean;
  /** The next pick is inside this container while it is folded. */
  holdsNext: boolean;
  children: Array<TaskLine | CaptionLine>;
  more: MoreLine | null;
}

export interface BandBlock {
  open: boolean;
  total: number;
  rows: TaskLine[];
  more: MoreLine | null;
}

export interface SectionLayout {
  entries: EntryBlock[];
  band: BandBlock | null;
  /** Every focusable row, in page order. */
  keys: string[];
}

export interface SectionInput {
  workspace: string;
  view: Pick<QueueView, "effective" | "entries">;
  rows: readonly PlanRow[];
  unqueued: readonly EffectiveQueueRow[];
  next: EffectiveQueueRow | null;
  known: ReadonlyMap<string, IssueRow>;
}

export function sectionLayout(input: SectionInput, folds: SectionFolds, workspace = input.workspace): SectionLayout {
  const nextId = input.next?.issueId ?? null;
  const keys: string[] = [];
  const entries = input.rows.map((plan, index): EntryBlock => {
    const identifier = plan.entry.identifier;
    const container = plan.expansion.length > 0;
    const open = container && isContainerOpen(folds, identifier);
    const covered = container || plan.effective ? null : coveredBy(plan.entry, input.view);
    const key = rowKey(workspace, "entry", identifier);
    keys.push(key);
    const children: Array<TaskLine | CaptionLine> = [];
    let more: MoreLine | null = null;
    if (open) {
      const whole = folds.whole.has(identifier);
      const shown = paged(plan.expansion, EXPANSION_PAGE, whole);
      for (const line of expansionLines(shown, identifier, input.known)) {
        if (line.kind === "caption") {
          children.push({ kind: "caption", key: `${key}\u0000${line.identifier}\u0000${children.length}`, identifier: line.identifier, title: line.title, issueKind: line.issueKind });
        } else {
          const taskKey = rowKey(workspace, "nested", line.row.identifier);
          keys.push(taskKey);
          children.push({ kind: "task", key: taskKey, row: line.row, isNext: line.row.issueId === nextId });
        }
      }
      if (plan.expansion.length > EXPANSION_PAGE) more = { total: plan.expansion.length, page: EXPANSION_PAGE, whole };
    }
    return {
      key,
      index,
      plan,
      container,
      open,
      covered,
      isNext: !container && plan.effective !== null && plan.effective.issueId === nextId,
      holdsNext: container && !open && plan.expansion.some((row) => row.issueId === nextId),
      children,
      more,
    };
  });

  let band: BandBlock | null = null;
  if (input.unqueued.length > 0) {
    const open = folds.bandOpen ?? (input.rows.length === 0 && folds.containersOpen);
    const rows: TaskLine[] = [];
    if (open) {
      for (const row of paged(input.unqueued, BAND_PAGE, folds.bandWhole)) {
        const key = rowKey(workspace, "band", row.identifier);
        keys.push(key);
        rows.push({ kind: "task", key, row, isNext: row.issueId === nextId });
      }
    }
    band = {
      open,
      total: input.unqueued.length,
      rows,
      more: open && input.unqueued.length > BAND_PAGE ? { total: input.unqueued.length, page: BAND_PAGE, whole: folds.bandWhole } : null,
    };
  }
  return { entries, band, keys };
}

/**
 * What has to open for a task to be on the page: its container and that container's paging,
 * or the band and its paging. Null when the task is not in this section's order at all.
 */
export type Reveal =
  | { place: "entry"; identifier: string }
  | { place: "nested"; entry: string; identifier: string; whole: boolean }
  | { place: "band"; identifier: string; whole: boolean };

export function revealOf(input: Pick<SectionInput, "rows" | "unqueued">, identifier: string): Reveal | null {
  // An entry that is its own row first; a duplicate entry's row lives under the earlier entry.
  for (const plan of input.rows) {
    if (plan.effective?.identifier === identifier) return { place: "entry", identifier };
  }
  for (const plan of input.rows) {
    const at = plan.expansion.findIndex((row) => row.identifier === identifier);
    if (at >= 0) return { place: "nested", entry: plan.entry.identifier, identifier, whole: at >= EXPANSION_PAGE };
  }
  for (const plan of input.rows) {
    if (plan.entry.identifier === identifier) return { place: "entry", identifier };
  }
  const at = input.unqueued.findIndex((row) => row.identifier === identifier);
  if (at >= 0) return { place: "band", identifier, whole: at >= BAND_PAGE };
  return null;
}

/** The folds with a reveal applied: the container opened and paged, or the band. */
export function withReveal(folds: SectionFolds, reveal: Reveal): SectionFolds {
  if (reveal.place === "entry") return folds;
  if (reveal.place === "band") return { ...folds, bandOpen: true, bandWhole: folds.bandWhole || reveal.whole };
  const flipped = new Set(folds.flipped);
  if (folds.containersOpen) flipped.delete(reveal.entry);
  else flipped.add(reveal.entry);
  const whole = new Set(folds.whole);
  if (reveal.whole) whole.add(reveal.entry);
  return { ...folds, flipped, whole };
}

export function revealKey(workspace: string, reveal: Reveal): string {
  return rowKey(workspace, reveal.place, reveal.identifier);
}
