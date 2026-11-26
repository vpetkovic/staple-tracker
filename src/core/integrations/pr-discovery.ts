/**
 * Finding the pull requests opened for a ticket's branch, and keeping their saved state current.
 *
 * The integrations link store is the one record of a ticket's pull requests. This only adds to
 * it: for every open ticket with a branch (`ticket-branch.ts`), the GitHub repositories mapped
 * to the workspace are asked, through the local gh, for the pull requests whose head is that
 * branch, and each one found is linked. The ticket's other linked pull requests that can still
 * change (open or draft) are read again for their state and checks.
 *
 * Read-only at the provider, like every integration read: no comment, label, status or review
 * is written anywhere. It never changes a ticket's status either: a merged pull request is a
 * fact on the ticket, and finishing the ticket stays a person's or an agent's call. It never
 * unlinks: a pull request linked by hand, or one whose branch was renamed, stays.
 *
 * A connection that is not working, or a workspace with no GitHub repository mapped, finds
 * nothing and says why (`failures`, `note`) rather than failing: discovery runs in the
 * background of the web UI's poll, where an error has nowhere to go.
 */
import type { WorkspaceStore } from "../store.js";
import { type SubtreePullRequest, subtreePullRequestsFor } from "../subtree-pull-requests.js";
import { type TicketBranch, ticketBranches } from "../ticket-branch.js";
import { StapleError } from "../types.js";
import type { ConnectionHealthSnapshot, ConnectionState, ExternalItem } from "./contracts.js";
import type { ProviderConnection } from "./connections.js";
import { healthFromError, isConnectionFailure, ProbeCache, snapshot } from "./health.js";
import { externalResourceId, type LinkedPullRequest } from "./link-store.js";
import type { MappingTarget } from "./mapping.js";
import type { IntegrationReader } from "./provider.js";

/** The actor a link made by discovery records when no one asked for it by name. */
export const DISCOVERY_ACTOR = "staple";
/** At most this many already linked pull requests are read again per run, oldest saved copy first. */
const REFRESH_LIMIT = 25;

export interface DiscoveryFailure {
  connectionId: string | null;
  targetKeys: string[];
  state: ConnectionState;
  message: string;
  action: string | null;
}

export interface DiscoveredTicket {
  ref: string;
  branch: TicketBranch;
  /** Every pull request linked to the ticket after this run, found here or linked before. */
  pullRequests: LinkedPullRequest[];
}

export interface DiscoveryReport {
  tickets: DiscoveredTicket[];
  /** Links this run made. */
  linked: Array<{ ref: string; key: string; url: string }>;
  /** Saved copies this run read again. */
  refreshed: number;
  failures: DiscoveryFailure[];
  /** Why nothing could be asked at all, in a sentence; null when the mapped repositories were read. */
  note: string | null;
}

export interface DiscoveryDependencies {
  store: WorkspaceStore;
  /** The workspace's own mapped targets; repositories outside them are never read. */
  targets: MappingTarget[];
  connection(id: string): ProviderConnection | null;
  reader(connection: ProviderConnection): IntegrationReader;
  /** The connection's last known health, when this process has one. */
  health(connection: ProviderConnection): ConnectionHealthSnapshot | null;
  /** A live read failed on the connection: remember it so the next run and Settings both see it. */
  recordFailure(connection: ProviderConnection, health: ConnectionHealthSnapshot): void;
  /** A live read succeeded: a remembered failure is out of date. */
  recordSuccess(connection: ProviderConnection): void;
  actor: string;
  now?: () => number;
}

/** A remembered failure is trusted for this long, or until GitHub's own retry time when it gave one. */
const FAILURE_HOLD_MS = 120_000;

