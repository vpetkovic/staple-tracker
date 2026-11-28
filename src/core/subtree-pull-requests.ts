/**
 * The pull requests of a parent's subtree: every pull request recorded on the parent and on
 * each of its descendants, so a feature is reviewed from its parent without opening each child.
 *
 * Read from the same links a ticket's own pull requests are (`ExternalLinkStore.pullRequests`),
 * one per pull request: the same one linked on two tickets of the subtree is listed once and
 * names both. The parent's own come first, then its descendants' in tree order (children by
 * creation, then by number, depth first), each listing the tickets it is recorded on in that
 * order. Done and cancelled descendants count: a merged pull request on a finished child is part
 * of the feature's history. A hidden idea (planning off) and everything under it does not.
 *
 * Only a parent has a subtree set: a ticket with no visible child gets none, and its own pull
 * requests stay where they always were. Two queries for any number of parents, never one per child.
 */
import type { PullRequestChecks } from "./integrations/contracts.js";
import type { LinkedPullRequest } from "./integrations/link-store.js";
import { IDEA_KIND } from "./plan.js";
import type { WorkspaceStore } from "./store.js";
import { MAX_TREE_DEPTH } from "./types.js";

/** A ticket of the subtree a pull request is recorded on. */
export interface PullRequestTicket {
  id: string;
  identifier: string;
  title: string;
  /**
   * The parent's direct child this ticket sits under: its own id when it is a direct child,
   * null for the parent itself. A child's row groups its whole branch's pull requests by it.
   */
  childId: string | null;
}

export interface SubtreePullRequest extends LinkedPullRequest {
  /** Recorded on the parent itself; false when only its descendants carry it. */
  own: boolean;
  /** Every ticket of the subtree it is recorded on: the parent first when `own`, then in tree order. */
  tickets: PullRequestTicket[];
}

interface SubtreeRow {
  root: string;
  top: string | null;
  id: string;
  identifier: string;
  title: string;
}

/**
 * The subtree set of each given ticket that has a visible child, keyed by its id. A ticket
 * without one is absent from the map. Pull requests that cannot be drawn are listed all the
 * same: what a surface draws is its own choice (`rowPullRequests`). A caller that has already
 * read the workspace's pull requests (`ExternalLinkStore.pullRequests()`) passes them as
 * `linked`, and the subtree walk is the only query.
 */
export function subtreePullRequestsFor(
  store: WorkspaceStore,
  rootIds: readonly string[],
  linked?: ReadonlyMap<string, readonly LinkedPullRequest[]>,
): Map<string, SubtreePullRequest[]> {
  const result = new Map<string, SubtreePullRequest[]>();
  if (rootIds.length === 0) return result;
  const hideIdeas = store.planningOn() ? 0 : 1;
  // Pre-order by the path of creation times from the root; the depth cap stops a corrupt cycle.
  // Siblings made in the same millisecond follow their number (zero-padded, so 9 before 10), and
  // their id only past that, so the order is creation order and not a random UUID's.
  const rows = store.db
    .prepare(
      `WITH RECURSIVE sub(root, top, id, identifier, title, path, depth) AS (
         SELECT i.id, NULL, i.id, i.identifier, i.title, '', 0 FROM issues i
          WHERE i.id IN (SELECT value FROM json_each(?))
            AND EXISTS (SELECT 1 FROM issues c WHERE c.parent_id = i.id AND (? = 0 OR c.kind <> '${IDEA_KIND}'))
         UNION ALL
         SELECT sub.root, COALESCE(sub.top, c.id), c.id, c.identifier, c.title, sub.path || '/' || c.created_at
                || printf('%020d', CAST(substr(c.identifier, length(rtrim(c.identifier, '0123456789')) + 1) AS INTEGER))
                || c.id,
                sub.depth + 1
           FROM sub JOIN issues c ON c.parent_id = sub.id
          WHERE sub.depth < ${MAX_TREE_DEPTH} AND (? = 0 OR c.kind <> '${IDEA_KIND}')
       )
       SELECT root, top, id, identifier, title FROM sub ORDER BY root, path`,
    )
    .all(JSON.stringify([...new Set(rootIds)]), hideIdeas, hideIdeas) as unknown as SubtreeRow[];
  if (rows.length === 0) return result;

  const byTicket = linked ?? store.externalLinks().pullRequests([...new Set(rows.map((row) => row.id))]);
  let root: string | null = null;
  let byResource = new Map<string, SubtreePullRequest>();
  const finish = () => {
    if (root !== null) result.set(root, [...byResource.values()]);
  };
  for (const row of rows) {
    if (row.root !== root) {
      finish();
      root = row.root;
      byResource = new Map();
    }
    const ticket = { id: row.id, identifier: row.identifier, title: row.title, childId: row.top };
    for (const pr of byTicket.get(row.id) ?? []) {
      const entry = byResource.get(pr.resourceId);
      if (entry) {
        if (!entry.tickets.some((t) => t.id === row.id)) entry.tickets.push(ticket);
      } else {
        byResource.set(pr.resourceId, { ...pr, own: row.id === row.root, tickets: [ticket] });
      }
    }
  }
  finish();
  return result;
}

/** One ticket's subtree set; null when it has no visible child. */
export function subtreePullRequests(store: WorkspaceStore, issueId: string): SubtreePullRequest[] | null {
  return subtreePullRequestsFor(store, [issueId]).get(issueId) ?? null;
}

/**
 * The detail surfaces' field (`staple show --json`, MCP `get_task`, `/api/agent-context`,
 * `/api/issue`): `{ subtreePullRequests }` on a parent, nothing at all on a leaf, so a leaf's
 * payload stays as it was.
 */
export function subtreePullRequestsField(store: WorkspaceStore, issueId: string): { subtreePullRequests?: SubtreePullRequest[] } {
  const set = subtreePullRequests(store, issueId);
  return set === null ? {} : { subtreePullRequests: set };
}

/**
 * A pull request's checks in words, only when they need attention, as the web UI says them:
 * `checks failing: test, lint` (three names, then `and N more`) or `checks pending`. Null
 * when they pass or none were read.
 */
export function checksPhrase(checks: PullRequestChecks | null): string | null {
  if (checks?.state === "pending") return "checks pending";
  if (checks?.state !== "failing") return null;
  const names = checks.failing.slice(0, 3).join(", ");
  const more = checks.failing.length > 3 ? ` and ${checks.failing.length - 3} more` : "";
  return names ? `checks failing: ${names}${more}` : "checks failing";
}
