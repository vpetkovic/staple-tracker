/**
 * THE QUEUE PAGE'S DATA AND WRITES — everything the view consumes, and nothing it draws.
 *
 * Two ways to read, one way to write:
 *
 *   `useWorkspaceQueue(workspace)` reads one workspace's plan (`GET /api/queue`), as the page
 *   for one workspace does.
 *
 *   `useHubQueue()` reads every workspace's plan in one request (`GET /api/queues`), one
 *   section each, for All workspaces. Each section then calls `useQueueSection` with its own
 *   slice of that answer.
 *
 * Both end in `useQueueSection`, which owns the writes. A plan is per workspace (its own order,
 * revision and policy), so every write names its workspace and carries that section's base
 * revision, and `busy` is per section: a write in one section disables only that one.
 *
 * ── HOW THE PAGE READS, AND WHY EVERY WRITE ASKS FOR THE SAME READING ──────────────────
 *
 * The read is `all: true` (resolved entries keep their place: the plan is shown whole) and
 * `pickup: true` (the member rung `queue next` applies, so a row the next pick skips because it
 * is another member's says so, and is not counted as ready). A write's answer is drawn until
 * the next read lands, so every write asks for the SAME reading. It did not: the answer came
 * back without the resolved entries, the page dropped them and their Clear control until the
 * re-read, and a second move made in that window sent a plan with an entry missing, which the
 * store refuses.
 *
 * ── A STALE REORDER ───────────────────────────────────────────────────────────────────
 *
 * `revision_conflict` means the store changed nothing, so the server's order is the truth:
 * the section drops what it was showing, re-reads, and reports the conflict with the order it
 * meant (`failure.intended`) so the view can offer Reload and Retry my order.
 *
 * NOTHING ABOUT ORDER OR ELIGIBILITY IS DERIVED HERE. Expansion, the unqueued band and the
 * eligibility ladder are `store.queue().effectiveQueue()`'s.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SelectOption } from "@/components/ui/searchable-select";
import { taskOption, withoutValues } from "@/components/createIssueForm";
import {
  dequeueTask,
  enqueueTask,
  getQueue,
  getQueues,
  isRevisionConflict,
  pruneQueue,
  reorderQueue,
  type AuthError,
} from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import type { EffectiveQueueRow, HubQueues, IssueRow, QueuePolicy, QueueView } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { idsOf, pinnedRef } from "@/lib/write-ref";
import {
  movedOrder,
  nextEligible,
  orderForPosition,
  planRows,
  retryOrder,
  skippedBefore,
  type PlanRow,
} from "./queue-model";
import { knownRows } from "./queue-tree";

/** How the queue page reads a plan, and how every write asks for its answer. See the header. */
export const QUEUE_PAGE_READING = { all: true, pickup: true } as const;

/** What the view shows when a write went wrong, and how it went wrong. */
export interface QueueWriteFailure {
  kind: "conflict" | "refusal";
  refusal: Refusal;
  /** The order the refused write wanted, so a conflict can offer to re-apply it. */
  intended: readonly string[] | null;
}

/** A section's read, wherever it came from: its own request or its slice of the hub's. */
export interface QueueRead {
  data: QueueView | undefined;
  error: Error | undefined;
  reload: () => void;
}

export interface QueueSection {
  workspace: string;
  /**
   * Why there is nothing to show. Only while there is no plan on screen: a re-read that fails
   * after the plan loaded keeps the plan, and the next successful read replaces it. The one
   * exception is the re-read a conflict starts, whose failure leaves no server order to show.
   */
  error: Error | undefined;
  /** The plan as last read or written, or null before the first read. */
  view: QueueView | null;
  policy: QueuePolicy | null;
  /** The plan in plan order, each entry with its whole expansion (no cap: the view pages it). */
  rows: PlanRow[];
  /** What an agent asking now would be handed, or null when nothing is pickable. */
  next: EffectiveQueueRow | null;
  /** Every row ahead of `next` in effective order: what the pick stepped over, and why. */
  skipped: EffectiveQueueRow[];
  /** The whole unqueued band, in effective order (no cap: the view pages it). */
  unqueued: EffectiveQueueRow[];
  /** This workspace's rows from the page's issue list, by identifier. */
  known: ReadonlyMap<string, IssueRow>;
  /** What the add control may offer: this workspace's work not already in the plan. */
  candidates: SelectOption[];
  /** The plan's identifiers, for the row menu (`queueRowMenuState`). */
  queuedIds: ReadonlySet<string>;
  /** One clock per answer, so every row of one render reads the same instant. */
  now: Date;
  /** A write is in flight for this section: its base revision is not safe to build on. */
  busy: boolean;
  /** The plan entry the write in flight is for, or null (a prune, or no write). */
  pending: string | null;
  failure: QueueWriteFailure | null;
  /** The plan position (0-based) of an entry, or -1. */
  indexOf: (identifier: string) => number;
  /** `at` is a 1-based plan position; absent appends. */
  add: (ref: string, at?: number) => void;
  remove: (identifier: string) => void;
  /** Move the entry at plan index `from` to `to` (0-based). */
  move: (from: number, to: number) => void;
  moveToEdge: (identifier: string, edge: "first" | "last") => void;
  prune: () => void;
  reload: () => void;
  /** Re-apply the conflicted order against the plan the reload brought back. */
  retry: () => void;
  dismissFailure: () => void;
}

