/**
 * THE SETTINGS SHELL'S PURE HALF — R6b (STA-177), made global.
 *
 * Everything the Settings sheet decides that can be decided without a DOM lives here, so it
 * can be pinned by a test that has none (the suite renders to a string; see
 * settings-shell.test.tsx). The component files hold only the wiring.
 *
 * ── ONE SETTINGS, FOR EVERYTHING ──────────────────────────────────────────────────────
 *
 * Settings used to be "Work Workspace Settings": opened on whichever workspace the page was
 * on — the FIRST workspace when the page was on All workspaces — so changing Usage & budget
 * meant picking a workspace first, and changing another workspace's statuses meant closing
 * Settings, switching, and opening it again. It is now one sheet for the whole computer:
 *
 *   ACROSS ALL WORKSPACES — Cloud, Hub registry, Usage & budget, This machine. The same
 *     whichever workspace the page is on, and reachable from All workspaces.
 *   PER WORKSPACE — Statuses, Kinds, Workflow, Cloud sync. They carry their own workspace
 *     picker, inside Settings; changing it re-points the section and never closes the sheet.
 *
 * Which workspace the per-workspace half edits is `settingsTarget` below: the one named in
 * the address, else the page's own, else the remembered choice — and on All workspaces with
 * nothing remembered, nobody: the section asks rather than editing the first workspace.
 *
 * ── THE ROUTE ─────────────────────────────────────────────────────────────────────────
 *
 * Two search parameters, the idiom this app already has (GraphView's `?graph=`, the page's
 * own `?view=`): `?settings` opens the sheet on its list, `?settings=kinds` opens a section,
 * and `settings-ws=pinecone` says which workspace a per-workspace section edits. Both are a
 * deep link. `withSettingsRoute` sets exactly these and leaves every other parameter alone.
 *
 * ── WHAT BACK MEANS ───────────────────────────────────────────────────────────────────
 *
 * Opening from the gear pushes ONE history entry, so Back closes the sheet and lands on the
 * page you were on. Moving between sections or workspaces inside the open sheet REPLACES
 * that entry — a Back that walked through every section you glanced at would have stopped
 * meaning "the page I was on before". Closing with the X or Esc pops the entry we pushed,
 * or, after a deep-link arrival, strips the parameters in place (`closeAction`).
 */
import type { WorkspaceScope } from "@/lib/session";
import { defaultTargetWorkspace } from "@/lib/session-workspace";
import type { SettingCategoryView, SettingScope, WorkspaceSettingsEnvelope } from "@/lib/settings";

/** The search parameter. `?settings` alone opens the shell; `?settings=<id>` focuses a category. */
export const SETTINGS_PARAM = "settings";
/** Which workspace the per-workspace sections edit. Absent: the default (`settingsTarget`). */
export const SETTINGS_WS_PARAM = "settings-ws";

/**
 * What the URL says about the shell: closed, or open on a requested category (`""` = none
 * requested) and, optionally, a requested workspace (`""` = none requested).
 */
export interface SettingsRoute {
  category: string;
  workspace: string;
}

/** Read the route out of a `location.search` string. `null` when the shell is closed. */
export function readSettingsRoute(search: string): SettingsRoute | null {
  const params = new URLSearchParams(search);
  const raw = params.get(SETTINGS_PARAM);
  return raw === null ? null : { category: raw, workspace: params.get(SETTINGS_WS_PARAM) ?? "" };
}

/**
 * The href with the settings parameter set to `category`, opened without one (`""`), or
 * removed (`null`, which also drops the workspace). `workspace`: a slug sets it, `""` or
 * `null` removes it, `undefined` leaves it as it is. Rebuilt from the CURRENT href so every
 * other parameter survives.
 */
