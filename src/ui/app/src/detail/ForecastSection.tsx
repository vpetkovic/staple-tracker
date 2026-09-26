/**
 * The forecast in the Analytics tab: what is left under this issue, and, apart from it, what that
 * work does to this machine's provider limits.
 *
 * ## One payload, two blocks, never blended
 *
 * Both blocks are drawn from ONE `GET /api/forecast?ref=` (`staple forecast --json`), and they stay
 * two blocks (docs/timing-semantics.md, "Forecasts"): the completion forecast is replicated data,
 * the same on every device; the budget forecast is this machine's readings and nothing else. The
 * budget block sits in its own dashed frame under its own heading, and no figure crosses between
 * them.
 *
 * ## Rendered, never recomputed
 *
 * Every figure is a field of the payload, formatted by lib/forecast-text.ts. An unknown figure is
 * the word "Unknown" with the payload's reason, in the placeholder style, never a 0 and never a
 * dash; a lower bound says "at least". Low confidence is a visible badge, not a colour alone.
 *
 * `ForecastReportView` takes the payload as a prop and reads no context, so the e2e test renders it
 * from the real server's answer; `IssueForecast` is the fetch around it.
 */
import { getForecast } from "@/lib/api";
import {
  confidenceText,
  formatDuration,
  formatPercent,
  formatProbability,
  limitMissingText,
  limitRemainingText,
  missingText,
  remainingText,
  reserveLabel,
  resetText,
  unknownUnitReason,
  warningText,
  RATE_WARNING_TEXT,
  type ForecastMode,
  type RemainingText,
} from "@/lib/forecast-text";
import type { AuthError } from "@/lib/api";
import { useOptionalSession } from "@/lib/session";
import type { BudgetForecast, BudgetLimitForecast, CompletionForecast, ForecastReport } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";

const HEADING = "mb-1.5 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase";
/** The placeholder a missing figure wears: the interface face, small, muted, italic. Never a figure. */
const UNKNOWN = "text-[11px] text-muted-foreground italic";

/** A warning as a calm chip: the short label on the page, the plain sentence in the tooltip and for a screen reader. */
export function WarningChip({ code, table }: { code: string; table?: Record<string, { label: string; tip: string }> }) {
  const { label, tip } = warningText(code, table);
  return (
    <li
      data-warning={code}
      title={tip}
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground"
    >
      {label}
      <span className="sr-only">: {tip}</span>
    </li>
  );
}

export function WarningChips({ codes, table, label }: { codes: readonly string[]; table?: Record<string, { label: string; tip: string }>; label: string }) {
  if (codes.length === 0) return null;
  return (
    <ul aria-label={label} className="mt-1.5 flex flex-wrap gap-1">
      {codes.map((code) => (
        <WarningChip key={code} code={code} table={table} />
      ))}
    </ul>
  );
}

/** The confidence badge. Low is marked with a dashed border and the word; colour never carries it alone. */
export function ConfidenceBadge({ label, text }: { label: "high" | "medium" | "low"; text: string }) {
  return (
    <span
      data-confidence={label}
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        label === "low" && "border-dashed border-[var(--status-task-todo)] text-[var(--status-task-todo)]",
        label === "medium" && "text-muted-foreground",
      )}
    >
      {text}
    </span>
  );
}

/** A clickable identifier that opens the issue, or plain text where nothing can open it. */
function RefLink({ refId, onOpen }: { refId: string; onOpen?: (ref: string) => void }) {
  if (!onOpen) return <span className="font-mono">{refId}</span>;
  return (
    <button type="button" className="font-mono underline-offset-2 hover:underline" onClick={() => onOpen(refId)}>
      {refId}
    </button>
  );
}

