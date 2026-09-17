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
 * Operations read per query by the single-pass fold (`foldLog` in `fold.ts`), which no route
 * runs any more; kept as the reference the fold checkpoint is proved against.
 */
export const SNAPSHOT_FOLD_PAGE = 500;

/** The most log the single-pass fold (`foldLog`) folds before it refuses. */
export const MAX_SNAPSHOT_FOLD_OPS = 20_000;

/**
 * Operations one fold step reads and folds (`fold-store.ts`). Also the most a snapshot page
 * or a restore turn ever folds on top of a checkpoint mark, because marks are at most one
 * step apart.
 */
export const FOLD_STEP_OPS = 500;

/**
 * Payload bytes one fold step reads, whatever its operation count: the bound on a step's
 * memory and CPU when operations are large (each may be up to {@link MAX_OP_BYTES}). A step
 * always takes its first operation, so one larger than this still moves the fold on.
 */
export const FOLD_STEP_BYTES = 1024 * 1024;

/**
 * Isolate time one fold step may be estimated at, in nanoseconds (`fold-work.ts`): payloads parsed,
 * stored states loaded, and states and packed statements written.
 */
export const FOLD_STEP_WORK = 4_000_000;

/** Reads a step may make for its revision placements beyond the ones it plans. */
export const FOLD_STEP_READS = 4;

/** Numbers a step's placements may step through one at a time (`fold-revisions.ts`). */
export const FOLD_STEP_WALK = 4096;

/** D1's ceiling on a string or a row: the most one operation's payload can ever be. */
export const ROW_BYTES = 2_000_000;

/**
 * The most payload between two checkpoint marks: a step's bytes and the one operation that
 * may take it past them. A read folds at most this on top of a mark.
 */
export const TAIL_BYTES = FOLD_STEP_BYTES + ROW_BYTES;

/**
 * Stored bytes of entities one snapshot page, or one restore turn, carries — at least one
 * entity, however large. A page of 500 entities is 1.6 MB and 6 ms of isolate time on the
 * measured 100,000-operation log, and a repository of large documents would be far more; the
 * page is cut here instead and `hasMore` says so, as it does for the entity limit.
 */
export const PAGE_BYTES = 1024 * 1024;

/** Bytes of packed rows per INSERT statement: under D1's 2 MB ceiling on a bound value. */
export const FOLD_WRITE_BYTES = 900_000;

/**
 * How far the fold may be behind the log before a pull advances it — in seqs, from the fold's
 * newest mark to the high-water mark, which counts a reserved-but-unused slot as well as an
 * operation and so never understates how much there is to fold.
 *
 * Pulls are what keep the checkpoint near the head without a push paying for it: every
 * sync pulls, so the fold never trails the log by much more than this, and a backup or a
 * restore — which fold what is left inside their own request — always have little to do.
 */
export const LAZY_FOLD_BEHIND = 500;

/**
 * The fold's per-request budgets, by plan.
 *
 * `foldBudgetOps` — operations one request may fold. Measured on workerd, a step of 500 costs
 * 2–5 ms of isolate time (7 ms on a cold isolate), so the free plan's 10 ms per request fits
 * one step beside the rest of the request — a 500-entity snapshot page or a 500-operation
 * pull page. The paid plan's 30 s default fits far more than any repository needs, and its
 * 1,000 queries per invocation fit a hundred steps at six queries each.
 *
 * `pullFoldOps` — operations a pull that finds the fold behind may fold, beside its page.
 *
 * `restoreStageEntities` — entities one restore turn writes. A turn writes them with one
 * packed statement per ~900 KB rather than one statement each, so the ceiling is CPU
 * (an operation id, a payload and a row each), not the query count.
 */
const FOLD_PLAN_LIMITS: Record<
  Plan,
  { foldBudgetOps: number; foldBudgetBytes: number; pullFoldOps: number; restoreStageEntities: number }
> = {
  free: {
    foldBudgetOps: FOLD_STEP_OPS,
    foldBudgetBytes: FOLD_STEP_BYTES,
    pullFoldOps: FOLD_STEP_OPS,
    restoreStageEntities: 200,
  },
  paid: {
    foldBudgetOps: 100 * FOLD_STEP_OPS,
    foldBudgetBytes: 64 * FOLD_STEP_BYTES,
    pullFoldOps: 50 * FOLD_STEP_OPS,
    restoreStageEntities: 1000,
  },
};

export function foldBudgetOps(plan: Plan): number {
  return FOLD_PLAN_LIMITS[plan].foldBudgetOps;
}

/** What one request may fold: {@link foldBudgetOps} operations and no more payload than this. */
export function requestFoldBudget(plan: Plan): { remaining: number; bytes: number } {
  return { remaining: FOLD_PLAN_LIMITS[plan].foldBudgetOps, bytes: FOLD_PLAN_LIMITS[plan].foldBudgetBytes };
}

/** Operations a pull that finds the fold behind may fold: one step on free, beside its page. */
export function pullFoldOps(plan: Plan): number {
  return FOLD_PLAN_LIMITS[plan].pullFoldOps;
}

/** What a pull that finds the fold behind may fold, operations and bytes. */
export function pullFoldBudget(plan: Plan): { remaining: number; bytes: number } {
  return { remaining: FOLD_PLAN_LIMITS[plan].pullFoldOps, bytes: FOLD_PLAN_LIMITS[plan].foldBudgetBytes };
}

export function restoreStageEntities(plan: Plan): number {
  return FOLD_PLAN_LIMITS[plan].restoreStageEntities;
}

/** Default lease TTL, and the ceiling a client may ask for. Server clock only. */
export const DEFAULT_LEASE_TTL_SECONDS = 300;
export const MAX_LEASE_TTL_SECONDS = 3600;
