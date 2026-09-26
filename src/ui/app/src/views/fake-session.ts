/**
 * A session for rendering a view to markup in a test: every field present, every action a
 * no-op, and the four that decide which workspace a page reads (`mode`, `ws`, `workspaces`,
 * `setWs`) set by the caller. Test-only; nothing in the app imports it.
 */
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters } from "@/lib/filters";
import type { StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";

const noop = () => {};

export function fakeSession(over: Partial<StapleSession> = {}): StapleSession {
  return {
    mode: "workspace",
    workspaces: [{ slug: "staple", prefix: "STA" }],
    view: "tree",
    setView: noop,
    milestoneFocus: null,
    focusMilestone: noop,
    projects: { data: [], error: undefined, loading: false, reload: noop },
    focusProject: noop,
    ws: "staple",
    setWs: noop,
    issues: { data: [], error: undefined, loading: false, reload: noop },
    filters: emptyFilters(),
    setFilters: noop,
    filterContext: buildFilterContext([]),
    assignee: "",
    setAssignee: noop,
    groupBy: "none",
    setGroupBy: noop,
    sort: DEFAULT_SORT,
    setSort: noop,
    visibleOrder: [],
    publishVisibleOrder: noop,
    selection: null,
    open: noop,
    pin: noop,
    close: noop,
    version: 1,
    refresh: noop,
    ...over,
  };
}
