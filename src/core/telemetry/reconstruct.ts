/**
 * History before capture: attempts rebuilt from the events that already exist.
 *
 * Contract: `docs/execution-telemetry.md`, "History before capture". `checkout` opens,
 * `claim_stolen` interrupts and reopens, `release`, `claim_released_stale` and a
 * `status_changed` out of the active category end. A reconstructed attempt says so
 * everywhere it can: `provenance`, `openedBy` and `endDetection` are `reconstructed`, and
 * `harness`, `providerBinding` and `estimateAtStart` are missing with `before_capture_began`.
 *
 * ## On request, and journaled
 *
 * Attempts are repository state, so a reconstruction has to replicate — and a migration
 * writes nowhere near the journal seam. So it is a command (`staple attempt reconstruct`),
 * and each attempt it rebuilds is an ordinary `attempt.create`.
 *
 * ## Idempotent, and bounded by what was captured
 *
 * Only the events of an issue before its first RECORDED attempt are read: from there on the
 * mutations recorded the history themselves. An attempt's id is derived from its issue and
 * the event that opened it, so running it again rebuilds nothing twice, and a copy of the
 * same database derives the same ids. No transitions are written: nothing measured the
 * concurrency then, and the events the transitions would narrate are already in the log.
 *
 * The honest limit, as the contract states it: a crash-recovery re-claim left no event, so a
 * reconstructed history under-counts interruptions and says so.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Journal } from "../journal.js";
import { attemptPayload, insertAttempt, readAttempt, type AttemptRecord } from "./attempt-records.js";

interface EventRow {
  seq: number;
  kind: string;
  actor: string | null;
  payload: string;
  dedup_key: string | null;
  created_at: string;
}

export interface ReconstructReport {
  /** Attempts written by this run. */
  readonly reconstructed: number;
  /** Attempts a previous run already wrote, found again and left alone. */
  readonly alreadyPresent: number;
  /** Issues whose events were read. */
  readonly issues: number;
}

const BEFORE = "before_capture_began";

