/**
 * Whether the agent holding a ticket has left a usable handoff: its worklog, judged for
 * the current tenure (since the claim was taken), outside autopilot runs too.
 *
 * Runs already refuse a handoff without a checkpoint (`run-driver`, `run-hook`). Agents
 * working a ticket by hand had nothing but the protocol text, and in practice they
 * checkpointed once early and then commented for hours, so a successor read a stale Next.
 * This answers the holder on its own progress writes (a reminder) and refuses its handoff
 * (any move out of active work but a cancel, or a release) until the worklog is current.
 */
import type { WorkspaceStore } from "./store.js";
import { hasHandoffSections, worklogReminder } from "./run-worklog.js";
import { StapleError, WORKLOG_KEY, type Issue } from "./types.js";

/**
 * How long a holder may keep working past its last checkpoint before the worklog reads as
 * behind. The web UI's stale cue is the same rule (`worklogStaleness`,
 * `WORKLOG_STALE_MARGIN_SECONDS`): activity after the checkpoint, never the worklog's age,
 * so a long silent build or a usage-limit pause does not make an accurate worklog stale.
 */
export const WORKLOG_BEHIND_SECONDS = 60 * 60;

/**
 * `missing`: no worklog written since the claim was taken (a predecessor's does not count).
 * `incomplete`: written this tenure, but Done, Next or Files touched is empty.
 * `behind`: complete, but the holder has kept writing for `WORKLOG_BEHIND_SECONDS` since.
 */
export type WorklogState = "missing" | "incomplete" | "behind" | "current";

export interface WorklogStanding {
  state: WorklogState;
  /** When the claim was taken; a worklog older than this belongs to an earlier holder. */
  tenureSince: string;
  /** The current worklog revision, whoever wrote it, or null when the ticket has none. */
  revision: number | null;
  writtenAt: string | null;
  author: string | null;
  /** What to do about it; null when the worklog is current. */
  action: string | null;
}

/** The worklog standing of `actor`'s claim on `ref`, or null when `actor` does not hold it. */
export function holderWorklog(store: WorkspaceStore, ref: string, actor: string | null | undefined): WorklogStanding | null {
  const issue = store.getIssue(ref);
  if (!actor || issue.checkoutAgent !== actor || !issue.checkoutAt) return null;
  return standingOf(store, issue, issue.checkoutAt);
}

/**
 * What a holder's progress write (a comment, a document, a milestone, a checkout) adds to
 * its answer: `{ worklog }` while the worklog is not current, nothing otherwise.
 */
export function worklogNudge(store: WorkspaceStore, ref: string, actor: string | null | undefined): { worklog?: WorklogStanding } {
  const standing = holderWorklog(store, ref, actor);
  return standing === null || standing.state === "current" ? {} : { worklog: standing };
}

function standingOf(store: WorkspaceStore, issue: Issue, tenureSince: string): WorklogStanding {
  let document: ReturnType<WorkspaceStore["getDocument"]> | null = null;
  try {
    document = store.getDocument(issue.id, WORKLOG_KEY);
  } catch (error) {
    if (!(error instanceof StapleError && error.code === "not_found")) throw error;
  }
  const writtenAt = document?.createdAt ?? null;
  const lastActivityAt = store.claimActivity(issue.identifier)?.lastActivityAt ?? null;
  const state: WorklogState =
    document === null || !(Date.parse(document.createdAt) >= Date.parse(tenureSince))
      ? "missing"
      : !hasHandoffSections(document.body)
        ? "incomplete"
        : lastActivityAt !== null && (Date.parse(lastActivityAt) - Date.parse(document.createdAt)) / 1000 >= WORKLOG_BEHIND_SECONDS
          ? "behind"
          : "current";
  return {
    state,
    tenureSince,
    revision: document?.revision ?? null,
    writtenAt,
    author: document?.author ?? null,
    action: state === "current" ? null : actionFor(state, issue.identifier, document?.author ?? null, writtenAt),
  };
}

function actionFor(state: Exclude<WorklogState, "current">, ref: string, author: string | null, writtenAt: string | null): string {
  const why =
    state === "missing"
      ? writtenAt === null
        ? `${ref} has no worklog yet.`
        : `${ref}'s worklog was written before you took it (${author ?? "unsigned"}, ${writtenAt}): read it, then write your own.`
      : state === "incomplete"
        ? `${ref}'s worklog leaves Done, Next or Files touched empty.`
        : `You have kept working ${ref} for over an hour since its worklog was written (${writtenAt}).`;
  return `${why} ${worklogReminder(ref)}`;
}

/**
 * Refuse the holder handing `ref` on without a current worklog. Anyone else (a person
 * closing an agent's ticket, a takeover by staleness) is not the holder and passes.
 */
export function assertHandoffWorklog(store: WorkspaceStore, ref: string, actor: string | null | undefined, handoff: string): void {
  const standing = holderWorklog(store, ref, actor);
  if (standing === null || standing.state === "current") return;
  throw new StapleError("validation", `Checkpoint before you hand this on (${handoff}). ${standing.action}`, { worklog: standing });
}

/**
 * `assertHandoffWorklog` for a status write. Any move out of active work hands the ticket on
 * (review, done, blocked, and back to todo or backlog, which clears the claim as a release
 * does); a cancel is the one exception, since nobody will resume it.
 */
export function assertHandoffStatus(store: WorkspaceStore, ref: string, status: string | undefined, actor: string | null | undefined): void {
  if (status === undefined) return;
  const category = store.categoryOf(status);
  if (category === null || category === "active" || category === "cancelled") return;
  if (store.getIssue(ref).status === status) return;
  assertHandoffWorklog(store, ref, actor, `status ${status}`);
}
