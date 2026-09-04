/**
 * The root: bootstrap, session state, and the mount points that sit above the shell.
 *
 * The auth story lives here and nowhere else. lib/api.ts turns 401/403 into AuthError,
 * every hook hands those up untouched, and this component is the only thing that reacts
 * to one — by swapping the entire page for the token screen. A view never has to think
 * about auth, and there is exactly one place where "the token went bad" is handled.
 *
 * ── What V2 (STA-87) changed ─────────────────────────────────────────────────────────
 *
 * The split layout is gone. This used to switch between `grid-cols-1` and
 * `grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)]` depending on whether an issue was
 * selected, which meant opening a task RESIZED the list underneath it — every row
 * reflowed, and whatever you were reading moved. V3 (STA-88) makes the detail an overlay
 * drawer portalled to the body, so the content area is now unconditionally full width and
 * `IssueDetailMount` is a third sibling alongside the palette and the create dialog. It
 * takes no props and reads `session.selection` itself; the keying that used to live here
 * moved inside it.
 *
 * The view is also no longer wrapped in a scroll container. `AppShell`'s `<main>` is a
 * plain sized box and each view owns its own scrolling, because the two things V5 and the
 * graph need — sticky group headers and a canvas that fills its parent — are both
 * properties of the scroll container, and a shell that owns it owns those decisions too.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { CommandPaletteMount } from "@/components/CommandPaletteMount";
import { CreateIssueMount } from "@/components/CreateIssueMount";
import { TokenGate } from "@/components/TokenGate";
import { IssueDetailMount } from "@/detail/IssueDetailMount";
import { SettingsMount } from "@/settings/SettingsMount";
import { AuthError, getBootstrap, getIssues, getMilestone, getMilestones, hasToken } from "@/lib/api";
import { buildFilterContext, type MilestoneFacts } from "@/lib/filter-dimensions";
import {
  loadFilters,
  saveFilters,
  withDimension,
  type FilterState,
} from "@/lib/filters";
import {
  DEFAULT_VIEW,
  SessionContext,
  type Selection,
  type StapleSession,
  type ViewName,
} from "@/lib/session";
import { useWorkspaceSettings } from "@/lib/settings";
import type { SortPref } from "@/lib/sort-modes";
import type { MilestoneListRow, MilestoneView } from "@/lib/types";
import {
  filtersForScope,
  loadViewPrefs,
  saveViewPrefs,
  sortForScope,
  sortScopeKey,
  withFiltersForScope,
  withSortForScope,
  type GroupBy,
  type ViewPrefs,
} from "@/lib/view-prefs";
import { useDataVersion, useResource } from "@/lib/useStaple";
import { GraphView } from "@/views/GraphView";
import { MilestonesView } from "@/views/milestones/MilestonesView";
import { TreeView } from "@/views/TreeView";
import { ErrorState, LoadingState } from "@/views/ViewChrome";

/**
 * The only place a view name becomes a component. One entry per member of `VIEWS`, and
 * the type makes that exhaustive — deleting a view from the tuple breaks this line until
 * its entry goes too, which is how the inbox and the board left without leaving a
 * dangling route behind them.
 */
const VIEW_COMPONENTS: Record<ViewName, typeof TreeView> = {
  tree: TreeView,
  graph: GraphView,
  milestones: MilestonesView,
};

/**
 * Same list, same order? Compared by value so a rebuilt-but-identical order keeps its old
 * array identity and every `useMemo`/`useEffect` downstream stays asleep.
 */
function sameOrder(a: readonly Selection[], b: readonly Selection[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry.ref === b[i]!.ref && entry.workspace === b[i]!.workspace);
}

