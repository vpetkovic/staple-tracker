/**
 * THE MILESTONE, WHEREVER A DETAIL MEETS ONE.
 *
 * Membership is a relation, not hierarchy, so neither `ancestors` nor `children` carries it.
 * Two facts on `/api/issue` do, and these are the pieces that print them:
 *
 *   - `detail.milestone` — what this issue counts toward, its own membership or the nearest
 *     ancestor's (`via`). Printed in the breadcrumb, as a property, and under "Part of".
 *   - `detail.milestonePlan` — on a milestone's own detail: its dates, state, progress and
 *     ordered members. Printed as the status sentence and "What is in this milestone".
 *
 * The member list reuses `memberListRows`, the Milestones page's own model, so the two
 * surfaces cannot disagree about what a milestone holds or how its epics indent.
 */
import { Milestone as MilestoneIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { TaskList } from "@/components/task-list";
import { getQueue } from "@/lib/api";
import { passesDone } from "@/lib/filters";
import { useSession } from "@/lib/session";
import type { EffectiveMilestone, EffectiveQueueRow, IssueDetail, MilestoneView } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import {
  dueText,
  progressDetailSentence,
  progressSegments,
  progressSentence,
  projectedDue,
  type ProjectedDue,
} from "@/views/milestones/milestone-plain";
import { MilestoneDueControl, useSetMilestoneTarget } from "@/views/milestones/MilestoneDue";
import { memberListRows, milestoneRisk } from "@/views/milestones/milestones-model";
import { openMilestoneIn } from "@/views/milestones/AllWorkspacesMilestones";
import { ProgressStrip } from "@/views/ProgressStrip";
import { DetailCard, SectionHeading, cn, useNow } from "./parts";

/** The milestone plan on a milestone's own detail, or null on every other issue. */
export function planOf(detail: IssueDetail): MilestoneView | null {
  return detail.milestonePlan ?? null;
}

/**
 * Does the primary action open the plan? Only for an open milestone: a finished one is not in
 * the Milestones list by default, and its primary is the ordinary Reopen.
 */
export function opensPlan(detail: IssueDetail): boolean {
  const state = planOf(detail)?.milestone.state;
  return state !== undefined && state !== "done" && state !== "cancelled";
}

/**
 * "3 of 9 tasks finished (33%). Due 11 Oct, in 13 days." — the milestone's status sentence,
 * with the due date said as the Milestones page says it (`dueText`): the set target, else the
 * projection from the work left, marked as an estimate.
 */
export function milestoneSentence(plan: MilestoneView, now: Date, projection: ProjectedDue | null = null, completedAt: string | null = null): string {
  return `${progressSentence(plan.progress)} ${dueText(plan.milestone, projection, now, completedAt)}.`;
}

/** The sentence as markup. Its own component so only a milestone's detail reads the clock. */
export function MilestoneSentence({ plan, completedAt = null }: { plan: MilestoneView; completedAt?: string | null }) {
  const now = useNow();
  const projection = projectedDue(plan.goal?.pace, now);
  return <span data-milestone-sentence="">{milestoneSentence(plan, now, projection, completedAt)}</span>;
}

/**
 * The Due property's value: the Milestones page's own due control, calendar and all, so the
 * date is set the same way in both places.
 */
export function MilestoneDue({ plan, workspace = "", completedAt = null }: { plan: MilestoneView; workspace?: string; completedAt?: string | null }) {
  const now = useNow();
  const projection = projectedDue(plan.goal?.pace, now);
  const write = useSetMilestoneTarget(workspace || undefined, plan.milestone.id);
  const finished = plan.milestone.state === "done" || plan.milestone.state === "cancelled";
  return (
    <span data-milestone-due="">
      <MilestoneDueControl
        milestone={plan.milestone}
        projection={projection}
        now={now}
        completedAt={completedAt}
        editable={!finished}
        busy={write.busy}
        error={write.error}
        onSetTarget={write.set}
      />
    </span>
  );
}

/** A milestone's primary action: its plan lives on the Milestones page, where it is edited. */
export function OpenPlanAction({
  workspace,
  identifier,
  size = "sm",
  className,
}: {
  workspace: string;
  identifier: string;
  size?: "sm" | "lg";
  className?: string;
}) {
  const session = useSession();
  return (
    <Button
      size={size}
      data-action="primary"
      data-primary="open-plan"
      onClick={() => openMilestoneIn(session, workspace, identifier)}
      className={cn("gap-1.5", className)}
    >
      <MilestoneIcon aria-hidden className="size-4" />
      Open plan
    </Button>
  );
}

/**
 * The Milestone property: the milestone by title, a link; and when the membership is
 * inherited, which ancestor it comes through — the reason an issue nobody added counts.
 */
export function MilestoneValue({ milestone, workspace }: { milestone: EffectiveMilestone; workspace: string }) {
  const session = useSession();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5" data-detail-milestone={milestone.identifier}>
      <button
        type="button"
        title={`${milestone.identifier} · ${milestone.title}`}
        onClick={() => session.open(workspace, milestone.identifier)}
        className="focus-ring flex min-w-0 items-center gap-1.5 rounded-md text-foreground hover:underline"
      >
        <MilestoneIcon aria-hidden className="size-3.5 shrink-0 text-text-secondary" />
        <span className="min-w-0 truncate">{milestone.title}</span>
      </button>
      {milestone.via ? (
        <span className="min-w-0 truncate text-text-tertiary" data-milestone-via={milestone.via.identifier}>
          via {milestone.via.title}
        </span>
      ) : null}
    </span>
  );
}

