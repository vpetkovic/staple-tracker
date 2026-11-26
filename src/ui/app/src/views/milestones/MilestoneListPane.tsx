/**
 * INTERIM: the milestone list as the old two-pane page drew it, kept for All workspaces only
 * (`AllWorkspacesMilestones.tsx`) until that page becomes the read-only outline. The workspace
 * page no longer uses it. Moved here unchanged from `MilestonesView.tsx`.
 */
import { Milestone, Plus } from "lucide-react";
import { StatusIcon } from "@/components/task-list";
import { useRowPlan } from "@/components/task-list/useRowPlan";
import { EmptyState as PlainEmptyState } from "@/components/plain/States";
import { Button } from "@/components/ui/button";
import { MILESTONE_KIND } from "@/detail/plain-actions";
import { statusCategory, statusLabel } from "@/lib/settings";
import { openCreateIssue } from "@/lib/shell-events";
import type { EffectiveQueueRow, MilestoneListRow, MilestoneState, MilestoneView as MilestoneViewData } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ProgressStrip } from "@/views/ProgressStrip";
import { EmptyState } from "@/views/ViewChrome";
import { dueText, progressSegments, progressSentence, projectedDue, riskSentence, shownState } from "./milestone-plain";
import { dateLabel, isFinishedMilestone, milestoneRisk, nextWorkLabel, progressLabel, STATE_PRESENTATION } from "./milestones-model";
import "./milestones-desk.css";

/** The desktop page, from the shell's desk breakpoint up. The phone keeps the page as it shipped. */
export function useMilestonesDesk(): boolean {
  return useRowPlan().layout === "line";
}

/**
 * The milestone's STATUS, as the task detail and the Tasks list show any status: the same
 * glyph, the same word, the same hue. It is the stored status, which the store derives from
 * the members, so this page and the Tasks list give one answer about the same milestone.
 */
export function MilestoneStatusPill({ status }: { status: string }) {
  return (
    <span
      data-milestone-status={status}
      data-status-category={statusCategory(status)}
      className="status-chip inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-label font-medium whitespace-nowrap"
    >
      <StatusIcon status={status} className="size-3.5" />
      {statusLabel(status)}
    </span>
  );
}

// ---------- small pieces ----------

/** Glyph AND word, never colour alone. `data-milestone-state` is what a stylesheet or a test keys on. */
export function StateBadge({ state, complete = false }: { state: MilestoneState; complete?: boolean }) {
  const { glyph, label } = STATE_PRESENTATION[state];
  return (
    <span
      data-milestone-state={state}
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium"
    >
      <span aria-hidden className="font-mono">
        {glyph}
      </span>
      {label}
      {complete && state !== "done" ? <span className="text-muted-foreground">· all members done</span> : null}
    </span>
  );
}

/**
 * The phone card's risk line: the overdue mark, then the same sentence the desk card and the
 * page say (`riskSentence`), so "blocked" is one number on every surface.
 */
function RiskLine({
  row,
  effective,
}: {
  row: Pick<MilestoneViewData, "milestone" | "progress">;
  effective: readonly EffectiveQueueRow[];
}) {
  const risk = milestoneRisk(row, effective);
  const sentence = riskSentence(row.progress, effective.length > 0 ? risk : null);
  const labels = [...(risk.overdue ? ["! overdue"] : []), ...(sentence ? [`⊘ ${sentence}`] : [])];
  if (labels.length === 0) return null;
  return (
    <span data-milestone-risk className="flex flex-wrap gap-x-2 text-[11px] font-medium">
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </span>
  );
}

function ProgressBar({ row }: { row: Pick<MilestoneViewData, "progress"> }) {
  const { progress } = row;
  const percent = progress.percent ?? 0;
  return (
    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-hover"
      >
        <span className="block h-full bg-foreground" style={{ width: `${percent}%` }} />
      </span>
      {progressLabel(progress)}
    </span>
  );
}

function NextWork({ next }: { next: MilestoneViewData["next"] }) {
  return (
    <span data-milestone-next={next ? "queued" : "none"} className={cn("text-[11px]", !next && "text-text-tertiary")}>
      {nextWorkLabel(next)}
    </span>
  );
}

// ---------- the list ----------

