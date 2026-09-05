/**
 * The page's own state — what is on screen, filtered how, with what selected.
 *
 * Kept as one context rather than scattered useState so every surface (the palette, a
 * tree row, a graph node, the navigation rail) can drive navigation without any one of
 * them owning it.
 */
import { createContext, useContext } from "react";
import type { FilterContext } from "./filter-dimensions";
import type { FilterState } from "./filters";
import type { IssueRow, UiMode, WorkspaceRef } from "./types";
import type { SortPref } from "./sort-modes";
import type { GroupBy } from "./view-prefs";
import type { Resource } from "./useStaple";

/**
 * The views, in the order the navigation rail lists them. FIRST IS THE DEFAULT.
 *
 * This tuple is the one registry of views: the rail's "Workspace" group
 * (`components/nav/nav-model.ts`), the palette's "Go to …" commands and the component map
 * in App.tsx are all derived from it, so adding or removing a view is one line here plus
 * one line in App.tsx's map and nothing else. `inbox` and `board` left this way, and the
 * pieces worth keeping moved to `lib/refusal.ts` and `components/GuardRefusal`.
 *
 * The VALUE `tree` is internal and stays: `sortScopeKey(ws, view)` and the localStorage
 * envelope key off it, so renaming it would silently discard every saved sort and filter
 * preference. What the user sees is `VIEW_LABELS` — the tree view is called "Tasks"
 * everywhere a human reads it.
 */
export const VIEWS = ["tree", "queue", "graph", "milestones"] as const;
export type ViewName = (typeof VIEWS)[number];

/** The human name of each view — the rail row, the content header, the palette command. */
export const VIEW_LABELS: Record<ViewName, string> = {
  tree: "Tasks",
  queue: "Queue",
  graph: "Graph",
  milestones: "Milestones",
};

export function viewLabel(view: ViewName): string {
  return VIEW_LABELS[view];
}

/**
 * Where the app lands. Tasks is the product — the list is what you look at, and the
 * graph is where you go to answer a question about shape. Declared rather than written
 * as a literal in App.tsx so "what is the default view" has one answer.
 */
export const DEFAULT_VIEW: ViewName = VIEWS[0];

export interface Selection {
  workspace: string;
  ref: string;
}

export interface StapleSession {
  mode: UiMode;
  workspaces: WorkspaceRef[];

  view: ViewName;
  setView: (view: ViewName) => void;

  /**
   * THE MILESTONE THE PAGE IS POINTED AT — R4c (STA-188).
   *
   * `focusMilestone` is one navigation primitive, exactly like `open` below: it switches to
   * the Milestones view AND records which milestone the reader asked for, so a row's
   * milestone marker can send somebody to the plan it names rather than to whichever
   * milestone happened to sort first.
   *
   * It lives here for the reason `view` does — the row that dispatches it, the header tabs
   * and the palette must all drive navigation without any one of them owning it. Cleared to
   * `null` on any other view switch, so a stale focus cannot outlive the trip.
   */
  milestoneFocus: string | null;
  focusMilestone: (ref: string) => void;

  /** "" means every workspace, and is only reachable in hub mode. */
  ws: string;
  setWs: (ws: string) => void;

  /**
   * Every issue in scope, UNFILTERED, fetched once for the whole page — V4 (STA-89).
   *
   * It lives here rather than inside each view because three surfaces need the same
   * list and they must agree about it: the tree renders it, the graph uses it to decide
   * which nodes survive the filter, and the filter menu derives its assignee and label
   * options from it. Three independent fetches on a 1.5s poll would be three chances for
   * the menu to offer a filter the list has never heard of.
   *
   * The FILTERED list is nowhere on the session on purpose. It is `applyFilters(rows,
   * filters)` — one pure call at one wiring point per view — and caching it here would
   * be a second source of truth for something that is already cheap to derive.
   */
  issues: Resource<IssueRow[]>;

  /**
   * What the page is filtered by, everywhere. Autosaved to localStorage by App.tsx on
   * every change; see lib/filters.ts for the shape and why `showDone` is on it.
   */
  filters: FilterState;
  setFilters: (next: FilterState) => void;

  /**
   * THE SERVED FACTS THE FILTER NEEDS BEYOND THE ROWS — R4b (STA-187).
   *
   * Milestone membership comes from `/api/milestones`, and a row's epic is a property of the
   * whole list rather than of the row. Both live here for the reason `issues` does: the menu,
   * the chip strip and the view must agree about them, and three surfaces deriving them
   * separately would be three chances for the menu to offer a milestone the list has never
   * heard of. Built by App with `buildFilterContext`; see lib/filter-dimensions.ts.
   */
  filterContext: FilterContext;

  /**
   * The assignee filter as a single string — a DERIVED view over `filters.dims.assignee`,
   * kept because the command palette speaks in these terms ("Filter by assignee…", "Clear
   * the assignee filter") and there is no reason for it to learn about dimensions. Reading
   * gives the first selected assignee or ""; writing replaces the whole dimension.
   */
  assignee: string;
  setAssignee: (assignee: string) => void;

  /**
   * How the list is ARRANGED — R1 (STA-100). Flat is the default; see lib/view-prefs.ts for
   * why this is not a field on the filter envelope.
   *
   * It sits on the session rather than inside the tree because the palette will want to
   * offer "Group by status" as a command, and because App owns the autosave for every
   * persisted preference in one place.
   */
  groupBy: GroupBy;
  setGroupBy: (next: GroupBy) => void;

  /**
   * WHAT ORDER THE LIST IS IN — R4a (STA-186). See lib/sort-modes.ts for the registry.
   *
   * Beside `groupBy` and not on it: arrangement and order are two questions, and a reader
   * who has grouped by epic has not asked for the rows inside those epics to be re-ordered.
   * Unlike `groupBy` this is stored per WORKSPACE and per VIEW — the argument is in
   * lib/view-prefs.ts — so App resolves the scope and this field is the answer for the scope
   * currently on screen. Setting it writes to that scope and no other.
   */
  sort: SortPref;
  setSort: (next: SortPref) => void;

  /**
   * THE VISIBLE ORDERED LIST — the contract R6 (STA-106) navigates by.
   *
   * Every task the user can currently see, in the order they see it: post-filter,
   * post-group, flattened. Group HEADERS are not in it (they are not tasks). Rows inside a
   * collapsed group or under a collapsed parent are not in it either — they are not
   * visible, and a "next" that lands on a row you cannot see is the bug the arrows exist to
   * avoid. `[]` when the active view has no list, so a consumer disables rather than guesses.
   *
   * PUBLISHED BY THE VIEW, HELD HERE. The alternative — deriving it in App — would need the
   * tree's collapse and expansion state, which lives in views/tree/expansion.ts; hoisting a
   * view's private UI state into the page's global state to serve a consumer in the drawer
   * is the wrong trade. App holds it behind an identity guard, so an unchanged order on the
   * 1.5s poll does not re-render everything that reads it.
   */
  visibleOrder: readonly Selection[];
  publishVisibleOrder: (order: readonly Selection[]) => void;

  selection: Selection | null;
  /** The single navigation primitive: open an issue in the detail drawer. */
  open: (workspace: string, ref: string) => void;
  close: () => void;

  /** Ticks on every fingerprint change; every view refetches on it. */
  version: number;
  /** Force a refresh now, without waiting for the next poll. Call after a write. */
  refresh: () => void;
}

export const SessionContext = createContext<StapleSession | null>(null);

export function useSession(): StapleSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() outside <App/>");
  return session;
}
