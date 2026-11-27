/**
 * The workspace switcher, as data — what it lists, what each row says, and when it offers a
 * search box. `WorkspaceSwitcher.tsx` draws this and nothing else, so the rules are pinned
 * without a DOM (switcher-model.test.ts).
 *
 * ── WHAT A ROW SAYS ───────────────────────────────────────────────────────────────────
 *
 * The workspace's name, on one line. Its task-number prefix rides along for the search box
 * and the row's title, and how much waits on a person there comes from the Inbox's read
 * (`waitingByWorkspace`), so the list says where the waiting is.
 */
import { ALL_WORKSPACES_LABEL, isAllWorkspaces, scopeName, type WorkspaceScope } from "@/lib/session";

/** More workspaces than this and the switcher grows a search box. */
export const SWITCHER_SEARCH_THRESHOLD = 6;

export interface SwitcherRow {
  /** "" is All workspaces. */
  value: string;
  name: string;
  /** The task-number prefix ("STA"): the row's title, and what the search box also matches. Empty for All workspaces. */
  prefix: string;
  current: boolean;
}

/** How many Inbox rows wait in each workspace, from the Inbox's own read (every workspace's). */
export function waitingByWorkspace(rows: readonly { workspace: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.workspace, (counts.get(row.workspace) ?? 0) + 1);
  return counts;
}

/** Every row the switcher offers, in hub order with All workspaces first. */
export function switcherRows(scope: WorkspaceScope): SwitcherRow[] {
  const rows: SwitcherRow[] = [];
  if (scope.mode === "hub") {
    rows.push({
      value: "",
      name: ALL_WORKSPACES_LABEL,
      prefix: "",
      current: isAllWorkspaces(scope),
    });
  }
  for (const workspace of scope.workspaces) {
    rows.push({
      value: workspace.slug,
      name: workspace.slug,
      prefix: workspace.prefix,
      current: scope.mode === "hub" ? scope.ws === workspace.slug : true,
    });
  }
  return rows;
}

/** Does the switcher offer a search box? Only when there are enough workspaces to need one. */
export function switcherSearches(scope: WorkspaceScope): boolean {
  return scope.workspaces.length > SWITCHER_SEARCH_THRESHOLD;
}

/**
 * The rows a query leaves: a case-insensitive match on the name or the task-number prefix,
 * ignoring spaces and dashes so "ai inbox" finds `ai-inbox-supabase`. An empty query leaves
 * everything. All workspaces stays whenever the query could mean it.
 */
export function filterSwitcherRows(
  rows: readonly SwitcherRow[],
  query: string,
  prefixes: ReadonlyMap<string, string> = new Map(),
): SwitcherRow[] {
  const squash = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, "");
  const wanted = squash(query);
  if (wanted === "") return [...rows];
  return rows.filter(
    (row) => squash(row.name).includes(wanted) || squash(prefixes.get(row.value) ?? "").startsWith(wanted),
  );
}

/** What the trigger says: the full name of the selection. Never an abbreviation of it. */
export function switcherTriggerLabel(scope: WorkspaceScope): string {
  if (scope.mode !== "hub") return scope.workspaces[0]?.slug ?? "No workspace";
  return scopeName(scope);
}
