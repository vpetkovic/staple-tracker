/**
 * GET /v1/repos/{repoId}/ops?cursor=&limit= — pull a bounded page.
 *
 * Two queries: authenticate, then one index range scan. `PRIMARY KEY (repo_id, seq)`
 * on a `WITHOUT ROWID` table makes the scan read exactly the rows it returns, so the
 * billed rows_read is the page size and not the table size.
 */

import type { Session } from "./auth.js";
import {
  assertCursorScope,
  decodePullCursor,
  encodeCursor,
  type PullCursor,
} from "./cursor.js";
import type { Env } from "./env.js";
import { SyncError, json } from "./errors.js";
import { DEFAULT_PULL_LIMIT, MAX_PULL_LIMIT } from "./limits.js";
import { log, tokenFingerprint } from "./log.js";

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

  // `hasMore` by fetching limit + 1 and trimming. Never a COUNT(*), which scans the
  // whole range to answer a question the extra row already answers.
  const page = await env.DB.prepare(
    `SELECT seq, epoch, op_id, device_id, entity, entity_id, verb, base_version,
            payload, actor, client_seq, schema_version, created_at, server_ts
       FROM ops
      WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3
      ORDER BY seq
      LIMIT ?4`,
  )
    .bind(session.repoId, session.epoch, after, limit + 1)
    .all<OpRow>();

  const hasMore = page.results.length > limit;
  const rows = hasMore ? page.results.slice(0, limit) : page.results;

  // The cursor advances to the last seq RETURNED, not to the high-water mark. Gaps
  // between them are legal — a slot reserved for a deduplicated operation goes unused
  // — and `WHERE seq > cursor` is gap-tolerant by construction.
  const lastSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : after;
  const next: PullCursor = { v: 1, r: session.repoId, e: session.epoch, s: lastSeq };

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
    ops: rows.map(toEnvelope),
    nextCursor: encodeCursor(next),
    hasMore,
  });
}

/**
 * Rebuild the wire envelope from a stored row.
 *
 * `payload` is re-parsed rather than re-serialized from a model: it went in verbatim
 * and comes out verbatim, so fields this build has no knowledge of survive the round
 * trip untouched.
 */
export function toEnvelope(row: OpRow): Record<string, unknown> {
  return {
    opId: row.op_id,
    repoId: undefined,
    seq: row.seq,
    epoch: row.epoch,
    protocol: 1,
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
