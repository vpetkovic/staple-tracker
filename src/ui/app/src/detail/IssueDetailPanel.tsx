/**
 * The detail panel's contents: the bar, the header (breadcrumb, title, status line, actions),
 * the properties, and the tab slot.
 *
 * This file knows nothing about any individual tab. It reads detail/tabs/registry.ts,
 * renders whatever is in it, and passes every tab the same props. The panel owns the fetch,
 * so a tab always gets a loaded `IssueDetail`.
 *
 * ── THE SHAPE, AND WHY ──────────────────────────────────────────────────────────────────
 *
 * Calm and typographic, one clear action, nothing that reads as a database dump:
 *
 *   1. A QUIET BAR. Where you are (the parent's title, not its id) and how to move: position
 *      in the list, previous/next, and the frame controls. Fixed height, never scrolls.
 *
 *   2. THE TITLE IS THE SUBJECT: `text-display` on a desk, `text-heading` on a phone.
 *
 *   3. ONE STATUS LINE IN PLAIN WORDS: the status pill (which is the only status control)
 *      and a sentence ("Being worked on by dux-shell · started 12 min ago"). The one primary
 *      action the state calls for sits at its end; every other verb is in ⋯.
 *
 *   4. PROPERTIES AS A QUIET LIST: people as chips, dates relative, priority as icon + word.
 *      The raw values sit behind "More details".
 *
 * Three presentations share one DOM and one scroll container:
 *
 *   drawer — one calm column; properties in a compact two-column list under the status line.
 *   full   — a readable column (`max-w-readable`) and a sticky properties rail to its right.
 *   sheet  — the phone: a compact bar (Back, "3 of 24", previous/next, ⋯), summary chips
 *            under the status line, and the primary action in a sticky bottom bar within
 *            thumb reach, above the home indicator.
 */
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Maximize2, Minimize2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getIssue, getQueue, getSettings } from "@/lib/api";
import type { AuthError } from "@/lib/api";
import { selectionTarget, useSession, type Selection } from "@/lib/session";
import { settingValueIn, statusCategory } from "@/lib/settings";
import type { IssueDetail, UiMode } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "./parts/cn";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import type { DetailMode, DetailPresentation } from "./drawer";
import type { NavState, NavTarget } from "./navigation";
import {
  ActionRefusal,
  contextOf,
  openBlockerCount,
  GateSection,
  OverflowMenu,
  PrimaryAction,
  StatusMenu,
  useIssueActions,
  type IssueActionsController,
} from "./IssueActions";
import { InlineKind, InlineLabels, InlinePriority, InlineProject, InlineTitle } from "./InlineProperties";
import { EmptyValue, MoreDetails, PropertyList, PropertyRow, type PropertyLayout } from "./PropertyGrid";
import { PersonChip, RelativeTime } from "./parts";
import { MilestoneCrumb, MilestoneDue, MilestoneSentence, MilestoneValue, OpenPlanAction, opensPlan, planOf } from "./MilestoneParts";
import { primaryItem, queueAheadOf, statusSentence } from "./plain-actions";
import { detailFacts } from "./properties";
import { onOpenDetailTab, visibleTabs } from "./tabs/registry";

