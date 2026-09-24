/**
 * An operator's reading typed from a provider screen (Claude Code `/usage`, Codex
 * `/status`): `source.kind: "operator_manual"`, `confidence: "medium"`.
 *
 * `--resets-at` takes either an instant (`2026-09-24T19:00:00Z`, observed absolute) or
 * what the screen shows, a duration in the existing vocabulary (`3h`), which is converted
 * at capture (`capturedAt + 3h`), marked `derived_from_relative`, and lowers the
 * confidence to `low`: a relative value is only true at the instant it was read.
 */
import { StapleError } from "../../types.js";
import type { BudgetReading, Missing } from "../budget-store.js";
import { addSeconds, normalizeInstant, parseRelativeSeconds } from "../formats.js";
import { DOCUMENTED_WINDOW_SECONDS, type ParsedItem } from "./types.js";

/** Lowercase and dotted, as the provider names the limit: `five_hour`, `codex.primary`. */
const LIMIT_KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

export interface ManualReadingInput {
  readonly provider: string;
  readonly limitKey: string;
  readonly used: number | string;
  readonly resetsAt?: string;
}

export function parseManualReading(input: ManualReadingInput, capturedAt: string): ParsedItem[] {
  const limitKey = input.limitKey.trim().toLowerCase();
  if (!LIMIT_KEY_PATTERN.test(limitKey)) {
    throw new StapleError(
      "validation",
      `--limit-key must be the provider's name for the limit, lowercase and dotted (five_hour, seven_day, codex.primary); got "${input.limitKey}".`,
    );
  }
  const used = typeof input.used === "number" ? input.used : input.used.trim() === "" ? Number.NaN : Number(input.used);
  if (!Number.isFinite(used) || used < 0) {
    throw new StapleError("validation", `--used must be the percentage used on a 0-100 scale, as the provider shows it (above 100 is kept); got "${String(input.used)}".`);
  }

  const missing: Missing = { sessionRef: "not_reported_by_source", planTier: "not_reported_by_source" };
  let resetsAt: string | null = null;
  let resetsAtSource: BudgetReading["resetsAtSource"] = null;
  if (input.resetsAt === undefined || input.resetsAt.trim() === "") {
    missing.resetsAt = "reset_not_reported";
  } else {
    const instant = normalizeInstant(input.resetsAt.trim());
    const relative = instant === null ? parseRelativeSeconds(input.resetsAt) : null;
    if (instant !== null) {
      resetsAt = instant;
      resetsAtSource = "observed_absolute";
    } else if (relative !== null) {
      resetsAt = addSeconds(capturedAt, relative);
      resetsAtSource = "derived_from_relative";
    } else {
      throw new StapleError(
        "validation",
        `--resets-at must be an instant with a zone (2026-09-24T19:00:00Z) or what the screen shows as a duration (90s, 30m, 3h, 2d); got "${input.resetsAt}".`,
      );
    }
  }
  const documented = DOCUMENTED_WINDOW_SECONDS[input.provider]?.[limitKey] ?? null;
  if (documented === null) missing.windowSeconds = "not_reported_by_source";

  return [
    {
      kind: "reading",
      reading: {
        limitKey,
        unit: "percent_of_limit",
        usedPercent: used,
        resetsAt,
        resetsAtSource,
        windowSeconds: documented,
        windowSecondsSource: documented === null ? null : "documented",
        planTier: null,
        method: "observed",
        confidence: resetsAtSource === "derived_from_relative" ? "low" : "medium",
        source: { kind: "operator_manual", harnessVersion: null, field: "used" },
        observedAt: capturedAt,
        observedAtSource: "capture",
        sessionRef: null,
        missing,
      },
    },
  ];
}
