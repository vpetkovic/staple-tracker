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
 * ## Plain words, no figures in mono
 *
 * The tab is called "Time" now, and it reads like a sentence: "Planned 6 hours ·
 * 4 minutes so far", a bar that fills as the actual approaches the plan, and the
 * difference said as what it means ("5 hours 56 minutes left in the plan") rather
 * than as `5h56m under (99%)`. The words are as precise as the old figures
 * (`spokenDuration` keeps formatDuration's two units); only the voice changed.
 * The spoken summary for screen readers is unchanged and still comes first.
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
import { Clock } from "lucide-react";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import { getTimingQuality } from "@/lib/api";
import { forecastMode } from "@/lib/forecast-text";
import { statusCategory, statusLabel } from "@/lib/settings";
import { useResource } from "@/lib/useStaple";
import {
  childQualityText,
  cohortLine,
  qualityText,
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
  isAggregated,
  isStillRunning,
  plainDelta,
  shortDelta,
  spokenDuration,
  summarySentence,
  totalsCaveat,
  type Delta,
} from "../analytics";
import { AwaitingForecast, IssueForecast } from "../ForecastSection";
import { SectionHeading, cn } from "../parts";
import type { TabProps } from "./registry";
import "./tabs.css";

/**
 * Over is red, under is green, on-plan is neutral — borrowed from the status
 * palette rather than invented, so the page never introduces a hue the token
 * sheet does not already name.
 */
function deltaTone(delta: Delta | null): string {
  if (!delta) return "text-text-secondary";
  if (delta.direction === "over") return "text-[var(--status-task-blocked)]";
  if (delta.direction === "under") return "text-[var(--status-task-done)]";
  return "text-text-secondary";
}

/** The one class list a real duration wears: the interface face, weighted. */
const FIGURE = "font-semibold text-foreground";
/** The one class list a placeholder wears: the interface face, regular, secondary. */
const PLACEHOLDER = "font-normal text-text-secondary";

/**
 * A duration in the headline sentence, or the placeholder WORD in its place. The
 * two never share a style, which is the whole of the "giant 'not started'" fix.
 */
function Figure({ name, seconds, absent }: { name: string; seconds: number | null; absent: string }) {
  return seconds === null ? (
    <span data-figure={name} className={PLACEHOLDER}>
      {absent}
    </span>
  ) : (
    <span data-figure={name} className={FIGURE}>
      {spokenDuration(seconds)}
    </span>
  );
}

/**
 * The bar under the headline: how much of the plan the actual has used. Full and
 * red past the plan; absent when either side is missing, because a bar needs both
 * ends to mean anything.
 */
function PlanBar({ planned, actual }: { planned: number | null; actual: number | null }) {
  if (planned === null || actual === null || planned <= 0) return null;
  const share = actual / planned;
  return (
    <span className="block h-2 overflow-hidden rounded-full bg-surface-sunken" data-plan-bar="">
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none",
          share > 1 ? "bg-[var(--status-task-blocked)]" : "bg-[var(--status-task-done)]",
        )}
        style={{ width: `${Math.max(Math.min(share, 1) * 100, actual > 0 ? 1.5 : 0)}%` }}
      />
    </span>
  );
}

/** One side of the "this task / its sub-tasks" comparison: a plan and an actual, in words, with their sources. */
function BreakdownCell({
  verb,
  seconds,
  absent,
  source,
}: {
  verb: string;
  seconds: number | null;
  absent: string;
  source: string;
}) {
  return (
    <div className="min-w-0">
      {seconds === null ? (
        <div className="text-text-secondary">{absent}</div>
      ) : (
        <div className="text-foreground">
          <span className="text-text-secondary">{verb} </span>
          {spokenDuration(seconds)}
        </div>
      )}
      <div className="text-caption text-text-tertiary">{source}</div>
    </div>
  );
}

/**
 * Each sub-task is TWO LINES, not a row in a six-column table: this panel is a
 * ~440px sidebar and a phone, not a page. The first line is the task and the
 * difference (where the eye lands); the second is the plan and the time spent,
 * each labelled in place so there is no header row to misalign.
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
    // On a phone the title takes the whole first line and the figure drops beneath it,
    // rather than both being cut to a few characters each.
    <div className="flex items-center gap-2 max-sm:flex-wrap max-sm:gap-y-0.5">
      <span className={cn("min-w-0 flex-1 truncate max-sm:basis-full", muted && "text-text-secondary")}>{left}</span>
      <span className={cn("shrink-0 tabular-nums max-sm:pl-5.5", rightTone)}>{right}</span>
    </div>
  );
}

/**
 * `Planned 3 hours · 1 hour 50 minutes spent`, with absences named rather than drawn
 * as zeros. The plan is the child's EFFECTIVE plan (R7c, STA-194) — the figure its
 * parent counts it as — and where that plan came from is the `title` on it, a tooltip
 * rather than a third line.
 */
function Pair({ planned, planHint, actual }: { planned: number | null; planHint: string | null; actual: number | null }) {
  return (
    <>
      <span title={planHint ?? undefined} data-testid="child-plan">
        {planned === null ? "No plan" : `Planned ${spokenDuration(planned)}`}
      </span>
      {actual === null ? " · not started" : ` · ${spokenDuration(actual)} spent`}
    </>
  );
}

