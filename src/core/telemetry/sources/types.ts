import type { BudgetReading, SkipReason } from "../budget-store.js";

/**
 * What a source parser hands the ingestion method, in input order: a reading to offer
 * the store, or a reading the source itself decided not to offer and why.
 */
export type ParsedItem =
  | { readonly kind: "reading"; readonly reading: BudgetReading }
  | { readonly kind: "skip"; readonly reason: SkipReason; readonly limitKey: string | null; readonly observedAt: string | null };

export function skip(reason: SkipReason, limitKey: string | null, observedAt: string | null): ParsedItem {
  return { kind: "skip", reason, limitKey, observedAt };
}

/**
 * Window lengths the provider publishes for limits whose source does not report one
 * (`windowSecondsSource: "documented"`). Claude Code's status line names a 5-hour
 * session limit and a 7-day weekly limit and carries no length. A spend limit's period
 * is not described, so it has no entry.
 */
export const DOCUMENTED_WINDOW_SECONDS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  anthropic: { five_hour: 5 * 3600, seven_day: 7 * 86400 },
};
