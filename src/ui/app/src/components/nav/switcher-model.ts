/**
 * The workspace switcher, as data — what it lists, what each row says, and when it offers a
 * search box. `WorkspaceSwitcher.tsx` draws this and nothing else, so the rules are pinned
 * without a DOM (switcher-model.test.ts).
 *
 * ── WHAT A ROW SAYS ───────────────────────────────────────────────────────────────────
 *
 * The workspace's name, and under it one plain caption a less technical reader can use:
 * how many open tasks it has when the page knows (it does on All workspaces, where every
 * workspace's rows are loaded), otherwise how its task numbers start — which is what they
 * will recognise from a task's number on screen. "All workspaces" says what it holds.
 */
import type { IssueRow, WorkspaceRef } from "@/lib/types";
import { ALL_WORKSPACES_LABEL, isAllWorkspaces, scopeName, type WorkspaceScope } from "@/lib/session";

/** More workspaces than this and the switcher grows a search box. */
export const SWITCHER_SEARCH_THRESHOLD = 6;

export interface SwitcherRow {
  /** "" is All workspaces. */
  value: string;
  name: string;
  caption: string;
  /** The task-number prefix, drawn apart from the caption in mono ("STA"). Empty for All workspaces. */
  prefix: string;
  current: boolean;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Open-task counts per workspace from the rows the page already holds. Resolved work is not open. */
export function openCountsByWorkspace(
  rows: readonly IssueRow[],
  isResolved: (status: string) => boolean,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (isResolved(row.issue.status)) continue;
    counts.set(row.workspace, (counts.get(row.workspace) ?? 0) + 1);
  }
  return counts;
}

function workspaceCaption(workspace: WorkspaceRef, openCounts: ReadonlyMap<string, number> | null): string {
  if (!openCounts) return `Task numbers start with ${workspace.prefix}`;
  return plural(openCounts.get(workspace.slug) ?? 0, "open task", "open tasks");
}

/**
 * Every row the switcher offers, in hub order with All workspaces first. `openCounts` is
 * passed only when it covers every workspace (All workspaces is on screen); a count for one
 * workspace and not the others would read as "the others have none".
 */
export function switcherRows(
  scope: WorkspaceScope,
  openCounts: ReadonlyMap<string, number> | null = null,
): SwitcherRow[] {
  const rows: SwitcherRow[] = [];
  if (scope.mode === "hub") {
    rows.push({
      value: "",
      name: ALL_WORKSPACES_LABEL,
      caption: `Everything from ${plural(scope.workspaces.length, "workspace", "workspaces")}`,
      prefix: "",
      current: isAllWorkspaces(scope),
    });
  }
  for (const workspace of scope.workspaces) {
    rows.push({
      value: workspace.slug,
      name: workspace.slug,
      caption: workspaceCaption(workspace, openCounts),
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
