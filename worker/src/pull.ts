/**
 * GET /v1/repos/{repoId}/ops?cursor=&limit= — pull a bounded page.
 *
 * Two queries for the page: authenticate, then one index range scan. `PRIMARY KEY (repo_id, seq)`
 * on a `WITHOUT ROWID` table makes the scan read exactly the rows it returns, so the
 * billed rows_read is the page size and not the table size. Then, when the fold checkpoint is
 * behind, a fold step within what the page left of the request's budget (`keepFoldNearHead`).
 */

import type { Session } from "./auth.js";
import {
  assertCursorScope,
  decodePullCursor,
  encodeCursor,
  type PullCursor,
} from "./cursor.js";
import type { Env } from "./env.js";
import { minProtocolFor } from "./envelope.js";
import { SyncError, json } from "./errors.js";
import { advanceFold, foldProgress } from "./fold-store.js";
import { ENTITY_NS, PARSE_NS_PER_BYTE, PARSE_NS_PER_ESCAPE, serveWork } from "./fold-work.js";
import {
  DEFAULT_PULL_LIMIT,
  LAZY_FOLD_BEHIND,
  MAX_PULL_LIMIT,
  PAGE_WORK,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  planOf,
  remainingFoldBudget,
} from "./limits.js";
import { errorKind, log, tokenFingerprint } from "./log.js";

interface OpRow {
  seq: number;
  epoch: number;
  op_id: string;
  device_id: string;
  entity: string;
  entity_id: string;
  verb: string;
  base_version: number | null;
  payload: string;
  actor: string;
  client_seq: number;
  schema_version: number;
  created_at: string;
  server_ts: number;
}

export async function pull(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  startedAt: number,
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));

  // No cursor means "from the beginning of this epoch". `seq` starts above 0, so an
  // exclusive lower bound of 0 is the whole log and needs no special case.
  const rawCursor = url.searchParams.get("cursor");
  let after = 0;
  if (rawCursor !== null && rawCursor !== "") {
    const cursor = decodePullCursor(rawCursor);
    // Repository first, then epoch. A cursor from a superseded epoch is
    // `epoch_changed` and is never silently reset to the beginning: a silent reset
    // replays the entire history into a live database.
    assertCursorScope(cursor, session.repoId, session.epoch);
    after = cursor.s;
  }

  /**
   * `hasMore` by fetching limit + 1 and trimming. Never a COUNT(*), which scans the
   * whole range to answer a question the extra row already answers.
   *
   * And no more than {@link PAGE_WORK} of estimated isolate time to parse and send
   * (`serveWork`, `fold-work.ts`) — always the first operation, however large. SQLite
   * measures each row and sums them, and a row past the budget comes back without its
   * payload, so a page of escape-heavy operations is cut before the isolate reads it; the
   * page is then shorter than its limit and says `hasMore`, which every client already
   * follows.
   */
  const page = await env.DB.prepare(
    `SELECT seq, epoch, op_id, device_id, entity, entity_id, verb, base_version,
            CASE WHEN n = 1 OR spent <= ?5 THEN payload END AS payload,
            actor, client_seq, schema_version, created_at, server_ts, bytes, escapes
       FROM (SELECT *, SUM(${ENTITY_NS} + ${2 * PARSE_NS_PER_BYTE} * bytes + ${2 * PARSE_NS_PER_ESCAPE} * escapes)
                         OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING) AS spent,
                       ROW_NUMBER() OVER (ORDER BY seq) AS n
               FROM (SELECT seq, epoch, op_id, device_id, entity, entity_id, verb, base_version,
                            payload, actor, client_seq, schema_version, created_at, server_ts,
                            length(CAST(payload AS BLOB)) AS bytes,
                            length(payload) - length(replace(replace(payload, '\\', ''), '"', '')) AS escapes
                       FROM ops
                      WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3
                      ORDER BY seq
                      LIMIT ?4))
      ORDER BY seq`,
  )
    .bind(session.repoId, session.epoch, after, limit + 1, PAGE_WORK)
    .all<Omit<OpRow, "payload"> & { payload: string | null; bytes: number; escapes: number }>();

  const cut = page.results.findIndex((row) => row.payload === null);
  const within = (cut >= 0 ? page.results.slice(0, cut) : page.results) as Array<OpRow & { bytes: number; escapes: number }>;
  const hasMore = page.results.length > limit || cut >= 0;
  const rows = within.slice(0, limit);

  assertServable(rows, protocol);

  // The cursor advances to the last seq RETURNED, not to the high-water mark. Gaps
  // between them are legal — a slot reserved for a deduplicated operation goes unused
  // — and `WHERE seq > cursor` is gap-tolerant by construction.
  const lastSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : after;
  const next: PullCursor = { v: 1, r: session.repoId, e: session.epoch, s: lastSeq };

  // What the page costs to parse and put on the wire, so the fold beside it never takes the request past its budget.
  const spent = rows.reduce((sum, row) => sum + serveWork(row.bytes, row.escapes), 0);
  await keepFoldNearHead(env, session, spent);

  log({
    event: "pull",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
    epoch: session.epoch,
    op_count: rows.length,
    seq_from: after,
    seq_to: lastSeq,
    duration_ms: Date.now() - startedAt,
  });

  return json({
    protocol,
    epoch: session.epoch,
    serverHighWatermark: session.lastSeq,
    ops: rows.map((row) => toEnvelope(row, protocol)),
    nextCursor: encodeCursor(next),
    hasMore,
  });
}

