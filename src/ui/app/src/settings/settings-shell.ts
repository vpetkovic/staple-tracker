/**
 * THE SETTINGS SHELL'S PURE HALF — R6b (STA-177).
 *
 * Everything the "Work Workspace Settings" shell decides that can be decided without a
 * DOM lives here, so it can be pinned by a test that has none (the suite renders to a
 * string; see settings-shell.test.tsx). The component files hold only the wiring.
 *
 * ── THE ROUTE ─────────────────────────────────────────────────────────────────────────
 *
 * A search parameter, because that is the URL idiom this app already has: GraphView
 * keeps its shareable state in `?graph=` through `withGraphView`, and the detail overlay
 * deliberately has no URL at all. `?settings` opens the shell on its first category;
 * `?settings=kinds` focuses one. `withSettingsRoute` sets exactly this one parameter and
 * leaves every other one alone — `token` in particular is never read, re-encoded or
 * reordered here.
 *
 * ── WHAT BACK MEANS ───────────────────────────────────────────────────────────────────
 *
 * Opening from the gear pushes ONE history entry, so Back closes the shell and lands on
 * the page you were on. Moving between categories inside the open shell REPLACES that
 * entry rather than pushing another: a Back that had to walk through every category you
 * glanced at would have stopped meaning "the page I was on before", which is the same
 * argument GraphView makes for its toggles. Closing with the X or Esc then pops the entry
 * we pushed — or, when the visitor arrived by deep link and we pushed nothing, strips the
 * parameter in place. `closeAction` is that decision, as a function, so it is testable.
 */
import type { SettingCategoryView, WorkspaceSettingsEnvelope } from "@/lib/settings";

/** The search parameter. `?settings` alone opens the shell; `?settings=<id>` focuses a category. */
export const SETTINGS_PARAM = "settings";

/** What the URL says about the shell: closed, or open on a requested category (`""` = none requested). */
export interface SettingsRoute {
  category: string;
}

/** Read the route out of a `location.search` string. `null` when the shell is closed. */
export function readSettingsRoute(search: string): SettingsRoute | null {
  const raw = new URLSearchParams(search).get(SETTINGS_PARAM);
  return raw === null ? null : { category: raw };
}

/**
 * The href with the settings parameter set to `category`, opened without one (`""`),
 * or removed (`null`). Rebuilt from the CURRENT href so every other parameter survives.
 */
export function withSettingsRoute(href: string, category: string | null): string {
  const url = new URL(href);
  if (category === null) url.searchParams.delete(SETTINGS_PARAM);
  else url.searchParams.set(SETTINGS_PARAM, category);
  return url.toString();
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
  /** The workspace handle being edited, or `""` before the fetch resolves. */
  workspace: string;
  /** Where global preferences live on this machine. */
  globalPath: string;
  globalPresent: boolean;
}

export function scopeSummaryOf(envelope: WorkspaceSettingsEnvelope): ScopeSummary {
  return {
    workspace: envelope.workspace,
    globalPath: envelope.global.path,
    globalPresent: envelope.global.present,
  };
}

/**
 * The one sentence under the title that says WHICH workspace this edits and where the
 * other scope lives. Both halves are always present, because "workspace or global" is
 * the distinction the whole surface exists to make visible.
 */
export function scopeSummaryText(scope: ScopeSummary): string {
  const workspace = scope.workspace ? `workspace "${scope.workspace}"` : "this workspace";
  const global = scope.globalPath
    ? `${scope.globalPath}${scope.globalPresent ? "" : " (not created yet)"}`
    : "this machine's config.json";
  return `Editing ${workspace}. Global preferences live in ${global}.`;
}

/** The human word for a scope, used by the nav headings and the per-category line. */
export function scopeLabel(scope: SettingCategoryView["scope"]): string {
  return scope === "workspace" ? "Workspace" : "Global";
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
  if (mode === "full" || layout === "stacked") return "inset-0 rounded-none";
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
