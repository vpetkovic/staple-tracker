/**
 * The Inbox's pieces: a section with its sticky folding header, a row in its wide and compact
 * shapes, a conflict opened in place, the skeleton, the unreadable-workspace banner and the
 * line that points at other workspaces. They take props and read no context, so
 * `attention-render.test.tsx` renders them to static markup.
 *
 * ONE ROW, TWO SHAPES. The page's own width decides (`@container/inbox`, 860px), not the
 * viewport's. Wide, a row is one line in an eight-column grid: new dot, subject, title, why it
 * waits, workspace, age, action, dismiss. Compact, it is three lines (title, why, a meta line
 * of subject, workspace and age) with the action and dismiss as square buttons on the right.
 * The markup is the same; the grid placement changes. Nothing here switches on a row's kind:
 * the verb, the label and the flags carry everything a kind the registry adds tomorrow needs.
 */
import {
  ArrowLeftRight,
  ArrowUpRight,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ShieldCheck,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useId } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatAgo } from "@/lib/claim";
import type { AttentionRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { type AttentionSection, ageText, attentionGo, rowSubject } from "./attention-model";
import { type AttentionVerb, actionWord, conflictValue, oldestAge, subjectCell, unblockTodo } from "./inbox-model";
import type { AttentionHandlers } from "./use-attention";

const SECTION_GLYPH: Record<AttentionVerb, LucideIcon> = {
  review: ShieldCheck,
  unblock: TriangleAlert,
  open: ArrowUpRight,
  inspect: Bot,
  resolve: ArrowLeftRight,
};

/** A section: its sticky header folds it, and a folded section draws no rows. */
export function InboxSection({
  section,
  folded,
  onToggle,
  children,
}: {
  section: AttentionSection;
  folded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const Glyph = SECTION_GLYPH[section.rows[0]!.action.verb] ?? ArrowUpRight;
  return (
    <section aria-label={section.label} data-attention-section={section.kind}>
      <h2 className="sticky top-0 z-[2] m-0">
        <button
          type="button"
          aria-expanded={!folded}
          onClick={onToggle}
          className="flex h-[34px] w-full cursor-pointer items-center gap-2 border-b bg-surface-sunken pr-4 pl-3 text-left text-label font-semibold text-text-secondary outline-none focus-ring-inset @max-[860px]/inbox:h-9"
        >
          <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 text-text-tertiary motion-safe:transition-transform", folded && "-rotate-90")} />
          <Glyph aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{section.label}</span>
          <span className="font-normal text-text-tertiary tabular-nums">{section.rows.length}</span>
          <span className="ml-auto shrink-0 font-normal text-text-tertiary tabular-nums">{`oldest ${formatAgo(oldestAge(section.rows))}`}</span>
        </button>
      </h2>
      {folded ? null : <div role="list">{children}</div>}
    </section>
  );
}

/**
 * What acting on a row does, from a click anywhere on it or from Enter: a conflict opens or
 * closes in place; everything else goes where it names.
 */
export function actOnRow(
  row: AttentionRow,
  state: { busy: boolean; expanded: boolean },
  handlers: AttentionHandlers,
  onExpand: (open: boolean) => void,
): void {
  if (state.busy || attentionGo(row) === null) return;
  if (row.action.verb === "resolve") onExpand(!state.expanded);
  else handlers.act(row);
}

const WIDE_GRID = "@min-[860px]/inbox:grid-cols-[6px_68px_minmax(0,1.05fr)_minmax(0,1fr)_132px_36px_84px_28px]";
const WIDE_GRID_ONE_WS = "@min-[860px]/inbox:grid-cols-[6px_68px_minmax(0,1.05fr)_minmax(0,1fr)_36px_84px_28px]";

export function InboxRow({
  row,
  allWorkspaces,
  isNew,
  selected,
  busy,
  expanded,
  active,
  handlers,
  onExpand,
  rowRef,
}: {
  row: AttentionRow;
  /** All workspaces: the row names its workspace. */
  allWorkspaces: boolean;
  isNew: boolean;
  /** Its ticket is open in the drawer. */
  selected: boolean;
  /** A write is running for it. */
  busy: boolean;
  /** A conflict open in place. */
  expanded: boolean;
  /** It holds the list's one tab stop: it and its buttons are in the tab order. */
  active: boolean;
  handlers: AttentionHandlers;
  onExpand: (open: boolean) => void;
  rowRef?: (element: HTMLElement | null) => void;
}) {
  const conflictId = useId();
  const subject = rowSubject(row);
  const named = subject ? `${subject} ${row.title}` : row.title;
  const verb = row.action.verb;
  const resolves = verb === "resolve";
  const todo = unblockTodo(row);
  const tabIndex = active ? 0 : -1;
  // A row that names nothing to open is not actionable at all. A busy row keeps its buttons
  // focusable (`aria-disabled`, not `disabled`): disabling the focused button would drop focus to the page.
  const inert = attentionGo(row) === null;
  const age = formatAgo(row.ageSeconds);

  return (
    <div
      role="listitem"
      ref={rowRef}
      tabIndex={tabIndex}
      aria-current={selected ? "true" : undefined}
      aria-busy={busy || undefined}
      data-attention-row={row.key}
      data-attention-kind={row.kind}
      // Where the drawer returns focus when it closes (detail/focus-return.ts).
      data-identifier={row.ref ?? undefined}
      onClick={(event) => {
        // The buttons and the conflict's own buttons do their own thing.
        if ((event.target as HTMLElement).closest("button, [data-attention-conflict]")) return;
        actOnRow(row, { busy, expanded }, handlers, onExpand);
      }}
      className={cn(
        "group/row relative grid cursor-pointer items-start gap-x-2.5 gap-y-px border-b border-border/60 py-[9px] pr-2 pl-3 outline-none hover:bg-surface-hover focus-ring-inset",
        row.dismissible ? "grid-cols-[6px_minmax(0,1fr)_auto_auto]" : "grid-cols-[6px_minmax(0,1fr)_auto]",
        "@min-[860px]/inbox:min-h-[38px] @min-[860px]/inbox:items-center @min-[860px]/inbox:gap-x-3 @min-[860px]/inbox:gap-y-0 @min-[860px]/inbox:py-0 @min-[860px]/inbox:pr-3 @min-[860px]/inbox:pl-4",
        allWorkspaces ? WIDE_GRID : WIDE_GRID_ONE_WS,
        selected && "bg-surface-selected hover:bg-surface-selected",
        busy && "opacity-60",
      )}
    >
      <span className="col-start-1 row-start-1 self-center @min-[860px]/inbox:col-auto @min-[860px]/inbox:row-auto">
        {isNew ? (
          <span data-attention-new="" title="New since you last looked" className="block size-1.5 rounded-full bg-[var(--status-task-in_progress)]">
            <span className="sr-only">New</span>
          </span>
        ) : null}
      </span>
      <span className="hidden truncate font-mono text-label text-text-tertiary @min-[860px]/inbox:block" title={subject ?? undefined}>
        {subjectCell(row)}
      </span>
      <span
        className={cn(
          "col-start-2 row-start-1 min-w-0 truncate text-body font-medium text-foreground @max-[860px]/inbox:line-clamp-2 @max-[860px]/inbox:whitespace-normal @max-[860px]/inbox:text-reading @min-[860px]/inbox:col-auto @min-[860px]/inbox:row-auto",
          isNew && "font-semibold",
        )}
        title={row.title}
      >
        {row.title}
      </span>
      <span
        data-attention-detail=""
        className="col-start-2 row-start-2 min-w-0 truncate text-label text-text-secondary @max-[860px]/inbox:line-clamp-2 @max-[860px]/inbox:whitespace-normal @max-[860px]/inbox:text-body @min-[860px]/inbox:col-auto @min-[860px]/inbox:row-auto"
      >
        {row.conflict ? (
          <>
            <span className="font-medium text-foreground">{row.conflict.field}</span> differs between two devices
          </>
        ) : todo ? (
          <>
            {row.detail} · <span className="font-medium text-foreground">{todo}</span>
          </>
        ) : (
          row.detail
        )}
      </span>
      <span className="col-start-2 row-start-3 mt-[3px] flex min-w-0 items-center gap-1.5 text-label text-text-tertiary @min-[860px]/inbox:hidden">
        {subject ? (
          <>
            <span className="shrink-0 font-mono">{subject}</span>
            <span aria-hidden>·</span>
          </>
        ) : null}
        {allWorkspaces ? (
          <>
            <span className="min-w-0 truncate">{row.workspace}</span>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <time dateTime={row.since} title={row.since} className="shrink-0 tabular-nums">
          {ageText(row)}
        </time>
      </span>
      {allWorkspaces ? (
        <span className="hidden min-w-0 justify-end @min-[860px]/inbox:flex">
          <span
            className="staple-row-workspace"
            // The task row's pill, allowed the whole column before it truncates.
            style={{ maxWidth: "100%" }}
            data-attention-workspace={row.workspace}
            title={`Workspace: ${row.workspace}`}
          >
            {row.workspace}
          </span>
        </span>
      ) : null}
      <time dateTime={row.since} title={row.since} className="hidden text-right text-label text-text-tertiary tabular-nums @min-[860px]/inbox:block">
        <span aria-hidden>{age}</span>
        <span className="sr-only">{ageText(row)}</span>
      </time>
      <RowAction
        row={row}
        label={`${actionWord(verb)} ${named}`}
        inert={inert}
        busy={busy}
        expanded={expanded}
        conflictId={conflictId}
        tabIndex={tabIndex}
        handlers={handlers}
        onExpand={onExpand}
      />
      {row.dismissible ? (
        <button
          type="button"
          tabIndex={tabIndex}
          aria-disabled={busy || undefined}
          data-attention-dismiss={row.key}
          aria-label={`Dismiss ${named}`}
          title="Dismiss"
          onClick={() => {
            if (!busy) handlers.dismiss(row);
          }}
          className="col-start-4 row-[1/span_3] inline-flex size-10 cursor-pointer items-center justify-center self-center rounded-md text-text-tertiary outline-none hover:bg-surface-selected hover:text-foreground focus-ring aria-disabled:cursor-default aria-disabled:opacity-50 pointer-coarse:size-11 @min-[860px]/inbox:col-auto @min-[860px]/inbox:row-auto @min-[860px]/inbox:size-7"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      ) : null}
      {resolves && expanded ? (
        <ConflictInPlace
          id={conflictId}
          row={row}
          conflict={row.conflict}
          busy={busy}
          tabIndex={tabIndex}
          handlers={handlers}
        />
      ) : null}
    </div>
  );
}

const ACTION_CLASS =
  "col-start-3 row-[1/span_3] inline-flex h-9 cursor-pointer items-center justify-center gap-[3px] self-center rounded-md text-label font-medium whitespace-nowrap text-text-tertiary outline-none hover:bg-surface-selected group-hover/row:text-foreground group-focus-visible/row:text-foreground focus-visible:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50 pointer-coarse:h-11 @min-[860px]/inbox:col-auto @min-[860px]/inbox:row-auto @min-[860px]/inbox:h-[26px] @min-[860px]/inbox:w-auto @min-[860px]/inbox:justify-self-end @min-[860px]/inbox:px-2";

/**
 * The row's one action, a real button named after the row. Compact, it is a square chevron
 * with the verb only in its name, except Resolve, which keeps its word.
 */
function RowAction({
  row,
  label,
  inert,
  busy,
  expanded,
  conflictId,
  tabIndex,
  handlers,
  onExpand,
}: {
  row: AttentionRow;
  label: string;
  /** Nothing to open: the row has no ticket, run or conflict. */
  inert: boolean;
  busy: boolean;
  expanded: boolean;
  conflictId: string;
  tabIndex: number;
  handlers: AttentionHandlers;
  onExpand: (open: boolean) => void;
}) {
  const verb = row.action.verb;
  const resolves = verb === "resolve";
  const Chevron = resolves ? (expanded ? ChevronUp : ChevronDown) : ChevronRight;
  const className = cn(ACTION_CLASS, resolves ? "px-2" : "w-9 pointer-coarse:w-11");
  const content = (
    <>
      <span className={resolves ? undefined : "hidden @min-[860px]/inbox:inline"}>{actionWord(verb)}</span>
      <Chevron aria-hidden className="size-3.5 shrink-0" />
    </>
  );

  return (
    <button
      type="button"
      tabIndex={tabIndex}
      disabled={inert}
      aria-disabled={busy || undefined}
      aria-label={label}
      aria-expanded={resolves ? expanded : undefined}
      aria-controls={resolves && expanded ? conflictId : undefined}
      data-attention-action={verb}
      onClick={() => {
        if (busy) return;
        if (resolves) onExpand(!expanded);
        else handlers.act(row);
      }}
      className={className}
    >
      {content}
    </button>
  );
}

/** A sync conflict opened under its row: both values, when the row carries them, and which to keep. */
function ConflictInPlace({
  id,
  row,
  conflict,
  busy,
  tabIndex,
  handlers,
}: {
  id: string;
  row: AttentionRow;
  conflict: AttentionRow["conflict"];
  busy: boolean;
  tabIndex: number;
  handlers: AttentionHandlers;
}) {
  const sides = [
    { take: "local" as const, label: "This device", value: conflict ? conflictValue(conflict.localValue) : null, button: "Keep this device's" },
    { take: "remote" as const, label: "Other device", value: conflict ? conflictValue(conflict.remoteValue) : null, button: "Take the other's" },
  ];
  return (
    <div
      id={id}
      data-attention-conflict=""
      className="col-[2/-1] row-start-4 grid cursor-default grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 pt-2 pb-1 text-label @min-[860px]/inbox:col-[3/-1] @min-[860px]/inbox:row-auto @min-[860px]/inbox:grid-cols-[auto_minmax(0,1fr)_auto] @min-[860px]/inbox:pt-0.5 @min-[860px]/inbox:pb-3"
    >
      {sides.map((side) => (
        <div key={side.take} className="contents">
          <span className="col-span-full -mb-1 text-text-tertiary @min-[860px]/inbox:col-auto @min-[860px]/inbox:mb-0">{side.label}</span>
          <span className="min-w-0 truncate font-mono text-text-secondary" title={side.value ?? undefined}>
            {side.value}
          </span>
          <Button
            variant="outline"
            size="sm"
            tabIndex={tabIndex}
            aria-disabled={busy || undefined}
            data-attention-take={side.take}
            onClick={() => {
              if (!busy) handlers.resolve(row, side.take);
            }}
            className="pointer-coarse:min-h-11"
          >
            {side.button}
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Loading: the list's own shape, so the page does not jump when the rows arrive. */
export function InboxSkeleton() {
  const widths = Array.from({ length: 9 }, (_, i) => ({ title: 52 + ((i * 37) % 40), why: 40 + ((i * 23) % 45) }));
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-attention-loading="">
      <span className="sr-only">Loading</span>
      <div aria-hidden className="flex h-[34px] items-center border-b bg-surface-sunken pl-3 @max-[860px]/inbox:h-9">
        <Skeleton className="h-3 w-40 rounded-full" />
      </div>
      {widths.map((width, i) => (
        <div key={i} aria-hidden className="border-b border-border/60">
          <div className="hidden min-h-[38px] grid-cols-[6px_68px_minmax(0,1.05fr)_minmax(0,1fr)_36px_84px] items-center gap-x-3 pr-3 pl-4 @min-[860px]/inbox:grid">
            <span />
            <Skeleton className="h-3 w-[52px] rounded-full" />
            <Skeleton className="h-3 rounded-full" style={{ width: `${width.title}%` }} />
            <Skeleton className="h-3 rounded-full" style={{ width: `${width.why}%` }} />
            <Skeleton className="h-3 w-6 justify-self-end rounded-full" />
            <span />
          </div>
          <div className="flex flex-col gap-2 py-3 pr-4 pl-[28px] @min-[860px]/inbox:hidden">
            <Skeleton className="h-3.5 rounded-full" style={{ width: `${width.title}%` }} />
            <Skeleton className="h-3 rounded-full" style={{ width: `${width.why}%` }} />
            <Skeleton className="h-2.5 w-32 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A workspace the page could not read: one row-height banner, above the rows. */
export function FailedBanner({ workspace, message }: { workspace: string; message: string }) {
  return (
    <div
      data-attention-failed={workspace}
      className="flex min-h-[38px] items-center gap-2.5 border-b border-[var(--plain-risk-border)] bg-[var(--plain-risk-bg)] py-2 pr-3 pl-4 text-label text-[var(--plain-risk-fg)]"
    >
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0">{`Could not read ${workspace}: ${message}`}</span>
    </div>
  );
}

/** The foot of a one-workspace list: how many wait elsewhere, and the way to see them. */
export function ElsewhereLine({ count, onShowAll }: { count: number; onShowAll?: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-5 text-label text-text-tertiary">
      {`${count} more waiting in other workspaces.`}
      <button
        type="button"
        onClick={onShowAll}
        className="cursor-pointer rounded-sm font-medium text-foreground underline underline-offset-2 outline-none focus-ring pointer-coarse:min-h-11"
      >
        Show all workspaces
      </button>
    </p>
  );
}
