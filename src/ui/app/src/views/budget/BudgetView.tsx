/**
 * The Budget destination: this machine's provider limits and each one's session pressure, as
 * `staple budget` reads them (docs/execution-telemetry.md, "Pressure"; docs/web-ui.md, "Budget").
 *
 * ## The machine's, not a workspace's
 *
 * Budget readings live in this machine's hub and never synchronize, so the view takes no `ws` and
 * reads the same whichever workspace the switcher names. The rail lists it in its own Machine group.
 *
 * ## Plain first, exact behind "Show details"
 *
 * Each limit with a current reading is a plain card (components/plain): the status word with an
 * icon (`pressureStatus`: the store's provisional state — unsafe is At risk, within is On track,
 * no state is Unknown), what is left as the figure (with its age when stale), a sentence with the
 * reset and the verdict, and two frames, MEASURED (solid: the gauge with the reserve line, the
 * observed pace, the reading's age) and FORECAST (dashed, "an early rule of thumb until a budget
 * policy is set"). Accounts are named for people; limits with no current window collapse into one
 * line per account. Everything the panel showed before — the technical header, badge and the two
 * blocks below — is under each card's (or account's) Show details, unchanged.
 *
 * ## Measured apart from forecast
 *
 * Each limit's technical blocks never share a figure. MEASURED (a solid frame): what
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
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw } from "lucide-react";
import { AuthError, getBudget } from "@/lib/api";
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
import type { BudgetAccountView, BudgetLimitReading, BudgetView as BudgetPayload } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ConfidenceBadge, WarningChips } from "@/detail/ForecastSection";
import { BudgetGauge } from "@/components/plain/BudgetGauge";
import { PlainCard, ShowDetails } from "@/components/plain/PlainCard";
import { StatusPill } from "@/components/plain/StatusPill";
import {
  PROVISIONAL_WORDS,
  boundText,
  budgetAbsentPlain,
  forecastLine,
  limitName,
  measuredLine,
  plainAge,
  pressureSentence,
  pressureStatus,
  providerName,
  readingGaugeDescription,
  unreadableLine,
} from "@/lib/plain-language";
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
function PressureBadge({ tone, word, provisional }: { tone: PressureTone; word: string; provisional: boolean }) {
  const Icon = TONE_ICON[tone];
  return (
    <span
      data-pressure-badge={tone}
      title={provisional ? `${word}, by the provisional pressure rule` : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        tone === "unsafe" && "border-destructive text-destructive",
        tone === "within" && "text-muted-foreground",
        tone === "unknown" && "border-dashed text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {word}
      {provisional ? <span className="sr-only"> (provisional)</span> : null}
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
            <>
              <span className="font-mono text-[15px] font-medium tabular-nums">{percentText(limit.remainingPercent!)}</span>
              <span className="text-[12px]"> left</span>
            </>
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
              <span className="text-[11px] text-muted-foreground"> keeps {percentText(pressure.reservePercent)} at the reset</span>
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

/** The technical header and blocks of a limit, exactly as the panel drew them: behind Show details. */
function LimitTechnical({ limit, asOf, unsafeAt, heldSeconds }: { limit: BudgetLimitReading; asOf: string; unsafeAt: number; heldSeconds: number }) {
  const state = pressureStateText(limit.pressure, unsafeAt);
  return (
    <div className="space-y-2" data-limit-technical={limit.limitKey}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate font-mono text-[12px] font-medium" title={limit.limitKey}>
          {limit.limitKey}
        </span>
        {limit.window?.label ? <span className="text-[11px] text-muted-foreground">{limit.window.label}</span> : null}
        <span className="ml-auto" />
        <PressureBadge tone={state.tone} word={state.word} provisional={state.tone !== "unknown"} />
      </header>
      <p className={cn("text-[11px]", state.tone === "unsafe" ? "text-destructive" : "text-muted-foreground")} data-testid="budget-state-detail">
        {state.tone === "unknown" ? `${state.word}: ${state.detail}` : `${state.word} (provisional): ${state.detail}`}
      </p>
      <div className="grid gap-2 @2xl:grid-cols-2">
        <MeasuredBlock limit={limit} heldSeconds={heldSeconds} />
        <ForecastBlock limit={limit} asOf={asOf} />
      </div>
    </div>
  );
}

