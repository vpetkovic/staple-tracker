/**
 * GET /v1/repos/{repoId}/snapshot?cursor=&limit= — bootstrap.
 *
 * A hydrating device reads a materialized snapshot taken at `seq = C`, then pulls from
 * cursor `C` forward. Writes concurrent with the snapshot land in the tail, so nothing
 * is missed and nothing is applied twice.
 *
 * WHY THERE IS NO PROJECTION TABLE. The obvious implementation maintains an
 * `entity_state` table on every push. It is rejected for three reasons, in order of
 * weight:
 *
 *   1. It would cost one more statement per operation, taking a push from N+4 to 2N+4.
 *      The free plan's queries-per-invocation ceiling is 50, so the advertised batch
 *      size of 25 would no longer fit — and that number is in the committed wire
 *      contract.
 *   2. It would roughly double the rows written per operation, against a free-tier
 *      budget of 100,000 rows/day that is ALREADY the binding constraint on how much
 *      this service can accept.
 *   3. It is derived state that can go stale relative to the log it is derived from,
 *      and repairing it is a whole second correctness problem.
 *
 * So the fold happens on read. It is a pure function of the log, which means it cannot
 * disagree with the log, and it writes nothing at all.
 *
 * The cost is that a snapshot request re-folds the log for every page. At this
 * service's design scale — a two-machine tracker whose free-plan ceiling is ~50,000
 * operations per DAY — that is one query per 500 operations against a ceiling of 50
 * queries, and typically a single page. If a repository ever genuinely outgrows it,
 * the answer is a projection table maintained lazily by THIS route (never by push),
 * catching up from a stored `folded_seq`. That is a real design, not a hope; it is not
 * built because nothing here needs it yet.
 */

import type { Session } from "./auth.js";
import {
  assertCursorScope,
  decodeSnapshotCursor,
  encodeCursor,
  entityKey,
  type SnapshotCursor,
} from "./cursor.js";
import type { Env } from "./env.js";
import { SyncError, json } from "./errors.js";
import {
  DEFAULT_SNAPSHOT_PAGE,
  MAX_SNAPSHOT_FOLD_OPS,
  MAX_SNAPSHOT_PAGE,
  SNAPSHOT_FOLD_PAGE,
} from "./limits.js";
import { log, tokenFingerprint } from "./log.js";

interface EntitySnapshot {
  entity: string;
  entityId: string;
  /** Count of operations folded into this entity. The client's initial version. */
  version: number;
  /** Server timestamp of the tombstone, or null. A tombstone is data, not an absence. */
  deletedAt: number | null;
  lastSeq: number;
  state: Record<string, unknown>;
}

export async function snapshot(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  startedAt: number,
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));

  const rawCursor = url.searchParams.get("cursor");
  let cutoff: number;
  let afterKey = "";
  if (rawCursor !== null && rawCursor !== "") {
    const cursor = decodeSnapshotCursor(rawCursor);
    assertCursorScope(cursor, session.repoId, session.epoch);
    // The cutoff is pinned in the cursor, so every page of one snapshot folds to the
    // same seq. Re-reading the high-water mark per page would let a concurrent push
    // move the cutoff mid-bootstrap and produce a snapshot that never existed.
    cutoff = cursor.c;
    afterKey = cursor.k;
  } else {
    cutoff = session.lastSeq;
  }

  const folded = await fold(env, session, cutoff);

  const ordered = [...folded.values()].sort((a, b) =>
    entityKey(a.entity, a.entityId) < entityKey(b.entity, b.entityId) ? -1 : 1,
  );
  const remaining = ordered.filter((e) => entityKey(e.entity, e.entityId) > afterKey);
  const hasMore = remaining.length > limit;
  const page = remaining.slice(0, limit);

  const lastKey =
    page.length > 0 ? entityKey(page[page.length - 1]!.entity, page[page.length - 1]!.entityId) : afterKey;

  const next: SnapshotCursor = {
    v: 1,
    r: session.repoId,
    e: session.epoch,
    c: cutoff,
    k: lastKey,
  };

  log({
    event: "snapshot",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
    epoch: session.epoch,
    entity_count: page.length,
    seq_to: cutoff,
    duration_ms: Date.now() - startedAt,
  });

  return json({
    protocol,
    epoch: session.epoch,
    /** The cutoff, as a seq. */
    cutoffSeq: cutoff,
    /**
     * The cursor the device pulls the ordered tail from once the snapshot is applied.
     * It is a PULL cursor, not a snapshot cursor: the two halves of a bootstrap resume
     * independently and must not be confused for one another.
     */
    tailCursor: encodeCursor({ v: 1, r: session.repoId, e: session.epoch, s: cutoff }),
    entities: page,
    nextCursor: hasMore ? encodeCursor(next) : null,
    hasMore,
  });
}