/**
 * How far each figure can be trusted: the work state (replicated, the ratio's actual) and the
 * elapsed state (this device's history), each one word and its reasons. Small and muted: it
 * qualifies the figures above, it is not a figure.
 */
function QualityRow({ label, text, testId }: { label: string; text: string | null; testId: string }) {
  if (text === null) return null;
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 px-3.5 py-2 text-label">
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-text-secondary" data-testid={testId}>
        {text}
      </span>
    </div>
  );
}

export function AnalyticsTab({ detail, workspace, onAuthError }: TabProps) {
  const { issue, timing, childrenTiming, children } = detail;

  /**
   * `activeSeconds` is the HEADLINE actual, and for a parent it is already the
   * children's aggregate — so the summary never renders an epic's own stopwatch.
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
    caveats.push(`${spokenDuration(timing.reviewSeconds)} in review, not counted as active time.`);
  }

  /**
   * Three different sentences, and never "still running" over a frozen
   * number: a parent says where its figure came from, a live leaf says
   * it is moving, a stalled leaf says how long ago it stopped.
   */
  const actualHint = aggregated ? aggregationHint(timing.childCount) : activityHint(activity);
  const differenceHint = summary.delta && running ? "provisional — not finished" : null;

  /**
   * A parent's cohort: the done leaves beneath it, counted by state over that eligible
   * population (`staple timing quality --parent`). One small read, refreshed with the page;
   * a leaf asks for nothing.
   */
  const cohort = useResource(
    () => (aggregated ? getTimingQuality({ ws: workspace, parent: issue.identifier, limit: 1 }) : Promise.resolve(null)),
    [aggregated, workspace, issue.identifier],
    onAuthError,
  );
  // The work figure beside its state: the ratio's actual, from attempts, which the headline's
  // category time is not.
  const workState = qualityText(timing.quality?.work);
  const workQuality = workState === null ? null : timing.workSeconds === null ? workState : `${spokenDuration(timing.workSeconds)} · ${workState}`;
  const wallQuality = qualityText(timing.quality?.wall);
  const beneath = cohort.data ? cohortLine(cohort.data) : null;

  /**
   * The forecast (docs/web-ui.md, "Analytics"): what is left and what it costs a provider limit,
   * from `GET /api/forecast`. After the headline and its breakdown, before the per-child list,
   * which can be long. Full for an open parent, compact for an open leaf with its own estimate,
   * one line for a leaf in review, absent otherwise.
   */
  const mode = forecastMode({ childCount: timing.childCount, estimatedSeconds: issue.estimatedSeconds, category: statusCategory(issue.status) });

  /** "so far" while the clock can still move, "took" once the work is finished. */
  const actualTense = running ? "so far" : null;

  return (
    <div className="w-full max-w-readable space-y-6 text-body">
      {/* ----------------------------------------------------------- headline */}
      <section aria-label="Summary">
        {/*
          R7c (STA-194). The spoken headline: planned, actual, difference, coverage,
          source — one sentence, in that order, from the same numbers the figures
          show. The visual card beneath is `aria-hidden` so a screen reader hears
          the facts once and in this order. Nothing is said here that is not also drawn.
        */}
        <p className="sr-only" data-testid="summary-sentence">
          {summarySentence(summary, timing.subtreePlan, { actual: actualHint, difference: differenceHint })}
        </p>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-xl border border-border bg-surface-raised p-4 sm:p-5" aria-hidden="true">
          <div className="w-full min-w-0 space-y-3">
            {/* Each half is kept on one line, so a narrow screen breaks at the dot, not mid-phrase. */}
            <p className="flex items-start gap-2.5 text-title text-text-secondary sm:text-heading">
              <Clock aria-hidden className="mt-0.5 size-4.5 shrink-0 text-text-tertiary sm:mt-1" />
              <span className="min-w-0">
                <span className="whitespace-nowrap">
                  {summary.plannedSeconds !== null ? "Planned " : null}
                  <Figure name="planned" seconds={summary.plannedSeconds} absent={NO_ESTIMATE} />
                </span>
                <span className="text-text-tertiary"> · </span>
                <span className="whitespace-nowrap">
                  {summary.actualSeconds !== null && !actualTense ? "took " : null}
                  <Figure name="actual" seconds={summary.actualSeconds} absent={NOT_STARTED} />
                  {summary.actualSeconds !== null && actualTense ? ` ${actualTense}` : null}
                </span>
              </span>
            </p>
            <PlanBar planned={summary.plannedSeconds} actual={summary.actualSeconds} />
            {summary.delta ? (
              <p data-figure="difference" className={cn("text-reading font-medium", deltaTone(summary.delta))}>
                {plainDelta(summary.delta, running)}
              </p>
            ) : null}
            {summary.plannedSeconds === null && summary.actualSeconds === null ? (
              <p className="text-body text-pretty text-text-secondary" data-testid="time-empty">
                Nothing to compare yet. Give the task an estimate when you plan it, and the time spent on it will
                be measured against that here.
              </p>
            ) : null}
            {summary.planHint || actualHint ? (
              <p className="text-label text-text-secondary">
                {[summary.planHint, actualHint]
                  .filter((hint): hint is string => Boolean(hint))
                  .map((hint) => hint.charAt(0).toUpperCase() + hint.slice(1))
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        </div>
        {caveats.length > 0 ? (
          <p className="mt-2 text-label text-pretty text-text-secondary">{caveats.join(" ")}</p>
        ) : null}
      </section>

      {/* ---------------------------------------------- own versus children */}
      {breakdown.length > 0 ? (
        <section aria-label="Breakdown">
          <SectionHeading>This task and its sub-tasks</SectionHeading>
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-raised">
            {breakdown.map((row) => (
              <div
                key={row.label}
                className="grid grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 px-3.5 py-2.5 text-label max-sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
              >
                <span className="font-medium text-foreground max-sm:col-span-2">{row.label}</span>
                <BreakdownCell verb="Planned" seconds={row.plannedSeconds} absent={NO_ESTIMATE} source={row.planSource} />
                <BreakdownCell verb="Worked" seconds={row.actualSeconds} absent={NOT_STARTED} source={row.actualSource} />
              </div>
            ))}
          </div>
          <p className="mt-2 text-label text-text-secondary">
            The plan above is this task&apos;s own estimate when one is set, otherwise its sub-tasks&apos;
            — the two are alternatives, never added together.
          </p>
        </section>
      ) : null}

      {/* -------------------------------------------------------- forecast */}
      {mode === "awaiting" ? <AwaitingForecast /> : null}
      {mode === "full" || mode === "compact" ? (
        <IssueForecast
          workspace={workspace}
          refId={issue.identifier}
          mode={mode}
          onAuthError={onAuthError}
        />
      ) : null}

      {/* ------------------------------------------------------- per child */}
      {rows.length > 0 ? (
        <section aria-label="Per child">
          <SectionHeading>Sub-tasks</SectionHeading>

          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-raised">
            {rows.map((row) => (
              <div key={row.identifier} data-child={row.identifier} title={`${row.identifier} · ${row.title}`} className="space-y-0.5 px-3.5 py-2.5 text-label">
                <ChildLine
                  left={
                    <span className="flex min-w-0 items-center gap-2">
                      <StatusIcon status={row.status} className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate text-body text-foreground">{row.title}</span>
                    </span>
                  }
                  right={
                    <>
                      {row.delta ? shortDelta(row.delta) : <span className="text-text-tertiary">no comparison</span>}
                      {/*
                        An unfinished child's delta is a snapshot, not a verdict — and WHY
                        it is unfinished matters: a clock still being fed, or one that stopped.
                      */}
                      {row.delta && row.running ? (
                        <span className="text-text-tertiary" data-child-activity={row.activity.kind}>
                          {row.activity.kind === "running" ? " so far" : " · stalled"}
                        </span>
                      ) : null}
                    </>
                  }
                  rightTone={deltaTone(row.delta)}
                />
                <ChildLine
                  muted
                  left={
                    <span className="pl-5.5">
                      <Pair planned={row.plannedSeconds} planHint={row.planHint} actual={row.actualSeconds} />
                    </span>
                  }
                  right={
                    <span className="flex items-center gap-2 max-sm:hidden">
                      {childQualityText(row) !== null ? (
                        <span className="text-caption text-text-tertiary" data-testid="child-quality">
                          {childQualityText(row)}
                        </span>
                      ) : null}
                      <span className="text-caption">{statusLabel(row.status)}</span>
                    </span>
                  }
                  rightTone="text-text-secondary"
                />
              </div>
            ))}
          </div>

          {totals.runningCount > 0 ? (
            <p className="mt-2 text-label text-text-secondary">
              &ldquo;So far&rdquo; means the sub-task is still running, so its difference can still change.
            </p>
          ) : null}
          {totals.idleCount > 0 ? (
            <p className="mt-2 text-label text-text-secondary">
              &ldquo;Stalled&rdquo; means the sub-task is unfinished but idle: its clock stopped at the last sign of
              work, so the number is frozen rather than growing.
            </p>
          ) : null}

          <p className="mt-2 text-label text-text-secondary">
            A sub-task with sub-tasks of its own shows their total. Each task counts its own estimate if it has
            one, otherwise its sub-tasks&apos; — never both.
          </p>
        </section>
      ) : null}

      {/* ----------------------------------------------------------- quality */}
      {workQuality !== null || wallQuality !== null || beneath !== null ? (
        <section aria-label="Measurement quality">
          <SectionHeading>How exact these numbers are</SectionHeading>
          {workQuality !== null || wallQuality !== null ? (
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-raised">
            <QualityRow label="Work" text={workQuality} testId="quality-work" />
            <QualityRow label="Elapsed" text={wallQuality} testId="quality-wall" />
          </div>
          ) : null}
          {beneath !== null ? (
            <p className="mt-2 text-label text-text-secondary" data-testid="quality-cohort">
              {beneath}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