export function withSettingsRoute(href: string, category: string | null, workspace?: string | null): string {
  const url = new URL(href);
  if (category === null) {
    url.searchParams.delete(SETTINGS_PARAM);
    url.searchParams.delete(SETTINGS_WS_PARAM);
    return url.toString();
  }
  url.searchParams.set(SETTINGS_PARAM, category);
  if (workspace) url.searchParams.set(SETTINGS_WS_PARAM, workspace);
  else if (workspace !== undefined) url.searchParams.delete(SETTINGS_WS_PARAM);
  return url.toString();
}

/**
 * WHICH WORKSPACE THE PER-WORKSPACE SECTIONS EDIT.
 *
 *   1. the one the address names, if it is registered;
 *   2. otherwise the page's own workspace (`defaultTargetWorkspace`): the selected one, the
 *      only one, or — on All workspaces — the one this browser last chose;
 *   3. otherwise "" — nobody, and the section asks. Never the first of several.
 */
export function settingsTarget(scope: WorkspaceScope, requested: string, remembered: string): string {
  if (requested && scope.workspaces.some((workspace) => workspace.slug === requested)) return requested;
  if (scope.mode !== "hub") return scope.workspaces[0]?.slug ?? "";
  return defaultTargetWorkspace(scope, remembered);
}

/**
 * The category the shell shows for a request: the requested id when the registry has
 * it, otherwise the first category in shell order, otherwise nothing (registry not yet
 * fetched). A deep link to a category this build does not know lands on the first one
 * rather than on an empty pane.
 */
export function resolveCategory(
  categories: readonly SettingCategoryView[],
  requested: string | null | undefined,
): string | null {
  if (requested && categories.some((c) => c.id === requested)) return requested;
  return categories[0]?.id ?? null;
}

/**
 * How the shell closes, given whether it pushed a history entry when it opened. Popping
 * our own entry is what makes the URL and the dialog agree without a second code path;
 * a deep-link arrival has no entry of ours to pop, so the parameter is stripped in place.
 */
export function closeAction(pushed: boolean): "history-back" | "replace-url" {
  return pushed ? "history-back" : "replace-url";
}

// ---------------------------------------------------------------- scope

export interface ScopeSummary {
  /** The workspace the per-workspace sections edit, or `""` when none is chosen yet. */
  workspace: string;
  /** Where global preferences live on this machine. */
  globalPath: string;
  globalPresent: boolean;
}

export function scopeSummaryOf(envelope: WorkspaceSettingsEnvelope, workspace = envelope.workspace): ScopeSummary {
  return {
    workspace,
    globalPath: envelope.global.path,
    globalPresent: envelope.global.present,
  };
}

/**
 * The one sentence under the title. It never claims a workspace the person did not choose:
 * it says what the sheet holds, and names a workspace only when one is being edited.
 */
export function scopeSummaryText(scope: ScopeSummary): string {
  if (!scope.workspace) return "Settings for this computer and for each of your workspaces, in one place.";
  return `Settings for this computer, and for the workspace "${scope.workspace}".`;
}

/** The nav's group headings, in nav order. Plain words for the one distinction the sheet makes. */
export const SCOPE_ORDER: readonly SettingScope[] = ["global", "workspace"];

/** The short word for a scope, used by a field's scope tag ("Workspace", "Global"). */
export function scopeLabel(scope: SettingCategoryView["scope"]): string {
  return scope === "workspace" ? "Workspace" : "Global";
}

/** The nav's group heading for a scope: who the sections under it apply to. */
export function scopeHeading(scope: SettingCategoryView["scope"]): string {
  return scope === "workspace" ? "Per workspace" : "Across all workspaces";
}

/** The line beside a section's title: who the section applies to. */
export function appliesToText(scope: SettingScope, workspace: string): string {
  if (scope === "global") return "Applies to every workspace on this computer";
  return workspace ? `Applies to ${workspace} only` : "Applies to one workspace at a time";
}

/**
 * Where the two synthetic "global" client categories and the per-workspace cloud section
 * sit. Cloud (80) and Usage & budget (85) are declared in their own files; these two are
 * the sections this sheet split out of Cloud.
 */