/** One workspace's queue page: its own read, and its writes. */
export function useWorkspaceQueue(workspace: string, onAuthError: (error: AuthError) => void): QueueSection {
  const session = useSession();
  // Always the workspace the page names — never the server's own first (workspace-scope.ts).
  const ws = workspace || undefined;
  const load = useCallback(() => getQueue({ ws, ...QUEUE_PAGE_READING }), [ws]);
  const read = useResource(load, [ws, session.version], onAuthError);
  return useQueueSection(workspace, read);
}

export interface HubQueue {
  /** Every readable workspace's plan, in hub order. */
  workspaces: HubQueues["workspaces"];
  /** The workspaces whose plan could not be read, and why. */
  failed: HubQueues["failed"];
  /** Only while nothing has loaded: the request itself failed. */
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** Every workspace's plan in one read, for All workspaces. Each section takes `sectionRead`. */
export function useHubQueue(onAuthError: (error: AuthError) => void): HubQueue {
  const session = useSession();
  const load = useCallback(() => getQueues(QUEUE_PAGE_READING), []);
  const read = useResource(load, [session.version], onAuthError);
  return {
    workspaces: read.data?.workspaces ?? [],
    failed: read.data?.failed ?? [],
    error: read.data ? undefined : read.error,
    loading: read.loading,
    reload: read.reload,
  };
}

/**
 * One section's slice of the hub read, as the `QueueRead` `useQueueSection` takes. A workspace
 * the server could not read is in `failed`, not in `workspaces`, and its section carries that
 * message as its error rather than loading forever.
 */
export function sectionRead(hub: HubQueue, slug: string): QueueRead {
  const failed = hub.failed.find((entry) => entry.workspace === slug);
  return {
    data: hub.workspaces.find((section) => section.slug === slug),
    error: hub.error ?? (failed ? new Error(failed.message) : undefined),
    reload: hub.reload,
  };
}

/** The writes and the derived plan for one workspace, over a read the caller owns. */
export function useQueueSection(workspace: string, read: QueueRead): QueueSection {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<QueueWriteFailure | null>(null);
  /** The last write's answer, shown until the next read lands — a writer redraws from its result. */
  const [written, setWritten] = useState<QueueView | null>(null);
  useEffect(() => setWritten(null), [read.data]);

  const ws = workspace || undefined;
  const view = written ?? read.data ?? null;
  const allIssues = session.issues.data;
  // This workspace's rows only: in All workspaces the page's list holds every workspace's.
  const issues = useMemo(
    () => (allIssues ?? []).filter((row) => !workspace || row.workspace === workspace),
    [allIssues, workspace],
  );
  const now = useMemo(() => new Date(), [view]);
  const known = useMemo(() => knownRows(issues), [issues]);
  const rows = useMemo(() => (view ? planRows(view, issues, workspace) : []), [view, issues, workspace]);
  // The member rung is the store's (`pickup`), so the first eligible row IS the next pick.
  const next = useMemo(() => (view ? nextEligible(view.effective) : null), [view]);
  const skipped = useMemo(() => (view ? skippedBefore(view.effective, next) : []), [view, next]);
  const unqueued = useMemo(() => (view ? view.effective.filter((row) => row.unqueued) : []), [view]);
  /**
   * WHAT YOU MAY QUEUE: this workspace's work, minus what is already in the plan. Excluding
   * what is queued is not a policy the store shares — enqueuing twice is a replay it answers
   * with `replayed: true` and no write. Offering it would be offering a no-op.
   */
  const candidates = useMemo<SelectOption[]>(
    () => (view ? withoutValues(issues.map(taskOption), view.entries.map((entry) => entry.identifier)) : []),
    [issues, view],
  );
  const queuedIds = useMemo(() => new Set((view?.entries ?? []).map((entry) => entry.identifier)), [view]);

  const { reload: reread } = read;
  const refresh = session.refresh;
  const write = useCallback(
    async (run: () => Promise<QueueView>, intended: readonly string[] | null, target: string | null) => {
      setBusy(true);
      setPending(target);
      try {
        const answer = await run();
        setWritten(answer);
        setFailure(null);
        refresh();
      } catch (error) {
        const conflict = isRevisionConflict(error);
        // The store changed nothing, so what is on screen is now the OLDER order. Drop it and
        // re-read: the banner's promise is that the list under it is the server's.
        if (conflict) {
          setWritten(null);
          reread();
        }
        setFailure({ kind: conflict ? "conflict" : "refusal", refusal: describeRefusal(error), intended });
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [refresh, reread],
  );

  /** THE ONE ATOMIC PATH. Drag, alt+arrow, alt+Home/End and the menu's moves all land here. */
  const applyOrder = useCallback(
    (order: readonly string[] | null, target: string | null) => {
      if (!view || !order) return;
      // The order the reader made, as the ids of the entries it shows (`lib/write-ref.ts`).
      const ids = idsOf(view.entries.map((entry) => ({ identifier: entry.identifier, id: entry.issueId })), order);
      void write(() => reorderQueue({ ws, order: ids, baseRevision: view.revision, ...QUEUE_PAGE_READING }), order, target);
    },
    [view, ws, write],
  );

  const indexOf = useCallback(
    (identifier: string) => view?.entries.findIndex((entry) => entry.identifier === identifier) ?? -1,
    [view],
  );

  const move = useCallback(
    (from: number, to: number) => applyOrder(view ? movedOrder(view.entries, from, to) : null, view?.entries[from]?.identifier ?? null),
    [applyOrder, view],
  );

  const moveToEdge = useCallback(
    (identifier: string, edge: "first" | "last") =>
      applyOrder(
        view ? orderForPosition(view.entries, indexOf(identifier), edge === "first" ? 1 : view.entries.length) : null,
        identifier,
      ),
    [applyOrder, indexOf, view],
  );

  const remove = useCallback(
    (identifier: string) => {
      if (!view) return;
      const [ref] = idsOf(view.entries.map((entry) => ({ identifier: entry.identifier, id: entry.issueId })), [identifier]);
      void write(() => dequeueTask({ ws, ref: ref!, baseRevision: view.revision, ...QUEUE_PAGE_READING }), null, identifier);
    },
    [view, ws, write],
  );

  /** `at` is the wire's own "put it in front" — not a reorder computed here. */
  const add = useCallback(
    (ref: string, at?: number) => {
      if (!view) return;
      void write(
        () => enqueueTask({ ws, ref: pinnedRef(issues, workspace, ref), at, baseRevision: view.revision, ...QUEUE_PAGE_READING }),
        null,
        ref,
      );
    },
    [issues, view, workspace, ws, write],
  );

  const prune = useCallback(() => {
    if (!view) return;
    void write(() => pruneQueue({ ws, baseRevision: view.revision, ...QUEUE_PAGE_READING }), null, null);
  }, [view, ws, write]);

  const reload = useCallback(() => {
    setFailure(null);
    setWritten(null);
    reread();
  }, [reread]);

  /**
   * The deliberate retry: re-apply the intent against the order the reload brought back.
   * `retryOrder` is what keeps it from undoing the other writer — see queue-model.ts.
   */
  const retry = useCallback(() => {
    if (!view || !failure?.intended) return;
    const order = retryOrder(failure.intended, view.entries);
    if (!order) {
      setFailure(null);
      return;
    }
    applyOrder(order, null);
  }, [applyOrder, failure, view]);

  const dismissFailure = useCallback(() => setFailure(null), []);

  return {
    workspace,
    /*
     * A conflict promises the list under its banner is the server's, so when the re-read it
     * started fails, the older order must not stand in for it: the error shows instead.
     */
    error: view && !(failure?.kind === "conflict" && read.error) ? undefined : read.error,
    view,
    policy: view?.policy ?? null,
    rows,
    next,
    skipped,
    unqueued,
    known,
    candidates,
    queuedIds,
    now,
    busy,
    pending,
    failure,
    indexOf,
    add,
    remove,
    move,
    moveToEdge,
    prune,
    reload,
    retry,
    dismissFailure,
  };
}
