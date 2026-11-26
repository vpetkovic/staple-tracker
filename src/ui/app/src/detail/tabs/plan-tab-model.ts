/**
 * What the Plan tab reads off an idea's detail to lay it out: its sections in plan order and
 * whether each has content, the breakdown's total when every estimate is a plain duration, and a
 * decision's leading date. Presentation only: completeness, what shaping still needs, states and
 * offered actions stay the server's.
 */
import type { BreakdownRow, IdeaDetailData } from "@/lib/plan-types";

export type PlanSectionId = "brief" | "goal" | "context" | "breakdown" | "acceptance" | "dependencies" | "out-of-scope" | "risks" | "sources" | "decisions";

export interface PlanSectionEntry {
  id: PlanSectionId;
  /** The chip's word. */
  label: string;
  /** The section's heading. */
  heading: string;
  /** Shaping requires it (the plan's starred sections). */
  star: boolean;
  /** It draws content. */
  filled: boolean;
  /** How many items a list section holds; null for prose and for an empty list. */
  count: number | null;
}

const has = (text: string | null): boolean => Boolean(text && text.trim());
const counted = (items: readonly unknown[]): number | null => (items.length > 0 ? items.length : null);

/** Every section of the plan in the order the tab draws them. */
export function planSectionsOf(record: IdeaDetailData): PlanSectionEntry[] {
  const { plan } = record;
  return [
    { id: "brief", label: "Brief", heading: "Brief", star: false, filled: has(record.brief), count: null },
    { id: "goal", label: "Goal", heading: "Goal", star: true, filled: has(plan.goal), count: null },
    { id: "context", label: "Context", heading: "Context and constraints", star: false, filled: has(plan.context), count: null },
    { id: "breakdown", label: "Breakdown", heading: "Task breakdown", star: true, filled: plan.breakdown.length > 0, count: counted(plan.breakdown) },
    { id: "acceptance", label: "Acceptance", heading: "Acceptance criteria", star: true, filled: plan.acceptance.length > 0, count: counted(plan.acceptance) },
    { id: "dependencies", label: "Dependencies", heading: "Dependencies", star: false, filled: plan.dependencies.length > 0, count: counted(plan.dependencies) },
    { id: "out-of-scope", label: "Out of scope", heading: "Out of scope", star: false, filled: has(plan.outOfScope), count: null },
    { id: "risks", label: "Risks", heading: "Risks", star: false, filled: has(plan.risks), count: null },
    { id: "sources", label: "Sources", heading: "Sources and files", star: false, filled: plan.sources.length > 0, count: counted(plan.sources) },
    { id: "decisions", label: "Decisions", heading: "Decisions", star: false, filled: record.decisions.length > 0, count: counted(record.decisions) },
  ];
}

/** Prose longer than this folds to about six lines behind "Show all". */
export const FOLD_AT = 700;

export function foldsLong(text: string | null): boolean {
  return (text ?? "").length > FOLD_AT;
}

/** A plan's working day, as the store reads estimates: `1d` is eight hours of effort. */
const HOURS_PER_DAY = 8;
const PLAIN = /^(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|d|days?)$/i;

/**
 * The breakdown's total, `14h`, only when every row's estimate is a plain number of hours or
 * days; anything else (no estimate, minutes, a range, a typo) leaves the total out.
 */
export function estimateHours(rows: readonly BreakdownRow[]): string | null {
  if (rows.length === 0) return null;
  let hours = 0;
  for (const row of rows) {
    const match = PLAIN.exec((row.estimate ?? "").trim());
    if (!match) return null;
    hours += Number(match[1]) * (match[2]!.toLowerCase().startsWith("d") ? HOURS_PER_DAY : 1);
  }
  return `${Number(hours.toFixed(1))}h`;
}

/** `2026-11-14: Chose X` reads as its day and its words; any other decision has no day. */
export function datedDecision(text: string): { date: string | null; text: string } {
  const match = /^(\d{4}-\d{2}-\d{2}):\s*([\s\S]*)$/.exec(text);
  return match ? { date: match[1]!, text: match[2]! } : { date: null, text };
}

/** `What it needs` with its first letter capital, the rest verbatim. */
export function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
