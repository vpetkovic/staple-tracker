/**
 * A milestone's work, in its order: the Tasks list's own row (`TaskRowLine`, drawn `bare`), a
 * position number on each direct member, an epic's own children under it once unfolded, and
 * the member's controls at the row's end. Move up and Move down appear on hover and focus from a
 * desk; `⋯` is always there (Open details, Move up, Move down, Remove from this milestone).
 *
 * The rows are a `treegrid` with the Tasks list's keyboard: arrows, Home and End move between
 * rows, Enter and Space open, right and left unfold and fold, alt+arrow moves a member. A click
 * on a row opens the task; the controls stop their clicks, so pressing one never also opens it.
 *
 * The move and remove controls act on a MEMBER: the row's own, or, when the done gate hides a
 * member, the member whose open work this row was lifted from (`standsFor`), named in their labels.
 * A finished milestone is a record: its work is listed and offers Open only.
 */
import { ArrowUpRight, ChevronDown, ChevronUp, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { resolveTaskListConfig, TaskRowLine } from "@/components/task-list";
import { clampIndex, onRowItself, useRovingFocus } from "@/components/task-list/roving";
import { useRowPlan } from "@/components/task-list/useRowPlan";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useBackToClose } from "@/lib/back-to-close";
import { cn } from "@/lib/utils";
import { useElementWidth } from "@/views/plan/plan-parts";
import { HiddenDoneNotice } from "./HiddenDone";
import "./work-tree.css";
import { TAP_28, TAP_TEXT } from "./milestone-parts";
import { isFinishedMilestone, type MemberListRow } from "./milestones-model";
import type { MilestoneWork } from "./useMilestoneWork";

/** What a key on a member row does. */
export type MemberRowKeyAction = { type: "focus"; index: number } | { type: "toggle" } | { type: "open" };

/**
 * The work list's keyboard, the Tasks list's contract: arrows, Home and End move between rows;
 * Enter and Space open the row, as a click does; right unfolds an epic and left folds it. Alt
 * (with an arrow: the reorder, handled by the row), Ctrl and Meta chords are left alone. Null:
 * not this list's key.
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

/** The row at the tree's own width: the wide column set from 900px, the desk row from 680px, the compact `panel` row below. */
const WIDE_ROW = { select: false, disclosure: true, actions: false } as const;
const NARROW_ROW = { select: false, disclosure: true, date: false, actions: false } as const;
const PANEL_ROW = { disclosure: true } as const;

export type WorkTreeProps = Pick<
  MilestoneWork,
  "view" | "members" | "now" | "busy" | "failure" | "hiddenDone" | "onShowDone" | "onMove" | "onRemove" | "onToggle" | "onOpen" | "onReload" | "onDismissFailure"
>;

