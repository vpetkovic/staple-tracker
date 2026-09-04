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
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronUp, Maximize2, Minimize2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { resolveTaskListConfig, TaskRowLine } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addMilestoneMember,
  getMilestone,
  getMilestones,
  isRevisionConflict,
  removeMilestoneMember,
  reorderMilestoneMembers,
  type AuthError,
} from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import type { MilestoneListRow, MilestoneState, MilestoneView as MilestoneViewData } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, SectionHeading } from "@/views/ViewChrome";
import {
  dateLabel,
  layoutFor,
  memberListRows,
  milestoneRisk,
  movedOrder,
  nextWorkLabel,
  progressLabel,
  riskLabels,
  sortMilestones,
  STATE_PRESENTATION,
  type MemberListRow,
  type MilestonesLayout as LayoutName,
} from "./milestones-model";

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

function RiskLine({ row }: { row: Pick<MilestoneViewData, "milestone" | "progress"> }) {
  const labels = riskLabels(milestoneRisk(row));
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
  selectedRef,
  onSelect,
}: {
  rows: readonly MilestoneListRow[];
  selectedRef: string | null;
  onSelect: (identifier: string) => void;
}) {
  if (rows.length === 0) {
    return <EmptyState>no milestones yet — `staple milestone new "…" --target YYYY-MM-DD`</EmptyState>;
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
              <RiskLine row={row} />
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
const MEMBER_ROW_CONFIG = resolveTaskListConfig("panel", { columns: { disclosure: true } });

function MemberRow({
  entry,
  count,
  now,
  busy,
  onOpen,
  onMove,
  onRemove,
}: {
  entry: MemberListRow;
  count: number;
  now: Date;
  busy: boolean;
  onOpen: (workspace: string, identifier: string) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (identifier: string) => void;
}) {
  const { row, role, memberIndex, member } = entry;
  const identifier = row.issue.identifier;
  return (
    <li
      data-milestone-member={identifier}
      data-member-role={role}
      onKeyDown={(event) => {
        if (role !== "member" || !event.altKey || busy) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onMove(memberIndex, memberIndex - 1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onMove(memberIndex, memberIndex + 1);
        }
      }}
      className="flex items-center gap-1"
    >
      <div className="min-w-0 flex-1">
        <TaskRowLine row={row} config={MEMBER_ROW_CONFIG} semantics="bare" now={now} />
        {member?.note ? (
          <div className="pb-1 pl-8 text-[11px] text-muted-foreground" data-member-note>
            {member.note}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Open ${identifier}`}
          onClick={() => onOpen(row.workspace, identifier)}
        >
          <ArrowUpRight aria-hidden />
        </Button>
        {role === "member" ? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${identifier} up`}
              disabled={busy || memberIndex === 0}
              onClick={() => onMove(memberIndex, memberIndex - 1)}
            >
              <ChevronUp aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${identifier} down`}
              disabled={busy || memberIndex === count - 1}
              onClick={() => onMove(memberIndex, memberIndex + 1)}
            >
              <ChevronDown aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${identifier} from this milestone`}
              disabled={busy}
              onClick={() => onRemove(identifier)}
            >
              <Trash2 aria-hidden />
            </Button>
          </>
        ) : (
          // A child is here for context only: same width as the three buttons it lacks,
          // so the rows' Open buttons line up.
          <span aria-hidden className="inline-block w-[4.5rem]" />
        )}
      </div>
    </li>
  );
}

