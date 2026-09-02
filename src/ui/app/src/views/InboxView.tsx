/**
 * The agent inbox: what is ready to pick up, in pickup order, and what is waiting and
 * on whom. The server does the ordering and the ready/blocked partition — this view
 * renders it and nothing more, because the pickup order is a property of the tracker,
 * not of the page.
 */
import { useCallback } from "react";
import { IssueCard } from "@/components/IssueCard";
import { getInbox } from "@/lib/api";
import { borrowedWaitingLine, needsBorrowedDescriptor } from "@/lib/derived-blocked";
import { useSession } from "@/lib/session";
import type { AuthError } from "@/lib/api";
import type { InboxIssue } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { EmptyState, SectionHeading, ViewState } from "./ViewChrome";

/** Why this issue is not ready, in the words the tracker itself uses. */
function blockedReason(issue: InboxIssue): string {
  if (issue.unresolvedBlockers.length > 0) {
    return `waiting on ${issue.unresolvedBlockers.join(", ")}`;
  }
  // A parent whose `blocked` was derived has no descriptor of its own, so it
  // borrows its blocking children's (STA-98). Without this the card would read
  // "? must act" — the epic knows it is waiting but cannot say on whom.
  if (needsBorrowedDescriptor(issue)) {
    const borrowed = borrowedWaitingLine(issue.derivedBlockers);
    if (borrowed) return borrowed;
  }
  return `${issue.unblockOwner ?? "?"} must ${issue.unblockAction ?? "act"}`;
}

export function InboxView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const { assignee, ws, mode, version, selection } = session;

  const load = useCallback(() => getInbox({ assignee }), [assignee]);
  const resource = useResource(load, [assignee, version], onAuthError);

  return (
    <div className="mx-auto max-w-5xl">
      <ViewState resource={resource} empty="nothing open">
        {(rows) => {
          const visible = rows.filter((row) => mode !== "hub" || !ws || row.workspace === ws);
          if (visible.every((row) => row.inbox.ready.length === 0 && row.inbox.blocked.length === 0)) {
            return <EmptyState>nothing open</EmptyState>;
          }
          return visible.map((row) => (
            <section key={row.workspace}>
              {mode === "hub" ? (
                <SectionHeading className="font-mono">{row.workspace}</SectionHeading>
              ) : null}

              <SectionHeading>Ready — pickup order</SectionHeading>
              {row.inbox.ready.length === 0 ? (
                <EmptyState>nothing ready</EmptyState>
              ) : (
                <div className="space-y-1.5">
                  {row.inbox.ready.map((issue) => (
                    <IssueCard
                      key={issue.id}
                      workspace={row.workspace}
                      issue={issue}
                      claim={issue.claim}
                      showWorkspace={mode === "hub"}
                      showStatus
                      selected={selection?.ref === issue.identifier}
                      onOpen={session.open}
                    />
                  ))}
                </div>
              )}

              {row.inbox.blocked.length > 0 ? (
                <>
                  <SectionHeading>Blocked</SectionHeading>
                  <div className="space-y-1.5">
                    {row.inbox.blocked.map((issue) => (
                      <IssueCard
                        key={issue.id}
                        workspace={row.workspace}
                        issue={issue}
                        claim={issue.claim}
                        note={blockedReason(issue)}
                        showWorkspace={mode === "hub"}
                        showStatus
                        selected={selection?.ref === issue.identifier}
                        onOpen={session.open}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </section>
          ));
        }}
      </ViewState>
    </div>
  );
}