export function WorkTree({ work }: { work: WorkTreeProps }) {
  const view = work.view!;
  const { members } = work;
  const finished = isFinishedMilestone(view.milestone.state);
  const plan = useRowPlan();
  // The row follows the tree's own width, not the window's: a narrow page on a wide screen gets the compact row.
  const { ref: box, width } = useElementWidth<HTMLDivElement>();
  const compact = plan.layout !== "line" || (width !== null && width < 680);
  const config = useMemo(
    () => (compact ? resolveTaskListConfig("panel", { columns: PANEL_ROW, plan }) : resolveTaskListConfig("tree", { columns: (width ?? 0) >= 900 ? WIDE_ROW : NARROW_ROW, plan, desk: true })),
    [plan, compact, width],
  );
  const keys = useMemo(() => members.map((entry) => entry.row.issue.identifier), [members]);
  const focus = useRovingFocus(keys);
  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const action = memberRowKey(event, members, index);
    if (!action) return;
    event.preventDefault();
    if (action.type === "focus") focus.go(keys[action.index]!);
    else if (action.type === "toggle") work.onToggle(members[index]!.row.issue.identifier);
    else work.onOpen(members[index]!.row.workspace, members[index]!.row.issue.identifier);
  };
  return (
    <div ref={box}>
      {work.failure ? (
        work.failure.kind === "conflict" ? (
          <div role="alert" data-milestone-conflict="" data-status="blocked" className="status-chip mx-4 my-2 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-body @max-[760px]/ms:mx-3">
            <span className="min-w-0 flex-1">
              <span className="font-medium">Member order changed elsewhere.</span> {work.failure.refusal.message}
            </span>
            <Button variant="outline" size="sm" className={TAP_TEXT} onClick={work.onReload} data-milestone-reload="">
              <RefreshCw aria-hidden />
              Reload
            </Button>
          </div>
        ) : (
          <GuardRefusal refusal={work.failure.refusal} onDismiss={work.onDismissFailure} className="mx-4 my-2 @max-[760px]/ms:mx-3" />
        )
      ) : null}
      {members.length === 0 && work.hiddenDone > 0 ? (
        <div className="px-4 py-3 @max-[760px]/ms:px-3">
          <HiddenDoneNotice count={work.hiddenDone} all onShowDone={work.onShowDone} />
        </div>
      ) : members.length === 0 ? (
        <p className="m-0 py-3 pr-4 pl-[42px] text-label text-text-tertiary @max-[760px]/ms:px-3">Nothing is in this milestone yet. Add an epic or a task.</p>
      ) : (
        <ul role="treegrid" aria-label={`Work in ${view.milestone.title}`} data-milestone-members="" className="m-0 flex list-none flex-col p-0">
          {members.map((entry, index) => {
            const identifier = entry.row.issue.identifier;
            return (
              <WorkRow
                key={identifier}
                entry={entry}
                count={view.members.length}
                readOnly={finished}
                compact={compact}
                config={config}
                work={work}
                focused={focus.activeKey === identifier}
                onFocus={() => focus.set(identifier)}
                onKeyDown={(event) => onRowKey(event, index)}
                registerRef={focus.register(identifier)}
              />
            );
          })}
        </ul>
      )}
      {members.length > 0 && work.hiddenDone > 0 ? (
        <div className="py-1 pr-2 pl-[34px] @max-[760px]/ms:pl-1">
          <HiddenDoneNotice count={work.hiddenDone} all={false} onShowDone={work.onShowDone} />
        </div>
      ) : null}
    </div>
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

function WorkRow({
  entry,
  count,
  readOnly,
  compact,
  config,
  work,
  focused,
  onFocus,
  onKeyDown,
  registerRef,
}: {
  entry: MemberListRow;
  count: number;
  readOnly: boolean;
  compact: boolean;
  config: ReturnType<typeof resolveTaskListConfig>;
  work: WorkTreeProps;
  focused: boolean;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  registerRef: (element: HTMLDivElement | null) => void;
}) {
  const { row, role, member } = entry;
  const identifier = row.issue.identifier;
  // The member the controls act on: this row's own, or the hidden one it stands for.
  const target =
    role === "member" ? { identifier, memberIndex: entry.memberIndex } : entry.standsFor ? { identifier: entry.standsFor.member.identifier, memberIndex: entry.standsFor.memberIndex } : null;
  const editable = target !== null && !readOnly;
  const memberIndex = target?.memberIndex ?? -1;
  const subject = target?.identifier ?? identifier;
  const { busy } = work;
  const open = () => work.onOpen(row.workspace, identifier);
  return (
    <li role="none" data-milestone-member={identifier} data-member-role={role} data-stands-for={entry.standsFor ? entry.standsFor.member.identifier : undefined} className="border-b border-border/60 last:border-b-0">
      <div
        ref={registerRef}
        role="row"
        aria-level={row.depth + 1}
        aria-expanded={row.hasChildren ? row.isExpanded : undefined}
        tabIndex={focused ? 0 : -1}
        data-member-row={identifier}
        onFocus={(event) => {
          if (event.target === event.currentTarget) onFocus();
        }}
        onClick={open}
        onKeyDown={(event) => {
          if (editable && event.altKey && !busy && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            work.onMove(memberIndex, memberIndex + (event.key === "ArrowUp" ? -1 : 1));
            return;
          }
          // Keys on a control inside the row are the control's own.
          if (!onRowItself(event)) return;
          onKeyDown(event);
        }}
        className="group/work flex cursor-pointer items-center gap-1 pr-2 pl-3 outline-hidden hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring @max-[760px]/ms:pl-1"
      >
        {/* The member's place in the order, also when Done hides some; a member's own children carry none. */}
        <span role="gridcell" aria-label={role === "member" ? `Position ${memberIndex + 1}` : undefined} data-member-position={role === "member" ? memberIndex + 1 : undefined} className="w-6 shrink-0 text-right text-caption tabular-nums text-text-tertiary @max-[760px]/ms:w-5">
          {role === "member" ? memberIndex + 1 : ""}
        </span>
        <div role="gridcell" className="min-w-0 flex-1" data-milestone-work-cell="">
          <TaskRowLine row={row} config={config} semantics="bare" now={work.now} isExpanded={row.isExpanded} onToggleExpand={row.hasChildren ? () => work.onToggle(identifier) : undefined} />
        </div>
        <div role="gridcell" className="flex shrink-0 items-center" data-member-controls="">
          {editable && !compact ? (
            <span className="flex items-center opacity-0 group-hover/work:opacity-100 group-focus-within/work:opacity-100">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Move ${subject} up`}
                title="Move up (Alt+↑)"
                disabled={busy || memberIndex === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  work.onMove(memberIndex, memberIndex - 1);
                }}
              >
                <ChevronUp aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Move ${subject} down`}
                title="Move down (Alt+↓)"
                disabled={busy || memberIndex === count - 1}
                onClick={(event) => {
                  event.stopPropagation();
                  work.onMove(memberIndex, memberIndex + 1);
                }}
              >
                <ChevronDown aria-hidden />
              </Button>
            </span>
          ) : null}
          <MemberMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={editable ? `Actions for ${subject}` : `Actions for ${identifier}`}
                data-member-actions={editable ? subject : identifier}
                className={cn("size-7 shrink-0 text-text-tertiary", TAP_28)}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label={`Actions for ${editable ? subject : identifier}`} onClick={(event) => event.stopPropagation()}>
              <DropdownMenuItem data-menu-item="open" onSelect={open}>
                <ArrowUpRight aria-hidden />
                Open details
              </DropdownMenuItem>
              {editable ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem data-menu-item="up" disabled={busy || memberIndex === 0} onSelect={() => work.onMove(memberIndex, memberIndex - 1)}>
                    <ChevronUp aria-hidden />
                    Move {subject} up
                  </DropdownMenuItem>
                  <DropdownMenuItem data-menu-item="down" disabled={busy || memberIndex === count - 1} onSelect={() => work.onMove(memberIndex, memberIndex + 1)}>
                    <ChevronDown aria-hidden />
                    Move {subject} down
                  </DropdownMenuItem>
                  <DropdownMenuItem data-menu-item="remove" disabled={busy} onSelect={() => work.onRemove(subject)}>
                    <Trash2 aria-hidden />
                    Remove {subject} from this milestone
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </MemberMenu>
        </div>
      </div>
      {/* Its own row under the task, so the task and its controls keep one line and one centre. */}
      {member?.note ? (
        <div role="row" aria-level={row.depth + 1}>
          <div role="gridcell" className="pb-1.5 pl-[70px] text-caption text-text-tertiary @max-[760px]/ms:pl-9" data-member-note="">
            {member.note}
          </div>
        </div>
      ) : null}
    </li>
  );
}
