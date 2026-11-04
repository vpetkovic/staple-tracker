/**
 * The row menu's queue in All workspaces: the row's OWN workspace plan, read when the menu
 * opens (see TreeView). This is the pure half — what the menu may do with what has loaded.
 */
import type { Refusal } from "@/lib/refusal";
import type { QueueView } from "@/lib/types";

export type RowQueue = { kind: "loading" } | { kind: "ready"; view: QueueView } | { kind: "failed"; refusal: Refusal };

export interface RowQueueMenu {
  /** The plan's identifiers, for `queueRowMenuState`. Empty until the plan is read. */
  planIds: ReadonlySet<string>;
  /** The revision a write builds on, or null when there is nothing safe to build on yet. */
  revision: number | null;
  /** Why the queue items are off, in words, or undefined when they are on. */
  reason: string | undefined;
}

export function rowQueueMenu(entry: RowQueue | undefined, workspace: string): RowQueueMenu {
  if (entry?.kind === "ready") {
    return {
      planIds: new Set(entry.view.entries.map((planned) => planned.identifier)),
      revision: entry.view.revision,
      reason: undefined,
    };
  }
  return {
    planIds: new Set(),
    revision: null,
    reason:
      entry?.kind === "failed"
        ? `Could not read the ${workspace} queue: ${entry.refusal.message}`
        : `Reading the ${workspace} queue…`,
  };
}