/** The breadcrumb's first stop: the milestone, before the real ancestors. */
export function MilestoneCrumb({ milestone, workspace }: { milestone: EffectiveMilestone; workspace: string }) {
  const session = useSession();
  return (
    <button
      type="button"
      title={`Milestone ${milestone.identifier} · ${milestone.title}`}
      onClick={() => session.open(workspace, milestone.identifier)}
      data-breadcrumb-milestone={milestone.identifier}
      className="focus-ring flex max-w-[18rem] min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-text-secondary hover:bg-surface-hover hover:text-foreground pointer-coarse:py-2"
    >
      <MilestoneIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{milestone.title}</span>
    </button>
  );
}

/**
 * A ticket an autopilot run created itself (a goal check or a follow-up: `originKind` `run`,
 * docs/runs.md "Goal mode") says so after its title, so the reader tells the plan a person
 * made from the work a goal run added to it. A member the page's list does not carry yet is
 * drawn from its member row, which has no origin, and says nothing until the next poll.
 */
export const MADE_BY_RUN_CAPTION = "Created by autopilot";

export function madeByRunCaption(row: { issue: { originKind: string } }): string | undefined {
  return row.issue.originKind === "run" ? MADE_BY_RUN_CAPTION : undefined;
}

/**
 * The milestone's progress bar and the sentence under it, read exactly as the Milestones page
 * reads them — the same buckets, the same queue reading, the same words — so the two surfaces
 * cannot give different figures for one milestone.
 */
export function MilestoneProgressSummary({
  plan,
  effective,
}: {
  plan: MilestoneView;
  /** The queue's effective rows; empty until the queue has answered, which counts statuses only. */
  effective: readonly EffectiveQueueRow[];
}) {
  if (plan.progress.countable === 0) return null;
  const risk = effective.length > 0 ? milestoneRisk(plan, effective) : null;
  return (
    <div className="mb-3" data-milestone-progress="">
      <ProgressStrip segments={progressSegments(plan.progress, risk)} label={progressSentence(plan.progress)} />
      <p className="mt-1.5 mb-0 text-label text-text-secondary" data-milestone-detail-sentence="">
        {progressDetailSentence(plan, risk)}
      </p>
    </div>
  );
}

const ignoreAuthError = () => {};

/** "What is in this milestone": progress, then the members in plan order with their epics' children. */
export function MilestoneMembers({ plan, workspace }: { plan: MilestoneView; workspace: string }) {
  const session = useSession();
  const filters = session.filters;
  const rows = useMemo(
    // This workspace's rows only: two workspaces may share a prefix in hub mode. The Tasks
    // list's done gate, so "Done hidden" hides the same members here as on the Milestones page.
    () =>
      memberListRows(
        plan,
        (session.issues.data ?? []).filter((row) => row.workspace === workspace),
        workspace,
        { visible: (row) => passesDone(row, filters) },
      ).map((entry) => entry.row),
    [plan, session.issues.data, workspace, filters],
  );
  // Blocked and gated are the queue's verdict (see `milestoneRisk`), read as the page reads it.
  const queue = useResource(
    useCallback(() => getQueue({ ws: workspace }), [workspace]),
    [workspace, session.version],
    ignoreAuthError,
  );
  return (
    <section aria-label="Milestone members" className="mt-8" data-milestone-members="">
      <SectionHeading action={<span className="text-text-tertiary">{plan.members.length}</span>}>What is in this milestone</SectionHeading>
      <MilestoneProgressSummary plan={plan} effective={queue.data?.effective ?? []} />
      {rows.length > 0 ? (
        <DetailCard padded={false} className="overflow-hidden">
          <TaskList label="Milestone members" preset="panel" rows={rows} captionOf={madeByRunCaption} onOpen={session.open} />
        </DetailCard>
      ) : (
        <p className="m-0 text-reading text-text-tertiary">Nothing is planned here yet. Add work from the Milestones page.</p>
      )}
    </section>
  );
}
