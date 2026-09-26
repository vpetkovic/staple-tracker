/**
 * Removing budget readings (docs/execution-telemetry.md, "Removing a reading"): the one
 * method `staple budget forget`, the MCP tool `forget_budget_samples` and `POST
 * /api/budget/forget` call, so the three cannot answer differently.
 *
 * A reading that should never have been stored has no other way out. For example, a
 * synthetic status-line payload piped through the live ingest can open a false window
 * that supersedes the real one. This removes named readings through
 * {@link BudgetStore.forget}. Without consent it only previews: the same transaction,
 * rolled back, so the preview shows exactly what the removal would do. With consent it
 * commits and appends one audit line to the budget log.
 *
 * Machine-local: `hub.db` and the staple home's `logs/`. No workspace is touched, nothing
 * replicates, and no network call is made or triggered.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../hub.js";
import { nowIso } from "../types.js";
import { BudgetStore, type ForgetWindowChange, type LimitKey, type Missing } from "./budget-store.js";
import { collectLogPath, rotateLog } from "./collection/codex-collect.js";
import { limitReadingOf } from "./read-budget.js";

/** Which surface asked: recorded in the audit line. */
export type ForgetSurface = "cli" | "mcp" | "http";

export interface ForgetRequest {
  /** Reading ids: full ids, or prefixes that name exactly one reading. */
  readonly ids: readonly string[];
  /** The consent. Without it nothing is removed and the result is the preview. */
  readonly confirm: boolean;
  readonly via: ForgetSurface;
}

/** One limit as `staple budget` reads it: its current window and that window's latest reading. */
export interface ForgetLimitView {
  /** `current` or `elapsed` (or `superseded`), or null when the limit has no window left. */
  readonly status: string | null;
  readonly window: { readonly id: string; readonly resetsAt: string | null; readonly status: string; readonly supersededBy: string | null } | null;
  readonly latestSample: { readonly id: string; readonly usedPercent: number | null; readonly observedAt: string } | null;
  readonly highWaterPercent: number | null;
  readonly remainingPercent: number | null;
  readonly missing: Missing;
}

export interface ForgottenReading {
  readonly id: string;
  readonly provider: string;
  readonly accountRef: string;
  readonly limitKey: string;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  readonly observedAt: string;
  readonly sessionRef: string | null;
  readonly sourceKind: string;
  readonly windowId: string | null;
}

export interface ForgetResult {
  /** False for a preview: nothing was removed. */
  readonly applied: boolean;
  readonly asOf: string;
  readonly readings: ForgottenReading[];
  readonly windows: ForgetWindowChange[];
  readonly limits: ReadonlyArray<LimitKey & { readonly before: ForgetLimitView; readonly after: ForgetLimitView }>;
  /** Where the audit line was written, when applied. */
  readonly auditLog: string | null;
}

export interface ForgetDeps {
  /** The staple home: its `hub.db` and its `logs/`. */
  readonly home: string;
  readonly now?: () => string;
}

function viewOf(store: BudgetStore, limit: LimitKey, now: string): ForgetLimitView {
  const reading = limitReadingOf(store, limit.provider, limit.accountRef, limit.limitKey, now);
  return {
    status: reading.status,
    window:
      reading.window === null
        ? null
        : { id: reading.window.id, resetsAt: reading.window.resetsAt, status: reading.window.status, supersededBy: reading.window.supersededBy },
    latestSample:
      reading.latestSample === null
        ? null
        : { id: reading.latestSample.id, usedPercent: reading.latestSample.usedPercent, observedAt: reading.latestSample.observedAt },
    highWaterPercent: reading.highWaterPercent,
    remainingPercent: reading.remainingPercent,
    missing: reading.missing,
  };
}

export function forgetBudgetSamples(request: ForgetRequest, deps: ForgetDeps): ForgetResult {
  const now = deps.now ?? nowIso;
  const at = now();
  const hub = Hub.openAt(deps.home);
  let result: ForgetResult;
  try {
    const outcome = new BudgetStore(hub.db).forget(request.ids, {
      apply: request.confirm === true,
      at,
      summarize: (store, limit) => viewOf(store, limit, at),
    });
    result = {
      applied: outcome.applied,
      asOf: at,
      readings: outcome.samples.map((sample) => ({
        id: sample.id,
        provider: sample.provider,
        accountRef: sample.accountRef,
        limitKey: sample.limitKey,
        usedPercent: sample.usedPercent,
        resetsAt: sample.resetsAt,
        observedAt: sample.observedAt,
        sessionRef: sample.sessionRef,
        sourceKind: sample.source.kind,
        windowId: sample.windowId,
      })),
      windows: outcome.windows,
      limits: outcome.limits,
      auditLog: null,
    };
  } finally {
    hub.close();
  }
  if (!result.applied) return result;
  // The audit line: what was removed, when, and through which surface. Written after the
  // commit, so it never names a removal that did not happen.
  const logPath = collectLogPath(deps.home);
  mkdirSync(join(deps.home, "logs"), { recursive: true, mode: 0o700 });
  rotateLog(logPath);
  appendFileSync(
    logPath,
    `${JSON.stringify({
      at,
      action: "forget",
      via: request.via,
      readings: result.readings,
      windows: result.windows.map((w) => ({ windowId: w.windowId, outcome: w.outcome, released: w.released })),
    })}\n`,
    { mode: 0o600 },
  );
  return { ...result, auditLog: logPath };
}
