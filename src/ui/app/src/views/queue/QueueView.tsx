/**
 * The Queue destination — R2d (STA-169), docs/queue.md, redesigned.
 *
 * ── WHAT THIS VIEW IS, AND THE TWO THINGS IT USED TO BE ───────────────────────────────
 *
 * It was two panes over one payload: THE PLAN on the left and THE EFFECTIVE ORDER on the
 * right. Both were correct and, put side by side against a real plan, they were the same
 * list twice — every right-hand row already appeared on the left carrying the same numbers.
 * The second pane read as a duplicate rather than as a second question answered, and the
 * relationship between the two was spelled out per row in monospace (`expands to 8`,
 * `pickup #10`, `#2 · from plan #1`): three numbering scales in one list.
 *
 * A first redesign made the left pane a real tree and turned the right pane into a rail that
 * read whichever row you selected. That fixed the duplication and kept a defect: the rail's
 * verbs did not survive contact with the data. "Add to plan" sat on a DESCENDANT that was
 * already going to be worked — it is in the effective order because its parent is queued — so
 * the button a reader was most likely to press was the one that read as a contradiction. And
 * a panel whose contents change by selection is a second place to look for actions that the
 * row's own `⋯` already owns.
 *
 * So there is now ONE THING ON THIS PAGE: the pickup order, full width, as a tree.
 *
 *   THE ORDER is the plan in plan order, with every queued container's expansion nested
 *   underneath it on the tree view's own connector rails. "This is a descendant of that" is
 *   read from the SHAPE. That is the whole redesign: the old flat list forced a reader to
 *   guess whether an indented row was a subtask, a blocker or something the row above was
 *   blocking, and the answer — it is a descendant, always — was nowhere on screen.
 *
 *   THE BAND across the top is the one fact a panel was never needed for: the row an agent
 *   asking right now would be handed.
 *
 *   THE `⋯` MENU is where every row action lives, here and on the tree, so there is exactly
 *   one place to look for them.
 *
 * ── WORK THAT IS ALREADY IN FLIGHT ────────────────────────────────────────────────────
 *
 * An agent claiming a row while you are looking at it changes NOTHING about where the row is.
 * docs/queue.md: "Rows are never dropped for being ineligible", and `queue-store.ts` gives it
 * `eligibility: "claimed"` with the store's own sentence (`held by codex-1`) and the holder in
 * `detail`. So the row keeps its place, wears the app's existing live treatment, and its
 * ordinal dims — a number that is no longer a turn that is coming. Nothing moves under the
 * cursor, nothing disappears, nothing is on a timer: the 1.5s poll re-reads and the row
 * corrects itself. A view that lifted claimed work into a section of its own would make the
 * order rearrange itself while somebody was reading it, which is the one thing an order must
 * not do.
 *
 * ── ONE NUMBER, ON THE ROWS IT DESCRIBES ──────────────────────────────────────────────
 *
 * A leaf prints its effective position and nothing else. A container prints `step N` — its
 * place in the plan — and no ordinal, because it is never a checkout target and inventing a
 * position for it would be the lie `row-cues.ts` refuses to tell. `from plan #N` is gone:
 * the row is drawn UNDERNEATH the plan row it came from. See `rowOrdinal` in queue-model.ts.
 *
 * ── THE PLAN IS SHOWN WHOLE, RESOLVED ROWS INCLUDED ───────────────────────────────────
 *
 * The read is `all: true` unconditionally, and no longer follows the page's Done filter.
 * Following it was a real defect rather than a preference: the resolver reserves a plan
 * position for a resolved entry, so filtering the entry out of `entries` left the list
 * numbered `1, 3, 4, 5` with nothing on screen explaining the gap — and hid the Prune
 * control at the same time, because `entries.filter(resolved)` was empty once the entries
 * were gone. Resolved rows are dimmed in place instead. The plan is a thing a human wrote;
 * a view of it that silently omits a step is not a view of it.
 *
 * ── WHAT DID NOT CHANGE, DELIBERATELY ─────────────────────────────────────────────────
 *
 * ONE ATOMIC REORDER PATH. Drag, alt+arrow, alt+Home/End and the menu's two moves all
 * end in `applyOrder(order)`, which is one `POST /api/queue/reorder` carrying
 * `baseRevision: view.revision`. The drag is still `settings/form/ReorderList`, which
 * already funnels its pointer and keyboard paths into a single `onMove(from, to)`. There is
 * still deliberately no second write path.
 *
 * A STALE REORDER. `revision_conflict` still means the store changed nothing, so the
 * server's order is still the truth: the view drops what it was showing, re-reads, and puts
 * the conflict up with the same TWO deliberate ways out — Reload and Retry my order.
 *
 * NOTHING ABOUT ORDER OR ELIGIBILITY IS DERIVED HERE. Expansion, the unqueued band and the
 * ladder are `store.queue().effectiveQueue()`'s, on every surface. This view joins, shapes
 * and words what it is sent.
 *
 * The presentational pieces take everything as props and read no context, so
 * `queue-render.test.tsx` renders them to static markup.
 */
import { ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { QueueRowMenu, queueRowMenuState } from "@/components/QueueRowMenu";
import {
  clampIndex,
  resolveTaskListConfig,
  TaskRowLine,
  useRovingFocus,
  type TaskRow,
} from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { SearchableSelect, type SelectOption } from "@/components/ui/searchable-select";
import { taskOption, withoutValues } from "@/components/createIssueForm";
import { ReorderList } from "@/settings/form/ReorderList";
import {
  dequeueTask,
  enqueueTask,
  getQueue,
  isRevisionConflict,
  pruneQueue,
  reorderQueue,
  type AuthError,
} from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import type { EffectiveQueueRow, IssueRow, QueueEligibility, QueueView as QueueViewData } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState } from "@/views/ViewChrome";
import {
  effectivePreview,
  ELIGIBILITY_PRESENTATION,
  EXPANSION_PREVIEW_LIMIT,
  movedOrder,
  orderForPosition,
  planRows,
  previewOf,
  reasonLabel,
  retryOrder,
  rowOrdinal,
  type EffectivePreview,
  type PlanRow,
} from "./queue-model";
import { knownRows, queueTreeRows, type QueueTreeRow } from "./queue-tree";

/**
 * THE ROW, EVERYWHERE ON THIS VIEW.
 *
 * `tree` rather than `panel`, which is the redesign in one line: the queue draws the same
 * row the tree draws, at the same density, with the same glyphs and the same connectors. The
 * two overrides are both subtractions — there is no multi-select here, and the `⋯` would be
 * a second way to reach actions the rail already owns for the selected row.
 */
const QUEUE_ROW_CONFIG = resolveTaskListConfig("tree", {
  columns: { select: false, disclosure: true, actions: true },
});

/** What the view shows when a write went wrong, and how it went wrong. */
export interface QueueWriteFailure {
  kind: "conflict" | "refusal";
  refusal: Refusal;
  /** The order the refused write wanted, so a conflict can offer to re-apply it. */
  intended: readonly string[] | null;
}

/** Everything the `⋯` on a queue row can do. Built by the view, one closure per row. */
export type QueueRowActions = (row: TaskRow, trigger: ReactNode) => ReactNode;

/** Is somebody holding this row right now — the resolver's answer, or the page's claim. */
function inFlight(effective: EffectiveQueueRow | null, row: TaskRow): boolean {
  return effective?.eligibility === "claimed" || row.claim !== null;
}

// ---------- small pieces ----------

/**
 * THE PICKUP NUMBER, marked as one.
 *
 * `#` is the EFFECTIVE scale throughout this app — `row-cues.ts` spells a plan position
 * `plan #2` and a pickup position `#2` precisely so the two can never be read as one — and
 * the queue's gutter now holds both scales at different indents: a plan entry prints its
 * plan position bare, a nested descendant prints its pickup number with the `#`. Without the
 * mark the column read `1 / 10 / 4 / 14`, which is two scales wearing the same clothes.
 */
function ordinalLabel(row: EffectiveQueueRow | null): ReactNode {
  const at = rowOrdinal(row);
  return at === null ? null : `#${at}`;
}

/** Glyph AND word, never colour alone. `data-queue-eligibility` is what a test keys on. */
export function EligibilityBadge({ eligibility }: { eligibility: QueueEligibility }) {
  const { glyph, label } = ELIGIBILITY_PRESENTATION[eligibility];
  return (
    <span
      data-queue-eligibility={eligibility}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium"
    >
      <span aria-hidden className="font-mono">
        {glyph}
      </span>
      {label}
    </span>
  );
}

/**
 * THE ORDINAL GUTTER — one fixed-width column down the whole list, so every number shares a
 * right edge and the rows underneath a container line up with the rows beside it.
 *
 * It holds at most one thing per row and is EMPTY rather than absent when there is nothing
 * to say: a container's row, a bracket, an unqueued row. Reserved width is what keeps the
 * task rows on one left edge, which is the alignment the whole tree language depends on.
 */
