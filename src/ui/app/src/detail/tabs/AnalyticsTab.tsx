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
 * tested. There are no component tests in this repo, so logic inside a `.tsx` is
 * logic nothing checks — this file is layout and tokens only.
 */
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import {
  NOT_STARTED,
  NO_ESTIMATE,
  activityHint,
  activityState,
  aggregationHint,
  buildChildRows,
  computeDelta,
  computeTotals,
  explainMissingDelta,
  formatOptionalDuration,
  headline,
  isAggregated,
  isStillRunning,
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

function Figure({
  label,
  value,
  hint,
  strong,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <Eyebrow>{label}</Eyebrow>
      <div
        className={cn(
          "font-mono tabular-nums",
          strong ? "text-2xl leading-tight" : "text-sm",
          tone,
        )}
      >
        {value}
      </div>
      {hint ? <div className="text-[10px] text-muted-foreground">{hint}</div> : null}
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

/** `est 3h · ran 1h50m`, with absences named rather than drawn as zeros. */
function pair(estimate: number | null, actual: number | null): string {
  return `est ${formatOptionalDuration(estimate, "—")} · ran ${formatOptionalDuration(actual, "—")}`;
}

export function AnalyticsTab({ detail }: TabProps) {
  const { issue, timing, childrenTiming, children } = detail;

  /**
   * `activeSeconds` is the HEADLINE actual, and for a parent it is already the
   * children's aggregate — so this card never renders an epic's own stopwatch.
   * That is the whole of VP's second complaint: the epic STA-79 auto-flipped had
   * an own-elapsed here that ticked forever with nobody working it.
   */
  const ownDelta = computeDelta(timing.estimatedSeconds, timing.activeSeconds);
  const aggregated = isAggregated(timing);
  const running = isStillRunning(issue.status);
  const activity = activityState(timing.countedThrough);
  const rows = buildChildRows(children, childrenTiming);
  const totals = computeTotals(timing, rows);
  const caveat = totalsCaveat(totals);

  return (
    <div className="space-y-4 text-sm">
      {/* ---------------------------------------------------------- task view */}
      <section>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3 rounded-md border bg-muted/40 px-4 py-3">
          <Figure
            label="estimate"
            value={formatOptionalDuration(timing.estimatedSeconds, NO_ESTIMATE)}
            hint={timing.estimatedSeconds === null ? "set one with --estimate at plan time" : undefined}
          />
          <Figure
            label={aggregated ? "actual (children)" : "actual"}
            value={formatOptionalDuration(timing.activeSeconds, NOT_STARTED)}
            /**
             * Three different sentences, and never "still running" over a frozen
             * number: a parent says where its figure came from, a live leaf says
             * it is moving, a stalled leaf says how long ago it stopped.
             */
            hint={
              aggregated
                ? aggregationHint(timing.childCount)
                : (activityHint(activity) ?? undefined)
            }
          />
          {/* Review is a queue, not execution — its own slot, only when nonzero. */}
          {timing.reviewSeconds ? (
            <Figure
              label="in review"
              value={formatOptionalDuration(timing.reviewSeconds, NOT_STARTED)}
              hint="not counted as active time"
            />
          ) : null}
          <Figure
            label="delta"
            value={ownDelta ? ownDelta.label : "—"}
            tone={deltaTone(ownDelta)}
            hint={
              ownDelta && running
                ? "provisional — this task has not finished"
                : undefined
            }
          />
        </div>
        {/* The honest sentence, whenever there is no delta to show. */}
        {ownDelta ? null : (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {explainMissingDelta(timing.estimatedSeconds, timing.activeSeconds)}
          </p>
        )}
        {/* A number with a weaker provenance has to say so in its own column. */}
        {timing.approximate ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            approx — no usable history for this issue, so the time is
            completed-minus-started rather than a sum of intervals.
          </p>
        ) : null}
        {/* The epic's own time, when it genuinely has some, kept out of the headline. */}
        {aggregated && timing.ownActiveSeconds ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            This issue was itself worked for {formatOptionalDuration(timing.ownActiveSeconds, "—")},
            which is not part of the total above.
          </p>
        ) : null}
      </section>

      {/* -------------------------------------------------- parent / epic view */}
      {rows.length > 0 ? (
        <section>
          <div className="mt-4 mb-2 flex flex-wrap items-end gap-x-8 gap-y-3 rounded-md border bg-muted/40 px-4 py-3">
            {/* The headline figure: the whole reason this tab exists. */}
            <Figure
              strong
              label="estimated total"
              value={formatOptionalDuration(totals.estimatedSeconds, NO_ESTIMATE)}
              hint={`${totals.estimatedCount} of ${totals.childCount} estimated`}
            />
            <Figure
              strong
              label="actual total"
              value={formatOptionalDuration(totals.actualSeconds, NOT_STARTED)}
              hint={aggregationHint(totals.childCount)}
            />
            <Figure
              strong
              label="difference"
              value={totals.delta ? totals.delta.label : "—"}
              tone={deltaTone(totals.delta)}
            />
          </div>

          <p className="text-[13px]">{headline(totals)}</p>
          {caveat ? (
            <p className="mt-1 text-[11px] text-muted-foreground">{caveat}</p>
          ) : null}

          <h3 className="mt-4 mb-1.5 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase">
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
                  right={pair(row.estimatedSeconds, row.actualSeconds)}
                  rightTone="text-muted-foreground"
                />
              </div>
            ))}

            {/* Totals, from the server's own sums — never re-added in the browser. */}
            <div className="space-y-0.5 py-2 text-[11px] font-medium">
              <ChildLine
                left="total"
                right={totals.delta ? totals.delta.label : "—"}
                rightTone={deltaTone(totals.delta)}
              />
              <ChildLine
                muted
                left={`${totals.childCount} direct ${totals.childCount === 1 ? "child" : "children"}`}
                right={pair(totals.estimatedSeconds, totals.actualSeconds)}
                rightTone="text-muted-foreground"
              />
            </div>
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
            Totals sum the DIRECT children listed above, so the column adds up. A child
            that is itself a parent contributes its own aggregate, which is the number its
            row shows.
          </p>
        </section>
      ) : null}
    </div>
  );
}
