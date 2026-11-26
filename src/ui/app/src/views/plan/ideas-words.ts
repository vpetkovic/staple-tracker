/**
 * The Ideas lens's words, from the payload as it is: how long ago a raw idea was captured, what
 * its `shape` action says is still missing, and how its sections meter reads. Pure, so
 * `ideas-lens.test.tsx` pins them without rendering.
 */
import type { IdeaData } from "@/lib/plan-types";
import { planActionItems, type PlanItem } from "@/detail/plain-actions";
import { dayIndex } from "./plan-model";

/** `today`, `8d ago` up to 13 days, then whole weeks: a date difference between its capture and the plan's day. */
export function capturedAge(createdAt: string, today: string): string {
  const days = Math.max(0, dayIndex(today) - dayIndex(createdAt.slice(0, 10)));
  if (days === 0) return "today";
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * Where an exploring idea stands on shaping, read from its `shape` action: ready when the action
 * runs now (with the call that runs it), else what its reason says is missing, the server's
 * "It needs … before it is shaped." wrapper taken off when both ends are there. Null when the
 * state does not offer shaping at all.
 */
export type Shaping = { ready: true; item: PlanItem } | { ready: false; need: string };

const NEEDS = "It needs ";
const BEFORE = " before it is shaped.";

export function shaping(idea: IdeaData): Shaping | null {
  const item = planActionItems("", idea).find((candidate) => candidate.id === "shape");
  if (!item) return null;
  const reason = item.disabledReason;
  if (!reason) return { ready: true, item };
  const wrapped = reason.startsWith(NEEDS) && reason.endsWith(BEFORE) && reason.length > NEEDS.length + BEFORE.length;
  return { ready: false, need: wrapped ? reason.slice(NEEDS.length, -BEFORE.length) : reason };
}

/** The one-click Explore a raw idea's state offers, or null. */
export function exploreItem(idea: IdeaData): PlanItem | null {
  return planActionItems("", idea).find((candidate) => candidate.id === "explore") ?? null;
}

export type SectionMark = "required-filled" | "required" | "filled" | "empty";

/**
 * The sections meter: one mark per section, the required ones first and filled up to the
 * server's `starred`, the rest filled up to `filled - starred`. The server's counts, drawn.
 */
export function sectionMarks({ starred, starredTotal, filled, total }: IdeaData["completeness"]): SectionMark[] {
  return Array.from({ length: total }, (_, index) =>
    index < starredTotal ? (index < starred ? "required-filled" : "required") : index - starredTotal < filled - starred ? "filled" : "empty",
  );
}

export function sectionsTitle({ starred, starredTotal, filled, total }: IdeaData["completeness"]): string {
  return `${starred} of ${starredTotal} required sections, ${filled} of ${total} in all`;
}
