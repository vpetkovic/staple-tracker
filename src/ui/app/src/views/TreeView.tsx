/**
 * The task list. Status-grouped, one line per task, everything readable without opening it.
 *
 * ── This file is a CONTAINER and nothing else ─────────────────────────────────────────
 *
 * Three tickets converge here and each owns a different layer, which is the only reason
 * three agents could work on it at once:
 *
 *   V2 (STA-87) — the scroll box and the full-bleed width.
 *   V4 (STA-89) — what is IN the list: `session.issues` + `applyFilters`.
 *   V5 (STA-97) — everything from the group headers down, in `views/tree/`.
 *
 * The scroller lives here rather than in the shell because `position: sticky` resolves
 * against the nearest scrolling ancestor, and V5's group headers are sticky. A shell that
 * owned the scrolling would have owned that decision on the list's behalf.
 *
 * V5 removed the padded inner wrapper V2 left behind (`px-4 py-3`). Rows are flush and
 * hairline-separated now, so the list reads as one continuous surface and a gutter would
 * only have stopped the separators reaching the window edge.
 *
 * ── What V5 deleted from this file, and why it was a bug ──────────────────────────────
 *
 * `groupByWorkspace()` mapped `IssueRow[] -> Issue[]` and dropped `row.claim` on the floor.
 * `/api/issues` runs a batched liveness query per workspace and sends `claim` on every row;
 * the view threw the result away, which made the live "Working…" pill impossible. The
 * pipeline now carries `{ issue, claim, workspace }` end to end. Hub mode no longer groups
 * by workspace either — status is the primary axis in both modes and the workspace became a
 * prefix chip on the identifier, because "which file did this come from" is a property of a
 * row and not a reason to split the list.
 *
 * `flatten()` also moved, into `tree/tree-model.ts`, where it gained the thing it was
 * missing: a placement rule. It used to nest a whole family under its head regardless of
 * status, which under status grouping would put an in-progress child inside Backlog.
 */
import { useMemo } from "react";
import type { AuthError } from "@/lib/api";
import { applyFilters, hiddenParents } from "@/lib/filters";
import { useSession } from "@/lib/session";
import { TreeGrid } from "./tree/TreeGrid";
import { EmptyState, NoMatchesState, ViewState } from "./ViewChrome";

export function TreeView(_props: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const { mode, selection, filters } = session;

  const all = useMemo(() => session.issues.data ?? [], [session.issues.data]);
  const rows = useMemo(() => applyFilters(all, filters), [all, filters]);

  /** Children whose parent a filter removed — V4's seam for V5's breadcrumb chip. */
  const orphanedBy = useMemo(() => hiddenParents(rows, all), [rows, all]);

  return (
    <div className="scrollbar-auto-hide h-full overflow-y-auto">
      <ViewState resource={session.issues} empty="no open issues">
        {(loaded) => {
          // An empty workspace and a filter that excluded everything are DIFFERENT
          // sentences, and telling the second as the first is how a filter convinces
          // someone the tracker lost their work.
          if (loaded.length === 0) return <EmptyState>no issues yet</EmptyState>;
          if (rows.length === 0) return <NoMatchesState />;
          return (
            <TreeGrid
              rows={rows}
              mode={mode}
              currentRef={selection?.ref ?? null}
              /*
               * TRUE, and this is the rewiring the spec asked for rather than a
               * disabled gate. `lib/filters.ts` is now the single authority on whether
               * resolved work is on the page, and its rule is subtler than a boolean:
               * selecting the "Done" status is itself the opt-in. Re-applying a
               * hide-resolved default here would throw those rows away again and show
               * an empty list to someone who explicitly asked for done tasks.
               */
              showResolved
              hiddenParents={orphanedBy}
              onOpen={session.open}
              onCloseDrawer={session.close}
            />
          );
        }}
      </ViewState>
    </div>
  );
}