/** Find and refresh the pull requests of `refs` (every open ticket when omitted). */
export async function discoverPullRequests(deps: DiscoveryDependencies, refs?: readonly string[]): Promise<DiscoveryReport> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const issues = refs ? refs.map((ref) => store.getIssue(ref)) : store.listIssues({});
  const branches = ticketBranches(store, issues.map((issue) => issue.id));
  const working = issues.filter((issue) => branches.has(issue.id));
  const report: DiscoveryReport = { tickets: [], linked: [], refreshed: 0, failures: [], note: null };
  const links = store.externalLinks();
  const finish = (): DiscoveryReport => {
    const all = links.pullRequests();
    report.tickets = working.map((issue) => ({ ref: issue.identifier, branch: branches.get(issue.id)!, pullRequests: all.get(issue.id) ?? [] }));
    return report;
  };
  // Every open ticket's live linked pull requests are read again, branch or not; only the branch lookup needs one.
  const live = (pr: LinkedPullRequest) => pr.providerId === "github" && (pr.state === null || pr.state === "open" || pr.state === "draft");
  // A finished child's pull requests are drawn on its open parent (subtree-pull-requests.ts), so
  // they are read again while any ancestor is open. Discovery links only to open tickets, so
  // what finished descendants carry is the same before and after the branch lookup.
  const linkedBefore = links.pullRequests();
  const drawnOnParents = [...subtreePullRequestsFor(store, issues.map((issue) => issue.id), linkedBefore).values()].flat();
  if (working.length === 0 && !issues.some((issue) => (linkedBefore.get(issue.id) ?? []).some(live)) && !drawnOnParents.some(live)) {
    report.note = refs ? "This ticket has no branch. Record one with staple branch <ref> <branch>." : null;
    return finish();
  }
  const repositories = deps.targets.filter((target) => target.providerId === "github" && target.kind === "repository");
  if (repositories.length === 0) {
    report.note = "No GitHub repository is mapped to this workspace, so no pull requests were looked for. Map one in Settings > Integrations.";
    return finish();
  }
  const fail = (connection: ProviderConnection | null, key: string, state: ConnectionState, message: string, action: string | null) => {
    const seen = report.failures.find((f) => f.connectionId === (connection?.id ?? null) && f.state === state);
    if (seen) seen.targetKeys.push(key);
    else report.failures.push({ connectionId: connection?.id ?? null, targetKeys: [key], state, message, action });
  };
  /** The reader for a target, or null after saying why it cannot be read now. */
  const readers = new Map<string, IntegrationReader | null>();
  const readerFor = (target: MappingTarget): { connection: ProviderConnection; reader: IntegrationReader } | null => {
    const connection = target.connectionId ? deps.connection(target.connectionId) : null;
    if (!connection) {
      fail(null, target.key, "not_found", `No connection on this computer reads ${target.host}.`, "Add a connection for it in Settings > Integrations.");
      return null;
    }
    if (!readers.has(connection.id)) {
      const known = deps.health(connection);
      const hold = known && known.state !== "ready" ? Math.max(FAILURE_HOLD_MS, (known.retryAfterSeconds ?? 0) * 1000) : 0;
      if (known && known.state !== "ready" && now() - Date.parse(known.checkedAt) < hold) {
        fail(connection, target.key, known.state, known.message ?? "This connection is not working.", known.action);
        readers.set(connection.id, null);
      } else {
        const reader = deps.reader(connection);
        readers.set(connection.id, reader.capabilities.discoverPullRequests ? reader : null);
      }
    } else if (readers.get(connection.id) === null) {
      const known = deps.health(connection);
      if (known && known.state !== "ready") fail(connection, target.key, known.state, known.message ?? "This connection is not working.", known.action);
    }
    const reader = readers.get(connection.id);
    return reader ? { connection, reader } : null;
  };
  /** Runs one live read; a failure becomes a line in `failures`, and a connection failure also the connection's health. */
  const attempt = async <T>(connection: ProviderConnection, key: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      const value = await read();
      deps.recordSuccess(connection);
      return value;
    } catch (error) {
      if (!(error instanceof StapleError)) throw error;
      const health = snapshot(connection, healthFromError(error), new Date(now()));
      // A repository this account cannot read is that repository's answer, not the connection's:
      // the other mapped repositories are still read.
      if (isConnectionFailure(error) && error.code !== "forbidden") {
        deps.recordFailure(connection, health);
        readers.set(connection.id, null);
      }
      fail(connection, key, health.state, health.message ?? error.message, health.action);
      return null;
    }
  };

  const byBranch = new Map<string, typeof working>();
  for (const issue of working) {
    const name = branches.get(issue.id)!.name;
    byBranch.set(name, [...(byBranch.get(name) ?? []), issue]);
  }
  const seen = new Set<string>();
  const remember = (item: ExternalItem) => {
    seen.add(`${item.ref.host}/${item.ref.containerId}#${item.ref.id}`);
  };
  for (const target of repositories) {
    const served = readerFor(target);
    if (!served) continue;
    const found = await attempt(served.connection, target.key, () => served.reader.pullRequestsForBranches(target.containerId, [...byBranch.keys()]));
    for (const item of found ?? []) {
      remember(item);
      for (const issue of byBranch.get(item.pullRequest!.headBranch) ?? []) {
        const resourceId = externalResourceId(item.ref);
        const before = links.list(issue.id).some((link) => link.resource.id === resourceId);
        if (before) {
          links.remember(item, deps.actor);
          continue;
        }
        // A branch name used before this ticket existed (fix/typo, develop) names somebody else's
        // work: only a pull request opened since the ticket was filed is its own. And one a person
        // unlinked from this ticket stays unlinked.
        const opened = item.pullRequest!.createdAt;
        if (opened !== null && opened !== undefined && opened < issue.createdAt) continue;
        if (links.wasUnlinked(issue.id, resourceId)) continue;
        links.link(issue.id, item, deps.actor);
        report.linked.push({ ref: issue.identifier, key: item.key, url: item.url });
      }
    }
  }

  // Every open ticket's other linked pull requests that can still change: stacked ones on another
  // branch, ones linked by hand, ones on a ticket with no branch, ones on a finished descendant
  // of an open parent. Only in mapped repositories, each once, oldest saved copy first, so a
  // failing check is read again until it passes.
  const linkedNow = links.pullRequests();
  const once = new Set<string>();
  const stale = [...issues.flatMap((issue) => linkedNow.get(issue.id) ?? []), ...drawnOnParents]
    .filter((pr) => live(pr) && !once.has(pr.resourceId) && once.add(pr.resourceId))
    .map((pr) => ({ pr, resource: links.resource(pr.resourceId) }))
    .filter(({ resource }) => !seen.has(`${resource.ref.host}/${resource.ref.containerId}#${resource.ref.id}`))
    .sort((a, b) => (a.pr.fetchedAt ?? "").localeCompare(b.pr.fetchedAt ?? ""))
    .slice(0, REFRESH_LIMIT);
  for (const { resource } of stale) {
    const target = repositories.find((t) => t.host === resource.ref.host && t.containerId === resource.ref.containerId);
    if (!target) continue; // outside the mapping: never read
    const served = readerFor(target);
    if (!served) continue;
    const item = await attempt(served.connection, target.key, () => served.reader.pullRequestDetails(resource.ref));
    if (item) {
      links.remember(item, deps.actor);
      report.refreshed += 1;
    }
  }
  return finish();
}

