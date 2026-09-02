/**
 * The task list. One line per task, everything readable without opening it.
 *
 * ── This file is a CONTAINER and nothing else ─────────────────────────────────────────
 *
 * Four tickets converge here and each owns a different layer, which is the only reason
 * several agents could work on it at once:
 *
 *   V2 (STA-87)  — the scroll box and the full-bleed width.
 *   V4 (STA-89)  — what is IN the list: `session.issues` + `applyFilters`.
 *   V5 (STA-97)  — the row and the group headers, now in `components/task-list/`.
 *   R1 (STA-100) — whether there are group headers at all, and publishing what is visible.
 *
 * The scroller lives here rather than in the shell because `position: sticky` resolves
 * against the nearest scrolling ancestor, V5's group headers are sticky, and R1's
 * scroll-into-view measures against the same box. A shell that owned the scrolling would have
 * owned all three decisions on the list's behalf.
 *
 * ── The two empty states are different sentences ──────────────────────────────────────
 *
 * An empty workspace and a filter that excluded everything are DIFFERENT facts, and telling
 * the second as the first is how a filter convinces someone the tracker lost their work.
 * Both of them also have to CLEAR the published visible order, or the detail drawer's
 * prev/next arrows would keep paging a list that is no longer on the page.
 */
import { useEffect, useMemo } from "react";
import { getInbox, type AuthError } from "@/lib/api";
import { applyFilters, hiddenParents } from "@/lib/filters";
import { useSession } from "@/lib/session";
import type { InboxRow } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { buildPickupIndex, EMPTY_PICKUP_INDEX } from "./tree/pickup-model";
import { TreeGrid } from "./tree/TreeGrid";
import { EmptyState, NoMatchesState, ViewState } from "./ViewChrome";

export function TreeView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const { mode, selection, filters, groupBy, publishVisibleOrder } = session;

  const all = useMemo(() => session.issues.data ?? [], [session.issues.data]);
  const rows = useMemo(() => applyFilters(all, filters), [all, filters]);

  /** Children whose parent a filter removed — V4's seam for V5's breadcrumb chip. */
  const orphanedBy = useMemo(() => hiddenParents(rows, all), [rows, all]);

  /**
   * PICKUP ORDER COMES FROM THE SERVER — V5 (STA-111).
   *
   * `/api/inbox` is the one definition of "ready", and it is dependency-aware in a way no
   * amount of client-side status inspection could reproduce. This fetches it and hands the
   * tree an index; the tree never decides readiness for itself.
   *
   * THREE DELIBERATE CHOICES HERE:
   *
   *  1. FETCHED ONLY IN PICKUP MODE. The loader short-circuits to `[]` in the other two, so
   *     the default view does not pay for an endpoint it never reads. `wantPickup` is in the
   *     deps, so switching the selector fetches immediately rather than at the next poll.
   *
   *  2. FETCHED UNFILTERED — no `assignee` argument, even when a filter has one. The inbox
   *     is used purely as an ORDER-AND-SECTION ORACLE; membership stays `applyFilters`.
   *     Narrowing both would mean a row could survive the filter and then be missing from
   *     the oracle, which is the one way this design could still drop a row.
   *
   *  3. REFETCHED ON `session.version`, the same 1.5s fingerprint every other read uses, so
   *     a claim taken by another agent moves the ticket from Up next to In flight within a
   *     poll rather than on a reload.
   */
  const wantPickup = groupBy === "pickup";
  const inbox = useResource<InboxRow[]>(
    () => (wantPickup ? getInbox() : Promise.resolve([])),
    [wantPickup, session.version],
    onAuthError,
  );

  const pickup = useMemo(
    () => (wantPickup && inbox.data ? buildPickupIndex(inbox.data) : EMPTY_PICKUP_INDEX),
    [wantPickup, inbox.data],
  );

  /**
   * Nothing on screen means nothing to navigate. TreeGrid publishes its own order and clears
   * it when it unmounts, but it never mounts at all in the loading and empty states — and
   * those are exactly the states where a stale order would be most confusing, because the
   * drawer can still be open over an empty list.
   */
  useEffect(() => {
    if (rows.length === 0) publishVisibleOrder([]);
  }, [rows.length, publishVisibleOrder]);

  return (
    <div className="scrollbar-auto-hide h-full overflow-y-auto">
      <ViewState resource={session.issues} empty="no open issues">
        {(loaded) => {
          if (loaded.length === 0) return <EmptyState>no issues yet</EmptyState>;
          if (rows.length === 0) return <NoMatchesState />;
          return (
            <TreeGrid
              rows={rows}
              /*
               * O3b (STA-127). The UNFILTERED list, for the collapsed-parent rollup's counts
               * and nothing else — `rows` above still decides membership, order and
               * everything the keyboard walks.
               *
               * It has to be this array rather than `rows`, because `done` is hidden by the
               * default filter: a rollup computed from what is on screen would tell an epic
               * with three finished children and two open ones that it is `0/2`, which is
               * not a partial answer but the wrong one. No new fetch — `/api/issues` is
               * unpaged and `session.issues.data` IS the whole list.
               */
              allRows={all}
              mode={mode}
              groupBy={groupBy}
              pickup={pickup}
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
              onVisibleOrder={publishVisibleOrder}
            />
          );
        }}
      </ViewState>
    </div>
  );
}