function Gutter({ children, dim = false }: { children?: ReactNode; dim?: boolean }) {
  return (
    <span
      aria-hidden={children ? undefined : true}
      className={cn(
        "w-12 shrink-0 pr-2 text-right font-mono text-[11px] tabular-nums text-text-tertiary",
        // IN FLIGHT: somebody is holding this row, so its number is not a turn that is
        // coming. The number stays — it is still where the row sits — it just stops
        // advertising. See the header.
        dim && "opacity-45",
      )}
    >
      {children}
    </span>
  );
}

/**
 * WHAT AN AGENT ASKING RIGHT NOW WOULD BE HANDED.
 *
 * A band rather than a panel. It is one fact, it never changes by selection, and it is the
 * only thing the deleted rail said that a reader could not get from the list itself.
 */
export function NextUpBand({
  next,
  onOpen,
}: {
  next: EffectiveQueueRow | null;
  onOpen: (identifier: string) => void;
}) {
  return (
    <section
      data-queue-next-up
      data-queue-next={next ? "eligible" : "none"}
      className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-2"
    >
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
        Next up
      </span>
      {next ? (
        <>
          <span data-queue-next-ref className="shrink-0 font-mono text-[12px] text-text-tertiary">
            {next.identifier}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">{next.title}</span>
          <Button variant="outline" size="xs" onClick={() => onOpen(next.identifier)}>
            Open
          </Button>
        </>
      ) : (
        <span className="min-w-0 flex-1 text-[13px] text-muted-foreground">
          Nothing is pickable right now — every row is waiting on something.
        </span>
      )}
    </section>
  );
}

/**
 * ONE ROW OF THE QUEUE TREE: the gutter, then the shared task row.
 *
 * Clicking it SELECTS rather than opens. That is the deliberate difference from the tree
 * view, and it is what makes the rail work: this view's question is "what is this and what
 * do I do with it", and answering it in a rail beside the list beats throwing a drawer over
 * the order the reader is trying to read. Opening is still one click away — the arrow button
 * on the row, and the rail's own Open.
 */
export function QueueTreeLine({
  entry,
  ordinal,
  focused,
  now,
  actions,
  onOpen,
  onToggle,
  onFocus,
  onKeyDown,
  registerRef,
}: {
  entry: QueueTreeRow;
  ordinal: ReactNode;
  focused: boolean;
  now: Date;
  actions?: QueueRowActions;
  onOpen: () => void;
  onToggle?: () => void;
  onFocus?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  registerRef?: (element: HTMLDivElement | null) => void;
}) {
  const identifier = entry.row.issue.identifier;
  const live = inFlight(entry.effective, entry.row);
  return (
    <div
      data-queue-tree-row={identifier}
      data-queue-bracket={entry.effective === null ? "true" : undefined}
      data-queue-inflight={live ? "true" : undefined}
      className="flex min-w-0 items-center rounded-md"
    >
      <Gutter dim={live}>{ordinal}</Gutter>
      <div className="min-w-0 flex-1">
        {/*
          `list` SEMANTICS, NOT `bare` — and the difference is the whole keyboard story.
          `bare` means "the host is already the option and already owns focus", which is true
          of cmdk and was NOT true here: the host was a plain `<li>`, so the rows had no role,
          no tab stop and no key handling. `list` gives the row `role="option"`, the roving
          `tabIndex` and the arrow keys, which is what this list actually is: a set of things,
          pick one.
        */}
        <TaskRowLine
          row={entry.row}
          config={QUEUE_ROW_CONFIG}
          semantics="list"
          now={now}
          isExpanded={entry.row.isExpanded}
          isFocused={focused}
          /*
           * THE RESOLVER'S OWN SENTENCE, ON THE ROW. `caption` is exactly the slot for it (see
           * TaskRowLine): one muted trailing sentence inside the title cell, costing no height
           * and eating only space the title was going to have. "Why can nobody take this" is a
           * question a reader asks while SCANNING, and an answer that needs a click first is
           * an answer they will not get.
           */
          caption={entry.effective ? reasonLabel(entry.effective) ?? undefined : undefined}
          onOpen={onOpen}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onToggleExpand={onToggle}
          actionsMenu={actions ? (trigger) => actions(entry.row, trigger) : undefined}
          registerRef={registerRef}
        />
      </div>
    </div>
  );
}

/**
 * ONE LISTBOX OF QUEUE ROWS, with the tab stop and the arrow keys the tree already owes.
 *
 * `useRovingFocus` is the SAME hook `TreeGrid` and `TaskList` use — exactly one row in the
 * list is tabbable and the arrows move which one — so a reader who has learned the tree has
 * learned this. Enter and Space select, which is `role="option"`'s own contract, and moving
 * focus selects too: the rail is a reading of the row you are on, and a keyboard user who had
 * to press an extra key to see it would be reading a stale panel the whole way down the list.
 */
