/**
 * The detail panel's tab list.
 *
 * This is the seam between U1 and the three tickets that follow. IssueDetailPanel
 * renders whatever is in this array and knows nothing else about any tab, so adding a
 * tab is one new file under detail/tabs/ plus one entry here — no edit to the panel,
 * no edit to the shell, and no chance of two agents colliding on the same line for
 * different reasons.
 *
 *   U2 → documents  (viewer + revision diff)
 *   U3 → activity   (unified timeline: events + comments + status changes)
 *   U4 → agent      ("what the agent sees" — the MCP context payload)
 *
 * Every tab receives the same props: the loaded detail, and the callbacks it needs to
 * act. If a tab needs more data it fetches it itself with useResource, which enrols it
 * in the fingerprint refresh automatically.
 */
import type { ComponentType } from "react";
import type { AuthError } from "@/lib/api";
import type { IssueDetail } from "@/lib/types";

export interface TabProps {
  detail: IssueDetail;
  /** The workspace slug the detail was loaded from — required on every API call. */
  workspace: string;
  onAuthError: (error: AuthError) => void;
  /** Call after any write so the page reflects it without waiting for the next poll. */
  refresh: () => void;
}

export interface TabDefinition {
  id: string;
  label: string;
  component: ComponentType<TabProps>;
  /** Hide the tab entirely when it has nothing to show (documents on a doc-less issue). */
  available?: (detail: IssueDetail) => boolean;
}

import { OverviewTab } from "./OverviewTab";
import { DocumentsTab } from "./DocumentsTab";
import { ActivityTab } from "./ActivityTab";
import { AgentViewTab } from "./AgentViewTab";
import { AnalyticsTab } from "./AnalyticsTab";

export const TABS: readonly TabDefinition[] = [
  { id: "overview", label: "Overview", component: OverviewTab },
  {
    id: "documents",
    label: "Documents",
    component: DocumentsTab,
    available: (detail) => detail.documents.length > 0,
  },
  { id: "activity", label: "Activity", component: ActivityTab },
  { id: "agent", label: "Agent view", component: AgentViewTab },
  /**
   * STA-82 — estimate vs actual. LAST, after "Agent view", per the epic.
   *
   * Deliberately has NO `available` predicate. It is tempting to hide the tab
   * when nothing is estimated, but that is exactly backwards: an issue with no
   * estimate is the one where the tab has something to tell you ("no estimate
   * recorded — set one with --estimate at plan time"), and a tab that vanishes
   * teaches nobody that the feature exists. Hiding it would also make the tab
   * strip's width jump around as work moves through statuses.
   */
  { id: "analytics", label: "Analytics", component: AnalyticsTab },
];

export function visibleTabs(detail: IssueDetail): TabDefinition[] {
  return TABS.filter((tab) => tab.available?.(detail) ?? true);
}
