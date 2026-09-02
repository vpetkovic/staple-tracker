/**
 * What the issue is and what it is waiting on: description, acceptance criteria,
 * relations (including cross-workspace blockers), children, ancestry.
 *
 * Deliberately the *static* half of the detail. Anything that changes over time —
 * comments, events, revisions — belongs in the Activity tab (U3), not here.
 */
import type { ReactNode } from "react";
import { IssueCard } from "@/components/IssueCard";
import { StatusBadge } from "@/components/StatusBadge";
import { blockingDescriptor, needsBorrowedDescriptor } from "@/lib/derived-blocked";
import { Markdown } from "@/lib/markdown";
import { useSession } from "@/lib/session";
import type { CrossBlocker, IssueRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { TabProps } from "./registry";

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-4 mb-1.5 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

function RelationChip({ relation, onOpen }: { relation: IssueRef; onOpen: (identifier: string) => void }) {
  return (
    <button
      type="button"
      data-status={relation.status}
      title={relation.title}
      onClick={() => onOpen(relation.identifier)}
      className="status-chip rounded border px-1.5 py-0.5 font-mono text-[11px] hover:opacity-80"
    >
      {relation.identifier} · {relation.status}
    </button>
  );
}

/**
 * A blocker in another workspace file. Dashed, because the hub knows it exists but this
 * page cannot open it; red when the file is not on this machine at all, which is a real
 * state an agent needs to see rather than an error to hide.
 */
function CrossChip({ blocker }: { blocker: CrossBlocker }) {
  return (
    <span
      title={`${blocker.workspace}${blocker.unresolvable ? " — workspace file not on this machine" : ""}`}
      className={cn(
        "rounded border border-dashed px-1.5 py-0.5 font-mono text-[11px]",
        blocker.unresolvable
          ? "border-[var(--status-task-blocked)] text-[var(--status-task-blocked)]"
          : "border-border text-muted-foreground",
      )}
    >
      {blocker.identifier} · {blocker.unresolvable ? "unresolvable" : (blocker.status ?? "?")}
    </span>
  );
}

export function OverviewTab({ detail, workspace }: TabProps) {
  const session = useSession();
  const { issue } = detail;
  const openRef = (identifier: string) => session.open(workspace, identifier);

  /**
   * A parent whose `blocked` was DERIVED from its children (STA-98) carries no
   * descriptor of its own, so it borrows its blocking children's. Computed from
   * `detail.children`, which is already on the wire — this panel needs no new
   * API, and what it shows can never disagree with the children listed below it.
   */
  const borrowedBlockers = needsBorrowedDescriptor(issue)
    ? detail.children.filter((child) => child.status === "blocked")
    : [];

  return (
    <div className="text-sm">
      {issue.description ? <Markdown text={issue.description} className="text-[13px]" /> : null}

      {issue.acceptanceCriteria?.length ? (
        <>
          <Heading>Acceptance criteria</Heading>
          <ul className="list-disc space-y-1 pl-5 text-[13px]">
            {issue.acceptanceCriteria.map((criterion, i) => (
              <li key={i}>{criterion}</li>
            ))}
          </ul>
        </>
      ) : null}

      {issue.status === "blocked" && (issue.unblockOwner || issue.unblockAction) ? (
        <p className="mt-3 rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/10 px-3 py-2 text-[13px]">
          unblock: {issue.unblockOwner ?? "?"} must {issue.unblockAction ?? "?"}
        </p>
      ) : null}

      {/*
        A parent blocked BY ITS CHILDREN (STA-98). Same slot and same colour as
        the descriptor above, because it answers the identical question — the
        only difference is whose sentence it is, so each line names the child it
        came from and opens it. Nothing here is styled as "derived": the
        descriptor IS the point, and a reader who wants provenance has the child
        identifier right there.
      */}
      {borrowedBlockers.length > 0 ? (
        <div
          data-derived-blocked="true"
          className="mt-3 rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/10 px-3 py-2 text-[13px]"
        >
          {borrowedBlockers.map((child) => (
            <div key={child.id} className="flex flex-wrap items-baseline gap-x-1.5">
              <span>{blockingDescriptor(child)}</span>
              <button
                type="button"
                onClick={() => openRef(child.identifier)}
                className="font-mono text-[11px] text-muted-foreground hover:underline"
              >
                {child.identifier}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <Heading>Blocked by</Heading>
      <div className="flex flex-wrap gap-1.5">
        {detail.blockedBy.length === 0 && detail.crossBlockers.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">none</span>
        ) : null}
        {detail.blockedBy.map((relation) => (
          <RelationChip key={relation.identifier} relation={relation} onOpen={openRef} />
        ))}
        {detail.crossBlockers.map((blocker) => (
          <CrossChip key={blocker.identifier} blocker={blocker} />
        ))}
      </div>

      <Heading>Blocks</Heading>
      <div className="flex flex-wrap gap-1.5">
        {detail.blocks.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">none</span>
        ) : (
          detail.blocks.map((relation) => (
            <RelationChip key={relation.identifier} relation={relation} onOpen={openRef} />
          ))
        )}
      </div>

      {detail.children.length > 0 ? (
        <>
          <Heading>Children</Heading>
          <div className="space-y-1.5">
            {detail.children.map((child) => (
              <IssueCard key={child.id} workspace={workspace} issue={child} showStatus onOpen={session.open} />
            ))}
          </div>
        </>
      ) : null}

      {detail.ancestors.length > 0 ? (
        <>
          <Heading>Ancestry</Heading>
          <div className="flex flex-wrap items-center gap-1.5">
            {detail.ancestors.map((ancestor) => (
              <button
                key={ancestor.id}
                type="button"
                onClick={() => openRef(ancestor.identifier)}
                className="flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] hover:border-ring"
              >
                <StatusBadge status={ancestor.status} />
                <span className="font-mono">{ancestor.identifier}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
