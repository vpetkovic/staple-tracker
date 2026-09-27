/**
 * "WHICH WORKSPACE?" — the one answer every workspace-only action uses when the page is on
 * All workspaces.
 *
 * Creating a task, making a project and editing a workspace's statuses each need exactly
 * one workspace. On a single workspace (or with one selected in a hub) that is simply the
 * current one. On All workspaces there is no current one, and the old behaviour — quietly
 * using the first registered workspace — filed work in a place the person never chose.
 *
 * So those actions ASK, and they ask with a remembered default: the workspace this browser
 * last chose in any of those questions, or last switched to. Nothing is preselected when
 * nothing has been chosen yet (unless there is only one workspace to choose), because a
 * default the person never picked is exactly the silent first-workspace fallback again.
 */
import { currentWorkspace, isAllWorkspaces, type WorkspaceScope } from "./session";

export const TARGET_WORKSPACE_KEY = "staple:target-workspace:v1";

type Store = Pick<Storage, "getItem" | "setItem">;

const storage = (): Store | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

export function loadRememberedWorkspace(store: Pick<Storage, "getItem"> | undefined = storage()): string {
  if (!store) return "";
  try {
    return store.getItem(TARGET_WORKSPACE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Remember a workspace the person chose. Blank is never stored: "" is not a workspace. */
export function rememberWorkspace(slug: string, store: Store | undefined = storage()): void {
  if (!store || slug === "") return;
  try {
    store.setItem(TARGET_WORKSPACE_KEY, slug);
  } catch {
    /* private mode: remembered for this page load only */
  }
}

/**
 * The workspace a workspace-only action should start on:
 *
 *   1. the page's own workspace, when it is on one;
 *   2. otherwise (All workspaces) the remembered choice, if it is still registered;
 *   3. otherwise the only workspace, when there is exactly one;
 *   4. otherwise "" — nothing chosen, and the form asks.
 *
 * Never `workspaces[0]` of several.
 */
export function defaultTargetWorkspace(scope: WorkspaceScope, remembered: string): string {
  const current = currentWorkspace(scope);
  if (current) return current.slug;
  if (!isAllWorkspaces(scope)) return "";
  if (remembered && scope.workspaces.some((workspace) => workspace.slug === remembered)) return remembered;
  if (scope.workspaces.length === 1) return scope.workspaces[0]!.slug;
  return "";
}

/** Must this action show a "which workspace" question at all? Only with more than one to choose from. */
export function asksForWorkspace(scope: WorkspaceScope): boolean {
  return scope.mode === "hub" && scope.workspaces.length > 1;
}
