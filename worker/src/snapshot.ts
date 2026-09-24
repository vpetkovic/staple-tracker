/**
 * GET /v1/repos/{repoId}/snapshot?cursor=&limit= — bootstrap.
 *
 * A hydrating device reads a materialized snapshot taken at `seq = C`, then pulls from
 * cursor `C` forward. Writes concurrent with the snapshot land in the tail, so nothing
 * is missed and nothing is applied twice.
 *
 * THE FOLD IS READ FROM THE CHECKPOINT, NOT COMPUTED HERE. This route used to fold the
 * whole log for every page and refused past 20,000 operations; `fold-store.ts` says why
 * that could not scale and what replaced it. What this route does now:
 *
 *   - The FIRST page pins the cutoff at the head, as it always has, and folds the
 *     checkpoint there first. Normally it is within a few hundred operations (every pull
 *     moves it on, `pull.ts`). Straight after this Worker is deployed onto a large log it is
 *     not, and the page answers "still folding", retryably, having folded this request's
 *     budget, until it is.
 *   - A LATER page reads its cutoff from the cursor, as it always has. The checkpoint
 *     serves any cutoff it has passed, so a cursor pinned days ago, or by the Worker
 *     before this one, resumes exactly where it stopped.
 *
 * WHY NOT A PROJECTION MAINTAINED BY PUSH. It would cost a push statements against the
 * free plan's 50 per invocation, and rows written against its 100,000 per day — the
 * budget that already bounds how much this service can accept. The checkpoint is advanced
 * by reads instead, and is derived state that cannot disagree with the log: every row of
 * it is a function of the log alone.
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
import { minProtocolFor } from "./envelope.js";
import { SyncError, json } from "./errors.js";
import { type FieldWrite, type FoldedEntity, materializedVerb } from "./fold.js";
import { type FoldBudget, foldBehind, foldedPage, pinMark, reachFold } from "./fold-store.js";
import {
  DEFAULT_SNAPSHOT_PAGE,
  MAX_SNAPSHOT_PAGE,
  PAGE_BYTES,
  PAGE_WORK,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  planOf,
  requestFoldBudget,
} from "./limits.js";
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
  /**
   * The seq and client time of the `create` this state descends from; null when the log
   * holds none. Both are what a device reading the ordered tail would have had from the
   * create itself: the time is the one a comment or revision without its own `createdAt`
   * is stamped with, and the seq is how two claims on one identifier or slug are settled
   * the way the tail settles them. Additive: an older client ignores both.
   */
  createdSeq: number | null;
  createdAt: string | null;
  /** The actor of that create; what a revision or comment without its own author takes. */
  createdBy: string | null;
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
  const budget: FoldBudget = requestFoldBudget(planOf(env));
  let cutoff: number;
  let afterKey = "";
  if (rawCursor !== null && rawCursor !== "") {
    const cursor = decodeSnapshotCursor(rawCursor);
    assertCursorScope(cursor, session.repoId, session.epoch);
    // The cutoff is pinned in the cursor, so every page of one snapshot folds to the
    // same seq. Re-reading the high-water mark per page would let a concurrent push
    // move the cutoff mid-bootstrap and produce a snapshot that never existed.
    //
    // A cutoff past the high-water mark was never handed out by any Worker — `last_seq`
    // only climbs — and folding towards it would record the fold as having reached
    // operations that do not exist yet.
    if (cursor.c < 0 || cursor.c > session.lastSeq) {
      throw new SyncError("cursor_invalid", "the snapshot cursor names a cutoff past the log");
    }
    cutoff = cursor.c;
    afterKey = cursor.k;
    // Normally a no-op: the first page took the checkpoint at least this far. Not for a
    // cursor an older Worker handed out, which no checkpoint has reached yet.
    await reachFold(env, session.repoId, session.epoch, cutoff, { budget });
  } else {
    /**
     * The head, as it always was — never wherever the checkpoint happens to have got.
     *
     * A cutoff short of the head would be a true snapshot of the log up to it, and the log up
     * to a point is not always whole: a restore stages its entities in the order of their
     * claims, not in the order they name each other, so part of a restored epoch can hold a
     * comment whose issue comes after it, and a device refuses a snapshot that names what it
     * never delivered — then asks again for the same page, at the same cutoff, for ever. The
     * head has every entity its log will ever name. So this folds towards the head and refuses,
     * `foldBehind`, changing nothing, until the fold has reached it; a client asks again while
     * `foldedSeq` climbs. The head is then a mark (`pinMark` writes one when a concurrent step
     * carried the checkpoint past it), so no later page folds anything on top of it.
     */
    cutoff = session.lastSeq;
    await reachFold(env, session.repoId, session.epoch, cutoff, { budget });
    await pinMark(env, session.repoId, session.epoch, cutoff);
  }

  /**
   * The page gets what the request's budget has left after folding, up to a page's own. A request
   * that folded nothing always serves at least one entity, however large. One that folded and has no
   * room left for the next entity serves none and answers "still folding" at the fold's progress,
   * which is the cutoff: asked again, the fold has nothing left to do and the page is served.
   */
  const folded = await foldedPage(env, session.repoId, session.epoch, cutoff, afterKey, limit, PAGE_BYTES, {
    work: Math.min(PAGE_WORK, budget.work ?? PAGE_WORK),
    atLeastOne: budget.folded !== true,
  });
  if (folded.deferred) throw foldBehind(cutoff, cutoff);

  /**
   * Refused over the WHOLE fold, not over the page about to be served.
   *
   * A snapshot is one consistent view delivered across several pages, and a device
   * applies each page as it arrives. Refusing per page would hand out the pages
   * whose entities happen to be admissible and fail on a later one, leaving the
   * device holding a partial hydration of a repository it cannot finish reading —
   * which is exactly the half-bootstrap the cursor's pinned cutoff exists to
   * prevent. Either the whole view is serveable at this protocol or none of it is.
   * `kinds` is every entity kind the fold holds at the cutoff, which the checkpoint
   * records at each mark, so this needs no pass over the entities.
   *
   * Same table and same code as `pull.ts`; see `assertServable` there for why 426
   * rather than filtering or serving.
   */
  for (const kind of folded.kinds) {
    const required = minProtocolFor(kind);
    if (required !== null && required > protocol) {
      throw new SyncError(
        "protocol_unsupported",
        "this repository contains entities that require a newer protocol than this request negotiated",
        {
          min: PROTOCOL_MIN,
          max: PROTOCOL_MAX,
          requiredProtocol: required,
          entity: kind,
        },
      );
    }
  }

  const page = folded.entities;
  const hasMore = folded.hasMore;
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
    createdSeq: entity.createdSeq,
    createdAt: entity.createdAt ?? null,
    createdBy: entity.createdBy ?? null,
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
