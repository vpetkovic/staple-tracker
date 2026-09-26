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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { CommandPaletteMount } from "@/components/CommandPaletteMount";
import { CreateIssueMount } from "@/components/CreateIssueMount";
import { TokenGate } from "@/components/TokenGate";
import { IssueDetailMount } from "@/detail/IssueDetailMount";
import { SettingsMount } from "@/settings/SettingsMount";
import { ProjectDialogMount } from "@/components/projects/ProjectDialogMount";
import {
  AuthError,
  getBootstrap,
  getIssues,
  getMilestone,
  getMilestones,
  getProjects,
  hasToken,
} from "@/lib/api";
import { buildFilterContext, type MilestoneFacts, type ProjectFacts } from "@/lib/filter-dimensions";
import {
  loadFilters,
  retainDimensionValues,
  saveFilters,
  withDimension,
  type FilterState,
} from "@/lib/filters";
import { readMilestoneList } from "@/lib/milestone-list";
import { projectsForWorkspace } from "@/lib/projects";
import {
  DEFAULT_VIEW,
  SessionContext,
  pinSelection,
  type Selection,
  type StapleSession,
  type ViewName,
} from "@/lib/session";
import {
  afterWorkspaceSwitch,
  isNavigation,
  readShellUrl,
  withShellState,
  type ShellUrlState,
} from "@/lib/session-url";
import { rememberWorkspace } from "@/lib/session-workspace";
import { afterHistorySettles, isOwnTraversal, leaveOverlays, replaceUrl } from "@/lib/back-to-close";
import { useWorkspaceSettings } from "@/lib/settings";
import type { SortPref } from "@/lib/sort-modes";
import type { MilestoneListRow, MilestoneView, ProjectRow } from "@/lib/types";
import {
  filtersForScope,
  loadViewPrefs,
  pruneFilterScopes,
  saveViewPrefs,
  sortForScope,
  sortScopeKey,
  withFiltersForScope,
  withSortForScope,
  type GroupBy,
  type ViewPrefs,
} from "@/lib/view-prefs";
import { useDataVersion, useResource } from "@/lib/useStaple";
import { BudgetView } from "@/views/budget/BudgetView";
import { CalibrationView } from "@/views/calibration/CalibrationView";
import { GraphView } from "@/views/GraphView";
import { MilestonesView } from "@/views/milestones/MilestonesView";
import { QueueView } from "@/views/queue/QueueView";
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
  queue: QueueView,
  calibration: CalibrationView,
  budget: BudgetView,
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

  /**
   * THE ADDRESS, read once before the first render — lib/session-url.ts. When it describes a
   * page (it carries `view`), the workspace, the view, the milestone focus and that scope's
   * filters all start from it; a bare address starts from what this browser remembered.
   */
  const [initialUrl] = useState<ShellUrlState | null>(() =>
    typeof window === "undefined" ? null : readShellUrl(window.location.search),
  );
  const [view, setView] = useState<ViewName>(initialUrl?.view ?? DEFAULT_VIEW);
  /**
   * R4c (STA-188). Which milestone the page was pointed at, and by what. Beside `view`
   * because it is the second half of one navigation act; see lib/session.ts.
   */
  const [milestoneFocus, setMilestoneFocus] = useState<string | null>(initialUrl?.focus ?? null);
  const [ws, setWsState] = useState(initialUrl?.ws ?? "");
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
  const [legacyFilters, setLegacyFilters] = useState<FilterState>(() => loadFilters(window.localStorage));
  const [filterPrefs, setFilterPrefs] = useState<Record<string, FilterState>>(() => {
    const stored = loadViewPrefs(window.localStorage).filters;
    // An address that describes a page decides that page's filters, whatever was stored.
    if (!initialUrl) return stored;
    return withFiltersForScope(stored, sortScopeKey(initialUrl.ws, initialUrl.view), initialUrl.filters);
  });

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
  /**
   * All workspaces paints every workspace's rows, so it gets every workspace's vocabulary —
   * their union, with the first workspace in hub order deciding a shared id's label and
   * category (`mergeWorkspaceVocabularies`) — rather than the first workspace's alone.
   */
  const vocabularyOfAll = useMemo(
    () =>
      bootstrap.data?.mode === "hub" && ws === "" ? bootstrap.data.workspaces.map((entry) => entry.slug) : undefined,
    [bootstrap.data, ws],
  );
  // Nothing is asked before the workspace list is known (see `wait`): never a per-workspace
  // read for a workspace nobody chose.
  const settings = useWorkspaceSettings({
    ws: ws || undefined,
    all: vocabularyOfAll,
    version,
    onAuthError,
    wait: bootstrap.data === undefined,
  });

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
  /** All workspaces asks every workspace: `readMilestoneList` in lib/milestone-list.ts. */
  const booted = bootstrap.data !== undefined;
  const allWorkspaces = bootstrap.data?.mode === "hub" && ws === "";
  const workspaceSlugs = (bootstrap.data?.workspaces ?? []).map((entry) => entry.slug).join(",");
  const loadMilestoneList = useCallback(
    () =>
      readMilestoneList(
        { booted, allWorkspaces, ws, workspaces: workspaceSlugs ? workspaceSlugs.split(",") : [], showDone },
        getMilestones,
      ),
    [ws, showDone, booted, allWorkspaces, workspaceSlugs],
  );
  const milestoneList = useResource<{ row: MilestoneListRow; ws: string }[]>(
    loadMilestoneList,
    [ws, showDone, booted, allWorkspaces, workspaceSlugs, version],
    onAuthError,
  );

  const selectedMilestones = (filters.dims.milestone ?? []).join(",");
  /** Which workspace each listed milestone lives in, so a selected one is read from there. */
  const milestoneHomes = useMemo(
    () => (milestoneList.data ?? []).map((entry) => `${entry.row.milestone.identifier}=${entry.ws}`).join(","),
    [milestoneList.data],
  );
  const loadMilestoneMembers = useCallback(() => {
    const homes = new Map(
      (milestoneHomes ? milestoneHomes.split(",") : []).map((pair) => pair.split("=") as [string, string]),
    );
    return Promise.all(
      (selectedMilestones ? selectedMilestones.split(",") : []).map((ref) =>
        getMilestone({ ws: homes.get(ref) ?? ws, ref }),
      ),
    );
  }, [ws, selectedMilestones, milestoneHomes]);
  const milestoneMembers = useResource<MilestoneView[]>(
    loadMilestoneMembers,
    [ws, selectedMilestones, milestoneHomes, version],
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
    return (milestoneList.data ?? []).map(({ row }) => ({
      identifier: row.milestone.identifier,
      title: row.milestone.title,
      memberCount: row.memberCount,
      members: loaded.get(row.milestone.identifier) ?? null,
    }));
  }, [milestoneList.data, milestoneMembers.data]);

  /**
   * THE TRACKED PROJECTS (migration 009). One read per poll, UNSCOPED — every workspace's
   * in hub mode — because the detail panel can hold an issue from a workspace the page is
   * not on (a cross-workspace blocker opened from the drawer) and its Project row must
   * offer that workspace's projects, not this one's. The rail, the filter context, the
   * create dialog and the detail row each narrow the list with `projectsForWorkspace`.
   */
  const loadProjects = useCallback(() => getProjects({}), []);
  const projects = useResource<ProjectRow[]>(loadProjects, [version], onAuthError);
  const projectFacts = useMemo<ProjectFacts[]>(
    () =>
      projectsForWorkspace(projects.data ?? [], ws).map((row) => ({
        id: row.project.id,
        name: row.project.name,
        workspace: row.workspace,
      })),
    [projects.data, ws],
  );

  /**
   * A DELETED PROJECT LEAVES NO FILTER BEHIND. Its id may still be selected in any saved
   * scope — a Tasks scope last filtered a week ago, the legacy fallback — and would greet
   * the reader with a chip over an empty list. Once the served list has arrived (never on
   * a failed or pending read, which knows nothing), every scope drops the ids it no
   * longer names. The helpers hand back the same object when nothing changed, so the
   * usual poll costs no render.
   */
  useEffect(() => {
    if (!projects.data) return;
    const known = new Set(projects.data.map((row) => row.project.id));
    setFilterPrefs((current) => pruneFilterScopes(current, "project", known));
    setLegacyFilters((current) => retainDimensionValues(current, "project", known));
  }, [projects.data]);

  /**
   * The filter context — built from the UNFILTERED rows, which is what makes a filtered-away
   * epic still name its children's epic. See lib/filter-dimensions.ts.
   */
  const filterContext = useMemo(
    () => buildFilterContext(issues.data ?? [], milestoneFacts, projectFacts),
    [issues.data, milestoneFacts, projectFacts],
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

  /**
   * The rail's project click: Tasks, narrowed to one project. The filter is written into
   * the TASKS scope for this workspace explicitly rather than through `setFilters`, which
   * writes to whichever scope is on screen — from the graph that would have filtered the
   * graph and then left it. Replaces the project selection rather than toggling it, for
   * the reason the palette's dimension command gives: a click is an absolute request.
   */
  const focusProject = useCallback(
    (projectId: string) => {
      const scope = sortScopeKey(ws, "tree");
      setFilterPrefs((current) =>
        withFiltersForScope(
          current,
          scope,
          withDimension(filtersForScope(current, scope, legacyFilters), "project", [projectId]),
        ),
      );
      setMilestoneFocus(null);
      setView("tree");
    },
    [ws, legacyFilters],
  );

  /**
   * SWITCHING WORKSPACE KEEPS THE PAGE — `afterWorkspaceSwitch` in lib/session-url.ts. The
   * view stays; the milestone focus (a milestone of the workspace being left) does not; the
   * filters are the target scope's own, which `filtersForScope` resolves on the next render.
   * A chosen workspace is also remembered as the default for "which workspace?" questions
   * asked later from All workspaces (lib/session-workspace.ts).
   */
  const setWs = useCallback(
    (next: string) => {
      const landing = afterWorkspaceSwitch({ view }, next, () => filters);
      setWsState(landing.ws);
      setMilestoneFocus(landing.focus);
      if (next) rememberWorkspace(next);
    },
    [view, filters],
  );

  /**
   * THE URL MIRRORS THE PAGE, and the page follows the URL on Back and Forward.
   *
   * Every change to the workspace, the view, the focus or the filters on screen is written
   * into the address. Going somewhere (another workspace or view) pushes a history entry, so
   * Back — the phone's back gesture included — returns from it; narrowing the list replaces
   * the entry, so Back does not replay every keystroke typed into search. `lastSynced` is
   * the state the address last held, which is what makes a popstate write nothing back.
   */
  const lastSynced = useRef<ShellUrlState | null>(initialUrl);
  const shellState = useMemo<ShellUrlState>(
    () => ({ ws, view, filters, focus: milestoneFocus }),
    [ws, view, filters, milestoneFocus],
  );
  useEffect(() => {
    const navigating = isNavigation(lastSynced.current, shellState);
    lastSynced.current = shellState;
    // The address is built when the write RUNS, not now: a write queued behind an overlay
    // closing (lib/back-to-close.ts) must see the address the traversal landed on.
    const write = () => {
      const href = withShellState(window.location.href, shellState);
      if (href === window.location.href) return;
      if (navigating) window.history.pushState(null, "", href);
      else replaceUrl(href);
    };
    // Going somewhere closes whatever is open on top first, so Back from the new page
    // returns to the old page and not to a stale overlay entry of it.
    if (navigating) leaveOverlays(write);
    else afterHistorySettles(write);
  }, [shellState]);

  useEffect(() => {
    const onPop = () => {
      // An overlay closing (or being closed for a navigation) steps back through entries at
      // the page's own address, or at the address the page is leaving: neither is a request
      // to go anywhere.
      if (isOwnTraversal()) return;
      const next = readShellUrl(window.location.search);
      if (!next) return;
      lastSynced.current = next;
      setWsState(next.ws);
      setView(next.view);
      setMilestoneFocus(next.focus);
      setFilterPrefs((current) => withFiltersForScope(current, sortScopeKey(next.ws, next.view), next.filters));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /**
   * An address naming a workspace this hub does not have (a link from another machine, a
   * workspace unregistered since) lands on All workspaces rather than on an error.
   */
  const knownWorkspaces = bootstrap.data?.workspaces;
  const hubMode = bootstrap.data?.mode === "hub";
  useEffect(() => {
    if (!knownWorkspaces || ws === "") return;
    if (!hubMode || !knownWorkspaces.some((workspace) => workspace.slug === ws)) setWsState("");
  }, [knownWorkspaces, hubMode, ws]);

  const open = useCallback((workspace: string, ref: string) => setSelection({ workspace, ref }), []);
  const pin = useCallback(
    (workspace: string, ref: string, id: string) => setSelection((current) => pinSelection(current, { workspace, ref, id })),
    [],
  );
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
      projects,
      focusProject,
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
      pin,
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
    projects,
    focusProject,
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
    pin,
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
      {/* The project dialog (migration 009): opened from the rail's `+` and each project's gear. */}
      <ProjectDialogMount />

      <AppShell>
        <View onAuthError={onAuthError} />
      </AppShell>
    </SessionContext>
  );
}
