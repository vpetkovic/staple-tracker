/**
 * Test fixtures for the pull request surfaces: a parent's subtree set as the server sends it,
 * a ticket's own linked pull request, and a row's ref. Test-only; nothing in the app imports it.
 */
import type { PullRequestCheckState } from "../../../../core/integrations/contracts";
import type { PullRequestTicket, SubtreePullRequest } from "../../../../core/subtree-pull-requests";
import type { PullRequestRef } from "@/lib/types";
import type { ExternalLink } from "./model";

export const REPO = "acme/shop";

export interface PrShape {
  repo?: string;
  /** The provider's state; null when never read. */
  state?: string | null;
  checks?: PullRequestCheckState | null;
  failing?: string[];
  title?: string | null;
}

const checksOf = ({ checks = null, failing }: PrShape) =>
  checks ? { state: checks, failing: failing ?? (checks === "failing" ? ["unit"] : []), completedAt: null } : null;

/** A ticket of the subtree. `childId` undefined leaves the field out, the way an older server sends it. */
export function prTicket(identifier: string, childId?: string | null): PullRequestTicket {
  const base = { id: `id-${identifier}`, identifier, title: `Task ${identifier}` };
  return (childId === undefined ? base : { ...base, childId }) as PullRequestTicket;
}

/** A pull request of a parent's subtree set. */
export function subtreePr(n: number, shape: PrShape & { own?: boolean; tickets?: PullRequestTicket[] } = {}): SubtreePullRequest {
  const repo = shape.repo ?? REPO;
  const state = shape.state === undefined ? "open" : shape.state;
  return {
    resourceId: `res-${repo}-${n}`,
    providerId: "github",
    key: `${repo}#${n}`,
    url: `https://github.com/${repo}/pull/${n}`,
    number: n,
    state,
    title: shape.title === undefined ? `Change ${n}` : shape.title,
    checks: checksOf(shape),
    fetchedAt: "2026-11-24T11:00:00Z",
    linkedAt: "2026-11-23T00:00:00Z",
    own: shape.own ?? false,
    tickets: shape.tickets ?? [],
  };
}

/** A ticket's own linked pull request. The resource id matches `subtreePr`'s for the same repository and number. */
export function prLink(n: number, shape: PrShape & { provider?: "github" | "linear" } = {}): ExternalLink {
  const repo = shape.repo ?? REPO;
  const state = shape.state === undefined ? "open" : shape.state;
  const checks = checksOf(shape);
  return {
    id: `link-${repo}-${n}`,
    issueId: "local",
    parentResourceId: null,
    parentMissing: false,
    position: 0,
    createdBy: "tester",
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    resource: {
      id: `res-${repo}-${n}`,
      ref: { providerId: shape.provider ?? "github", host: "github.com", scopeId: "host", containerId: `42-${repo}`, id: String(n), kind: "pull_request" },
      key: `${repo}#${n}`,
      url: `https://github.com/${repo}/pull/${n}`,
      title: shape.title === undefined ? `Change ${n}` : shape.title,
      body: null,
      status: state ? { id: state, name: state } : null,
      fetchedAt: "2026-11-24T11:00:00Z",
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      contextShared: false,
      ...(checks ? { pullRequest: { headBranch: `branch-${n}`, headSha: `sha${n}`, checks } } : {}),
    },
  } as ExternalLink;
}

/** A row's pull request ref. */
export function rowPr(n: number, state: PullRequestRef["state"] = "open", extra: Partial<PullRequestRef> = {}): PullRequestRef {
  return { provider: "github", number: n, url: `https://github.com/${REPO}/pull/${n}`, state, title: `Change ${n}`, ...extra };
}
