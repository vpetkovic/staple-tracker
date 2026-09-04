/**
 * The Queue destination — R2d (STA-169), docs/queue.md.
 *
 * Two panes over one payload. On the left THE PLAN: `entries` in plan order, the thing a
 * human edits — search and add, drag or keyboard to reorder, a position to type, a remove.
 * On the right THE EFFECTIVE ORDER: `effective`, the list an agent is actually handed,
 * with every queued container expanded to its next eligible descendants and every row that
 * cannot be picked up carrying the store's own sentence for why. Narrow viewports show one
 * pane at a time with a Back; from `md` up they split; a full-screen toggle gives either
 * pane the whole content box, the way the milestone detail's expand does.
 *
 * The presentational pieces (`QueuePlanPane`, `QueuePreviewPane`, `QueueLayout`) take
 * everything as props and read no context, so `queue-render.test.tsx` renders them to
 * static markup. `QueueView` is the one component that talks to the session and the API.
 *
 * ── ONE ATOMIC REORDER PATH ───────────────────────────────────────────────────────────
 *
 * Drag, alt+arrow, alt+Home/End and a typed position all end in `applyOrder(order)`, which
 * is one `POST /api/queue/reorder` carrying `baseRevision: view.revision` — one call, one
 * transaction, one revision bump. There is deliberately no second write path: `move` and
 * `enqueue --at` exist on the wire and would each be a different idea of what a move is.
 * The drag itself is `settings/form/ReorderList`, which already wires `@dnd-kit/core`
 * generically and already funnels its pointer and keyboard paths into a single
 * `onMove(from, to)`; a second dnd wiring in this view would be two answers to a question
 * that has one.
 *
 * ── A STALE REORDER ───────────────────────────────────────────────────────────────────
 *
 * A stale `baseRevision` is `revision_conflict` and the store changes nothing, so the
 * server's order is still the truth: the view drops whatever it was showing, re-reads, and
 * puts the conflict up as a notice with TWO deliberate ways out — Reload (abandon the
 * move) and Retry my order (re-apply the intent at the new revision, keeping whatever the
 * other writer added). Neither happens on its own; an editor that silently replayed a
 * write against an order it had not seen would be the bug this banner exists to prevent.
 */
