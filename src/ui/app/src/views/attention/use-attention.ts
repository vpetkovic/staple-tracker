/**
 * The Inbox page's data and writes, apart from how they look: its rows (the root's one
 * `/api/attention` read, lib/attention.ts, narrowed to the page's workspace), which of them
 * are new to this browser, what each row's action does, the order the detail drawer walks,
 * and the two writes a person makes from here (resolve a sync conflict, dismiss a row).
 *
 * The page component renders what this returns and owns nothing else, so the data flow can
 * change without touching the layout and the other way round.
 *
 * NEW ROWS (lib/inbox-seen.ts). Rows this browser had not seen are `fresh` for as long as the
 * page is open, and are marked seen the moment it shows them, so the rail's mark clears while
 * the page still points them out. A row that arrives while the page is open joins them.
 *
 * THE DRAWER WALKS THE INBOX. The page publishes its tickets in row order as the session's
 * visible order, so the drawer's previous and next go down the Inbox; when the open ticket's
 * row leaves (approved, sent back, unblocked), the drawer moves to the next row still listed.
 *
 * A STOPPED RUN IS ONE FACT. Its row here and its "Autopilot stopped" notice
 * (components/autopilot/RunStopNotices.tsx) tell the same thing, so opening the row or
 * dismissing it marks the notice seen too (`rowStopKey`). A dismissal marks it only once the
 * server took it: a refused one leaves both where they were.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { personActor } from "@/detail/parts/person";
import { dismissAttention, resolveCloudConflict } from "@/lib/api";
import { scopeAttention, useAttentionRead } from "@/lib/attention";
import { unseenKeys } from "@/lib/inbox-seen";
import { markInboxSeen, useInboxSeen } from "@/lib/inbox-seen-store";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { markStopsSeen } from "@/lib/stop-seen-store";
import type { AttentionList, AttentionRow } from "@/lib/types";
import type { Resource } from "@/lib/useStaple";
import { afterRowLeft, attentionGo, inboxOrder, rowStopKey } from "./attention-model";

export interface AttentionHandlers {
  act: (row: AttentionRow) => void;
  resolve: (row: AttentionRow, take: "local" | "remote") => void;
  dismiss: (row: AttentionRow) => void;
}

export interface AttentionState {
  /** The rows in the page's scope (every workspace, or the one the page is on). */
  resource: Resource<AttentionList>;
  /** Rows waiting in workspaces the page is not showing; 0 on All workspaces. */
  elsewhere: number;
  /** Keys of the rows that were new to this browser when the page showed them. */
  fresh: ReadonlySet<string>;
  /** The key of the row a write is running for, or null. */
  busy: string | null;
  /** The last write's refusal, in words, until dismissed or the next write. */
  refusal: Refusal | null;
  clearRefusal: () => void;
  handlers: AttentionHandlers;
}

const seenFor = (row: AttentionRow): void => {
  const key = rowStopKey(row);
  if (key) markStopsSeen([key]);
};

export function useAttention(): AttentionState {
  const session = useSession();
  const read = useAttentionRead();
  const scoped = useMemo(() => (read.data ? scopeAttention(read.data, session.ws) : null), [read.data, session.ws]);
  const resource: Resource<AttentionList> = { ...read, data: scoped?.list };
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  // New rows: remembered for this visit, seen as soon as they are shown.
  const seen = useInboxSeen();
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const unseen = useMemo(() => (scoped ? unseenKeys(scoped.list, seen) : []), [scoped, seen]);
  useEffect(() => {
    if (unseen.length === 0) return;
    setFresh((current) => new Set([...current, ...unseen]));
    markInboxSeen(unseen);
  }, [unseen]);

  // The drawer walks the Inbox, and moves on when the open ticket's row leaves it.
  const rows = useMemo(() => scoped?.list.rows ?? [], [scoped]);
  const order = useMemo(() => inboxOrder(rows), [rows]);
  const { publishVisibleOrder, selection, open, ws } = session;
  const shown = useRef({ ws, rows });
  useEffect(() => {
    publishVisibleOrder(order);
    // A workspace switch narrows the rows; it is a navigation that closes the drawer, not a row leaving.
    const next = shown.current.ws === ws ? afterRowLeft(shown.current.rows, rows, selection) : null;
    shown.current = { ws, rows };
    if (next) open(next.workspace, next.ref);
    // Only a new order moves the drawer; opening another ticket by hand does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, order, publishVisibleOrder]);
  useEffect(() => () => publishVisibleOrder([]), [publishVisibleOrder]);

  const write = async (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    setRefusal(null);
    try {
      await fn();
      after?.();
      session.refresh();
    } catch (error) {
      setRefusal(describeRefusal(error));
    } finally {
      setBusy(null);
    }
  };

  const handlers: AttentionHandlers = {
    act: (row) => {
      const go = attentionGo(row);
      if (go?.to === "issue") session.open(go.workspace, go.ref);
      else if (go?.to === "run") {
        seenFor(row);
        session.openRun(go.runId);
      }
    },
    resolve: (row, take) =>
      void write(row.key, () => resolveCloudConflict({ ws: row.workspace, id: row.conflictId!, take, actor: personActor() })),
    dismiss: (row) =>
      void write(
        row.key,
        () => dismissAttention({ ws: row.workspace, target: row.runId ?? row.ref ?? row.key, actor: personActor() }),
        () => seenFor(row),
      ),
  };

  return { resource, elsewhere: scoped?.elsewhere ?? 0, fresh, busy, refusal, clearRefusal: () => setRefusal(null), handlers };
}
