/**
 * A milestone's work, in its order, drawn with Plan's outline grammar (`views/plan/PlanTree.tsx`):
 * one grid every line shares, a header strip, one 18px guide per level, the 18px chevron, a 14px
 * glyph, the title, then the row's own columns, and a `⋯` revealed on hover and focus. The layout
 * follows the tree's own width (`@container/tree`): under 760px a row is two lines (the title, then
 * what it says); from 760px it is one line, with the columns Progress, Now and (from 1040px)
 * Updated. What each cell says is the Tasks list's own parts: the status glyph, the parent rollup,
 * the dependency, claim and pull request cues, the priority, the assignee and the date.
 *
 * Every row starts chevron, glyph, title at one x for its depth. No position number is drawn: the
 * order is the sequence under "Work, in order". Each direct member carries its place for assistive
 * technology (`aria-posinset`), the `⋯` menu opens on it ("2 of 3 in the order"), and a move says
 * where it landed through a polite live region. The row holding the milestone's next ticket, and
 * the ticket once unfolded, carry a "next up" flag.
 *
 * The rows are a `treegrid` with the Tasks list's keyboard: arrows, Home and End move between
 * rows, Enter and Space open, right and left unfold and fold, alt+arrow moves a member. A click
 * on a row opens the task; the controls stop their clicks, so pressing one never also opens it.
 *
 * The move and remove controls act on a MEMBER: the row's own, or, when the done gate hides a
 * member, the member whose open work this row was lifted from (`standsFor`), named in the menu.
 * A finished milestone is a record: its work is listed and offers Open only.
 */
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, ChevronDown, ChevronRight, ChevronUp, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { Avatar, DependencyBadges, formatRowDate, ParentRollupBar, PrBadge, PrioritySignal, StatusIcon, WhoCue, type TaskRow } from "@/components/task-list";
import { clampIndex, onRowItself, useRovingFocus } from "@/components/task-list/roving";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ShippedCheck } from "@/detail/ShippedMark";
import { useBackToClose } from "@/lib/back-to-close";
import { SessionContext } from "@/lib/session";
import { isResolvedStatus, kindLabel, statusLabel } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Flag } from "@/views/plan/plan-parts";
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

/** The menu's moves, each one reorder write: from where the member is to where it goes. */
export type MemberMove = "up" | "down" | "top" | "bottom";

export function memberMenuMove(move: MemberMove, index: number, count: number, onMove: (from: number, to: number) => void): void {
  const to = move === "up" ? index - 1 : move === "down" ? index + 1 : move === "top" ? 0 : count - 1;
  onMove(index, to);
}

/** What the live region says once a move has landed. */
export function movedAnnouncement(index: number, count: number): string {
  return `Moved to ${index + 1} of ${count}`;
}

/**
 * The rows that carry the "next up" flag: the ticket itself, the nearest member that holds it, and
 * a folded row it is hidden inside. `parentOf` walks up from the ticket through the issue list.
 */
export function nextUpRows(next: string | null, rows: readonly MemberListRow[], memberIds: ReadonlySet<string>, parentOf: (identifier: string) => string | null): Set<string> {
  const flagged = new Set<string>();
  if (!next) return flagged;
  const chain: string[] = [];
  for (let at: string | null = next; at !== null && !chain.includes(at); at = parentOf(at)) chain.push(at);
  const holder = chain.find((identifier) => memberIds.has(identifier)) ?? null;
  for (const { row } of rows) {
    const identifier = row.issue.identifier;
    if (identifier === next || identifier === holder || (chain.includes(identifier) && row.hasChildren && !row.isExpanded)) flagged.add(identifier);
  }
  return flagged;
}

/**
 * The grid every line shares, by the tree's own width: two columns on a compact tree (the work,
 * the `⋯`), four from 760px (Progress, Now), five from 1040px (Updated). Plan's, with this
 * page's column widths.
 */
