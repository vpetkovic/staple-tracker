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
  /** Stable: code, tests and the open-tab event key off it. Never rename. */
  id: string;
  /** What a person reads on the strip: plain words, not engineer words. */
  label: string;
  component: ComponentType<TabProps>;
  /** Hide the tab entirely when it has nothing to show (documents on a doc-less issue). */
  available?: (detail: IssueDetail) => boolean;
}

import { OverviewTab } from "./OverviewTab";
import { DocumentsTab } from "./DocumentsTab";
import { FilesTab } from "./FilesTab";
import { ActivityTab } from "./ActivityTab";
import { AgentViewTab } from "./AgentViewTab";
import { AnalyticsTab } from "./AnalyticsTab";
import { RelationsTab } from "./RelationsTab";

export const TABS: readonly TabDefinition[] = [
  { id: "overview", label: "Details", component: OverviewTab },
  /**
   * O2b (STA-132) — the ticket's place in the plan, on a mini canvas.
   *
   * SECOND, straight after Details, because it answers the question a reader has while
   * still looking at Details: "what is this attached to?". Details lists the relations
   * as rows; this draws them, and the two belong next to each other rather than either
   * side of the activity feed.
   *
   * NO `available` predicate, deliberately, and for the same reason Analytics has none:
   * a ticket with nothing attached to it is a fact worth being able to check, and a tab
   * that vanishes teaches nobody that the feature exists. The tab renders "no relations"
   * rather than an empty canvas, which is the honest version of the same answer.
   */
  { id: "relations", label: "Connections", component: RelationsTab },
  {
    id: "documents",
    label: "Documents",
    component: DocumentsTab,
    available: (detail) => detail.documents.length > 0,
  },
  /**
   * Always on the strip, including when the ticket has no files. An empty list
   * is the answer, and a tab that appears only after the first upload makes the
   * strip jump and hides the place a file would go.
   */
  { id: "files", label: "Files", component: FilesTab },
  { id: "activity", label: "Activity", component: ActivityTab },
  { id: "agent", label: "For agents", component: AgentViewTab },
  /**
   * STA-82 — estimate vs actual. LAST, after "For agents", per the epic.
   *
   * Deliberately has NO `available` predicate. It is tempting to hide the tab
   * when nothing is estimated, but that is exactly backwards: an issue with no
   * estimate is the one where the tab has something to tell you ("no estimate
   * recorded — set one with --estimate at plan time"), and a tab that vanishes
   * teaches nobody that the feature exists. Hiding it would also make the tab
   * strip's width jump around as work moves through statuses.
   */
  { id: "analytics", label: "Time", component: AnalyticsTab },
];

export function visibleTabs(detail: IssueDetail): TabDefinition[] {
  return TABS.filter((tab) => tab.available?.(detail) ?? true);
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE TAB SENDING THE READER TO ANOTHER — W3 (STA-115).
 *
 * The seam above is about tabs that mind their own business, and it was right to be.
 * But the worklog panel on Overview has an honest "Show all" that must land on the
 * Documents tab with the `worklog` key selected, and nothing in `TabProps` can express
 * that: the active tab is `useState` inside IssueDetailPanel, and Radix unmounts an
 * inactive `TabsContent`, so DocumentsTab is not even mounted to be told.
 *
 * A window event, following `lib/shell-events.ts` verbatim — the file that exists
 * because the palette and the create dialog "cannot simply be handed a prop by the
 * header that now needs to open them". Same shape of problem, same ten-line answer,
 * and no new context. The panel keeps owning its tab state; this only asks.
 *
 * The pinned key is a module variable rather than event detail because the two halves
 * happen in different places: the panel receives the event and switches tabs, and
 * DocumentsTab reads the key in its own lazy `useState` initialiser one render later.
 * Passing it through the event would mean the panel carrying a value it has no use for
 * down to a tab it knows nothing about, which is the coupling this seam was built to
 * avoid. It is consumed on read, so it can never re-pin a later visit to the tab.
 */
const OPEN_TAB = "staple:detail-open-tab";

/** The document key a Documents tab should open on, and the issue it is for (null: whichever mounts next). */
let pendingDocument: { ref: string | null; key: string } | null = null;

/**
 * Ask the detail panel to show `tabId`, optionally pinning a document key on arrival. `ref`
 * ties the key to that issue, so a Documents tab of any other issue drops it unread.
 */
export function openDetailTab(tabId: string, documentKey?: string, ref: string | null = null): void {
  pendingDocument = documentKey ? { ref, key: documentKey } : null;
  window.dispatchEvent(new CustomEvent(OPEN_TAB, { detail: tabId }));
}

/** Subscribe the panel that owns the tab state. Returns the unsubscribe, for useEffect. */
export function onOpenDetailTab(handler: (tabId: string) => void): () => void {
  const listener = (event: Event) => {
    const { detail } = event as CustomEvent<string>;
    if (typeof detail === "string") handler(detail);
  };
  window.addEventListener(OPEN_TAB, listener);
  return () => window.removeEventListener(OPEN_TAB, listener);
}

/**
 * The key a tab was asked to open on for issue `ref`, or null. CONSUMES it whichever issue
 * asks: a reader who later returns to Documents on their own should get their own default,
 * not last week's pin, and a pin meant for one issue must never open another's.
 */
export function takePendingDocumentKey(ref: string): string | null {
  const pending = pendingDocument;
  pendingDocument = null;
  return pending !== null && (pending.ref === null || pending.ref === ref) ? pending.key : null;
}

/**
 * A tab to open on ANOTHER issue once its detail mounts: a goal's evidence citing
 * `ABC-12:plan` opens ABC-12 on its Documents tab with `plan` pinned. The event above cannot
 * do it (the new panel is not mounted when the link is pressed), so the request waits here
 * for the next panel to mount, which takes it if it is for that issue and drops it either
 * way. Evidence on the issue already open is not an arrival: `openDetailTab` switches in place.
 */
let arrival: { ref: string; tabId: string } | null = null;

export function openTabOnArrival(ref: string, tabId: string, documentKey?: string): void {
  arrival = { ref, tabId };
  pendingDocument = documentKey ? { ref, key: documentKey } : null;
}

/** The tab asked for this issue, or null; consumed by whichever panel mounts first. */
export function takeArrivalTab(ref: string): string | null {
  const pending = arrival;
  arrival = null;
  if (pending === null) return null;
  if (pending.ref === ref) return pending.tabId;
  // Another issue mounted first: the request and its pinned document go together.
  if (pendingDocument?.ref === pending.ref) pendingDocument = null;
  return null;
}
