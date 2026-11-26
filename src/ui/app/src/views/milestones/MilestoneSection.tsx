/**
 * One open milestone in the outline, the shape of a horizon's section in Plan's Horizons lens:
 * a sticky header, its gate when it has one, then (unless folded) its Goal line, its Plan line
 * when it is a horizon, and its work with the Add work line.
 *
 * The header renders from the list row alone, so a folded section asks the server for nothing
 * more. Its one-milestone reads (`useMilestoneWork`) start when it is unfolded, its `⋯` menu is
 * first opened, or it waits for an approval (its gate is the thing a person is asked to act on).
 *
 * The header's first line: the fold chevron, the glyph, the name (opens the drawer), the due
 * date with its calendar, then `Queued #n` or `Queue`, and `⋯`. The status control lives in the
 * `⋯` menu: a milestone's status follows its members and a person changes it rarely. Under 760px
 * of the page only the first line sticks (chevron, glyph, name, percent, `⋯`); the bar, flags and
 * facts scroll away under it, and the due date and the queue chip move to the facts as text.
 */
import { ArrowUpRight, CalendarDays, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ListMinus, ListPlus, MoreHorizontal, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ActionRefusal, GateSection } from "@/detail/IssueActions";
import { HorizonPlanTree } from "@/detail/PlanActions";
import { dequeueTask, enqueueTask, type AuthError } from "@/lib/api";
import { useBackToClose } from "@/lib/back-to-close";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import type { EffectiveQueueRow, MilestoneListRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/views/ViewChrome";
import { dueText, progressSentence, projectedDue, shownState } from "./milestone-plain";
import {
  AddWork,
  FoldButton,
  GoalBody,
  MilestoneBar,
  MilestoneFlags,
  MilestoneGlyph,
  PacePill,
  QueuedMark,
  StatusSubmenu,
  TAP_28,
  TAP_TEXT,
  goalShort,
  goalStartsOpen,
  milestoneFacts,
  nextCriterion,
} from "./milestone-parts";
import { MilestoneDueControl } from "./MilestoneDue";
import { isFinishedMilestone } from "./milestones-model";
import { useMilestoneWork, type MilestoneWork } from "./useMilestoneWork";
import { WorkTree } from "./WorkTree";

/** Writing the milestone's own row in the pickup queue, and what went wrong with the last write. */
export interface SectionQueue {
  busy: boolean;
  refusal: Refusal | null;
  /** Absent while the queue has not been read: there is no revision to write against. */
  onQueue?: () => void;
  onDequeue?: () => void;
  onDismiss: () => void;
}

/** Whether the element after `sentinel` is stuck at the top of the outline's scroller. */
function useStuck(sentinel: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const element = sentinel.current;
    const root = element?.closest("[data-milestones-outline]");
    if (!element || !root || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry!.isIntersecting && entry!.boundingClientRect.top < (entry!.rootBounds?.top ?? 0) + 1), { root, threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sentinel]);
  return stuck;
}

/** The milestone's own queue row: Queue, or Remove from the queue, against the queue's revision. */
function useSectionQueue(workspace: string, milestoneId: string, queueRevision: number | undefined): SectionQueue {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const write = (run: (baseRevision: number) => Promise<unknown>) => async () => {
    if (queueRevision === undefined) return;
    setBusy(true);
    setRefusal(null);
    try {
      await run(queueRevision);
      session.refresh();
    } catch (error) {
      setRefusal(describeRefusal(error));
    } finally {
      setBusy(false);
    }
  };
  const ws = workspace || undefined;
  const ready = queueRevision !== undefined;
  return {
    busy,
    refusal,
    onQueue: ready ? () => void write((baseRevision) => enqueueTask({ ws, ref: milestoneId, baseRevision }))() : undefined,
    onDequeue: ready ? () => void write((baseRevision) => dequeueTask({ ws, ref: milestoneId, baseRevision }))() : undefined,
    onDismiss: () => setRefusal(null),
  };
}

