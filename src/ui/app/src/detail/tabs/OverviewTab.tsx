/**
 * The Details tab: what the issue is and what it is waiting on. The description and the
 * acceptance criteria read as clean content (the criteria as a checklist), then where the
 * work stands, then what it waits on, what it holds up and the tasks inside it. Empty
 * sections are not drawn; ancestry is the breadcrumb above the title.
 *
 * Deliberately the *static* half of the detail. Anything that changes over time —
 * comments, events, revisions — belongs in the Activity tab (U3), not here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE EXCEPTION TO THAT RULE, AND WHY IT IS ONE — W3 (STA-115).
 *
 * The worklog panel below shows a document that changes, so the rule as written
 * forbids it. VP approved the exception (STA-108 §6, Q3) and it is amended here rather
 * than quietly broken, because a charter nobody edits is a charter nobody believes.
 *
 * The distinction the rule was really drawing is STREAM versus STATE, not static
 * versus changing. Activity answers "what happened, in what order" — every comment,
 * every status move, every revision, growing forever. This panel answers "where does
 * the work stand right now": ONE document, its LATEST revision only, no history, no
 * chronology, replaced rather than appended. That is the same kind of fact as the
 * status badge and the assignee, both of which change constantly and have always
 * lived on this tab without anybody calling it a stream.
 *
 * And it is the fact this tab exists to carry. The whole point of Overview is "what is
 * this ticket"; for a ticket somebody is halfway through, the honest answer to that is
 * the handoff its agent wrote, not the description written before any of it started.
 * The reader in §1b of the spec — an agent resuming an interrupted task — lands here
 * first, and made four deliberate clicks to reach a document written specifically so
 * that nobody would have to ask.
 *
 * THE RULE IS NARROWED, NOT REPEALED. What Overview may now show is a pinned current
 * value of a named document. It still may not show history, a feed, a diff, or a
 * count of things that have happened. If a future ticket wants a *second* changing
 * thing here, it does not get to cite this comment — it has to make its own argument.
 */
import { ArrowUpRight, CircleAlert, CircleCheck, FileText, Hourglass } from "lucide-react";
import { useCallback, useMemo } from "react";
import { StatusIcon, TaskList } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { getDocument } from "@/lib/api";
import type { AuthError } from "@/lib/api";
import { blockingDescriptor, needsBorrowedDescriptor } from "@/lib/derived-blocked";
import { Markdown } from "@/lib/markdown";
import { useSession } from "@/lib/session";
import { statusCategory, statusLabel } from "@/lib/settings";
import type { CrossBlocker, IssueDocumentMeta, IssueRef } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "../parts/cn";
import { displayExcerptLine, excerptWorklog, WORKLOG_KEY } from "@/lib/worklog";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { DetailCard, PersonChip, RelativeTime, SectionHeading, actorLabel } from "../parts";
import { unreachableBlockers } from "../IssueActions";
import { openDetailTab, type TabProps } from "./registry";
import { MilestoneMembers } from "../MilestoneParts";
import { MilestoneGoalSection } from "../MilestoneGoal";

/**
 * A related task as one quiet row: its status icon, its title, and its reference at the end.
 * The whole row opens it.
 */
function RelationRow({ relation, onOpen }: { relation: IssueRef; onOpen: (identifier: string) => void }) {
  return (
    <li>
      <button
        type="button"
        data-status={relation.status}
        data-relation={relation.identifier}
        title={`${relation.identifier} · ${statusLabel(relation.status)}`}
        onClick={() => onOpen(relation.identifier)}
        className="focus-ring group flex min-h-10 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-surface-hover"
      >
        <StatusIcon status={relation.status} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-body text-foreground">{relation.title}</span>
        <span className="shrink-0 text-label text-text-tertiary">{relation.identifier}</span>
        <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-text-tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      </button>
    </li>
  );
}

/**
 * A blocker in another workspace file. Reachable ones read like any other row, with their
 * workspace. One this computer can't see says which of the two reasons it is, and what the
 * person can do, in the wording the Connections tab uses too.
 */
