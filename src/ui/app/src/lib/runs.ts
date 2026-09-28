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

export interface RunsState {
  /** Every run the page read, newest first. */
  entries: readonly RunEntry[];
  /** The live ones (active or paused), newest first. */
  live: readonly RunEntry[];
  /** `claimKey(workspace, issueId)` → the live run working that issue. */
  claimed: ReadonlyMap<string, RunEntry>;
  /** Refetch everything now: after a Stop, so the banner does not wait for the poll. */
  refresh: () => void;
}

export function claimKey(workspace: string, issueId: string): string {
  return `${workspace}/${issueId}`;
}

export function buildRunsState(entries: readonly RunEntry[], refresh: () => void = () => {}): RunsState {
  const live = entries.filter((entry) => isLiveRun(entry.run));
  const claimed = new Map<string, RunEntry>();
  for (const entry of live) {
    for (const ticket of entry.run.tickets) {
      if (ticket.outcome === null) claimed.set(claimKey(entry.workspace, ticket.issueId), entry);
    }
  }
  return { entries, live, claimed, refresh };
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
