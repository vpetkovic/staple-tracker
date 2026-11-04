/**
 * The progress view: how one ticket's current attempt is going, as the `ui://staple/progress`
 * view draws it in an agent's thread, live.
 *
 * `ticketProgress` reads everything the view shows, and both halves of a `show_progress`
 * answer come from it: `structuredContent.progress` for a host that renders the view, and
 * `progressText` for a host that does not. The view refreshes itself by calling
 * `show_progress` again through the host, which is a read, so no host asks a person first.
 *
 * The attempt shown is the open worker attempt, else the newest ended one (the ticket card
 * reads it the same way). Its TIMELINE, oldest first, is:
 *
 *   - its transitions: started, each milestone an agent recorded with `record_attempt_event`
 *     (its label, and the comment or document it points at), paused, resumed, interrupted,
 *     ended;
 *   - the comments posted on the ticket while it ran, except one a milestone already shows.
 *
 * Only the newest {@link TIMELINE_LIMIT} entries are sent; `earlier` counts the rest, so a
 * long attempt never grows the payload a view polls for.
 */
import { formatDuration, stapleUiBase, ticketUrl } from "./mcp-ticket-card.js";
import type { WorkspaceStore } from "./core/store.js";
import { nowIso, type IssueComment } from "./core/types.js";

export type TimelineKind = "started" | "milestone" | "paused" | "resumed" | "interrupted" | "ended" | "comment";

export interface TimelineEntry {
  kind: TimelineKind;
  at: string;
  /** Who recorded it: the attempt's agent, another actor, or a comment's author. */
  actor: string | null;
  /** One line: the milestone's label, the comment's first line, or what happened. */
  text: string;
  /** What a milestone points at (a comment's first line, or `document worklog r3`). */
  detail: string | null;
}

export interface TicketProgress {
  /** The workspace slug, as the web UI's `ws` parameter names it. */
  workspace: string;
  identifier: string;
  title: string;
  status: { id: string; label: string; category: string };
  assignee: string | null;
  /** The open worker attempt, else the newest ended one; null before the first claim. */
  attempt: {
    id: string;
    ordinal: number;
    agent: string;
    state: string;
    current: boolean;
    startedAt: string;
    endedAt: string | null;
    outcome: string | null;
    endReason: string | null;
  } | null;
  /** The attempt's timeline, oldest first: the newest {@link TIMELINE_LIMIT} entries. */
  timeline: TimelineEntry[];
  /** How many older entries were left out of `timeline`. */
  earlier: number;
  milestoneCount: number;
  timing: { estimatedSeconds: number | null; elapsedSeconds: number | null };
  /** The newest thing the attempt recorded: its last activity, or its newest timeline entry. */
  lastActivityAt: string | null;
  /** True while an attempt is open (running or paused): the view keeps refreshing. */
  live: boolean;
  /** How often a view polls `show_progress` while `live`. */
  refreshSeconds: number;
  /** When this was read. */
  asOf: string;
  /** The web UI's deep link to this ticket; null when no UI base is known. */
  url: string | null;
}

/** How many timeline entries a payload carries at most. */
export const TIMELINE_LIMIT = 20;

/** How often a live view reads the progress again. */
export const REFRESH_SECONDS = 5;

/** How many of a ticket's newest comments are read for the timeline. */
const COMMENT_WINDOW = 200;