const GRID =
  "grid grid-cols-[minmax(0,1fr)_36px] items-center gap-x-2 px-3 @min-[760px]/tree:grid-cols-[minmax(0,1fr)_150px_240px_28px] @min-[760px]/tree:gap-x-4 @min-[760px]/tree:px-4 @min-[1040px]/tree:grid-cols-[minmax(0,1fr)_150px_250px_120px_28px]";
const LINE = "relative min-h-9 cursor-pointer border-b border-border/60 outline-none hover:bg-surface-hover focus-ring-inset";
/** One level of depth: Plan's 18px guide with its hairline. */
const GUIDE = "relative -my-[7px] w-[18px] shrink-0 self-stretch before:absolute before:-top-px before:-bottom-px before:left-2 before:w-px before:bg-border @max-[760px]/tree:hidden";
/** The key the gathered "finished hidden" line takes in the roving focus. */
const HIDDEN_KEY = "\u0000hidden-done";

export type WorkTreeProps = Pick<
  MilestoneWork,
  "view" | "members" | "now" | "busy" | "failure" | "hiddenDone" | "onShowDone" | "onMove" | "onRemove" | "onToggle" | "onOpen" | "onReload" | "onDismissFailure"
>;

/** A write that went wrong: the conflict with Reload, or the store's sentence. */
export function WorkFailure({ work, className }: { work: Pick<MilestoneWork, "failure" | "onReload" | "onDismissFailure">; className?: string }) {
  const { failure } = work;
  if (!failure) return null;
  if (failure.kind === "conflict") {
    return (
      <div role="alert" data-milestone-conflict="" data-status="blocked" className={cn("status-chip flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-body", className)}>
        <span className="min-w-0 flex-1">
          <span className="font-medium">Member order changed elsewhere.</span> {failure.refusal.message}
        </span>
        <Button variant="outline" size="sm" className={TAP_TEXT} onClick={work.onReload} data-milestone-reload="">
          <RefreshCw aria-hidden />
          Reload
        </Button>
      </div>
    );
  }
  return <GuardRefusal refusal={failure.refusal} onDismiss={work.onDismissFailure} className={className} />;
}