/** One remaining figure: a label, the value (or its named absence), and its ranges beneath. */
function RemainingRow({ label, text, testId, children }: { label: string; text: RemainingText; testId: string; children?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 py-2 text-[11px]" data-testid={testId}>
      <span className="font-medium">{label}</span>
      <div className="min-w-0 space-y-0.5">
        {text.value === null ? (
          <div className={UNKNOWN} data-unknown>
            {text.absent}
          </div>
        ) : (
          <div data-figure>
            {text.lowerBound ? <span className="text-[11px] text-muted-foreground">at least </span> : null}
            <span className="font-mono text-[13px] tabular-nums">{text.figure}</span>
          </div>
        )}
        {text.spread ? (
          <div className="font-mono text-[10px] text-muted-foreground tabular-nums">
            <span className="whitespace-nowrap">{text.spread}</span> · <span className="whitespace-nowrap">{text.band}</span>
            {text.lowerBound ? <span className="font-sans"> (lower bounds)</span> : null}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function CompletionBlock({ completion, mode, onOpen }: { completion: CompletionForecast; mode: Exclude<ForecastMode, null>; onOpen?: (ref: string) => void }) {
  const confidence = confidenceText(completion.confidence);
  const labor = remainingText(completion.labor);
  const path = remainingText(completion.path);
  const unknown = completion.units.items.filter((unit) => unit.treatment === "forecast" && unit.expected === null);
  const awaiting = completion.units.items.filter((unit) => unit.treatment === "awaiting_review");
  const chain = completion.path.chain;

  return (
    <section aria-label="Completion forecast" data-block="completion">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className={cn(HEADING, "mb-0")}>Forecast</h3>
        <span className="ml-auto" />
        <ConfidenceBadge label={completion.confidence.label} text={confidence.label} />
      </div>

      {completion.settled ? (
        <p className="text-[11px] text-muted-foreground" data-testid="forecast-settled">
          Every unit is done: nothing is left to forecast.
        </p>
      ) : (
        <div className="divide-y border-t border-b">
          <RemainingRow label={mode === "full" ? "Remaining labor" : "Remaining work"} text={labor} testId="forecast-labor" />
          {mode === "full" ? (
            <RemainingRow label="Critical path" text={path} testId="forecast-path">
              {chain.length > 0 ? (
                <ol aria-label="Critical path chain" className="flex flex-wrap items-center gap-x-1 text-[10px] text-muted-foreground">
                  {chain.map((step, index) => (
                    <li key={step.ref} className="inline-flex items-center gap-1">
                      {index > 0 ? <span aria-hidden>→</span> : null}
                      <RefLink refId={step.ref} onOpen={onOpen} />
                      <span className="tabular-nums">{step.seconds === null ? "unknown" : formatDuration(step.seconds)}</span>
                    </li>
                  ))}
                  {completion.path.chainLength > chain.length ? <li>and {completion.path.chainLength - chain.length} more</li> : null}
                </ol>
              ) : null}
            </RemainingRow>
          ) : null}
        </div>
      )}

      <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="forecast-confidence">
        {confidence.label}: {confidence.achieved}.
        {confidence.reasons.length > 0 ? ` Not high because: ${confidence.reasons.join(", ").toLowerCase()}.` : null}
      </p>
      <WarningChips codes={completion.warnings} label="Forecast warnings" />

      {awaiting.length > 0 ? (
        <div className="mt-2" data-testid="forecast-awaiting">
          <div className="text-[10px] text-muted-foreground">Not forecast: in review or awaiting approval ({missingText("not_forecast")})</div>
          <ul className="text-[11px]">
            {awaiting.map((unit) => (
              <li key={unit.ref} className="flex min-w-0 gap-2">
                <RefLink refId={unit.ref} onOpen={onOpen} />
                <span className="truncate text-muted-foreground" title={unit.title}>
                  {unit.title}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unknown.length > 0 ? (
        <div className="mt-2" data-testid="forecast-unknown">
          <div className="text-[10px] text-muted-foreground">Unknown: not counted, so the sums above are lower bounds</div>
          <ul className="text-[11px]">
            {unknown.map((unit) => (
              <li key={unit.ref} className="flex min-w-0 flex-wrap gap-x-2">
                <RefLink refId={unit.ref} onOpen={onOpen} />
                <span className="min-w-0 truncate text-muted-foreground" title={unit.title}>
                  {unit.title}
                </span>
                <span className={cn(UNKNOWN, "ml-auto shrink-0 pr-0.5")}>{unknownUnitReason(unit)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {mode === "full" ? (
        <p className="mt-2 text-[10px] text-muted-foreground" data-testid="forecast-units">
          {completion.units.forecast} of {completion.units.total} units forecast ({completion.units.known} known) ·{" "}
          {completion.units.done} done · {completion.units.awaitingReview} in review
          {completion.plan.seconds !== null ? ` · the plan's estimates add up to ${formatDuration(completion.plan.seconds)} (a plan, not a forecast)` : null}
          {completion.units.truncated ? " · units listed up to the limit" : null}
        </p>
      ) : null}
      <p className="mt-1 text-[10px] text-muted-foreground">
        Effort along the work, not calendar time: waits for an agent, a review or an outside blocker are not in it.
      </p>
    </section>
  );
}

/** What a limit's projection says, as lines; each unknown with its reason. */
function LimitLines({ limit }: { limit: BudgetLimitForecast }) {
  const rate = limit.workRate;
  const reserve = limit.reserve;
  const work = limit.work;
  return (
    <div className="min-w-0 space-y-0.5 text-[11px]">
      {rate ? (
        <div data-testid="budget-rate">
          <span className="font-mono tabular-nums">{formatPercent(rate.percentPerWorkHour)}/work-hour</span>
          <span className="text-muted-foreground">
            {" "}
            work rate · {rate.confidence.label} confidence ({rate.confidence.spans} of {rate.confidence.minimum} spans)
          </span>
          <WarningChips codes={rate.confidence.warnings} table={RATE_WARNING_TEXT} label="Work rate warnings" />
        </div>
      ) : (
        <div className={UNKNOWN} data-unknown data-testid="budget-rate">
          Work rate unknown: {limitMissingText(limit, "workRate") ?? "no reason given"}
        </div>
      )}
      {work ? (
        <div className="text-muted-foreground" data-testid="budget-work">
          The work alone {work.lowerBound ? "uses at least" : "uses"} {formatPercent(work.consumedPercent.expected)} and leaves{" "}
          {work.lowerBound ? "at most " : ""}
          {formatPercent(work.remainingAtResetPercent.expected)} at the reset
          {work.outlastsResetProbability > 0 ? `; ${formatProbability(work.outlastsResetProbability)} chance it runs past the reset` : null}
        </div>
      ) : (
        <div className={UNKNOWN} data-unknown data-testid="budget-work">
          This work's burn unknown: {limitMissingText(limit, "work") ?? "no reason given"}
        </div>
      )}
      {reserve ? (
        <div data-testid="budget-breach">
          {reserve.breachProbability === null ? (
            <span className={UNKNOWN} data-unknown>
              Chance of going under {reserveLabel(reserve)} unknown: {limitMissingText(reserve, "breachProbability") ?? "no reason given"}
            </span>
          ) : (
            <>
              <span className="font-mono tabular-nums">{formatProbability(reserve.breachProbability)}</span>
              <span className="text-muted-foreground"> chance of going under {reserveLabel(reserve)}</span>
              {reserve.alreadyBelow ? <span className="text-muted-foreground"> (already below it)</span> : null}
              <span className="text-muted-foreground"> · {reserve.confidence.label} confidence</span>
            </>
          )}
          <div className="text-[10px] text-muted-foreground">
            {reserve.withOtherUse
              ? reserve.withOtherUse.breachProbability === null
                ? "With other use of the account: unknown"
                : `With other use of the account: ${formatProbability(reserve.withOtherUse.breachProbability)}`
              : `With other use of the account: unknown, ${limitMissingText(reserve, "withOtherUse") ?? "not measured"}`}
          </div>
        </div>
      ) : (
        <div className={UNKNOWN} data-unknown data-testid="budget-breach">
          Chance of going under the reserve unknown: {limitMissingText(limit, "reserve") ?? "no reason given"}
        </div>
      )}
    </div>
  );
}

function BudgetBlock({ budget }: { budget: BudgetForecast }) {
  const reserve = budget.reserve;
  return (
    <section aria-label="Budget forecast" data-block="budget" className="rounded-md border border-dashed px-3 py-2.5">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <h3 className={cn(HEADING, "mb-0")}>Budget</h3>
        <span className="text-[10px] text-muted-foreground">this machine only, apart from the forecast above</span>
      </div>
      <p className="text-[10px] text-muted-foreground" data-testid="budget-reserve">
        Measured against {reserveLabel(reserve)}
        {reserve.source === "provisional_default" ? " (provisional until an admission policy sets one)" : null}. The work runs serially from now.
      </p>

      {budget.accounts.length === 0 ? (
        <p className={cn(UNKNOWN, "mt-1.5")} data-unknown data-testid="budget-none">
          No budget forecast: {budget.missing.accounts ? missingText(budget.missing.accounts) : "no accounts"}.
        </p>
      ) : (
        <div className="mt-1.5 space-y-2">
          {budget.accounts.map((account) => (
            <div key={`${account.provider}:${account.accountRef}`} data-account={account.accountRef}>
              <div className="text-[11px] font-medium">
                {account.accountRef}
                {account.provider ? <span className="font-normal text-muted-foreground"> · {account.provider}</span> : null}
              </div>
              {account.limits.length === 0 ? (
                <p className={UNKNOWN} data-unknown>
                  No limits read{Object.values(account.missing).length > 0 ? `: ${Object.values(account.missing).map(missingText).join("; ")}` : ""}.
                </p>
              ) : (
                <div className="divide-y border-t border-b">
                  {account.limits.map((limit) => {
                    const remaining = limitRemainingText(limit);
                    return (
                      <div key={limit.limitKey} data-limit={limit.limitKey} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 py-2 text-[11px]">
                        <div className="min-w-0">
                          <div className="truncate font-mono" title={limit.limitKey}>
                            {limit.limitKey}
                          </div>
                          {remaining.value !== null ? (
                            <div className="font-mono text-[13px] tabular-nums" data-testid="budget-remaining">
                              {remaining.value}
                            </div>
                          ) : (
                            <div className={UNKNOWN} data-unknown data-testid="budget-remaining">
                              {remaining.absent}
                            </div>
                          )}
                          <div className="text-[10px] text-muted-foreground" title={limit.resetsAt ?? undefined} data-testid="budget-reset">
                            {resetText(limit)}
                          </div>
                        </div>
                        <LimitLines limit={limit} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** The snapshot identities, tucked away: a reader who needs to say which data this was can open it. */
function DataDisclosure({ report }: { report: ForecastReport }) {
  return (
    <details className="text-[10px] text-muted-foreground" data-testid="forecast-data">
      <summary className="cursor-pointer select-none">Data</summary>
      <dl className="mt-1 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        <dt>as of</dt>
        <dd className="font-mono break-all">{report.asOf}</dd>
        <dt>forecast</dt>
        <dd className="font-mono break-all">{report.snapshot.id}</dd>
        <dt>calibration</dt>
        <dd className="font-mono break-all">
          {report.snapshot.calibration.id} ({report.snapshot.calibration.samples} samples of {report.snapshot.calibration.members} members)
        </dd>
        <dt>budget</dt>
        <dd className="font-mono break-all">{report.snapshot.budget.id} (this machine only)</dd>
        <dt>scope</dt>
        <dd>{report.subject.scope === "subtree" ? "the units beneath this issue" : "this issue as its own unit"}</dd>
      </dl>
    </details>
  );
}

/** The whole forecast, from one payload. */
export function ForecastReportView({ report, mode, onOpen }: { report: ForecastReport; mode: Exclude<ForecastMode, null>; onOpen?: (ref: string) => void }) {
  return (
    <div className="space-y-3" data-forecast-mode={mode}>
      <CompletionBlock completion={report.completion} mode={mode} onOpen={onOpen} />
      <BudgetBlock budget={report.budget} />
      <DataDisclosure report={report} />
    </div>
  );
}

/** The fetch around the view. A failed read says so in the section; it never blanks the tab. */
export function IssueForecast({
  workspace,
  refId,
  mode,
  onAuthError,
}: {
  workspace: string;
  refId: string;
  mode: Exclude<ForecastMode, null>;
  onAuthError: (error: AuthError) => void;
}) {
  // Re-read on the page's fingerprint, like every other view: new work moves the forecast.
  const session = useOptionalSession();
  const version = session?.version ?? 0;
  const onOpen = session ? (ref: string) => session.open(workspace, ref) : undefined;
  const forecast = useResource(() => getForecast({ ws: workspace, ref: refId }), [workspace, refId, version], onAuthError);
  if (forecast.error) {
    return (
      <section aria-label="Completion forecast">
        <h3 className={HEADING}>Forecast</h3>
        <p className={UNKNOWN}>The forecast could not be read: {forecast.error.message}</p>
      </section>
    );
  }
  if (!forecast.data) {
    return (
      <section aria-label="Completion forecast">
        <h3 className={HEADING}>Forecast</h3>
        <p className="text-[11px] text-muted-foreground">Reading the forecast…</p>
      </section>
    );
  }
  return <ForecastReportView report={forecast.data} mode={mode} onOpen={onOpen} />;
}