/**
 * Move the fold checkpoint on when it has fallen behind the log (`fold-store.ts`), by what the
 * request's budget has left beside its page (`spent`) and never more: the step is cut to fit, and
 * a step that fits nothing folds nothing (`pullFoldBudget`).
 *
 * Here because every sync pulls: a device that pushed pulls straight after, so the
 * checkpoint trails the log by little more than {@link LAZY_FOLD_BEHIND} operations, and a
 * backup or restore — which finish the fold inside their own request — find almost nothing
 * left to do. Below the threshold it costs one indexed read. A pull never fails because of
 * it: the pull's answer is already decided, a failed step writes nothing (its batch is one
 * transaction), and the next pull or snapshot tries again.
 */
async function keepFoldNearHead(env: Env, session: Session, spent: number): Promise<void> {
  try {
    const progress = await foldProgress(env, session.repoId, session.epoch);
    if (session.lastSeq - progress.seq < LAZY_FOLD_BEHIND) return;
    await advanceFold(env, session.repoId, session.epoch, session.lastSeq, {
      budget: remainingFoldBudget(planOf(env), spent),
    });
  } catch (err) {
    log({ event: "fold.lag", status: 503, code: errorKind(err), repo_id: session.repoId, epoch: session.epoch });
  }
}

/**
 * Refuse to hand a client an entity its protocol does not admit.
 *
 * The refusal is the point of the protocol bump. Three alternatives were available
 * and each is worse:
 *
 *   - **Serve it anyway.** The client throws inside its apply loop
 *     (`src/core/cloud/apply.ts`, the `default` branch), the page fails, and the
 *     message names an entity the human has never heard of. Convergence stops and
 *     nothing says why.
 *   - **Filter it out.** Silent non-synchronization, which is the exact mistake
 *     `src/core/cloud/wire.ts` records as having already been made once and
 *     reverted: *"it converts a loud, fixable emitter bug into silent
 *     non-synchronization."* Worse here, because a filtered page still advances the
 *     cursor, so the operation is skipped for ever rather than deferred.
 *   - **Say nothing and let the cursor stall.** A page that cannot be served and
 *     does not say so is indistinguishable from a healthy empty log.
 *
 * So: 426 with the supported range and the version that would admit it, which is
 * what the contract already promises for a client outside the range. Nothing has
 * been written — a pull writes nothing — and the client's remedy is in the response.
 *
 * Costs one pass over a page already in memory. No query, no extra column: the
 * entity name is on every row and `minProtocolFor` is the same table validation
 * uses, so a route can never serve what the validator would have refused.
 */
function assertServable(rows: readonly OpRow[], protocol: number): void {
  for (const row of rows) {
    const required = minProtocolFor(row.entity);
    if (required !== null && required > protocol) {
      throw new SyncError(
        "protocol_unsupported",
        "this log contains operations that require a newer protocol than this request negotiated",
        {
          min: PROTOCOL_MIN,
          max: PROTOCOL_MAX,
          requiredProtocol: required,
          // The entity NAME, not the row. It is a fixed word from a closed
          // vocabulary in this Worker's own source — not user data, not an id, and
          // not attacker-controlled — and without it the client cannot say which
          // feature the upgrade is for.
          entity: row.entity,
        },
      );
    }
  }
}

/**
 * Rebuild the wire envelope from a stored row.
 *
 * `payload` is re-parsed rather than re-serialized from a model: it went in verbatim
 * and comes out verbatim, so fields this build has no knowledge of survive the round
 * trip untouched.
 *
 * `protocol` is the version this REQUEST negotiated, not a constant. It used to be a
 * hardcoded `1`, which was true only while `1` was the only version there was; the
 * moment a second exists that literal is a lie on every protocol-2 page. There is no
 * `ops.protocol` column to read the sender's version from and there should not be —
 * `validateEnvelope` requires the envelope's protocol to equal the request header's,
 * so the version an operation was pushed under is a property of the conversation
 * rather than of the row. The honest value is the version of the conversation
 * carrying it out, and `assertServable` has already guaranteed that version admits
 * every entity on the page.
 */
export function toEnvelope(row: OpRow, protocol: number): Record<string, unknown> {
  return {
    opId: row.op_id,
    repoId: undefined,
    seq: row.seq,
    epoch: row.epoch,
    protocol,
    schema: row.schema_version,
    entity: row.entity,
    entityId: row.entity_id,
    verb: row.verb,
    baseVersion: row.base_version,
    payload: JSON.parse(row.payload),
    deviceId: row.device_id,
    actor: row.actor,
    clientSeq: row.client_seq,
    createdAt: row.created_at,
    serverTs: row.server_ts,
  };
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === "") return DEFAULT_PULL_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SyncError("validation", "limit must be a positive integer", {
      maxPullLimit: MAX_PULL_LIMIT,
    });
  }
  // Exceeding the documented cap is a stable error, never a silent truncation to the
  // maximum: a client that asked for 5,000 and quietly got 500 will conclude the log
  // ended.
  if (limit > MAX_PULL_LIMIT) {
    throw new SyncError("payload_too_large", "limit exceeds the documented maximum", {
      maxPullLimit: MAX_PULL_LIMIT,
      limit,
    });
  }
  return limit;
}
