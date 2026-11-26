/**
 * What the External links tab says about its links that does not need a DOM: the filter
 * counts, which links a connection on this computer can refresh, the one notice per
 * provider that cannot, and how old the oldest refreshable saved copy is. Pure.
 */
import { connectionStatus, isReady, type ConnectionView } from "./connection-status";
import { providerName } from "./link-state";
import type { ExternalLink } from "./model";

export function filterCounts(links: readonly ExternalLink[]): { all: number; issue: number; pull_request: number } {
  const issue = links.filter((l) => l.resource.ref.kind === "issue").length;
  return { all: links.length, issue, pull_request: links.length - issue };
}

/**
 * What refreshing a saved copy and judging its connection read of a link. A pull request a
 * parent lists from its descendants has this much too, so "Refresh all" covers the whole tab.
 */
export interface RefreshTarget {
  resource: Pick<ExternalLink["resource"], "id" | "ref" | "fetchedAt">;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "6 pull requests", "1 issue", "2 issues, 3 pull requests". */
export function countWords(links: readonly ExternalLink[]): string {
  const { issue, pull_request } = filterCounts(links);
  return [issue ? plural(issue, "issue") : null, pull_request ? plural(pull_request, "pull request") : null]
    .filter(Boolean)
    .join(", ");
}

/** A connection that could read this link: same provider and host, and beyond GitHub the same organisation or workspace. */
function serves(connection: ConnectionView, link: RefreshTarget): boolean {
  const ref = link.resource.ref;
  return (
    connection.providerId === ref.providerId &&
    connection.host === ref.host &&
    (connection.providerId === "github" || connection.scopeId === ref.scopeId)
  );
}

/** The ready connection that reads this link, named on every refresh so the server never has to choose between two accounts. */
export function refreshConnection(link: RefreshTarget, connections: readonly ConnectionView[]): string | null {
  return connections.find((c) => isReady(c) && serves(c, link))?.id ?? null;
}

export function isRefreshable(link: RefreshTarget, connections: readonly ConnectionView[]): boolean {
  return refreshConnection(link, connections) !== null;
}

/** Server messages do not always end their sentence; the notice continues after this one. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export interface ConnectionNotice {
  key: string;
  providerId: string;
  /** The first sentence: what is wrong with the connection. */
  text: string;
}

/** One notice per provider and host that has links here but no ready connection for them. */
export function connectionNotices(links: readonly RefreshTarget[], connections: readonly ConnectionView[]): ConnectionNotice[] {
  const notices = new Map<string, ConnectionNotice>();
  for (const link of links) {
    const { providerId, host } = link.resource.ref;
    const key = `${providerId} ${host}`;
    if (notices.has(key) || isRefreshable(link, connections)) continue;
    const name = providerName(providerId);
    const held = connections.find((c) => serves(c, link));
    const text = !held
      ? `${name} isn't connected on this computer.`
      : held.health?.message
        ? // A server sentence that already names the provider stands alone; any other gets the provider and its status first.
          held.health.message.includes(name)
          ? sentence(held.health.message)
          : `${name}: ${connectionStatus(held.health).label}. ${sentence(held.health.message)}`
        : `${name}: ${connectionStatus(held.health).label}.`;
    notices.set(key, { key, providerId, text });
  }
  return [...notices.values()];
}

/** The link with the oldest saved copy among those a connection here can refresh; null when none was ever read. */
export function oldestRefresh<T extends RefreshTarget>(links: readonly T[], connections: readonly ConnectionView[]): T | null {
  const read = links
    .filter((l) => l.resource.fetchedAt && isRefreshable(l, connections))
    .sort((a, b) => Date.parse(a.resource.fetchedAt!) - Date.parse(b.resource.fetchedAt!));
  return read[0] ?? null;
}

/** "2 of 8 could not be refreshed: <first message>", or null when all succeeded. */
export function refreshFailure(messages: readonly string[], total: number): string | null {
  return messages.length ? `${messages.length} of ${total} could not be refreshed: ${messages[0]}` : null;
}

/** Indent levels for a stack row: one per depth, never more than three. */
export const stackIndent = (depth: number): number => Math.min(depth, 3);

/** "Open on GitHub", "Open in Linear". */
export function openLabel(providerId: string): string {
  return providerId === "github" ? "Open on GitHub" : `Open in ${providerName(providerId)}`;
}