/** An open milestone's section, with its reads and its queue write. */
export function OpenSection({
  row,
  workspace,
  effective,
  queueRevision,
  onAuthError,
  folded,
  onFold,
  narrow,
  landed,
  sectionRef,
}: {
  row: MilestoneListRow;
  workspace: string;
  effective: readonly EffectiveQueueRow[];
  queueRevision: number | undefined;
  onAuthError: (error: AuthError) => void;
  folded: boolean;
  onFold: () => void;
  narrow: boolean;
  /** A link just landed here: marked for a moment. */
  landed: boolean;
  sectionRef?: (element: HTMLElement | null) => void;
}) {
  const { milestone } = row;
  // Read once wanted, and keep reading: folding it again keeps what it shows ready.
  const [wanted, setWanted] = useState(false);
  if (!wanted && (!folded || milestone.status === "awaiting_approval")) setWanted(true);
  const work = useMilestoneWork(workspace, wanted ? milestone.identifier : null, onAuthError, { startFolded: true });
  const queue = useSectionQueue(workspace, milestone.id, queueRevision);
  return (
    <SectionView
      row={row}
      work={work}
      workspace={workspace}
      effective={effective}
      folded={folded}
      onFold={onFold}
      narrow={narrow}
      landed={landed}
      queue={queue}
      onMenuOpen={() => setWanted(true)}
      sectionRef={sectionRef}
    />
  );
}

