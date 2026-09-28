/**
 * The Milestones destination — R3c (STA-173), docs/milestones.md.
 *
 * Master–detail: the plan on the left (every milestone in plan order, then target date),
 * one milestone on the right with its dates, details, ordered members, rollups and the
 * queue's answer. Narrow viewports stack the two and the detail gets a Back button; from
 * `md` up they split; a full-screen toggle gives the detail the whole content box, the
 * way the issue drawer's expand does (detail/drawer.ts — the idea, not the module).
 *
 * The presentational pieces (`MilestonesLayout`, `MilestoneListPane`, `MilestoneDetailPane`)
 * take everything as props and read no context, so `milestones-render.test.tsx` renders
 * them to static markup. `MilestonesView` is the one component that talks to the session
 * and the API.
 *
 * ── WRITES ────────────────────────────────────────────────────────────────────────────
 *
 * Add, remove and reorder go through `/api/milestone/{add,remove,reorder}` carrying
 * `baseRevision: view.revision`. The store checks it before touching the order; a stale
 * base is `revision_conflict`, which the page shows as a conflict notice with a Reload
 * rather than as a refusal — the order on screen is simply older than the store's, and
 * the fix is to read again, not to argue. Every other error is the store's own sentence
 * in the shared `GuardRefusal`. A write's result IS the view, so the detail is redrawn
 * from it directly and the page fingerprint is bumped for the list.
 *
 * Reorder is the keyboard's: Move up / Move down buttons on every member, always visible,
 * plus alt+arrow on the row. The task list carries no drag wiring (only the settings
 * editor does), and the brief's fallback for that case is exactly this.
 */
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronUp, Maximize2, Milestone, Minimize2, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import { openCreateIssue } from "@/lib/shell-events";
import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { resolveTaskListConfig, StatusIcon, TaskRowLine } from "@/components/task-list";
import { clampIndex, useRovingFocus } from "@/components/task-list/roving";
import { useRowPlan } from "@/components/task-list/useRowPlan";
import { passesDone, withShowDone } from "@/lib/filters";
import { statusCategory, statusLabel } from "@/lib/settings";
import { ROOMY_QUERY, useMediaQuery } from "@/lib/use-media";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ActionRefusal, GateSection, StatusMenu, useIssueActions, type IssueActionsController } from "@/detail/IssueActions";
import {
  addMilestoneMember,
  getIssue,
  getMilestone,
  getMilestones,
  getQueue,
  isRevisionConflict,
  removeMilestoneMember,
  reorderMilestoneMembers,
  type AuthError,
} from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useBackToClose } from "@/lib/back-to-close";
import { useSession } from "@/lib/session";
import type {
  EffectiveQueueRow,
  GoalPace,
  IssueDetail,
  MilestoneListRow,
  MilestoneState,
  MilestoneView as MilestoneViewData,
} from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, SectionHeading } from "@/views/ViewChrome";
import { workspaceScope } from "@/views/workspace-scope";
import { idsOf, pinnedRef } from "@/lib/write-ref";
import { AllWorkspacesMilestones, MilestonesOff } from "./AllWorkspacesMilestones";
import {
  dateLabel,
  isMissingMilestoneKind,
  layoutFor,
  memberListRows,
  milestoneRisk,
  movedOrder,
  NOT_QUEUED_LABEL,
  nextWorkLabel,
  progressLabel,
  riskLabels,
  sortMilestones,
  STATE_PRESENTATION,
  type MemberListRow,
  type MilestonesLayout as LayoutName,
} from "./milestones-model";
import {
  dueText,
  progressDetailSentence,
  progressSegments,
  progressSentence,
  projectedDue,
  riskSentence,
  type ProjectedDue,
} from "./milestone-plain";
import { MilestoneDueControl, useSetMilestoneTarget } from "./MilestoneDue";
import { ProgressStrip } from "@/views/ProgressStrip";
import { EmptyState as PlainEmptyState } from "@/components/plain/States";
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