function CrossRow({ blocker, missing }: { blocker: CrossBlocker & { title?: string | null }; missing: "workspace" | "task" | null }) {
  if (missing) {
    return (
      <li data-cross-blocker={blocker.identifier} data-missing={missing} className="flex min-w-0 items-start gap-2.5 rounded-lg border border-dashed px-2 py-2 text-body">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--status-task-blocked)]" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-foreground wrap-anywhere">
            {missing === "workspace" ? `${blocker.identifier} is in ${blocker.workspace}, which isn't on this computer.` : `${blocker.identifier} can't be found in ${blocker.workspace}.`}
          </span>
          <span className="text-label text-text-secondary">
            {missing === "workspace" ? "Open that workspace on this computer, or remove the link if it no longer applies." : "It may have been deleted or renamed. Remove the link if it no longer applies."}
          </span>
        </span>
      </li>
    );
  }
  return (
    <li data-cross-blocker={blocker.identifier} className="flex min-h-10 min-w-0 items-center gap-2.5 rounded-lg border border-dashed px-2 text-body" title={blocker.workspace}>
      {blocker.status ? <StatusIcon status={blocker.status} className="size-4 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate text-foreground">{blocker.title || blocker.identifier}</span>
      <span className="shrink-0 text-label text-text-tertiary">{`${blocker.title ? `${blocker.identifier} · ` : ""}in ${blocker.workspace}${blocker.status ? ` · ${statusLabel(blocker.status)}` : ""}`}</span>
    </li>
  );
}

/**
 * A note about why the task is waiting: an icon, a sentence, and whatever the reader can do
 * about it. `tone="blocked"` borrows the blocked hue; a review gate stays neutral, because a
 * gate is the process working, not a fault.
 */
function Note({ tone, icon: Icon, children, ...rest }: { tone: "blocked" | "neutral"; icon: typeof Hourglass; children: React.ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div
      {...rest}
      className={cn(
        "mt-5 flex items-start gap-3 rounded-xl border px-4 py-3 text-body",
        tone === "blocked"
          ? "border-[var(--status-task-blocked)]/35 bg-[var(--status-task-blocked)]/[0.06]"
          : "bg-surface-sunken",
      )}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone === "blocked" ? "text-[var(--status-task-blocked)]" : "text-text-secondary")} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Where the work stands: the latest worklog, excerpted, with an honest way to the rest.
 *
 * THE GATE IS STRUCTURAL. This component is only rendered when `detail.documents` already
 * contains a worklog, so an issue without one does not mount the hook and cannot fire the
 * request. Revision and last-written time ride in on `/api/issue`'s `documents[]` for free;
 * only the body costs a request, and the author arrives with it.
 */
