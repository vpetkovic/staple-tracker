/**
 * ONE RUN: its name and controls, what it is doing now (or how it ended), its numbers, its
 * goal, every ticket it took with how each went, what it takes next, and any instruction
 * that changed under it. Every fact is the payload's, phrased by lib/run-text.ts and
 * ./autopilot-text.ts.
 */
import { Check, ChevronLeft, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { PauseResumeButton, RunStatePill, StopRunButton } from "@/components/autopilot/RunParts";
import { issueOf, RefText, TicketChip } from "@/components/ticket/TicketChip";
import { Button } from "@/components/ui/button";
import { CriterionRow } from "@/detail/MilestoneGoal";
import { attentionLabel, stopAttention } from "@/lib/run-stops";
import { clockText, driverText, durationText, endedStateText, failureReasonText, isLiveRun, stoppedByText } from "@/lib/run-text";
import type { RunEntry, RunTicket } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  endedEyebrow,
  headerPill,
  instructionsLine,
  isRetry,
  isWorking,
  noTicketsText,
  nowEyebrow,
  openTicket,
  outcomeKey,
  outcomeWord,
  runTitle,
  scopeRef,
  scopeWords,
  sentence,
  statTiles,
  takenLine,
  ticketsCount,
  timeOfDay,
  UP_NEXT_SHOWN,
  upNextRows,
} from "./autopilot-text";
import { BlockHeading, RunDot, WorkspacePill } from "./autopilot-parts";

type Open = (ref: string) => void;

const EYEBROW = "m-0 flex items-center gap-2 text-caption font-semibold tracking-[0.02em] text-text-tertiary";