function RiskLine({
  row,
  effective,
}: {
  row: Pick<MilestoneViewData, "milestone">;
  effective: readonly EffectiveQueueRow[];
}) {
  const labels = riskLabels(milestoneRisk(row, effective));
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

/** A milestone that is over: finished or cancelled. Read-only on this page. */
export function isFinishedMilestone(state: MilestoneState): boolean {
  return state === "done" || state === "cancelled";
}

/** The milestones the list shows under the Done toggle, and how many finished ones it hides. */
export function visibleMilestones<T extends Pick<MilestoneListRow, "milestone">>(all: readonly T[], showDone: boolean): { rows: T[]; hiddenFinished: number } {
  const rows = showDone ? [...all] : all.filter((row) => !isFinishedMilestone(row.milestone.state));
  return { rows, hiddenFinished: all.length - rows.length };
}

export function MilestoneListPane({
  rows,
  effective = [],
  paces = null,
  hiddenFinished = 0,
  onShowFinished,
  selectedRef,
  onSelect,
  desk = false,
}: {
  rows: readonly MilestoneListRow[];
  /**
   * The goal check's pace per milestone (by identifier), for a card with no target date to
   * show its projected one. The list read carries no goal, so the page reads each such
   * milestone's view; absent, a card says only what it knows.
   */
  paces?: ReadonlyMap<string, GoalPace> | null;
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
          <Button variant="outline" size="sm" onClick={openCreateIssue} data-create-milestone="">
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
                  "staple-milestone-card flex w-full flex-col gap-2 rounded-xl border bg-card px-3.5 py-3 text-left outline-none",
                  "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
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
                    row.milestone.state === "overdue" && "text-[var(--plain-risk-fg)]",
                  )}
                >
                  {dueText(row.milestone, projectedDue(paces?.get(row.milestone.identifier), now), now)}
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
                "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left outline-none",
                "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                selected ? "border-ring bg-surface-hover" : "border-transparent",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-text-tertiary">{row.milestone.identifier}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{row.milestone.title}</span>
                <StateBadge state={row.milestone.state} complete={row.progress.complete} />
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

// ---------- the detail ----------

/** What the detail pane shows when a write went wrong, and how it went wrong. */
export interface MemberWriteFailure {
  kind: "conflict" | "refusal";
  refusal: Refusal;
}

/** The panel row, plus the disclosure column — that column is what carries the indent. */
const MEMBER_ROW_COLUMNS = { disclosure: true } as const;

/**
 * The member row at this width — the tree's own ladder (row-layout.ts). On the desk it is the
 * Tasks list's desktop row with the Tasks list's columns (chevron, identifier, kind slot, cue
 * cluster, handoff note, who), so its badges sit in the same right-aligned cluster. Off: the
 * select box and the hover quick actions (the member row carries its own open, move and
 * remove buttons beside it), and the last-change date, whose 40px the split pane's titles
 * need more.
 */
const DESK_MEMBER_COLUMNS = { select: false, disclosure: true, date: false, actions: false } as const;
function useMemberRowConfig() {
  const plan = useRowPlan();
  return useMemo(
    () =>
      plan.layout === "line"
        ? resolveTaskListConfig("tree", { columns: DESK_MEMBER_COLUMNS, plan, desk: true })
        : resolveTaskListConfig("panel", { columns: MEMBER_ROW_COLUMNS, plan }),
    [plan],
  );
}

/** The member `⋯` menu, held open by its own state so phone Back can close it. */
function MemberMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useBackToClose(open, () => setOpen(false));
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {children}
    </DropdownMenu>
  );
}

/** What a key on a member row does. */
export type MemberRowKeyAction = { type: "focus"; index: number } | { type: "toggle" } | { type: "open" };

/**
 * The member list's keyboard, the Tasks list's contract: arrows, Home and End move between
 * rows; Enter and Space open the row, as a click does; right unfolds an epic and left folds
 * it. Alt (with an arrow: the reorder, handled by the member's `<li>`), Ctrl and Meta chords
 * are left alone. Null: not this list's key.
 */
export function memberRowKey(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">,
  members: readonly MemberListRow[],
  index: number,
): MemberRowKeyAction | null {
  if (event.altKey || event.metaKey || event.ctrlKey || members.length === 0) return null;
  const row = members[index]!.row;
  switch (event.key) {
    case "ArrowDown":
      return { type: "focus", index: clampIndex(index + 1, members.length) };
    case "ArrowUp":
      return { type: "focus", index: clampIndex(index - 1, members.length) };
    case "Home":
      return { type: "focus", index: 0 };
    case "End":
      return { type: "focus", index: members.length - 1 };
    case "ArrowRight":
    case "ArrowLeft":
      return row.hasChildren && row.isExpanded === (event.key === "ArrowLeft") ? { type: "toggle" } : null;
    case "Enter":
    case " ":
      return { type: "open" };
    default:
      return null;
  }
}

/**
 * One member row. The row itself is the Tasks list's row with `list` semantics — an option in
 * the members listbox, one tab stop for the list, and a click or Enter anywhere on it opens
 * the task, as on the Queue page. The open, move and remove buttons are siblings of the row,
 * not inside it, and stop their clicks as well, so pressing one never also opens the row.
 */
