/**
 * One open milestone in the outline, the shape of a horizon's section in Plan's Horizons lens:
 * a sticky header, its gate when it has one, then (unless folded) its Goal line, its Plan line
 * when it is a horizon, and its work.
 *
 * The header renders from the list row alone, so a folded section asks the server for nothing
 * more. Its one-milestone reads (`useMilestoneWork`) run only while something needs them: it is
 * unfolded, its `⋯` menu (or the approval form the menu opened) is open, it waits for an approval
 * (its gate is the thing a person is asked to act on), or one of its writes is in flight. Folded
 * again, it reads nothing on a refresh. A write never depends on the reads: one that fails while
 * the section is folded keeps its failure, shown when the section is next unfolded.
 *
 * The header's first line: the fold chevron, the glyph, the name (opens the drawer), the due
 * date with its calendar, then `+ Add work`, `Queued #n` or `Queue`, and `⋯`. Add work opens a
 * popover with the reference and the note; on a folded section it starts the reads it needs, and
 * a write's failure is shown under the header until the section is unfolded. The status control
 * lives in the `⋯` menu: a milestone's status follows its members and a person changes it rarely. Under 760px
 * of the page only the first line sticks (chevron, glyph, name, percent, `⋯`); the bar, flags and
 * facts scroll away under it, and the due date and the queue chip move to the facts as text;
 * Add work is in `⋯`, its popover anchored to the stuck `⋯`.
 */