/** A limit with no current window, the technical way: the one line that says why. */
function NoWindowTechnical({ limit }: { limit: BudgetLimitReading }) {
  const noWindow = noWindowText(limit);
  if (!noWindow) return null;
  return (
    <div data-limit={limit.limitKey} data-testid="budget-no-window">
      <p className={UNKNOWN} data-unknown>
        {noWindow.reason}
      </p>
      {noWindow.hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{noWindow.hint}</p> : null}
    </div>
  );
}

/**
 * One limit with a current reading, as a plain card: its status word (`pressureStatus`, the
 * store's provisional state, said as such), what is left, the verdict, and two frames that never
 * share a figure — MEASURED (solid: the gauge with the reserve line, the observed pace, the
 * reading's age) and FORECAST (dashed: an early rule of thumb until a budget policy is set). The
 * panel's technical header and blocks are behind Show details, unchanged.
 */
function LimitCard({ limit, asOf, unsafeAt, heldSeconds }: { limit: BudgetLimitReading; asOf: string; unsafeAt: number; heldSeconds: number }) {
  const state = pressureStateText(limit.pressure, unsafeAt);
  const { status } = pressureStatus(limit);
  const { pressure } = limit;
  const reset = pressure.secondsToReset !== null ? tickSeconds(pressure.secondsToReset, heldSeconds, "down") : null;
  const age = pressure.lastReadingAgeSeconds !== null ? tickSeconds(pressure.lastReadingAgeSeconds, heldSeconds, "up") : null;
  const remaining = limit.remainingPercent!;
  return (
    <PlainCard
      data-limit={limit.limitKey}
      data-pressure-state={state.tone}
      title={limitName({ limitKey: limit.limitKey, windowSeconds: limit.window?.windowSeconds ?? null })}
      className={cn("relative overflow-hidden", state.tone === "unsafe" && "border-destructive")}
      pill={<StatusPill status={status} />}
      figure={
        <>
          {Math.round(remaining)}% left
          {limit.stale && age !== null ? (
            <span className="text-[15px] font-normal text-muted-foreground" data-testid="budget-age">
              {" "}
              · {plainAge(age)} ago
            </span>
          ) : null}
        </>
      }
      headline={pressureSentence(limit, reset)}
      headlineTestId="budget-headline"
      help={
        <>
          Your subscription allows a certain amount of use in each window, then resets. The bar is that allowance: blue is what is
          left, grey is already used, and the dashed line is the safety reserve we try not to dip into. &ldquo;Measured&rdquo; is
          what the provider reported; &ldquo;Forecast&rdquo; is what your recent pace suggests, {PROVISIONAL_WORDS}.
        </>
      }
      details={<LimitTechnical limit={limit} asOf={asOf} unsafeAt={unsafeAt} heldSeconds={heldSeconds} />}
    >
      {state.tone === "unsafe" ? <span aria-hidden data-unsafe-hatch className="absolute inset-y-0 left-0 w-1.5" style={UNSAFE_HATCH} /> : null}
      <div className="grid items-start gap-2 @2xl:grid-cols-2">
        <section aria-label="Measured" data-plain-block="measured" className="min-w-0 space-y-2 rounded-lg border px-3 py-2.5">
          <h4 className={EYEBROW}>Measured</h4>
          <BudgetGauge
            testId="budget-gauge"
            remaining={remaining}
            after={null}
            reserve={pressure.reservePercent}
            lowerBound={false}
            description={readingGaugeDescription(remaining, pressure.reservePercent)}
          />
          <p className="text-[13px]" data-testid="budget-measured-line">
            {measuredLine(limit, age)}
          </p>
        </section>
        <section aria-label="Forecast" data-plain-block="forecast" className="min-w-0 space-y-1.5 rounded-lg border border-dashed px-3 py-2.5">
          <h4 className={EYEBROW}>
            Forecast <span className="normal-case tracking-normal">· {PROVISIONAL_WORDS}</span>
          </h4>
          <p className="text-[13px]" data-testid="budget-forecast-line">
            {forecastLine(limit)}
          </p>
        </section>
      </div>
    </PlainCard>
  );
}

