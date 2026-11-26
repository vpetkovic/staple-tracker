/**
 * One reading of a pull request for every surface that draws one: the task row's badge, the
 * detail's chips and roll-up, the External links tab and the phone's pill. Each surface gets
 * its pull requests in a different payload (a row's refs, a ticket's links, a parent's subtree
 * set); they all become a `PullRequestEntry` here, so state, checks, order and counts are
 * decided once. Pure.
 */
import type { SubtreePullRequest } from "../../../../core/subtree-pull-requests";
import type { PullRequestCounts, PullRequestRef } from "@/lib/types";
import { linkTone, shortKey, type LinkTone } from "./link-state";
import type { ExternalRowSummary } from "../../../../core/integrations/link-store";
import type { ExternalItemRef } from "../../../../core/integrations/contracts";
import type { RefreshTarget } from "./links-view";
import type { ExternalLink, SourceItem } from "./model";

export type PullRequestState = "open" | "draft" | "merged" | "closed" | "unknown";
export type ChecksState = "passing" | "failing" | "pending";

export interface EntryTicket {
  id: string;
  identifier: string;
  title: string;
  /** The direct child of the parent shown that this ticket sits under; null for the parent itself, absent from an older server. */
  childId?: string | null;
}

export interface PullRequestEntry {
  /** Stable among the entries shown together: the link resource's id, else the URL. */
  id: string;
  /** `owner/repo#12`, or `#12` when only the number is known (a row's refs). */
  key: string;
  url: string;
  title: string | null;
  state: PullRequestState;
  /** How the head commit's checks stand; null when merged, closed, without checks or never read. */
  checks: ChecksState | null;
  /** Names of the failing checks, when the payload carries them. */
  failing: string[];
  /** Recorded on the ticket shown itself. */
  own: boolean;
  /** Every ticket of the subtree it is recorded on; empty when the payload names none. */
  tickets: EntryTicket[];
  /** Where it lives at the provider, when the payload says: what refreshing its saved copy needs. */
  ref?: ExternalItemRef;
  /** When its saved copy was read; null when never. */
  fetchedAt?: string | null;
}

const STATES: readonly PullRequestState[] = ["open", "draft", "merged", "closed"];
const stateOf = (state: string | null | undefined): PullRequestState =>
  STATES.includes(state?.toLowerCase() as PullRequestState) ? (state!.toLowerCase() as PullRequestState) : "unknown";

/** Checks only say something about a pull request that can still change. */
const liveChecks = (state: PullRequestState, checks: ChecksState | null | undefined): ChecksState | null =>
  checks && (state === "open" || state === "draft" || state === "unknown") ? checks : null;

/** A pull request of a parent's subtree set. */
export function subtreeEntry(pr: SubtreePullRequest): PullRequestEntry {
  const state = stateOf(pr.state);
  return {
    id: pr.resourceId,
    key: pr.key,
    url: pr.url,
    title: pr.title,
    state,
    checks: liveChecks(state, pr.checks?.state),
    failing: pr.checks?.state === "failing" ? pr.checks.failing : [],
    own: pr.own,
    tickets: pr.tickets,
    // Absent from a server that predates it; the entry then lists but cannot be refreshed from here.
    ref: pr.ref as ExternalItemRef | undefined,
    fetchedAt: pr.fetchedAt,
  };
}

/** The state a link's tone stands for, so a provider that names its states differently (Azure DevOps) still counts. */
const TONE_STATE: Record<LinkTone, PullRequestState> = { open: "open", active: "open", draft: "draft", merged: "merged", done: "merged", closed: "closed", neutral: "unknown" };

/** A ticket's own linked pull request. */
export function linkEntry(link: ExternalLink): PullRequestEntry {
  const resource = link.resource;
  const state = TONE_STATE[linkTone(resource)];
  const checks = resource.pullRequest?.checks ?? null;
  return {
    id: resource.id,
    key: resource.key,
    url: resource.url,
    title: resource.title,
    state,
    checks: liveChecks(state, checks?.state),
    failing: checks?.state === "failing" ? checks.failing : [],
    own: true,
    tickets: [],
  };
}

