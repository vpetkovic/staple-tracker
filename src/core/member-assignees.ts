/**
 * Keeping tickets with their member across a rename.
 *
 * An issue's `assignee` is a member's NAME, so renaming a member on the sync service leaves
 * every ticket assigned to the old name pointing at nobody. Other members' pickup then reads
 * those tickets as free text and takes them. The device that made the rename fixes that at
 * once, by rewriting the old name to the new one on every issue in the workspace.
 *
 * Through `updateIssue`, the ordinary write path, so each change is journaled and reaches
 * every other device on its next sync like any assignee edit. Case-insensitive, because member
 * names are unique ignoring case. A ticket assigned to a different person whose name merely
 * starts the same way is not touched: the comparison is the whole name.
 */
import type { WorkspaceStore } from "./store.js";

/** Move every issue assigned to `from` (ignoring case) onto `to`. Returns the identifiers changed. */
export function reassignMember(store: WorkspaceStore, from: string, to: string, actor: string | null): string[] {
  const wanted = from.trim().toLowerCase();
  const next = to.trim();
  if (wanted === "" || next === "") return [];
  const rows = store.db
    .prepare("SELECT id, identifier, assignee FROM issues WHERE assignee IS NOT NULL")
    .all() as Array<{ id: string; identifier: string; assignee: string }>;
  const changed: string[] = [];
  for (const row of rows) {
    if (row.assignee.trim().toLowerCase() !== wanted || row.assignee === next) continue;
    store.updateIssue(row.id, { assignee: next }, actor);
    changed.push(row.identifier);
  }
  return changed;
}