export function MilestoneListPane({
  rows,
  effective = [],
  hiddenFinished = 0,
  onShowFinished,
  selectedRef,
  onSelect,
  desk = false,
}: {
  rows: readonly MilestoneListRow[];
  /** Finished milestones the Done toggle is hiding, so an empty list can say they exist. */
  hiddenFinished?: number;
  /** Show them: lifts the same Done toggle the header shows. */
  onShowFinished?: () => void;
  /** The queue's effective rows, which is where blocked and gated are counted from. */
  effective?: readonly EffectiveQueueRow[];
  selectedRef: string | null;
  onSelect: (identifier: string) => void;
  /** The desktop cards: plain due dates, a progress bar with its sentence. */
  desk?: boolean;
}) {
  if (rows.length === 0 && hiddenFinished > 0) {
    // Nothing open, but finished ones exist: say so, and offer them, rather than a blank page.
    return (
      <div data-milestone-empty="finished-hidden">
        <PlainEmptyState compact icon={Milestone} title="No open milestones">
          {hiddenFinished === 1 ? "1 milestone is finished" : `All ${hiddenFinished} milestones are finished`} and hidden while Done is hidden.
        </PlainEmptyState>
        {onShowFinished ? (
          <div className="mt-3 flex justify-center">
            <Button variant="outline" size="sm" onClick={onShowFinished} data-show-finished="">
              Show finished milestones
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  if (desk && rows.length === 0) {
    return (
      <div data-milestone-empty="none">
        <PlainEmptyState compact icon={Milestone} title="No milestones here yet">
          A milestone gathers tasks that should be finished by a date. Create one with New task and the Milestone kind, or ask an agent to.
        </PlainEmptyState>
        <div className="mt-3 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => openCreateIssue({ kind: MILESTONE_KIND })} data-create-milestone="">
            <Plus aria-hidden />
            New task
          </Button>
        </div>
      </div>
    );
  }
  if (desk) {
    const now = new Date();
    return (
      <ul aria-label="Milestones" data-milestone-list data-desk="" className="flex flex-col gap-2">
        {rows.map((row) => {
          const selected = row.milestone.identifier === selectedRef;
          const riskFacts = effective.length > 0 ? milestoneRisk(row, effective) : null;
          const risk = riskSentence(row.progress, riskFacts);
          return (
            <li key={row.milestone.identifier}>
              <button
                type="button"
                data-milestone-row={row.milestone.identifier}
                data-milestone-finished={isFinishedMilestone(row.milestone.state) ? "" : undefined}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(row.milestone.identifier)}
                className={cn(
                  "staple-milestone-card flex w-full flex-col gap-2 rounded-xl border bg-card px-3.5 py-3 text-left outline-hidden",
                  "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring",
                  selected && "border-ring",
                )}
              >
                <span className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-reading font-medium">{row.milestone.title}</span>
                  <MilestoneStatusPill status={row.milestone.status} />
                </span>
                <span
                  data-milestone-target
                  className={cn(
                    "text-label text-muted-foreground",
                    shownState(row.milestone, now) === "overdue" && "text-[var(--plain-risk-fg)]",
                  )}
                >
                  {dueText(row.milestone, projectedDue(row.remaining, now), now)}
                </span>
                <ProgressStrip compact label={progressSentence(row.progress)} segments={progressSegments(row.progress, riskFacts)} />
                <span className="flex flex-wrap items-baseline gap-x-2 text-label text-muted-foreground">
                  <span data-milestone-progress-sentence className="text-foreground">
                    {progressSentence(row.progress)}
                  </span>
                  {risk ? <span data-milestone-risk>{risk}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  if (rows.length === 0) {
    return (
      <div data-milestone-empty="none">
        <EmptyState>
          No milestones here yet. A milestone gathers tasks that should be finished by a date; create one with New task and the
          Milestone kind, or ask an agent to.
        </EmptyState>
      </div>
    );
  }
  return (
    <ul aria-label="Milestones" data-milestone-list className="flex flex-col gap-1">
      {rows.map((row) => {
        const selected = row.milestone.identifier === selectedRef;
        return (
          <li key={row.milestone.identifier}>
            <button
              type="button"
              data-milestone-row={row.milestone.identifier}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(row.milestone.identifier)}
              className={cn(
                "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left outline-hidden",
                "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring",
                selected ? "border-ring bg-surface-hover" : "border-transparent",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-text-tertiary">{row.milestone.identifier}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{row.milestone.title}</span>
                <StateBadge state={shownState(row.milestone, new Date())} complete={row.progress.complete} />
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span data-milestone-target>target {dateLabel(row.milestone.targetDate)}</span>
                <span>
                  {row.memberCount} {row.memberCount === 1 ? "member" : "members"}
                </span>
                {row.milestone.planPosition !== null ? <span>plan #{row.milestone.planPosition}</span> : null}
              </span>
              <ProgressBar row={row} />
              <RiskLine row={row} effective={effective} />
              <NextWork next={row.next} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