function Rollups({ view }: { view: MilestoneViewData }) {
  const { counts } = view.progress;
  const cells: Array<[string, string]> = [
    ["progress", progressLabel(view.progress)],
    ["blocked", `⊘ ${counts.blocked}`],
    ["gated", `◇ ${counts.gated}`],
    ["active", `◐ ${counts.active + counts.review}`],
    ["ready", `○ ${counts.ready + counts.unstarted}`],
  ];
  return (
    <dl data-milestone-rollups className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-3">
      {cells.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-2">
          <dt className="text-text-tertiary">{label}</dt>
          <dd className="font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function MilestoneDetailPane({
  view,
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
}: {
  view: MilestoneViewData;
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
}) {
  const { milestone } = view;
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

  return (
    <article data-milestone-detail={milestone.identifier} className="flex min-h-0 flex-1 flex-col gap-4">
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
            <StateBadge state={milestone.state} complete={view.progress.complete} />
            <span data-milestone-start>start {dateLabel(milestone.startDate)}</span>
            <span data-milestone-target>target {dateLabel(milestone.targetDate)}</span>
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

      <section>
        <SectionHeading>Rollups</SectionHeading>
        <Rollups view={view} />
        <div className="mt-2 flex flex-wrap gap-x-3">
          <RiskLine row={view} />
          <NextWork next={view.next} />
        </div>
      </section>

      <section className="min-h-0">
        <SectionHeading>Members</SectionHeading>
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
          <EmptyState>no members yet — add an epic or a task below</EmptyState>
        ) : (
          <ul aria-label={`Members of ${milestone.identifier}`} data-milestone-members className="flex flex-col">
            {members.map((entry) => (
              <MemberRow
                key={entry.row.issue.identifier}
                entry={entry}
                count={view.members.length}
                now={now}
                busy={busy}
                onOpen={onOpen}
                onMove={onMove}
                onRemove={onRemove}
              />
            ))}
          </ul>
        )}
        <form onSubmit={submitAdd} className="mt-2 flex flex-wrap items-center gap-2" data-milestone-add>
          <Input
            value={addRef}
            aria-label="Identifier to add"
            placeholder="STA-66"
            disabled={busy}
            onChange={(event) => setAddRef(event.target.value)}
            className="h-7 w-28 font-mono text-[12px]"
          />
          <Input
            value={addNote}
            aria-label="Note for the new member"
            placeholder="note (optional)"
            disabled={busy}
            onChange={(event) => setAddNote(event.target.value)}
            className="h-7 min-w-0 flex-1 text-[12px]"
          />
          <Button type="submit" variant="outline" size="xs" disabled={busy || addRef.trim() === ""}>
            Add member
          </Button>
        </form>
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
        detailOnly || listOnly ? "grid-cols-1" : "grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]",
      )}
    >
      {detailOnly ? null : (
        <div data-milestones-pane="list" className="min-h-0 overflow-y-auto border-r px-3 py-3">
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
  const layout = useLayout();
  const [selectedRef, setSelectedRef] = useState<string | null>(session.milestoneFocus);
  const [fullScreen, setFullScreen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MemberWriteFailure | null>(null);
  /** The last write's answer, shown until the next read lands — a writer redraws from its result. */
  const [written, setWritten] = useState<MilestoneViewData | null>(null);

  const ws = session.ws || undefined;
  const workspace = session.ws || session.workspaces[0]?.slug || "";

  const loadList = useCallback(() => getMilestones({ ws, all: session.filters.showDone }), [ws, session.filters.showDone]);
  const list = useResource(loadList, [ws, session.filters.showDone, session.version], onAuthError);
  const sorted = useMemo(() => (list.data ? sortMilestones(list.data) : []), [list.data]);

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
  const members = useMemo(
    () => (view ? memberListRows(view, session.issues.data ?? [], workspace) : []),
    [view, session.issues.data, workspace],
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
        reorderMilestoneMembers({ ws, milestone: view.milestone.identifier, order, baseRevision: view.revision }),
      );
    },
    [view, ws, write],
  );

  const onRemove = useCallback(
    (identifier: string) => {
      if (!view) return;
      void write(() =>
        removeMilestoneMember({ ws, milestone: view.milestone.identifier, ref: identifier, baseRevision: view.revision }),
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
          milestone: view.milestone.identifier,
          ref,
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

  const listPane = list.error ? (
    <ErrorState error={list.error} />
  ) : list.data === undefined ? (
    <LoadingState />
  ) : (
    <MilestoneListPane rows={sorted} selectedRef={selectedRef} onSelect={setSelectedRef} />
  );

  const detailPane = !selectedRef ? (
    <EmptyState>select a milestone</EmptyState>
  ) : detail.error ? (
    <ErrorState error={detail.error} />
  ) : !view ? (
    <LoadingState />
  ) : (
    <MilestoneDetailPane
      view={view}
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