function AccountSection({ account, view, heldSeconds }: { account: BudgetAccountView; view: BudgetPayload; heldSeconds: number }) {
  const absent = account.limits.length === 0 ? accountAbsentText(account, view.budgetCapture) : null;
  const names = providerName(account.provider, account.accountRef);
  const readable = account.limits.filter((limit) => limit.status === "current" && limit.remainingPercent !== null);
  const unreadable = account.limits.filter((limit) => !(limit.status === "current" && limit.remainingPercent !== null));
  const line = unreadableLine(unreadable, names.short, readable.length > 0);
  return (
    <section aria-label={`Account ${account.accountRef}`} data-account={account.accountRef} className="space-y-2">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-[14px] font-medium">
        <span>{names.name}</span>
        {names.name !== account.accountRef ? <span className="text-[12px] font-normal text-muted-foreground break-all">{account.accountRef}</span> : null}
        <span className="text-[12px] font-normal text-muted-foreground" data-bound={account.bound ? "yes" : "no"}>
          {boundText(account.bound)}
        </span>
      </h2>
      {absent ? (
        <p className="text-[14px]" data-testid="budget-account-plain">
          {budgetAbsentPlain(account.missing.limits, view.budgetCapture, account.bound)}
        </p>
      ) : null}
      {readable.length > 0 ? (
        <div className="grid items-start gap-3">
          {readable.map((limit) => (
            <LimitCard key={limit.limitKey} limit={limit} asOf={view.asOf} unsafeAt={view.pressureRule.unsafeAtRatio} heldSeconds={heldSeconds} />
          ))}
        </div>
      ) : null}
      {line !== null ? (
        <p className="text-[13px] text-muted-foreground" data-testid="budget-unreadable">
          {line}
        </p>
      ) : null}
      <ShowDetails label="Show account details">
        <p className="font-mono text-[10px] text-muted-foreground">
          {account.accountRef}
          {account.provider ? ` · ${account.provider}` : ""} · {account.bound ? "bound on this machine" : "not bound on this machine"}
        </p>
        {absent ? (
          <div data-testid="budget-account-unknown">
            <p className={UNKNOWN} data-unknown>
              {absent.reason}
            </p>
            {absent.hint ? <p className="mt-1 text-[11px] text-muted-foreground">{absent.hint}</p> : null}
          </div>
        ) : null}
        {unreadable.map((limit) => (
          <NoWindowTechnical key={limit.limitKey} limit={limit} />
        ))}
      </ShowDetails>
    </section>
  );
}