/** A comment's first non-blank line, cut to a length a timeline row can hold. */
export function firstLine(body: string, max = 160): string {
  const line = body.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const words = (value: string): string => value.replace(/_/g, " ");

/** Everything the progress view shows, for one ticket. */
export function ticketProgress(store: WorkspaceStore, ref: string, uiBase: string | null = stapleUiBase(), now: string = nowIso()): TicketProgress {
  const issue = store.getIssue(ref);
  const status = store.getStatuses().find((candidate) => candidate.id === issue.status);
  const summary = store.attemptSummary(issue.id);
  const shown = summary.current ?? summary.last;
  const { timing } = store.detailTiming(issue.id);

  const entries: TimelineEntry[] = [];
  let lastActivityAt: string | null = null;
  if (shown) {
    const comments = store.latestComments(issue.id, COMMENT_WINDOW);
    const byId = new Map<string, IssueComment>(comments.map((comment) => [comment.id, comment]));
    const pointedAt = new Set<string>();
    let endRecorded = false;
    for (const transition of store.attemptTransitions(shown.id)) {
      const detail = transition.detail as { label?: unknown; commentId?: unknown; document?: { key?: unknown; revision?: unknown } };
      switch (transition.kind) {
        case "attempt_started":
          entries.push({ kind: "started", at: transition.at, actor: transition.actor, text: `Started by ${transition.actor ?? shown.agent}`, detail: null });
          break;
        case "attempt_milestone": {
          let pointer: string | null = null;
          if (typeof detail.commentId === "string") {
            pointedAt.add(detail.commentId);
            const comment = byId.get(detail.commentId);
            pointer = comment ? firstLine(comment.body) : null;
          } else if (detail.document && typeof detail.document.key === "string") {
            pointer = `document ${detail.document.key} r${String(detail.document.revision)}`;
          }
          entries.push({ kind: "milestone", at: transition.at, actor: transition.actor, text: typeof detail.label === "string" ? detail.label : "Milestone", detail: pointer });
          break;
        }
        case "attempt_paused":
          entries.push({ kind: "paused", at: transition.at, actor: transition.actor, text: transition.reason ? `Paused: ${words(transition.reason)}` : "Paused", detail: null });
          break;
        case "attempt_resumed":
          entries.push({ kind: "resumed", at: transition.at, actor: transition.actor, text: transition.reason ? `Resumed: ${transition.reason}` : "Resumed", detail: null });
          break;
        case "attempt_interrupted":
          endRecorded = true;
          entries.push({ kind: "interrupted", at: transition.at, actor: transition.actor, text: transition.reason ? `Interrupted: ${words(transition.reason)}` : "Interrupted", detail: null });
          break;
        case "attempt_ended":
          endRecorded = true;
          entries.push({
            kind: "ended",
            at: transition.at,
            actor: transition.actor,
            text: shown.outcome ? `Ended: ${words(shown.outcome)}` : "Ended",
            detail: transition.reason ? words(transition.reason) : null,
          });
          break;
        default:
          // Bookkeeping (a harness session added, and kinds a later version records) is not progress.
          break;
      }
    }
    // An end the read derives (an orphaned claim) has no transition; the attempt still ended.
    if (!endRecorded && shown.state === "ended" && shown.endedAt) {
      entries.push({ kind: "ended", at: shown.endedAt, actor: shown.endedBy, text: shown.outcome ? `Ended: ${words(shown.outcome)}` : "Ended", detail: shown.endReason ? words(shown.endReason) : null });
    }
    const until = shown.endedAt ?? null;
    for (const comment of comments) {
      if (pointedAt.has(comment.id) || comment.createdAt < shown.startedAt || (until !== null && comment.createdAt > until)) continue;
      entries.push({ kind: "comment", at: comment.createdAt, actor: comment.author, text: firstLine(comment.body), detail: null });
    }
    // Stable: a comment and a transition at the same instant keep the order they were read in.
    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    lastActivityAt = [shown.lastActivityAt, entries[entries.length - 1]?.at].filter((at): at is string => typeof at === "string").sort().pop() ?? null;
  }

  const timeline = entries.slice(-TIMELINE_LIMIT);
  return {
    workspace: store.slug,
    identifier: issue.identifier,
    title: issue.title,
    status: { id: issue.status, label: status?.label ?? issue.status, category: status?.category ?? issue.status },
    assignee: issue.assignee,
    attempt: shown
      ? {
          id: shown.id,
          ordinal: shown.ordinal,
          agent: shown.agent,
          state: shown.state,
          current: summary.current !== null,
          startedAt: shown.startedAt,
          endedAt: shown.endedAt,
          outcome: shown.outcome,
          endReason: shown.endReason,
        }
      : null,
    timeline,
    earlier: entries.length - timeline.length,
    milestoneCount: entries.filter((entry) => entry.kind === "milestone").length,
    timing: {
      estimatedSeconds: timing.subtreePlan?.estimatedSeconds ?? timing.estimatedSeconds,
      elapsedSeconds: timing.activeSeconds,
    },
    lastActivityAt,
    live: summary.current !== null,
    refreshSeconds: REFRESH_SECONDS,
    asOf: now,
    url: uiBase === null ? null : ticketUrl(uiBase, store.slug, issue.identifier),
  };
}

/** `2026-11-04 12:14 UTC`: an instant a reader of plain text can place without a locale. */
function stamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The progress as prose: the whole answer for a host without MCP Apps. Lists the milestones. */
export function progressText(progress: TicketProgress): string {
  const lines = [`${progress.identifier} ${progress.title}`];
  const attempt = progress.attempt;
  lines.push(
    [
      progress.status.label,
      attempt
        ? `${attempt.current ? "attempt" : "last attempt"} #${attempt.ordinal} by ${attempt.agent}: ${words(attempt.state)}${attempt.outcome ? ` (${words(attempt.outcome)})` : ""}, since ${stamp(attempt.startedAt)}`
        : "no attempt yet",
    ].join(" · "),
  );
  const { estimatedSeconds, elapsedSeconds } = progress.timing;
  if (estimatedSeconds !== null || elapsedSeconds) {
    lines.push(
      estimatedSeconds !== null
        ? `Time: ${formatDuration(elapsedSeconds ?? 0)} of ${formatDuration(estimatedSeconds)} estimate.`
        : `Time: ${formatDuration(elapsedSeconds ?? 0)}, no estimate.`,
    );
  }
  if (progress.lastActivityAt) lines.push(`Last activity ${stamp(progress.lastActivityAt)}.`);
  const milestones = progress.timeline.filter((entry) => entry.kind === "milestone");
  if (attempt) {
    if (progress.milestoneCount === 0) {
      lines.push("No milestones recorded yet.");
    } else {
      const left = progress.milestoneCount - milestones.length;
      lines.push(`Milestones (${progress.milestoneCount}${left > 0 ? `, the newest ${milestones.length} shown` : ""}):`);
      for (const entry of milestones) lines.push(`  - ${stamp(entry.at)} ${entry.text}${entry.detail ? ` (${entry.detail})` : ""}`);
    }
  }
  if (progress.url) lines.push(`Open in Staple: ${progress.url}`);
  return lines.join("\n");
}