/**
 * A row's ref carries no key, only the number and the URL. The repository is read from the
 * URL (`https://host/owner/repo/pull/12`), so a row's list can tell a pull request of another
 * repository apart the way the detail's does; a URL of another shape leaves the number alone.
 */
function rowKey(pr: PullRequestRef): string {
  const repository = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/[0-9]+/.exec(pr.url)?.[1];
  return repository ? `${repository}#${pr.number}` : `#${pr.number}`;
}

/** A task row's pull request. `tickets` are identifiers only there, so the entry's ids are the identifiers. */
export function rowEntry(pr: PullRequestRef, ownIdentifier?: string): PullRequestEntry {
  const tickets = (pr.tickets ?? []).map((identifier) => ({ id: identifier, identifier, title: "" }));
  return {
    id: pr.url,
    key: rowKey(pr),
    url: pr.url,
    title: pr.title ?? null,
    state: pr.state,
    checks: liveChecks(pr.state, pr.checks),
    failing: [],
    own: tickets.length === 0 || tickets.some((ticket) => ticket.identifier === ownIdentifier),
    tickets,
  };
}

/** The tone the shared glyph draws a state in. */
export const entryTone = (entry: Pick<PullRequestEntry, "state">): LinkTone => (entry.state === "unknown" ? "neutral" : entry.state);

const failingNow = (entry: PullRequestEntry) => entry.checks === "failing";

/**
 * What needs a person first: a failing check, then what is still open, then drafts, then
 * what is finished. A state never read sits with the live ones, since it may still be moving.
 */
function rank(entry: PullRequestEntry): number {
  if (failingNow(entry)) return 0;
  switch (entry.state) {
    case "open": return 1;
    case "draft": return 2;
    case "unknown": return 3;
    case "merged": return 4;
    case "closed": return 5;
  }
}

/** Sorted by what needs a person; ties keep the order given (the server's: own first, then the tree). */
export function byAttention<T extends PullRequestEntry>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

export interface PullRequestTally {
  total: number;
  /** Open or draft with a failing check. They are counted in `open` or `draft` as well. */
  failing: number;
  open: number;
  draft: number;
  merged: number;
  closed: number;
  unknown: number;
}

export function tallyOf(entries: readonly PullRequestEntry[]): PullRequestTally {
  const tally: PullRequestTally = { total: entries.length, failing: 0, open: 0, draft: 0, merged: 0, closed: 0, unknown: 0 };
  for (const entry of entries) {
    tally[entry.state] += 1;
    if (failingNow(entry)) tally.failing += 1;
  }
  return tally;
}

export type TallySegment = "failing" | PullRequestState;
/** The order every tally is read in: trouble, then what is moving, then what is finished. */
export const TALLY_ORDER: readonly TallySegment[] = ["failing", "open", "draft", "merged", "closed", "unknown"];

const SEGMENT_WORDS: Record<TallySegment, string> = {
  failing: "with failing checks",
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
  unknown: "state unknown",
};

export const segmentWords = (segment: TallySegment, count: number): string => `${count} ${SEGMENT_WORDS[segment]}`;

export const countWords = (count: number): string => `${count} pull request${count === 1 ? "" : "s"}`;

/** "1 with failing checks, 5 open, 2 draft, 2 merged": the breakdown alone; empty for an empty tally. */
export function tallyParts(tally: PullRequestTally): string {
  return TALLY_ORDER.filter((segment) => tally[segment] > 0)
    .map((segment) => segmentWords(segment, tally[segment]))
    .join(", ");
}

/** "10 pull requests: 1 with failing checks, 5 open, 2 draft, 2 merged". */
export function tallyWords(tally: PullRequestTally): string {
  const parts = tallyParts(tally);
  return parts ? `${countWords(tally.total)}: ${parts}` : countWords(tally.total);
}