function Header({ entry, showWorkspace, open }: { entry: RunEntry; showWorkspace: boolean; open: Open }) {
  const { run } = entry;
  const live = isLiveRun(run);
  const pill = headerPill(entry);
  const ref = scopeRef(entry);
  return (
    <header className="grid grid-cols-[minmax(0,1fr)] items-start gap-x-4 gap-y-1.5 @min-[900px]/auto:grid-cols-[minmax(0,1fr)_auto]">
      <h2 className="m-0 text-[18px] leading-6 font-semibold tracking-[-0.01em] text-foreground text-pretty wrap-anywhere">{runTitle(entry)}</h2>
      {live ? (
        <div className="order-3 flex flex-wrap gap-2 @min-[900px]/auto:order-none" data-run-controls="">
          <PauseResumeButton entry={entry} className="@max-[900px]/auto:h-10 @max-[900px]/auto:flex-1" />
          <StopRunButton entry={entry} className="@max-[900px]/auto:h-10 @max-[900px]/auto:flex-1" />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-text-secondary @min-[900px]/auto:col-span-full" data-run-meta="">
        <RunStatePill text={pill.text} tone={pill.tone} />
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span>{scopeWords(run)}</span>
          {run.scope.kind === "queue" ? null : (
            <TicketChip issue={issueOf(entry, run.scope.issueId)} fallbackRef={ref ?? "a deleted issue"} onOpen={open} variant="inline" />
          )}
        </span>
        {/* The separator rides with what follows it, so a wrapped line never ends on a dot. */}
        <span className="inline-flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="text-border-strong">
            ·
          </span>
          <span className="min-w-0 wrap-anywhere">run by {run.actor}</span>
        </span>
        {showWorkspace ? <WorkspacePill workspace={entry.workspace} /> : null}
      </div>
    </header>
  );
}

/** Whether a driver is attached and alive; a missing or silent one is a warning, not a fact in passing. */
function DriverLine({ entry }: { entry: RunEntry }) {
  const { driver } = entry;
  const mark = driver === null ? "none" : String(driver.alive);
  if (driver !== null && driver.alive !== false) {
    return (
      <span data-run-driver={mark} className="text-text-secondary">
        {driverText(driver)}
      </span>
    );
  }
  const tone = driver === null ? "tight" : "risk";
  return (
    <span data-run-driver={mark} className="inline-flex items-start gap-1.5" style={{ color: `var(--plain-${tone}-fg)` }}>
      <TriangleAlert aria-hidden className="mt-[3px] size-3.5 shrink-0" />
      <span>
        {driver === null
          ? "No driver attached: the next ticket waits until an agent continues this run."
          : "The driver stopped responding: the run takes nothing until a driver attaches or you stop it."}
      </span>
    </span>
  );
}

function LiveNow({ entry, open, now }: { entry: RunEntry; open: Open; now: Date }) {
  const { run } = entry;
  const eyebrow = nowEyebrow(entry, now);
  const ticket = openTicket(run);
  const tone = headerPill(entry).tone;
  return (
    <section data-run-now="live" aria-label="What it is doing now" className="flex flex-col gap-2.5 rounded-xl border bg-surface-sunken px-4 py-3.5">
      <p className={EYEBROW}>
        <RunDot tone={tone} pulse={isWorking(entry)} />
        <span className="uppercase">{eyebrow.label}</span>
        {eyebrow.detail ? <span className="min-w-0 font-normal text-text-secondary">{eyebrow.detail}</span> : null}
      </p>
      <div className="flex min-w-0">
        {ticket ? (
          <TicketChip issue={issueOf(entry, ticket.issueId)} fallbackRef={ticket.identifier} onOpen={open} variant="lead" />
        ) : (
          <span className="text-title font-semibold text-foreground">Nothing taken yet</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-text-secondary">
        {ticket ? <span>{takenLine(ticket, now)}</span> : null}
        {run.state === "paused" ? <span>It takes nothing until you resume it.</span> : null}
        <DriverLine entry={entry} />
      </div>
    </section>
  );
}

function EndedNow({ entry, open, now }: { entry: RunEntry; open: Open; now: Date }) {
  const { run } = entry;
  const state = endedStateText(run);
  const attention = stopAttention(run);
  const by = stoppedByText(run);
  const toned = state.tone !== "unknown";
  return (
    <section
      data-run-now="ended"
      data-run-tone={state.tone}
      aria-label="How it ended"
      className={cn("flex flex-col gap-2.5 rounded-xl border px-4 py-3.5", !toned && "bg-surface-sunken")}
      style={toned ? { backgroundColor: `var(--plain-${state.tone}-bg)`, borderColor: `var(--plain-${state.tone}-border)` } : undefined}
    >
      <p className={EYEBROW}>
        <span className="uppercase">{endedEyebrow(run, now)}</span>
      </p>
      <p className="m-0 text-title leading-[22px] font-semibold text-foreground text-pretty">
        <RefText text={state.text} issues={entry.issues ?? []} onOpen={open} />
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="m-0 min-w-0 flex-1 basis-56 text-body text-text-secondary" data-run-stop-reason={run.stop?.reason}>
          {by}
          {run.stop?.note ? <span className={cn("text-text-tertiary", by && "ml-1")}>“{run.stop.note}”</span> : null}
        </p>
        {attention ? (
          <Button type="button" size="sm" data-run-attention={attention.action} onClick={() => open(attention.ref)} className="pointer-coarse:h-11">
            {attentionLabel(attention)}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function StatTiles({ entry, now }: { entry: RunEntry; now: Date }) {
  const tiles = statTiles(entry, now);
  return (
    <div data-run-stats="" className="overflow-hidden rounded-xl border">
      <dl className="m-0 -mr-px -mb-px grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] @max-[900px]/auto:grid-cols-2">
        {tiles.map((tile) => (
          <div
            key={tile.key}
            data-run-stat={tile.key}
            className="flex min-w-0 flex-col gap-1 border-r border-b px-4 py-3 @max-[900px]/auto:last:odd:col-span-2"
          >
            <dt className="text-caption text-text-tertiary">{tile.label}</dt>
            <dd className="m-0 text-[20px] leading-6 font-semibold tracking-[-0.01em] text-foreground tabular-nums">
              {tile.value}
              {tile.of ? <small className="text-label font-normal tracking-normal text-text-tertiary">{tile.of}</small> : null}
            </dd>
            {tile.note ? <dd className="m-0 text-label text-text-tertiary">{tile.note}</dd> : null}
            {tile.meter !== undefined ? (
              <dd aria-hidden className="m-0 mt-0.5 h-1 overflow-hidden rounded-sm bg-muted">
                <span className="block h-full rounded-sm bg-foreground" style={{ width: `${Math.round(tile.meter * 100)}%` }} />
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
    </div>
  );
}

function GoalBlock({ entry, now }: { entry: RunEntry; now: Date }) {
  const goal = entry.goal;
  if (!goal) return null;
  const owner = entry.run.goal?.gateOwner;
  const count = `${goal.counts.met} of ${goal.counts.total} criteria met${owner ? ` · approved by ${owner}` : ""}`;
  return (
    <section aria-label="Goal" data-run-goal="">
      <BlockHeading count={count}>Goal</BlockHeading>
      {goal.criteria.length > 0 ? (
        <ul aria-label="Criteria" className="m-0 flex list-none flex-col divide-y rounded-xl border px-3.5 py-0">
          {goal.criteria.map((criterion) => (
            <CriterionRow key={criterion.position} criterion={criterion} workspace={entry.workspace} openRef={goal.milestone.identifier} now={now} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const MARK_STYLE = {
  done: { color: "var(--plain-ok-fg)", backgroundColor: "var(--plain-ok-bg)", boxShadow: "inset 0 0 0 1px var(--plain-ok-border)" },
  failed: { color: "var(--plain-risk-fg)", backgroundColor: "var(--plain-risk-bg)", boxShadow: "inset 0 0 0 1px var(--plain-risk-border)" },
  open: { backgroundColor: "var(--card)", boxShadow: "inset 0 0 0 1.5px var(--status-task-in_progress)" },
} as const;

const OUTCOME_CLASS = {
  done: "text-text-secondary",
  failed: "text-[var(--plain-risk-fg)]",
  open: "text-[var(--status-task-in_progress)]",
} as const;

/** One take: its number, an outcome mark on the line that joins them, the ticket, the outcome in a word, how long, when. */
function TicketRow({ entry, takes, index, open, now }: { entry: RunEntry; takes: readonly RunTicket[]; index: number; open: Open; now: Date }) {
  const ticket = takes[index]!;
  const key = outcomeKey(ticket);
  const retry = isRetry(takes, index);
  const reason = ticket.outcome === "failed" && ticket.reason ? sentence(failureReasonText(ticket.reason)) : null;
  return (
    <li
      data-run-ticket={ticket.identifier}
      data-outcome={key}
      className={cn(
        "relative grid min-h-[38px] items-center gap-x-2.5 border-b px-3.5 last:border-b-0 hover:bg-surface-hover",
        "grid-cols-[22px_18px_minmax(0,1fr)_auto_44px_44px]",
        "@max-[900px]/auto:grid-cols-[18px_minmax(0,1fr)_auto] @max-[900px]/auto:items-start @max-[900px]/auto:px-3 @max-[900px]/auto:py-2",
        // The line joining the marks: from the first mark down to the last.
        "before:absolute before:inset-y-0 before:left-[54.5px] before:w-px before:bg-border first:before:top-1/2 last:before:bottom-1/2 only:before:hidden",
        "@max-[900px]/auto:before:left-[20.5px] @max-[900px]/auto:first:before:top-4 @max-[900px]/auto:last:before:bottom-auto @max-[900px]/auto:last:before:h-4",
      )}
    >
      <span className="text-right text-caption text-text-tertiary tabular-nums @max-[900px]/auto:hidden">{ticket.seq}</span>
      <span
        title={outcomeWord(ticket)}
        className="relative z-[1] inline-flex size-[18px] items-center justify-center rounded-full @max-[900px]/auto:mt-px"
        style={MARK_STYLE[key]}
      >
        {key === "done" ? <Check aria-hidden className="size-3" strokeWidth={2.5} /> : null}
        {key === "failed" ? <X aria-hidden className="size-3" strokeWidth={2.5} /> : null}
        {key === "open" ? <span aria-hidden className="block size-1.5 rounded-full bg-[var(--status-task-in_progress)]" /> : null}
      </span>
      <span className="flex min-w-0 items-center gap-2 @max-[900px]/auto:flex-wrap @max-[900px]/auto:[&_[data-ticket-chip]]:flex-wrap @max-[900px]/auto:[&_[data-ticket-chip]>span:last-child]:basis-full @max-[900px]/auto:[&_[data-ticket-chip]>span:last-child]:whitespace-normal">
        <TicketChip issue={issueOf(entry, ticket.issueId)} fallbackRef={ticket.identifier} onOpen={open} />
        {retry ? (
          <span data-run-retry="" className="shrink-0 rounded-[4px] border px-[5px] text-caption leading-4 text-text-tertiary">
            retry
          </span>
        ) : null}
      </span>
      <span className={cn("text-right text-label whitespace-nowrap @max-[900px]/auto:col-start-2 @max-[900px]/auto:row-start-2 @max-[900px]/auto:text-left", OUTCOME_CLASS[key])}>
        {outcomeWord(ticket)}
      </span>
      <span
        title="How long the run held it"
        className="text-right text-label whitespace-nowrap text-text-tertiary tabular-nums @max-[900px]/auto:col-start-3 @max-[900px]/auto:row-start-1"
      >
        {durationText(ticket.takenAt, ticket.recordedAt, now)}
      </span>
      <time dateTime={ticket.takenAt} title={`Taken ${clockText(ticket.takenAt, now)}`} className="text-right text-label text-text-tertiary tabular-nums @max-[900px]/auto:hidden">
        {timeOfDay(ticket.takenAt)}
      </time>
      {reason ? (
        <p data-run-failure="" className="col-[3/-1] m-0 -mt-1 pb-2 text-label text-[var(--plain-risk-fg)] @max-[900px]/auto:col-[2/-1] @max-[900px]/auto:row-start-3 @max-[900px]/auto:m-0 @max-[900px]/auto:p-0">
          <RefText text={reason} issues={entry.issues ?? []} onOpen={open} />
        </p>
      ) : null}
    </li>
  );
}

function TicketsBlock({ entry, open, now }: { entry: RunEntry; open: Open; now: Date }) {
  const { run } = entry;
  const takes = [...run.tickets].sort((a, b) => a.seq - b.seq);
  return (
    <section aria-label="Tickets">
      <BlockHeading count={takes.length > 0 ? ticketsCount(run) : undefined}>Tickets</BlockHeading>
      {takes.length > 0 ? (
        <ol className="m-0 list-none overflow-hidden rounded-xl border p-0">
          {takes.map((ticket, index) => (
            <TicketRow key={ticket.seq} entry={entry} takes={takes} index={index} open={open} now={now} />
          ))}
        </ol>
      ) : (
        <p className="m-0 text-body text-text-tertiary" data-run-no-tickets="">
          {noTicketsText(entry)}
        </p>
      )}
    </section>
  );
}

function UpNext({ entry, open }: { entry: RunEntry; open: Open }) {
  const [all, setAll] = useState(false);
  if (!entry.facts) return null;
  const { ready, waiting } = upNextRows(entry.facts);
  if (ready.length === 0 && waiting === 0) return null;
  const shown = all ? ready : ready.slice(0, UP_NEXT_SHOWN);
  const more = ready.length - shown.length;
  return (
    <section aria-label="Up next" data-run-next="">
      <BlockHeading count="in pickup order">Up next</BlockHeading>
      <ol className="m-0 list-none overflow-hidden rounded-xl border p-0">
        {shown.map((row, index) => (
          <li key={row.issueId} className="grid min-h-[34px] grid-cols-[22px_minmax(0,1fr)] items-center gap-x-2.5 border-b px-3.5 last:border-b-0 hover:bg-surface-hover @max-[900px]/auto:min-h-10">
            <span className="text-right text-caption text-text-tertiary tabular-nums">{index + 1}</span>
            <span className="flex min-w-0">
              <TicketChip issue={issueOf(entry, row.issueId)} fallbackRef={row.identifier} onOpen={open} />
            </span>
          </li>
        ))}
        {more > 0 || waiting > 0 ? (
          <li className="flex min-h-[34px] flex-wrap items-center gap-x-1 bg-surface-sunken px-3.5 text-label text-text-tertiary">
            {more > 0 ? (
              <button type="button" data-run-next-more="" onClick={() => setAll(true)} className="focus-ring rounded-sm font-medium text-foreground hover:underline pointer-coarse:min-h-11">
                {more} more ready
              </button>
            ) : null}
            {more > 0 && waiting > 0 ? <span aria-hidden>·</span> : null}
            {waiting > 0 ? <span>{waiting} waiting on work others hold</span> : null}
          </li>
        ) : null}
      </ol>
    </section>
  );
}

export function RunDetail({
  entry,
  showWorkspace,
  onOpenTicket,
  onBack,
  now,
}: {
  entry: RunEntry;
  showWorkspace: boolean;
  onOpenTicket: (workspace: string, ref: string) => void;
  /** Back to the list: shown under the page's wide width only. */
  onBack: () => void;
  now: Date;
}) {
  const live = isLiveRun(entry.run);
  const open: Open = (ref) => onOpenTicket(entry.workspace, ref);
  const changed = instructionsLine(entry);
  return (
    <article data-run-detail={entry.run.id} aria-label={runTitle(entry)} className="flex max-w-[920px] flex-col gap-4 px-4 pt-3 pb-8 @min-[900px]/auto:gap-5 @min-[900px]/auto:px-7 @min-[900px]/auto:pt-5 @min-[900px]/auto:pb-10">
      <BackLink onBack={onBack} />
      <Header entry={entry} showWorkspace={showWorkspace} open={open} />
      {live ? <LiveNow entry={entry} open={open} now={now} /> : <EndedNow entry={entry} open={open} now={now} />}
      <StatTiles entry={entry} now={now} />
      <GoalBlock entry={entry} now={now} />
      <div className="flex flex-col gap-2">
        <TicketsBlock entry={entry} open={open} now={now} />
        {changed ? (
          <p className="m-0 text-label text-text-tertiary" data-run-instructions="">
            {changed}
          </p>
        ) : null}
      </div>
      {live ? <UpNext entry={entry} open={open} /> : null}
    </article>
  );
}

/** "‹ All runs": back to the run list, on the one-pane page only (the page's own title already says Autopilot). */
export function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      data-run-back=""
      onClick={onBack}
      className="focus-ring -mb-2 -ml-1.5 inline-flex h-8 items-center gap-1 self-start rounded-md px-1.5 text-body text-text-secondary hover:bg-surface-hover hover:text-foreground pointer-coarse:h-11 @min-[900px]/auto:hidden"
    >
      <ChevronLeft aria-hidden className="size-4" />
      All runs
    </button>
  );
}