function MemberRow({
  entry,
  count,
  now,
  busy,
  readOnly = false,
  focused = false,
  onFocus,
  onKeyDown,
  registerRef,
  onToggle,
  onOpen,
  onMove,
  onRemove,
}: {
  entry: MemberListRow;
  count: number;
  now: Date;
  busy: boolean;
  /** A finished milestone: Open only, no move or remove. */
  readOnly?: boolean;
  focused?: boolean;
  onFocus?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  registerRef?: (element: HTMLDivElement | null) => void;
  onToggle?: () => void;
  onOpen: (workspace: string, identifier: string) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (identifier: string) => void;
}) {
  const { row, role, memberIndex, member } = entry;
  const editable = role === "member" && !readOnly;
  const identifier = row.issue.identifier;
  const config = useMemberRowConfig();
  /*
   * On a phone, and on a desk narrower than 1280px where the split leaves the member list a
   * narrow pane, the four buttons fold into one `⋯` with the same four acts, in words: they
   * cost the title ~100px it cannot spare there.
   */
  const roomy = useMediaQuery(ROOMY_QUERY, true);
  const compact = config.plan?.layout === "compact" || !roomy;
  return (
    <li
      role="presentation"
      data-milestone-member={identifier}
      data-member-role={role}
      onKeyDown={(event) => {
        if (!editable || !event.altKey || busy) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onMove(memberIndex, memberIndex - 1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onMove(memberIndex, memberIndex + 1);
        }
      }}
      className="flex flex-col"
    >
      <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        <TaskRowLine
          row={row}
          config={config}
          semantics="list"
          now={now}
          isExpanded={row.isExpanded}
          isFocused={focused}
          onOpen={() => onOpen(row.workspace, identifier)}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onToggleExpand={onToggle}
          registerRef={registerRef}
        />
      </div>
      {compact && editable ? (
        /* On a phone the four buttons cost the title ~110px. One `⋯` holds the same four
           acts, with words, and a 44px target. */
        <MemberMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${identifier}`}
              data-member-actions={identifier}
              className="shrink-0 text-text-tertiary"
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            aria-label={`Actions for ${identifier}`}
            className="pointer-coarse:[&_[role=menuitem]]:min-h-11 pointer-coarse:[&_[role=menuitem]]:text-[15px]"
          >
            <DropdownMenuItem data-menu-item="open" onSelect={() => onOpen(row.workspace, identifier)}>
              <ArrowUpRight aria-hidden />
              Open details
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy || memberIndex === 0} onSelect={() => onMove(memberIndex, memberIndex - 1)}>
              <ChevronUp aria-hidden />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy || memberIndex === count - 1} onSelect={() => onMove(memberIndex, memberIndex + 1)}>
              <ChevronDown aria-hidden />
              Move down
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => onRemove(identifier)}>
              <Trash2 aria-hidden />
              Remove from this milestone
            </DropdownMenuItem>
          </DropdownMenuContent>
        </MemberMenu>
      ) : (
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          // Folded, a child's lone Open is as wide as a member's `⋯`, so every row ends at one x.
          size={compact ? "icon-sm" : "icon-xs"}
          aria-label={`Open ${identifier}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen(row.workspace, identifier);
          }}
        >
          <ArrowUpRight aria-hidden />
        </Button>
        {editable ? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${identifier} up`}
              disabled={busy || memberIndex === 0}
              onClick={(event) => {
                event.stopPropagation();
                onMove(memberIndex, memberIndex - 1);
              }}
            >
              <ChevronUp aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${identifier} down`}
              disabled={busy || memberIndex === count - 1}
              onClick={(event) => {
                event.stopPropagation();
                onMove(memberIndex, memberIndex + 1);
              }}
            >
              <ChevronDown aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${identifier} from this milestone`}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(identifier);
              }}
            >
              <Trash2 aria-hidden />
            </Button>
          </>
        ) : compact ? null : (
          // A child is here for context only: same width as the three buttons it lacks,
          // so the rows' Open buttons line up.
          <span aria-hidden className="inline-block w-[4.5rem]" />
        )}
      </div>
      )}
      </div>
      {/* Under the row, so the row and its buttons keep one line and one centre. */}
      {member?.note ? (
        <div className="pb-1 pl-8 text-[11px] text-muted-foreground" data-member-note>
          {member.note}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The figures behind the card, as one aligned grid of label and value — two pairs to a line
 * where there is room, one where there is not. It holds only what the sentence and the bar do
 * not already say: which milestone, its dates, how many tasks the percentage is over, and the
 * queue's reading (what waits, and what an agent would take next). The bar's buckets are not
 * repeated here.
 */
export function Rollups({
  view,
  effective,
  withDates = false,
}: {
  view: Pick<MilestoneViewData, "milestone" | "progress" | "next">;
  effective: readonly EffectiveQueueRow[];
  /** The desk card, whose header does not print the reference and the dates. */
  withDates?: boolean;
}) {
  const { milestone, progress, next } = view;
  // Blocked and gated are the QUEUE's verdict, not a status category — see `milestoneRisk`.
  const risk = milestoneRisk(view, effective);
  const counted =
    progress.counts.cancelled > 0 ? `${progress.countable} (${progress.counts.cancelled} cancelled not counted)` : `${progress.countable}`;
  type Cell = [key: string, label: string, value: string];
  const dated = (cell: Cell): Cell[] => (withDates ? [cell] : []);
  const cells: Cell[] = [
    ...dated(["reference", "Reference", milestone.identifier]),
    ["counted", "Tasks counted", counted],
    ...dated(["start", "Starts", dateLabel(milestone.startDate)]),
    ["blocked", "Tasks waiting on others", `${risk.blocked}`],
    ...dated(["target", "Target", dateLabel(milestone.targetDate)]),
    ["gated", "Tasks waiting for approval", `${risk.gated}`],
    ...(milestone.planPosition !== null ? dated(["plan", "Plan position", `#${milestone.planPosition}`]) : []),
    ["next", "Next up", next ? `${next.identifier}, #${next.position} in the pickup order` : NOT_QUEUED_LABEL],
  ];
  return (
    <dl
      data-milestone-rollups
      className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1 text-label sm:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]"
    >
      {cells.map(([key, label, value]) => (
        <Fragment key={key}>
          <dt className="text-text-tertiary" data-rollup={key}>
            {label}
          </dt>
          <dd className="m-0 min-w-0 truncate text-foreground tabular-nums">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function MilestoneDetailPane({
  view,
  effective = [],
  members,
  now,
  busy,
  failure,
  fullScreen,
  onToggleFullScreen,
  onOpen,
  onMove,
  onRemove,
  onAdd,
  onReload,
  onDismissFailure,
  onToggle,
  projection = null,
  due,
  decision = null,
  desk = false,
  exampleRef = null,
}: {
  view: MilestoneViewData;
  /** The queue's effective rows, which is where blocked and gated are counted from. */
  effective?: readonly EffectiveQueueRow[];
  members: readonly MemberListRow[];
  now: Date;
  busy: boolean;
  failure: MemberWriteFailure | null;
  fullScreen: boolean;
  onToggleFullScreen: () => void;
  onOpen: (workspace: string, identifier: string) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (identifier: string) => void;
  onAdd: (ref: string, note: string) => void;
  onReload: () => void;
  onDismissFailure: () => void;
  /** Fold or unfold a member epic's children, as the chevron does in the Tasks list. */
  onToggle?: (identifier: string) => void;
  /** When the work still estimated in it would land; shown while no target is set. */
  projection?: ProjectedDue | null;
  /** The due-date write, for the calendar button. Absent: the date is read-only. */
  due?: { busy: boolean; error: string | null; onSetTarget: (targetDate: string | null) => Promise<boolean> };
  /**
   * The milestone as the task detail reads it (`/api/issue`) and the detail's own action
   * controller: the status control, the approval gate and its refusals are the detail's,
   * with the detail's hold-back rules and the detail's signing. Absent until it loads.
   */
  decision?: { detail: IssueDetail; controller: IssueActionsController } | null;
  /** The desktop pane: a plain header, a progress card, the raw rollups under Show details. */
  desk?: boolean;
  /** A real reference from this workspace, for the add box's example. */
  exampleRef?: string | null;
}) {
  const { milestone } = view;
  const finished = isFinishedMilestone(milestone.state);
  const [requestOpen, setRequestOpen] = useState(false);
  const completedAt = decision?.detail.issue.completedAt ?? decision?.detail.issue.cancelledAt ?? null;
  const dueControl = (
    <MilestoneDueControl
      milestone={milestone}
      projection={projection}
      now={now}
      completedAt={completedAt}
      editable={!finished && Boolean(due)}
      busy={due?.busy}
      error={due?.error}
      onSetTarget={due?.onSetTarget}
    />
  );
  const statusControl = decision ? (
    <StatusMenu detail={decision.detail} controller={decision.controller} onRequestApproval={() => setRequestOpen(true)} />
  ) : (
    <MilestoneStatusPill status={milestone.status} />
  );
  const gateBlock = decision ? (
    <div data-milestone-gate="" className="flex flex-col gap-3 empty:hidden">
      <ActionRefusal controller={decision.controller} />
      <GateSection
        detail={decision.detail}
        controller={decision.controller}
        requestOpen={requestOpen}
        onCloseRequest={() => setRequestOpen(false)}
        showState
      />
    </div>
  ) : null;
  const [addRef, setAddRef] = useState("");
  const [addNote, setAddNote] = useState("");
  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    const ref = addRef.trim();
    if (!ref) return;
    onAdd(ref, addNote.trim());
    setAddRef("");
    setAddNote("");
  };

  const risk = milestoneRisk(view, effective);
  const riskReading = effective.length > 0 ? risk : null;

  // One tab stop for the whole list, arrows between rows: the Tasks list's contract.
  const keys = useMemo(() => members.map((entry) => entry.row.issue.identifier), [members]);
  const focus = useRovingFocus(keys);
  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const action = memberRowKey(event, members, index);
    if (!action) return;
    event.preventDefault();
    if (action.type === "focus") focus.go(keys[action.index]!);
    else if (action.type === "toggle") onToggle?.(members[index]!.row.issue.identifier);
    else onOpen(members[index]!.row.workspace, members[index]!.row.issue.identifier);
  };
  return (
    <article
      data-milestone-detail={milestone.identifier}
      data-desk={desk ? "" : undefined}
      className={cn("flex min-h-0 flex-1 flex-col", desk ? "mx-auto w-full max-w-wide gap-5 pt-2" : "gap-4")}
    >
      {desk ? (
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-heading font-semibold">{milestone.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-muted-foreground">
              {statusControl}
              {dueControl}
              {milestone.assignee ? <span>Owned by {milestone.assignee}</span> : null}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => onOpen("", milestone.identifier)}>
            <ArrowUpRight aria-hidden />
            Open
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={fullScreen ? "Collapse from full screen" : "Expand to full screen"}
            aria-pressed={fullScreen}
            title={fullScreen ? "Collapse from full screen" : "Expand to full screen"}
            onClick={onToggleFullScreen}
          >
            {fullScreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
        </header>
      ) : null}
      {desk ? gateBlock : null}
      {desk ? (
        <section aria-label="Progress" data-milestone-progress className="rounded-xl border bg-card px-4 py-4">
          <p className="text-title font-medium" data-milestone-progress-sentence>
            {progressSentence(view.progress)}
          </p>
          <p className="mt-0.5 mb-3 text-body text-muted-foreground" data-milestone-detail-sentence>
            {progressDetailSentence(view, riskReading)}
          </p>
          <ProgressStrip
            testId="milestone-progress"
            label={progressSentence(view.progress)}
            segments={progressSegments(view.progress, riskReading)}
          />
          <details className="mt-3 text-label text-muted-foreground" data-technical-details="">
            <summary className="cursor-pointer select-none py-1">Show details</summary>
            <div className="mt-2">
              <Rollups view={view} effective={effective} withDates />
            </div>
          </details>
        </section>
      ) : null}
      {desk ? null : (
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-mono text-[11px] text-text-tertiary">
            {milestone.identifier}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Open ${milestone.identifier}`}
              onClick={() => onOpen("", milestone.identifier)}
            >
              <ArrowUpRight aria-hidden />
            </Button>
          </div>
          <h2 className="text-[17px] font-semibold tracking-[var(--tracking-heading)]">{milestone.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            {decision ? statusControl : <StateBadge state={milestone.state} complete={view.progress.complete} />}
            <span data-milestone-start>start {dateLabel(milestone.startDate)}</span>
            {dueControl}
            {milestone.assignee ? <span>owner {milestone.assignee}</span> : null}
            {milestone.planPosition !== null ? <span>plan #{milestone.planPosition}</span> : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={fullScreen ? "Collapse from full screen" : "Expand to full screen"}
          aria-pressed={fullScreen}
          title={fullScreen ? "Collapse from full screen" : "Expand to full screen"}
          onClick={onToggleFullScreen}
        >
          {fullScreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
      </header>

      )}
      {desk ? null : gateBlock}
      {desk ? null : (
      <section aria-label="Progress" data-milestone-progress>
        <SectionHeading>Rollups</SectionHeading>
        <p className="mb-2 text-[13px]" data-milestone-progress-sentence>
          {progressSentence(view.progress)}{" "}
          <span className="text-muted-foreground" data-milestone-detail-sentence>
            {progressDetailSentence(view, riskReading)}
          </span>
        </p>
        <ProgressStrip
          testId="milestone-progress"
          label={progressSentence(view.progress)}
          segments={progressSegments(view.progress, riskReading)}
        />
        <div className="mt-2">
          <Rollups view={view} effective={effective} />
        </div>
      </section>
      )}

      <section className="min-h-0">
        {desk ? (
          <h3 className="mb-2 text-body font-semibold">
            What is in this milestone
            <span className="ml-2 font-normal text-muted-foreground">
              {view.members.length} {view.members.length === 1 ? "item" : "items"}, in order
            </span>
          </h3>
        ) : (
          <SectionHeading>Members</SectionHeading>
        )}
        {failure ? (
          failure.kind === "conflict" ? (
            <div
              role="alert"
              data-milestone-conflict
              className="status-chip mb-2 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[13px]"
              data-status="blocked"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">Member order changed elsewhere.</span> {failure.refusal.message}
              </span>
              <Button variant="outline" size="xs" onClick={onReload}>
                <RefreshCw aria-hidden />
                Reload
              </Button>
            </div>
          ) : (
            <GuardRefusal refusal={failure.refusal} onDismiss={onDismissFailure} className="mb-2" />
          )
        ) : null}
        {members.length === 0 ? (
          desk ? (
            <PlainEmptyState compact icon={Milestone} title="Nothing is in this milestone yet">
              Add an epic or a task below.
            </PlainEmptyState>
          ) : (
            <EmptyState>no members yet — add an epic or a task below</EmptyState>
          )
        ) : (
          <ul role="listbox" aria-label={`Members of ${milestone.identifier}`} data-milestone-members className="flex flex-col">
            {members.map((entry, index) => {
              const identifier = entry.row.issue.identifier;
              return (
                <MemberRow
                  key={identifier}
                  entry={entry}
                  count={view.members.length}
                  readOnly={finished}
                  now={now}
                  busy={busy}
                  focused={focus.activeKey === identifier}
                  onFocus={() => focus.set(identifier)}
                  onKeyDown={(event) => onRowKey(event, index)}
                  registerRef={focus.register(identifier)}
                  onToggle={entry.row.hasChildren && onToggle ? () => onToggle(identifier) : undefined}
                  onOpen={onOpen}
                  onMove={onMove}
                  onRemove={onRemove}
                />
              );
            })}
          </ul>
        )}
        {/* A finished milestone is a record: its members are listed, not edited. */}
        {finished ? null : (
        <form onSubmit={submitAdd} className="mt-2 flex flex-wrap items-center gap-2" data-milestone-add>
          <Input
            value={addRef}
            aria-label="Identifier to add"
            placeholder={desk ? (exampleRef ? `Task, like ${exampleRef}` : "Task reference") : "STA-66"}
            disabled={busy}
            onChange={(event) => setAddRef(event.target.value)}
            className={cn("h-7 text-[12px]", desk ? "h-8 w-40" : "w-28 font-mono")}
          />
          <Input
            value={addNote}
            aria-label="Note for the new member"
            placeholder={desk ? "Why it is here (optional)" : "note (optional)"}
            disabled={busy}
            onChange={(event) => setAddNote(event.target.value)}
            className="h-7 min-w-0 flex-1 text-[12px]"
          />
          <Button type="submit" variant="outline" size={desk ? "sm" : "xs"} disabled={busy || addRef.trim() === ""}>
            {desk ? "Add to milestone" : "Add member"}
          </Button>
        </form>
        )}
      </section>
    </article>
  );
}

// ---------- the layout ----------

/**
 * Where the two panes go. `stacked` shows one at a time — the list, or the detail with a
 * Back button; `split` shows both; `fullScreen` gives the detail the whole box in either.
 */
export function MilestonesLayout({
  layout,
  fullScreen,
  hasSelection,
  list,
  detail,
  onBack,
}: {
  layout: LayoutName;
  fullScreen: boolean;
  hasSelection: boolean;
  list: ReactNode;
  detail: ReactNode;
  onBack: () => void;
}) {
  const detailOnly = fullScreen || (layout === "stacked" && hasSelection);
  const listOnly = layout === "stacked" && !hasSelection;
  return (
    <div
      data-milestones-layout={layout}
      data-full-screen={fullScreen ? "true" : undefined}
      className={cn(
        "grid h-full min-h-0",
        detailOnly || listOnly
          ? "grid-cols-1"
          : "grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)] min-[1280px]:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]",
      )}
    >
      {detailOnly ? null : (
        <div data-milestones-pane="list" className={cn("min-h-0 overflow-y-auto px-3 py-3", listOnly ? null : "border-r")}>
          {list}
        </div>
      )}
      {listOnly ? null : (
        <div data-milestones-pane="detail" className="flex min-h-0 flex-col overflow-y-auto px-4 py-3">
          {layout === "stacked" && !fullScreen ? (
            <Button variant="ghost" size="sm" onClick={onBack} className="mb-2 self-start">
              <ArrowLeft aria-hidden />
              Back to milestones
            </Button>
          ) : null}
          {detail}
        </div>
      )}
    </div>
  );
}

// ---------- the view ----------

function useLayout(): LayoutName {
  const [layout, setLayout] = useState<LayoutName>(() => layoutFor(window.innerWidth));
  useEffect(() => {
    const onResize = () => setLayout(layoutFor(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return layout;
}

export function MilestonesView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const scope = workspaceScope(session.mode, session.ws, session.workspaces);
  if (scope.kind === "choose") {
    return <AllWorkspacesMilestones workspaces={scope.workspaces} onAuthError={onAuthError} />;
  }
  return <WorkspaceMilestones key={scope.slug} workspace={scope.slug} onAuthError={onAuthError} />;
}

function WorkspaceMilestones({ workspace, onAuthError }: { workspace: string; onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const layout = useLayout();
  const [selectedRef, setSelectedRef] = useState<string | null>(session.milestoneFocus);
  const [fullScreen, setFullScreen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MemberWriteFailure | null>(null);
  /** The last write's answer, shown until the next read lands — a writer redraws from its result. */
  const [written, setWritten] = useState<MilestoneViewData | null>(null);

  // Always the workspace the page names — never the server's own first (workspace-scope.ts).
  const ws = workspace || undefined;

  const desk = useMilestonesDesk();
  /*
   * Every milestone, finished ones included, and the header's own Done toggle decides which
   * are listed — the Tasks list's toggle, so one switch governs both pages. Reading all of
   * them is what lets an empty list say "all 3 are finished" and offer them, rather than
   * showing a blank page.
   */
  const showDone = session.filters.showDone;
  const loadList = useCallback(() => getMilestones({ ws, all: true }), [ws]);
  const list = useResource(loadList, [ws, session.version], onAuthError);
  const everything = useMemo(() => (list.data ? sortMilestones(list.data) : []), [list.data]);
  const { rows: sorted, hiddenFinished } = useMemo(() => visibleMilestones(everything, showDone), [everything, showDone]);

  // The cards with no target date show a projected one from the goal check's pace, which the
  // list read does not carry: read those milestones' views, one request each, few by nature.
  const undatedKey = sorted
    .filter((row) => !row.milestone.targetDate && !isFinishedMilestone(row.milestone.state))
    .map((row) => row.milestone.identifier)
    .join(",");
  const loadPaces = useCallback(
    () =>
      Promise.all(
        undatedKey
          .split(",")
          .filter(Boolean)
          .map((ref) => getMilestone({ ws, ref }).then((view) => [ref, view.goal.pace] as const)),
      ).then((pairs) => new Map<string, GoalPace>(pairs)),
    [ws, undatedKey],
  );
  const paces = useResource(loadPaces, [ws, undatedKey, session.version], onAuthError);
  const onShowFinished = useCallback(() => session.setFilters(withShowDone(session.filters, true)), [session]);

  // Blocked and gated are the resolver's verdict, not a status category, so the page reads
  // the queue alongside the plan and counts them off `effective` (see `milestoneRisk`). A
  // queue that has not loaded leaves the risk lines silent rather than wrong; a queue that
  // fails is not this page's error state, so it is deliberately not surfaced.
  const loadQueue = useCallback(() => getQueue({ ws }), [ws]);
  const queue = useResource(loadQueue, [ws, session.version], onAuthError);
  const effective = queue.data?.effective ?? [];

  // Nothing selected, or the selection left the list: fall to the first row on a split
  // layout, where an empty right pane would be a page saying nothing.
  useEffect(() => {
    if (sorted.length === 0) return;
    if (selectedRef && sorted.some((row) => row.milestone.identifier === selectedRef)) return;
    // A row cue that opened this view names the milestone to focus; honour it before falling to the first row.
    const focus = session.milestoneFocus;
    if (focus && sorted.some((row) => row.milestone.identifier === focus)) {
      setSelectedRef(focus);
      return;
    }
    if (layout === "split" || fullScreen) setSelectedRef(sorted[0]!.milestone.identifier);
  }, [sorted, selectedRef, layout, fullScreen, session.milestoneFocus]);

  const loadDetail = useCallback(
    () => (selectedRef ? getMilestone({ ws, ref: selectedRef }) : Promise.resolve(null)),
    [ws, selectedRef],
  );
  const detail = useResource(loadDetail, [ws, selectedRef, session.version], onAuthError);

  // The milestone as the task detail reads it, for its status control and approval gate, and
  // the detail's own action controller — one write path, one set of hold-back rules.
  const loadIssue = useCallback(
    () => (selectedRef ? getIssue({ ws, ref: selectedRef }) : Promise.resolve(null)),
    [ws, selectedRef],
  );
  const issueRead = useResource(loadIssue, [ws, selectedRef, session.version], onAuthError);
  const controller = useIssueActions(session.refresh, { workspaces: session.workspaces.map((w) => w.slug) });
  const milestoneIssue = issueRead.data && issueRead.data.issue.identifier === selectedRef ? issueRead.data : null;
  useEffect(() => setWritten(null), [detail.data]);
  useEffect(() => {
    setFailure(null);
    setWritten(null);
  }, [selectedRef]);

  // `useResource` keeps the previous answer while the next one loads; a milestone must
  // not be drawn under another milestone's identifier for even one frame.
  const loaded = detail.data && detail.data.milestone.identifier === selectedRef ? detail.data : null;
  const view = written ?? loaded;
  const now = useMemo(() => new Date(), [view]);
  const projection = useMemo(() => (view ? projectedDue(view.goal?.pace, now) : null), [view, now]);
  const dueWrite = useSetMilestoneTarget(ws, view?.milestone.id ?? "");
  // The Tasks list's own done gate and its fold, so "Done hidden" hides the same rows here.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback(
    (identifier: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(identifier)) next.add(identifier);
        return next;
      }),
    [],
  );
  const filters = session.filters;
  const members = useMemo(
    () =>
      view
        ? memberListRows(view, session.issues.data ?? [], workspace, {
            visible: (row) => passesDone(row, filters),
            collapsed,
          })
        : [],
    [view, session.issues.data, workspace, filters, collapsed],
  );

  const write = useCallback(
    async (run: () => Promise<MilestoneViewData>) => {
      setBusy(true);
      try {
        const next = await run();
        setWritten(next);
        setFailure(null);
        session.refresh();
      } catch (error) {
        setFailure({ kind: isRevisionConflict(error) ? "conflict" : "refusal", refusal: describeRefusal(error) });
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  const onMove = useCallback(
    (from: number, to: number) => {
      if (!view) return;
      const order = movedOrder(view.members, from, to);
      if (!order) return;
      void write(() =>
        reorderMilestoneMembers({
          ws,
          // By id (`lib/write-ref.ts`): the milestone and the members the reader sees.
          milestone: view.milestone.id,
          order: idsOf(view.members.map((member) => ({ identifier: member.identifier, id: member.issueId })), order),
          baseRevision: view.revision,
        }),
      );
    },
    [view, ws, write],
  );

  const onRemove = useCallback(
    (identifier: string) => {
      if (!view) return;
      void write(() =>
        removeMilestoneMember({
          ws,
          milestone: view.milestone.id,
          ref: idsOf(view.members.map((member) => ({ identifier: member.identifier, id: member.issueId })), [identifier])[0]!,
          baseRevision: view.revision,
        }),
      );
    },
    [view, ws, write],
  );

  const onAdd = useCallback(
    (ref: string, note: string) => {
      if (!view) return;
      void write(() =>
        addMilestoneMember({
          ws,
          milestone: view.milestone.id,
          ref: pinnedRef(session.issues.data ?? [], workspace, ref),
          baseRevision: view.revision,
          ...(note ? { note } : {}),
        }),
      );
    },
    [view, ws, write],
  );

  const onReload = useCallback(() => {
    setFailure(null);
    setWritten(null);
    detail.reload();
  }, [detail]);

  const onOpen = useCallback(
    (rowWorkspace: string, identifier: string) => session.open(rowWorkspace || workspace, identifier),
    [session, workspace],
  );

  // The workspace has no milestone kind: the whole page says so, in words, with the fix.
  if (list.error && isMissingMilestoneKind(list.error)) return <MilestonesOff workspace={workspace} />;

  const listPane = list.error ? (
    <ErrorState error={list.error} />
  ) : list.data === undefined ? (
    <LoadingState />
  ) : (
    <MilestoneListPane
      rows={sorted}
      effective={effective}
      paces={paces.data ?? null}
      hiddenFinished={hiddenFinished}
      onShowFinished={onShowFinished}
      selectedRef={selectedRef}
      onSelect={setSelectedRef}
      desk={desk}
    />
  );

  // No milestone listed: the list pane already says why and what to do; the right pane stays quiet.
  const detailPane = sorted.length === 0 && list.data !== undefined ? null : !selectedRef ? (
    desk ? (
      <PlainEmptyState compact icon={Milestone} title="Pick a milestone">
        Choose one on the left to see what is in it and how far it has got.
      </PlainEmptyState>
    ) : (
      <EmptyState>select a milestone</EmptyState>
    )
  ) : detail.error ? (
    <ErrorState error={detail.error} />
  ) : !view ? (
    <LoadingState />
  ) : (
    <MilestoneDetailPane
      view={view}
      effective={effective}
      members={members}
      now={now}
      busy={busy}
      failure={failure}
      fullScreen={fullScreen}
      onToggleFullScreen={() => setFullScreen((on) => !on)}
      onOpen={onOpen}
      onMove={onMove}
      onRemove={onRemove}
      onAdd={onAdd}
      onReload={onReload}
      onDismissFailure={() => setFailure(null)}
      onToggle={onToggle}
      projection={projection}
      due={{ busy: dueWrite.busy, error: dueWrite.error, onSetTarget: dueWrite.set }}
      decision={milestoneIssue ? { detail: milestoneIssue, controller } : null}
      desk={desk}
      exampleRef={(session.issues.data ?? []).find((r) => r.workspace === workspace && r.issue.kind !== "milestone")?.issue.identifier ?? null}
    />
  );

  return (
    <MilestonesLayout
      layout={layout}
      fullScreen={fullScreen}
      hasSelection={selectedRef !== null}
      list={listPane}
      detail={detailPane}
      onBack={() => setSelectedRef(null)}
    />
  );
}
