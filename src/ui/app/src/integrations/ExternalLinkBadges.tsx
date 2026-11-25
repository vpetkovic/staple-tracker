import { requestExternalSection } from "./external-section";
import { useOptionalSession } from "@/lib/session";
import { openTabOnArrival, openDetailTab } from "@/detail/tabs/registry";
import type { ExternalRowSummary } from "../../../../core/integrations/link-store";
import { leadingTone } from "./link-state";
import { LinkGlyph } from "./parts";
import { LinkHoverCard, LinkListCard, previewTones } from "./LinkHoverCard";

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
}: {
  summary?: ExternalRowSummary;
  workspace: string;
  issueId: string;
  issueRef?: string;
  withoutPullRequests?: boolean;
}) {
  if (!summary || (!summary.issues.count && (withoutPullRequests || !summary.pullRequests.count))) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" data-external-link-badges>
      <Badge group={summary.issues} kind="issue" workspace={workspace} issueId={issueId} issueRef={issueRef} />
      {withoutPullRequests ? null : <Badge group={summary.pullRequests} kind="pull_request" workspace={workspace} issueId={issueId} issueRef={issueRef} />}
    </span>
  );
}

function Badge({
  group,
  kind,
  workspace,
  issueId,
  issueRef,
}: {
  group: ExternalRowSummary["issues"];
  kind: "issue" | "pull_request";
  workspace: string;
  issueId: string;
  issueRef?: string;
}) {
  const session = useOptionalSession();
  if (!group.count) return null;
  const label = `${group.count} linked ${kind === "issue" ? "issue" : "pull request"}${group.count === 1 ? "" : "s"}`;
  const showAll = () => {
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
  return (
    <LinkHoverCard
      aria-label={label}
      cardLabel={label}
      align="end"
      data-link-badge={kind}
      className="focus-ring relative inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-label tabular-nums text-text-tertiary hover:bg-[var(--surface-selected)] hover:text-foreground focus-visible:bg-[var(--surface-selected)] data-[state=open]:bg-[var(--surface-selected)] data-[state=open]:text-foreground pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:content-['']"
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
    </LinkHoverCard>
  );
}
