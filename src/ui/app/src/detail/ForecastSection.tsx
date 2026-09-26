/**
 * The forecast in the Analytics tab: what is left under this issue, and, apart from it, what that
 * work does to this machine's provider limits.
 *
 * ## Plain first, exact behind "Show details"
 *
 * Each block is a card (components/plain) that opens with ONE headline figure and a
 * plain-language sentence (lib/plain-language.ts), draws the figure as a visual with a text
 * alternative (the likely-range bar, the budget gauge), says its status in a word with an icon,
 * and explains itself under "What does this mean?". Every technical figure the page showed before
 * (quantiles, bands, the chain, confidence achieved, warning chips, reason codes, snapshot ids) is
 * still here, unchanged, behind each card's "Show details".
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
 * Every figure is a field of the payload, rounded and phrased by lib/plain-language.ts or
 * formatted by lib/forecast-text.ts. An unknown figure is "We can't tell yet" with the payload's
 * reason, never a 0; a lower bound says "at least".
 *
 * `ForecastReportView` takes the payload as a prop and reads no context, so the e2e test renders it
 * from the real server's answer; `IssueForecast` is the fetch around it.
 */
import { getForecast } from "@/lib/api";
import { useId, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BudgetGauge } from "@/components/plain/BudgetGauge";
import { PlainCard, ShowDetails } from "@/components/plain/PlainCard";
import { RangeBar } from "@/components/plain/RangeBar";
import { ConfidencePill, StatusPill } from "@/components/plain/StatusPill";
import {
  asOfText,
  breachText,
  confidenceText,
  formatEffort,
  workUseText,
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
  type RemainingText,
} from "@/lib/forecast-text";
import {
  AWAITING_HEADLINE,
  CONFIDENCE_WORDS,
  confidenceHeadline,
  forecastHeadline,
  gaugeDescription,
  leftFigure,
  limitHelp,
  limitName,
  limitSentence,
  limitStatus,
  plainLeft,
  notCountedText,
  pathHeadline,
  plainMissing,
  plainReasons,
  providerName,
  rangeWords,
  unreadableLine,
} from "@/lib/plain-language";
import type { AuthError } from "@/lib/api";
import { useOptionalSession } from "@/lib/session";
import type { BudgetForecast, BudgetLimitForecast, CompletionForecast, ForecastReport, RemainingFigure } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";

const HEADING = "text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase";
/** The placeholder a missing figure wears: the interface face, small, muted, italic. Never a figure. */
const UNKNOWN = "text-[11px] text-muted-foreground italic";

/**
 * Warnings as calm chips. Each chip is a button: hovering or focusing it shows the plain sentence in
 * the app's tooltip, and pressing it (a tap, Enter or Space) opens the same sentence inline under
 * the chips, which is what a touch screen gets. The sentence is also in the button's accessible
 * name, so a screen reader hears it without opening anything.
 */
