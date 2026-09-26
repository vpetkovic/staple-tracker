/**
 * The Budget destination: this machine's provider limits and each one's session pressure, as
 * `staple budget` reads them (docs/execution-telemetry.md, "Pressure"; docs/web-ui.md, "Budget").
 *
 * ## The machine's, not a workspace's
 *
 * Budget readings live in this machine's hub and never synchronize, so the view takes no `ws` and
 * reads the same whichever workspace the switcher names. The rail lists it in its own Machine group.
 *
 * ## Measured apart from forecast
 *
 * Each limit is one card with two blocks that never share a figure. MEASURED (a solid frame): what
 * the provider reported, the remaining figure, the reset countdown, the observed pace and how old
 * the last reading is. FORECAST (a dashed frame, labelled provisional): the sustainable pace, the
 * pressure, when the pace uses the limit up and reaches the reserve, safe concurrency (not defined
 * until the admission policy is), and the confidence of the pace behind them.
 *
 * ## Live, and honest about when
 *
 * The page re-reads every 30 seconds. Between reads the reset countdown and the reading's age tick
 * by the seconds the page has held the answer (`tickSeconds`); the forecast figures do not move,
 * and say "as of" the instant the server read them.
 *
 * ## Rendered, never recomputed
 *
 * Every figure is a field of `GET /api/budget`, formatted by lib/budget-text.ts. An unknown figure
 * is the word "Unknown" with the payload's reason, never 0. The unsafe state is a word, an icon and
 * a hatched frame, never a colour alone.
 *
 * `BudgetReportView` takes the payload (and the seconds held) as props and reads no context, so the
 * e2e test renders it from the real server's answer; `BudgetView` is the fetch and the clock.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw } from "lucide-react";
import { getBudget, type AuthError } from "@/lib/api";
import {
  BUDGET_REFRESH_MS,
  PRESSURE_WARNING_TEXT,
  accountAbsentText,
  ageText,
  clockText,
  exhaustionText,
  machineAbsentText,
  noWindowText,
  percentText,
  perHourText,
  pressureRatioText,
  pressureStateText,
  reachText,
  remainingText,
  reserveText,
  sourceText,
  tickSeconds,
  whyUnknown,
  type PressureTone,
} from "@/lib/budget-text";
import { formatDuration } from "@/lib/forecast-text";
import { useSession } from "@/lib/session";
import type { BudgetAccountView, BudgetLimitReading, BudgetView as BudgetPayload } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { ConfidenceBadge, WarningChips } from "@/detail/ForecastSection";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/views/ViewChrome";

const EYEBROW = "text-[10px] font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase";
const UNKNOWN = "text-[11px] text-muted-foreground italic";

/** One label and its value (or its named absence). */
function Figure({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-x-3 py-1 text-[12px]" data-testid={testId}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Unknown({ children }: { children: React.ReactNode }) {
  return (
    <span className={UNKNOWN} data-unknown>
      {children}
    </span>
  );
}

const TONE_ICON: Record<PressureTone, typeof AlertTriangle> = { unsafe: AlertTriangle, within: CheckCircle2, unknown: CircleHelp };

/** The pressure state: a word and an icon, in a frame that is hatched when unsafe and dashed when unknown. */
function PressureBadge({ tone, word }: { tone: PressureTone; word: string }) {
  const Icon = TONE_ICON[tone];
  return (
    <span
      data-pressure-badge={tone}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        tone === "unsafe" && "border-destructive text-destructive",
        tone === "within" && "text-muted-foreground",
        tone === "unknown" && "border-dashed text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {word}
    </span>
  );
}

/** The hatch an unsafe card wears down its left edge: a pattern, so the state never rests on colour alone. */
const UNSAFE_HATCH = {
  backgroundImage: "repeating-linear-gradient(135deg, var(--destructive) 0 3px, transparent 3px 7px)",
} as const;

function MeasuredBlock({ limit, heldSeconds }: { limit: BudgetLimitReading; heldSeconds: number }) {
  const { pressure } = limit;
  const remaining = remainingText(limit);
  const sample = limit.latestSample;
  return (
    <section aria-label="Measured" data-block="measured" className="min-w-0 rounded-md border px-3 py-2">
      <h4 className={EYEBROW}>Measured</h4>
      <dl>
        <Figure label="Remaining" testId="budget-remaining">
          {remaining.value !== null ? (
            <span className="font-mono text-[15px] font-medium tabular-nums">{remaining.value}</span>
          ) : (
            <Unknown>{remaining.absent}</Unknown>
          )}
          {limit.highWaterPercent !== null ? <span className="text-[11px] text-muted-foreground"> (high-water {percentText(limit.highWaterPercent)} used)</span> : null}
        </Figure>
        <Figure label="Resets in" testId="budget-reset">
          {pressure.secondsToReset !== null ? (
            <>
              <span className="font-mono tabular-nums" data-countdown>
                {formatDuration(tickSeconds(pressure.secondsToReset, heldSeconds, "down"))}
              </span>
              {limit.window?.resetsAt ? <span className="text-[11px] text-muted-foreground"> · at {clockText(limit.window.resetsAt)}</span> : null}
            </>
          ) : (
            <Unknown>Unknown: {whyUnknown(pressure, "secondsToReset") ?? "no reason given"}</Unknown>
          )}
        </Figure>
        <Figure label="Observed pace" testId="budget-observed">
          {pressure.observed ? (
            <>
              <span className="font-mono tabular-nums">{perHourText(pressure.observed.percentPerHour)}</span>
              <span className="text-[11px] text-muted-foreground">
                {" "}
                · {percentText(pressure.observed.fromPercent)} to {percentText(pressure.observed.toPercent)} over {formatDuration(pressure.observed.spanSeconds)}, {pressure.observed.readings} readings
              </span>
            </>
          ) : (
            <Unknown>Unknown: {whyUnknown(pressure, "observed") ?? "no reason given"}</Unknown>
          )}
        </Figure>
        <Figure label="Last reading" testId="budget-last-reading">
          {pressure.lastReadingAgeSeconds !== null ? (
            <>
              <span className="font-mono tabular-nums" data-age>
                {ageText(tickSeconds(pressure.lastReadingAgeSeconds, heldSeconds, "up"))}
              </span>
              {sample ? <span className="text-[11px] text-muted-foreground"> · {sourceText(sample.source.kind)}</span> : null}
              {limit.stale ? (
                <span className="ml-1 rounded border border-dashed px-1 text-[10px] text-muted-foreground" data-stale>
                  stale: over 10 minutes old
                </span>
              ) : null}
            </>
          ) : (
            <Unknown>Unknown: {whyUnknown(pressure, "lastReadingAgeSeconds") ?? "no reason given"}</Unknown>
          )}
        </Figure>
      </dl>
    </section>
  );
}

function ForecastBlock({ limit, asOf }: { limit: BudgetLimitReading; asOf: string }) {
  const { pressure } = limit;
  return (
    <section aria-label="Forecast" data-block="forecast" className="min-w-0 rounded-md border border-dashed px-3 py-2">
      <h4 className={EYEBROW}>
        Forecast <span className="normal-case tracking-normal">· provisional, as of {clockText(asOf)}</span>
      </h4>
      <dl>
        <Figure label="Sustainable pace" testId="budget-sustainable">
          {pressure.sustainablePercentPerHour !== null ? (
            <>
              <span className="font-mono tabular-nums">{perHourText(pressure.sustainablePercentPerHour)}</span>
              <span className="text-[11px] text-muted-foreground"> keeps {Math.round(pressure.reservePercent)}% at the reset</span>
            </>
          ) : (
            <Unknown>Unknown: {whyUnknown(pressure, "sustainablePercentPerHour") ?? "no reason given"}</Unknown>
          )}
        </Figure>
        <Figure label="Pressure" testId="budget-pressure">
          {pressure.ratio !== null ? (
            <span className="font-mono tabular-nums">{pressureRatioText(pressure.ratio)}</span>
          ) : (
            <Unknown>Unknown: {whyUnknown(pressure, "ratio") ?? "no reason given"}</Unknown>
          )}
        </Figure>
        <Figure label="Runs out" testId="budget-exhaustion">
          {pressure.exhaustion ? <span>{exhaustionText(pressure.exhaustion)}</span> : <Unknown>Unknown: {whyUnknown(pressure, "exhaustion") ?? "no reason given"}</Unknown>}
        </Figure>
        <Figure label="Reaches reserve" testId="budget-reach">
          {pressure.reserveReach ? (
            <span className={cn(pressure.reserveReach.atPace === "before_reset" || pressure.reserveReach.atPace === "already" ? "font-medium" : undefined)}>
              {reachText(pressure.reserveReach)}
            </span>
          ) : (
            <Unknown>Unknown: {whyUnknown(pressure, "reserveReach") ?? "no reason given"}</Unknown>
          )}
        </Figure>
        <Figure label="Safe concurrency" testId="budget-concurrency">
          <Unknown>Not defined yet: {whyUnknown(pressure, "safeConcurrency") ?? "no reason given"}</Unknown>
        </Figure>
        <Figure label="Confidence" testId="budget-confidence">
          {pressure.confidence ? (
            <>
              <ConfidenceBadge label={pressure.confidence.label} text={pressure.confidence.label === "low" ? "Low confidence" : "Medium confidence"} />
              <span className="text-[11px] text-muted-foreground">
                {" "}
                {pressure.confidence.readings} readings over {formatDuration(pressure.confidence.spanSeconds)}
              </span>
              <WarningChips codes={pressure.confidence.warnings} table={PRESSURE_WARNING_TEXT} label="Pressure confidence warnings" />
            </>
          ) : (
            <Unknown>Unknown: {whyUnknown(pressure, "confidence") ?? "no reason given"}</Unknown>
          )}
        </Figure>
      </dl>
    </section>
  );
}

function LimitCard({ limit, asOf, unsafeAt, heldSeconds }: { limit: BudgetLimitReading; asOf: string; unsafeAt: number; heldSeconds: number }) {
  const state = pressureStateText(limit.pressure, unsafeAt);
  const noWindow = noWindowText(limit);
  return (
    <article
      data-limit={limit.limitKey}
      data-pressure-state={state.tone}
      aria-label={`${limit.limitKey}: pressure ${state.word.toLowerCase()}`}
      className={cn("relative overflow-hidden rounded-lg border bg-card py-2.5 pr-3 pl-4", state.tone === "unsafe" && "border-destructive")}
    >
      {state.tone === "unsafe" ? <span aria-hidden data-unsafe-hatch className="absolute inset-y-0 left-0 w-1.5" style={UNSAFE_HATCH} /> : null}
      <header className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="min-w-0 truncate font-mono text-[12px] font-medium" title={limit.limitKey}>
          {limit.limitKey}
        </h3>
        {limit.window?.label ? <span className="text-[11px] text-muted-foreground">{limit.window.label}</span> : null}
        <span className="ml-auto" />
        <PressureBadge tone={state.tone} word={state.word} />
      </header>
      {noWindow ? null : (
        <p className={cn("mb-2 text-[11px]", state.tone === "unsafe" ? "text-destructive" : "text-muted-foreground")} data-testid="budget-state-detail">
          {state.word}: {state.detail}
        </p>
      )}
      {noWindow ? (
        <div data-testid="budget-no-window">
          <p className={UNKNOWN} data-unknown>
            {noWindow.reason}
          </p>
          {noWindow.hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{noWindow.hint}</p> : null}
        </div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          <MeasuredBlock limit={limit} heldSeconds={heldSeconds} />
          <ForecastBlock limit={limit} asOf={asOf} />
        </div>
      )}
    </article>
  );
}

function AccountSection({ account, view, heldSeconds }: { account: BudgetAccountView; view: BudgetPayload; heldSeconds: number }) {
  const absent = account.limits.length === 0 ? accountAbsentText(account, view.budgetCapture) : null;
  return (
    <section aria-label={`Account ${account.accountRef}`} data-account={account.accountRef} className="space-y-2">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-[13px] font-medium">
        <span className="break-all">{account.accountRef}</span>
        {account.provider ? <span className="text-[11px] font-normal text-muted-foreground">{account.provider}</span> : null}
        <span className="text-[11px] font-normal text-muted-foreground" data-bound={account.bound ? "yes" : "no"}>
          {account.bound ? "bound on this machine" : "not bound on this machine"}
        </span>
      </h2>
      {absent ? (
        <div className="rounded-lg border border-dashed px-3 py-2.5" data-testid="budget-account-unknown">
          <p className={UNKNOWN} data-unknown>
            {absent.reason}
          </p>
          {absent.hint ? <p className="mt-1 text-[11px] text-muted-foreground">{absent.hint}</p> : null}
        </div>
      ) : (
        account.limits.map((limit) => <LimitCard key={limit.limitKey} limit={limit} asOf={view.asOf} unsafeAt={view.pressureRule.unsafeAtRatio} heldSeconds={heldSeconds} />)
      )}
    </section>
  );
}

/** The whole view, from one payload and the seconds the page has held it. */
export function BudgetReportView({ view, heldSeconds, onRefresh }: { view: BudgetPayload; heldSeconds: number; onRefresh?: () => void }) {
  const absent = machineAbsentText(view);
  const unsafe = view.accounts.flatMap((account) => account.limits).filter((limit) => limit.pressure.state === "unsafe").length;
  return (
    <div className="space-y-4" data-budget>
      <header className="space-y-1.5">
        <p className="text-[12px] text-muted-foreground">
          Provider limits on this machine: what the provider reported, and apart from it a provisional forecast of the pace. Budget data never
          synchronizes, so every workspace shows the same figures here.
        </p>
        <p className="text-[11px] text-muted-foreground" data-testid="budget-reserve">
          Protected reserve: {reserveText(view.reserve)}.
        </p>
        <p className="text-[11px] text-muted-foreground" data-testid="budget-rule">
          Pressure is the observed pace over the sustainable pace (what is left above the reserve over the time to the reset); unsafe at{" "}
          {pressureRatioText(view.pressureRule.unsafeAtRatio)} or over. Provisional until an admission policy defines it.
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span data-testid="budget-as-of">
            Read at {clockText(view.asOf)}, every {BUDGET_REFRESH_MS / 1000} s. Capture {view.budgetCapture ? "on" : "off"}.
          </span>
          {unsafe > 0 ? (
            <span className="inline-flex items-center gap-1 font-medium text-destructive" data-testid="budget-unsafe-count">
              <AlertTriangle className="size-3.5" aria-hidden />
              {unsafe} unsafe limit{unsafe === 1 ? "" : "s"}
            </span>
          ) : null}
          {onRefresh ? (
            <Button variant="outline" size="xs" className="ml-auto" onClick={onRefresh} data-testid="budget-refresh">
              <RefreshCw aria-hidden />
              Refresh
            </Button>
          ) : null}
        </div>
      </header>
      {absent ? (
        <div className="rounded-lg border border-dashed px-3 py-3" data-testid="budget-none">
          <p className={UNKNOWN} data-unknown>
            {absent.reason}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">{absent.hint}</p>
        </div>
      ) : (
        view.accounts.map((account) => <AccountSection key={`${account.provider}:${account.accountRef}`} account={account} view={view} heldSeconds={heldSeconds} />)
      )}
    </div>
  );
}

/** Seconds since `since` (a `Date.now()`), ticking once a second. */
function useHeldSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

export function BudgetView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const budget = useResource(() => getBudget(), [session.version], onAuthError);
  const { reload } = budget;
  useEffect(() => {
    const timer = window.setInterval(reload, BUDGET_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);
  // The instant the page received this answer, by its own clock: the countdowns tick from it.
  const [received, setReceived] = useState(() => Date.now());
  useEffect(() => setReceived(Date.now()), [budget.data]);
  const heldSeconds = useHeldSeconds(received);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-4">
        {budget.error && !budget.data ? (
          <ErrorState error={budget.error} />
        ) : budget.data ? (
          <>
            {budget.error ? <p className={cn(UNKNOWN, "mb-2")}>The last refresh failed ({budget.error.message}); showing the previous read.</p> : null}
            <BudgetReportView view={budget.data} heldSeconds={heldSeconds} onRefresh={reload} />
          </>
        ) : (
          <LoadingState rows={3} />
        )}
      </div>
    </div>
  );
}
