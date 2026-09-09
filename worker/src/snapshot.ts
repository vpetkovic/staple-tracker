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
import { type FieldWrite, type FoldedEntity, foldLog, materializedVerb } from "./fold.js";
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
  /**
   * Per-field provenance for the keys somebody SET, keyed as the operation spelled them.
   *
   * A sibling of `state`, never a transformation of it — `state` and `verb` are what
   * STA-259 pinned against the ordered tail, and neither moves. The ABSENT keys are the
   * point: a field carried only by the entity's `create` has no entry, so a hydrating
   * device inherits its defaults without acquiring a claim on them. See `fold.ts`.
   */
  fieldWrites: Record<string, FieldWrite>;
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
 * The state travels as the fold holds it, because since STA-259 the fold holds nothing
 * private: a `replace` merges the keys it carried like every other verb, so there is no
 * `{ replaced: … }` wrapper to strip and no unwrapping step to get wrong. What a client
 * applies for the collection is byte-identical to the payload of the `replace` it would
 * have received from the ordered tail, which is the property that matters — a collection
 * arrives the same way whichever half of a bootstrap carried it — and the milestone's
 * dates come with it instead of being evicted by a `replace` that never mentioned them.
 *
 * The VERB still travels explicitly, and now it has to: with nothing wrapped, a client
 * could not infer it from the shape of the state even if it were willing to guess. It
 * comes from `materializedVerb`, the same function a RESTORE uses, so a bootstrap and a
 * restore cannot reach different conclusions about the same log.
 *
 * ONE DIFFERENCE FROM A RESTORE, deliberately, and it is why `state` is read from the
 * entity rather than from `materializedVerb`'s payload. A restore materialises a
 * tombstone as a bare `delete` and drops the state the entity had, because reproducing
 * the corpse would cost two operations for a state nothing reads. A snapshot keeps it: a
 * hydrating device is handed the tombstone AND what the entity looked like, which is what
 * this route has always returned and what its callers already assert.
 *
 * `fieldWrites` rides alongside and is the only thing STA-263 added. A RESTORE gets the
 * opposite treatment — `forBackup` strips it — because a restore rewrites the timeline
 * the provenance is expressed in, while a bootstrap joins it.
 */
function toWireEntity(entity: FoldedEntity): WireEntity {
  return {
    entity: entity.entity,
    entityId: entity.entityId,
    version: entity.version,
    deletedAt: entity.deletedAt,
    lastSeq: entity.lastSeq,
    verb: materializedVerb(entity).verb,
    state: entity.state,
    fieldWrites: entity.fieldWrites,
  };
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