/** The whole view, from one payload and the seconds the page has held it. */
export function BudgetReportView({ view, heldSeconds, onRefresh }: { view: BudgetPayload; heldSeconds: number; onRefresh?: () => void }) {
  const absent = machineAbsentText(view);
  const unsafe = view.accounts.flatMap((account) => account.limits).filter((limit) => limit.pressure.state === "unsafe").length;
  return (
    <div className="@container space-y-5" data-budget>
      <header className="space-y-2">
        <p className="text-[15px] leading-relaxed" data-testid="budget-intro">
          {absent
            ? "We can't tell yet: budget tracking isn't collecting anything on this computer."
            : `Your subscription limits on this computer, and whether your recent pace keeps a safety reserve of ${Math.round(view.reserve.percent * 10) / 10}%${
                view.reserve.source === "provisional_default" ? " (a default until you set one)" : ""
              }. The pace check is ${PROVISIONAL_WORDS}.`}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {unsafe > 0 ? <StatusPill status="at_risk" label={`${unsafe} limit${unsafe === 1 ? "" : "s"} at risk`} /> : null}
          <span>Updated {clockText(view.asOf)}</span>
          {onRefresh ? (
            <Button variant="outline" size="xs" className="ml-auto" onClick={onRefresh} data-testid="budget-refresh">
              <RefreshCw aria-hidden />
              Refresh
            </Button>
          ) : null}
        </div>
        <ShowDetails label="Show rule details">
          <p className="text-[11px] text-muted-foreground" data-testid="budget-reserve">
            Protected reserve: {reserveText(view.reserve)}.
          </p>
          <p className="text-[11px] text-muted-foreground" data-testid="budget-rule">
            Pressure is the observed pace over the sustainable pace (what is left above the reserve over the time to the reset); unsafe at{" "}
            {pressureRatioText(view.pressureRule.unsafeAtRatio)} or over. Provisional until an admission policy defines it.
          </p>
          <p className="text-[11px] text-muted-foreground" data-testid="budget-as-of">
            Read at {clockText(view.asOf)}, every {BUDGET_REFRESH_MS / 1000} s. Capture {view.budgetCapture ? "on" : "off"}.
            {unsafe > 0 ? <span data-testid="budget-unsafe-count"> {unsafe} unsafe limit{unsafe === 1 ? "" : "s"}.</span> : null}
          </p>
        </ShowDetails>
      </header>
      {absent ? (
        <div className="space-y-2 rounded-xl border border-dashed p-4">
          <p className="text-[14px]" data-testid="budget-none-plain">
            {budgetAbsentPlain(undefined, view.budgetCapture, false)}
          </p>
          <ShowDetails>
            <div data-testid="budget-none">
              <p className={UNKNOWN} data-unknown>
                {absent.reason}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">{absent.hint}</p>
            </div>
          </ShowDetails>
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
  return Math.max(0, Math.floor((Math.max(now, since) - since) / 1000));
}

/** One read and the instant the page received it, set together so a countdown never ticks from the previous answer's clock. */
interface Held {
  readonly view: BudgetPayload;
  readonly receivedAt: number;
}

/**
 * The budget, re-read every {@link BUDGET_REFRESH_MS} while the page is visible and at once when
 * it becomes visible again. Budget readings live in the hub, not in a workspace, so the page's
 * workspace fingerprint says nothing about them and is not a reason to re-read.
 */
function useLiveBudget(onAuthError: (error: AuthError) => void): { held: Held | null; error: Error | null; reload: () => void } {
  const [held, setHeld] = useState<Held | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;
  const alive = useRef(true);
  const reload = useCallback(() => {
    getBudget()
      .then((view) => {
        if (!alive.current) return;
        setHeld({ view, receivedAt: Date.now() });
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!alive.current) return;
        if (caught instanceof AuthError) authRef.current(caught);
        else setError(caught instanceof Error ? caught : new Error(String(caught)));
      });
  }, []);
  useEffect(() => {
    alive.current = true;
    reload();
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, BUDGET_REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);
  return { held, error, reload };
}

export function BudgetView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const { held, error, reload } = useLiveBudget(onAuthError);
  const heldSeconds = useHeldSeconds(held?.receivedAt ?? 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-4">
        {error && !held ? (
          <ErrorState error={error} />
        ) : held ? (
          <>
            {error ? <p className={cn(UNKNOWN, "mb-2")}>The last refresh failed ({error.message}); showing the previous read.</p> : null}
            <BudgetReportView view={held.view} heldSeconds={heldSeconds} onRefresh={reload} />
          </>
        ) : (
          <LoadingState rows={3} />
        )}
      </div>
    </div>
  );
}
