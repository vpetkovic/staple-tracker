/**
 * The limits the server advertises and enforces.
 *
 * The client sizes its batches from `/v1/capabilities`, never from a constant
 * compiled into itself: the ceilings differ by plan, and a client that hardcodes the
 * paid number fails permanently on the free one.
 */

import type { Env, Plan } from "./env.js";

/**
 * The supported wire protocol range.
 *
 * `min` stays at 1, and that is the whole reason a bump is affordable: every
 * existing client keeps working unchanged, because `negotiateProtocol` accepts
 * anything in `[min, max]` and a missing header still means `min`. Nothing is
 * retired here — the contract's promise is *"the current version and the one before
 * it for at least one release cycle"*, and this is that cycle.
 *
 * ## Why 2 exists, when the change is "only" two new entity kinds
 *
 * Because the contract's claim that new entity kinds are additive within a version
 * is false against the client that exists. `src/core/cloud/apply.ts` throws on an
 * entity it does not know and the pull loop defers only `ReferentMissing`, so an
 * older device handed a `registration` operation fails the page and stops
 * converging — with a message about an unknown entity, which reads as corruption
 * rather than as "upgrade". See `envelope.ts` for the full reasoning and
 * `docs/sync.md`, "Protocol evolution", which has been corrected to match.
 *
 * What the bump buys is one specific thing: a protocol-1 client cannot PUSH a
 * registry entity and cannot be HANDED one either — `pull.ts` and `snapshot.ts`
 * refuse the page with 426 and the supported range rather than serving something
 * the client will throw on. The failure moves from the applying device's fold, deep
 * inside a transaction, to the request boundary, with the remedy in the response.
 *
 * The client does NOT raise its floor to match. `CLIENT_PROTOCOL` stays 1 for
 * workspace traffic and only the hub registry leg declares 2, because a client that
 * sent 2 for everything would be refused outright by any Worker not yet redeployed
 * — turning a hub feature into a total sync outage on every repository.
 */
export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 2;

/**
 * The binding constraint on batch size is D1's queries-per-Worker-invocation limit:
 * 1,000 on paid, **50** on free.
 *
 * A push costs, exactly:
 *
 *   1                 authenticate + read the repo row (one joined query)
 *   N + 2             the atomic batch: [0] read the pre-push watermark,
 *                     [1] reserve N slots, [2..N+1] one insert per operation
 *   1                 range-select the newly assigned (op_id, seq) pairs
 *   ---
 *   N + 4             the normal path
 *   + 1               ONLY when at least one operation deduplicated, to look up the
 *                     original seq of each duplicate
 *   ---
 *   N + 5             worst case, which is a full replay of an already-applied batch
 *
 * Free: 25 + 5 = 30, against a ceiling of 50. Paid: 200 + 5 = 205, against 1,000.
 * Both leave real headroom, which matters because the free ceiling is small enough
 * that being approximately right is being wrong.
 */
const PLAN_LIMITS: Record<Plan, { maxBatchSize: number }> = {
  free: { maxBatchSize: 25 },
  paid: { maxBatchSize: 200 },
};

/** 512 KiB. Well under D1's 2 MB maximum row size, with headroom for the envelope. */
export const MAX_OP_BYTES = 512 * 1024;

export const MAX_PULL_LIMIT = 500;
export const DEFAULT_PULL_LIMIT = 200;

/**
 * The whole request body ceiling, checked from `Content-Length` before the body is
 * parsed. Sized as (maxBatchSize x maxOpBytes) plus envelope slack, and NOTHING caps it
 * further — this comment used to say "then capped", which described no code: there is no
 * `Math.min` here, so the free plan's ceiling really is 25 x 512 KiB + 64 KiB ≈ 13.1 MB.
 *
 * The reason that is safe is not a smaller number, it is WHERE the check happens. The
 * free plan allows 10 ms of CPU per request, and a limit enforced after
 * `await request.json()` is enforced too late to help; this one is read off
 * `Content-Length` by `assertBodySize` before anything parses a byte. The real ceiling on
 * work is `maxBatchSize`, which the push path enforces per operation.
 */
export function maxBodyBytes(plan: Plan): number {
  return PLAN_LIMITS[plan].maxBatchSize * MAX_OP_BYTES + 64 * 1024;
}

export function maxBatchSize(plan: Plan): number {
  return PLAN_LIMITS[plan].maxBatchSize;
}

export function planOf(env: Env): Plan {
  return env.PLAN === "paid" ? "paid" : "free";
}

export interface Capabilities {
  protocol: { min: number; max: number };
  maxBatchSize: number;
  maxOpBytes: number;
  maxPullLimit: number;
  defaultPullLimit: number;
  maxSnapshotPageSize: number;
}

export function capabilities(env: Env): Capabilities {
  return {
    protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
    maxBatchSize: maxBatchSize(planOf(env)),
    maxOpBytes: MAX_OP_BYTES,
    maxPullLimit: MAX_PULL_LIMIT,
    defaultPullLimit: DEFAULT_PULL_LIMIT,
    maxSnapshotPageSize: MAX_SNAPSHOT_PAGE,
  };
}

/** Entities returned per snapshot page. Bounded and resumable, like a pull page. */
export const MAX_SNAPSHOT_PAGE = 500;
export const DEFAULT_SNAPSHOT_PAGE = 200;

/**
 * Operations read per fold query while materializing a snapshot. A snapshot request
 * spends `ceil(log / SNAPSHOT_FOLD_PAGE)` queries against the same
 * queries-per-invocation ceiling as everything else, so this is deliberately large:
 * 500 keeps a 10,000-operation repository inside 20 queries.
 */
export const SNAPSHOT_FOLD_PAGE = 500;

/**
 * The ceiling on how much log one snapshot request will fold. Beyond this the
 * response is `unavailable` rather than a truncated snapshot, because a snapshot
 * that silently omits entities hydrates a device into quiet divergence.
 *
 * The free plan's real ceiling is ~50,000 operations per DAY (100,000 rows written,
 * ~2 rows per operation), and this is a two-machine tracker. If a repository ever
 * genuinely exceeds this, the answer is a maintained projection table, not a bigger
 * number here — see worker/README.md.
 */
export const MAX_SNAPSHOT_FOLD_OPS = 20_000;

/** Default lease TTL, and the ceiling a client may ask for. Server clock only. */
export const DEFAULT_LEASE_TTL_SECONDS = 300;
export const MAX_LEASE_TTL_SECONDS = 3600;