import { ArrowUpRight, CalendarDays, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ListMinus, ListPlus, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ActionRefusal, GateSection } from "@/detail/IssueActions";
import { HorizonPlanTree } from "@/detail/PlanActions";
import { dequeueTask, enqueueTask, type AuthError } from "@/lib/api";
import { useBackToClose } from "@/lib/back-to-close";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession, type StapleSession } from "@/lib/session";
import type { EffectiveQueueRow, MilestoneListRow, MilestoneView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/views/ViewChrome";
import { projectedDue, shownState } from "./milestone-plain";
import {
  AddWorkForm,
  FINISHED_LINE,
  FINISHED_NAME,
  FinishedFacts,
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
import { WorkFailure, WorkTree } from "./WorkTree";

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

/** The header's first line, the name line, in the editable section and in All workspaces' read-only header. */
export const NAME_LINE = "flex min-w-0 items-center gap-x-2.5 @max-[760px]/ms:h-11 @max-[760px]/ms:gap-x-2";
/** The milestone's name on its header's first line. */
export const NAME_TEXT = "text-title font-semibold";

/** Under 760px of the page the percent sits on the name line; from 760px it is beside the bar. */
export function NarrowPercent({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  return <span className="hidden text-label font-semibold tabular-nums text-foreground @max-[760px]/ms:inline">{percent}%</span>;
}

/**
 * The header's second and third lines: the bar with its percent and the flags, then (under 760px
 * of the page) the due date in words and the queue chip as text, then the facts sentence.
 */
export function HeaderFacts({ row, effective, now, goal, narrow, due }: { row: Pick<MilestoneListRow, "milestone" | "progress" | "next">; effective: readonly EffectiveQueueRow[]; now: Date; goal?: MilestoneView["goal"]; narrow: boolean; due: ReactNode }) {
  const { milestone } = row;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <MilestoneBar row={row} effective={effective} size="lg" className="min-w-[120px] flex-[0_1_340px] @max-[760px]/ms:flex-[1_1_100%] @max-[760px]/ms:[&>span]:hidden" />
        <MilestoneFlags row={row} effective={effective} now={now} goal={goal} />
      </div>
      {narrow ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-label text-text-secondary" data-milestone-facts-due="">
          {due}
          {milestone.planPosition !== null ? <span className="text-text-tertiary">· Queued #{milestone.planPosition}</span> : null}
        </div>
      ) : null}
      <p className="m-0 mt-1 text-label text-text-tertiary text-pretty" data-milestone-facts="">
        {milestoneFacts(row, effective, now)}
      </p>
    </>
  );
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
  // The menu or the approval form it opened is open, and one of its writes is in flight.
  const [asking, setAsking] = useState(false);
  const [writing, setWriting] = useState(false);
  const reading = !folded || asking || writing || milestone.status === "awaiting_approval";
  const work = useMilestoneWork(workspace, reading ? milestone.identifier : null, onAuthError, { startFolded: true, milestoneId: milestone.id });
  const inFlight = work.busy || work.due.busy || (work.decision?.controller.busy ?? false);
  if (inFlight !== writing) setWriting(inFlight);
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
      onAsking={setAsking}
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
  onAsking,
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
  /** Its `⋯` menu, or the approval form the menu opened, is open (true) or closed again. */
  onAsking?: (asking: boolean) => void;
  sectionRef?: (element: HTMLElement | null) => void;
}) {
  const [requestOpen, setRequestOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  useBackToClose(addOpen, () => setAddOpen(false));
  // The add field reads what it needs: an open popover keeps the section's reads running.
  const asking = menuOpen || requestOpen || addOpen;
  useEffect(() => onAsking?.(asking), [asking, onAsking]);
  const [dueOpen, setDueOpen] = useState(false);
  const sentinel = useRef<HTMLSpanElement>(null);
  const stuck = useStuck(sentinel);
  // Under 760px the due field opens from the stuck first line's `⋯`, which stays in view.
  const menuButton = useRef<HTMLButtonElement>(null);
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
      anchor={narrow ? menuButton : undefined}
    />
  );
  const queued = milestone.planPosition !== null;
  const finished = isFinishedMilestone(milestone.state);
  const addWork = finished ? null : (
    <Popover open={addOpen} onOpenChange={setAddOpen}>
      {narrow ? (
        <PopoverAnchor virtualRef={menuButton} />
      ) : (
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 min-h-0" data-milestone-add-open={milestone.identifier}>
            <Plus aria-hidden />
            Add work
          </Button>
        </PopoverTrigger>
      )}
      <PopoverContent align="end" className="w-80" aria-label={`Add work to ${milestone.title}`} data-milestone-add-popover="">
        <AddWorkForm busy={work.busy} ready={work.view !== null} exampleRef={work.exampleRef} failure={work.failure} onAdd={work.onAdd} />
      </PopoverContent>
    </Popover>
  );
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
            NAME_LINE,
            "@max-[760px]/ms:sticky @max-[760px]/ms:top-0 @max-[760px]/ms:z-10 @max-[760px]/ms:border-b @max-[760px]/ms:border-transparent @max-[760px]/ms:bg-card @max-[760px]/ms:px-3",
            stuck && "@max-[760px]/ms:border-border",
          )}
          data-milestone-line={milestone.identifier}
          data-stuck={stuck ? "" : undefined}
        >
          <FoldButton folded={folded} label={milestone.title} onClick={onFold} className="-ml-1" data-milestone-fold={milestone.identifier} />
          <MilestoneGlyph state={state} percent={progress.percent} />
          <h2 className={cn("m-0 min-w-0", NAME_TEXT)}>
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
            <NarrowPercent percent={progress.percent} />
            {narrow ? addWork : null}
            <span className="contents @max-[760px]/ms:hidden">
              {narrow ? null : addWork}
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
              addable={sectionAddable({ narrow, finished })}
              onAddWork={() => setAddOpen(true)}
              onOpenChange={setMenuOpen}
              triggerRef={menuButton}
              onOpenDetails={() => work.onOpen("", milestone.identifier)}
              onChangeDue={() => setDueOpen(true)}
              onRequestApproval={() => setRequestOpen(true)}
              onFold={onFold}
            />
          </div>
        </div>
        <div className="mt-1.5 @max-[760px]/ms:mt-0 @max-[760px]/ms:border-b @max-[760px]/ms:bg-card @max-[760px]/ms:px-3 @max-[760px]/ms:pb-2.5">
          <HeaderFacts row={summary} effective={effective} now={now} goal={work.view?.goal} narrow={narrow} due={due} />
        </div>
      </header>
      {queue.refusal ? <GuardRefusal refusal={queue.refusal} onDismiss={queue.onDismiss} className="mx-4 my-2 @max-[760px]/ms:mx-3" /> : null}
      {decision ? (
        <div data-milestone-gate="" className="flex flex-col gap-3 border-b px-4 py-3 empty:hidden @max-[760px]/ms:px-3">
          <ActionRefusal controller={decision.controller} />
          <GateSection detail={decision.detail} controller={decision.controller} requestOpen={requestOpen} onCloseRequest={() => setRequestOpen(false)} showState />
        </div>
      ) : null}
      {/* Unfolded, a write's failure is at the top of the work; folded, it is here. */}
      {folded ? <WorkFailure work={work} className="mx-4 my-2 @max-[760px]/ms:mx-3" /> : <SectionBody work={work} workspace={workspace} row={row} />}
    </section>
  );
}

/** Add work is in the header's `⋯` on a phone's open milestone: the desk has the header's button, a finished one offers none. */
export function sectionAddable({ narrow, finished }: { narrow: boolean; finished: boolean }): boolean {
  return narrow && !finished;
}

