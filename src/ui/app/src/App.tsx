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
import { AuthError, getBootstrap, getIssues, hasToken } from "@/lib/api";
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
import { loadViewPrefs, saveViewPrefs, type GroupBy } from "@/lib/view-prefs";
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
  const [ws, setWs] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);

  /**
   * The filter state — V4 (STA-89). Seeded from localStorage during the FIRST render, not
   * in an effect: an effect would paint one frame of the unfiltered list before correcting
   * itself, and the frame it would paint is the one containing all the done tasks this
   * ticket exists to hide.
   */
  const [filters, setFilters] = useState<FilterState>(() => loadFilters(window.localStorage));

  /**
   * Autosave. Every change, no save button, no debounce — the value is a few hundred bytes
   * and the write is synchronous and idempotent, so the honest implementation is the naive
   * one. This also fires once on mount with the value it just loaded, which is a no-op and
   * costs less than the branch it would take to avoid it.
   */
  useEffect(() => {
    saveFilters(window.localStorage, filters);
  }, [filters]);

  /**
   * How the list is arranged — R1 (STA-100). Seeded during the FIRST render for the same
   * reason the filters are: an effect would paint one frame of the wrong layout and then
   * correct itself, and a list that re-arranges itself 16ms after it appears reads as a bug.
   */
  const [groupBy, setGroupBy] = useState<GroupBy>(() => loadViewPrefs(window.localStorage).groupBy);

  useEffect(() => {
    saveViewPrefs(window.localStorage, { groupBy });
  }, [groupBy]);

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

  /** The palette's single-assignee view over the assignee dimension. See session.ts. */
  const assignee = filters.dims.assignee?.[0] ?? "";
  const setAssignee = useCallback(
    (who: string) =>
      setFilters((current) => withDimension(current, "assignee", who ? [who] : [])),
    [],
  );

  const open = useCallback((workspace: string, ref: string) => setSelection({ workspace, ref }), []);
  const close = useCallback(() => setSelection(null), []);

  const settingsSnapshot = settings.settings;

  const session = useMemo<StapleSession | null>(() => {
    if (!bootstrap.data) return null;
    return {
      mode: bootstrap.data.mode,
      workspaces: bootstrap.data.workspaces,
      view,
      setView,
      ws,
      setWs,
      issues,
      filters,
      setFilters,
      groupBy,
      setGroupBy,
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
    ws,
    issues,
    filters,
    groupBy,
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
