/**
 * The root: bootstrap, session state, the split layout, and the two mount points wave 2
 * builds into.
 *
 * The auth story lives here and nowhere else. lib/api.ts turns 401/403 into AuthError,
 * every hook hands those up untouched, and this component is the only thing that reacts
 * to one — by swapping the entire page for the token screen. A view never has to think
 * about auth, and there is exactly one place where "the token went bad" is handled.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { CommandPaletteMount } from "@/components/CommandPaletteMount";
import { CreateIssueMount } from "@/components/CreateIssueMount";
import { TokenGate } from "@/components/TokenGate";
import { IssueDetailPanel } from "@/detail/IssueDetailPanel";
import { AuthError, getBootstrap, hasToken } from "@/lib/api";
import { SessionContext, type Selection, type StapleSession, type ViewName } from "@/lib/session";
import { useDataVersion, useResource } from "@/lib/useStaple";
import { BoardView } from "@/views/board/BoardView";
import { GraphView } from "@/views/GraphView";
import { InboxView } from "@/views/InboxView";
import { TreeView } from "@/views/TreeView";
import { ErrorState, LoadingState } from "@/views/ViewChrome";

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

  const [view, setView] = useState<ViewName>("inbox");
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

  const View = { inbox: InboxView, board: BoardView, tree: TreeView, graph: GraphView }[session.view];

  return (
    <SessionContext value={session}>
      {/*
        Both mount points sit above the shell on purpose: a palette has to outlive view
        switches and sit over the detail panel, and a create dialog has to be triggerable
        from the board, the palette, or the header without any of them owning it.
      */}
      <CommandPaletteMount />
      <CreateIssueMount />

      <AppShell>
        <div
          className={
            session.selection
              ? "grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)]"
              : "grid h-full min-h-0 grid-cols-1"
          }
        >
          <div className="scrollbar-auto-hide min-h-0 overflow-y-auto p-4">
            <View onAuthError={onAuthError} />
          </div>
          {session.selection ? (
            // Keyed by the selected issue: tab state like a half-picked status, an
            // armed restore, or a document key must not survive an issue switch.
            <IssueDetailPanel
              key={`${session.selection.workspace}:${session.selection.ref}`}
              selection={session.selection}
              onAuthError={onAuthError}
            />
          ) : null}
        </div>
      </AppShell>
    </SessionContext>
  );
}