/** The header's `⋯`: Open details, Status, Change due date, Add work on a phone, the queue, and the fold. */
function SectionMenu({
  title,
  identifier,
  onOpenChange,
  triggerRef,
  ...items
}: {
  title: string;
  identifier: string;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
} & Omit<SectionMenuItemsProps, "handOver">) {
  const [open, setOpen] = useState(false);
  useBackToClose(open, () => setOpen(false));
  useEffect(() => onOpenChange(open), [open, onOpenChange]);
  // The due field, the add field and the approval form take the focus; giving it back to `⋯` would close them.
  const handingFocus = useRef(false);
  const handOver = (next: () => void) => () => {
    handingFocus.current = true;
    next();
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} variant="ghost" size="icon" className={cn("size-7 text-text-tertiary @max-[760px]/ms:-my-2", TAP_28)} aria-label={`${title} options`} data-milestone-menu={identifier}>
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
        <SectionMenuItems {...items} handOver={handOver} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SectionMenuItemsProps {
  status: string;
  decision: MilestoneWork["decision"];
  folded: boolean;
  queued: boolean;
  queue: SectionQueue;
  /** Add work is offered here (a phone's open milestone, `sectionAddable`). */
  addable: boolean;
  onOpenDetails: () => void;
  onChangeDue: () => void;
  onRequestApproval: () => void;
  onAddWork: () => void;
  onFold: () => void;
  /** Wraps an item that opens a field which takes the focus. */
  handOver?: (next: () => void) => () => void;
}

/** The header menu's items. */
export function SectionMenuItems({ status, decision, folded, queued, queue, addable, onOpenDetails, onChangeDue, onRequestApproval, onAddWork, onFold, handOver = (next) => next }: SectionMenuItemsProps) {
  return (
    <>
      <DropdownMenuItem data-menu-item="open" onSelect={onOpenDetails}>
        <ArrowUpRight aria-hidden />
        Open details
      </DropdownMenuItem>
      <StatusSubmenu decision={decision} status={status} onRequestApproval={handOver(onRequestApproval)} />
      <DropdownMenuItem data-menu-item="due" onSelect={handOver(onChangeDue)}>
        <CalendarDays aria-hidden />
        Change due date
      </DropdownMenuItem>
      {addable ? (
        <DropdownMenuItem data-menu-item="add" onSelect={handOver(onAddWork)}>
          <Plus aria-hidden />
          Add work
        </DropdownMenuItem>
      ) : null}
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
    </>
  );
}

/** Open a horizon where its plan is: Plan's Horizons lens, landing on it, inside the app. */
export function openInPlan(session: Pick<StapleSession, "openHorizon">, workspace: string, horizon: { identifier: string }): void {
  session.openHorizon(workspace, horizon.identifier);
}

/**
 * "Open in Plan": a link to the lens's address for the horizon, so it can be opened in a new tab,
 * that a plain press follows inside the app (`openInPlan`) instead of reloading the page.
 */
function OpenInPlanLink({ workspace, horizon }: { workspace: string; horizon: { identifier: string } }) {
  const session = useSession();
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openInPlan(session, workspace, horizon);
  };
  return (
    <a
      href={`?${new URLSearchParams({ ws: workspace, view: "plan", "plan-lens": "horizons", focus: horizon.identifier })}`}
      onClick={follow}
      className="focus-ring relative shrink-0 rounded-sm text-label text-text-secondary underline-offset-2 hover:underline @max-[760px]/ms:before:absolute @max-[760px]/ms:before:-inset-y-2 @max-[760px]/ms:before:-inset-x-1 @max-[760px]/ms:before:content-['']"
      data-milestone-open-plan={horizon.identifier}
    >
      Open in Plan
    </a>
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

/** Under a header: the Goal line, the Plan line for a horizon, then the work. */
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
            end={<OpenInPlanLink workspace={workspace} horizon={plan.horizon} />}
          >
            <span className="ml-1.5 font-medium text-foreground">Plan</span>
            <span className="text-text-secondary">
              {ideas} {ideas === 1 ? "idea" : "ideas"}
            </span>
          </FoldLine>
          {planOpen ? <HorizonPlanTree workspace={workspace} horizon={plan.horizon} ideas={plan.ideas} horizons={plan.horizons} className="border-b" /> : null}
        </>
      ) : null}
      <WorkTree work={work} />
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
      <div className={FINISHED_LINE}>
        <FoldButton folded={!open} label={milestone.title} onClick={onToggle} className="-ml-1" data-milestone-fold={milestone.identifier} />
        <MilestoneGlyph state={milestone.state} percent={progress.percent} />
        <button
          type="button"
          // A 32px tap under 760px, as the open section's name: padding inside the box (a `::before` would be clipped by the truncation), taken back by a negative margin.
          className={cn("focus-ring min-h-0 rounded-sm text-left underline-offset-2 hover:underline @max-[760px]/ms:-my-1.5 @max-[760px]/ms:py-1.5", FINISHED_NAME)}
          onClick={() => session.open(workspace, milestone.identifier)}
          data-milestone-open={milestone.identifier}
        >
          {milestone.title}
        </button>
        <FinishedFacts row={row} now={now} />
      </div>
      {open ? <FinishedBody row={row} workspace={workspace} onAuthError={onAuthError} /> : null}
    </section>
  );
}

function FinishedBody({ row, workspace, onAuthError }: { row: MilestoneListRow; workspace: string; onAuthError: (error: AuthError) => void }) {
  const work = useMilestoneWork(workspace, row.milestone.identifier, onAuthError, { showAll: true, startFolded: true, milestoneId: row.milestone.id });
  return (
    <div className="border-t">
      <SectionBody work={work} workspace={workspace} row={row} />
    </div>
  );
}
