/**
 * Estimate vs actual — what the plan said, what it cost, and the gap.
 *
 * The whole payload is already on `IssueDetail` (`timing`, `childrenTiming`),
 * delivered by STA-81, so this tab fetches NOTHING. It renders, and every number
 * it shows came off the server in the same response as the issue itself. That is
 * why it can never disagree with `staple show` or with MCP `get_task`: there is
 * no second implementation of the arithmetic anywhere in the browser.
 *
 * ## No client-side ticking, deliberately
 *
 * A live task's elapsed keeps growing, and it would be easy to run a
 * `setInterval` here and animate it. It is not done, for the same reason the
 * stale-claim badge does not: the server is the only thing that knows the time
 * this feature measures, and a local stopwatch would drift away from every other
 * surface's answer within minutes. Values refresh on the existing fingerprint
 * poll (1.5s). A number that is a second stale and consistent everywhere beats
 * one that is smooth and wrong.
 *
 * ## The arithmetic is not here
 *
 * Every computation and every sentence lives in detail/analytics.ts, which is
 * tested. This file is layout and tokens; AnalyticsTab.test.tsx pins what the
 * layout puts in the DOM, and in what order.
 *
 * ## One headline, then the breakdown (R7b, STA-193)
 *
 * The tab used to open with a card of this issue's own figures and, for a parent,
 * follow it with a second, larger card of its children's — two competing
 * summaries, and "no estimate recorded" set in the typeface and size reserved for
 * the numbers. Now there is ONE summary for leaf and parent alike, led by the
 * recursive plan, and a parent gets a compact "This issue / Children" block
 * beneath it in which every figure names its source. The reading order is the
 * same in the drawer and on the full-screen page because it is one component in
 * one column; nothing here consults the detail mode.
 */
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import {
  NOT_STARTED,
  NO_ESTIMATE,
  activityHint,
  activityState,
  aggregationHint,
  buildBreakdown,
  buildChildRows,
  computeSummary,
  computeTotals,
  explainMissingDelta,
  formatDuration,
  formatOptionalDuration,
  isAggregated,
  isStillRunning,
  summarySentence,
  totalsCaveat,
  type Delta,
} from "../analytics";
import type { TabProps } from "./registry";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase">
      {children}
    </div>
  );
}

/**
 * Over is red, under is green, on-estimate is neutral — borrowed from the status
 * palette rather than invented, so the page never introduces a hue the token
 * sheet does not already name.
 */
function deltaTone(delta: Delta | null): string {
  if (!delta) return "text-muted-foreground";
  if (delta.direction === "over") return "text-[var(--status-task-blocked)]";
  if (delta.direction === "under") return "text-[var(--status-task-done)]";
  return "text-muted-foreground";
}

/** The one class list a real figure wears, so numbers and deltas line up on the same digits. */
const FIGURE = "font-mono text-2xl leading-tight tabular-nums";
/** The one class list a placeholder wears: the interface face, small, muted. */
const PLACEHOLDER = "text-xs text-muted-foreground";

/**
 * A headline slot. A real duration is a large tabular figure; an absence is the
 * placeholder WORD in the normal interface face. The two never share a style,
 * which is the whole of the "giant monospace 'not started'" fix.
 */
