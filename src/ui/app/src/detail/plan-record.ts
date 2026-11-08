/**
 * The plan's side of a detail: which records the drawer draws as plan records, and the one write
 * path its plan editors use.
 *
 * An unpromoted idea has no ticket number (the server sends `identifier: null, draft: true`, and
 * the page addresses it by id), so the drawer never shows `issue.identifier` for it: its header,
 * breadcrumb and tabs come from `planRecord`. Once promoted the same record is an epic, drawn as one, and the Plan tab stays on
 * its strip for the plan actions its state still offers.
 */
import { useCallback, useState } from "react";
import { planWrite } from "@/lib/api";
import type { HorizonData, IdeaData, IdeaDetailData } from "@/lib/plan-types";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import type { IssueDetail } from "@/lib/types";
import { personActor } from "./parts/person";

/** The record's plan detail, promoted or not; null outside the plan. */
export function planRecordOf(detail: IssueDetail): IdeaDetailData | null {
  return detail.planRecord ?? null;
}

/** An idea that has not been promoted: drawn as an idea, never as tracker work. */
export function isIdeaDetail(detail: IssueDetail): boolean {
  const record = planRecordOf(detail);
  return record !== null && !record.idea.promoted;
}

/** A horizon's plan side: the horizon and the records on it; null for any other issue. */
export function horizonPlanOf(detail: IssueDetail): { horizon: HorizonData; ideas: IdeaData[] } | null {
  return detail.horizonPlan ?? null;
}

/**
 * An issue with no ticket number to show: an unpromoted idea, which the server sends with
 * `draft: true` and the page addresses by its id (`getIssue`).
 */
export function hasNoNumber(issue: { id: string; identifier: string; draft?: boolean }): boolean {
  return issue.draft === true || issue.identifier === issue.id;
}

/** What the drawer calls a lifecycle state, in plain words. */
export const STATE_WORDS: Record<string, string> = {
  raw: "Raw",
  exploring: "Exploring",
  shaped: "Shaped",
  started: "Started",
  shipped: "Shipped",
  dropped: "Dropped",
  planned: "Planned",
  active: "Active",
};

export type PlanWrite = (verb: string, body: Record<string, unknown>) => Promise<boolean>;

/**
 * A plan write from the drawer: sent as the person (the page is the person), then the page
 * refreshes. A refusal is kept for the tab to show where the change was asked for.
 */
export function usePlanWrite(workspace: string, refresh: () => void): { write: PlanWrite; refusal: Refusal | null } {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const write = useCallback<PlanWrite>(
    async (verb, body) => {
      setRefusal(null);
      try {
        await planWrite(verb, { ws: workspace, actor: personActor() ?? "ui", ...body });
        refresh();
        return true;
      } catch (error) {
        setRefusal(describeRefusal(error));
        return false;
      }
    },
    [workspace, refresh],
  );
  return { write, refusal };
}