/**
 * When each workspace's discovery last ran in this process, keyed by its database. The web UI's
 * poll asks every 1.5 s; this holds a run for the health poll interval and never runs two at once.
 */
export const discoveryRuns = new ProbeCache<number>();

const ROW_STATES = ["open", "draft", "unknown", "merged", "closed"] as const;
type RowState = (typeof ROW_STATES)[number];

/** The row badge's pull requests, as `/api/issues` sends them (`PullRequestRef`, ui lib/types.ts). */
export interface RowPullRequest {
  provider: "github";
  number: number;
  url: string;
  /** `unknown` while no state was read on this machine or shared: linked by URL, or synced without context. */
  state: RowState;
  title: string | null;
  updatedAt: string | null;
  /** On a parent's row, the tickets of its subtree the pull request is linked on; absent on a leaf's. */
  tickets?: string[];
  /** The checks on the head commit at the last read; absent when none were read (merged, closed, no checks). */
  checks?: "passing" | "failing" | "pending";
}

/** A parent's row: counts over its whole subtree set, which the row lists only the first of. */
export interface RowPullRequestCounts {
  total: number;
  /** Open or draft with failing checks; each also counts in `open` or `draft`. */
  failing: number;
  open: number;
  draft: number;
  unknown: number;
  merged: number;
  closed: number;
  /** Not recorded on the row's own ticket: only its descendants carry them. */
  inside: number;
}

/** A parent's row lists this many of its subtree set; its counts cover the whole set. */
export const PARENT_ROW_PULL_REQUESTS = 8;

/**
 * A row's `pullRequests`. A leaf's: every linked pull request, the ones still moving first
 * (open, draft, unknown, then merged and closed), newest first within a state. A GitHub pull
 * request is all a link can be, so every one is drawn: one with no state read yet draws as
 * unknown. A parent's (given its subtree set, `subtree-pull-requests.ts`): the ones with
 * failing checks first, then the same order, only the first `PARENT_ROW_PULL_REQUESTS`, each
 * naming the tickets it is linked on, and `pullRequestCounts` over the whole set.
 */
export function rowPullRequests(linked: readonly (LinkedPullRequest | SubtreePullRequest)[] | undefined): {
  pullRequests?: RowPullRequest[];
  pullRequestCounts?: RowPullRequestCounts;
} {
  const drawable = (linked ?? []).filter((pr) => pr.providerId === "github" && pr.number !== null);
  if (!drawable.length) return {};
  const stateOf = (pr: LinkedPullRequest): RowState => (ROW_STATES.includes(pr.state as RowState) && pr.state !== "unknown" ? (pr.state as RowState) : "unknown");
  const failing = (pr: LinkedPullRequest) => (pr.state === "open" || pr.state === "draft") && pr.checks?.state === "failing";
  const parent = drawable.some((pr) => "tickets" in pr);
  const rank = (pr: LinkedPullRequest) => (parent && failing(pr) ? -1 : ROW_STATES.indexOf(stateOf(pr)));
  const sorted = [...drawable].sort((a, b) => rank(a) - rank(b) || b.number! - a.number!);
  const row = (pr: LinkedPullRequest | SubtreePullRequest): RowPullRequest => ({
    provider: "github",
    number: pr.number!,
    url: pr.url,
    state: stateOf(pr),
    title: pr.title,
    updatedAt: pr.fetchedAt,
    ...(pr.checks ? { checks: pr.checks.state } : {}),
    ...("tickets" in pr ? { tickets: pr.tickets.map((ticket) => ticket.identifier) } : {}),
  });
  if (!parent) return { pullRequests: sorted.map(row) };
  const counts: RowPullRequestCounts = { total: drawable.length, failing: 0, open: 0, draft: 0, unknown: 0, merged: 0, closed: 0, inside: 0 };
  for (const pr of drawable) {
    counts[stateOf(pr)] += 1;
    if (failing(pr)) counts.failing += 1;
    if ("own" in pr && !pr.own) counts.inside += 1;
  }
  return { pullRequests: sorted.slice(0, PARENT_ROW_PULL_REQUESTS).map(row), pullRequestCounts: counts };
}
