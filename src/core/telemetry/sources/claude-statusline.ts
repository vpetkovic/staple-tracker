/**
 * Claude Code status-line input (docs/execution-telemetry.md, "What providers actually
 * expose" and "Status-line readings are cached re-reads").
 *
 * The configured `statusLine` command receives a JSON object on stdin. Its
 * `rate_limits` carries `five_hour`, `seven_day` and, behind a gateway, `spend_limit`,
 * each `{used_percentage, resets_at (Unix epoch seconds)}`, present only for
 * subscribers, after the first API response, and each only while its reset has not
 * passed. No window length, plan tier, account or observation timestamp.
 *
 * Every reading is `observedAtSource: "capture"`: the process re-sends the `rate_limits`
 * of its own last API response on every render, so a reading proves the process is
 * alive, not that the provider measured again.
 *
 * Privacy: only `rate_limits`, `session_id` (hashed at once) and `version` are read.
 * `cwd`, `transcript_path`, the workspace, the repository and the session name are
 * never touched.
 */
import { StapleError } from "../../types.js";
import type { BudgetReading, Missing } from "../budget-store.js";
import { epochSecondsToIso, sessionRefOf } from "../formats.js";
import { DOCUMENTED_WINDOW_SECONDS, skip, type ParsedItem } from "./types.js";

export function parseClaudeStatusline(raw: string, capturedAt: string): ParsedItem[] {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new StapleError("validation", "The status-line input is not JSON. Claude Code sends one JSON object on the status-line command's stdin.");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new StapleError("validation", "The status-line input must be one JSON object.");
  }
  const record = input as Record<string, unknown>;
  const rateLimits = record.rate_limits;
  // Absent for API-key users, before the first response, and once every window's reset
  // has passed. That is no reading at all: a gap, never a placeholder row.
  if (rateLimits === undefined || rateLimits === null) return [skip("not_reported_by_source", null, capturedAt)];
  if (typeof rateLimits !== "object" || Array.isArray(rateLimits)) return [skip("parse_error", null, capturedAt)];

  const sessionId = typeof record.session_id === "string" && record.session_id !== "" ? record.session_id : null;
  const sessionRef = sessionId === null ? null : sessionRefOf("claude_code", sessionId);
  const harnessVersion = typeof record.version === "string" ? record.version : null;

  const items: ParsedItem[] = [];
  for (const [name, value] of Object.entries(rateLimits as Record<string, unknown>)) {
    // The provider's own name for the limit, lowercased: five_hour, seven_day, spend_limit.
    const limitKey = name.toLowerCase();
    if (value === null || value === undefined) {
      items.push(skip("not_reported_by_source", limitKey, capturedAt));
      continue;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      items.push(skip("parse_error", limitKey, capturedAt));
      continue;
    }
    const limit = value as Record<string, unknown>;
    const used = limit.used_percentage;
    if (used === undefined || used === null) {
      items.push(skip("not_reported_by_source", limitKey, capturedAt));
      continue;
    }
    if (typeof used !== "number" || !Number.isFinite(used)) {
      items.push(skip("parse_error", limitKey, capturedAt));
      continue;
    }

    const missing: Missing = {};
    const resetsAt = epochSecondsToIso(limit.resets_at);
    if (resetsAt === null) {
      missing.resetsAt = limit.resets_at === undefined || limit.resets_at === null ? "reset_not_reported" : "parse_error";
    }
    const documented = DOCUMENTED_WINDOW_SECONDS.anthropic?.[limitKey] ?? null;
    if (documented === null) missing.windowSeconds = "not_reported_by_source";
    if (sessionRef === null) missing.sessionRef = "not_reported_by_source";
    missing.planTier = "not_reported_by_source";

    const reading: BudgetReading = {
      limitKey,
      unit: "percent_of_limit",
      usedPercent: used,
      resetsAt,
      resetsAtSource: resetsAt === null ? null : "observed_absolute",
      windowSeconds: documented,
      windowSecondsSource: documented === null ? null : "documented",
      planTier: null,
      method: "observed",
      // Observed through a surface its harness documents (the schema ships with it).
      confidence: "high",
      source: { kind: "claude_code_statusline", harnessVersion, field: `rate_limits.${name}` },
      observedAt: capturedAt,
      observedAtSource: "capture",
      sessionRef,
      missing,
    };
    items.push({ kind: "reading", reading });
  }
  return items;
}