export function App() {
  // Set once, by the first AuthError anything throws. Non-null means: stop rendering
  // the app, the credential we hold cannot work.
  const [authFailure, setAuthFailure] = useState<string | null>(hasToken() ? null : "");
  const onAuthError = useCallback((error: AuthError) => setAuthFailure(error.message), []);

  // Write handlers catch errors to render them as refusals, which would swallow an
  // AuthError before it reached this component — api.ts broadcasts them for that case.
  useEffect(() => {
    const onBroadcast = (event: Event) =>
      onAuthError((event as CustomEvent<AuthError>).detail);
    window.addEventListener("staple:auth-error", onBroadcast);
    return () => window.removeEventListener("staple:auth-error", onBroadcast);
  }, [onAuthError]);

  const [view, setView] = useState<ViewName>(DEFAULT_VIEW);
  /**
   * R4c (STA-188). Which milestone the page was pointed at, and by what. Beside `view`
   * because it is the second half of one navigation act; see lib/session.ts.
   */
  const [milestoneFocus, setMilestoneFocus] = useState<string | null>(null);
  const [ws, setWs] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);

  /**
   * The filter state — V4 (STA-89), SCOPED PER WORKSPACE AND VIEW by R4b (STA-187).
   *
   * Both halves are seeded from localStorage during the FIRST render, not in an effect: an
   * effect would paint one frame of the unfiltered list before correcting itself, and the
   * frame it would paint is the one containing all the done tasks V4 exists to hide.
   *
   * `legacyFilters` is the MIGRATION, read once and never written back into: it is the old
   * global `staple:filters:v1` state, and it answers for every scope the user has not
   * filtered in yet, so nobody opens this build to a filter set they never chose. See
   * `filtersForScope` in lib/view-prefs.ts.
   */
  const [legacyFilters] = useState<FilterState>(() => loadFilters(window.localStorage));
  const [filterPrefs, setFilterPrefs] = useState<Record<string, FilterState>>(
    () => loadViewPrefs(window.localStorage).filters,
  );

  /**
   * How the list is arranged — R1 (STA-100). Seeded during the FIRST render for the same
   * reason the filters are: an effect would paint one frame of the wrong layout and then
   * correct itself, and a list that re-arranges itself 16ms after it appears reads as a bug.
   */
  const [groupBy, setGroupBy] = useState<GroupBy>(() => loadViewPrefs(window.localStorage).groupBy);

  /**
   * The sort preference for every scope the user has ever set one in — R4a (STA-186).
   *
   * The WHOLE map is held rather than the one value on screen, because the scope changes
   * under it: switching workspace or view must produce that scope's sort immediately, and a
   * single `sort` state would have to re-read storage on every switch to do it. Seeded during
   * the first render for the same reason `groupBy` is — an effect would paint one frame of
   * the wrong order and then correct itself.
   */
  const [sortPrefs, setSortPrefs] = useState<Record<string, SortPref>>(
    () => loadViewPrefs(window.localStorage).sort,
  );

  /**
   * ONE autosave for the whole envelope, because it is one key. Two effects writing
   * `staple:view:v1` would race on the render where both changed, and the loser would
   * overwrite the winner with the value it had captured.
   */
  useEffect(() => {
    const prefs: ViewPrefs = { groupBy, sort: sortPrefs, filters: filterPrefs };
    saveViewPrefs(window.localStorage, prefs);
  }, [groupBy, sortPrefs, filterPrefs]);

  /**
   * WHICH SORT AND WHICH FILTER ARE ON SCREEN — the workspace and the view, resolved to one
   * preference each. An unset sort scope is `DEFAULT_SORT`, never the neighbouring scope's
   * choice; an unset FILTER scope is the legacy global state above. See view-prefs.ts.
   */
  const viewScope = sortScopeKey(ws, view);
  const sort = sortForScope(sortPrefs, viewScope);
  const setSort = useCallback(
    (next: SortPref) => setSortPrefs((current) => withSortForScope(current, viewScope, next)),
    [viewScope],
  );

  const filters = filtersForScope(filterPrefs, viewScope, legacyFilters);
  const setFilters = useCallback(
    (next: FilterState) => setFilterPrefs((current) => withFiltersForScope(current, viewScope, next)),
    [viewScope],
  );

  /**
   * The old key stays written, with the set that is on screen. It costs one synchronous
   * write per change and it is what makes this migration reversible: a build that predates
   * R4b, or a tab still running one, reads the filter the user last used rather than the one
   * they had before the upgrade.
   */
  useEffect(() => {
    saveFilters(window.localStorage, filters);
  }, [filters]);

  /**
   * The visible ordered list — published by whichever view is on screen, held here.
   *
   * The identity guard is the whole reason this is a callback and not a plain setter. The
   * fingerprint poll rebuilds the row list every 1.5s; nine times out of ten it produces the
   * SAME order, and handing a fresh array to every consumer each time would re-render the
   * detail drawer twice a second for no change at all.
   */
  const [visibleOrder, setVisibleOrder] = useState<readonly Selection[]>([]);
  const publishVisibleOrder = useCallback((next: readonly Selection[]) => {
    setVisibleOrder((prev) => (sameOrder(prev, next) ? prev : next));
  }, []);

  const { version, bump } = useDataVersion(onAuthError);
  const bootstrap = useResource(() => getBootstrap(), [], onAuthError);

  /**
   * The page's one issue fetch. Scoped by workspace only — every other dimension is
   * applied client-side by `applyFilters`, because the filter menu has to offer the
   * assignees and labels of the WHOLE page, and a server that had already filtered them
   * out could not tell it what they were.
   *
   * `/api/issues` returns resolved work too (`includeResolved: true`), which is what makes
   * "hide done by default, show it on opt-in" a client-side decision rather than a refetch.
   */
  const loadIssues = useCallback(() => getIssues({ ws }), [ws]);
  const issues = useResource(loadIssues, [ws, version], onAuthError);

  /**
   * THE WORKSPACE VOCABULARY — O7b (STA-141). Fetched HERE, once, for the whole page.
   *
   * It has to be at the root and it took a browser to prove it. While this hook lived
   * only inside the settings dialog, nothing fetched `/api/settings` until somebody
   * opened the dialog — so a workspace with a custom status painted every row of it with
   * the SEED's fallback category, which is `unstarted`. A status called `pairing` in the
   * `active` category rendered as a dashed backlog ring, and the label looked right only
   * because `statusLabel` title-cases an id it does not recognise. Every unit test passed;
   * the page was wrong.
   *
   * The result is deliberately not put on the session. `lib/settings.ts` holds it in a
   * module snapshot precisely so that pure modules — `views/tree/tree-model.ts`,
   * `lib/filters.ts`, a `StatusIcon` three components deep — can ask without a hook and
   * without prop drilling. What this call buys is (a) the fetch, and (b) a re-render of
   * the whole tree when the answer changes, which is why `settings.settings` is a
   * dependency of the session memo below.
   *
   * `version` re-runs it on the fingerprint poll, so a vocabulary changed by an agent
   * through MCP or by a shell through the CLI reaches an open page within 1.5s.
   */
  const settings = useWorkspaceSettings({ ws: ws || undefined, version, onAuthError });

  /**
   * THE MILESTONES, FOR THE FILTER — R4b (STA-187).
   *
   * Two reads, and the split is the whole cost argument. `/api/milestones` is ONE request per
   * poll — the same bargain `/api/settings` above already makes — and it is what the menu
   * needs to offer a milestone at all: its identifier, its title, and how many members it
   * has. It carries no members, by design.
   *
   * Membership itself is fetched only for the milestones the user has actually SELECTED,
   * which is almost always one and never the whole list. Filtering by membership without it
   * is impossible; fetching every milestone's members on every poll to answer a question
   * nobody asked would be the same mistake `/api/inbox` is deliberately not making one file
   * over in TreeView.tsx.
   *
   * `all` follows the done toggle, so a finished milestone appears in the menu exactly when
   * finished work is on the page — the same default, asked once.
   */
  const showDone = filters.showDone;
  const loadMilestoneList = useCallback(() => getMilestones({ ws, all: showDone }), [ws, showDone]);
  const milestoneList = useResource<MilestoneListRow[]>(
    loadMilestoneList,
    [ws, showDone, version],
    onAuthError,
  );

  const selectedMilestones = (filters.dims.milestone ?? []).join(",");
  const loadMilestoneMembers = useCallback(
    () =>
      Promise.all(
        (selectedMilestones ? selectedMilestones.split(",") : []).map((ref) =>
          getMilestone({ ws, ref }),
        ),
      ),
    [ws, selectedMilestones],
  );
  const milestoneMembers = useResource<MilestoneView[]>(
    loadMilestoneMembers,
    [ws, selectedMilestones, version],
    onAuthError,
  );

  /**
   * The two reads, joined into what the predicates take. `members: null` — not `[]` — for a
   * milestone nobody has opened: "I have not looked" and "it is empty" are different facts
   * and lib/filter-dimensions.ts refuses to confuse them.
   */
  const milestoneFacts = useMemo<MilestoneFacts[]>(() => {
    const loaded = new Map(
      (milestoneMembers.data ?? []).map((view) => [
        view.milestone.identifier,
        view.members.map((member) => member.identifier),
      ]),
    );
    return (milestoneList.data ?? []).map((row) => ({
      identifier: row.milestone.identifier,
      title: row.milestone.title,
      memberCount: row.memberCount,
      members: loaded.get(row.milestone.identifier) ?? null,
    }));
  }, [milestoneList.data, milestoneMembers.data]);

  /**
   * The filter context — built from the UNFILTERED rows, which is what makes a filtered-away
   * epic still name its children's epic. See lib/filter-dimensions.ts.
   */
  const filterContext = useMemo(
    () => buildFilterContext(issues.data ?? [], milestoneFacts),
    [issues.data, milestoneFacts],
  );

  /** The palette's single-assignee view over the assignee dimension. See session.ts. */
  const assignee = filters.dims.assignee?.[0] ?? "";
  const setAssignee = useCallback(
    (who: string) => setFilters(withDimension(filters, "assignee", who ? [who] : [])),
    [filters, setFilters],
  );

  /**
   * Switching to any view by hand drops the focus: it was a request to look at ONE
   * milestone, and a request that outlived the trip would silently re-point the plan the
   * next time somebody clicked the tab.
   */
  const goToView = useCallback((next: ViewName) => {
    setMilestoneFocus(null);
    setView(next);
  }, []);

  const focusMilestone = useCallback((ref: string) => {
    setMilestoneFocus(ref);
    setView("milestones");
  }, []);

  const open = useCallback((workspace: string, ref: string) => setSelection({ workspace, ref }), []);
  const close = useCallback(() => setSelection(null), []);

  const settingsSnapshot = settings.settings;

  const session = useMemo<StapleSession | null>(() => {
    if (!bootstrap.data) return null;
    return {
      mode: bootstrap.data.mode,
      workspaces: bootstrap.data.workspaces,
      view,
      setView: goToView,
      milestoneFocus,
      focusMilestone,
      ws,
      setWs,
      issues,
      filters,
      setFilters,
      filterContext,
      groupBy,
      setGroupBy,
      sort,
      setSort,
      visibleOrder,
      publishVisibleOrder,
      assignee,
      setAssignee,
      selection,
      open,
      close,
      version,
      refresh: bump,
    };
  }, [
    bootstrap.data,
    // Not read by the session — held as a dependency so that a vocabulary change
    // rebuilds it and every view re-renders against the new statuses. See above.
    settingsSnapshot,
    view,
    goToView,
    milestoneFocus,
    focusMilestone,
    ws,
    issues,
    filters,
    setFilters,
    filterContext,
    groupBy,
    sort,
    setSort,
    visibleOrder,
    publishVisibleOrder,
    assignee,
    setAssignee,
    selection,
    open,
    close,
    version,
    bump,
  ]);

  if (authFailure !== null) {
    return <TokenGate reason={authFailure === "" ? undefined : authFailure} />;
  }

  if (bootstrap.error) {
    return (
      <div className="p-6">
        <ErrorState error={bootstrap.error} />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="p-6">
        <LoadingState />
      </div>
    );
  }

  const View = VIEW_COMPONENTS[session.view];

  return (
    <SessionContext value={session}>
      {/*
        All four mounts sit above the shell on purpose. A palette has to outlive view
        switches, a create dialog has to be triggerable from the header or a keystroke
        without either owning it, and the detail drawer portals out of the layout
        entirely. None of them are affected by what the shell does below.
      */}
      <CommandPaletteMount />
      <CreateIssueMount />
      <IssueDetailMount />
      {/*
        O7b (STA-141). A fourth mount for the same reason as the other three: the
        workspace vocabulary editor has to be openable from the header and from the
        palette without either owning its open flag, and it must survive a view switch.
      */}
      <SettingsMount />

      <AppShell>
        <View onAuthError={onAuthError} />
      </AppShell>
    </SessionContext>
  );
}
