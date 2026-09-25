/**
 * Bounded telemetry reads: limits, cursors and coverage (docs/execution-telemetry.md,
 * "Bounded reads, coverage and truncation").
 *
 * Every telemetry list answers `{items, truncated, nextCursor, coverage}`:
 *
 *   - `limit` defaults to 50 and is clamped to 500;
 *   - `truncated` is stated by the read (it fetched one row more than it returns), never
 *     inferred from `itemCount == limit`;
 *   - the cursor is a KEYSET position, not an offset. A list ordered by an instant and an id
 *     resumes strictly after the last row it returned, so rows inserted between two pages
 *     never shift a page: no row is returned twice and no row that existed is skipped. The
 *     offset cursors in `types.ts` cannot promise that, which is why these are separate;
 *   - a cursor carries a fingerprint of the arguments it was issued for, and replaying it
 *     against other arguments is refused, as every other cursor in staple is.
 */
import { createHash } from "node:crypto";
import { clampLimit, StapleError, type PageLimits } from "../types.js";

export const TELEMETRY_PAGE_LIMITS: PageLimits = { default: 50, max: 500 };

/**
 * A span with no sample longer than this is a capture gap. Two heartbeat intervals: an
 * unchanged reading is stored again only once the previous one is 300 s old, so stored
 * samples of a live session can legitimately be a little over 300 s apart, and one interval
 * would report the heartbeat cadence itself as a gap.
 */
export const GAP_SECONDS = 600;

/** One span nobody was looking, with a reason from the contract's missingness table. */
export interface CoverageGap {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface Coverage {
  /** The first instant the page speaks for, or null when it speaks for none. */
  readonly from: string | null;
  /** The last instant the page speaks for, or null when it speaks for none. */
  readonly to: string | null;
  readonly itemCount: number;
  readonly gaps: CoverageGap[];
}

export interface TelemetryPage<T> {
  readonly items: T[];
  readonly truncated: boolean;
  /** Null exactly when `truncated` is false. */
  readonly nextCursor: string | null;
  readonly coverage: Coverage;
}

export interface PageRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

/** A keyset position: the sort instant and id of the last row a page returned. */
export interface KeysetPosition {
  readonly at: string;
  readonly id: string;
}

interface CursorPayload {
  /** Always "t": a telemetry keyset cursor. */
  readonly k: "t";
  /** Which list issued it (`attempts`, `transitions`, `budget_samples`). */
  readonly l: string;
  /** Fingerprint of the arguments it was issued for. */
  readonly q: string;
  readonly at: string;
  readonly id: string;
}

/** Stable fingerprint of the arguments a cursor was issued for. */
function fingerprint(scope: unknown): string {
  return createHash("sha256").update(JSON.stringify(scope ?? null)).digest("hex").slice(0, 12);
}

export function encodeKeysetCursor(list: string, scope: unknown, position: KeysetPosition): string {
  const payload: CursorPayload = { k: "t", l: list, q: fingerprint(scope), at: position.at, id: position.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeKeysetCursor(list: string, scope: unknown, cursor: string): KeysetPosition {
  let payload: CursorPayload | null = null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (parsed?.k === "t" && typeof parsed.l === "string" && typeof parsed.q === "string" && typeof parsed.at === "string" && typeof parsed.id === "string") {
      payload = parsed;
    }
  } catch {
    payload = null;
  }
  if (payload === null) throw new StapleError("validation", "Cursor is not a cursor this server issued. Drop it and start from the first page.");
  if (payload.l !== list) throw new StapleError("validation", "Cursor belongs to a different kind of list.");
  if (payload.q !== fingerprint(scope)) {
    throw new StapleError(
      "validation",
      "Cursor was issued for different arguments. Re-run the first page with these arguments, or reuse the arguments the cursor came from.",
    );
  }
  return { at: payload.at, id: payload.id };
}

/** The effective limit: the default when absent, clamped to the maximum. */
export function pageLimit(limit: number | undefined): number {
  return clampLimit(limit, TELEMETRY_PAGE_LIMITS);
}

/** Strictly after a keyset position, in (at, id) order. */
export function afterPosition(row: KeysetPosition, position: KeysetPosition | null): boolean {
  if (position === null) return true;
  return row.at > position.at || (row.at === position.at && row.id > position.id);
}

/**
 * Cut `rows` (already in keyset order and already after the cursor) to one page. `rows` may
 * hold more than `limit + 1`; only whether there is one more is used.
 */
export function cutPage<T>(
  rows: readonly T[],
  limit: number,
  list: string,
  scope: unknown,
  keyOf: (row: T) => KeysetPosition,
): { items: T[]; truncated: boolean; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const truncated = rows.length > limit;
  const last = items[items.length - 1];
  return { items, truncated, nextCursor: truncated && last !== undefined ? encodeKeysetCursor(list, scope, keyOf(last)) : null };
}

const ms = (instant: string): number => Date.parse(instant);

/**
 * The gaps in a timeline of observation instants: every span between two consecutive
 * instants (and between the bounds and the first and last) longer than {@link GAP_SECONDS}.
 * `leadingReason` names the gap before the first instant.
 */
export function gapsIn(
  instants: readonly string[],
  bounds: { from: string | null; to: string | null },
  reasons: { leading: string; between: string; trailing: string },
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const limit = GAP_SECONDS * 1000;
  const points = [...instants];
  if (bounds.from !== null && (points.length === 0 || points[0]! > bounds.from)) {
    const first = points[0] ?? bounds.to;
    if (first !== null && first !== undefined && ms(first) - ms(bounds.from) > limit) {
      gaps.push({ from: bounds.from, to: first, reason: reasons.leading });
    }
  }
  for (let i = 1; i < points.length; i += 1) {
    if (ms(points[i]!) - ms(points[i - 1]!) > limit) gaps.push({ from: points[i - 1]!, to: points[i]!, reason: reasons.between });
  }
  const last = points[points.length - 1];
  if (last !== undefined && bounds.to !== null && ms(bounds.to) - ms(last) > limit) gaps.push({ from: last, to: bounds.to, reason: reasons.trailing });
  return gaps;
}
