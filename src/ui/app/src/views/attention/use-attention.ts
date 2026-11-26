/**
 * The Attention page's data and writes, apart from how they look: the rows (`/api/attention`,
 * one workspace or every one, refetched on the page's poll), what each row's action does, and
 * the two writes a person makes from here (resolve a sync conflict, dismiss a row).
 *
 * The page component renders what this returns and owns nothing else, so the data flow can
 * change without touching the layout and the other way round.
 *
 * A STOPPED RUN IS ONE FACT. Its row here and its "Autopilot stopped" notice
 * (components/autopilot/RunStopNotices.tsx) tell the same thing, so opening the row or
 * dismissing it marks the notice seen too (`rowStopKey`). A dismissal marks it only once the
 * server took it: a refused one leaves both where they were.
 */
import { useCallback, useState } from "react";
import { personActor } from "@/detail/parts/person";
import { type AuthError, dismissAttention, getAttention, resolveCloudConflict } from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { markStopsSeen } from "@/lib/stop-seen-store";
import type { AttentionList, AttentionRow } from "@/lib/types";
import { type Resource, useResource } from "@/lib/useStaple";
import { attentionGo, rowStopKey } from "./attention-model";

export interface AttentionHandlers {
  act: (row: AttentionRow) => void;
  resolve: (row: AttentionRow, take: "local" | "remote") => void;
  dismiss: (row: AttentionRow) => void;
}

export interface AttentionState {
  resource: Resource<AttentionList>;
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

export function useAttention(onAuthError: (error: AuthError) => void): AttentionState {
  const session = useSession();
  // Every workspace when the page is on All workspaces; the server answers for the one named otherwise.
  const ws = session.ws || undefined;
  const load = useCallback(() => getAttention({ ws }), [ws]);
  const resource = useResource(load, [ws, session.version], onAuthError);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

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

  return { resource, busy, refusal, clearRefusal: () => setRefusal(null), handlers };
}
