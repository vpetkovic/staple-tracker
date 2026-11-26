/**
 * A checkpoint: the handoff a session leaves on a ticket, written in one call.
 *
 * It replaces the ticket's `worklog` document with three sections in a fixed order, Done,
 * Next and Files touched, as one new revision through `putDocument`, so history, events and
 * sync are a document write's. A section left out is written as its heading with nothing
 * under it: a thin handoff stays visible, and a run's handoff check (`checkpointedSince`)
 * still refuses it. A branch, when given, is set through `setTicketBranch`, the write
 * `staple branch` makes, in the same transaction as the worklog: both land or neither does.
 */
import type { WorkspaceStore } from "./store.js";
import { checkBranchName, setTicketBranch, ticketBranch, type TicketBranch } from "./ticket-branch.js";
import { StapleError, WORKLOG_KEY } from "./types.js";

export interface CheckpointSections {
  done?: string | null;
  next?: string | null;
  filesTouched?: string | null;
}

export interface CheckpointInput extends CheckpointSections {
  /** The branch the work is on. Left out, the ticket's branch is not touched. */
  branch?: string;
}

export interface CheckpointResult {
  ref: string;
  key: typeof WORKLOG_KEY;
  revision: number;
  body: string;
  /** The ticket's branch after the call, whether or not this call set it. */
  branch: TicketBranch | null;
  branchChanged: boolean;
}

/** The headings, in the order they are written. */
export const CHECKPOINT_SECTIONS = [
  ["done", "Done"],
  ["next", "Next"],
  ["filesTouched", "Files touched"],
] as const;

/** The worklog body a checkpoint writes. A blank section is its heading alone. */
export function checkpointBody(sections: CheckpointSections): string {
  return CHECKPOINT_SECTIONS.map(([field, heading]) => {
    const text = sections[field]?.replace(/\s+$/, "").replace(/^(?:[ \t]*\r?\n)+/, "") ?? "";
    return text === "" ? `## ${heading}\n` : `## ${heading}\n\n${text}\n`;
  }).join("\n");
}

/** The sections a checkpoint left empty, by heading. */
export function emptySections(sections: CheckpointSections): string[] {
  return CHECKPOINT_SECTIONS.filter(([field]) => !sections[field]?.trim()).map(([, heading]) => heading);
}

/**
 * Replace the worklog and, when a branch is given, set it. Everything is checked before
 * anything is written; a failure after that rolls both writes back.
 */
export function writeCheckpoint(store: WorkspaceStore, ref: string, input: CheckpointInput, actor: string | null): CheckpointResult {
  if (input.branch !== undefined) {
    if (input.branch.trim() === "") {
      throw new StapleError("validation", "A checkpoint's branch cannot be blank. Leave it out to keep the ticket's branch.");
    }
    checkBranchName(input.branch);
  }
  const body = checkpointBody(input);
  return store.journaled(() => {
    const issue = store.getIssue(ref);
    const branchChanged = input.branch !== undefined && setTicketBranch(store, issue.id, { branch: input.branch }, actor).changed;
    const { revision } = store.putDocument(issue.id, WORKLOG_KEY, body, { author: actor });
    return { ref: issue.identifier, key: WORKLOG_KEY, revision, body, branch: ticketBranch(store, issue.id), branchChanged };
  });
}
