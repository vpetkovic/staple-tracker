/**
 * The page's autopilot runs: ONE read of `GET /api/runs` per fingerprint change, held at the
 * root (App.tsx) and handed down through this context, so the rail banner, the phone strip,
 * the row badges, the detail's notice and the history all read the same answer.
 *
 * It rides the existing poll and nothing else. Every run write emits an event (the fingerprint
 * moves), and a driver attaching or dying is in the fingerprint too (`driverFingerprint` in
 * server.ts), so the banner follows a run within one refresh with no timer of its own.
 *
 * `claimed` is the badge's join, done here once rather than per row: every ticket a LIVE run
 * took and has not recorded yet, keyed by workspace and issue id. A run that ended holds
 * nothing (core settles its open ticket), so its rows wear no badge.
 */
import { createContext, useContext } from "react";
import { isLiveRun } from "./run-text";
import type { RunEntry } from "./types";

/** How a row is on autopilot: its own ticket, the scope a run works, or a folded parent of a ticket. */
export type AutopilotMark =
  | { kind: "ticket"; entry: RunEntry }
  | { kind: "scope"; entry: RunEntry }
  | { kind: "inside"; entry: RunEntry; refs: readonly string[] };

export interface RunsState {
  /** Every run the page read, newest first. */
  entries: readonly RunEntry[];
  /** The live ones (active or paused), newest first. */
  live: readonly RunEntry[];
  /** `claimKey(workspace, issueId)` → the live run working that issue. */
  claimed: ReadonlyMap<string, RunEntry>;
  /** `claimKey(workspace, scopeIssueId)` → the live run working that epic or milestone. */
  scopes: ReadonlyMap<string, RunEntry>;
  /** Refetch everything now: after a Stop, so the banner does not wait for the poll. */
  refresh: () => void;
  /** The server's clock at the last read (`/api/runs` `now`); null before the first. */
  now: string | null;
}

export function claimKey(workspace: string, issueId: string): string {
  return `${workspace}/${issueId}`;
}

export function buildRunsState(entries: readonly RunEntry[], refresh: () => void = () => {}, now: string | null = null): RunsState {
  const live = entries.filter((entry) => isLiveRun(entry.run));
  const claimed = new Map<string, RunEntry>();
  for (const entry of live) {
    for (const ticket of entry.run.tickets) {
      if (ticket.outcome === null) claimed.set(claimKey(entry.workspace, ticket.issueId), entry);
    }
  }
  const scopes = new Map<string, RunEntry>();
  for (const entry of live) {
    if (entry.run.scope.kind !== "queue") scopes.set(claimKey(entry.workspace, entry.run.scope.issueId), entry);
  }
  return { entries, live, claimed, scopes, refresh, now };
}

/**
 * THE FOLD'S HALF: which rows have a live run's open ticket somewhere underneath, keyed like
 * `claimed`, with the refs being worked. Walks up from each claimed ticket over the parent
 * links of `rows` AS THE LIST HAS THEM, so a milestone the list nests its members under
 * (views/tree/milestone-placement.ts rewrites `parentId` on the list's copy) lights up for a
 * run working any member's descendant, exactly as the fold hides it. A cycle stops the walk.
 */
export function autopilotAncestors(
  rows: readonly { workspace: string; issue: { id: string; parentId: string | null } }[],
  claimed: ReadonlyMap<string, RunEntry>,
): ReadonlyMap<string, { entry: RunEntry; refs: string[] }> {
  const out = new Map<string, { entry: RunEntry; refs: string[] }>();
  if (claimed.size === 0) return out;
  const parentOf = new Map<string, string | null>();
  for (const row of rows) parentOf.set(claimKey(row.workspace, row.issue.id), row.issue.parentId);
  for (const [key, entry] of claimed) {
    const slash = key.indexOf("/");
    const workspace = key.slice(0, slash);
    const ticket = entry.run.tickets.find((candidate) => candidate.outcome === null && claimKey(workspace, candidate.issueId) === key);
    const ref = ticket?.identifier ?? key.slice(slash + 1);
    const seen = new Set<string>([key]);
    let parent = parentOf.get(key) ?? null;
    while (parent !== null) {
      const up = claimKey(workspace, parent);
      if (seen.has(up)) break;
      seen.add(up);
      const mark = out.get(up);
      if (mark) {
        if (!mark.refs.includes(ref)) mark.refs.push(ref);
      } else out.set(up, { entry, refs: [ref] });
      parent = parentOf.get(up) ?? null;
    }
  }
  return out;
}

/** The list's fold map, provided by the task list (TreeView) over the rows it nests; empty elsewhere. */
export const AutopilotTreeContext = createContext<ReadonlyMap<string, { entry: RunEntry; refs: string[] }>>(new Map());

/**
 * Is this row on autopilot, and how: its own open ticket first; then the scope a live run
 * works (shown folded or not, because that container IS what is on autopilot); then, only
 * while FOLDED, a parent hiding a ticket being worked. An expanded parent says nothing: the
 * child row under it carries the badge.
 */
export function useAutopilotMark(workspace: string, issueId: string, folded = false): AutopilotMark | null {
  const runs = useContext(RunsContext);
  const tree = useContext(AutopilotTreeContext);
  const key = claimKey(workspace, issueId);
  const own = runs.claimed.get(key);
  if (own) return { kind: "ticket", entry: own };
  const scope = runs.scopes.get(key);
  if (scope) return { kind: "scope", entry: scope };
  const inside = folded ? tree.get(key) : undefined;
  return inside ? { kind: "inside", entry: inside.entry, refs: inside.refs } : null;
}

export const EMPTY_RUNS: RunsState = buildRunsState([]);

export const RunsContext = createContext<RunsState>(EMPTY_RUNS);

export function useRuns(): RunsState {
  return useContext(RunsContext);
}

/** The live run working this issue, or null. */
export function useRunClaim(workspace: string, issueId: string): RunEntry | null {
  return useRuns().claimed.get(claimKey(workspace, issueId)) ?? null;
}