export function IssueDetailPanel({
  selection,
  mode,
  presentation = mode,
  onToggleMode,
  nav,
  onNavigate,
  onClose,
  onAuthError,
}: {
  selection: Selection;
  mode: DetailMode;
  /**
   * `sheet` on a phone (drawer.ts): a Back control leads the bar and the expand toggle
   * goes, because a full-screen sheet has nothing to expand to. Defaults to `mode`.
   */
  presentation?: DetailPresentation;
  onToggleMode: () => void;
  nav: NavState;
  onNavigate: (target: NavTarget | null) => void;
  onClose: () => void;
  onAuthError: (error: AuthError) => void;
}) {
  const session = useSession();
  const sheet = presentation === "sheet";
  const expanded = !sheet && mode === "full";

  /**
   * By the issue the selection was pinned to once it loaded, not by the identifier it was
   * opened with: sync can move an open issue off its number, and the number then names
   * another issue (`selectionTarget`).
   */
  const target = selectionTarget(selection);
  const load = useCallback(() => getIssue({ ws: selection.workspace, ref: target }), [selection.workspace, target]);
  const resource = useResource(load, [selection.workspace, target, session.version], onAuthError);

  const detail = resource.data;
  const issue = detail?.issue;
  const { pin } = session;
  useEffect(() => {
    if (issue) pin(selection.workspace, selection.ref, issue.id);
  }, [issue, pin, selection.workspace, selection.ref]);

  // Strict queue: the plan row that has to be taken first, read the way the Queue view reads
  // it. Only fetched when the workspace's policy is strict.
  const queueAhead = useQueueAhead(detail, onAuthError, session.version);
  const controller = useIssueActions(session.refresh, { queueAhead, workspaces: session.workspaces.map((w) => w.slug) });
  const [requestOpen, setRequestOpen] = useState(false);
  const gateRef = useRef<HTMLDivElement>(null);
  const reviewGate = useCallback(() => {
    const element = gateRef.current;
    if (!element) return;
    element.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    element.focus({ preventScroll: true });
  }, []);

  return (
    // `aria-label` and the `aside` role are what the evidence scripts select on.
    <aside aria-label="Issue detail" className="flex h-full min-h-0 flex-col">
      <DetailBar
        selection={selection}
        detail={detail}
        presentation={presentation}
        expanded={expanded}
        nav={nav}
        onNavigate={onNavigate}
        onToggleMode={onToggleMode}
        onClose={onClose}
        overflow={
          sheet && detail ? (
            <OverflowMenu detail={detail} controller={controller} onRequestApproval={() => setRequestOpen(true)} triggerClassName="size-11" />
          ) : null
        }
      />

      {/* ONE scroll container in every presentation. A sticky rail inside one scroll gets the
          two-column page without two scrollbars to choose between. */}
      <div className="staple-detail-scroll scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto">
        {resource.error ? (
          <div className="px-5 py-4">
            <ErrorState error={resource.error} />
          </div>
        ) : null}
        {!detail && resource.loading ? (
          <div className="px-5 py-4">
            <LoadingState rows={4} />
          </div>
        ) : null}

        {detail ? (
          <DetailContent
            detail={detail}
            presentation={presentation}
            expanded={expanded}
            mode={session.mode}
            controller={controller}
            refresh={session.refresh}
            onAuthError={onAuthError}
            requestOpen={requestOpen}
            onRequestApproval={() => setRequestOpen(true)}
            onCloseRequest={() => setRequestOpen(false)}
            onReview={reviewGate}
            gateRef={gateRef}
          />
        ) : null}
      </div>

      {/* The phone's primary action: in the thumb's reach, never scrolled away. The sheet's
          own bottom padding keeps it above the home indicator (detail.css). */}
      {sheet && detail ? (
        <div data-detail-actionbar="" className="staple-detail-actionbar flex shrink-0 flex-col gap-2 border-t bg-card px-4 pt-3 pb-3">
          {/* A refusal from the bottom bar or the top bar's ⋯ shows here, next to the thumb
              that caused it, never at the top of a long scroll. */}
          <ActionRefusal controller={controller} className="max-h-[40vh] overflow-y-auto" />
          {opensPlan(detail) ? (
            <OpenPlanAction workspace={detail.workspace} identifier={detail.issue.identifier} size="lg" className="w-full" />
          ) : (
            <>
              <PrimaryReason detail={detail} controller={controller} />
              <PrimaryAction detail={detail} controller={controller} onReview={reviewGate} size="lg" className="w-full" />
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}

/**
 * Why the primary cannot run, as one short line above it on the phone: a finger has no hover,
 * so the reason the desk gets as a tooltip is said out loud here.
 */
function PrimaryReason({ detail, controller }: { detail: IssueDetail; controller: IssueActionsController }) {
  const reason = primaryItem(contextOf(detail, controller)).disabledReason;
  if (!reason) return null;
  return (
    <p className="m-0 text-center text-label text-text-secondary wrap-anywhere" data-primary-reason="">
      {reason}
    </p>
  );
}

/** The strict queue's head for this task, or null (policy off, not loaded, or nothing ahead). */
function useQueueAhead(detail: IssueDetail | undefined, onAuthError: (error: AuthError) => void, version: number): { identifier: string; title: string } | null {
  const ws = detail?.workspace;
  const issueId = detail?.issue.id;
  const settings = useResource(useCallback(() => (ws ? getSettings({ ws }) : Promise.resolve(null)), [ws]), [ws, version], onAuthError);
  const strict = settings.data ? settingValueIn(settings.data, "queue.policy")?.value === "strict" : false;
  const queue = useResource(useCallback(() => (ws && strict ? getQueue({ ws }) : Promise.resolve(null)), [ws, strict]), [ws, strict, version], onAuthError);
  return strict && queue.data && issueId ? queueAheadOf(queue.data.effective, issueId) : null;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ───────────────────────────────────────────────────────────────────── bar

function DetailBar({
  selection,
  detail,
  presentation,
  expanded,
  nav,
  onNavigate,
  onToggleMode,
  onClose,
  overflow,
}: {
  selection: Selection;
  detail: IssueDetail | undefined;
  presentation: DetailPresentation;
  expanded: boolean;
  nav: NavState;
  onNavigate: (target: NavTarget | null) => void;
  onToggleMode: () => void;
  onClose: () => void;
  overflow: ReactNode;
}) {
  const sheet = presentation === "sheet";
  const position = nav.index >= 0 && nav.total > 0 ? `${nav.index + 1} of ${nav.total}` : null;

  if (sheet) {
    return (
      <div className="staple-detail-sheet-bar flex h-14 shrink-0 items-center gap-1 border-b px-1" data-detail-bar="sheet">
        {/* Where the thumb and the iOS habit both expect the way out. It is the same
            `session.close()` the X calls; the X goes, so there is one exit, not two. */}
        <Button
          variant="ghost"
          onClick={onClose}
          aria-label="Back to the list"
          data-detail-back=""
          className="h-11 min-w-11 gap-0.5 px-2 text-[15px] font-normal text-foreground"
        >
          <ChevronLeft className="size-5" aria-hidden />
          Back
        </Button>
        <span className="min-w-0 flex-1 truncate text-center text-label text-text-tertiary tabular-nums" data-detail-position="">
          {position}
        </span>
        <NavButton direction="prev" target={nav.prev} nav={nav} onNavigate={onNavigate} icon={<ChevronUp className="size-5" />} large />
        <NavButton direction="next" target={nav.next} nav={nav} onNavigate={onNavigate} icon={<ChevronDown className="size-5" />} large />
        {overflow}
      </div>
    );
  }

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b pr-2 pl-4">
      <Breadcrumb selection={selection} detail={detail} className="flex-1" />
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {position ? (
          <span className="mr-1.5 text-label text-text-tertiary tabular-nums" data-detail-position="">
            {position}
          </span>
        ) : null}
        {/* Previous/next act on WHICH task the panel shows; expand and close act on the panel.
            A hairline between the two groups says so. Up is previous and down is next,
            matching the list they move through. */}
        <NavButton direction="prev" target={nav.prev} nav={nav} onNavigate={onNavigate} icon={<ChevronUp className="size-4" />} />
        <NavButton direction="next" target={nav.next} nav={nav} onNavigate={onNavigate} icon={<ChevronDown className="size-4" />} />
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <Button
          variant="ghost"
          size="icon"
          aria-label={expanded ? "Collapse to drawer" : "Expand to full screen"}
          aria-pressed={expanded}
          title={expanded ? "Collapse to drawer" : "Expand to full screen"}
          onClick={onToggleMode}
          className="focus-ring text-text-secondary"
        >
          {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" aria-label="Close detail" title="Close (Esc)" onClick={onClose} className="focus-ring text-text-secondary">
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Where this task sits: its parents by TITLE (they are what a person recognises), each one a
 * link, then this task's own reference in the quietest register. Truncates rather than wraps.
 */
function Breadcrumb({ selection, detail, className }: { selection: Selection; detail: IssueDetail | undefined; className?: string }) {
  const session = useSession();
  const ancestors = detail?.ancestors ?? [];
  const milestone = detail?.milestone ?? null;
  return (
    <nav aria-label="Ancestry" className={cn("flex min-w-0 items-center gap-1 text-label text-text-tertiary", className)} data-detail-breadcrumb="">
      {/* Membership is not a parent, but it is where this work sits: the plan comes first. */}
      {milestone && detail ? (
        <span className="flex min-w-0 items-center gap-1">
          <MilestoneCrumb milestone={milestone} workspace={detail.workspace} />
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        </span>
      ) : null}
      {ancestors.map((ancestor) => (
        <span key={ancestor.id} className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            title={`${ancestor.identifier} · ${ancestor.title}`}
            onClick={() => session.open(detail!.workspace, ancestor.identifier)}
            className="focus-ring max-w-[18rem] min-w-0 truncate rounded-md px-1 py-0.5 text-text-secondary hover:bg-surface-hover hover:text-foreground pointer-coarse:py-2"
          >
            {ancestor.title}
          </button>
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        </span>
      ))}
      {/* Never wraps: on a phone the row gives its column to the title, so this is where the
          reference is read, and it has to read as one word. */}
      <span className="shrink-0 px-1 whitespace-nowrap" data-detail-identifier="">
        {detail?.issue.identifier ?? selection.ref}
      </span>
    </nav>
  );
}

/**
 * One of the two navigation chevrons. The TITLE is why this is a component: a disabled icon
 * button with no explanation has three different reasons to be off (at the end of the list,
 * showing a task the list does not contain, no list at all), and enabled, the title names
 * the destination. The `aria-label` stays constant so it does not churn under a screen
 * reader every time the selection moves.
 */
function NavButton({
  direction,
  target,
  nav,
  onNavigate,
  icon,
  large = false,
}: {
  /** The phone sheet: a full 44×44 target, as every control on a touch screen gets. */
  large?: boolean;
  direction: "prev" | "next";
  target: NavTarget | null;
  nav: NavState;
  onNavigate: (target: NavTarget | null) => void;
  icon: ReactNode;
}) {
  const label = direction === "prev" ? "Previous task" : "Next task";
  const hint = direction === "prev" ? "K, or Alt+Up" : "J, or Alt+Down";

  let title: string;
  if (target) title = `${label} — ${target.ref}  (${hint})`;
  else if (nav.total === 0) title = `${label} — no list to move through in this view`;
  else if (nav.index < 0) title = `${label} — this issue is not in the current list`;
  else title = direction === "prev" ? "Already at the top of the list" : "Already at the end of the list";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={title}
      disabled={!target}
      data-detail-nav={direction}
      className={cn("focus-ring text-text-secondary pointer-coarse:min-w-11", large && "size-11")}
      onClick={() => onNavigate(target)}
    >
      {icon}
    </Button>
  );
}

// ──────────────────────────────────────────────────────────────── content

/**
 * Everything under the bar, for a loaded detail. Exported so a test can render the loaded
 * layout directly; the panel above only adds the fetch, the bar and the phone's action bar.
 */
export function DetailContent({
  detail,
  presentation,
  expanded,
  mode,
  controller,
  refresh,
  onAuthError,
  requestOpen,
  onRequestApproval,
  onCloseRequest,
  onReview,
  gateRef,
}: {
  detail: IssueDetail;
  presentation: DetailPresentation;
  expanded: boolean;
  mode: UiMode;
  controller: IssueActionsController;
  refresh: () => void;
  onAuthError: (error: AuthError) => void;
  requestOpen: boolean;
  onRequestApproval: () => void;
  onCloseRequest: () => void;
  onReview: () => void;
  gateRef?: RefObject<HTMLDivElement | null>;
}) {
  const sheet = presentation === "sheet";
  const { issue } = detail;
  const gate = <GateSection detail={detail} controller={controller} requestOpen={requestOpen} onCloseRequest={onCloseRequest} />;

  return (
    <div
      data-detail-layout={sheet ? "sheet" : expanded ? "page" : "drawer"}
      className={cn(
        "flex w-full flex-col",
        expanded
          ? // The page: a readable column and a rail, centred as one block so neither is
            // stranded on a wide screen. Below `lg` the rail moves above the content.
            "mx-auto max-w-[calc(var(--container-readable)+17.5rem+3.5rem)] gap-8 px-6 pt-8 pb-12 lg:flex-row lg:items-start lg:gap-14 lg:px-8"
          : sheet
            ? "px-4 pt-3 pb-6"
            : "px-6 pt-6 pb-10",
      )}
    >
      <div className={cn("flex min-w-0 flex-1 flex-col", expanded && "lg:max-w-readable")}>
        {sheet ? <Breadcrumb selection={{ workspace: detail.workspace, ref: issue.identifier }} detail={detail} className="-ml-1 mb-1.5" /> : null}

        <InlineTitle issue={issue} workspace={detail.workspace} refresh={refresh} size={sheet ? "heading" : "display"} />

        <StatusLine detail={detail} controller={controller} withPill={!sheet} onRequestApproval={onRequestApproval} className="mt-3">
          {sheet ? null : (
            <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
              {/* A milestone is a plan, not work: nobody starts it; its plan is edited on its page. */}
              {opensPlan(detail) ? <OpenPlanAction workspace={detail.workspace} identifier={issue.identifier} /> : <PrimaryAction detail={detail} controller={controller} onReview={onReview} />}
              <OverflowMenu detail={detail} controller={controller} onRequestApproval={onRequestApproval} />
            </div>
          )}
        </StatusLine>

        {sheet ? <SummaryChips detail={detail} controller={controller} refresh={refresh} onRequestApproval={onRequestApproval} className="mt-4" /> : null}

        {/* On a desk the refusal sits right under the controls that caused it. */}
        {sheet ? null : <ActionRefusal controller={controller} className="mt-4" />}

        <div ref={gateRef} tabIndex={-1} className="scroll-mt-4 outline-none empty:hidden [&:not(:empty)]:mt-5" data-detail-gate="">
          {gate}
        </div>

        {!sheet && !expanded ? (
          <section aria-label="Properties" className="mt-6 border-t pt-4">
            <Properties detail={detail} layout="grid" mode={mode} refresh={refresh} />
          </section>
        ) : null}

        {sheet ? (
          <section aria-label="Properties" className="mt-3">
            <MoreDetails facts={detailFacts(detail, mode)}>
              <Properties detail={detail} layout="rail" mode={mode} refresh={refresh} phone />
            </MoreDetails>
          </section>
        ) : null}

        <DetailTabs detail={detail} sheet={sheet} refresh={refresh} onAuthError={onAuthError} />
      </div>

      {expanded ? (
        <aside
          aria-label="Properties"
          data-detail-rail=""
          className="w-full shrink-0 max-lg:order-first lg:sticky lg:top-8 lg:w-[17.5rem] lg:border-l lg:pl-6"
        >
          <Properties detail={detail} layout="rail" mode={mode} refresh={refresh} />
        </aside>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── status

/**
 * The status in plain words: the pill (the one status control) and one sentence. `children`
 * is the end of the line, where the desktop puts its primary action and ⋯.
 */
function StatusLine({
  detail,
  controller,
  withPill,
  onRequestApproval,
  className,
  children,
}: {
  detail: IssueDetail;
  controller: IssueActionsController;
  withPill: boolean;
  onRequestApproval: () => void;
  className?: string;
  children?: ReactNode;
}) {
  const plan = planOf(detail);
  const ctx = contextOf(detail, controller);
  const queuedAncestor = detail.queuedBy ? detail.ancestors.find((a) => a.identifier === detail.queuedBy!.identifier) : undefined;
  const sentence = statusSentence(
    {
      ...ctx,
      issue: detail.issue,
      childrenTotal: detail.children.length,
      childrenDone: detail.children.filter((child) => statusCategory(child.status) === "done").length,
      openBlockers: openBlockerCount(detail),
      unreachable: ctx.unreachable,
      // The breadcrumb names the parent by title, so the sentence does too, never by id.
      queuedByTitle: queuedAncestor?.title ?? null,
      queuedByParent: Boolean(queuedAncestor && queuedAncestor.id === detail.issue.parentId),
    },
    statusCategory,
  );

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2", className)} data-status-line="">
      {withPill ? <StatusMenu detail={detail} controller={controller} onRequestApproval={onRequestApproval} /> : null}
      <p
        data-status-sentence=""
        data-tone={sentence.tone}
        className={cn("m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-body text-text-secondary wrap-anywhere", !plan && sentence.tone === "attention" && "text-foreground")}
      >
        {plan ? <MilestoneSentence plan={plan} /> : null}
        {!plan && sentence.lead ? <span>{sentence.lead}</span> : null}
        {!plan && sentence.person ? <PersonChip name={sentence.person.name} kind={sentence.person.kind} className="max-w-full font-medium" /> : null}
        {!plan && sentence.tail ? <span>{sentence.tail}</span> : null}
        {!plan && sentence.at ? (
          <>
            <span aria-hidden className="text-text-tertiary">
              ·
            </span>
            <span className="text-text-tertiary">
              {sentence.atPrefix ? `${sentence.atPrefix} ` : ""}
              <RelativeTime iso={sentence.at} inSentence />
            </span>
          </>
        ) : null}
      </p>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── properties

/**
 * The readable properties. Kind leads (what IS this), then priority, the people, where it is
 * filed, and when things happened. Kind, priority, project and labels are editable where they
 * are read; the rest are facts. The raw values follow behind "More details" (except on the
 * phone, where the whole list is itself inside that disclosure).
 */
function Properties({
  detail,
  layout,
  mode,
  refresh,
  phone = false,
}: {
  detail: IssueDetail;
  layout: PropertyLayout;
  mode: UiMode;
  refresh: () => void;
  /** Inside the phone's "More details": the chips already carry kind, priority and assignee. */
  phone?: boolean;
}) {
  const { issue, workspace } = detail;
  const editor = { issue, workspace, refresh };
  const plan = planOf(detail);

  return (
    <div className="flex flex-col gap-3">
      <PropertyList layout={layout}>
        {phone ? null : (
          <>
            <PropertyRow label="Kind">
              <InlineKind {...editor} />
            </PropertyRow>
            <PropertyRow label="Priority">
              <InlinePriority {...editor} />
            </PropertyRow>
            <PropertyRow label="Assignee">
              {issue.assignee ? <PersonChip name={issue.assignee} kind={issue.assignee === issue.checkoutAgent ? "agent" : "human"} /> : <EmptyValue>No one yet</EmptyValue>}
            </PropertyRow>
          </>
        )}
        <PropertyRow label="Project">
          <InlineProject {...editor} />
        </PropertyRow>
        {detail.milestone ? (
          <PropertyRow label="Milestone">
            <MilestoneValue milestone={detail.milestone} workspace={workspace} />
          </PropertyRow>
        ) : null}
        {plan ? (
          <>
            <PropertyRow label="Due">
              <MilestoneDue plan={plan} />
            </PropertyRow>
            {plan.milestone.startDate ? (
              <PropertyRow label="Starts">
                <span>{plan.milestone.startDate}</span>
              </PropertyRow>
            ) : null}
          </>
        ) : null}
        {issue.startedAt ? (
          <PropertyRow label="Started">
            <RelativeTime iso={issue.startedAt} inSentence />
          </PropertyRow>
        ) : null}
        {issue.completedAt ? (
          <PropertyRow label="Finished">
            <RelativeTime iso={issue.completedAt} inSentence />
          </PropertyRow>
        ) : null}
        {issue.cancelledAt ? (
          <PropertyRow label="Cancelled">
            <RelativeTime iso={issue.cancelledAt} inSentence />
          </PropertyRow>
        ) : null}
        <PropertyRow label="Updated">
          <RelativeTime iso={issue.updatedAt} inSentence />
        </PropertyRow>
        <PropertyRow label="Created">
          <RelativeTime iso={issue.createdAt} inSentence />
        </PropertyRow>
        <PropertyRow label="Labels" span>
          <InlineLabels {...editor} />
        </PropertyRow>
      </PropertyList>
      {phone ? null : <MoreDetails facts={detailFacts(detail, mode)} />}
    </div>
  );
}

/**
 * The phone's summary: status, priority, kind and the assignee as wrapping chips, each a
 * finger-sized control (the status and the two editors) or a fact (the person).
 */
function SummaryChips({
  detail,
  controller,
  refresh,
  onRequestApproval,
  className,
}: {
  detail: IssueDetail;
  controller: IssueActionsController;
  refresh: () => void;
  onRequestApproval: () => void;
  className?: string;
}) {
  const { issue, workspace } = detail;
  // Chip editors report a refusal to the panel's one refusal slot instead of drawing it inside
  // the chip row, where it would break the row and fall out of view on a phone.
  const editor = { issue, workspace, refresh, variant: "chip" as const, report: controller.report };
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} data-summary-chips="">
      <StatusMenu detail={detail} controller={controller} onRequestApproval={onRequestApproval} className="h-9 px-3" />
      <InlinePriority {...editor} />
      <InlineKind {...editor} />
      <span className="inline-flex h-9 max-w-full min-w-0 items-center rounded-full border border-border bg-surface-raised px-3 text-label font-medium pointer-coarse:h-11" data-summary-assignee="">
        {issue.assignee ? (
          <PersonChip name={issue.assignee} kind={issue.assignee === issue.checkoutAgent ? "agent" : "human"} />
        ) : (
          <span className="text-text-tertiary">No assignee</span>
        )}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── tabs

/**
 * The tab strip. Sticky, so it is still reachable a thousand rows into an activity feed. On
 * a desk it is an underlined strip; on the phone a scrollable segmented control that never
 * clips a label mid-word: the edges fade while there is more to scroll, and the active tab
 * is scrolled into view.
 */
function DetailTabs({
  detail,
  sheet,
  refresh,
  onAuthError,
}: {
  detail: IssueDetail;
  sheet: boolean;
  refresh: () => void;
  onAuthError: (error: AuthError) => void;
}) {
  const [tab, setTab] = useState("overview");
  /**
   * A tab asking to hand the reader to another tab (Details' worklog "Show all" lands on
   * Documents). This file subscribes to a verb and sets its own state; see
   * `onOpenDetailTab` in tabs/registry.ts for why it is an event and not a prop.
   */
  useEffect(() => onOpenDetailTab(setTab), []);
  const tabs = visibleTabs(detail);
  const active = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? "overview");
  const stripRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(stripRef, tabs.length);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stuck = useStuck(sentinelRef);

  // Bring the active tab into view inside the strip, horizontally only: scrollIntoView
  // would also scroll the panel to the strip, which is not what choosing a tab means.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const trigger = strip?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!strip || !trigger || strip.scrollWidth <= strip.clientWidth) return;
    const left = trigger.offsetLeft - (strip.clientWidth - trigger.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [active]);

  return (
    <Tabs value={active} onValueChange={setTab} className={cn("gap-0", sheet ? "mt-5" : "mt-8")}>
      {/* Zero-height marker just above the strip: once it scrolls out, the strip is stuck
          and content runs under it, so the strip grows a hairline to separate the two. */}
      <div ref={sentinelRef} aria-hidden className="h-0" />
      <div
        className={cn("sticky top-0 z-10 bg-card transition-[border-color,box-shadow] duration-150", sheet ? "-mx-4 border-b border-transparent px-4 py-2" : "border-b")}
        data-detail-tabs=""
        data-stuck={stuck ? "" : undefined}
      >
        <div className="staple-detail-tabfade" data-fade-start={edges.start ? "" : undefined} data-fade-end={edges.end ? "" : undefined}>
          <TabsList
            ref={stripRef}
            variant={sheet ? "default" : "line"}
            className={cn("staple-detail-tabstrip w-full justify-start", sheet && "staple-detail-segments")}
          >
            {tabs.map((definition) => (
              <TabsTrigger key={definition.id} value={definition.id} className="focus-ring-inset flex-none">
                {definition.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </div>
      {tabs.map((definition) => {
        const Tab = definition.component;
        return (
          <TabsContent key={definition.id} value={definition.id} className="pt-5">
            <Tab detail={detail} workspace={detail.workspace} onAuthError={onAuthError} refresh={refresh} />
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

/** Whether a horizontal scroller has more content before or after what is showing. */
function useScrollEdges(ref: RefObject<HTMLElement | null>, contentKey: unknown): { start: boolean; end: boolean } {
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const max = element.scrollWidth - element.clientWidth;
      const next = { start: element.scrollLeft > 1, end: max - element.scrollLeft > 1 };
      setEdges((current) => (current.start === next.start && current.end === next.end ? current : next));
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [ref, contentKey]);
  return edges;
}

/** Whether the element after `sentinel` is stuck: the sentinel has scrolled out of the panel. */
function useStuck(sentinel: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const element = sentinel.current;
    const root = element?.closest(".staple-detail-scroll");
    if (!element || !root || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry!.isIntersecting && entry!.boundingClientRect.top < (entry!.rootBounds?.top ?? 0) + 1), { root, threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sentinel]);
  return stuck;
}