export function WarningChips({ codes, table, label }: { codes: readonly string[]; table?: Record<string, { label: string; tip: string }>; label: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const tipId = useId();
  if (codes.length === 0) return null;
  const shown = open !== null && codes.includes(open) ? warningText(open, table) : null;
  return (
    <div className="mt-1.5">
      <ul aria-label={label} className="flex flex-wrap gap-1">
        {codes.map((code) => {
          const { label: chip, tip } = warningText(code, table);
          return (
            <li key={code}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-size="xs"
                    data-warning={code}
                    aria-expanded={open === code}
                    aria-controls={tipId}
                    onClick={() => setOpen((current) => (current === code ? null : code))}
                    className={cn(
                      "inline-flex min-h-6 items-center rounded-full border px-2 py-1 text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                      open === code && "text-foreground",
                    )}
                  >
                    {chip}
                    <span className="sr-only">: {tip}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-72">
                  {tip}
                </TooltipContent>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      <p id={tipId} data-testid="warning-tip" className="mt-1 text-[10px] text-muted-foreground" hidden={shown === null}>
        {shown ? `${shown.label}: ${shown.tip}` : null}
      </p>
    </div>
  );
}

/**
 * The technical confidence badge (the budget pressure panel's). Low is marked with a dashed border
 * and the word; colour never carries it alone.
 */
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
  // Never broken across lines: `STA-` on one line and `303` on the next is not an identifier.
  if (!onOpen) return <span className="shrink-0 font-mono whitespace-nowrap">{refId}</span>;
  return (
    // `data-size="xs"`: an inline identifier keeps its text size on a touch screen, where the
    // app's 44px floor would stand it on its own line (theme-tokens.css, coarse pointers).
    <button type="button" data-size="xs" className="shrink-0 font-mono whitespace-nowrap underline-offset-2 hover:underline" onClick={() => onOpen(refId)}>
      {refId}
    </button>
  );
}

/** One remaining figure, the technical way: a label, the value (or its named absence), and its ranges beneath. */
function RemainingRow({ label, text, testId, children }: { label: string; text: RemainingText; testId: string; children?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 py-1 text-[11px]" data-testid={testId}>
      <span className="font-medium">{label}</span>
      <div className="min-w-0 space-y-0.5">
        {text.value === null ? (
          <div className={UNKNOWN} data-unknown>
            {text.absent}
          </div>
        ) : (
          <div>
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

/**
 * The likely-range bar of a remaining figure. ONE range in words (`rangeWords`): the draws'
 * p10–p90 as the strong band, "Most likely between 14 and 19 hours (8 in 10 chances)"; the 90%
 * band (p5–p95) drawn as the pale edge and named only as "rarely beyond …" when that says
 * something new; the expected figure as the marker. Scaled from 0 to a little past the band's
 * upper end so the band never touches the edge. Nothing without draws or an expected figure.
 */
function FigureRange({ figure, testId }: { figure: RemainingFigure; testId: string }) {
  const spread = figure.simulated;
  const words = rangeWords(figure);
  if (!spread || figure.expectedSeconds === null || words === null) return null;
  return (
    <RangeBar
      testId={testId}
      max={Math.max(spread.band.upper, figure.expectedSeconds) * 1.08}
      wide={spread.band}
      likely={{ lower: spread.p10, upper: spread.p90 }}
      marker={figure.expectedSeconds}
      description={words.description}
      legend={[
        { mark: "likely", text: words.likely },
        ...(words.beyond ? [{ mark: "wide" as const, text: upperFirstWord(words.beyond) }] : []),
        { mark: "marker", text: "Expected" },
      ]}
    />
  );
}

const upperFirstWord = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The pill of the work-left card: Done when settled, Unknown when there is no figure, else the confidence. */
function CompletionPill({ completion }: { completion: CompletionForecast }) {
  if (completion.settled) return <StatusPill status="on_track" label="Done" />;
  if (completion.labor.expectedSeconds === null) return <StatusPill status="unknown" />;
  const level = completion.confidence.label;
  return <ConfidencePill level={level} word={CONFIDENCE_WORDS[level]} />;
}

function CompletionBlock({
  completion,
  calibrationSamples,
  mode,
  onOpen,
}: {
  completion: CompletionForecast;
  calibrationSamples: number;
  mode: "full" | "compact";
  onOpen?: (ref: string) => void;
}) {
  const confidence = confidenceText(completion.confidence);
  const labor = remainingText(completion.labor);
  const path = remainingText(completion.path);
  // The unit lists are the full report's: a compact (leaf) forecast is one unit, the issue itself.
  const full = mode === "full";
  const unknown = full ? completion.units.items.filter((unit) => unit.treatment === "forecast" && unit.expected === null) : [];
  const awaiting = full ? completion.units.items.filter((unit) => unit.treatment === "awaiting_review") : [];
  const outside = full ? completion.path.crossSubtreeBlockers.filter((blocker) => !blocker.resolved) : [];
  const chain = completion.path.chain;
  const headline = forecastHeadline(completion, mode);
  const order = pathHeadline(completion.path);

  // The headline already says how many can't be estimated (a lower bound or an unknown figure):
  // "Not counted" does not say it again.
  const headlineSaysUnknown = completion.labor.expectedSeconds === null || (completion.labor.partial && completion.units.unknownRefs.length > 0);
  const notCounted = notCountedText(awaiting.length, headlineSaysUnknown ? 0 : unknown.length);
  // With no figure there is nothing to be sure about: the confidence card is left out, and its
  // technical line and warnings move under the work-left card's details, so none is lost.
  const hasFigure = completion.settled || completion.labor.expectedSeconds !== null;
  const confidenceDetails = (
    <>
      <p className="text-[11px] text-muted-foreground" data-testid="forecast-confidence">
        {confidence.label}: {confidence.achieved}.
        {confidence.reasons.length > 0 ? ` Not high because: ${confidence.reasons.join(", ").toLowerCase()}.` : null}
      </p>
      <WarningChips codes={completion.warnings} label="Forecast warnings" />
    </>
  );

  return (
    <section aria-label="Completion forecast" data-block="completion" className="grid gap-3 @xl:grid-cols-2">
      <PlainCard
        title={full ? "Work left" : "Work left on this task"}
        className="@xl:col-span-2"
        pill={<CompletionPill completion={completion} />}
        figure={headline.figure}
        headline={headline.sentence}
        headlineTestId="forecast-headline"
        help={
          <>
            This is hands-on work time, not a date on the calendar: time waiting for someone, for a review or for other work
            is not in it. The bar starts at zero and shows where the total will most likely land: the strong middle band is
            the likely range (8 in 10 chances), the fainter outer band the wider range (9 in 10), and the upright line is
            the expected figure.
          </>
        }
        detailsTestId="forecast-labor-details"
        details={
          completion.settled ? (
            <p className="text-[11px] text-muted-foreground" data-testid="forecast-settled">
              Every unit is done: nothing is left to forecast.
            </p>
          ) : (
            <>
              <RemainingRow label={full ? "Remaining labor" : "Remaining work"} text={labor} testId="forecast-labor" />
              {awaiting.length > 0 ? (
                <div data-testid="forecast-awaiting">
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
                <div data-testid="forecast-unknown">
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
              {full ? (
                <p className="text-[10px] text-muted-foreground" data-testid="forecast-units">
                  {completion.units.forecast} of {completion.units.total} units forecast ({completion.units.known} known) ·{" "}
                  {completion.units.done} done · {completion.units.awaitingReview} in review
                  {completion.plan.seconds !== null ? ` · the plan's estimates add up to ${formatEffort(completion.plan.seconds)} (a plan, not a forecast)` : null}
                  {completion.units.truncated ? " · units listed up to the limit" : null}
                </p>
              ) : null}
              <p className="text-[10px] text-muted-foreground">
                Effort along the work, not calendar time: waits for an agent, a review or an outside blocker are not in it.
              </p>
              {hasFigure ? null : confidenceDetails}
            </>
          )
        }
      >
        {completion.settled ? null : <FigureRange figure={completion.labor} testId="forecast-range" />}
        {notCounted !== null ? (
          <p className="text-[13px] text-muted-foreground" data-testid="forecast-not-counted">
            {notCounted}
          </p>
        ) : null}
      </PlainCard>

      {full && !completion.settled ? (
        <PlainCard
          title="What has to happen in order"
          figure={order.figure}
          headline={order.sentence}
          headlineTestId="forecast-path-headline"
          help={
            <>
              Some tasks can only start when others finish. This is the longest such chain: even with several people or agents
              working at once, the work can't finish sooner than this.
            </>
          }
          details={
            <RemainingRow label="Critical path" text={path} testId="forecast-path">
              {chain.length > 0 ? (
                <ol aria-label="Critical path chain" className="flex flex-wrap items-center gap-x-1 text-[10px] text-muted-foreground">
                  {chain.map((step, index) => (
                    <li key={step.ref} className="inline-flex items-center gap-1">
                      {index > 0 ? <span aria-hidden>→</span> : null}
                      <RefLink refId={step.ref} onOpen={onOpen} />
                      <span className="whitespace-nowrap tabular-nums">{step.seconds === null ? "unknown" : formatEffort(step.seconds)}</span>
                    </li>
                  ))}
                  {completion.path.chainLength > chain.length ? <li>(the first {chain.length} of {completion.path.chainLength})</li> : null}
                </ol>
              ) : null}
              {outside.length > 0 ? (
                <ul aria-label="Open outside blockers" className="text-[10px] text-muted-foreground" data-testid="forecast-outside">
                  {outside.map((blocker) => (
                    <li key={`${blocker.blocked}:${blocker.blocker}`} className="flex flex-wrap items-center gap-x-1">
                      <RefLink refId={blocker.blocked} onOpen={onOpen} />
                      <span>waits on</span>
                      <RefLink refId={blocker.blocker} onOpen={onOpen} />
                      <span>({blocker.blockerStatus}), outside this subtree: not in the path</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </RemainingRow>
          }
        >
          <FigureRange figure={completion.path} testId="forecast-path-range" />
          {outside.length > 0 ? (
            <p className="text-[13px] text-muted-foreground" data-testid="forecast-outside-plain">
              {outside.length === 1 ? "1 task also waits" : `${outside.length} tasks also wait`} on work outside this, which isn&apos;t counted here.
            </p>
          ) : null}
        </PlainCard>
      ) : null}

      {hasFigure ? (
        <PlainCard
          data-confidence={completion.confidence.label}
          title="How sure we are"
          className={full && !completion.settled ? undefined : "@xl:col-span-2"}
          figure={CONFIDENCE_WORDS[completion.confidence.label]}
          headline={confidenceHeadline(completion.confidence, calibrationSamples)}
          headlineTestId="forecast-confidence-headline"
          help={
            <>
              The forecast learns from how long finished tasks really took compared with their estimates. The more finished tasks
              like these there are, the surer it gets. &ldquo;Quite sure&rdquo;, &ldquo;Fairly sure&rdquo; and &ldquo;Rough
              guess&rdquo; say how much to lean on it.
            </>
          }
          details={confidenceDetails}
        />
      ) : null}
    </section>
  );
}

/** What a limit's projection says, as lines; each unknown with its reason. */
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const sentenceOf = ({ figure, clause }: { figure: string | null; clause: string }): string => (figure === null ? clause : `${figure} ${clause}`);

function LimitLines({ limit }: { limit: BudgetLimitForecast }) {
  const lowerBound = limit.work?.lowerBound ?? false;
  const breach =
    limit.reserve && limit.reserve.breachProbability !== null ? breachText(limit.reserve.breachProbability, lowerBound, reserveLabel(limit.reserve)) : null;
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
          {workUseText(work)}
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
          ) : breach === null ? null : (
            <>
              {breach.figure !== null ? (
                <span className="font-mono tabular-nums" data-testid="budget-breach-figure">
                  {breach.figure}{" "}
                </span>
              ) : null}
              <span className="text-muted-foreground">{breach.figure !== null ? breach.clause : capitalize(breach.clause)}</span>
              {reserve.alreadyBelow ? <span className="text-muted-foreground"> (already below it)</span> : null}
              <span className="text-muted-foreground"> · {reserve.confidence.label} confidence</span>
            </>
          )}
          <div className="text-[10px] text-muted-foreground">
            {reserve.withOtherUse
              ? reserve.withOtherUse.breachProbability === null
                ? "With other use of the account: unknown"
                : `With other use of the account: ${sentenceOf(breachText(reserve.withOtherUse.breachProbability, lowerBound, "it"))}`
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

/**
 * One provider limit as a card: its status word, what is left and when it resets, what this work
 * does to it (the gauge), and the technical lines, unchanged, behind "Show details". Exported for
 * the other budget views to reuse.
 */
export function LimitCard({ limit, asOf, account }: { limit: BudgetLimitForecast; asOf: string; account?: string }) {
  const { status } = limitStatus(limit);
  // The figure says what is left (and how old a stale reading is); the sentence goes on from
  // there (limitHeadline is the whole).
  const sentence = limitSentence(limit);
  return (
    <PlainCard
      data-limit={limit.limitKey}
      title={account ? `${limitName(limit)} · ${account}` : limitName(limit)}
      pill={<StatusPill status={status} />}
      figure={plainLeft(limit) === null ? null : <LeftFigure limit={limit} />}
      headline={sentence.opening === null ? sentence.verdict : `${sentence.reset ? `${sentence.reset} ` : ""}${sentence.verdict}`}
      headlineTestId="budget-headline"
      help={limitHelp(limit)}
      details={<LimitDetails limit={limit} asOf={asOf} />}
    >
      {limit.remainingPercent !== null ? (
        <BudgetGauge
          testId="budget-gauge"
          remaining={limit.remainingPercent}
          after={limit.work ? limit.work.remainingAtResetPercent.expected : null}
          reserve={limit.reserve ? limit.reserve.percent : null}
          lowerBound={limit.work?.lowerBound ?? false}
          description={gaugeDescription(limit)}
        />
      ) : null}
    </PlainCard>
  );
}

/**
 * What is left, as the card's figure; a stale reading's age beside it, smaller, so the number
 * stays the thing read first. The words are `leftFigure`'s ("93% left · 12 min ago").
 */
function LeftFigure({ limit }: { limit: BudgetLimitForecast }) {
  const whole = leftFigure(limit);
  const left = plainLeft(limit);
  if (whole === null || left === null) return null;
  if (whole === left) return <>{left}</>;
  return (
    <>
      {left}
      <span className="text-[15px] font-normal text-muted-foreground" data-testid="budget-age">
        {whole.slice(left.length)}
      </span>
    </>
  );
}

/** A limit's technical rows, exactly as before: key, what is left, the reset, and the projection lines. */
function LimitDetails({ limit, asOf }: { limit: BudgetLimitForecast; asOf: string }) {
  const remaining = limitRemainingText(limit);
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 text-[11px]" data-limit={limit.limitKey}>
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
          {limit.secondsToReset !== null ? ` (${asOfText(asOf)})` : null}
        </div>
      </div>
      <LimitLines limit={limit} />
    </div>
  );
}

/**
 * One account: its everyday name ("Claude (Anthropic)") with the operator's own label beside it,
 * a card per limit that has a reading, and ONE line for the limits that can't be read, whose
 * technical rows (and the raw account reference) are behind the account's Show details.
 */
function AccountBudget({ account, asOf }: { account: BudgetForecast["accounts"][number]; asOf: string }) {
  const names = providerName(account.provider, account.accountRef);
  const readable = account.limits.filter((limit) => limit.remainingPercent !== null);
  const unreadable = account.limits.filter((limit) => limit.remainingPercent === null);
  const line = unreadableLine(unreadable, names.short, readable.length > 0);
  return (
    <div data-account={account.accountRef} className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
        <span className="font-medium">{names.name}</span>
        {names.name !== account.accountRef ? <span className="text-muted-foreground">{account.accountRef}</span> : null}
      </div>
      {account.limits.length === 0 ? (
        <p className="text-[13px]" data-unknown>
          No limits read yet{Object.values(account.missing).length > 0 ? `: ${plainReasons(Object.values(account.missing))}` : ""}.
        </p>
      ) : null}
      {readable.length > 0 ? (
        <div className="grid items-start gap-3 @xl:grid-cols-2">
          {readable.map((limit) => (
            <LimitCard key={limit.limitKey} limit={limit} asOf={asOf} />
          ))}
        </div>
      ) : null}
      {line !== null ? (
        <p className="text-[13px] text-muted-foreground" data-testid="budget-unreadable">
          {line}
        </p>
      ) : null}
      <ShowDetails testId="budget-account-details" label="Show account details">
        <p className="font-mono text-[10px] text-muted-foreground" data-testid="budget-account-ref">
          {account.accountRef}
          {account.provider ? ` · ${account.provider}` : ""}
          {Object.values(account.missing).length > 0 ? ` · ${Object.values(account.missing).map(missingText).join("; ")}` : ""}
        </p>
        {unreadable.map((limit) => (
          <LimitDetails key={limit.limitKey} limit={limit} asOf={asOf} />
        ))}
      </ShowDetails>
    </div>
  );
}

function BudgetBlock({ budget, asOf }: { budget: BudgetForecast; asOf: string }) {
  const reserve = budget.reserve;
  return (
    <section aria-label="Budget forecast" data-block="budget" className="space-y-3 rounded-xl border border-dashed p-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className={HEADING}>Budget</h3>
          <span className="text-[12px] text-muted-foreground" data-testid="budget-subtitle">
            Usage measured on this computer
          </span>
        </div>
        <p className="text-[14px] leading-relaxed" data-testid="budget-intro">
          {budget.accounts.length === 0
            ? `We can't tell yet: ${budget.missing.accounts ? plainMissing(budget.missing.accounts) : "no usage has been measured on this computer"}.`
            : `How this work fits your subscription limits. We aim to keep ${Math.round(reserve.percent)}% of each limit in reserve${
                reserve.source === "provisional_default" ? " (a default until you set one)" : ""
              }.`}
        </p>
      </div>

      {budget.accounts.length === 0 ? null : (
        <div className="space-y-4">
          {budget.accounts.map((account) => (
            <AccountBudget key={`${account.provider}:${account.accountRef}`} account={account} asOf={asOf} />
          ))}
        </div>
      )}

      <ShowDetails testId="budget-details" label="Show reserve details">
        <p className="text-[10px] text-muted-foreground" data-testid="budget-reserve">
          Measured against {reserveLabel(reserve)}
          {reserve.source === "provisional_default" ? " (provisional until an admission policy sets one)" : null}. The work runs serially from
          now. This machine only, apart from the forecast above.
        </p>
        {budget.accounts.length === 0 ? (
          <p className={UNKNOWN} data-unknown data-testid="budget-none">
            No budget forecast: {budget.missing.accounts ? missingText(budget.missing.accounts) : "no accounts"}.
          </p>
        ) : null}
      </ShowDetails>
    </section>
  );
}

/** The snapshot identities, tucked away: a reader who needs to say which data this was can open it. */
function DataDisclosure({ report }: { report: ForecastReport }) {
  return (
    <details className="text-[10px] text-muted-foreground" data-testid="forecast-data">
      <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-md select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        Where these numbers come from
      </summary>
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

/**
 * The whole forecast, from one payload. `@container`: the cards reflow on the width the detail
 * panel gives them (one column in a narrow panel or on a phone, two when there is room), not on
 * the window's width.
 */
export function ForecastReportView({ report, mode, onOpen }: { report: ForecastReport; mode: "full" | "compact"; onOpen?: (ref: string) => void }) {
  return (
    <div className="@container" data-forecast-mode={mode}>
      <div className="space-y-3">
        <h3 className={HEADING}>Forecast</h3>
        <CompletionBlock completion={report.completion} calibrationSamples={report.snapshot.calibration.samples} mode={mode} onOpen={onOpen} />
        <BudgetBlock budget={report.budget} asOf={report.asOf} />
        <DataDisclosure report={report} />
      </div>
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
  mode: "full" | "compact";
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
        <h3 className={cn(HEADING, "mb-1.5")}>Forecast</h3>
        <p className={UNKNOWN}>The forecast could not be read: {forecast.error.message}</p>
      </section>
    );
  }
  if (!forecast.data) {
    return (
      <section aria-label="Completion forecast">
        <h3 className={cn(HEADING, "mb-1.5")}>Forecast</h3>
        <p className="text-[12px] text-muted-foreground">Reading the forecast…</p>
      </section>
    );
  }
  return <ForecastReportView report={forecast.data} mode={mode} onOpen={onOpen} />;
}

/**
 * A leaf in review or awaiting approval: its work was handed over, and what is left is a wait that
 * is not work and is not forecast. One card, and no request.
 */
export function AwaitingForecast() {
  return (
    <section aria-label="Completion forecast" data-forecast-mode="awaiting" className="space-y-3">
      <h3 className={HEADING}>Forecast</h3>
      <PlainCard
        title="Work left on this task"
        pill={<StatusPill status="unknown" label="In review" />}
        headline={AWAITING_HEADLINE}
        headlineTestId="forecast-awaiting-plain"
        details={
          <p className="text-[11px] text-muted-foreground" data-testid="forecast-awaiting-self">
            In review: not forecast. {missingText("not_forecast").replace(/^./, (c) => c.toUpperCase())}.
          </p>
        }
      />
    </section>
  );
}