/** "checks failing: unit, typecheck and 2 more", "checks pending"; null when there is nothing to say. */
export function checksWords(entry: Pick<PullRequestEntry, "checks" | "failing">): string | null {
  if (entry.checks === "pending") return "checks pending";
  if (entry.checks === "passing") return "checks passing";
  if (entry.checks !== "failing") return null;
  if (!entry.failing.length) return "checks failing";
  const named = entry.failing.slice(0, 3).join(", ");
  const more = entry.failing.length - 3;
  return `checks failing: ${named}${more > 0 ? ` and ${more} more` : ""}`;
}

/** "acme/shop#405, Validate card fields, open, checks failing": an entry read aloud. */
export function entryWords(entry: PullRequestEntry): string {
  const checks = entry.checks === "passing" ? null : checksWords(entry);
  return [entry.key, entry.title, entry.state === "unknown" ? "state unknown" : entry.state, checks].filter(Boolean).join(", ");
}

/**
 * An entry as a source item, for the shared key, glyph and state pill rules: they read the
 * key, the provider and the state, and nothing else an entry lacks.
 */
export const entryItem = (entry: PullRequestEntry): SourceItem =>
  ({
    key: entry.key,
    url: entry.url,
    title: entry.title ?? "",
    ref: { providerId: "github", host: "", scopeId: "", containerId: "", id: "", kind: "pull_request" },
    status: entry.state === "unknown" ? null : { id: entry.state, name: entry.state },
  }) as unknown as SourceItem;

const containerOf = (key: string) => key.slice(0, Math.max(0, key.lastIndexOf("#")));

/**
 * Each entry's key as a list of pull requests shows it. The repository most of them are in
 * goes unsaid (`#405`), the way the provider itself writes a pull request of the repository
 * being read; one from another repository keeps the shortest name that tells it apart
 * (`admin#88`). One stray pull request then never puts a prefix on every line.
 */