/** The section as drawn from its list row and its reads. Reads no context of its own but the session's for the drawer links. */
export function SectionView({
  row,
  work,
  workspace,
  effective,
  folded,
  onFold,
  narrow,
  landed = false,
  queue,
  onMenuOpen,
  sectionRef,
}: {
  row: MilestoneListRow;
  work: MilestoneWork;
  workspace: string;
  effective: readonly EffectiveQueueRow[];
  folded: boolean;
  onFold: () => void;
  narrow: boolean;
  landed?: boolean;
  queue: SectionQueue;
  onMenuOpen?: () => void;
  sectionRef?: (element: HTMLElement | null) => void;
}) {
  const [requestOpen, setRequestOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const sentinel = useRef<HTMLSpanElement>(null);
  const stuck = useStuck(sentinel);
  // The view once read is fresher than the list row; until then the row is the header.
  const summary = work.view ?? row;
  const { milestone, progress } = summary;
  const now = work.now;
  const state = shownState(milestone, now);
  const decision = work.decision;
  const due = (
    <MilestoneDueControl
      key={milestone.id}
      milestone={milestone}
      projection={work.projection ?? projectedDue(row.remaining, now)}
      now={now}
      busy={work.due.busy}
      error={work.due.error}
      onSetTarget={work.due.onSetTarget}
      onOpen={work.due.onOpen}
      open={dueOpen}
      onOpenChange={setDueOpen}
      button={!narrow}
    />
  );
  const queued = milestone.planPosition !== null;
  return (
    <section
      ref={sectionRef}
      aria-label={milestone.title}
      data-milestone-section={milestone.identifier}
      data-milestone-folded={folded ? "" : undefined}
      data-milestone-landed={landed ? "" : undefined}
      className={cn(
        "relative border-b",
        // The landing mark: a ring over the whole section that fades; none with reduced motion.
        "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:opacity-0 after:shadow-[inset_0_0_0_2px_var(--color-ring)] after:transition-opacity after:duration-700 after:content-[''] motion-reduce:after:hidden",
        landed && "after:opacity-100 after:duration-150",
      )}
    >
      <header className="sticky top-0 z-10 border-b bg-card px-4 pt-3 pb-2.5 @max-[760px]/ms:contents">
        {/* Zero height at the section's top under 760px: once it scrolls out, the first line is stuck. */}
        <span ref={sentinel} aria-hidden className="block h-0" />
        <div
          className={cn(
            "flex min-w-0 items-center gap-x-2.5",
            "@max-[760px]/ms:sticky @max-[760px]/ms:top-0 @max-[760px]/ms:z-10 @max-[760px]/ms:h-11 @max-[760px]/ms:gap-x-2 @max-[760px]/ms:border-b @max-[760px]/ms:border-transparent @max-[760px]/ms:bg-card @max-[760px]/ms:px-3",
            stuck && "@max-[760px]/ms:border-border",
          )}
          data-milestone-line={milestone.identifier}
          data-stuck={stuck ? "" : undefined}
        >
          <FoldButton folded={folded} label={milestone.title} onClick={onFold} className="-ml-1" data-milestone-fold={milestone.identifier} />
          <MilestoneGlyph state={state} percent={progress.percent} />
          <h2 className="m-0 min-w-0 text-title font-semibold">
            <button
              type="button"
              className="focus-ring block min-h-0 max-w-full truncate rounded-sm text-left underline-offset-2 hover:underline @max-[760px]/ms:-my-[5px] @max-[760px]/ms:py-[5px]"
              title="Open details"
              onClick={() => work.onOpen("", milestone.identifier)}
              data-milestone-open={milestone.identifier}
            >
              {milestone.title}
            </button>
          </h2>
          {narrow ? null : <span className="shrink-0 text-label text-text-secondary">{due}</span>}
          <div className="ms-auto flex shrink-0 items-center gap-1.5">
            {progress.percent !== null ? <span className="hidden text-label font-semibold tabular-nums text-foreground @max-[760px]/ms:inline">{progress.percent}%</span> : null}
            <span className="contents @max-[760px]/ms:hidden">
              {queued ? (
                <QueuedMark position={milestone.planPosition} />
              ) : (
                <Button variant="outline" size="sm" className="h-7 min-h-0" disabled={queue.busy || !queue.onQueue} onClick={queue.onQueue} data-milestone-queue={milestone.identifier}>
                  <ListPlus aria-hidden />
                  Queue
                </Button>
              )}
            </span>
            <SectionMenu
              title={milestone.title}
              identifier={milestone.identifier}
              status={milestone.status}
              decision={decision}
              folded={folded}
              queued={queued}
              queue={queue}
              onOpenMenu={onMenuOpen}
              onOpenDetails={() => work.onOpen("", milestone.identifier)}
              onChangeDue={() => setDueOpen(true)}
              onRequestApproval={() => setRequestOpen(true)}
              onFold={onFold}
            />
          </div>
        </div>
        <div className="mt-1.5 @max-[760px]/ms:mt-0 @max-[760px]/ms:border-b @max-[760px]/ms:bg-card @max-[760px]/ms:px-3 @max-[760px]/ms:pb-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <MilestoneBar row={summary} effective={effective} size="lg" className="min-w-[120px] flex-[0_1_340px] @max-[760px]/ms:flex-[1_1_100%] @max-[760px]/ms:[&>span]:hidden" />
            <MilestoneFlags row={summary} effective={effective} now={now} goal={work.view?.goal} />
          </div>
          {narrow ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-label text-text-secondary" data-milestone-facts-due="">
              {due}
              {queued ? <span className="text-text-tertiary">· Queued #{milestone.planPosition}</span> : null}
            </div>
          ) : null}
          <p className="m-0 mt-1 text-label text-text-tertiary text-pretty" data-milestone-facts="">
            {milestoneFacts(summary, effective, now)}
          </p>
        </div>
      </header>
      {queue.refusal ? <GuardRefusal refusal={queue.refusal} onDismiss={queue.onDismiss} className="mx-4 my-2 @max-[760px]/ms:mx-3" /> : null}
      {decision ? (
        <div data-milestone-gate="" className="flex flex-col gap-3 border-b px-4 py-3 empty:hidden @max-[760px]/ms:px-3">
          <ActionRefusal controller={decision.controller} />
          <GateSection detail={decision.detail} controller={decision.controller} requestOpen={requestOpen} onCloseRequest={() => setRequestOpen(false)} showState />
        </div>
      ) : null}
      {folded ? null : <SectionBody work={work} workspace={workspace} row={row} />}
    </section>
  );
}

/** The header's `⋯`: Open details, Status, Change due date, the queue, and the fold. */
function SectionMenu({
  title,
  identifier,
  status,
  decision,
  folded,
  queued,
  queue,
  onOpenMenu,
  onOpenDetails,
  onChangeDue,
  onRequestApproval,
  onFold,
}: {
  title: string;
  identifier: string;
  status: string;
  decision: MilestoneWork["decision"];
  folded: boolean;
  queued: boolean;
  queue: SectionQueue;
  onOpenMenu?: () => void;
  onOpenDetails: () => void;
  onChangeDue: () => void;
  onRequestApproval: () => void;
  onFold: () => void;
}) {
  const [open, setOpen] = useState(false);
  useBackToClose(open, () => setOpen(false));
  // The due field and the approval form take the focus; giving it back to `⋯` would close them.
  const handingFocus = useRef(false);
  const handOver = (next: () => void) => () => {
    handingFocus.current = true;
    next();
  };
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenMenu?.();
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("size-7 text-text-tertiary @max-[760px]/ms:-my-2", TAP_28)} aria-label={`${title} options`} data-milestone-menu={identifier}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[13rem]"
        aria-label={`${title} options`}
        onCloseAutoFocus={(event) => {
          if (!handingFocus.current) return;
          handingFocus.current = false;
          event.preventDefault();
        }}
      >
        <DropdownMenuItem data-menu-item="open" onSelect={onOpenDetails}>
          <ArrowUpRight aria-hidden />
          Open details
        </DropdownMenuItem>
        <StatusSubmenu decision={decision} status={status} onRequestApproval={handOver(onRequestApproval)} />
        <DropdownMenuItem data-menu-item="due" onSelect={handOver(onChangeDue)}>
          <CalendarDays aria-hidden />
          Change due date
        </DropdownMenuItem>
        {queued ? (
          <DropdownMenuItem data-menu-item="dequeue" disabled={queue.busy || !queue.onDequeue} onSelect={queue.onDequeue}>
            <ListMinus aria-hidden />
            Remove from the queue
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem data-menu-item="queue" disabled={queue.busy || !queue.onQueue} onSelect={queue.onQueue}>
            <ListPlus aria-hidden />
            Queue
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem data-menu-item="fold" onSelect={onFold}>
          {folded ? <ChevronsUpDown aria-hidden /> : <ChevronsDownUp aria-hidden />}
          {folded ? "Expand" : "Collapse"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A line like the lens's rows: a chevron at the fold chevron's x, a label, what it holds. */
function FoldLine({ open, onToggle, children, end, ...data }: { open: boolean; onToggle: () => void; children: ReactNode; end?: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className="flex min-h-9 items-center border-b border-border/60 pr-4 hover:bg-surface-hover @max-[760px]/ms:pr-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        {...data}
        className="focus-ring-inset flex min-h-9 min-w-0 flex-1 items-center gap-2 py-1.5 pl-[15px] text-left text-label @max-[760px]/ms:pl-[11px]"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0 text-text-tertiary" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />}
        {children}
      </button>
      {end}
    </div>
  );
}

/** Under a header: the Goal line, the Plan line for a horizon, then the work and its add line. */
export function SectionBody({ work, workspace, row, defaultGoalOpen, defaultPlanOpen = false }: { work: MilestoneWork; workspace: string; row: MilestoneListRow; defaultGoalOpen?: boolean; defaultPlanOpen?: boolean }) {
  const [goalOpen, setGoalOpen] = useState(defaultGoalOpen ?? goalStartsOpen(row));
  const [planOpen, setPlanOpen] = useState(defaultPlanOpen);
  if (work.error) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 px-4 @max-[760px]/ms:px-3" data-milestone-read-error="">
        <ErrorState error={work.error} />
        <Button variant="outline" size="sm" className={TAP_TEXT} onClick={work.onReload} data-milestone-retry="">
          <RefreshCw aria-hidden />
          Retry
        </Button>
      </div>
    );
  }
  if (!work.view) return <p className="m-0 py-3 pr-4 pl-[42px] text-label text-text-tertiary @max-[760px]/ms:px-3" data-milestone-loading="">Loading…</p>;
  const { view, now } = work;
  const finished = isFinishedMilestone(view.milestone.state);
  const items = view.members.length;
  const plan = work.decision?.detail.horizonPlan ?? null;
  const ideas = plan ? plan.ideas.filter((idea) => idea.horizonId === plan.horizon.id).length : 0;
  return (
    <>
      <FoldLine open={goalOpen} onToggle={() => setGoalOpen(!goalOpen)} data-milestone-goal-line={view.milestone.identifier}>
        <span className="ml-1.5 font-medium text-foreground">Goal</span>
        <span className="shrink-0 text-text-secondary">{goalShort(view.goal)}</span>
        <PacePill goal={view.goal} now={now} />
        {goalOpen ? null : <span className="min-w-0 flex-1 truncate text-text-tertiary @max-[760px]/ms:hidden">{nextCriterion(view.goal)}</span>}
      </FoldLine>
      {goalOpen ? (
        <div className="border-b bg-surface-sunken/50 pr-4 pb-3 pl-[42px] @max-[760px]/ms:px-3">
          <GoalBody view={view} workspace={workspace} now={now} className="max-w-[880px]" />
        </div>
      ) : null}
      {plan ? (
        <>
          <FoldLine
            open={planOpen}
            onToggle={() => setPlanOpen(!planOpen)}
            data-milestone-plan-line={view.milestone.identifier}
            end={
              <a href={`?${new URLSearchParams({ ws: workspace, view: "plan", "plan-lens": "horizons" })}`} className="focus-ring relative shrink-0 rounded-sm text-label text-text-secondary underline-offset-2 hover:underline @max-[760px]/ms:before:absolute @max-[760px]/ms:before:-inset-y-2 @max-[760px]/ms:before:-inset-x-1 @max-[760px]/ms:before:content-['']" data-milestone-open-plan="">
                Open in Plan
              </a>
            }
          >
            <span className="ml-1.5 font-medium text-foreground">Plan</span>
            <span className="text-text-secondary">
              {ideas} {ideas === 1 ? "idea" : "ideas"}
            </span>
          </FoldLine>
          {planOpen ? <HorizonPlanTree workspace={workspace} horizon={plan.horizon} ideas={plan.ideas} horizons={plan.horizons} className="border-b" /> : null}
        </>
      ) : null}
      <div aria-hidden className="flex items-baseline gap-2 border-b bg-surface-sunken py-1.5 pr-4 pl-[42px] text-caption text-text-tertiary @max-[760px]/ms:px-3">
        <span>Work, in order</span>
        <span className="ms-auto tabular-nums">
          {items} {items === 1 ? "item" : "items"}
        </span>
      </div>
      <WorkTree work={work} />
      {/* A finished milestone is a record: its work is listed, not edited. */}
      {finished ? null : <AddWork busy={work.busy} exampleRef={work.exampleRef} onAdd={work.onAdd} className="border-t border-border/60 py-1 pr-4 pl-[34px] @max-[760px]/ms:px-2" />}
    </>
  );
}

/** A finished or cancelled milestone on the shelf: one 40px line; its goal and its work open under it, read-only. */
export function FinishedLine({ row, workspace, onAuthError, open, onToggle }: { row: MilestoneListRow; workspace: string; onAuthError: (error: AuthError) => void; open: boolean; onToggle: () => void }) {
  const session = useSession();
  const now = new Date();
  const { milestone, progress } = row;
  return (
    <section aria-label={milestone.title} data-milestone-section={milestone.identifier} data-milestone-finished-line={milestone.identifier} className="border-b">
      <div className="flex min-h-10 min-w-0 items-center gap-x-2.5 px-4 hover:bg-surface-hover @max-[760px]/ms:gap-x-2 @max-[760px]/ms:px-3">
        <FoldButton folded={!open} label={milestone.title} onClick={onToggle} className="-ml-1" data-milestone-fold={milestone.identifier} />
        <MilestoneGlyph state={milestone.state} percent={progress.percent} />
        <button
          type="button"
          className="focus-ring min-h-0 min-w-0 truncate rounded-sm text-left text-body font-medium text-text-secondary underline-offset-2 hover:underline"
          onClick={() => session.open(workspace, milestone.identifier)}
          data-milestone-open={milestone.identifier}
        >
          {milestone.title}
        </button>
        <span className="ms-auto shrink-0 text-label text-text-tertiary @max-[760px]/ms:hidden">{progressSentence(progress)}</span>
        <span className="shrink-0 text-label text-text-tertiary @max-[760px]/ms:ms-auto">{dueText(milestone, null, now)}</span>
      </div>
      {open ? <FinishedBody row={row} workspace={workspace} onAuthError={onAuthError} /> : null}
    </section>
  );
}

function FinishedBody({ row, workspace, onAuthError }: { row: MilestoneListRow; workspace: string; onAuthError: (error: AuthError) => void }) {
  const work = useMilestoneWork(workspace, row.milestone.identifier, onAuthError, { showAll: true, startFolded: true });
  return (
    <div className="border-t">
      <SectionBody work={work} workspace={workspace} row={row} />
    </div>
  );
}
