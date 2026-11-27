/**
 * The Return lens as the page mounts it: it owns the lens's data, and hands the page to
 * `ReturnPage`. The shell only says which workspace and period are on screen.
 *
 *   figures     `useRoi(query)`: every figure the page prints is the server's
 *   cost model  `useCostModel(scope)`: what Cost setup and the role pages edit
 *   saving      one `saveCostModel` per edit, writing only the parts the edit changes. The edit
 *               shows at once; the figures follow when the server has priced it (the save
 *               refreshes every Analytics read on the page).
 */
import { useCallback, useRef, useState } from "react";
import type { AnalyticsQuery, CostModelResponse, CostModelValue, CostModelWrite } from "@/lib/analytics-api";
import { ApiError, type AuthError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { saveCostModel, useCostModel, useRoi } from "@/lib/use-analytics";
import { refusalSentence, withHome, type CostEdit } from "./cost-edits";
import type { PeriodAsk } from "./period";
import type { CostApi, SaveStatus } from "./return-parts";
import { ReturnPage } from "./ReturnPage";

export function ReturnLens({ workspace, query, onAuthError, onOpenTicket }: {
  /** "" is every workspace on this computer. */
  workspace: string;
  period: PeriodAsk;
  /** The same period and workspace as the query the real routes take. */
  query: AnalyticsQuery;
  onAuthError: (error: AuthError) => void;
  onOpenTicket: (workspace: string, ref: string) => void;
}) {
  const scope = query.scope ?? (workspace || "hub");
  const roi = useRoi(query, onAuthError);
  const stored = useCostModel(scope, onAuthError);
  const cost = useCostEditor(stored.data ?? roi.data?.model, scope, useSession().workspaces);
  const retry = useCallback(() => {
    roi.reload();
    stored.reload();
  }, [roi.reload, stored.reload]);
  return <ReturnPage roi={roi.data} cost={cost} error={roi.error ?? (roi.data ? undefined : stored.error)} onRetry={retry} query={query} onAuthError={onAuthError} onOpenTicket={onOpenTicket} />;
}

/**
 * The cost model on screen, and saving it. An edit shows at once (`draft`); its save's answer
 * stands until the next read of the model, so nothing flickers back while the reads catch up. A
 * refused save drops the draft, so the page shows what is saved, and says why at the field.
 */
export function useCostEditor(read: CostModelResponse | undefined, scope: string, workspaces: CostApi["workspaces"]): CostApi | null {
  const [draft, setDraft] = useState<CostModelValue | null>(null);
  const [answer, setAnswer] = useState<{ response: CostModelResponse; over: CostModelResponse | undefined } | null>(null);
  const [save, setSave] = useState<SaveStatus>({ state: "idle" });
  const response = answer && answer.over === read ? answer.response : read;
  // The latest values for `apply`, which stays one function across renders.
  const now = useRef({ read, response });
  now.current = { read, response };
  const latest = useRef(0);
  const inFlight = useRef(0);
  /** A refusal among saves sent in one burst: a later success does not hide it. */
  const refused = useRef<SaveStatus | null>(null);

  const apply = useCallback(
    (change: CostEdit | CostModelWrite | null) => {
      const current = now.current.response;
      if (change === null || current === undefined) return;
      const edit = "next" in change && "write" in change ? (change as CostEdit) : null;
      const write = withHome(edit ? edit.write : (change as CostModelWrite), current.home);
      const field = edit?.field ?? "model";
      const sequence = ++latest.current;
      if (inFlight.current === 0) refused.current = null;
      inFlight.current += 1;
      if (edit) setDraft(edit.next);
      setSave({ state: "saving" });
      saveCostModel(write, scope)
        .then(
          (saved) => {
            if (sequence !== latest.current) return;
            setAnswer({ response: saved, over: now.current.read });
            setDraft(null);
            setSave(refused.current ?? { state: "saved" });
          },
          (error: unknown) => {
            const reason = error instanceof ApiError && (error.code === "conflict" || error.code === "validation") ? error.code : "other";
            const message = error instanceof Error ? error.message : String(error);
            refused.current = { state: "failed", reason, message: reason === "validation" ? refusalSentence(message) : message, field };
            if (sequence !== latest.current) return;
            setDraft(null);
            setSave(refused.current);
          },
        )
        .finally(() => {
          inFlight.current -= 1;
        });
    },
    [scope],
  );
  if (response === undefined) return null;
  return {
    model: draft ?? response.model,
    response,
    save,
    apply,
    problem: (field) => (save.state === "failed" && save.reason === "validation" && save.field === field ? save.message : undefined),
    workspaces,
  };
}
