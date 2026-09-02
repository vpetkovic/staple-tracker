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
import { AuthError, getBootstrap, hasToken } from "@/lib/api";
import {
  DEFAULT_VIEW,
  SessionContext,
  type Selection,
  type StapleSession,
  type ViewName,
} from "@/lib/session";
import { useDataVersion, useResource } from "@/lib/useStaple";
import { GraphView } from "@/views/GraphView";
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
};

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
  const [assignee, setAssignee] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);

  const { version, bump } = useDataVersion(onAuthError);
  const bootstrap = useResource(() => getBootstrap(), [], onAuthError);

  const open = useCallback((workspace: string, ref: string) => setSelection({ workspace, ref }), []);
  const close = useCallback(() => setSelection(null), []);

  const session = useMemo<StapleSession | null>(() => {
    if (!bootstrap.data) return null;
    return {
      mode: bootstrap.data.mode,
      workspaces: bootstrap.data.workspaces,
      view,
      setView,
      ws,
      setWs,
      assignee,
      setAssignee,
      selection,
      open,
      close,
      version,
      refresh: bump,
    };
  }, [bootstrap.data, view, ws, assignee, selection, open, close, version, bump]);

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
        All three mounts sit above the shell on purpose. A palette has to outlive view
        switches, a create dialog has to be triggerable from the header or a keystroke
        without either owning it, and the detail drawer portals out of the layout
        entirely. None of them are affected by what the shell does below.
      */}
      <CommandPaletteMount />
      <CreateIssueMount />
      <IssueDetailMount />

      <AppShell>
        <View onAuthError={onAuthError} />
      </AppShell>
    </SessionContext>
  );
}