function WorklogPanel({
  meta,
  workspace,
  issueRef,
  onAuthError,
}: {
  meta: IssueDocumentMeta;
  workspace: string;
  issueRef: string;
  onAuthError: (error: AuthError) => void;
}) {
  // `currentRevision` in the dep list, not just the ref: a new checkpoint is exactly the
  // change this panel exists to show, and it does not move the issue's updated_at.
  const body = useResource(
    useCallback(() => getDocument({ ws: workspace, ref: issueRef, key: WORKLOG_KEY }), [workspace, issueRef]),
    [workspace, issueRef, meta.currentRevision],
    onAuthError,
  );

  const excerpt = useMemo(() => (body.data ? excerptWorklog(body.data.body) : null), [body.data]);
  const showAll = () => openDetailTab("documents", WORKLOG_KEY);

  return (
    <section aria-label="Worklog" className="mt-8">
      <SectionHeading
        action={
          <Button size="xs" variant="ghost" className="focus-ring text-text-secondary pointer-coarse:h-10 pointer-coarse:px-3" onClick={showAll} title="Open the full worklog in the Documents tab">
            Show all
          </Button>
        }
      >
        Where the work stands
      </SectionHeading>
      <DetailCard className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-secondary" data-worklog-byline="">
          <FileText aria-hidden className="size-3.5" />
          <span>Worklog</span>
          {body.data?.author ? (
            <>
              <span aria-hidden>·</span>
              <PersonChip name={body.data.author} kind="agent" size="sm" />
            </>
          ) : null}
          <span aria-hidden>·</span>
          <RelativeTime iso={meta.updatedAt} inSentence />
          <span className="ml-auto text-text-tertiary" title={`Revision ${meta.currentRevision}`}>
            Version {meta.currentRevision}
          </span>
        </div>

        {body.error ? <ErrorState error={body.error} /> : null}
        {!body.data && body.loading ? <LoadingState rows={2} /> : null}

        {excerpt ? (
          <div className="flex flex-col gap-1">
            {/* Tiers 1 and 2 found a section and can name it; tier 3 found the top of the
                document and must not pretend otherwise. */}
            {excerpt.label ? <p className="m-0 text-body font-medium text-foreground">{excerpt.label}</p> : null}
            {/* Plain lines rather than Markdown on purpose: an excerpt is a FRAGMENT, and a
                fragment ending mid-list renders as garbage. Documents keeps the formatting. */}
            <div className="flex min-w-0 flex-col gap-0.5 text-body wrap-anywhere whitespace-pre-wrap text-text-secondary">
              {excerpt.lines.map((line, i) => {
                const { text, heading } = displayExcerptLine(line);
                return (
                  <div key={i} className={cn(heading && "font-medium text-foreground")}>
                    {text}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {body.data && !excerpt ? <p className="m-0 text-body text-text-tertiary">This worklog is empty.</p> : null}

        {/* How much of the document this is, BEFORE offering the rest. */}
        {body.data && excerpt?.truncated ? (
          <p className="m-0 text-label text-text-tertiary">
            Showing {excerpt.lines.length} of {excerpt.totalLines} lines
          </p>
        ) : null}
      </DetailCard>
    </section>
  );
}

export function OverviewTab({ detail, workspace, onAuthError }: TabProps) {
  const session = useSession();
  const { issue } = detail;
  const openRef = (identifier: string) => session.open(workspace, identifier);
  const finished = statusCategory(issue.status) === "done";

  /**
   * A parent whose `blocked` was DERIVED from its children carries no descriptor of its own,
   * so it borrows its blocking children's, from `detail.children` already on the wire.
   */
  const borrowedBlockers = needsBorrowedDescriptor(issue) ? detail.children.filter((child) => child.status === "blocked") : [];

  /** Absent means no worklog: the panel is not rendered, so nothing is fetched. */
  const worklog = detail.documents.find((document) => document.key === WORKLOG_KEY);
  const waitingOn = detail.blockedBy.length + detail.crossBlockers.length;
  const unreachable = unreachableBlockers(detail, session.workspaces.map((w) => w.slug));

  return (
    <div className="flex flex-col" data-details-tab="">
      {issue.description ? (
        <Markdown text={issue.description} className="staple-detail-prose" />
      ) : (
        <p className="m-0 text-reading text-text-tertiary" data-no-description="">
          No description yet.
        </p>
      )}

      {/* A milestone's criteria are its goal, and the goal check says where each one stands. */}
      {detail.milestonePlan ? <MilestoneGoalSection plan={detail.milestonePlan} gate={detail.gate} workspace={workspace} /> : null}

      {!detail.milestonePlan && issue.acceptanceCriteria?.length ? (
        <section aria-label="Acceptance criteria" className="mt-8">
          <SectionHeading action={<span className="text-text-tertiary">{issue.acceptanceCriteria.length}</span>}>Done when</SectionHeading>
          <ul className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0" data-criteria="" aria-label={finished ? "Done when (met)" : "Done when"}>
            {issue.acceptanceCriteria.map((criterion, i) => (
              <li key={i} className="flex min-w-0 items-start gap-3 py-1.5 text-reading text-foreground" data-criterion={finished ? "met" : "open"}>
                {/* Read-only: the tracker keeps no tick per criterion, so nothing here looks
                    tickable. A quiet dot while open, a check once the task is done. */}
                {finished ? (
                  <CircleCheck aria-hidden className="mt-[3px] size-4 shrink-0 text-[var(--status-task-done)]" />
                ) : (
                  <span aria-hidden className="flex h-[22px] w-4 shrink-0 items-center justify-center">
                    <span className="size-1.5 rounded-full bg-text-tertiary" />
                  </span>
                )}
                <span className="min-w-0 flex-1 text-pretty wrap-anywhere">{criterion}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {issue.status === "blocked" && (issue.unblockOwner || issue.unblockAction) ? (
        <Note tone="blocked" icon={Hourglass} data-unblock="">
          <span className="wrap-anywhere">
            Waiting for <strong className="font-medium">{actorLabel(issue.unblockOwner)}</strong> to {issue.unblockAction ?? "unblock it"}.
          </span>
        </Note>
      ) : null}

      {/* A gate or a queue is said once, in the status line under the title, with the
          approval card right below it; the tab does not repeat it. */}

      {/* A parent blocked BY ITS CHILDREN: each line names the child it came from and opens it. */}
      {borrowedBlockers.length > 0 ? (
        <Note tone="blocked" icon={Hourglass} data-derived-blocked="true">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {borrowedBlockers.map((child) => (
              <li key={child.id} className="flex flex-wrap items-baseline gap-x-2">
                <span>{blockingDescriptor(child)}</span>
                <button type="button" onClick={() => openRef(child.identifier)} className="focus-ring rounded text-label text-text-secondary underline-offset-2 hover:underline">
                  {child.identifier}
                </button>
              </li>
            ))}
          </ul>
        </Note>
      ) : null}

      {/* After what the work IS, where it GOT TO, and only then what it is waiting on. */}
      {worklog ? <WorklogPanel meta={worklog} workspace={workspace} issueRef={issue.identifier} onAuthError={onAuthError} /> : null}

      {waitingOn > 0 ? (
        <section aria-label="Blocked by" className="mt-8">
          <SectionHeading action={<span className="text-text-tertiary">{waitingOn}</span>}>Waiting on</SectionHeading>
          <ul className="-mx-2 m-0 flex list-none flex-col gap-0.5 p-0">
            {detail.blockedBy.map((relation) => (
              <RelationRow key={relation.identifier} relation={relation} onOpen={openRef} />
            ))}
            {detail.crossBlockers.map((blocker) => (
              <CrossRow key={blocker.identifier} blocker={blocker} missing={unreachable.find((u) => u.identifier === blocker.identifier)?.missing ?? null} />
            ))}
          </ul>
        </section>
      ) : null}

      {detail.blocks.length > 0 ? (
        <section aria-label="Blocks" className="mt-8">
          <SectionHeading action={<span className="text-text-tertiary">{detail.blocks.length}</span>}>Holding up</SectionHeading>
          <ul className="-mx-2 m-0 flex list-none flex-col gap-0.5 p-0">
            {detail.blocks.map((relation) => (
              <RelationRow key={relation.identifier} relation={relation} onOpen={openRef} />
            ))}
          </ul>
        </section>
      ) : null}

      {detail.milestonePlan ? <MilestoneMembers plan={detail.milestonePlan} workspace={workspace} /> : null}

      {detail.children.length > 0 ? (
        <section aria-label="Children" className="mt-8">
          <SectionHeading action={<span className="text-text-tertiary">{detail.children.length}</span>}>Tasks inside</SectionHeading>
          {/* The SAME row the list renders, in the `panel` preset: one visual language for
              the same object, and every improvement to the row lands here for free. */}
          <DetailCard padded={false} className="overflow-hidden">
            <TaskList
              label="Children"
              preset="panel"
              rows={detail.children.map((child) => ({ workspace, issue: child, claim: null }))}
              currentRef={issue.identifier}
              onOpen={session.open}
            />
          </DetailCard>
        </section>
      ) : null}
    </div>
  );
}
