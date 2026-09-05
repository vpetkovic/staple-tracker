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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { dequeueTask, enqueueTask, getInbox, getQueue, isRevisionConflict, type AuthError } from "@/lib/api";
import {
  attachRowCues,
  buildRowCueIndex,
  EMPTY_ROW_CUE_INDEX,
  type TaskRow,
} from "@/components/task-list";
import { GuardRefusal } from "@/components/GuardRefusal";
import { QueueRowMenu, queueRowMenuState } from "@/components/QueueRowMenu";
import { buildGateCaptions } from "@/lib/derived-queued";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { FilterEmptyState } from "@/components/filters/FilterEmptyState";
import { applyFilterDimensions } from "@/lib/filter-dimensions";
import { hiddenParents } from "@/lib/filters";
import { useSession } from "@/lib/session";
import type { InboxRow, QueueView } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { buildPickupIndex, EMPTY_PICKUP_INDEX } from "./tree/pickup-model";
import { TreeGrid } from "./tree/TreeGrid";
import { EmptyState, ViewState } from "./ViewChrome";

export function TreeView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const { mode, selection, filters, filterContext, groupBy, sort, publishVisibleOrder } = session;

  /**
   * THE PICKUP PLAN, JOINED ONTO THE ROWS — R4c (STA-188).
   *
   * `/api/issues` reserves `pickupState`, `queuePosition` and `planPosition` and does not
   * send them, so the cues are joined in the browser against `GET /api/queue` — the one
   * view R2c publishes. THREE CHOICES, the same three `/api/inbox` above makes:
   *
   *  1. FETCHED ONLY IN THE UNGROUPED SHAPE. The cues are an ungrouped-view affordance
   *     (STA-188 is explicit, and STA-160's criterion says "ungrouped rows"), so the loader
   *     short-circuits to `null` everywhere else and the grouped views cost nothing and
   *     change not one element.
   *  2. FETCHED UNFILTERED. The queue is an ORDER-AND-ELIGIBILITY ORACLE; membership stays
   *     `applyFilterDimensions`. Narrowing both would let a row survive the filter and then
   *     be missing from the oracle.
   *  3. REFETCHED ON `session.version` — the existing 1.5s fingerprint, so a reorder or a
   *     claim taken by another agent moves the number within a poll rather than on reload.
   *
   * `all: true` because the LIST may be showing resolved work: a done row must be able to
   * say the queue calls it resolved rather than fall through to "unqueued".
   *
   * ONE WORKSPACE AT A TIME. `/api/queue` answers for a single workspace — a plan is a
   * per-workspace sequence and there is no cross-workspace order to ask for — while
   * `/api/issues` in hub mode returns every workspace at once. So the cues are off in hub
   * mode until a workspace is chosen: the alternative is joining one workspace's plan onto
   * another's rows and captioning all of them "unqueued", which is not a partial answer but
   * the wrong one.
   */
  const wantQueue = mode !== "hub" || session.ws !== "";
  const wantCues = groupBy === "none" && wantQueue;
  /*
   * THE FETCH IS WIDER THAN THE CUES, and choice (1) above is now about the CUES only.
   *
   * The row menu (components/QueueRowMenu.tsx) can put a task into the plan from any shape
   * of this list, and to do that it needs two things the plan alone carries: `revision`, the
   * CAS every queue write is checked against, and `entries`, which is what "is this already
   * queued" means. Neither is derivable from a row. So the request is made whenever a
   * workspace is in view — one request per fingerprint change, the bargain `/api/settings`
   * and `/api/milestones` already make — while `wantCues` still gates the JOIN, so a grouped
   * view renders exactly the elements it rendered before.
   */
  const queue = useResource<QueueView | null>(
    () => (wantQueue ? getQueue({ ws: session.ws || undefined, all: true }) : Promise.resolve(null)),
    [wantQueue, session.ws, session.version],
    onAuthError,
  );

  /**
   * THE ROW MENU'S WRITES — the `⋯` slot, wired to the queue.
   *
   * Every one of them is the SAME `POST /api/queue/…` the Queue view sends, carrying the
   * same `baseRevision`. There is no second write path and no optimistic local plan: the
   * answer is a whole `QueueView`, and rather than hold a copy of it here the view simply
   * re-reads — `session.refresh()` bumps the fingerprint every surface on the page polls on,
   * so the row's cue, the queue tab and this menu's own "is it queued" all move together.
   *
   * A refusal is surfaced through the same `describeRefusal` sentence the Queue view uses.
   * It is put in the session's guard channel rather than swallowed: a menu item that appears
   * to do nothing is worse than one that says it was refused.
   */
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueRefusal, setQueueRefusal] = useState<Refusal | null>(null);
  const queueRevision = queue.data?.revision;
  const queueReload = queue.reload;
  const queueWrite = useCallback(
    async (run: (baseRevision: number) => Promise<unknown>) => {
      if (queueRevision === undefined) return;
      setQueueBusy(true);
      try {
        await run(queueRevision);
        /*
         * ONE refetch, not two. `session.refresh()` bumps the fingerprint this resource
         * already lists in its deps, so the read that follows is the same read
         * `queue.reload()` would force — calling both was a second request for one write.
         */
        session.refresh();
      } catch (error) {
        /*
         * A CONFLICT IS NOT A REFUSAL, and saying so is the difference between "somebody
         * else moved the plan, here it is again" and "the server said no". The Queue view
         * makes the same distinction and offers Retry; the tree has no order of its own to
         * retry, so it re-reads and says what happened.
         */
        if (isRevisionConflict(error)) queueReload();
        setQueueRefusal(describeRefusal(error));
      } finally {
        setQueueBusy(false);
      }
    },
    [queueRevision, queueReload, session],
  );

  /**
   * "Is this identifier in the plan", as a SET rather than a scan.
   *
   * `queueRowMenuState` is called once per rendered row and the tree is not virtualised, so
   * the `entries.some(...)` it used to do was O(rows × entries) — 15k string comparisons per
   * render on a 300-row list with a 50-entry plan, every 1.5s poll.
   */
  const queuedIds = useMemo(
    () => new Set((queue.data?.entries ?? []).map((entry) => entry.identifier)),
    [queue.data],
  );

  const rowActionsMenu = useCallback(
    (row: TaskRow, trigger: ReactNode) => {
      const ref = row.issue.identifier;
      const ws = session.ws || undefined;
      return (
        <QueueRowMenu
          trigger={trigger}
          identifier={ref}
          state={queueRowMenuState(row, queuedIds)}
          disabled={queueBusy || queueRevision === undefined}
          onOpen={() => session.open(row.workspace, ref)}
          // `at: 1` is the wire's own "put it in front", not a reorder computed here.
          onQueueNext={() =>
            void queueWrite((baseRevision) => enqueueTask({ ws, ref, at: 1, baseRevision }))
          }
          onQueueLast={() => void queueWrite((baseRevision) => enqueueTask({ ws, ref, baseRevision }))}
          onDequeue={() => void queueWrite((baseRevision) => dequeueTask({ ws, ref, baseRevision }))}
        />
      );
    },
    [queuedIds, queueBusy, queueRevision, queueWrite, session],
  );

  /**
   * Milestone TITLES, from the list App already fetches for the filter menu (`filterContext`).
   * No second request: the marker needs a name for its tooltip and `/api/milestones` is
   * already on the page once per poll.
   */
  const milestoneTitles = useMemo(
    () => new Map(filterContext.milestones.map((milestone) => [milestone.identifier, milestone.title])),
    [filterContext.milestones],
  );

  const cueIndex = useMemo(
    () => (wantCues && queue.data ? buildRowCueIndex(queue.data, milestoneTitles) : EMPTY_ROW_CUE_INDEX),
    [wantCues, queue.data, milestoneTitles],
  );

  /**
   * The join, ONCE, over the UNFILTERED list — before `applyFilterDimensions` rather than
   * after, so the rollup source and the filtered rows carry the same cues and a ghost's real
   * row cannot disagree with the copy of itself drawn in another bucket.
   *
   * `attachRowCues` returns the SAME array when the index is empty, so a grouped view (or a
   * page whose queue has not landed) pays nothing and re-renders nothing.
   */
  const all = useMemo(
    () => attachRowCues(session.issues.data ?? [], cueIndex),
    [session.issues.data, cueIndex],
  );
  /*
   * R4b (STA-187). `applyFilterDimensions` is `applyFilters` plus the three dimensions that
   * need served facts the row does not carry — pickup state, milestone membership, epic. It
   * runs the V4 predicate first and narrows what survived, so nothing V4 argued changes and
   * the two registries never have to know about each other.
   */
  const rows = useMemo(
    () => applyFilterDimensions(all, filters, filterContext),
    [all, filters, filterContext],
  );

  /**
   * Children whose parent a filter removed — V4's seam for V5's breadcrumb chip, and the
   * input to O8's ghosts.
   *
   * Computed from the FULLY filtered `rows`, which is what keeps the ghost rules true for
   * the new dimensions for free: an epic removed by a milestone filter is a parent that is
   * in `all` and not in `rows`, which is the only thing this function and `buildGroups` ever
   * ask about a missing parent.
   */
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
   * The gate captions — Q2 (STA-144).
   *
   * Built from `rows`, the SAME `/api/issues` payload the list is drawn from, and in
   * every grouping mode rather than only in pickup order: a parked epic says "awaiting
   * VP" wherever you meet it. No second fetch — `gate` and `queuedBy` ride on those
   * rows already.
   *
   * Once per fetch rather than once per row per poll, the same bargain
   * `buildPickupIndex` makes one hook up.
   */
  const captions = useMemo(() => buildGateCaptions(rows), [rows]);

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
      {/*
        A queue write refused from the row menu. It renders HERE rather than over the row,
        because the refusal is about the plan rather than about the task, and the row it came
        from may have been filtered away by the time the answer lands.
      */}
      {queueRefusal ? (
        <div className="px-4 pt-3">
          <GuardRefusal refusal={queueRefusal} onDismiss={() => setQueueRefusal(null)} />
        </div>
      ) : null}
      <ViewState resource={session.issues} empty="no open issues">
        {(loaded) => {
          if (loaded.length === 0) return <EmptyState>no issues yet</EmptyState>;
          /*
           * R4b (STA-187). The standard empty state, plus a sentence naming the dimensions
           * responsible — including the combinations that cannot match anything at all. See
           * components/filters/FilterEmptyState.tsx.
           */
          if (rows.length === 0) {
            return <FilterEmptyState rows={all} state={filters} context={filterContext} />;
          }
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
              /*
               * R4a (STA-186). The active sort for THIS workspace and view, resolved by App
               * from `staple:view:v1`. It reaches the model as `BuildOptions.sort` and does
               * nothing else — it cannot reach the queue, the inbox, or a write. See
               * `lib/sort-modes.ts` and docs/queue.md's "Presentation sort is not the queue".
               */
              sort={sort}
              pickup={pickup}
              captions={captions}
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
              /*
               * R4c (STA-188). The milestone marker's destination — the Milestones view,
               * with that milestone focused. The routing is the session's, the same one the
               * header tabs and the palette's "Go to …" commands use; the row knows only
               * that it has somewhere to send a click.
               */
              onOpenMilestone={session.focusMilestone}
              /*
               * The `⋯` menu, built per row. Passed as a BUILDER rather than as data so the
               * grid never has to know what a menu is — see `TaskRowLine.actionsMenu`.
               */
              rowActionsMenu={rowActionsMenu}
              onCloseDrawer={session.close}
              onVisibleOrder={publishVisibleOrder}
            />
          );
        }}
      </ViewState>
    </div>
  );
}
