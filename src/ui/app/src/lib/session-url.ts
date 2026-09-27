/**
 * THE PAGE'S ADDRESS — which workspace, which view, and how it is filtered, in the URL.
 *
 * The URL is the source of truth for what is on screen. A reload, a bookmark, a link sent
 * to a phone and the browser's Back button all land on the same page, because the page is
 * rebuilt from the address rather than from whatever this tab last had in memory.
 *
 * ── THE SHAPE ─────────────────────────────────────────────────────────────────────────
 *
 *   ?ws=staple&view=tasks&status=in_progress&status=in_review&priority=high&q=login&done=1
 *
 * Readable on purpose: one parameter per filter dimension, repeated for each value (so a
 * label with a comma in it survives), `q` for the search box, `done=1` when finished work
 * is shown, `focus` for the milestone the Milestones view was pointed at. `ws` absent means
 * every workspace. `view` is the one parameter the app ALWAYS writes, and its presence is
 * what says "this address describes a page": a bare `/` (a fresh tab, the printed launch
 * URL) says nothing, and the page then opens on what this browser last remembered.
 *
 * ── WHAT IT LEAVES ALONE ──────────────────────────────────────────────────────────────
 *
 * `withShellState` rewrites only its own parameters and keeps every other one verbatim:
 * `settings`/`settings-ws` (the settings sheet, see settings/settings-shell.ts), `graph`
 * (the graph's shareable layout — kept on the Graph only, dropped on every other page) and
 * `token` (which lib/api.ts strips on arrival anyway).
 */
import { ALL_FILTER_DIMENSIONS } from "./filter-dimensions";
import { emptyFilters, type FilterState } from "./filters";
import { VIEWS, type ViewName } from "./session";

/** The address word for each view. `tree` and `calibration` are internal ids a reader never sees. */
export const VIEW_SLUGS: Record<ViewName, string> = {
  tree: "tasks",
  queue: "queue",
  graph: "graph",
  milestones: "milestones",
  calibration: "estimate-accuracy",
  budget: "budget",
};

const SLUG_TO_VIEW = new Map<string, ViewName>([
  ...VIEWS.map((view) => [VIEW_SLUGS[view], view] as const),
  // The internal ids are accepted too, so a hand-typed `view=tree` still lands.
  ...VIEWS.map((view) => [view, view] as const),
]);

export function viewFromSlug(slug: string | null): ViewName | null {
  return slug === null ? null : (SLUG_TO_VIEW.get(slug.toLowerCase()) ?? null);
}

export const URL_PARAMS = { ws: "ws", view: "view", text: "q", done: "done", focus: "focus" } as const;

/** The Graph's own shareable layout parameter (views/graph/graph-share.ts). Kept only on the Graph. */
export const GRAPH_PARAM = "graph";

/** Every filter dimension id the address can carry. */
function dimensionIds(): string[] {
  return ALL_FILTER_DIMENSIONS.map((dimension) => dimension.id);
}

export interface ShellUrlState {
  /** "" = every workspace. */
  ws: string;
  view: ViewName;
  filters: FilterState;
  /** The milestone the Milestones view is pointed at, or null. */
  focus: string | null;
}

/**
 * What the address says, or `null` when it says nothing about the page (no `view`).
 * An unknown view slug is also "says nothing" rather than a broken page.
 */
export function readShellUrl(search: string): ShellUrlState | null {
  const params = new URLSearchParams(search);
  const view = viewFromSlug(params.get(URL_PARAMS.view));
  if (view === null) return null;
  const dims: Record<string, string[]> = {};
  for (const id of dimensionIds()) {
    const values = params
      .getAll(id)
      .map((value) => value.trim())
      .filter((value) => value !== "");
    if (values.length > 0) dims[id] = [...new Set(values)];
  }
  return {
    ws: params.get(URL_PARAMS.ws)?.trim() ?? "",
    view,
    filters: {
      ...emptyFilters(),
      dims,
      text: params.get(URL_PARAMS.text) ?? "",
      showDone: params.get(URL_PARAMS.done) === "1",
    },
    focus: params.get(URL_PARAMS.focus) || null,
  };
}

/**
 * The href with the page's state written into it and every other parameter kept. The
 * order is fixed (ws, view, then the filters in registry order) so the same state always
 * produces the same string, which is what lets the caller skip a no-op `replaceState`.
 */
export function withShellState(href: string, state: ShellUrlState): string {
  const url = new URL(href);
  const params = url.searchParams;
  for (const key of [...Object.values(URL_PARAMS), ...dimensionIds()]) params.delete(key);
  // The graph's layout belongs to the Graph: on any other page it would ride along, unread,
  // into every link and bookmark — and re-appear on the Graph from a stale address.
  if (state.view !== "graph") params.delete(GRAPH_PARAM);
  const extra = [...params.entries()];
  const next = new URLSearchParams();
  if (state.ws) next.set(URL_PARAMS.ws, state.ws);
  next.set(URL_PARAMS.view, VIEW_SLUGS[state.view]);
  for (const id of dimensionIds()) {
    for (const value of state.filters.dims[id] ?? []) next.append(id, value);
  }
  if (state.filters.text.trim() !== "") next.set(URL_PARAMS.text, state.filters.text);
  if (state.filters.showDone) next.set(URL_PARAMS.done, "1");
  if (state.focus) next.set(URL_PARAMS.focus, state.focus);
  for (const [key, value] of extra) next.append(key, value);
  url.search = next.toString();
  return url.toString();
}

/**
 * WHERE A WORKSPACE SWITCH LANDS. The same page — the view you were on exists in every
 * workspace, so switching from Graph on `staple` lands on Graph on `pinecone` — with that
 * workspace's own remembered filters (filters are kept per workspace and view, see
 * lib/view-prefs.ts). A milestone focus does not travel: it names a milestone of the
 * workspace you left, and pointing the new workspace's plan at it would show nothing.
 */
export function afterWorkspaceSwitch(
  current: Pick<ShellUrlState, "view">,
  target: string,
  filtersFor: (ws: string, view: ViewName) => FilterState,
): ShellUrlState {
  return { ws: target, view: current.view, focus: null, filters: filtersFor(target, current.view) };
}

/**
 * Does moving from `before` to `after` deserve its own Back step? A new workspace or a
 * new view is a place you went to, and Back should return from it — on a phone that is
 * the system back gesture. A filter tweak or a keystroke in the search box is not; those
 * replace the entry so Back does not have to walk through every letter typed.
 */
export function isNavigation(before: ShellUrlState | null, after: ShellUrlState): boolean {
  if (before === null) return false;
  return before.ws !== after.ws || before.view !== after.view;
}