/** A deterministic id in the UUID shape: the same events always rebuild the same attempt. */
function derivedId(issueId: string, opening: EventRow): string {
  const hex = createHash("sha256")
    .update(`reconstructed\n${issueId}\n${opening.dedup_key ?? `${opening.created_at}\n${opening.actor ?? ""}\n${opening.kind}`}`, "utf8")
    .digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function payloadOf(row: EventRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The outcome of leaving `active` for a category, as a recorded end would have it. */
function leaving(category: string | null): { outcome: string; endReason: string } {
  switch (category) {
    case "review":
      return { outcome: "completed", endReason: "review" };
    case "done":
      return { outcome: "completed", endReason: "done" };
    case "blocked":
      return { outcome: "yielded", endReason: "blocked" };
    case "cancelled":
      return { outcome: "yielded", endReason: "cancelled" };
    case "gated":
      return { outcome: "yielded", endReason: "gated" };
    default:
      return { outcome: "yielded", endReason: "returned" };
  }
}

/** Rebuild the attempts the event log implies, for every issue, before capture began. */
export function reconstructAttempts(db: DatabaseSync, journal: Journal, deviceId: string | null): ReconstructReport {
  const categories = new Map(
    (db.prepare("SELECT id, category FROM workspace_statuses").all() as Array<{ id: string; category: string }>).map((row) => [row.id, row.category]),
  );
  const issues = (db.prepare("SELECT DISTINCT issue_id AS id FROM events WHERE issue_id IS NOT NULL ORDER BY issue_id").all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
  let reconstructed = 0;
  let alreadyPresent = 0;
  for (const issueId of issues) {
    const boundary = (
      db.prepare("SELECT MIN(started_at) AS at FROM attempts WHERE issue_id = ? AND provenance <> 'reconstructed'").get(issueId) as { at: string | null }
    ).at;
    const events = db
      .prepare(
        `SELECT seq, kind, actor, payload, dedup_key, created_at FROM events
          WHERE issue_id = ? AND kind IN ('checkout', 'claim_stolen', 'release', 'claim_released_stale', 'status_changed')
            AND (? IS NULL OR created_at < ?)
          ORDER BY seq`,
      )
      .all(issueId, boundary, boundary) as unknown as EventRow[];
    const built: AttemptRecord[] = [];
    let open: { record: AttemptRecord } | null = null;
    const start = (event: EventRow, agent: string, resumes: string | null): void => {
      open = {
        record: {
          id: derivedId(issueId, event),
          issueId,
          agent,
          state: "running",
          outcome: null,
          endReason: null,
          endDetection: null,
          endedBy: null,
          openedBy: "reconstructed",
          resumesAttemptId: resumes,
          startedAt: event.created_at,
          endedAt: null,
          endedAtSource: null,
          deviceId,
          claim: { scope: "local", fencingToken: null },
          harness: null,
          providerBinding: null,
          estimateAtStart: { estimatedSeconds: null, source: "none" },
          idempotencyKey: null,
          provenance: "reconstructed",
          missing: { harness: BEFORE, providerBinding: BEFORE, estimateAtStart: BEFORE },
        },
      };
    };
    const finish = (fields: { outcome: string; endReason: string; endedBy: string | null; endedAt: string; endedAtSource: string }): AttemptRecord | null => {
      const current = open as { record: AttemptRecord } | null;
      if (current === null) return null;
      const ended: AttemptRecord = { ...current.record, state: "ended", endDetection: "reconstructed", ...fields };
      built.push(ended);
      open = null;
      return ended;
    };
    for (const event of events) {
      const payload = payloadOf(event);
      const heldBy = (open as { record: AttemptRecord } | null)?.record.agent ?? null;
      switch (event.kind) {
        case "checkout": {
          if (event.actor === null || heldBy === event.actor) break;
          if (heldBy !== null) finish({ outcome: "interrupted", endReason: "claim_moved", endedBy: event.actor, endedAt: event.created_at, endedAtSource: "mutation" });
          const previous = built[built.length - 1];
          start(event, event.actor, previous?.outcome === "interrupted" ? previous.id : null);
          break;
        }
        case "claim_stolen": {
          const lastActivity = typeof payload.previousLastActivityAt === "string" ? payload.previousLastActivityAt : event.created_at;
          const ended = finish({ outcome: "interrupted", endReason: "claim_stolen", endedBy: event.actor, endedAt: lastActivity, endedAtSource: "last_activity" });
          const previous = ended ?? built[built.length - 1];
          if (event.actor !== null) start(event, event.actor, previous?.outcome === "interrupted" ? previous.id : null);
          break;
        }
        case "claim_released_stale": {
          const lastActivity = typeof payload.previousLastActivityAt === "string" ? payload.previousLastActivityAt : event.created_at;
          finish({ outcome: "interrupted", endReason: "released_stale", endedBy: event.actor, endedAt: lastActivity, endedAtSource: "last_activity" });
          break;
        }
        case "release":
          finish({ outcome: "yielded", endReason: "released", endedBy: event.actor, endedAt: event.created_at, endedAtSource: "mutation" });
          break;
        case "status_changed": {
          const from = typeof payload.from === "string" ? categories.get(payload.from) ?? null : null;
          const to = typeof payload.to === "string" ? categories.get(payload.to) ?? null : null;
          if (from === "active" && to !== "active") finish({ ...leaving(to), endedBy: event.actor, endedAt: event.created_at, endedAtSource: "mutation" });
          break;
        }
        default:
          break;
      }
    }
    const still = open as { record: AttemptRecord } | null;
    if (still !== null) built.push(still.record);
    for (const record of built) {
      if (readAttempt(db, record.id) !== null) {
        alreadyPresent += 1;
        continue;
      }
      insertAttempt(db, record);
      journal.record({ entity: "attempt", entityId: record.id, verb: "create", payload: attemptPayload(record), actor: record.agent });
      reconstructed += 1;
    }
  }
  return { reconstructed, alreadyPresent, issues: issues.length };
}