export function shortKeys(entries: readonly PullRequestEntry[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(containerOf(entry.key), (counts.get(containerOf(entry.key)) ?? 0) + 1);
  let home = "";
  let most = 0;
  for (const [container, count] of counts) if (count > most) [home, most] = [container, count];
  const items = entries.map(entryItem);
  return new Map(
    entries.map((entry, index) => {
      const hash = entry.key.lastIndexOf("#");
      // A key that names no number (another provider's) is shown whole.
      return [entry.id, hash > 0 && containerOf(entry.key) === home ? entry.key.slice(hash) : shortKey(items[index]!, items)];
    }),
  );
}

/** The tickets an entry is on, beyond the ticket shown. */
export const otherTickets = (entry: PullRequestEntry, shownId: string): EntryTicket[] =>
  entry.tickets.filter((ticket) => ticket.id !== shownId && ticket.identifier !== shownId);

/** The entries only a descendant carries: what a parent's own chips do not already draw. */
export const descendantEntries = (entries: readonly PullRequestEntry[]): PullRequestEntry[] => entries.filter((entry) => !entry.own);

/** A parent's whole set as entries; empty on a leaf, whose own links are its set. */
export function subtreeEntries(detail: { subtreePullRequests?: SubtreePullRequest[] }): PullRequestEntry[] {
  return (detail.subtreePullRequests ?? []).map(subtreeEntry);
}

/**
 * The pull requests of each direct child of the parent shown, its own and its descendants',
 * for the "Tasks inside" rows. A pull request is filed under a child through the `childId`
 * of the tickets it is on; a server that does not send it files it under the tickets
 * themselves, which covers direct children.
 */
export function entriesByChild(entries: readonly PullRequestEntry[]): Map<string, PullRequestEntry[]> {
  const byChild = new Map<string, PullRequestEntry[]>();
  for (const entry of entries) {
    const children = new Set(entry.tickets.map((ticket) => (ticket.childId === undefined ? ticket.id : ticket.childId)).filter((id): id is string => Boolean(id)));
    for (const child of children) {
      const list = byChild.get(child) ?? [];
      list.push(entry);
      byChild.set(child, list);
    }
  }
  return byChild;
}

/** An entry as a row's pull request ref, so a child's row in the detail draws the badge the list draws. */
export function entryRef(entry: PullRequestEntry, tickets?: string[]): PullRequestRef | null {
  const number = Number(/#([1-9][0-9]*)$/.exec(entry.key)?.[1]);
  if (!Number.isSafeInteger(number)) return null;
  return {
    provider: "github",
    number,
    url: entry.url,
    state: entry.state,
    title: entry.title,
    ...(entry.checks ? { checks: entry.checks } : {}),
    ...(tickets ? { tickets } : {}),
  };
}

/**
 * Whether a row's pull requests reach beyond the row's own ticket: a parent's subtree set
 * with at least one that a descendant carries. A parent whose pull requests are all its own
 * reads as a leaf does. The server's counts decide when it sends them, since the row then
 * holds only the first of the set.
 */
export function isSubtreeSet(prs: readonly PullRequestRef[] | undefined, ownIdentifier?: string, counts?: PullRequestCounts): boolean {
  if (counts) return counts.inside > 0;
  return (prs ?? []).some((pr) => (pr.tickets ?? []).some((ticket) => ticket !== ownIdentifier));
}

/** A row's tally: the server's counts over the whole set when it sent them, else what the row lists. */
export function rowTally(entries: readonly PullRequestEntry[], counts?: PullRequestCounts): PullRequestTally {
  if (!counts) return tallyOf(entries);
  const { total, failing, open, draft, merged, closed, unknown } = counts;
  return { total, failing, open, draft, merged, closed, unknown };
}

/**
 * A child row's pull requests under "Tasks inside": the entries filed under that child, each
 * naming only the tickets inside that child, so a leaf child reads as a leaf and a sub-parent
 * as a subtree set. `externalLinks` is the counted summary a phone row draws in the badge's
 * place. Nothing when the child has none.
 */
export function childPullRequests(entries: readonly PullRequestEntry[] | undefined, childId: string): { pullRequests?: PullRequestRef[]; externalLinks?: ExternalRowSummary } {
  const drawn = byAttention(entries ?? [])
    .map((entry) => {
      const inside = entry.tickets.filter((ticket) => (ticket.childId === undefined ? ticket.id : ticket.childId) === childId);
      // An entry that sits in another child is not this row's, whatever list it came in.
      if (!inside.length) return { entry, ref: null };
      const below = inside.some((ticket) => ticket.id !== childId);
      return { entry, ref: entryRef(entry, below ? inside.map((ticket) => ticket.identifier) : undefined) };
    })
    .filter((row): row is { entry: PullRequestEntry; ref: PullRequestRef } => row.ref !== null);
  if (!drawn.length) return {};
  const items = drawn.map(({ entry }) => ({
    id: entry.id,
    providerId: "github",
    host: "",
    containerId: "",
    key: entry.key,
    url: entry.url,
    title: entry.title,
    status: entry.state === "unknown" ? null : { id: entry.state, name: entry.state },
  }));
  return { pullRequests: drawn.map(({ ref }) => ref), externalLinks: { issues: { count: 0, items: [] }, pullRequests: { count: items.length, items } } };
}

/** The one mark a badge that stands for several wears: failing beats pending, and passing says nothing. */
export function worstChecks(entries: readonly Pick<PullRequestEntry, "checks">[]): ChecksState | null {
  if (entries.some((entry) => entry.checks === "failing")) return "failing";
  return entries.some((entry) => entry.checks === "pending") ? "pending" : null;
}

/** The entries whose saved copies can be read again from here: the ones the payload placed at a provider. */
export function refreshTargets(entries: readonly PullRequestEntry[]): RefreshTarget[] {
  return entries.filter((entry) => entry.ref).map((entry) => ({ resource: { id: entry.id, ref: entry.ref!, fetchedAt: entry.fetchedAt ?? null } }));
}