function Figure({
  label,
  seconds,
  absent,
  hint,
}: {
  label: string;
  seconds: number | null;
  absent: string;
  hint?: string | null;
}) {
  return (
    <div className="min-w-0">
      <Eyebrow>{label}</Eyebrow>
      {seconds === null ? (
        <div className={PLACEHOLDER}>{absent}</div>
      ) : (
        <div className={FIGURE}>{formatDuration(seconds)}</div>
      )}
      {hint ? <div className="text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** The delta slot: same treatment, and "No comparison" rather than a dash that reads as zero. */
function DeltaFigure({ delta, hint }: { delta: Delta | null; hint?: string | null }) {
  return (
    <div className="min-w-0">
      <Eyebrow>difference</Eyebrow>
      {delta ? (
        <div className={cn(FIGURE, deltaTone(delta))}>{delta.label}</div>
      ) : (
        <div className={PLACEHOLDER}>No comparison</div>
      )}
      {hint ? <div className="text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/**
 * One cell of the breakdown: `est 6h` or `ran 1h50m` as a small tabular figure,
 * or the placeholder word — and, under either, the words that say where the
 * number came from.
 */
function BreakdownCell({
  prefix,
  seconds,
  absent,
  source,
}: {
  prefix: string;
  seconds: number | null;
  absent: string;
  source: string;
}) {
  return (
    <div className="min-w-0">
      {seconds === null ? (
        <div className="text-muted-foreground">{absent}</div>
      ) : (
        <div className="font-mono tabular-nums">
          <span className="text-muted-foreground">{prefix} </span>
          {formatDuration(seconds)}
        </div>
      )}
      <div className="text-[10px] text-muted-foreground">{source}</div>
    </div>
  );
}

/**
 * Each child is TWO LINES, not a row in a six-column table.
 *
 * The first draft was a table — id / title / status / estimate / actual / delta —
 * and the live check killed it immediately: this panel is a ~440px sidebar, not
 * a page. Six fixed columns needed roughly 460px before the title had any room,
 * so the headers collided into "TSTITAET US" and the delta column rendered off
 * the right edge. A table that only works at a width the container never has is
 * not a narrow-screen bug, it is the wrong shape.
 *
 * Two lines per child fits, and it also removes the header row entirely: each
 * value is labelled in place (`est 3h · ran 1h50m`), so there is nothing left to
 * misalign. The delta — the number the reader actually came for — gets the top
 * right corner, where the eye lands.
 */
function ChildLine({
  left,
  right,
  rightTone,
  muted,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  rightTone?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("min-w-0 flex-1 truncate", muted && "text-muted-foreground")}>{left}</span>
      <span className={cn("shrink-0 font-mono tabular-nums", rightTone)}>{right}</span>
    </div>
  );
}

/**
 * `est 3h · ran 1h50m`, with absences named rather than drawn as zeros.
 *
 * `est` is the child's EFFECTIVE plan (R7c, STA-194): STA-157 under STA-156 reads
 * `est 11h`, the figure its parent counts it as, not the `—` of its own empty
 * field. Where that plan came from is the `title` on the figure — a tooltip, not
 * a third line, so a child stays two lines whatever its provenance.
 */
function Pair({ planned, planHint, actual }: { planned: number | null; planHint: string | null; actual: number | null }) {
  return (
    <>
      <span title={planHint ?? undefined} data-testid="child-plan">
        est {formatOptionalDuration(planned, "—")}
      </span>
      {` · ran ${formatOptionalDuration(actual, "—")}`}
    </>
  );
}

export function AnalyticsTab({ detail }: TabProps) {
  const { issue, timing, childrenTiming, children } = detail;

  /**
   * `activeSeconds` is the HEADLINE actual, and for a parent it is already the
   * children's aggregate — so the summary never renders an epic's own stopwatch.
   * That is the whole of VP's second complaint: the epic STA-79 auto-flipped had
   * an own-elapsed here that ticked forever with nobody working it.
   */
  const summary = computeSummary(timing);
  const aggregated = isAggregated(timing);
  const running = isStillRunning(issue.status);
  const activity = activityState(timing.countedThrough);
  const rows = buildChildRows(children, childrenTiming);
  const totals = computeTotals(timing, rows);
  const breakdown = buildBreakdown(timing);

  /**
   * The caveats, in one muted block under the headline: why there is no delta,
   * what the parent's totals leave out, whether the number is approximate, and
   * time spent in review. Each is one sentence; none is a figure.
   */
  const caveats: string[] = [];
  if (!summary.delta) caveats.push(explainMissingDelta(summary.plannedSeconds, summary.actualSeconds));
  const caveat = aggregated ? totalsCaveat(totals) : null;
  if (caveat) caveats.push(caveat);
  if (timing.approximate) {
    caveats.push("Approximate — no usable history, so the time is completed-minus-started rather than a sum of intervals.");
  }
  // Review is a queue, not execution — named, but never counted as active time.
  if (timing.reviewSeconds) {
    caveats.push(`${formatDuration(timing.reviewSeconds)} in review, not counted as active time.`);
  }

  /**
   * Three different sentences, and never "still running" over a frozen
   * number: a parent says where its figure came from, a live leaf says
   * it is moving, a stalled leaf says how long ago it stopped.
   */
  const actualHint = aggregated ? aggregationHint(timing.childCount) : activityHint(activity);
  const differenceHint = summary.delta && running ? "provisional — not finished" : null;

  return (
    <div className="space-y-4 text-sm">
      {/* ----------------------------------------------------------- headline */}
      <section aria-label="Summary">
        {/*
          R7c (STA-194). The spoken headline: planned, actual, difference, coverage,
          source — one sentence, in that order, from the same numbers the figures
          show. The figure row beneath is `aria-hidden` so a screen reader hears
          the facts once and in this order rather than walking three cells whose
          hints put the source before the actual. Sighted readers see the figures;
          nothing is said here that is not also drawn.
        */}
        <p className="sr-only" data-testid="summary-sentence">
          {summarySentence(summary, timing.subtreePlan, { actual: actualHint, difference: differenceHint })}
        </p>
        <div
          className="flex flex-wrap items-end gap-x-8 gap-y-3 rounded-md border bg-muted/40 px-4 py-3"
          aria-hidden="true"
        >
          <Figure
            label="planned"
            seconds={summary.plannedSeconds}
            absent={NO_ESTIMATE}
            hint={summary.planHint}
          />
          <Figure label="actual" seconds={summary.actualSeconds} absent={NOT_STARTED} hint={actualHint} />
          <DeltaFigure delta={summary.delta} hint={differenceHint} />
        </div>
        {caveats.length > 0 ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">{caveats.join(" ")}</p>
        ) : null}
      </section>

      {/* ---------------------------------------------- own versus children */}
      {breakdown.length > 0 ? (
        <section aria-label="Breakdown">
          <h3 className="mb-1.5 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase">
            This issue vs children
          </h3>
          <div className="divide-y border-t border-b">
            {breakdown.map((row) => (
              <div
                key={row.label}
                className="grid grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 py-2 text-[11px]"
              >
                <span className="font-medium">{row.label}</span>
                <BreakdownCell prefix="est" seconds={row.plannedSeconds} absent={NO_ESTIMATE} source={row.planSource} />
                <BreakdownCell prefix="ran" seconds={row.actualSeconds} absent={NOT_STARTED} source={row.actualSource} />
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            The planned figure above is this issue&apos;s own estimate when one is set, otherwise
            the children&apos;s — the two are alternatives, never added together.
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------- per child */}
      {rows.length > 0 ? (
        <section aria-label="Per child">
          <h3 className="mb-1.5 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase">
            Per child
          </h3>

          <div className="divide-y border-t border-b">
            {rows.map((row) => (
              <div key={row.identifier} className="space-y-0.5 py-2 text-[11px]">
                <ChildLine
                  left={
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{row.identifier}</span>
                      <StatusBadge status={row.status} />
                    </span>
                  }
                  right={
                    <>
                      {row.delta ? row.delta.label : "—"}
                      {/*
                        An unfinished child's delta is a snapshot, not a verdict —
                        but WHY it is unfinished matters, so the marker
                        distinguishes a clock that is still being fed from one
                        that stopped. Same glyph budget, two different facts.
                      */}
                      {row.delta && row.running ? (
                        <span
                          className="text-muted-foreground"
                          title={
                            row.activity.kind === "running"
                              ? "still running"
                              : "unfinished, but idle — the clock has stopped"
                          }
                        >
                          {row.activity.kind === "running" ? " *" : " ‡"}
                        </span>
                      ) : null}
                    </>
                  }
                  rightTone={deltaTone(row.delta)}
                />
                <ChildLine
                  muted
                  left={<span title={row.title}>{row.title}</span>}
                  right={<Pair planned={row.plannedSeconds} planHint={row.planHint} actual={row.actualSeconds} />}
                  rightTone="text-muted-foreground"
                />
              </div>
            ))}
          </div>

          {totals.runningCount > 0 ? (
            <p className="mt-2 text-[10px] text-muted-foreground">
              * still running — the actual is still growing, so the delta is provisional.
            </p>
          ) : null}
          {totals.idleCount > 0 ? (
            <p className="mt-2 text-[10px] text-muted-foreground">
              ‡ unfinished but idle — the clock stopped at the last sign of work, so this
              number is frozen rather than growing.
            </p>
          ) : null}

          <p className="mt-2 text-[10px] text-muted-foreground">
            A child that is itself a parent shows its own aggregate. The children&apos;s plan
            above looks all the way down: each issue counts its own estimate if it has one,
            otherwise its children&apos;s — never both.
          </p>
        </section>
      ) : null}
    </div>
  );
}
