/**
 * The Inbox's presentation model: how the rows `attention-model.ts` cuts into sections are
 * worded and walked. Pure and tested (inbox-model.test.ts).
 *
 * Nothing here switches on a row's kind. A kind the registry adds tomorrow renders by its
 * verb, its label and its flags, so the page needs no change for it.
 */
import type { Selection } from "@/lib/session";
import type { AttentionRow } from "@/lib/types";
import type { AttentionSection } from "./attention-model";

export type AttentionVerb = AttentionRow["action"]["verb"];

const ACTION_WORDS: Record<AttentionVerb, string> = {
  review: "Review",
  unblock: "Open",
  open: "Open",
  inspect: "View run",
  resolve: "Resolve",
};

/** The word on a row's action. The row's own action label is not a button label: on a block it is the to-do. */
export function actionWord(verb: AttentionVerb): string {
  return ACTION_WORDS[verb];
}

/** What a person must do to unblock the row, printed after its reason; null when the label is the bare verb. */
export function unblockTodo(row: Pick<AttentionRow, "action">): string | null {
  return row.action.verb === "unblock" && row.action.label !== "Unblock" ? row.action.label : null;
}

/** A conflicting field's value: a string as it is, anything else as JSON. */
export function conflictValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

/** The narrow subject column: the ticket, or "run" for a run with no ticket (the full run id is in the meta line). */
export function subjectCell(row: Pick<AttentionRow, "ref" | "runId">): string {
  return row.ref ?? (row.runId ? "run" : "");
}

/** The section header's "oldest": the longest wait among its rows. */
export function oldestAge(rows: readonly Pick<AttentionRow, "ageSeconds">[]): number {
  return Math.max(...rows.map((row) => row.ageSeconds));
}

/** The rows on screen, in order: a folded section draws none. The keyboard and the drawer walk these. */
export function drawnRows(sections: readonly AttentionSection[], folded: Readonly<Record<string, boolean>>): AttentionRow[] {
  return sections.flatMap((section) => (folded[section.kind] ? [] : section.rows));
}

/** The drawer's previous and next walk these: the drawn rows that name a ticket, in order. */
export function drawerOrder(rows: readonly AttentionRow[]): Selection[] {
  return rows.flatMap((row) => (row.ref ? [{ workspace: row.workspace, ref: row.ref }] : []));
}

/** What a key does on the focused row. */
export type InboxMove =
  | { focus: string }
  | { act: string }
  | { dismiss: string; focus: string | null }
  | { expand: string }
  | { collapse: string }
  | null;

export function inboxKey(
  keys: readonly string[],
  current: string,
  key: string,
  row: { dismissible: boolean; resolve: boolean; expanded: boolean },
): InboxMove {
  const index = keys.indexOf(current);
  if (index === -1) return null;
  switch (key) {
    case "ArrowDown":
    case "j":
      return index < keys.length - 1 ? { focus: keys[index + 1]! } : null;
    case "ArrowUp":
    case "k":
      return index > 0 ? { focus: keys[index - 1]! } : null;
    case "Home":
      return { focus: keys[0]! };
    case "End":
      return { focus: keys[keys.length - 1]! };
    case "Enter":
    case " ":
      return { act: current };
    case "e":
      // The row that takes its place is the next one; at the end of the list, the one before.
      return row.dismissible ? { dismiss: current, focus: keys[index + 1] ?? keys[index - 1] ?? null } : null;
    case "ArrowRight":
      return row.resolve && !row.expanded ? { expand: current } : null;
    case "ArrowLeft":
      return row.resolve && row.expanded ? { collapse: current } : null;
    default:
      return null;
  }
}
