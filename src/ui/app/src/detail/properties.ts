/**
 * The raw facts behind "More details": ids, the workspace, who created it, and every
 * timestamp exactly as the server sent it.
 *
 * The readable properties (people as chips, relative dates, priority as icon + word) are
 * PropertyGrid.tsx's job. This list is the other half of that bargain: nothing the old
 * table showed is lost, it has just moved one tap down, for the people and agents who need
 * to type an id or compare two stamps.
 *
 * WHY A PURE FUNCTION AND NOT JSX. A list of rows accretes: every engineer who needs one more
 * fact adds one more row, in whatever order they happen to be thinking in. Computing the row
 * set here keeps the order in one array literal and makes it testable without a DOM.
 *
 *   A SPINE THAT DOES NOT MOVE. Reference, status name, assignee, created and updated are
 *   rows on every issue, populated or not; everything else appears only when it carries
 *   something.
 *
 *   NO CLOCK ARITHMETIC HERE. These are the exact values: every timestamp is the instant the
 *   server sent, in the viewer's local time with its zone, never "ago". The relative reading
 *   ("12 min ago") is the readable list's, with this same exact value in its tooltip. The one duration in this file, how long a
 *   holder has been silent, is a server reading, formatted rather than recomputed.
 *
 * Editable properties are deliberately NOT here: kind, priority, project and labels are
 * click-to-edit components (InlineProperties.tsx) and status is a verb with its own refusal
 * path (IssueActions.tsx). A `DetailFact` has nowhere to put a refusal, so a row rendered
 * from this function would show the OLD value after a refused write with no sentence saying
 * why. `properties.test.ts` pins kind's absence for that reason.
 */
import { formatAgo } from "../lib/claim";
import { formatStamp } from "./parts";
import type { IssueDetail, IssuePriority, UiMode } from "../lib/types";

export interface DetailFact {
  /** Stable across renders and unique within one grid — it is the React key. */
  id: string;
  label: string;
  /** null means "this row exists and is empty", which the grid draws as a dash. */
  value: string | null;
  /** Identifiers and machine names only. People and dates are never set in mono. */
  mono?: boolean;
  /** The unrounded fact, for a row that is truncated or a value that is a reading. */
  title?: string;
}

/**
 * `Sep 2, 2026, 12:14 AM EDT` — the viewer's local time WITH its zone, the same reading the
 * relative dates' tooltips give. The raw ISO value stays on the row as its `title`. (The old
 * UTC slice disagreed by hours with every local date around it and did not say so.)
 */
export function formatWhen(iso: string | null, timeZone?: string): string | null {
  return formatStamp(iso, { timeZone });
}

/** A row, but only if it has something in it. Keeps the builder below flat. */
function when(id: string, label: string, iso: string | null): DetailFact[] {
  const value = formatWhen(iso);
  return value ? [{ id, label, value, title: iso ?? undefined }] : [];
}

export function detailFacts(detail: IssueDetail, mode: UiMode): DetailFact[] {
  const { issue } = detail;

  /**
   * Who is sitting on this, and are they alive. The single most operational fact
   * in an agent tracker, and the reason the row is worth its own branch: the name
   * alone reads identically for an agent typing right now and one a usage limit
   * killed four hours ago. `claim.idleSeconds` is what separates them, and it comes
   * from the server — this only formats it.
   */
  const holder: DetailFact[] = issue.checkoutAgent
    ? [
        {
          id: "holder",
          label: "Held by",
          value: detail.claim
            ? `${detail.claim.heldBy} · silent ${formatAgo(detail.claim.idleSeconds)}`
            : issue.checkoutAgent,
          title: detail.claim ? `last activity ${detail.claim.lastActivityAt}` : undefined,
        },
      ]
    : [];

  return [
    { id: "identifier", label: "Reference", value: issue.identifier, mono: true },
    { id: "status", label: "Status name", value: issue.status, mono: true },
    { id: "assignee", label: "Assignee", value: issue.assignee ? `@${issue.assignee}` : null },
    ...holder,
    // Only in hub mode, where a bare `STA-88` is ambiguous across workspace files.
    // In single-workspace mode it is the one fact on the page that is true of
    // every row on the page, which makes it furniture.
    ...(mode === "hub" ? [{ id: "workspace", label: "Workspace", value: detail.workspace, mono: true }] : []),
    ...(issue.createdBy ? [{ id: "createdBy", label: "Created by", value: issue.createdBy }] : []),
    ...when("created", "Created", issue.createdAt),
    ...when("updated", "Updated", issue.updatedAt),
    ...when("started", "Started", issue.startedAt),
    // Done and cancelled get separate rows rather than one "Closed": they are
    // different endings, and which one a ticket got is exactly the fact a shared
    // row would throw away.
    ...when("completed", "Completed", issue.completedAt),
    ...when("cancelled", "Cancelled", issue.cancelledAt),
    ...(detail.documents.length > 0
      ? [{ id: "documents", label: "Documents", value: String(detail.documents.length) }]
      : []),
    ...(detail.comments.length > 0
      ? [{ id: "comments", label: "Comments", value: String(detail.comments.length) }]
      : []),
    { id: "internalId", label: "Internal id", value: issue.id, mono: true },
  ];
}

/**
 * Priority as a person says it. The wire says `critical`; every human-facing surface says
 * "Urgent" (the task list's PrioritySignal makes the same translation).
 */
export const PRIORITY_WORDS: Record<IssuePriority, string> = {
  critical: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};
