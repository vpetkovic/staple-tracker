/**
 * THE RUN HISTORY — every autopilot run the page knows, newest first: who ran it, over what,
 * how it stands or how it ended and why, when, for how long, and each ticket with how it went.
 *
 * ── WHY A DIALOG FROM THE RAIL, AND NOT A SEVENTH VIEW ────────────────────────────────
 *
 * A run lives in the workspace's database and follows the workspace switch (All workspaces
 * lists every workspace's runs), so it belongs with the workspace in the rail, not under
 * "This computer". The history is the drill-down of the rail's live banner: its "Details"
 * and the section's "Run history" row both open it here, and so do the phone strip and a
 * task's "See the run". A view would have added a seventh tab to the phone's bottom bar,
 * whose six were sized to fit a 360px screen, for a page most people open when a run stops.
 *
 * Every figure is a field of `GET /api/runs`, phrased by lib/run-text.ts; the stop reasons
 * are the tracker's codes in plain words. The live runs sit on top with Stop and Pause.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PHONE_SHEET_CLASS } from "@/components/CreateIssueDialog";
import {
  bannerLine,
  clockText,
  driverText,
  durationText,
  endedStateText,
  isLiveRun,
  liveStateText,
  scopeText,
  stoppedByText,
  ticketOutcomeText,
} from "@/lib/run-text";
import { useRuns } from "@/lib/runs";
import type { RunEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PauseResumeButton, RunStatePill, StopRunButton } from "./RunParts";

const SCOPE_KIND: Record<RunEntry["run"]["scope"]["kind"], string> = {
  queue: "The whole queue",
  issue: "Epic",
  milestone: "Milestone",
};

/** A labelled fact: "Started 09:12". */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-caption text-text-tertiary">{label}</dt>
      <dd className="m-0 truncate text-label text-foreground">{children}</dd>
    </div>
  );
}