import { ArrowLeft, ArrowRight, ArrowUpRight, Maximize2, Minimize2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { resolveTaskListConfig, TaskRowLine } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { EmptyState, ErrorState, LoadingState, SectionHeading } from "@/views/ViewChrome";
import {
  effectivePreview,
  ELIGIBILITY_PRESENTATION,
  effectivePositionLabel,
  EXPANSION_PREVIEW_LIMIT,
  layoutFor,
  movedOrder,
  nextWorkLabel,
  orderForPosition,
  pickupLabel,
  planRows,
  previewOf,
  reasonLabel,
  retryOrder,
  searchCandidates,
  type EffectivePreview,
  type PlanRow,
  type QueueLayout as LayoutName,
  type QueuePane,
} from "./queue-model";

// ---------- small pieces ----------

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
 * ONE EFFECTIVE ROW, compact.
 *
 * Deliberately not the shared `TaskRowLine`. What matters about a row here is its pickup
 * number, where in the plan it came from, whether it can be taken and the sentence saying
 * why not — four facts the shared row does not carry — and many of these rows are leaves
 * the page's issue list has never fetched, so drawing them as task rows would mean
 * synthesising an `Issue` per row to render bits nobody is reading on this pane.
 */
export function EffectiveLine({
  row,
  onOpen,
  indented = false,
}: {
  row: EffectiveQueueRow;
  onOpen: (identifier: string) => void;
  indented?: boolean;
}) {
  const reason = reasonLabel(row);
  return (
    <li
      data-queue-effective={row.identifier}
      data-queue-via={row.via ?? undefined}
      className={cn("flex flex-col gap-0.5 rounded-md px-2 py-1 hover:bg-surface-hover", indented && "pl-6")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span data-queue-effective-position className="shrink-0 font-mono text-[11px] text-text-tertiary">
          {effectivePositionLabel(row)}
        </span>
        <button
          type="button"
          aria-label={`Open ${row.identifier}`}
          onClick={() => onOpen(row.identifier)}
          className="shrink-0 font-mono text-[11px] underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          {row.identifier}
        </button>
        <span className="min-w-0 flex-1 truncate text-[12px]">{row.title}</span>
        <EligibilityBadge eligibility={row.eligibility} />
      </span>
      {reason ? (
        <span data-queue-reason className="pl-2 text-[11px] text-muted-foreground">
          {reason}
        </span>
      ) : null}
      {row.dueAt ? (
        <span data-queue-due className="pl-2 text-[11px] text-text-tertiary">
          due {row.dueAt}
        </span>
      ) : null}
    </li>
  );
}

/** A pane's header line: what it is, and the control that gives it the whole box. */
function PaneHeader({
  title,
  subtitle,
  fullScreen,
  onToggleFullScreen,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  fullScreen: boolean;
  onToggleFullScreen: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold tracking-[var(--tracking-heading)]">{title}</h2>
        {subtitle ? <div className="mt-0.5 text-[12px] text-muted-foreground">{subtitle}</div> : null}
      </div>
      {children}
      <Button
        variant="ghost"
        size="icon"
        aria-label={fullScreen ? `Collapse ${title} from full screen` : `Expand ${title} to full screen`}
        aria-pressed={fullScreen}
        title={fullScreen ? "Collapse from full screen" : "Expand to full screen"}
        onClick={onToggleFullScreen}
      >
        {fullScreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </Button>
    </header>
  );
}

// ---------- the plan ----------

/** What the plan pane shows when a write went wrong, and how it went wrong. */
export interface QueueWriteFailure {
  kind: "conflict" | "refusal";
  refusal: Refusal;
  /** The order the refused write wanted, so a conflict can offer to re-apply it. */
  intended: readonly string[] | null;
}

/** The panel row, plus the disclosure column — the same configuration the milestone members use. */
const PLAN_ROW_CONFIG = resolveTaskListConfig("panel", { columns: { disclosure: true } });

/**
 * The plan number as an EDITABLE field, which is also where "move to position N" lives.
 *
 * Uncontrolled and keyed on the value it is showing: a move re-renders the list with a new
 * number, the key changes, and the field remounts on the truth instead of holding the
 * digits somebody typed into a row that has since moved. Commit is Enter or blur; Escape
 * gives the row back its own number.
 */
function PlanPositionField({
  identifier,
  planPosition,
  disabled,
  onCommit,
}: {
  identifier: string;
  planPosition: number;
  disabled: boolean;
  onCommit: (position: number) => void;
}) {
  const commit = (raw: string) => {
    const next = Number.parseInt(raw, 10);
    if (Number.isNaN(next) || next === planPosition) return;
    onCommit(next);
  };
  return (
    <input
      key={planPosition}
      type="text"
      inputMode="numeric"
      defaultValue={String(planPosition)}
      disabled={disabled}
      aria-label={`Plan position of ${identifier}`}
      data-queue-position-field={identifier}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.currentTarget.value = String(planPosition);
        }
      }}
      onBlur={(event) => commit(event.target.value)}
      className={cn(
        "h-5 w-8 shrink-0 rounded border bg-transparent text-center font-mono text-[11px] tabular-nums",
        "text-text-tertiary outline-none focus-visible:border-ring focus-visible:text-foreground",
      )}
    />
  );
}

