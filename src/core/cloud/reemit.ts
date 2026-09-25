/**
 * Applying an operation re-emits the local event the original mutation emitted, dated at
 * the ORIGIN's instant (`docs/sync.md`, "Events are re-derived, never transported";
 * `docs/timing-semantics.md`, "Multi-device").
 *
 * The timing replay reads a device's own event log. Before this, a device that pulled an
 * issue's status change wrote no event for it, its replay could not reach the row's status,
 * and `timing` read `approximate` for every issue that device did not change itself. An
 * event written at apply time would not be enough either: dated by the apply, it would put
 * the transition at the moment this device happened to sync.
 *
 * ## What travels, and what is derived here
 *
 * A local mutation notes every status-moving and blocker-set event it writes, and its
 * operation carries them as `originEvents` (`Journal.noteEvent`, `Journal.flush`): the kind,
 * the actor, the payload and the instant. Applying the operation writes the same events here,
 * with the origin's instant, its place in the origin's order (`origin_device`, `origin_seq`)
 * and a `deviceId` in the payload.
 *
 * ## Local rows, never journaled
 *
 * Called inside `Journal.applyRemote`, whose suppressed scope journals nothing (obligation 4),
 * and whose scope derives each event's dedup key from the operation id, so a re-delivered
 * operation re-derives the same keys and writes nothing twice (obligation 6). This device's
 * own operations coming back are skipped: it wrote those events when it made the change.
 */
import type { DatabaseSync } from "node:sqlite";
import { insertEvent } from "../event-log.js";
import type { RemoteOperation } from "./wire.js";

/** What the apply is about to change, read before it: whether the issue existed, and its status. */
export interface BeforeApply {
  readonly status: string | null;
  readonly exists: boolean;
}

const STATUS_MOVING = new Set(["issue_created", "status_changed", "checkout", "claim_stolen", "release", "claim_released_stale"]);

/** Read what an issue or relation operation may change, before it is applied. */
export function beforeApply(db: DatabaseSync, op: Pick<RemoteOperation, "entity" | "entityId">): BeforeApply | null {
  if (op.entity !== "issue" && op.entity !== "relation") return null;
  const row = db.prepare("SELECT status FROM issues WHERE id = ?").get(op.entityId) as { status: string } | undefined;
  return { status: row?.status ?? null, exists: row !== undefined };
}

interface Carried {
  readonly issueId: string;
  readonly kind: string;
  readonly at: string;
  readonly actor: string | null;
  readonly seq: number | null;
  readonly payload: Record<string, unknown>;
}

function carriedEvents(payload: Record<string, unknown>, entityId: string): Carried[] | null {
  const raw = payload.originEvents;
  if (!Array.isArray(raw)) return null;
  const out: Carried[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const event = entry as Record<string, unknown>;
    if (typeof event.kind !== "string" || typeof event.at !== "string") continue;
    const body = event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload) ? (event.payload as Record<string, unknown>) : {};
    out.push({
      issueId: typeof event.issueId === "string" ? event.issueId : entityId,
      kind: event.kind,
      at: event.at,
      actor: typeof event.actor === "string" ? event.actor : null,
      seq: typeof event.seq === "number" ? event.seq : null,
      payload: body,
    });
  }
  return out;
}

const born = (db: DatabaseSync, issueId: string): boolean =>
  db.prepare("SELECT 1 FROM events WHERE issue_id = ? AND kind = 'issue_created' LIMIT 1").get(issueId) !== undefined;

/**
 * Write the events an applied operation narrates. Inside the apply's transaction and its
 * suppressed journal scope; `localDeviceId` is this device, whose own operations are skipped.
 *
 * Every issue and relation operation this build writes says what it narrates, an empty list
 * included — a seed, a heal, a republish, a vocabulary migration and a settlement narrate
 * nothing, and nothing is invented for them here. Only an operation with no `originEvents` at
 * all, from a build before this one, is narrated from itself, and then only a birth whose
 * create was never edited (`createdAt` equal to `updatedAt`), which is the one thing such a
 * create can say for certain: anything else about its history is unknown, and the replay
 * says `replay_unavailable` rather than guess.
 */
export function reemitEvents(db: DatabaseSync, op: RemoteOperation, before: BeforeApply | null, localDeviceId: string): void {
  if (before === null || op.deviceId === localDeviceId || op.verb === "delete") return;
  const payload = op.payload ?? {};
  const row = db.prepare("SELECT status, identifier, title FROM issues WHERE id = ?").get(op.entityId) as
    | { status: string; identifier: string; title: string }
    | undefined;
  if (!row) return;
  /**
   * A status a conflict withheld did not land here, so neither did the transition its events
   * narrate: the replay would otherwise walk a path the row never took. They wait on the
   * conflict record, and are written if it is resolved to that side (`conflicts.ts`).
   */
  const statusWithheld = op.entity === "issue" && typeof payload.status === "string" && row.status !== payload.status;

  const carried = carriedEvents(payload, op.entityId);
  if (carried !== null) {
    for (const event of carried) {
      if (STATUS_MOVING.has(event.kind) && statusWithheld && event.issueId === op.entityId) continue;
      if (event.issueId !== op.entityId && identifierOf(db, event.issueId) === null) continue;
      if (event.kind === "issue_created" && born(db, event.issueId)) continue;
      insertEvent(db, {
        kind: event.kind,
        issueId: event.issueId,
        actor: event.actor,
        payload: { ...event.payload, deviceId: op.deviceId },
        createdAt: event.at,
        originDevice: op.deviceId,
        originSeq: event.seq,
      });
    }
    return;
  }

  // An operation from a build that carried none: a pristine birth, and nothing else.
  const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : typeof payload.created_at === "string" ? payload.created_at : null;
  const updatedAt = typeof payload.updatedAt === "string" ? payload.updatedAt : typeof payload.updated_at === "string" ? payload.updated_at : null;
  if (op.entity !== "issue" || op.verb !== "create" || before.exists || createdAt === null || createdAt !== updatedAt || born(db, op.entityId)) return;
  insertEvent(db, {
    kind: "issue_created",
    issueId: op.entityId,
    actor: op.actor,
    payload: { identifier: row.identifier, title: row.title, status: typeof payload.status === "string" ? payload.status : row.status, deviceId: op.deviceId },
    createdAt,
    originDevice: op.deviceId,
  });
}

function identifierOf(db: DatabaseSync, issueId: string): string | null {
  return (db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string } | undefined)?.identifier ?? null;
}
