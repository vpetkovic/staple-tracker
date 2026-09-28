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
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { TaskList } from "@/components/task-list";
import { useSession } from "@/lib/session";
import type { EffectiveMilestone, IssueDetail, MilestoneView } from "@/lib/types";
import { plainDue, progressSegments, progressSentence } from "@/views/milestones/milestone-plain";
import { memberListRows } from "@/views/milestones/milestones-model";
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

/** "3 of 9 tasks finished (33%). Due 11 Oct, in 13 days." — the milestone's status sentence. */
export function milestoneSentence(plan: MilestoneView, now: Date): string {
  return `${progressSentence(plan.progress)} ${plainDue(plan.milestone.targetDate, plan.milestone.state, now)}.`;
}

/** The sentence as markup. Its own component so only a milestone's detail reads the clock. */
export function MilestoneSentence({ plan }: { plan: MilestoneView }) {
  const now = useNow();
  return <span data-milestone-sentence="">{milestoneSentence(plan, now)}</span>;
}

/** The Due property's value, reading the clock for the same reason. */
export function MilestoneDue({ plan }: { plan: MilestoneView }) {
  const now = useNow();
  return <span data-milestone-due="">{plainDue(plan.milestone.targetDate, plan.milestone.state, now)}</span>;
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

/** "What is in this milestone": progress, then the members in plan order with their epics' children. */
export function MilestoneMembers({ plan, workspace }: { plan: MilestoneView; workspace: string }) {
  const session = useSession();
  const rows = useMemo(
    // This workspace's rows only: two workspaces may share a prefix in hub mode.
    () =>
      memberListRows(
        plan,
        (session.issues.data ?? []).filter((row) => row.workspace === workspace),
        workspace,
      ).map((entry) => entry.row),
    [plan, session.issues.data, workspace],
  );
  return (
    <section aria-label="Milestone members" className="mt-8" data-milestone-members="">
      <SectionHeading action={<span className="text-text-tertiary">{plan.members.length}</span>}>What is in this milestone</SectionHeading>
      {plan.progress.countable > 0 ? (
        <div className="mb-3">
          <ProgressStrip segments={progressSegments(plan.progress)} label={progressSentence(plan.progress)} />
        </div>
      ) : null}
      {rows.length > 0 ? (
        <DetailCard padded={false} className="overflow-hidden">
          <TaskList label="Milestone members" preset="panel" rows={rows} onOpen={session.open} />
        </DetailCard>
      ) : (
        <p className="m-0 text-reading text-text-tertiary">Nothing is planned here yet. Add work from the Milestones page.</p>
      )}
    </section>
  );
}