function PlanRowContent({
  plan,
  now,
  busy,
  onOpen,
  onMoveTo,
  onMoveToEdge,
}: {
  plan: PlanRow;
  now: Date;
  busy: boolean;
  onOpen: (workspace: string, identifier: string) => void;
  onMoveTo: (identifier: string, position: number) => void;
  onMoveToEdge: (identifier: string, edge: "first" | "last") => void;
}) {
  const { entry } = plan;
  const pickup = pickupLabel(entry.planPosition, plan.effective?.position ?? null, plan.expansion.length);
  return (
    <div
      data-queue-entry={entry.identifier}
      className="flex min-w-0 flex-1 flex-col gap-0.5"
      /*
       * alt+Home / alt+End, the two moves alt+arrow cannot express. They are on the
       * CONTENT rather than on the reorder row because the row is `ReorderList`'s and it
       * owns alt+arrow; a keydown from any control inside this div bubbles through here
       * first, and neither handler answers the other's keys. `alt` is required for the
       * same reason it is on the arrows: a bare Home inside the position field belongs to
       * the caret, and a list that stole it would make the field uneditable.
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
      <div className="flex min-w-0 items-center gap-2">
        <PlanPositionField
          identifier={entry.identifier}
          planPosition={entry.planPosition}
          disabled={busy}
          onCommit={(position) => onMoveTo(entry.identifier, position)}
        />
        {pickup ? (
          <span data-queue-pickup={entry.identifier} className="shrink-0 font-mono text-[11px] text-text-tertiary">
            {pickup}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <TaskRowLine row={plan.row} config={PLAN_ROW_CONFIG} semantics="bare" now={now} />
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Open ${entry.identifier}`}
          onClick={() => onOpen(plan.row.workspace, entry.identifier)}
        >
          <ArrowUpRight aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/**
 * WHAT A QUEUED CONTAINER EXPANDS TO, inline under the container's own row.
 *
 * Capped, with the remainder counted rather than hidden: a queued epic can be a dozen
 * children deep and a plan of five epics would otherwise be sixty rows of somebody else's
 * problem. The rows shown are the FIRST ones in effective order, which is exactly "the
 * next eligible descendants" — the resolver has already put them in the order an agent
 * will meet them.
 */
function PlanRowExpansion({ plan, onOpen }: { plan: PlanRow; onOpen: (identifier: string) => void }) {
  const { shown, hidden } = previewOf(plan.expansion, EXPANSION_PREVIEW_LIMIT);
  return (
    <div data-queue-expansion={plan.entry.identifier} className="pl-6">
      <ul aria-label={`What ${plan.entry.identifier} expands to`} className="flex flex-col">
        {shown.map((row) => (
          <EffectiveLine key={row.identifier} row={row} onOpen={onOpen} />
        ))}
      </ul>
      {hidden > 0 ? (
        <p data-queue-expansion-more className="px-2 pb-1 text-[11px] text-text-tertiary">
          and {hidden} more under {plan.entry.identifier}
        </p>
      ) : null}
    </div>
  );
}

export function QueuePlanPane({
  view,
  rows,
  now,
  busy,
  failure,
  fullScreen,
  query,
  candidates,
  onQuery,
  onToggleFullScreen,
  onOpen,
  onMove,
  onMoveTo,
  onMoveToEdge,
  onRemove,
  onAdd,
  onPrune,
  onReload,
  onRetry,
  onDismissFailure,
}: {
  view: QueueViewData;
  rows: readonly PlanRow[];
  now: Date;
  busy: boolean;
  failure: QueueWriteFailure | null;
  fullScreen: boolean;
  query: string;
  candidates: readonly IssueRow[];
  onQuery: (query: string) => void;
  onToggleFullScreen: () => void;
  onOpen: (workspace: string, identifier: string) => void;
  onMove: (from: number, to: number) => void;
  onMoveTo: (identifier: string, position: number) => void;
  onMoveToEdge: (identifier: string, edge: "first" | "last") => void;
  onRemove: (identifier: string) => void;
  onAdd: (ref: string) => void;
  onPrune: () => void;
  onReload: () => void;
  onRetry: () => void;
  onDismissFailure: () => void;
}) {
  const resolved = view.entries.filter((entry) => entry.resolved).length;
  return (
    <div data-queue-plan className="flex min-h-0 flex-1 flex-col gap-3">
      <PaneHeader
        title="Plan"
        subtitle={
          <span data-queue-revision={view.revision}>
            {view.entries.length} {view.entries.length === 1 ? "entry" : "entries"} · revision {view.revision}
          </span>
        }
        fullScreen={fullScreen}
        onToggleFullScreen={onToggleFullScreen}
      >
        {resolved > 0 ? (
          <Button variant="outline" size="xs" disabled={busy} onClick={onPrune}>
            Prune {resolved} resolved
          </Button>
        ) : null}
      </PaneHeader>

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

      <form
        data-queue-add
        className="flex flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const ref = query.trim();
          if (ref) onAdd(ref);
        }}
      >
        <div className="flex items-center gap-2">
          <Input
            value={query}
            aria-label="Search issues, epics and milestones to queue"
            placeholder="search or type an identifier…"
            disabled={busy}
            onChange={(event) => onQuery(event.target.value)}
            className="h-7 min-w-0 flex-1 text-[12px]"
          />
          <Button type="submit" variant="outline" size="xs" disabled={busy || query.trim() === ""}>
            <Plus aria-hidden />
            Queue it
          </Button>
        </div>
        {candidates.length > 0 ? (
          <ul aria-label="Matches" data-queue-candidates className="flex flex-col rounded-md border">
            {candidates.map((candidate) => (
              <li key={candidate.issue.identifier}>
                <button
                  type="button"
                  data-queue-candidate={candidate.issue.identifier}
                  disabled={busy}
                  onClick={() => onAdd(candidate.issue.identifier)}
                  className="flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
                >
                  <span className="shrink-0 font-mono text-[11px] text-text-tertiary">
                    {candidate.issue.identifier}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">{candidate.issue.title}</span>
                  <span className="shrink-0 text-[11px] text-text-tertiary">{candidate.issue.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </form>

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
                onOpen={onOpen}
                onMoveTo={onMoveTo}
                onMoveToEdge={onMoveToEdge}
              />
            )}
            renderActions={(plan) => (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${plan.entry.identifier} from the plan`}
                disabled={busy}
                onClick={() => onRemove(plan.entry.identifier)}
              >
                <Trash2 aria-hidden />
              </Button>
            )}
            renderBelow={(plan) => (
              <>
                {plan.entry.note ? (
                  <p data-queue-note className="pl-6 text-[11px] text-muted-foreground">
                    {plan.entry.note}
                  </p>
                ) : null}
                {plan.expansion.length > 0 ? (
                  <PlanRowExpansion plan={plan} onOpen={(identifier) => onOpen(plan.row.workspace, identifier)} />
                ) : null}
                {plan.effective && reasonLabel(plan.effective) ? (
                  <p data-queue-entry-reason={plan.entry.identifier} className="pl-6 text-[11px] text-muted-foreground">
                    {ELIGIBILITY_PRESENTATION[plan.effective.eligibility].glyph} {reasonLabel(plan.effective)}
                  </p>
                ) : null}
              </>
            )}
          />
        )}
      </div>
    </div>
  );
}

// ---------- the effective preview ----------

export function QueuePreviewPane({
  preview,
  fullScreen,
  onToggleFullScreen,
  onOpen,
}: {
  preview: EffectivePreview;
  fullScreen: boolean;
  onToggleFullScreen: () => void;
  onOpen: (identifier: string) => void;
}) {
  return (
    <div data-queue-preview className="flex min-h-0 flex-1 flex-col gap-3">
      <PaneHeader
        title="Effective order"
        subtitle={
          <span data-queue-next={preview.next ? "eligible" : "none"}>{nextWorkLabel(preview.next)}</span>
        }
        fullScreen={fullScreen}
        onToggleFullScreen={onToggleFullScreen}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SectionHeading>From the plan</SectionHeading>
        {preview.planned.length === 0 ? (
          <EmptyState>the plan is empty, so every row below is unqueued work in presentation order</EmptyState>
        ) : (
          <ul aria-label="Effective order from the plan" data-queue-planned className="flex flex-col">
            {preview.planned.map((row) => (
              <EffectiveLine key={row.identifier} row={row} onOpen={onOpen} indented={row.via !== null} />
            ))}
          </ul>
        )}

        <SectionHeading>Unqueued, and therefore later</SectionHeading>
        {preview.unqueued.length === 0 ? (
          <EmptyState>every open leaf is in the plan</EmptyState>
        ) : (
          <ul aria-label="Unqueued work" data-queue-unqueued className="flex flex-col">
            {preview.unqueued.map((row) => (
              <EffectiveLine key={row.identifier} row={row} onOpen={onOpen} />
            ))}
          </ul>
        )}
        {preview.unqueuedHidden > 0 ? (
          <p data-queue-unqueued-more className="px-2 py-1 text-[11px] text-text-tertiary">
            and {preview.unqueuedHidden} more unqueued
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------- the layout ----------

/**
 * Where the two panes go. `stacked` is the drawer — one pane at a time, with the way
 * across at the bottom of the plan and a Back at the top of the preview; `split` shows
 * both; `fullScreen` gives the ACTIVE pane the whole box at either width.
 */
export function QueueLayout({
  layout,
  pane,
  fullScreen,
  plan,
  preview,
  onPane,
}: {
  layout: LayoutName;
  pane: QueuePane;
  fullScreen: boolean;
  plan: ReactNode;
  preview: ReactNode;
  onPane: (pane: QueuePane) => void;
}) {
  const single = fullScreen || layout === "stacked";
  return (
    <div
      data-queue-layout={layout}
      data-full-screen={fullScreen ? "true" : undefined}
      className={cn("grid h-full min-h-0", single ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}
    >
      {single && pane === "preview" ? null : (
        <div data-queue-pane="plan" className={cn("flex min-h-0 flex-col px-4 py-3", single ? "" : "border-r")}>
          {plan}
          {layout === "stacked" && !fullScreen ? (
            <Button variant="ghost" size="sm" onClick={() => onPane("preview")} className="mt-2 self-start">
              Effective order
              <ArrowRight aria-hidden />
            </Button>
          ) : null}
        </div>
      )}
      {single && pane === "plan" ? null : (
        <div data-queue-pane="preview" className="flex min-h-0 flex-col px-4 py-3">
          {layout === "stacked" && !fullScreen ? (
            <Button variant="ghost" size="sm" onClick={() => onPane("plan")} className="mb-2 self-start">
              <ArrowLeft aria-hidden />
              Back to the plan
            </Button>
          ) : null}
          {preview}
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

export function QueueView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const layout = useLayout();
  const [pane, setPane] = useState<QueuePane>("plan");
  const [fullScreen, setFullScreen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<QueueWriteFailure | null>(null);
  const [query, setQuery] = useState("");
  /** The last write's answer, shown until the next read lands — a writer redraws from its result. */
  const [written, setWritten] = useState<QueueViewData | null>(null);

  const ws = session.ws || undefined;
  const workspace = session.ws || session.workspaces[0]?.slug || "";

  const load = useCallback(() => getQueue({ ws, all: session.filters.showDone }), [ws, session.filters.showDone]);
  const queue = useResource(load, [ws, session.filters.showDone, session.version], onAuthError);
  useEffect(() => setWritten(null), [queue.data]);

  const view = written ?? queue.data ?? null;
  const issues = session.issues.data ?? [];
  const now = useMemo(() => new Date(), [view]);
  const rows = useMemo(() => (view ? planRows(view, issues, workspace) : []), [view, issues, workspace]);
  const preview = useMemo(() => (view ? effectivePreview(view) : null), [view]);
  const candidates = useMemo(
    () => (view ? searchCandidates(issues, query, view.entries.map((entry) => entry.identifier)) : []),
    [issues, query, view],
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
        // The store changed nothing, so what is on screen is now the OLDER order. Drop it
        // and re-read: the banner's promise is that the list under it is the server's.
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

  /** THE ONE ATOMIC PATH. Drag, alt+arrow, alt+Home/End and a typed position all land here. */
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

  const onMoveTo = useCallback(
    (identifier: string, position: number) =>
      applyOrder(view ? orderForPosition(view.entries, indexOf(identifier), position) : null),
    [applyOrder, indexOf, view],
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

  const onAdd = useCallback(
    (ref: string) => {
      if (!view) return;
      setQuery("");
      void write(() => enqueueTask({ ws, ref, baseRevision: view.revision }), null);
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

  if (queue.error) return <ErrorState error={queue.error} />;
  if (!view || !preview) return <LoadingState />;

  return (
    <QueueLayout
      layout={layout}
      pane={pane}
      fullScreen={fullScreen}
      onPane={setPane}
      plan={
        <QueuePlanPane
          view={view}
          rows={rows}
          now={now}
          busy={busy}
          failure={failure}
          fullScreen={fullScreen}
          query={query}
          candidates={candidates}
          onQuery={setQuery}
          onToggleFullScreen={() => {
            setPane("plan");
            setFullScreen((on) => !on);
          }}
          onOpen={onOpen}
          onMove={onMove}
          onMoveTo={onMoveTo}
          onMoveToEdge={onMoveToEdge}
          onRemove={onRemove}
          onAdd={onAdd}
          onPrune={onPrune}
          onReload={onReload}
          onRetry={onRetry}
          onDismissFailure={() => setFailure(null)}
        />
      }
      preview={
        <QueuePreviewPane
          preview={preview}
          fullScreen={fullScreen}
          onToggleFullScreen={() => {
            setPane("preview");
            setFullScreen((on) => !on);
          }}
          onOpen={(identifier) => onOpen(workspace, identifier)}
        />
      }
    />
  );
}
