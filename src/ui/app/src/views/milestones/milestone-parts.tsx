/**
 * The pieces the Milestones outline draws a milestone with, in the Plan view's vocabulary: a
 * state glyph, filled flags for what needs attention, one bar with the server's percent, the
 * goal with its criteria, the fold chevron, the Add work line and the status submenu. Every
 * count, percent, verdict and sentence is the server's or `milestone-plain.ts`'s.
 *
 * Control sizes: a control keeps its desk look at every width. Under 760px of the page
 * container its tap grows to at least 32px through an invisible inset (`TAP_*`), never a
 * bigger box.
 */
import { Check, ChevronDown, ChevronRight, Plus, ShieldCheck } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { RunStatePill } from "@/components/autopilot/RunParts";
import { StatusIcon } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { statusEntries } from "@/detail/action-controller";
import { contextOf, type IssueActionsController } from "@/detail/IssueActions";
import { ClearedMarks, CriterionRow } from "@/detail/MilestoneGoal";
import { ACTION_WORDS, overflowItems, statusItems } from "@/detail/plain-actions";
import { ShippedCheck } from "@/detail/ShippedMark";
import { PACE_TONE, PACE_WORDS, paceText, shownPace, unplannedText } from "@/lib/goal-text";
import { statusCategory, statusLabel } from "@/lib/settings";
import type { EffectiveQueueRow, IssueDetail, MilestoneListRow, MilestoneState, MilestoneSummary, MilestoneView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ProgressStrip } from "@/views/ProgressStrip";
import { Flag } from "@/views/plan/plan-parts";
import { cancelledSentence, nextSentence, progressSegments, progressSentence, riskSentence, shownState, waitBreakdown } from "./milestone-plain";
import { isFinishedMilestone, milestoneRisk } from "./milestones-model";

type SummaryRow = Pick<MilestoneListRow, "milestone" | "progress" | "next">;

/** A 20px icon control: a 32px tap under 760px. */
export const TAP_20 = "relative @max-[760px]/ms:before:absolute @max-[760px]/ms:before:-inset-1.5 @max-[760px]/ms:before:content-['']";
/** A 28px icon control: a 36px tap at every width (a work row's `⋯`, the section's `⋯`). */
export const TAP_28 = "relative before:absolute before:-inset-1 before:content-['']";
/** A 28px text button: a 32px tap under 760px. */
export const TAP_TEXT = "relative h-7 @max-[760px]/ms:before:absolute @max-[760px]/ms:before:-inset-y-0.5 @max-[760px]/ms:before:inset-x-0 @max-[760px]/ms:before:content-['']";

/** The milestone's state as a 14px picture: a ring filled to the server's percent, red once overdue, the check when done, a dotted struck ring when cancelled. */
export function MilestoneGlyph({ state, percent, className }: { state: MilestoneState; percent: number | null; className?: string }) {
  if (state === "done") return <ShippedCheck label="" className={cn("size-3.5 [&_svg]:size-2.5", className)} />;
  const ring = { cx: 7, cy: 7, r: 6, fill: "none", stroke: "currentColor", strokeWidth: 1.6 };
  const share = Math.max(0, Math.min(0.999, (percent ?? 0) / 100));
  const angle = share * 2 * Math.PI;
  const x = (7 + 3.6 * Math.sin(angle)).toFixed(2);
  const y = (7 - 3.6 * Math.cos(angle)).toFixed(2);
  const tone = state === "overdue" ? "text-flag-late" : state === "cancelled" ? "text-text-tertiary" : share > 0 ? "text-[color:var(--status-task-icon-in_progress)]" : "text-text-secondary";
  return (
    <span aria-hidden="true" data-milestone-glyph={state} className={cn("inline-flex size-3.5 shrink-0", tone, className)}>
      <svg viewBox="0 0 14 14" className="size-full">
        <circle {...ring} strokeDasharray={state === "cancelled" ? "1.2 2.6" : undefined} strokeLinecap="round" />
        {state === "cancelled" ? <path d="M3.5 10.5 10.5 3.5" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /> : null}
        {state !== "cancelled" && share > 0 ? <path d={`M7 7 L7 3.4 A3.6 3.6 0 ${share > 0.5 ? 1 : 0} 1 ${x} ${y} Z`} fill="currentColor" /> : null}
      </svg>
    </span>
  );
}

/** What needs attention, as the Plan view flags it: waiting for approval, blocked, behind. Overdue is the red date and glyph, not a flag. Null when nothing does. */
export function MilestoneFlags({ row, effective, now, goal }: { row: SummaryRow; effective: readonly EffectiveQueueRow[]; now: Date; goal?: MilestoneView["goal"] }) {
  const risk = effective.length > 0 ? milestoneRisk(row, effective, now) : null;
  const blocked = waitBreakdown(row.progress, risk).blocked;
  const state = shownState(row.milestone, now);
  const flags: ReactNode[] = [];
  if (row.milestone.status === "awaiting_approval") flags.push(<Flag key="gate" tone="you" data-milestone-flag="approval">Waiting for your approval</Flag>);
  if (blocked > 0 && !isFinishedMilestone(state)) flags.push(<Flag key="blocked" tone="notStarted" data-milestone-flag="blocked">{blocked} blocked</Flag>);
  if (goal && goal.pace.verdict === "behind") flags.push(<Flag key="behind" tone="late" data-milestone-flag="behind">behind</Flag>);
  if (flags.length === 0) return null;
  return <span className="inline-flex flex-wrap items-center gap-1.5">{flags}</span>;
}