function QueueRowList({
  label,
  rows,
  ordinalOf,
  now,
  actions,
  onOpen,
  onToggle,
  testAttr,
}: {
  label: string;
  rows: readonly QueueTreeRow[];
  ordinalOf: (entry: QueueTreeRow) => ReactNode;
  now: Date;
  actions?: QueueRowActions;
  onOpen: (identifier: string) => void;
  onToggle?: (identifier: string) => void;
  testAttr?: Record<string, string>;
}) {
  const keys = useMemo(() => rows.map((entry) => entry.row.issue.identifier), [rows]);
  const focus = useRovingFocus(keys);

  return (
    <div role="listbox" aria-label={label} className="flex flex-col" {...testAttr}>
      {rows.map((entry, index) => {
        const identifier = entry.row.issue.identifier;
        return (
          <QueueTreeLine
            key={identifier}
            entry={entry}
            ordinal={ordinalOf(entry)}
            focused={focus.activeKey === identifier}
            now={now}
            actions={actions}
            onOpen={() => onOpen(identifier)}
            onToggle={entry.row.hasChildren && onToggle ? () => onToggle(identifier) : undefined}
            onFocus={() => focus.set(identifier)}
            registerRef={focus.register(identifier)}
            onKeyDown={(event) => {
              const at = (i: number) => keys[clampIndex(i, keys.length)]!;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focus.go(at(index + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                focus.go(at(index - 1));
              }
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * WHAT A QUEUED CONTAINER EXPANDS TO, nested under the container's own row.
 *
 * Capped, with the remainder counted rather than hidden, exactly as before: a queued epic
 * can be a dozen children deep and a plan of five epics would otherwise be sixty rows of
 * somebody else's problem. What changed is only the SHAPE — the rows shown are the same
 * rows, in the same effective order, drawn on the tree's rails so their relationship to the
 * container is visible instead of stated.
 */
function PlanRowExpansion({
  plan,
  known,
  workspace,
  now,
  collapsed,
  actions,
  onOpen,
  onToggle,
}: {
  plan: PlanRow;
  known: ReadonlyMap<string, IssueRow>;
  workspace: string;
  now: Date;
  collapsed: ReadonlySet<string>;
  actions?: QueueRowActions;
  onOpen: (identifier: string) => void;
  onToggle: (identifier: string) => void;
}) {
  const { shown, hidden } = useMemo(
    () => previewOf(plan.expansion, EXPANSION_PREVIEW_LIMIT),
    [plan.expansion],
  );
  /*
   * MEMOISED. This builds a forest, a walk and one synthesised `Issue` per row, and the view
   * re-renders on every keystroke in the add box, every selection and every fold — not only
   * on the 1.5s poll. Without this, typing in the search field rebuilt the whole expansion of
   * every queued container per character.
   */
  const rows = useMemo(
    () => queueTreeRows(shown, { known, workspace, root: plan.entry.identifier, collapsed }),
    [shown, known, workspace, plan.entry.identifier, collapsed],
  );
  return (
    <div data-queue-expansion={plan.entry.identifier}>
      <QueueRowList
        label={`What ${plan.entry.identifier} expands to`}
        rows={rows}
        ordinalOf={(entry) => ordinalLabel(entry.effective)}
        now={now}
        actions={actions}
        onOpen={onOpen}
        onToggle={onToggle}
      />
      {hidden > 0 ? (
        <p data-queue-expansion-more className="px-2 pb-1 pl-16 text-[11px] text-text-tertiary">
          and {hidden} more under {plan.entry.identifier}
        </p>
      ) : null}
    </div>
  );
}

/**
 * NOT PLANNED — the unqueued band, folded.
 *
 * docs/queue.md: "the queue is a prefix, not a filter", and this is that sentence as a
 * control. Folded by default because it is every other open leaf in the workspace and would
 * otherwise be most of the screen; open it and the rows are the same tree rows, so a reader
 * comparing planned work to unplanned work is comparing like with like.
 */
export function UnqueuedSection({
  preview,
  known,
  workspace,
  now,
  open,
  actions,
  onToggleOpen,
  onOpen,
}: {
  preview: EffectivePreview;
  known: ReadonlyMap<string, IssueRow>;
  workspace: string;
  now: Date;
  open: boolean;
  actions?: QueueRowActions;
  onToggleOpen: () => void;
  onOpen: (identifier: string) => void;
}) {
  const total = preview.unqueued.length + preview.unqueuedHidden;
  // Memoised for the reason `PlanRowExpansion`'s is; empty while folded costs nothing.
  const rows = useMemo(
    () => (open ? queueTreeRows(preview.unqueued, { known, workspace, root: null }) : []),
    [open, preview.unqueued, known, workspace],
  );
  if (total === 0) return null;
  return (
    <section data-queue-unqueued-section className="mt-3 border-t pt-2">
      <button
        type="button"
        data-queue-unqueued-toggle
        aria-expanded={open}
        onClick={onToggleOpen}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        <span className="font-medium">Not planned</span>
        <span data-queue-unqueued-count className="text-text-tertiary">
          {total} {total === 1 ? "item" : "items"} · picked up after the plan
        </span>
      </button>
      {open ? (
        <>
          <QueueRowList
            label="Work that is not in the plan"
            rows={rows}
            /* No ordinal: these rows are not in the plan, and the section says so once. */
            ordinalOf={() => null}
            now={now}
            actions={actions}
            onOpen={onOpen}
            testAttr={{ "data-queue-unqueued": "true" }}
          />
          {preview.unqueuedHidden > 0 ? (
            <p data-queue-unqueued-more className="px-2 py-1 pl-16 text-[11px] text-text-tertiary">
              and {preview.unqueuedHidden} more
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * ONE PLAN ENTRY.
 *
 * The bordered position `<input>` that used to sit here is gone: it put a form control on
 * every row of a list, which is what made the plan read as a form rather than as an order.
 * Moving a row is drag, alt+arrow, alt+Home/End and the `⋯`'s two moves — four paths, all
 * landing in the one `reorder` write.
 */
function PlanRowContent({
  plan,
  now,
  busy,
  expanded,
  actions,
  onOpen,
  onToggleExpand,
  onMoveToEdge,
}: {
  plan: PlanRow;
  now: Date;
  busy: boolean;
  expanded: boolean;
  actions?: QueueRowActions;
  onOpen: (workspace: string, identifier: string) => void;
  onToggleExpand: () => void;
  onMoveToEdge: (identifier: string, edge: "first" | "last") => void;
}) {
  const { entry } = plan;
  /*
   * A queued CONTAINER gets the ordinary chevron, driven by the ordinary fold state — the same
   * control the tree uses, doing the same thing. `hasChildren` is the EXPANSION rather than the
   * issue's real children: what folds here is what this entry contributes to the pickup order,
   * which is the only thing this view is drawing.
   */
  const foldable = plan.expansion.length > 0;
  const row = foldable
    ? { ...plan.row, hasChildren: true, isExpanded: expanded, childCount: plan.expansion.length }
    : plan.row;
  const live = inFlight(plan.effective, plan.row);
  return (
    <div
      data-queue-entry={entry.identifier}
      data-queue-resolved={entry.resolved ? "true" : undefined}
      data-queue-inflight={live ? "true" : undefined}
      className={cn("flex min-w-0 flex-1", entry.resolved && "opacity-55")}
      /*
       * alt+Home / alt+End, the two moves alt+arrow cannot express. They are on the CONTENT
       * rather than on the reorder row because the row is `ReorderList`'s and it owns
       * alt+arrow; a keydown from any control inside this div bubbles through here first, and
       * neither handler answers the other's keys.
       */
      onKeyDown={(event) => {
        if (!event.altKey || busy) return;
        if (event.key === "Home") {
          event.preventDefault();
          onMoveToEdge(entry.identifier, "first");
        } else if (event.key === "End") {
          event.preventDefault();
          onMoveToEdge(entry.identifier, "last");
        }
      }}
    >
      <div className="flex min-w-0 flex-1 items-center rounded-md">
        {/*
          THE PLAN POSITION, always, and bare. Every top-level row prints the same scale, so the
          column reads 1, 2, 3, 4, 5 with no gaps — resolved rows included, which is the
          numbering hole this redesign set out to close. Pickup numbers live one indent in,
          wearing a `#`.
        */}
        <Gutter dim={live}>{entry.planPosition}</Gutter>
        <div className="min-w-0 flex-1">
          <TaskRowLine
            row={row}
            config={QUEUE_ROW_CONFIG}
            semantics="bare"
            now={now}
            isExpanded={expanded}
            caption={plan.effective ? reasonLabel(plan.effective) ?? undefined : undefined}
            onOpen={() => onOpen(plan.row.workspace, entry.identifier)}
            onToggleExpand={foldable ? onToggleExpand : undefined}
            actionsMenu={actions ? (trigger) => actions(row, trigger) : undefined}
          />
        </div>
      </div>
    </div>
  );
}

// ---------- the board ----------

export function QueueBoard({
  view,
  rows,
  preview,
  known,
  workspace,
  now,
  busy,
  failure,
  candidates,
  collapsed,
  unqueuedOpen,
  actions,
  onOpen,
  onToggleCollapsed,
  onToggleUnqueued,
  onMove,
  onMoveToEdge,
  onAdd,
  onPrune,
  onReload,
  onRetry,
  onDismissFailure,
}: {
  view: QueueViewData;
  rows: readonly PlanRow[];
  preview: EffectivePreview;
  known: ReadonlyMap<string, IssueRow>;
  workspace: string;
  now: Date;
  busy: boolean;
  failure: QueueWriteFailure | null;
  candidates: readonly SelectOption[];
  collapsed: ReadonlySet<string>;
  unqueuedOpen: boolean;
  actions?: QueueRowActions;
  onOpen: (workspace: string, identifier: string) => void;
  onToggleCollapsed: (identifier: string) => void;
  onToggleUnqueued: () => void;
  onMove: (from: number, to: number) => void;
  onMoveToEdge: (identifier: string, edge: "first" | "last") => void;
  onAdd: (ref: string) => void;
  onPrune: () => void;
  onReload: () => void;
  onRetry: () => void;
  onDismissFailure: () => void;
}) {
  const resolved = view.entries.filter((entry) => entry.resolved).length;
  return (
    <div data-queue-board className="flex h-full min-h-0 w-full flex-col gap-3 px-4 py-3">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-[var(--tracking-heading)]">Pickup order</h2>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            <span data-queue-revision={view.revision}>
              {view.entries.length} {view.entries.length === 1 ? "entry" : "entries"} · revision{" "}
              {view.revision}
            </span>
          </div>
        </div>
        {resolved > 0 ? (
          <Button variant="outline" size="xs" disabled={busy} onClick={onPrune}>
            Prune {resolved} resolved
          </Button>
        ) : null}
      </header>

      <NextUpBand next={preview.next} onOpen={(identifier) => onOpen(workspace, identifier)} />

      {/* The one sentence that answers "so what happens to these" without a tour. */}
      <p data-queue-legend className="text-[12px] text-muted-foreground">
        Agents take work from the top down. Rows nested under an entry are what that entry
        expands to — its own open descendants.
      </p>

      {failure ? (
        failure.kind === "conflict" ? (
          <div
            role="alert"
            data-queue-conflict
            className="status-chip flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[13px]"
            data-status="blocked"
          >
            <span className="min-w-0 flex-1">
              <span className="font-medium">The plan changed elsewhere — nothing was written.</span>{" "}
              {failure.refusal.message} The order below is the server's.
            </span>
            <Button variant="outline" size="xs" disabled={busy} onClick={onReload}>
              <RefreshCw aria-hidden />
              Reload
            </Button>
            {failure.intended ? (
              <Button variant="outline" size="xs" disabled={busy} onClick={onRetry}>
                Retry my order
              </Button>
            ) : null}
          </div>
        ) : (
          <GuardRefusal refusal={failure.refusal} onDismiss={onDismissFailure} />
        )
      ) : null}

      {/*
        THE ADD CONTROL IS THE APP'S TASK PICKER, not one of its own.
        
        This was a bare `<Input>` plus a hand-rolled match list — the third dropdown in the
        app and the only one that filtered, ranked and rendered tasks its own way. The create
        dialog already asks this exact question three times (parent, blocked by, blocking) and
        answers it with `SearchableSelect`: a cmdk-backed popover over tasks THAT EXIST, so a
        ref cannot be wrong; its own order-preserving `filterOptions` rather than cmdk's fuzzy
        reordering; a status icon, a title hint and a workspace pill per row; and a `modal`
        popover so the list scrolls. All of that was already built and unit-tested next door.

        NO `onCreate`. `searchable-select.tsx` is explicit that a relation field must never
        offer to invent `STA-999`, and a queue entry is a relation: the store resolves the ref
        and would refuse it, which is the late, silent failure the control exists to remove.

        `selected` is ALWAYS EMPTY. Picking here is an ACT, not a state — the pick becomes a
        plan entry and the list below is where it now lives. Holding it as a chip in the
        control as well would show the same fact twice and invite somebody to "deselect" it,
        which is not what removing an entry from the plan is.
      */}
      <div data-queue-add>
        <SearchableSelect
          name="queue-add"
          id="queue-add"
          options={candidates}
          selected={[]}
          onChange={([ref]) => {
            if (ref) onAdd(ref);
          }}
          placeholder="Queue a task, epic or milestone…"
          actionLabel="Queue another…"
          searchPlaceholder="search or type an identifier…"
          emptyText="nothing matches — or it is already in the plan"
          disabled={busy}
          mono
          note="A plan is per workspace, so this lists this workspace's work."
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <EmptyState>
            nothing is queued — agents take work in presentation order until you put something here
          </EmptyState>
        ) : (
          <ReorderList
            items={rows}
            getId={(plan) => plan.entry.identifier}
            getLabel={(plan) => plan.entry.identifier}
            disabled={busy}
            onMove={onMove}
            renderItem={(plan) => (
              <PlanRowContent
                plan={plan}
                now={now}
                busy={busy}
                expanded={!collapsed.has(plan.entry.identifier)}
                actions={actions}
                onOpen={onOpen}
                onToggleExpand={() => onToggleCollapsed(plan.entry.identifier)}
                onMoveToEdge={onMoveToEdge}
              />
            )}
            renderBelow={(plan) => (
              <>
                {plan.entry.note ? (
                  <p data-queue-note className="pl-12 text-[11px] text-muted-foreground">
                    {plan.entry.note}
                  </p>
                ) : null}
                {plan.expansion.length > 0 && !collapsed.has(plan.entry.identifier) ? (
                  <PlanRowExpansion
                    plan={plan}
                    known={known}
                    workspace={workspace}
                    now={now}
                    collapsed={collapsed}
                    actions={actions}
                    onOpen={(identifier) => onOpen(plan.row.workspace, identifier)}
                    onToggle={onToggleCollapsed}
                  />
                ) : null}
              </>
            )}
          />
        )}

        <UnqueuedSection
          preview={preview}
          known={known}
          workspace={workspace}
          now={now}
          open={unqueuedOpen}
          actions={actions}
          onToggleOpen={onToggleUnqueued}
          onOpen={(identifier) => onOpen(workspace, identifier)}
        />
      </div>
    </div>
  );
}

// ---------- the view ----------

export function QueueView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<QueueWriteFailure | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [unqueuedOpen, setUnqueuedOpen] = useState(false);
  /** The last write's answer, shown until the next read lands — a writer redraws from its result. */
  const [written, setWritten] = useState<QueueViewData | null>(null);

  const ws = session.ws || undefined;
  const workspace = session.ws || session.workspaces[0]?.slug || "";

  /*
   * `all: true`, ALWAYS — see the file header. The plan's positions are the plan's, and a view
   * that drops a resolved entry shows a numbered list with a hole in it and hides the Prune
   * button that would fix it.
   */
  const load = useCallback(() => getQueue({ ws, all: true }), [ws]);
  const queue = useResource(load, [ws, session.version], onAuthError);
  useEffect(() => setWritten(null), [queue.data]);

  const view = written ?? queue.data ?? null;
  const issues = session.issues.data ?? [];
  const now = useMemo(() => new Date(), [view]);
  const known = useMemo(() => knownRows(issues), [issues]);
  const rows = useMemo(() => (view ? planRows(view, issues, workspace) : []), [view, issues, workspace]);
  const preview = useMemo(() => (view ? effectivePreview(view) : null), [view]);
  /**
   * WHAT YOU MAY QUEUE: this workspace's work, minus what is already in the plan.
   *
   * The MAPPING is the create dialog's (`taskOption`) and the EXCLUSION is its
   * `withoutValues` — the same helper that keeps Blocked by and Blocking out of each other's
   * way, doing the same job here. The FILTERING is `SearchableSelect`'s own, which is why
   * there is no query state left in this view.
   *
   * Restricted to the workspace because a plan IS one: `/api/queue` answers for a single
   * workspace (docs/queue.md), so a foreign identifier is a ref the store would refuse.
   *
   * Excluding what is queued is not a policy the store shares — enqueuing twice is a replay
   * it answers with `replayed: true` and no write. Offering it would be offering a no-op.
   */
  const candidates = useMemo<SelectOption[]>(
    () =>
      view
        ? withoutValues(
            issues.filter((row) => row.workspace === workspace).map(taskOption),
            view.entries.map((entry) => entry.identifier),
          )
        : [],
    [issues, view, workspace],
  );
  /** The plan's identifiers, once — not a scan per row. See `queueRowMenuState`. */
  const queuedIds = useMemo(
    () => new Set((view?.entries ?? []).map((entry) => entry.identifier)),
    [view],
  );

  const write = useCallback(
    async (run: () => Promise<QueueViewData>, intended: readonly string[] | null) => {
      setBusy(true);
      try {
        const next = await run();
        setWritten(next);
        setFailure(null);
        session.refresh();
      } catch (error) {
        const conflict = isRevisionConflict(error);
        // The store changed nothing, so what is on screen is now the OLDER order. Drop it and
        // re-read: the banner's promise is that the list under it is the server's.
        if (conflict) {
          setWritten(null);
          queue.reload();
        }
        setFailure({ kind: conflict ? "conflict" : "refusal", refusal: describeRefusal(error), intended });
      } finally {
        setBusy(false);
      }
    },
    [queue, session],
  );

  /** THE ONE ATOMIC PATH. Drag, alt+arrow, alt+Home/End and the menu's moves all land here. */
  const applyOrder = useCallback(
    (order: readonly string[] | null) => {
      if (!view || !order) return;
      void write(() => reorderQueue({ ws, order, baseRevision: view.revision }), order);
    },
    [view, ws, write],
  );

  const onMove = useCallback(
    (from: number, to: number) => applyOrder(view ? movedOrder(view.entries, from, to) : null),
    [applyOrder, view],
  );

  const indexOf = useCallback(
    (identifier: string) => view?.entries.findIndex((entry) => entry.identifier === identifier) ?? -1,
    [view],
  );

  const onMoveToEdge = useCallback(
    (identifier: string, edge: "first" | "last") =>
      applyOrder(
        view ? orderForPosition(view.entries, indexOf(identifier), edge === "first" ? 1 : view.entries.length) : null,
      ),
    [applyOrder, indexOf, view],
  );

  const onRemove = useCallback(
    (identifier: string) => {
      if (!view) return;
      void write(() => dequeueTask({ ws, ref: identifier, baseRevision: view.revision }), null);
    },
    [view, ws, write],
  );

  /** `at` is the wire's own "put it in front" — not a reorder computed here. */
  const onAdd = useCallback(
    (ref: string, at?: number) => {
      if (!view) return;
      void write(() => enqueueTask({ ws, ref, at, baseRevision: view.revision }), null);
    },
    [view, ws, write],
  );

  const onPrune = useCallback(() => {
    if (!view) return;
    void write(() => pruneQueue({ ws, baseRevision: view.revision }), null);
  }, [view, ws, write]);

  const onReload = useCallback(() => {
    setFailure(null);
    setWritten(null);
    queue.reload();
  }, [queue]);

  /**
   * The deliberate retry: re-apply the intent against the order the reload brought back.
   * `retryOrder` is what keeps it from undoing the other writer — see queue-model.ts.
   */
  const onRetry = useCallback(() => {
    if (!view || !failure?.intended) return;
    const order = retryOrder(failure.intended, view.entries);
    if (!order) {
      setFailure(null);
      return;
    }
    applyOrder(order);
  }, [applyOrder, failure, view]);

  const onOpen = useCallback(
    (rowWorkspace: string, identifier: string) => session.open(rowWorkspace || workspace, identifier),
    [session, workspace],
  );

  const onToggleCollapsed = useCallback((identifier: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(identifier)) next.delete(identifier);
      else next.add(identifier);
      return next;
    });
  }, []);

  /**
   * THE `⋯`, on every row of this view — the same menu the tree hangs, plus the two moves,
   * which are offered here because here there IS an order on screen to move within.
   */
  const actions = useCallback<QueueRowActions>(
    (row, trigger) => {
      const ref = row.issue.identifier;
      return (
        <QueueRowMenu
          trigger={trigger}
          identifier={ref}
          state={queueRowMenuState(row, queuedIds)}
          disabled={busy || view === null}
          onOpen={() => onOpen(row.workspace, ref)}
          onQueueNext={() => onAdd(ref, 1)}
          onQueueLast={() => onAdd(ref)}
          onDequeue={() => onRemove(ref)}
          onMoveToTop={() => onMoveToEdge(ref, "first")}
          onMoveToBottom={() => onMoveToEdge(ref, "last")}
        />
      );
    },
    [busy, onAdd, onMoveToEdge, onOpen, onRemove, queuedIds, view],
  );

  if (queue.error) return <ErrorState error={queue.error} />;
  if (!view || !preview) return <LoadingState />;

  return (
    <QueueBoard
      view={view}
      rows={rows}
      preview={preview}
      known={known}
      workspace={workspace}
      now={now}
      busy={busy}
      failure={failure}
      candidates={candidates}
      collapsed={collapsed}
      unqueuedOpen={unqueuedOpen}
      actions={actions}
      onOpen={onOpen}
      onToggleCollapsed={onToggleCollapsed}
      onToggleUnqueued={() => setUnqueuedOpen((on) => !on)}
      onMove={onMove}
      onMoveToEdge={onMoveToEdge}
      onAdd={onAdd}
      onPrune={onPrune}
      onReload={onReload}
      onRetry={onRetry}
      onDismissFailure={() => setFailure(null)}
    />
  );
}
