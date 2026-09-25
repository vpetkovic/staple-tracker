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
 * with the origin's instant and a `deviceId` in the payload. An operation from a build before
 * this one carries none, and the event is derived from the change itself: `issue_created`
 * from a create, `status_changed` from a status that moved (dated at the row's `updatedAt`),
 * `blockers_changed` from a blocker set.
 *
 * A pulled delete removes the deleted issue's edges by cascade, which the origin narrated
 * nowhere: each dependent that lost a blocker gets a `blockers_changed` here, dated at the
 * delete's own time, on every device alike.
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

/** What the apply is about to change, read before it: the only way to tell what moved. */
export interface BeforeApply {
  readonly status: string | null;
  readonly exists: boolean;
  /** Issues this one blocks, for a delete that takes the edges with it. */
  readonly dependents: readonly string[];
}

const STATUS_MOVING = new Set(["issue_created", "status_changed", "checkout", "claim_stolen", "release", "claim_released_stale"]);

/** Read what an issue or relation operation may change, before it is applied. */
export function beforeApply(db: DatabaseSync, op: Pick<RemoteOperation, "entity" | "entityId">): BeforeApply | null {
  if (op.entity !== "issue" && op.entity !== "relation") return null;
  const row = db.prepare("SELECT status FROM issues WHERE id = ?").get(op.entityId) as { status: string } | undefined;
  const dependents =
    op.entity === "issue"
      ? (db.prepare("SELECT blocked_id FROM relations WHERE blocker_id = ? AND type = 'blocks'").all(op.entityId) as Array<{ blocked_id: string }>).map(
          (edge) => edge.blocked_id,
        )
      : [];
  return { status: row?.status ?? null, exists: row !== undefined, dependents };
}

interface Carried {
  readonly kind: string;
  readonly at: string;
  readonly actor: string | null;
  readonly payload: Record<string, unknown>;
}

function carriedEvents(payload: Record<string, unknown>): Carried[] | null {
  const raw = payload.originEvents;
  if (!Array.isArray(raw)) return null;
  const out: Carried[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const event = entry as Record<string, unknown>;
    if (typeof event.kind !== "string" || typeof event.at !== "string") continue;
    const body = event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload) ? (event.payload as Record<string, unknown>) : {};
    out.push({ kind: event.kind, at: event.at, actor: typeof event.actor === "string" ? event.actor : null, payload: body });
  }
  return out;
}

function blockerSetOf(db: DatabaseSync, blockedId: string): { blockedBy: string[]; blockedByIds: string[] } {
  const set = db
    .prepare(
      `SELECT i.id AS id, i.identifier AS identifier FROM relations r JOIN issues i ON i.id = r.blocker_id
        WHERE r.blocked_id = ? AND r.type = 'blocks' ORDER BY r.created_at, i.identifier`,
    )
    .all(blockedId) as Array<{ id: string; identifier: string }>;
  return { blockedBy: set.map((row) => row.identifier), blockedByIds: set.map((row) => row.id) };
}

function identifierOf(db: DatabaseSync, issueId: string): string | null {
  return (db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string } | undefined)?.identifier ?? null;
}

/**
 * Write the events an applied operation narrates. Inside the apply's transaction and its
 * suppressed journal scope; `localDeviceId` is this device, whose own operations are skipped.
 */
export function reemitEvents(db: DatabaseSync, op: RemoteOperation, before: BeforeApply | null, localDeviceId: string): void {
  if (before === null) return;
  const payload = op.payload ?? {};

  if (op.entity === "issue" && op.verb === "delete") {
    // The cascade: every device derives the same events from the same delete, its own included.
    for (const dependent of before.dependents) {
      if (identifierOf(db, dependent) === null) continue;
      insertEvent(db, {
        kind: "blockers_changed",
        issueId: dependent,
        actor: op.actor,
        payload: { identifier: identifierOf(db, dependent), ...blockerSetOf(db, dependent), removedBlockerIds: [op.entityId], deviceId: op.deviceId },
        createdAt: op.createdAt,
      });
    }
    return;
  }
  if (op.deviceId === localDeviceId) return;
  const row = db.prepare("SELECT status, identifier, title FROM issues WHERE id = ?").get(op.entityId) as
    | { status: string; identifier: string; title: string }
    | undefined;
  if (!row) return;
  /**
   * A status a conflict withheld did not land here, so neither did the transition its events
   * narrate: the replay would otherwise walk a path the row never took.
   */
  const statusWithheld = op.entity === "issue" && typeof payload.status === "string" && row.status !== payload.status;

  // A create sent again (a lost answer, a restore) narrates a birth this device already holds.
  const born = db.prepare("SELECT 1 FROM events WHERE issue_id = ? AND kind = 'issue_created' LIMIT 1").get(op.entityId) !== undefined;
  const carried = carriedEvents(payload);
  if (carried !== null) {
    for (const event of carried) {
      if (STATUS_MOVING.has(event.kind) && statusWithheld) continue;
      if (event.kind === "issue_created" && born) continue;
      insertEvent(db, {
        kind: event.kind,
        issueId: op.entityId,
        actor: event.actor,
        payload: { ...event.payload, deviceId: op.deviceId },
        createdAt: event.at,
      });
    }
    return;
  }

  // An operation that carries no events: derived from the change itself.
  const at = typeof payload.updatedAt === "string" ? payload.updatedAt : typeof payload.updated_at === "string" ? payload.updated_at : op.createdAt;
  if (op.entity === "relation") {
    if (!Array.isArray(payload.blockedBy)) return;
    insertEvent(db, {
      kind: "blockers_changed",
      issueId: op.entityId,
      actor: op.actor,
      payload: { identifier: row.identifier, ...blockerSetOf(db, op.entityId), deviceId: op.deviceId },
      createdAt: op.createdAt,
    });
    return;
  }
  if (op.verb === "create" && !before.exists && !born) {
    const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : typeof payload.created_at === "string" ? payload.created_at : op.createdAt;
    const bornIn = typeof payload.status === "string" ? payload.status : row.status;
    insertEvent(db, {
      kind: "issue_created",
      issueId: op.entityId,
      actor: op.actor,
      payload: { identifier: row.identifier, title: row.title, status: bornIn, deviceId: op.deviceId },
      createdAt,
    });
    if (Array.isArray(payload.blockedBy) && payload.blockedBy.length > 0) {
      insertEvent(db, {
        kind: "blockers_changed",
        issueId: op.entityId,
        actor: op.actor,
        payload: { identifier: row.identifier, ...blockerSetOf(db, op.entityId), deviceId: op.deviceId },
        createdAt,
      });
    }
    return;
  }
  if (!statusWithheld && before.exists && before.status !== null && before.status !== row.status) {
    insertEvent(db, {
      kind: "status_changed",
      issueId: op.entityId,
      actor: op.actor,
      payload: {
        identifier: row.identifier,
        from: before.status,
        to: row.status,
        ...(typeof payload.derived === "string" ? { derived: payload.derived } : {}),
        deviceId: op.deviceId,
      },
      createdAt: at,
    });
  }
}