/** The status bar and the server's percent beside it. `lg`: the section header's 8px bar. */
export function MilestoneBar({ row, effective, size = "sm", className }: { row: SummaryRow; effective: readonly EffectiveQueueRow[]; size?: "sm" | "lg"; className?: string }) {
  const risk = effective.length > 0 ? milestoneRisk(row, effective) : null;
  const percent = row.progress.percent;
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)} data-milestone-bar="">
      <div className={cn("min-w-0 flex-1", size === "lg" && "[&_.staple-progress-bar]:h-2")}>
        <ProgressStrip compact label={progressSentence(row.progress)} segments={progressSegments(row.progress, risk)} />
      </div>
      {percent !== null ? <span className={cn("shrink-0 tabular-nums", size === "lg" ? "text-label font-semibold text-foreground" : "text-caption text-text-tertiary")}>{percent}%</span> : null}
    </div>
  );
}

/** "Queued #1" when the milestone has its own row in the pickup queue. */
export function QueuedMark({ position, className }: { position: number | null; className?: string }) {
  if (position === null) return null;
  return (
    <span className={cn("shrink-0 rounded-full border px-1.5 py-px text-caption leading-tight text-text-secondary", className)} data-milestone-queued={position}>
      Queued #{position}
    </span>
  );
}

/**
 * The header's third line: how much is finished, then what blocks it, what is not counted and
 * what is next, each in `milestone-plain.ts`'s words.
 */
export function milestoneFacts(row: SummaryRow, effective: readonly EffectiveQueueRow[], now: Date): string {
  const { progress } = row;
  const tasks = `${progress.countable} ${progress.countable === 1 ? "task" : "tasks"}`;
  const done = progress.countable === 0 ? "No tasks to count yet." : progress.complete ? `All ${tasks} finished.` : `${progress.counts.done} of ${tasks} finished.`;
  const risk = effective.length > 0 ? milestoneRisk(row, effective, now) : null;
  return [done, riskSentence(progress, risk), cancelledSentence(progress), nextSentence(row.next)].filter(Boolean).join(" ");
}

/** The Goal line starts open when judging is the job: the milestone waits for approval, or all of its work is finished and it is not closed. */
export function goalStartsOpen(row: { milestone: Pick<MilestoneSummary, "status" | "state">; progress: Pick<MilestoneView["progress"], "complete"> }): boolean {
  if (isFinishedMilestone(row.milestone.state)) return false;
  return row.milestone.status === "awaiting_approval" || row.progress.complete;
}

/** The goal's own summary, short enough for a heading line: "1 of 4 met". */
export function goalShort(goal: MilestoneView["goal"]): string {
  if (goal.counts.total === 0) return "no criteria";
  return `${goal.counts.met} of ${goal.counts.total} met`;
}

/** What the folded goal line says after its count: the first criterion that is not met yet. */
export function nextCriterion(goal: MilestoneView["goal"]): string {
  const open = goal.criteria.find((criterion) => criterion.verdict !== "met");
  return open ? `Next: ${open.text}` : "";
}

/** The pace against the target date: the check's verdict as a pill. */
export function PacePill({ goal, now }: { goal: MilestoneView["goal"]; now: Date }) {
  const pace = shownPace(goal.pace, now);
  return <RunStatePill text={PACE_WORDS[pace.verdict]} tone={PACE_TONE[pace.verdict]} />;
}

/** The criteria as the check reads them, the marks it cleared, then the pace in a sentence. */
export function GoalBody({ view, workspace, now, className }: { view: MilestoneView; workspace: string; now: Date; className?: string }) {
  const { goal } = view;
  const unplanned = unplannedText(goal.pace);
  return (
    <div className={className} data-milestone-goal="">
      {goal.criteria.length > 0 ? (
        <ul aria-label="Criteria" className="m-0 flex min-w-0 list-none flex-col divide-y divide-border/60 p-0">
          {goal.criteria.map((criterion) => (
            <CriterionRow key={criterion.position} criterion={criterion} workspace={workspace} openRef={view.milestone.identifier} now={now} />
          ))}
        </ul>
      ) : (
        <p className="m-0 py-2 text-body text-text-tertiary">No criteria yet: its goal is that every member lands.</p>
      )}
      <ClearedMarks cleared={goal.cleared} className="pb-2" />
      <p className="m-0 border-t border-border/60 pt-2.5 text-body text-text-secondary text-pretty">
        <span className="font-medium text-foreground">Pace.</span> {paceText(goal.pace, now)}
        {unplanned ? <span className="text-text-tertiary"> {unplanned}</span> : null}
      </p>
    </div>
  );
}