export function RunHistoryItem({
  entry,
  showWorkspace,
  highlighted = false,
  onOpenTicket,
  now = new Date(),
}: {
  entry: RunEntry;
  showWorkspace: boolean;
  highlighted?: boolean;
  onOpenTicket?: (workspace: string, ref: string) => void;
  now?: Date;
}) {
  const { run } = entry;
  const live = isLiveRun(run);
  const state = live ? liveStateText(entry) : endedStateText(run);
  const scope = scopeText(run);
  return (
    <li
      data-run-history={run.id}
      data-run-live={live ? "" : undefined}
      className={cn("flex flex-col gap-3 rounded-lg border px-3 py-3", highlighted && "border-border-strong bg-surface-sunken")}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="m-0 min-w-0 truncate text-body font-semibold">
          {SCOPE_KIND[run.scope.kind]}
          {run.scope.kind === "queue" ? null : ` ${scope}`}
        </h3>
        <RunStatePill text={state.text} tone={state.tone} />
        {showWorkspace ? <span className="text-caption text-text-tertiary">{entry.workspace}</span> : null}
      </div>
      {live ? (
        <p className="m-0 text-label text-text-secondary" data-run-line="">
          {bannerLine(entry, now)}
        </p>
      ) : null}
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Fact label="Run by">{run.actor}</Fact>
        <Fact label="Started">{clockText(run.startedAt, now)}</Fact>
        <Fact label={live ? "Running for" : "Took"}>{durationText(run.startedAt, run.endedAt, now)}</Fact>
        {live ? (
          <Fact label="Driver">{driverText(entry.driver)}</Fact>
        ) : (
          <Fact label="Ended">{run.endedAt ? clockText(run.endedAt, now) : "—"}</Fact>
        )}
      </dl>
      {!live && run.stop ? (
        <p className="m-0 text-body text-text-secondary" data-run-stop-reason={run.stop.reason}>
          <span className="font-medium text-foreground">{state.text}.</span>{" "}
          <span>{stoppedByText(run)}</span>
          {run.stop.note ? <span className="text-text-tertiary"> “{run.stop.note}”</span> : null}
        </p>
      ) : null}
      {run.tickets.length > 0 ? (
        <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Tickets">
          {run.tickets.map((ticket) => (
            <li key={ticket.seq} className="flex min-w-0 items-baseline gap-2 text-label" data-run-ticket={ticket.identifier} data-outcome={ticket.outcome ?? "open"}>
              <button
                type="button"
                onClick={() => onOpenTicket?.(entry.workspace, ticket.identifier)}
                className="shrink-0 rounded-sm font-mono text-label text-foreground underline-offset-2 hover:underline focus-ring pointer-coarse:min-h-11"
              >
                {ticket.identifier}
              </button>
              <span className={cn("min-w-0 wrap-anywhere", ticket.outcome === "failed" ? "text-[var(--plain-risk-fg)]" : "text-text-secondary")}>
                {ticketOutcomeText(ticket)}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 text-label text-text-tertiary">No tickets taken.</p>
      )}
      {live ? (
        <div className="flex flex-wrap items-center gap-2">
          <StopRunButton entry={entry} />
          <PauseResumeButton entry={entry} />
        </div>
      ) : null}
    </li>
  );
}

export function RunHistoryList({
  entries,
  showWorkspace,
  focusRunId,
  onOpenTicket,
  now,
}: {
  entries: readonly RunEntry[];
  showWorkspace: boolean;
  focusRunId?: string;
  onOpenTicket?: (workspace: string, ref: string) => void;
  now?: Date;
}) {
  const live = entries.filter((entry) => isLiveRun(entry.run));
  const ended = entries.filter((entry) => !isLiveRun(entry.run));
  if (entries.length === 0) {
    return (
      <p className="m-0 text-body text-text-secondary" data-run-history-empty="">
        No autopilot runs yet. An agent starts one when you ask it to keep working through the queue, an epic or a milestone.
      </p>
    );
  }
  const section = (label: string, rows: readonly RunEntry[], id: string) =>
    rows.length === 0 ? null : (
      <section aria-labelledby={`runs-${id}`} className="flex flex-col gap-2">
        <h2 id={`runs-${id}`} className="m-0 text-label font-medium text-text-tertiary">
          {label}
        </h2>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((entry) => (
            <RunHistoryItem
              key={`${entry.workspace}/${entry.run.id}`}
              entry={entry}
              showWorkspace={showWorkspace}
              highlighted={entry.run.id === focusRunId}
              onOpenTicket={onOpenTicket}
              now={now}
            />
          ))}
        </ul>
      </section>
    );
  return (
    <div className="flex flex-col gap-5">
      {section("Running now", live, "live")}
      {section("Earlier", ended, "ended")}
    </div>
  );
}

export function RunHistoryDialog({
  focusRunId,
  showWorkspace,
  onOpenTicket,
  onOpenChange,
}: {
  focusRunId?: string;
  showWorkspace: boolean;
  onOpenTicket: (workspace: string, ref: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { entries } = useRuns();
  const body = useRef<HTMLDivElement>(null);
  // A banner's Details brings its run into view.
  useEffect(() => {
    if (!focusRunId) return;
    body.current?.querySelector(`[data-run-history="${CSS.escape(focusRunId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusRunId]);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-run-history-dialog className={cn("sm:max-w-2xl md:max-h-[85dvh] md:overflow-y-auto", PHONE_SHEET_CLASS)}>
        <DialogHeader>
          <DialogTitle>Autopilot runs</DialogTitle>
          <DialogDescription className="text-body text-text-secondary">
            Agents working through a scope ticket after ticket. You can stop or pause a run here; only an agent starts one.
          </DialogDescription>
        </DialogHeader>
        <div ref={body}>
          <RunHistoryList entries={entries} showWorkspace={showWorkspace} focusRunId={focusRunId} onOpenTicket={onOpenTicket} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
