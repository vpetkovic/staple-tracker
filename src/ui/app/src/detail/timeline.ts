/**
 * The merge behind the activity timeline — pure, so it can be tested without a DOM.
 *
 * Three sources, and they overlap:
 *
 *   comments    detail.comments        author + authorType + the full body
 *   events      GET /api/events?issue=  status changes, checkouts, blocker wakes, …
 *   revisions   GET /api/revisions      key + revision + change summary + author
 *
 * `comment_added` and `doc_updated` events are lossy duplicates of rows in the other
 * two sources — a 120-character preview instead of a body, no author on the revision —
 * so they are dropped in favour of the richer record. `doc_updated` is still used as a
 * *correlation* key: it is the only thing that knows who wrote a revision through an
 * actor rather than an author field, so its actor fills the gap when the revision row
 * has none.
 *
 * Everything else about an event is rendered from `describeEvent`, which fails soft: an
 * event kind this file has never heard of still gets a row, because a timeline that
 * silently drops what it does not recognise is worse than one that says
 * "some_new_event".
 *
 * The inputs are declared structurally rather than imported from lib/types.
 *
 * This module is pure and is unit-tested from test/, which compiles under the Node
 * tsconfig where the app's `@/*` alias does not exist. Naming only the fields the merge
 * reads keeps the module importable from both compilations, and makes it obvious at a
 * glance how little of a comment or an event this actually needs. IssueComment,
 * StapleEvent and DocumentRevision from lib/types all satisfy these.
 */
export interface TimelineComment {
  id: string;
  author: string;
  authorType: string;
  body: string;
  createdAt: string;
}

export interface TimelineEvent {
  seq: number;
  kind: string;
  actor: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface TimelineRevision {
  key: string;
  revision: number;
  author: string | null;
  changeSummary: string | null;
  createdAt: string;
}

export type TimelineKind = "comment" | "status" | "blocker" | "revision" | "lifecycle";

export interface TimelineEntry {
  /** Stable across refetches, so React keys do not thrash. */
  id: string;
  kind: TimelineKind;
  at: string;
  /** Who did it, as best any source knows. */
  actor: string | null;
  /** One line, already phrased. */
  summary: string;
  /** Longer content, rendered as markdown (comment bodies only, today). */
  body?: string;
  /** Set on comment entries so the UI can distinguish a human from an agent. */
  authorType?: string;
  /** Set on status entries so the rail can borrow --status-task-*. */
  status?: string;
  /** Extra chips: blocker identifiers, document key + revision. */
  chips?: string[];
}

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asIdentifiers = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((item) =>
          typeof item === "string"
            ? item
            : asString((item as Record<string, unknown> | null)?.identifier),
        )
        .filter((item): item is string => item !== null)
    : [];

/**
 * One event -> one row's worth of prose, or null when the event is a lossy duplicate
 * of something a richer source already contributes.
 */
export function describeEvent(
  event: TimelineEvent,
): Pick<TimelineEntry, "kind" | "summary" | "status" | "chips"> | null {
  const payload = event.payload ?? {};
  switch (event.kind) {
    // Dropped: the comment thread and the revision list carry more than these do.
    case "comment_added":
    case "doc_updated":
      return null;

    case "status_changed": {
      const from = asString(payload.from);
      const to = asString(payload.to);
      return {
        kind: "status",
        status: to ?? undefined,
        summary: from && to ? `status ${from} → ${to}` : `status changed${to ? ` to ${to}` : ""}`,
      };
    }

    case "issue_created":
      return { kind: "lifecycle", summary: "issue created" };

    case "checkout":
      return { kind: "lifecycle", summary: "claimed" };

    case "release":
      return { kind: "lifecycle", summary: "released the claim" };

    case "blockers_changed": {
      const blockers = asIdentifiers(payload.blockedBy);
      return {
        kind: "blocker",
        summary: blockers.length === 0 ? "dependencies cleared" : "dependencies set",
        chips: blockers,
      };
    }

    case "blockers_resolved": {
      const blockers = asIdentifiers(payload.blockers);
      return {
        kind: "blocker",
        summary: "every blocker resolved — ready to pick up",
        chips: blockers,
      };
    }

    case "children_complete": {
      const children = asIdentifiers(payload.children);
      return {
        kind: "blocker",
        summary: "every subtask finished",
        chips: children,
      };
    }

    default:
      // Fail soft: an unrecognised kind is still history.
      return { kind: "lifecycle", summary: event.kind.replace(/_/g, " ") };
  }
}

/**
 * Merge the three sources into one chronological thread, oldest first.
 *
 * Oldest-first because the comment composer sits at the bottom of the tab, which
 * already implies the thread reads downward — flipping it just because the event log
 * is a log would put the reply box furthest from the thing being replied to.
 *
 * The tiebreak matters: comments and events written inside one transaction share a
 * timestamp to the second, so ties fall back to a fixed kind order (creation before
 * the things that follow from it) and then to the source's own sequence.
 */
export function buildTimeline(input: {
  comments: readonly TimelineComment[];
  events: readonly TimelineEvent[];
  revisions: readonly TimelineRevision[];
}): TimelineEntry[] {
  // doc_updated is dropped from the thread but is the only place a revision's *actor*
  // is recorded, so keep it as a lookup for revisions whose author column is null.
  const revisionActors = new Map<string, string>();
  for (const event of input.events) {
    if (event.kind !== "doc_updated" || !event.actor) continue;
    const key = asString(event.payload?.key);
    const revision = event.payload?.revision;
    if (key && typeof revision === "number") revisionActors.set(`${key}@${revision}`, event.actor);
  }

  const entries: Array<TimelineEntry & { order: number; seq: number }> = [];

  for (const comment of input.comments) {
    entries.push({
      id: `comment:${comment.id}`,
      kind: "comment",
      at: comment.createdAt,
      actor: comment.author,
      authorType: comment.authorType,
      summary: "commented",
      body: comment.body,
      order: 2,
      seq: 0,
    });
  }

  for (const event of input.events) {
    const described = describeEvent(event);
    if (!described) continue;
    entries.push({
      id: `event:${event.seq}`,
      at: event.createdAt,
      actor: event.actor,
      ...described,
      order: described.kind === "lifecycle" && described.summary === "issue created" ? 0 : 1,
      seq: event.seq,
    });
  }

  for (const revision of input.revisions) {
    const id = `${revision.key}@${revision.revision}`;
    entries.push({
      id: `revision:${id}`,
      kind: "revision",
      at: revision.createdAt,
      actor: revision.author ?? revisionActors.get(id) ?? null,
      summary: revision.changeSummary ?? `wrote ${revision.key}`,
      chips: [`${revision.key} r${revision.revision}`],
      order: 3,
      seq: revision.revision,
    });
  }

  entries.sort(
    (a, b) => a.at.localeCompare(b.at) || a.order - b.order || a.seq - b.seq || a.id.localeCompare(b.id),
  );

  return entries.map(({ order: _order, seq: _seq, ...entry }) => entry);
}