/**
 * Fold the operation log up to `cutoff` into per-entity state.
 *
 * The fold is mechanical and knows nothing about what an issue is:
 *
 *   create/update/renumber — shallow-merge the payload's fields over the state
 *   replace                — supersede the state wholesale (ordered collections only)
 *   delete                 — record a tombstone; later updates become no-ops
 *
 * That shallow merge is NOT last-write-wins conflict resolution, and the distinction
 * matters. Conflict detection is field-scoped and happens on the applying device,
 * against a LOCAL entity version. A bootstrapping device has no local state to
 * conflict with — that is what bootstrapping means — so folding the log in seq order
 * gives it exactly what replaying the log in seq order would have given it, for less
 * bandwidth. No conflict is being resolved here because none can exist yet.
 *
 * A tombstoned entity's later updates are dropped rather than applied: the tombstone
 * wins regardless of arrival order, which is what makes convergence
 * order-independent. The tombstone itself is returned, not omitted — a device that is
 * handed silence about a deleted entity has no way to distinguish it from one it has
 * simply never heard of.
 */
async function fold(
  env: Env,
  session: Session,
  cutoff: number,
): Promise<Map<string, EntitySnapshot>> {
  const entities = new Map<string, EntitySnapshot>();
  let after = 0;
  let read = 0;

  for (;;) {
    const page = await env.DB.prepare(
      `SELECT seq, entity, entity_id, verb, payload, server_ts
         FROM ops
        WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 AND seq <= ?4
        ORDER BY seq
        LIMIT ?5`,
    )
      .bind(session.repoId, session.epoch, after, cutoff, SNAPSHOT_FOLD_PAGE)
      .all<{
        seq: number;
        entity: string;
        entity_id: string;
        verb: string;
        payload: string;
        server_ts: number;
      }>();

    if (page.results.length === 0) break;

    read += page.results.length;
    if (read > MAX_SNAPSHOT_FOLD_OPS) {
      // A truncated snapshot would hydrate a device into quiet divergence, which is
      // strictly worse than a loud refusal. Retryable, because the honest fix is
      // operational (compaction, or the projection table described above) rather than
      // anything the client did wrong.
      throw new SyncError("unavailable", "operation log is too large to snapshot in one pass", {
        maxSnapshotFoldOps: MAX_SNAPSHOT_FOLD_OPS,
      });
    }

    for (const row of page.results) {
      const key = entityKey(row.entity, row.entity_id);
      let entry = entities.get(key);
      if (!entry) {
        entry = {
          entity: row.entity,
          entityId: row.entity_id,
          version: 0,
          deletedAt: null,
          lastSeq: row.seq,
          state: {},
        };
        entities.set(key, entry);
      }

      entry.version += 1;
      entry.lastSeq = row.seq;

      if (row.verb === "delete") {
        entry.deletedAt = row.server_ts;
        continue;
      }
      // The tombstone wins regardless of arrival order.
      if (entry.deletedAt !== null) continue;

      const payload = JSON.parse(row.payload) as unknown;
      if (row.verb === "replace") {
        // Ordered collections replicate whole. Merging two plans would invent an order
        // neither human asked for, so a replace supersedes rather than merges.
        entry.state = { replaced: payload } as Record<string, unknown>;
      } else if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
        Object.assign(entry.state, payload as Record<string, unknown>);
      }
    }

    after = page.results[page.results.length - 1]!.seq;
    if (page.results.length < SNAPSHOT_FOLD_PAGE) break;
  }

  return entities;
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === "") return DEFAULT_SNAPSHOT_PAGE;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SyncError("validation", "limit must be a positive integer", {
      maxSnapshotPageSize: MAX_SNAPSHOT_PAGE,
    });
  }
  if (limit > MAX_SNAPSHOT_PAGE) {
    throw new SyncError("payload_too_large", "limit exceeds the documented maximum", {
      maxSnapshotPageSize: MAX_SNAPSHOT_PAGE,
      limit,
    });
  }
  return limit;
}