/** A fold chevron in the Plan view's size: 20px, with a 32px tap under 760px. */
export function FoldButton({ folded, label, onClick, className, ...data }: { folded: boolean; label: string; onClick: () => void; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <button
      type="button"
      {...data}
      aria-expanded={!folded}
      aria-label={`${folded ? "Show" : "Hide"} ${label}`}
      onClick={onClick}
      className={cn("focus-ring inline-flex size-5 min-h-0 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover", TAP_20, className)}
    >
      {folded ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
    </button>
  );
}

/** Add work: one quiet line that opens the reference and note fields in place (Add, Done, Escape). */
export function AddWork({
  busy,
  exampleRef,
  onAdd,
  defaultOpen = false,
  className,
}: {
  busy: boolean;
  exampleRef: string | null;
  onAdd: (ref: string, note: string) => void;
  /** Tests render the fields open; the page opens them on a click. */
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ref.trim()) return;
    onAdd(ref.trim(), note.trim());
    setRef("");
    setNote("");
  };
  if (!open) {
    return (
      <div className={className}>
        <Button variant="ghost" size="sm" className={cn(TAP_TEXT, "gap-1.5 px-2 text-label text-text-secondary")} onClick={() => setOpen(true)} data-milestone-add-open="">
          <Plus aria-hidden className="size-3.5" />
          Add work
        </Button>
      </div>
    );
  }
  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-milestone-add=""
    >
      <Input
        value={ref}
        autoFocus
        aria-label="Identifier to add"
        placeholder={exampleRef ? `Task or epic, like ${exampleRef}` : "Task or epic"}
        disabled={busy}
        onChange={(event) => setRef(event.target.value)}
        className="h-8 w-48 text-label @max-[760px]/ms:flex-1"
      />
      <Input
        value={note}
        aria-label="Note for the new member"
        placeholder="Why it is here (optional)"
        disabled={busy}
        onChange={(event) => setNote(event.target.value)}
        className="h-8 min-w-0 flex-1 basis-40 text-label @max-[760px]/ms:basis-full"
      />
      <Button type="submit" size="sm" className={TAP_TEXT} disabled={busy || ref.trim() === ""}>
        Add
      </Button>
      <Button type="button" variant="ghost" size="sm" className={TAP_TEXT} onClick={() => setOpen(false)}>
        Done
      </Button>
    </form>
  );
}

/**
 * The `⋯` menu's Status submenu: the detail's own status items (`statusItems` through
 * `statusEntries`, with their hold-back reasons) and "Ask for approval" when it is offered, run
 * through the detail's controller. Disabled until the milestone's detail has loaded.
 */
export function StatusSubmenu({ decision, status, onRequestApproval }: { decision: { detail: IssueDetail; controller: IssueActionsController } | null; status: string; onRequestApproval: () => void }) {
  const trigger = (
    <>
      <StatusIcon status={status as Parameters<typeof StatusIcon>[0]["status"]} className="size-3.5" />
      <span className="flex-1">Status</span>
      <span className="text-text-tertiary">{statusLabel(status as Parameters<typeof statusLabel>[0])}</span>
    </>
  );
  const marks = { "data-status-menu": "", "data-status-category": statusCategory(status as Parameters<typeof statusCategory>[0]) };
  if (!decision) {
    return (
      <DropdownMenuItem disabled {...marks} data-menu-item="status" className="gap-2">
        {trigger}
      </DropdownMenuItem>
    );
  }
  const { detail, controller } = decision;
  const ctx = contextOf(detail, controller);
  const entries = statusEntries(statusItems(ctx), controller.run);
  const askable = overflowItems(ctx).some((item) => item.id === "request-approval");
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger {...marks} data-menu-item="status" disabled={controller.busy} className="gap-2" aria-label={`Status: ${statusLabel(detail.issue.status)}. Change status`}>
        {trigger}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent aria-label="Change status" className="w-[min(20rem,calc(100vw-2rem))] p-1.5">
        {entries.map((item) => (
          <DropdownMenuItem
            key={item.status}
            data-status-choice={item.status}
            aria-current={item.current ? "true" : undefined}
            disabled={!item.current && (controller.busy || !item.call)}
            className="items-start gap-2.5 rounded-lg px-2 py-2"
            onSelect={item.select}
          >
            <StatusIcon status={item.status} className="mt-0.5 size-4" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-body font-medium text-foreground">{item.label}</span>
              <span className="text-label text-text-secondary">{item.disabledReason ?? item.description}</span>
            </span>
            {item.current ? <Check aria-hidden className="mt-0.5 size-4 text-foreground" /> : null}
          </DropdownMenuItem>
        ))}
        {askable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-status-choice="ask-approval" className="items-start gap-2.5 rounded-lg px-2 py-2" onSelect={onRequestApproval}>
              <ShieldCheck aria-hidden className="mt-0.5 size-4" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body font-medium text-foreground">{ACTION_WORDS.requestApproval}…</span>
                <span className="text-label text-text-secondary">Park it until a person approves. The tasks under it wait.</span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