export const HUB_REGISTRY_CATEGORY: SettingCategoryView = {
  id: "hub-registry",
  label: "Workspaces on this computer",
  description:
    "Keep the list of workspaces on this computer on your sync service, so another computer can restore or adopt it. " +
    "Stored on this computer, never in a workspace.",
  scope: "global",
  editor: "fields",
  order: 82,
};

export const WORKSPACE_CLOUD_CATEGORY: SettingCategoryView = {
  id: "workspace-cloud",
  label: "Cloud sync",
  description:
    "Whether this workspace syncs with your other devices, and the devices it syncs with. " +
    "The computer's sign-in to the sync service is Cloud account.",
  scope: "workspace",
  editor: "fields",
  order: 40,
};

export function isHubRegistryCategory(id: string | null | undefined): boolean {
  return id === HUB_REGISTRY_CATEGORY.id;
}

export function isWorkspaceCloudCategory(id: string | null | undefined): boolean {
  return id === WORKSPACE_CLOUD_CATEGORY.id;
}

/** The registry plus the two split-out cloud sections; untouched while the registry is empty. */
export function withShellCategories(categories: readonly SettingCategoryView[]): SettingCategoryView[] {
  if (categories.length === 0) return [...categories];
  const extra = [HUB_REGISTRY_CATEGORY, WORKSPACE_CLOUD_CATEGORY].filter(
    (added) => !categories.some((category) => category.id === added.id),
  );
  return [...categories, ...extra].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * Does the selected section need a workspace that has not been chosen? Then the content
 * pane asks for one instead of rendering an editor bound to nobody (or to the first).
 */
export function needsWorkspaceChoice(category: SettingCategoryView | null, workspace: string): boolean {
  return category !== null && category.scope === "workspace" && workspace === "";
}

// ---------------------------------------------------------------- layout

/** Two panes side by side, or one at a time with a Back path. */
export type ShellLayout = "two-pane" | "stacked";
/** Which pane a stacked shell is showing. Ignored by the two-pane layout. */
export type ShellPane = "nav" | "content";
/** The dialog's size on a wide display: a centred dialog, or the whole viewport. */
export type ShellMode = "drawer" | "full";

/** Below Tailwind's `md` the two panes cannot both be usable, so the shell stacks. */
export const STACKED_QUERY = "(max-width: 767px)";

export function otherShellMode(mode: ShellMode): ShellMode {
  return mode === "drawer" ? "full" : "drawer";
}

/**
 * The frame the dialog content gets. Full-screen and stacked share one: a narrow
 * viewport is already the whole screen, and a centred dialog inside it would only take
 * the margins away from the forms. The drawer frame is the only place the centred
 * geometry is written.
 */
export function settingsFrameClass(mode: ShellMode, layout: ShellLayout): string {
  // A phone: the whole dynamic viewport, so a collapsing browser toolbar never hides the foot.
  if (layout === "stacked") return "inset-x-0 top-0 h-dvh rounded-none";
  if (mode === "full") return "inset-0 rounded-none";
  return "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[min(44rem,calc(100dvh-2rem))] w-[min(64rem,calc(100vw-2rem))] rounded-lg border";
}

// ---------------------------------------------------------------- scroll memory

/**
 * One scroll offset per category, so returning to Statuses after a look at Kinds lands
 * where you left it rather than at the top of the list. A Map rather than component
 * state: it is written on the way OUT of a category and read on the way in, and nothing
 * needs to re-render when it changes.
 */
export type ScrollMemory = Map<string, number>;

export function rememberScroll(memory: ScrollMemory, category: string | null, top: number): void {
  if (category !== null) memory.set(category, top);
}

export function recallScroll(memory: ScrollMemory, category: string | null): number {
  return category === null ? 0 : (memory.get(category) ?? 0);
}
