/**
 * A parent's Pull requests row beyond its own links: each pull request recorded on one of its
 * descendants, drawn as the same chip its own are (state glyph, shortest key) and followed by
 * the tickets it is recorded on, each a button that opens that ticket. A pull request on the
 * parent itself stays the parent's own chip, and names the descendants it is also on after it.
 *
 * The set is the server's (`subtreePullRequests` on `/api/issue`, core/subtree-pull-requests.ts),
 * so the detail, the row badge and the agent surfaces list the same pull requests.
 */
import type { SubtreePullRequest } from "../../../../core/subtree-pull-requests";
import type { ExternalItem } from "../../../../core/integrations/contracts";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { linkTone, shortKey } from "./link-state";
import { LinkGlyph } from "./parts";
import type { SourceItem } from "./model";

/** A pull request of the set as a source item, so tone and key read exactly as a linked one's do. */
export function subtreeItem(pr: SubtreePullRequest): SourceItem {
  const item: ExternalItem = {
    ref: { providerId: pr.providerId, host: "", scopeId: "", containerId: "", id: String(pr.number ?? ""), kind: "pull_request" },
    key: pr.key,
    url: pr.url,
    title: pr.title ?? "",
    body: null,
    status: pr.state ? { id: pr.state, name: pr.state } : null,
    fetchedAt: pr.fetchedAt ?? "",
  };
  return item;
}

/** The pull requests only a descendant carries: the ones a parent's own chips do not already draw. */
export function descendantPullRequests(detail: { subtreePullRequests?: SubtreePullRequest[] }): SubtreePullRequest[] {
  return (detail.subtreePullRequests ?? []).filter((pr) => !pr.own);
}

/** The descendants a pull request is recorded on, beyond the ticket shown. */
export function otherTickets(pr: SubtreePullRequest, issueId: string) {
  return pr.tickets.filter((ticket) => ticket.id !== issueId);
}

/** A 44px target on a finger, as the chips beside it get. */
const HIT = "relative pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:inset-x-0 pointer-coarse:before:content-['']";

/** The tickets a pull request is recorded on, each opening that ticket. */
export function SubtreeTickets({ workspace, tickets, also = false }: { workspace: string; tickets: SubtreePullRequest["tickets"]; also?: boolean }) {
  const session = useSession();
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-label text-text-tertiary" data-subtree-tickets="">
      <span aria-hidden>{also ? "also" : "·"}</span>
      {tickets.map((ticket, index) => (
        <span key={ticket.id} className="inline-flex items-center">
          <button
            type="button"
            data-subtree-ticket={ticket.identifier}
            title={`${ticket.identifier} · ${ticket.title}`}
            aria-label={`Open ${ticket.identifier}, ${ticket.title}`}
            onClick={() => session.open(workspace, ticket.identifier)}
            className={cn("focus-ring rounded-sm whitespace-nowrap tabular-nums text-text-secondary hover:text-foreground hover:underline", HIT)}
          >
            {ticket.identifier}
          </button>
          {index < tickets.length - 1 ? <span aria-hidden>,</span> : null}
        </span>
      ))}
    </span>
  );
}

/** One descendant's pull request: the chip opens it at the provider, the identifiers open its tickets. */
export function SubtreePullRequestChip({ pr, workspace, peers }: { pr: SubtreePullRequest; workspace: string; peers: readonly SourceItem[] }) {
  const item = subtreeItem(pr);
  return (
    <span
      data-subtree-pr={pr.key}
      className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md border px-1.5 text-label tabular-nums text-foreground"
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={[pr.key, pr.title, pr.state].filter(Boolean).join(", ")}
        title={pr.title ?? pr.key}
        className={cn("focus-ring inline-flex min-w-0 items-center gap-1 rounded-sm hover:underline", HIT)}
      >
        <LinkGlyph kind="pull_request" tone={linkTone(item)} className="size-3.5" />
        <span data-link-key="">{shortKey(item, peers)}</span>
      </a>
      <SubtreeTickets workspace={workspace} tickets={pr.tickets} />
    </span>
  );
}