export function WorkTree({ work }: { work: WorkTreeProps }) {
  const view = work.view!;
  const { members } = work;
  const finished = isFinishedMilestone(view.milestone.state);
  const session = useContext(SessionContext);
  const issues = session?.issues.data;
  const next = view.next?.identifier ?? null;
  const flagged = useMemo(() => {
    const byId = new Map<string, TaskRow["issue"]>();
    const byIdentifier = new Map<string, TaskRow["issue"]>();
    for (const known of [...(issues ?? []).map((row) => row.issue), ...members.map((entry) => entry.row.issue)]) {
      byId.set(known.id, known);
      byIdentifier.set(known.identifier, known);
    }
    const parentOf = (identifier: string) => {
      const parentId = byIdentifier.get(identifier)?.parentId;
      return parentId ? (byId.get(parentId)?.identifier ?? null) : null;
    };
    return nextUpRows(next, members, new Set(view.members.map((member) => member.identifier)), parentOf);
  }, [next, members, issues, view.members]);
  const gathered = members.length > 0 && work.hiddenDone > 0;
  const keys = useMemo(() => [...members.map((entry) => entry.row.issue.identifier), ...(gathered ? [HIDDEN_KEY] : [])], [members, gathered]);
  const focus = useRovingFocus(keys);
  // A move says where it landed once its result is drawn; a failed one says nothing.
  const [announcement, setAnnouncement] = useState("");
  const moving = useRef<{ identifier: string; to: number } | null>(null);
  const onMove = (from: number, to: number) => {
    const subject = view.members[from]?.identifier;
    if (subject && to >= 0 && to < view.members.length && to !== from) moving.current = { identifier: subject, to };
    work.onMove(from, to);
  };
  useEffect(() => {
    const pending = moving.current;
    if (!pending) return;
    if (work.failure) moving.current = null;
    else if (view.members[pending.to]?.identifier === pending.identifier) {
      moving.current = null;
      setAnnouncement(movedAnnouncement(pending.to, view.members.length));
    }
  }, [view.members, work.failure]);
  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const action = memberRowKey(event, members, index);
    if (!action) return;
    event.preventDefault();
    if (action.type === "focus") {
      // Down from the last row, and End, reach the gathered line after it.
      const toLine = gathered && (event.key === "End" || (event.key === "ArrowDown" && index === members.length - 1));
      focus.go(toLine ? HIDDEN_KEY : keys[action.index]!);
    } else if (action.type === "toggle") work.onToggle(members[index]!.row.issue.identifier);
    else work.onOpen(members[index]!.row.workspace, members[index]!.row.issue.identifier);
  };
  const onLineKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "Enter" || event.key === " ") work.onShowDone();
    else if (event.key === "ArrowUp" || event.key === "Home") focus.go(keys[event.key === "Home" ? 0 : members.length - 1]!);
    else return;
    event.preventDefault();
  };
  const items = view.members.length;
  return (
    <div className="@container/tree min-w-0">
      <div role="treegrid" aria-label={`Work in ${view.milestone.title}`} data-milestone-members="" className="min-w-0">
        <div aria-hidden className={cn(GRID, "border-b bg-surface-sunken py-1.5 text-caption text-text-tertiary")} data-work-strip="">
          <span className="truncate">
            Work, in order{" "}
            <span className="tabular-nums">
              · {items} {items === 1 ? "item" : "items"}
            </span>
          </span>
          <span className="hidden @min-[760px]/tree:block">Progress</span>
          <span className="hidden @min-[760px]/tree:block">Now</span>
          <span className="hidden text-right @min-[1040px]/tree:block">Updated</span>
          <span />
        </div>
        <WorkFailure work={work} className="mx-4 my-2 @max-[760px]/ms:mx-3" />
        {members.length === 0 && work.hiddenDone > 0 ? (
          <div className="px-4 py-3 @max-[760px]/ms:px-3">
            <HiddenDoneNotice count={work.hiddenDone} all onShowDone={work.onShowDone} />
          </div>
        ) : members.length === 0 ? (
          <p className="m-0 py-3 pr-4 pl-[42px] text-label text-text-tertiary @max-[760px]/ms:px-3">Nothing is in this milestone yet. Add an epic or a task.</p>
        ) : (
          members.map((entry, index) => {
            const identifier = entry.row.issue.identifier;
            return (
              <WorkRow
                key={identifier}
                entry={entry}
                count={view.members.length}
                readOnly={finished}
                next={flagged.has(identifier)}
                work={{ ...work, onMove }}
                focused={focus.activeKey === identifier}
                onFocus={() => focus.set(identifier)}
                onKeyDown={(event) => onRowKey(event, index)}
                registerRef={focus.register(identifier)}
              />
            );
          })
        )}
        {gathered ? (
          <div
            ref={focus.register(HIDDEN_KEY)}
            role="row"
            aria-level={1}
            tabIndex={focus.activeKey === HIDDEN_KEY ? 0 : -1}
            data-hidden-done={work.hiddenDone}
            data-show-done=""
            onFocus={(event) => {
              if (event.target === event.currentTarget) focus.set(HIDDEN_KEY);
            }}
            onClick={work.onShowDone}
            onKeyDown={onLineKey}
            className={cn(GRID, LINE)}
          >
            <div role="gridcell" className="col-span-full flex min-w-0 items-center gap-2 py-[7px] text-label text-text-tertiary">
              <ChevronRight aria-hidden className="size-[18px] shrink-0 p-0.5" />
              <ShippedCheck label="" className="size-3.5 shrink-0 [&_svg]:size-2.5" />
              <span className="min-w-0 truncate">
                {work.hiddenDone} finished hidden · <span className="text-text-secondary underline-offset-2 hover:underline">show</span>
              </span>
            </div>
          </div>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite" data-work-announce="">
        {announcement}
      </p>
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

/**
 * The row's menu: its place in the order (a quiet line, not an item), then Open details, the four
 * moves and Remove. A child that stands for no member opens, and offers nothing that would rewrite
 * an order. `target` null: nothing to move (a child, or a finished milestone's record).
 */
export function MemberMenuItems({
  target,
  identifier,
  count,
  busy,
  onOpen,
  onMove,
  onRemove,
}: {
  target: { identifier: string; memberIndex: number } | null;
  identifier: string;
  count: number;
  busy: boolean;
  onOpen: () => void;
  onMove: (from: number, to: number) => void;
  onRemove: (identifier: string) => void;
}) {
  const index = target?.memberIndex ?? -1;
  const move = (to: MemberMove) => () => memberMenuMove(to, index, count, onMove);
  const place = `${index + 1} of ${count} in the order`;
  return (
    <>
      {target ? (
        <DropdownMenuLabel className="py-1 text-caption font-normal tracking-normal normal-case text-text-tertiary" data-member-place="">
          {target.identifier === identifier ? place : `${target.identifier} is ${place}`}
        </DropdownMenuLabel>
      ) : null}
      <DropdownMenuItem data-menu-item="open" onSelect={onOpen}>
        <ArrowUpRight aria-hidden />
        Open details
      </DropdownMenuItem>
      {target ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-menu-item="up" disabled={busy || index === 0} onSelect={move("up")}>
            <ChevronUp aria-hidden />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem data-menu-item="down" disabled={busy || index === count - 1} onSelect={move("down")}>
            <ChevronDown aria-hidden />
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem data-menu-item="top" disabled={busy || index === 0} onSelect={move("top")}>
            <ArrowUpFromLine aria-hidden />
            Move to top
          </DropdownMenuItem>
          <DropdownMenuItem data-menu-item="bottom" disabled={busy || index === count - 1} onSelect={move("bottom")}>
            <ArrowDownToLine aria-hidden />
            Move to bottom
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-menu-item="remove" disabled={busy} onSelect={() => onRemove(target.identifier)}>
            <Trash2 aria-hidden />
            {target.identifier === identifier ? "Remove from this milestone" : `Remove ${target.identifier} from this milestone`}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

function WorkRow({
  entry,
  count,
  readOnly,
  next,
  work,
  focused,
  onFocus,
  onKeyDown,
  registerRef,
}: {
  entry: MemberListRow;
  count: number;
  readOnly: boolean;
  next: boolean;
  work: WorkTreeProps;
  focused: boolean;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  registerRef: (element: HTMLDivElement | null) => void;
}) {
  const { row, role, member } = entry;
  const { issue, depth } = row;
  const identifier = issue.identifier;
  // The member the controls act on: this row's own, or the hidden one it stands for.
  const target =
    role === "member" ? { identifier, memberIndex: entry.memberIndex } : entry.standsFor ? { identifier: entry.standsFor.member.identifier, memberIndex: entry.standsFor.memberIndex } : null;
  const editable = target !== null && !readOnly;
  const memberIndex = target?.memberIndex ?? -1;
  const subject = editable ? target.identifier : identifier;
  const { busy } = work;
  const open = () => work.onOpen(row.workspace, identifier);
  const kind = issue.kind === "task" || issue.kind === "epic" ? null : kindLabel(issue.kind).toLowerCase();
  const note = member?.note ?? null;
  const placed = role === "member" && !readOnly;
  // Quiet words after the title: the identifier, a kind worth naming, the parent a lifted row
  // came from, the flag, the note. On one line from 760px; on a compact tree, the second line.
  const tags = (
    <>
      <span className="shrink-0 font-mono text-caption text-text-tertiary" data-work-id="">
        {identifier}
      </span>
      {kind ? (
        <span className="shrink-0 text-caption text-text-tertiary" data-work-kind="">
          {kind}
        </span>
      ) : null}
      {row.breadcrumb ? (
        <button
          type="button"
          tabIndex={-1}
          className="relative min-h-0 shrink-0 text-caption text-text-tertiary underline-offset-2 hover:underline @max-[760px]/tree:before:absolute @max-[760px]/tree:before:-inset-y-[9px] @max-[760px]/tree:before:-inset-x-1 @max-[760px]/tree:before:content-['']"
          title={row.breadcrumb.title}
          aria-label={`Parent ${row.breadcrumb.identifier}: ${row.breadcrumb.title}`}
          data-member-parent={row.breadcrumb.identifier}
          onClick={(event) => {
            event.stopPropagation();
            work.onOpen(row.workspace, row.breadcrumb!.identifier);
          }}
        >
          in {row.breadcrumb.identifier}
        </button>
      ) : null}
      {next ? (
        <Flag tone="you" data-work-next="">
          next up
        </Flag>
      ) : null}
    </>
  );
  const noteText = note ? (
    <span className="min-w-0 truncate text-caption text-text-tertiary" title={note} data-member-note="">
      {note}
    </span>
  ) : null;
  return (
    <div
      ref={registerRef}
      role="row"
      aria-level={depth + 1}
      aria-expanded={row.hasChildren ? row.isExpanded : undefined}
      aria-posinset={placed ? memberIndex + 1 : undefined}
      aria-setsize={placed ? count : undefined}
      tabIndex={focused ? 0 : -1}
      data-member-row={identifier}
      data-milestone-member={identifier}
      data-member-role={role}
      data-stands-for={entry.standsFor ? entry.standsFor.member.identifier : undefined}
      data-work-depth={depth}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocus();
      }}
      onClick={(event) => {
        // The chevron, the cues and the menu do their own thing.
        if ((event.target as HTMLElement).closest("a, button, [role=menu]")) return;
        open();
      }}
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
      style={{ "--d": depth } as CSSProperties}
      className={cn(
        GRID,
        LINE,
        "group/row",
        // On a compact tree a child's indent is a rule down its left edge, not guides.
        depth > 0 && "@max-[760px]/tree:shadow-[inset_2px_0_0_var(--color-border)]",
      )}
    >
      <div
        role="gridcell"
        className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 py-[7px] @max-[760px]/tree:items-start @max-[760px]/tree:pt-[9px] @max-[760px]/tree:pb-0 @max-[760px]/tree:pl-[calc(var(--d)*16px)] @min-[760px]/tree:col-auto @min-[760px]/tree:row-auto"
        data-work-cell=""
      >
        {Array.from({ length: depth }, (_, index) => (
          <span key={index} aria-hidden className={GUIDE} data-work-guide="" />
        ))}
        {row.hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`${row.isExpanded ? "Collapse" : "Expand"} ${identifier}`}
            aria-expanded={row.isExpanded}
            data-work-chevron={identifier}
            onClick={() => work.onToggle(identifier)}
            className="relative inline-flex size-[18px] min-h-0 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-active @max-[760px]/tree:mt-[1px] @max-[760px]/tree:before:absolute @max-[760px]/tree:before:-inset-[9px] @max-[760px]/tree:before:content-['']"
          >
            {row.isExpanded ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
          </button>
        ) : (
          <span aria-hidden className="size-[18px] shrink-0" data-work-chevron-spacer="" />
        )}
        <StatusIcon status={issue.status} className="size-3.5 shrink-0 @max-[760px]/tree:mt-[3px]" />
        <span
          className={cn(
            "min-w-0 truncate text-body @max-[760px]/tree:line-clamp-2 @max-[760px]/tree:whitespace-normal @max-[760px]/tree:text-reading",
            role === "member" && "font-medium",
            isResolvedStatus(issue.status) ? "text-text-secondary" : "text-foreground",
          )}
          title={issue.title}
          data-work-title=""
        >
          {issue.title || "(untitled)"}
        </span>
        <span className="contents @max-[760px]/tree:hidden">{tags}</span>
        {/* The note takes only what the title leaves: the title never truncates while it shows. */}
        {noteText ? <span className="flex min-w-0 flex-[1_1_0%] @max-[760px]/tree:hidden">{noteText}</span> : null}
      </div>
      {/* On a compact tree, the second line; from 760px its cells are the row's own columns. */}
      <div className="col-span-full row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 pb-[9px] pl-[calc(var(--d)*16px+48px)] text-label text-text-secondary @min-[760px]/tree:contents">
        <div role="gridcell" className="flex min-w-0 items-center" data-work-progress="">
          <ProgressCell row={row} />
        </div>
        <div role="gridcell" className="min-w-0" data-work-now="">
          <NowCell row={row} />
        </div>
        <span className="contents @min-[760px]/tree:hidden">{tags}</span>
        {noteText ? <span className="flex min-w-0 max-w-full @min-[760px]/tree:hidden">{noteText}</span> : null}
      </div>
      <div role="gridcell" className="hidden min-w-0 items-center justify-end gap-2 text-label text-text-tertiary @min-[1040px]/tree:flex" data-work-updated="">
        <UpdatedCell row={row} now={work.now} />
      </div>
      <div
        role="gridcell"
        className="col-start-2 row-start-1 -mb-2 flex justify-end self-start pt-[5px] @min-[760px]/tree:col-auto @min-[760px]/tree:row-auto @min-[760px]/tree:mb-0 @min-[760px]/tree:self-center @min-[760px]/tree:pt-0 @min-[760px]/tree:opacity-0 @min-[760px]/tree:group-hover/row:opacity-100 @min-[760px]/tree:group-focus-visible/row:opacity-100 @min-[760px]/tree:focus-within:opacity-100 @min-[760px]/tree:has-[[data-state=open]]:opacity-100 @min-[760px]/tree:[@media(hover:none)]:opacity-100"
        data-member-controls=""
      >
        <MemberMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              tabIndex={focused ? 0 : -1}
              aria-label={`Actions for ${subject}`}
              data-member-actions={subject}
              className={cn("size-7 shrink-0 text-text-tertiary", TAP_28)}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[13rem]" aria-label={`Actions for ${subject}`} onClick={(event) => event.stopPropagation()}>
            <MemberMenuItems target={editable ? target : null} identifier={identifier} count={count} busy={busy} onOpen={open} onMove={work.onMove} onRemove={work.onRemove} />
          </DropdownMenuContent>
        </MemberMenu>
      </div>
    </div>
  );
}

/** Where a row stands: a parent's rollup (bar and count), or a leaf's status in words. */
function ProgressCell({ row }: { row: TaskRow }) {
  if (row.rollup && row.rollup.total > 0) return <ParentRollupBar rollup={row.rollup} collapsed />;
  return (
    <span className="truncate text-label text-text-secondary" data-work-state={row.issue.status}>
      {statusLabel(row.issue.status)}
    </span>
  );
}

/**
 * What stands in the way, or who is on it, in the Tasks list's order: blocked by, waiting for
 * approval, blocks, the claim with its holder, the pull request. One line that clips sideways (so a chip keeps its tap above and below), never wraps.
 */
function NowCell({ row }: { row: TaskRow }) {
  const { issue, claim } = row;
  const held = claim !== null || issue.checkoutAgent !== null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-x-clip whitespace-nowrap [&>*]:shrink-0" data-desk-cues="">
      <DependencyBadges row={row} words only="blockedBy" />
      {issue.status === "awaiting_approval" ? (
        <Flag tone="you" data-work-approval="">
          waiting for approval
        </Flag>
      ) : null}
      <DependencyBadges row={row} words only="blocks" />
      {held ? <WhoCue claim={claim} checkoutAgent={issue.checkoutAgent} assignee={null} /> : null}
      {row.pullRequests?.length ? <PrBadge pullRequests={row.pullRequests} counts={row.pullRequestCounts} workspace={row.workspace} issueId={issue.id} issueRef={issue.identifier} /> : null}
    </span>
  );
}

/** From 1040px: the priority, the assignee when the claim did not already show them, the last change. */
function UpdatedCell({ row, now }: { row: TaskRow; now: Date }) {
  const { issue, claim } = row;
  const holder = claim?.heldBy ?? issue.checkoutAgent;
  return (
    <>
      <PrioritySignal priority={issue.priority} />
      {issue.assignee && issue.assignee !== holder ? <Avatar name={issue.assignee} kind="human" size={18} /> : null}
      <time className="shrink-0 tabular-nums" dateTime={issue.updatedAt} title={`Last changed ${issue.updatedAt}`}>
        {formatRowDate(issue.updatedAt, now)}
      </time>
    </>
  );
}
