/**
 * What the rail's two top rows and the phone's tab bar say, as pure functions of the page's
 * reads: the Inbox badge (`lib/attention.ts` `useInboxBadge`) and the live runs
 * (`lib/runs.ts` `useRuns`). Every fact comes from those reads and `lib/run-text.ts`; this
 * file only decides how the navigation words and marks them, so it is tested without a DOM.
 */
import { liveStateText, type RunTone } from "@/lib/run-text";
import { TAB_VIEWS, VIEWS, isMachineView, type ViewName } from "@/lib/session";
import type { InboxBadge } from "@/lib/attention";
import type { RunEntry } from "@/lib/types";

// ---------------------------------------------------------------- the rail's top rows

/** What the Inbox row shows after its label: the count, a dot for what is new, and the spoken form. */
export function inboxRowMark(badge: InboxBadge): { count: string | null; fresh: boolean; spoken: string } {
  if (badge.waiting === 0) return { count: null, fresh: false, spoken: "" };
  const fresh = badge.unseen > 0;
  return { count: String(badge.waiting), fresh, spoken: `, ${badge.waiting} waiting${fresh ? `, ${badge.unseen} new` : ""}` };
}

/** "2 live" beside Autopilot; nothing while no run is live. */
export function autopilotLiveText(live: number): string | null {
  return live > 0 ? `${live} live` : null;
}

/** How many live runs the rail lists under Autopilot before the rest fold into "n more". */
export const RUN_SUBROW_LIMIT = 4;

export function runSubRows<T>(live: readonly T[], limit: number = RUN_SUBROW_LIMIT): { shown: T[]; more: number } {
  if (live.length <= limit) return { shown: [...live], more: 0 };
  return { shown: live.slice(0, limit), more: live.length - limit };
}

/** The ticket a live run has open, by its identifier now (a renumber moves it), else the one it was taken as. */
function openTicketRef(entry: Pick<RunEntry, "run" | "issues">): string | null {
  const open = [...entry.run.tickets].reverse().find((ticket) => ticket.outcome === null);
  if (!open) return null;
  return entry.issues.find((issue) => issue.issueId === open.issueId)?.identifier ?? open.identifier;
}

/**
 * The words on a sub-row's right: the ticket a working run is on, otherwise its state
 * ("Paused", or why it waits).
 */
export function runSubRowAside(entry: Pick<RunEntry, "run" | "decision" | "issues">): string {
  const state = liveStateText(entry);
  const ref = state.tone === "ok" ? openTicketRef(entry) : null;
  return ref ?? state.text;
}

/** A sub-row's accessible name: the run, its state in words, its ticket, and its workspace on All workspaces. */
export function runSubRowLabel(entry: Pick<RunEntry, "run" | "decision" | "issues" | "title" | "workspace">, showWorkspace: boolean): string {
  const state = liveStateText(entry);
  const ref = state.tone === "ok" ? openTicketRef(entry) : null;
  return [entry.title, state.text, ref, showWorkspace ? entry.workspace : null].filter(Boolean).join(", ");
}

/**
 * Which top row is the page: the Inbox, a live run's own sub-row, or the Autopilot row on
 * the run list and on a run not listed under it (an ended one, or one folded into "n more").
 * Returns the row's `data-nav-item` id, `run:<id>` for a sub-row, or null.
 */
export function currentTopRow(view: ViewName, run: string | null, shownRunIds: readonly string[]): string | null {
  if (view === "attention") return "view:attention";
  if (view !== "autopilot") return null;
  return run !== null && shownRunIds.includes(run) ? `run:${run}` : "view:autopilot";
}

/** The minimal shape of a click a sub-row's link receives. */
export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
}

/**
 * A sub-row is a real link (open in a new tab, copy the address). A plain click navigates in
 * the page instead; a modified or middle click keeps the browser's behaviour.
 */
export function openRunOnPlainClick(event: ClickLike, open: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  open();
}

// ---------------------------------------------------------------- the phone's tab bar

/** The Inbox tab's badge: what waits, "99+" past 99, nothing at 0. */
export function tabBadgeText(waiting: number): string | null {
  if (waiting <= 0) return null;
  return waiting > 99 ? "99+" : String(waiting);
}

export function inboxTabLabel(waiting: number): string {
  return waiting > 0 ? `Inbox, ${waiting} waiting` : "Inbox";
}

/** The Autopilot tab's dot: ok while any live run works, tight when every one waits or is paused. */
export function liveDotTone(live: readonly Pick<RunEntry, "run" | "decision">[]): Extract<RunTone, "ok" | "tight"> | null {
  if (live.length === 0) return null;
  return live.some((entry) => liveStateText(entry).tone === "ok") ? "ok" : "tight";
}

export function autopilotTabLabel(live: number): string {
  if (live === 0) return "Autopilot";
  return `Autopilot, ${live} ${live === 1 ? "run" : "runs"} live`;
}

/** More is the page when the view is not one of the four tabs. */
export function moreIsCurrent(view: ViewName): boolean {
  return !TAB_VIEWS.includes(view);
}

/** What the More sheet lists: every view not on the bar, the machine's under "This computer". */
export function moreSheetViews(planningEnabled: boolean | undefined): { views: ViewName[]; machine: ViewName[] } {
  const rest = VIEWS.filter((view) => !TAB_VIEWS.includes(view) && (view !== "plan" || planningEnabled === true));
  return { views: rest.filter((view) => !isMachineView(view)), machine: rest.filter(isMachineView) };
}
