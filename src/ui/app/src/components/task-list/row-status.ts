/**
 * Changing a task's status from its row: which statuses to offer, where the write goes, and
 * what to say, in plain words, when the store refuses it.
 *
 * Pure, so each rule is testable without a browser: the menu and the list view only render
 * what these functions decide.
 */
import type { Refusal } from "@/lib/refusal";
import type { StatusCategory } from "@/lib/types";

export interface StatusChoice {
  id: string;
  label: string;
  category: StatusCategory;
}

export interface RowStatusChoice extends StatusChoice {
  /** The task's status now: shown, checked, and not offered again. */
  current: boolean;
  disabled: boolean;
}

/**
 * The ROW'S workspace vocabulary, in its configured order.
 *
 * Not the page's: in All workspaces a row from one workspace must never be offered a status
 * only another workspace has (the store would refuse it). A `gated` status is left out unless
 * the task is already in it: the store never sets one directly (a review is requested from the
 * task, which records who must approve), so offering it would be offering a refusal.
 */
export function rowStatusChoices(statuses: readonly StatusChoice[], current: string): RowStatusChoice[] {
  return statuses
    .filter((status) => status.category !== "gated" || status.id === current)
    .map((status) => ({ ...status, current: status.id === current, disabled: status.id === current }));
}

/** Where a row's write goes: the row's own workspace, by id — never the page's scope. */
export function rowWriteTarget(row: { workspace: string; issue: { id: string } }): { ws: string; ref: string } {
  return { ws: row.workspace, ref: row.issue.id };
}

export type RowAct = (
  target: { ws?: string; ref?: string; actor?: string },
  payload: { type: "status"; status: never } | { type: "assignee"; assignee: string | null },
) => Promise<unknown>;

/** Send a status change for this row, to the row's workspace. */
export function applyRowStatus(
  row: { workspace: string; issue: { id: string } },
  status: string,
  act: (target: { ws: string; ref: string }, payload: { type: "status"; status: string }) => Promise<unknown>,
): Promise<unknown> {
  return act(rowWriteTarget(row), { type: "status", status });
}

export interface RowRefusalWords {
  /** One plain sentence: what did not happen and why. */
  sentence: string;
  /** The store wants someone assigned first; "Assign me" fixes it in place. */
  needsAssignee: boolean;
}

/**
 * The store's refusal, said for a person looking at the row.
 *
 * The store's own sentences are written for agents and logs ("in_progress requires an
 * assignee"); the known ones are reworded here, and anything else is passed through after a
 * plain lead-in, so a new refusal is never swallowed.
 */
export function plainRowRefusal(refusal: Refusal, to: { label: string }): RowRefusalWords {
  const message = refusal.message.trim();
  const lead = `Can't move this to ${to.label}`;
  if (refusal.crossOrigin) return { sentence: refusal.message, needsAssignee: false };
  if (/requires an assignee/i.test(message)) {
    return { sentence: `${lead}: it needs someone assigned first.`, needsAssignee: true };
  }
  const blockers = /unresolved blockers\s+(.+?)\.?$/i.exec(message);
  if (blockers) {
    return { sentence: `${lead} yet: it is waiting on ${blockers[1]} to finish.`, needsAssignee: false };
  }
  if (/park the issue with/i.test(message)) {
    return { sentence: `${lead} here: asking for approval is done from the task itself.`, needsAssignee: false };
  }
  const gate = /parked behind a review gate(?: awaiting ([^;]+))?/i.exec(message);
  if (gate) {
    return {
      sentence: `This is waiting for approval${gate[1] ? ` from ${gate[1]}` : ""}, so its status can't change until then.`,
      needsAssignee: false,
    };
  }
  if (refusal.code === "revision_conflict" || /changed (elsewhere|since)/i.test(message)) {
    return { sentence: "Someone else changed this task a moment ago. Try again.", needsAssignee: false };
  }
  const reason = message.replace(/\.$/, "");
  return { sentence: `${lead}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`, needsAssignee: false };
}
