/**
 * The property grid's model — which facts about an issue the new detail shows, in
 * what order, and how each one reads.
 *
 * WHY A PURE FUNCTION AND NOT JSX. ClickUp's property block is the strongest thing
 * about its task view and the easiest to get wrong: it is a list of rows, so every
 * engineer who needs one more fact adds one more row, in whatever order they happen
 * to be thinking in, until the block is a bag of fields nobody reads. Computing the
 * row set here means the ordering is one array literal you can see all of, the
 * conditional rows have their conditions in one place, and the whole thing is
 * testable without a DOM.
 *
 * TWO RULES THE ROW SET FOLLOWS.
 *
 *   A SPINE THAT DOES NOT MOVE. Assignee, Created and Updated are rows on every
 *   issue, populated or not. A grid whose shape changes per ticket cannot be
 *   scanned — you re-read it every time instead of looking at the place the fact
 *   lives. Everything else appears only when it carries something, because the
 *   opposite failure is just as bad: eleven rows of em-dash is not information.
 *
 *   NO CLOCK ARITHMETIC. Every timestamp renders as the server sent it. This is
 *   lib/claim.ts's rule carried into the grid, for its reasons: a client-derived
 *   "updated 3 minutes ago" keeps counting in a backgrounded tab and against a
 *   store that has moved on, so it is smoother and strictly less true. The one
 *   duration in this file — how long a holder has been silent — is a server
 *   reading, read rather than recomputed.
 *
 * Editable properties are deliberately NOT here. Title, priority and labels are
 * click-to-edit components (InlineProperties.tsx) and status is a verb with its own
 * refusal path (IssueActions.tsx); a pure function can model a fact, but it cannot
 * model a control that can be refused by the store.
 */
import { formatAgo } from "../lib/claim";
import type { IssueDetail, UiMode } from "../lib/types";

export interface DetailFact {
  /** Stable across renders and unique within one grid — it is the React key. */
  id: string;
  label: string;
  /** null means "this row exists and is empty", which the grid draws as a dash. */
  value: string | null;
  /** Identifiers, agent names and stamps are set in mono everywhere else too. */
  mono?: boolean;
  /** The unrounded fact, for a row that is truncated or a value that is a reading. */
  title?: string;
}

/**
 * `2026-09-01 22:44` — the same minute-precision stamp ActivityTab and DocumentsTab
 * already print. Sliced rather than parsed on purpose: `new Date(iso).toLocale…`
 * would silently re-express a UTC instant in the viewer's zone, so two surfaces
 * showing "the same" timestamp would disagree by hours, and the mono column would
 * stop being a column.
 */
export function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 16).replace("T", " ");
}

/** A row, but only if it has something in it. Keeps the builder below flat. */
function when(id: string, label: string, iso: string | null): DetailFact[] {
  const value = formatWhen(iso);
  return value ? [{ id, label, value, mono: true, title: iso ?? undefined }] : [];
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
          mono: true,
          title: detail.claim ? `last activity ${detail.claim.lastActivityAt}` : undefined,
        },
      ]
    : [];

  return [
    { id: "assignee", label: "Assignee", value: issue.assignee ? `@${issue.assignee}` : null, mono: true },
    ...holder,
    // Only in hub mode, where a bare `STA-88` is ambiguous across workspace files.
    // In single-workspace mode it is the one fact on the page that is true of
    // every row on the page, which makes it furniture.
    ...(mode === "hub" ? [{ id: "workspace", label: "Workspace", value: detail.workspace, mono: true }] : []),
    ...(issue.createdBy ? [{ id: "createdBy", label: "Created by", value: issue.createdBy, mono: true }] : []),
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
  ];
}
