import { requestExternalSection } from "./external-section";
import { useOptionalSession } from "@/lib/session";
import { openTabOnArrival, openDetailTab } from "@/detail/tabs/registry";
import type { ExternalRowSummary } from "../../../../core/integrations/link-store";
import { leadingTone } from "./link-state";
import { LinkGlyph } from "./parts";
import { LinkHoverCard, LinkListCard, previewTones } from "./LinkHoverCard";
import { ChecksMark } from "./PullRequestParts";
import type { ChecksState } from "./pull-requests";

/** A row's counted badge: a glyph and a number, quiet until hovered, a 44px target on a finger. */
export const ROW_COUNT_BADGE =
  "focus-ring relative inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-label tabular-nums text-text-tertiary hover:bg-[var(--surface-selected)] hover:text-foreground focus-visible:bg-[var(--surface-selected)] data-[state=open]:bg-[var(--surface-selected)] data-[state=open]:text-foreground pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:content-['']";

/**
 * From a row, the way to all of a ticket's links: its External links tab on the wanted
 * section, opening the ticket first when it is not the one already open.
 */
export function useShowExternalLinks(workspace: string, issueId: string, issueRef: string | undefined, kind: "issue" | "pull_request") {
  const session = useOptionalSession();
  return () => {
    requestExternalSection(kind);
    if (
      session?.selection?.workspace === workspace &&
      (session.selection.id === issueId || session.selection.ref === issueId)
    )
      openDetailTab("external-links");
    else {
      openTabOnArrival(issueRef ?? issueId, "external-links");
      session?.open(workspace, issueId);
    }
  };
}

/**
 * A task row's linked issues and pull requests: a glyph and a count each, the list on hover, focus or tap.
 * `withoutPullRequests` when the row's pull request badge (PrBadge) already draws them, so a pull
 * request is never on the row twice.
 */
export function ExternalLinkBadges({
  summary,
  workspace,
  issueId,
  issueRef,
  withoutPullRequests = false,
  pullRequestChecks = null,
}: {
  summary?: ExternalRowSummary;
  workspace: string;
  issueId: string;
  issueRef?: string;
  withoutPullRequests?: boolean;
  /** The mark the counted pull requests wear when one of them has failing or pending checks. */
  pullRequestChecks?: ChecksState | null;
}) {
  if (!summary || (!summary.issues.count && (withoutPullRequests || !summary.pullRequests.count))) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" data-external-link-badges>
      <Badge group={summary.issues} kind="issue" workspace={workspace} issueId={issueId} issueRef={issueRef} />
      {withoutPullRequests ? null : <Badge group={summary.pullRequests} kind="pull_request" workspace={workspace} issueId={issueId} issueRef={issueRef} checks={pullRequestChecks} />}
    </span>
  );
}

function Badge({
  group,
  kind,
  workspace,
  issueId,
  issueRef,
  checks = null,
}: {
  group: ExternalRowSummary["issues"];
  kind: "issue" | "pull_request";
  workspace: string;
  issueId: string;
  issueRef?: string;
  checks?: ChecksState | null;
}) {
  const showAll = useShowExternalLinks(workspace, issueId, issueRef, kind);
  if (!group.count) return null;
  const count = `${group.count} linked ${kind === "issue" ? "issue" : "pull request"}${group.count === 1 ? "" : "s"}`;
  const label = checks === "failing" ? `${count}, checks failing` : checks === "pending" ? `${count}, checks pending` : count;
  return (
    <LinkHoverCard
      aria-label={label}
      cardLabel={label}
      align="end"
      data-link-badge={kind}
      className={ROW_COUNT_BADGE}
      card={(close) => (
        <LinkListCard
          kind={kind}
          count={group.count}
          items={group.items}
          onShowAll={() => {
            close();
            showAll();
          }}
        />
      )}
    >
      <LinkGlyph kind={kind} tone={leadingTone(previewTones(group.items, kind))} className="size-3.5" />
      <span>{group.count}</span>
      <ChecksMark checks={checks} />
    </LinkHoverCard>
  );
}
