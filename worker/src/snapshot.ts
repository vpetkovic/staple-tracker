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
import { type FoldedEntity, foldLog, materializedVerb } from "./fold.js";
import { DEFAULT_SNAPSHOT_PAGE, MAX_SNAPSHOT_PAGE } from "./limits.js";
import { log, tokenFingerprint } from "./log.js";

/** One folded entity, as it crosses the wire. */
interface WireEntity {
  entity: string;
  entityId: string;
  /** Count of operations folded into this entity. The client's initial version. */
  version: number;
  /** Server timestamp of the tombstone, or null. A tombstone is data, not an absence. */
  deletedAt: number | null;
  lastSeq: number;
  /**
   * The verb the fold materialised, so a client never has to infer it from the
   * shape of the state. See `toWireEntity`.
   */
  verb: string;
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

  const folded = await foldLog(env, session.repoId, session.epoch, cutoff);

  // `foldLog` already returns entities ordered by entity key, which is the paging order.
  const remaining = folded.entities.filter((e) => entityKey(e.entity, e.entityId) > afterKey);
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
    entities: page.map(toWireEntity),
    nextCursor: hasMore ? encodeCursor(next) : null,
    hasMore,
  });
}

/**
 * The wire form of a folded entity.
 *
 * `{ replaced: … }` is how the fold represents a superseded ordered collection TO
 * ITSELF. It is not a wire shape and it does not leave this function. A client handed
 * it would have to decide whether an entity whose only field is called `replaced` was
 * a `replace`, or was simply an entity with a field of that name — and guessing about
 * that is exactly how the plan arrives as an object with a `replaced` key instead of
 * as a plan.
 *
 * So the verb the fold consumed travels explicitly and the payload is handed over
 * unwrapped, which is precisely what `materializedVerb` does when a RESTORE turns a
 * folded entity back into an operation. Both ways out of a fold now go through the
 * same function, so a bootstrap and a restore cannot reach different conclusions
 * about the same log.
 *
 * What the client then applies is byte-identical to the payload of the `replace` it
 * would have received from the ordered tail. That is the property that matters: a
 * collection arrives the same way whichever half of a bootstrap carried it.
 *
 * ONE DIFFERENCE FROM A RESTORE, deliberately. A restore materialises a tombstone as
 * a bare `delete` and drops the state the entity had, because reproducing the corpse
 * would cost two operations for a state nothing reads. A snapshot keeps it: a
 * hydrating device is handed the tombstone AND what the entity looked like, which is
 * what this route has always returned and what its callers already assert.
 */
function toWireEntity(entity: FoldedEntity): WireEntity {
  return {
    entity: entity.entity,
    entityId: entity.entityId,
    version: entity.version,
    deletedAt: entity.deletedAt,
    lastSeq: entity.lastSeq,
    verb: materializedVerb(entity).verb,
    state: unwrapped(entity),
  };
}

/**
 * The payload a `replace` carried, or the merged state for everything else.
 *
 * A `replace` whose payload was not an object cannot be unwrapped into one, and
 * becomes an empty state rather than a lie about what the operation said.
 * `worker/src/envelope.ts` refuses such an operation at ingest, so this is a floor
 * under a corrupted log rather than a case the wire is expected to carry.
 */
function unwrapped(entity: FoldedEntity): Record<string, unknown> {
  if (!entity.superseded) return entity.state;
  const payload = entity.state.replaced;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {};
  return payload as Record<string, unknown>;
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
