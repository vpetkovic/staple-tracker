/**
 * The Return lens as the page mounts it: it owns the lens's data, and hands the page to
 * `ReturnPage`. The shell only says which workspace and period are on screen.
 *
 * INTERIM: it still reads the preview stand-in through `proto-api.ts`. The wiring to the real
 * routes (`useRoi`, `useCostModel`, `saveCostModel`, `useRoiTickets` from `lib/use-analytics.ts`)
 * replaces the inside of this file; the props stay.
 */
import { useCallback, useState } from "react";
import type { AnalyticsQuery } from "@/lib/analytics-api";
import type { AuthError } from "@/lib/api";
import { useResource } from "@/lib/useStaple";
import type { PeriodAsk } from "./period";
import { getReturn, saveCostModel, type CostModel } from "./proto-api";
import { ReturnPage } from "./ReturnPage";

export function ReturnLens({ workspace, period, onAuthError, onOpenTicket }: {
  /** "" is every workspace on this computer. */
  workspace: string;
  period: PeriodAsk;
  /** The same period and workspace as the query the real routes take. */
  query: AnalyticsQuery;
  onAuthError: (error: AuthError) => void;
  onOpenTicket: (workspace: string, ref: string) => void;
}) {
  const key = `${period.preset}:${period.from ?? ""}:${period.to ?? ""}`;
  const returns = useResource(useCallback(() => getReturn(workspace, period), [workspace, key]), [workspace, key], onAuthError);
  // The cost model is the person's: an edit shows at once and is saved behind it.
  const [draft, setDraft] = useState<CostModel | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const model = draft ?? returns.data?.model ?? null;
  const reload = returns.reload;
  const change = useCallback(
    (next: CostModel, options: { rematch?: boolean } = {}) => {
      setDraft(next);
      setSaving("saving");
      saveCostModel(next).then(
        () => {
          setSaving("saved");
          // A change to what a role covers moves hours between roles: only the server can redo that.
          if (options.rematch) reload();
        },
        () => setSaving("failed"),
      );
    },
    [reload],
  );
  const data = returns.data;
  const fresh = data !== undefined && data.period.preset === period.preset && (period.preset !== "custom" || (data.period.from === period.from && data.period.to === period.to)) && (workspace === "" ? data.scope.kind === "all" : data.scope.workspaces[0]?.slug === workspace);
  return <ReturnPage returns={fresh ? data : undefined} model={model} error={returns.error} onRetry={returns.reload} onChange={change} saving={saving} onOpenTicket={onOpenTicket} />;
}
