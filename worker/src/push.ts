/**
 * POST /v1/repos/{repoId}/ops — push a batch.
 *
 * The sequence-assignment design, in one paragraph, because it is the load-bearing
 * part of the whole service:
 *
 * A D1 database is backed by a single Durable Object and processes queries one at a
 * time, and `batch()` is a real SQL transaction that rolls back whole on any failure.
 * That is exactly the serialization a coordinator in front would add, so there is no
 * Durable Object here — it would charge for a guarantee D1 hands over for free. The
 * batch reserves N slots with one `UPDATE repos SET last_seq = last_seq + N`, and each
 * insert then computes its OWN position with `SELECT r.last_seq - N + j FROM repos r`.
 * Nothing reads a number into JavaScript and writes it back, which is the lost update
 * this shape exists to avoid. `RETURNING` is not used anywhere: it is undocumented
 * across the entire D1 doc set and `results` is documented as empty for writes.
 */

import type { Session } from "./auth.js";
import type { Env } from "./env.js";
import { SyncError, json } from "./errors.js";
import { type Envelope, validateEnvelope } from "./envelope.js";
import { readJson } from "./http.js";
import { maxBatchSize, planOf } from "./limits.js";
import { log, tokenFingerprint } from "./log.js";

interface PushResult {
  opId: string;
  status: "applied" | "duplicate";
  seq: number;
}

export async function push(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  startedAt: number,
): Promise<Response> {
  const body = await readJson(request);
  const ops = parseBatch(body, env, session, protocol);

  // The epoch a client may optionally fence its push on. Additive and optional, which
  // a protocol version permits. When present it is checked here for a clean 409 AND
  // again inside the batch, because the two are separate queries and an epoch can move
  // between them; the in-batch guard is the one that is actually race-free.
  const claimedEpoch = body.epoch === undefined ? null : intOrThrow(body.epoch, "epoch");
  if (claimedEpoch !== null && claimedEpoch !== session.epoch) {
    throw new SyncError("epoch_changed", "epoch has moved; re-bootstrap before pushing", {
      currentEpoch: session.epoch,
      mustRebootstrap: true,
    });
  }

  // An empty batch is a legal no-op. It costs no statements and is the honest answer
  // to a client whose outbox drained between deciding to push and pushing.
  if (ops.length === 0) {
    return json({
      protocol,
      epoch: session.epoch,
      serverHighWatermark: session.lastSeq,
      results: [],
    });
  }

  const now = Date.now();
  const results = await applyBatch(env, session, ops, now);
  const response = await describe(env, session, ops, results);

  log({
    event: "push",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
    epoch: response.epoch,
    op_count: ops.length,
    applied_count: response.results.filter((r) => r.status === "applied").length,
    duplicate_count: response.results.filter((r) => r.status === "duplicate").length,
    seq_to: response.serverHighWatermark,
    duration_ms: Date.now() - startedAt,
  });

  return json(response);
}

function parseBatch(
  body: Record<string, unknown>,
  env: Env,
  session: Session,
  protocol: number,
): Envelope[] {
  if (!Array.isArray(body.ops)) {
    throw new SyncError("validation", "ops must be an array");
  }

  // Enforced against the SAME number `/v1/capabilities` advertises, so a client that
  // sized itself from the handshake can never be refused for doing what it was told.
  const max = maxBatchSize(planOf(env));
  if (body.ops.length > max) {
    throw new SyncError("payload_too_large", "batch exceeds the advertised maximum", {
      maxBatchSize: max,
      opCount: body.ops.length,
    });
  }

  // Every envelope is validated before any statement is prepared. A batch with one bad
  // operation is rejected whole and writes nothing — never a partially accepted batch.
  const ops = body.ops.map((op, index) => validateEnvelope(op, index, session, protocol));

  // Duplicate ids WITHIN one batch would each reserve a slot and only one would land,
  // which is legal but means the client is confused about its own clientSeq counter.
  // Say so rather than absorbing it.
  const seen = new Set<string>();
  for (const [index, op] of ops.entries()) {
    if (seen.has(op.opId)) {
      throw new SyncError("validation", `ops[${index}].opId is repeated within this batch`, {
        index,
      });
    }
    seen.add(op.opId);
  }

  return ops;
}

/**
 * The atomic batch: `N + 2` statements, all-or-nothing.
 *
 * Returns the per-operation applied/deduplicated flags and the pre-push watermark.
 */
async function applyBatch(
  env: Env,
  session: Session,
  ops: Envelope[],
  now: number,
): Promise<{ priorHigh: number; epoch: number; applied: boolean[] }> {
  const n = ops.length;

  const statements: D1PreparedStatement[] = [
    // [0] The pre-push watermark, read INSIDE the transaction. The value from
    //     authentication is not good enough: another push may have landed since.
    env.DB.prepare(`SELECT last_seq AS prior_high, epoch FROM repos WHERE repo_id = ?1`).bind(
      session.repoId,
    ),

    // [1] Reserve N slots. One statement, so two concurrent pushes cannot reserve the
    //     same window. Fenced on the epoch read at authentication time: if a restore
    //     moved the epoch since, this matches nothing, the inserts below then compute
    //     seqs that already exist, and the primary key rolls the whole batch back.
    env.DB.prepare(
      `UPDATE repos SET last_seq = last_seq + ?2 WHERE repo_id = ?1 AND epoch = ?3`,
    ).bind(session.repoId, n, session.epoch),
  ];

  // [2..N+1] One insert per operation, each computing its own slot from the reserved
  //          window as (window_end - N) + j. `j` is a bound literal, so no statement
  //          depends on a value that passed through JavaScript.
  const insert = env.DB.prepare(
    `INSERT INTO ops (repo_id, seq, epoch, op_id, device_id, entity, entity_id, verb,
                      base_version, payload, actor, client_seq, schema_version,
                      created_at, server_ts)
     SELECT ?1, r.last_seq - ?2 + ?3, r.epoch, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
       FROM repos r
      WHERE r.repo_id = ?1
        AND NOT EXISTS (
              SELECT 1 FROM ops o
               WHERE o.repo_id = ?1
                 AND o.epoch   = r.epoch
                 AND o.op_id   = ?4)`,
  );

  for (const [index, op] of ops.entries()) {
    statements.push(
      insert.bind(
        session.repoId, // ?1  from the SESSION, never from the envelope
        n, // ?2
        index + 1, // ?3
        op.opId, // ?4
        session.deviceId, // ?5  likewise
        op.entity,
        op.entityId,
        op.verb,
        op.baseVersion,
        JSON.stringify(op.payload),
        op.actor,
        op.clientSeq,
        op.schema,
        op.createdAt,
        now,
      ),
    );
  }

  let batch: D1Result[];
  try {
    batch = await env.DB.batch(statements);
  } catch (err) {
    // The batch rolled back entirely — `repos.last_seq` is unchanged and no row was
    // written, so the client may retry the identical batch safely. The one cause worth
    // distinguishing is an epoch that moved under the reservation, which surfaces here
    // as a primary-key collision rather than as a clean signal.
    const current = await env.DB.prepare(`SELECT epoch FROM repos WHERE repo_id = ?1`)
      .bind(session.repoId)
      .first<{ epoch: number }>();
    if (current && current.epoch !== session.epoch) {
      throw new SyncError("epoch_changed", "epoch moved during the push; re-bootstrap", {
        currentEpoch: current.epoch,
        mustRebootstrap: true,
      });
    }
    throw err;
  }

  const head = batch[0]?.results?.[0] as { prior_high: number; epoch: number } | undefined;
  if (!head) {
    // The repository row is gone: purged between authentication and this statement.
    throw new SyncError("not_found", "repository is not known to this server");
  }

  return {
    priorHigh: head.prior_high,
    epoch: head.epoch,
    // `meta.changes` is 1 for an applied insert and 0 for one the NOT EXISTS guard
    // skipped, per element, in the array position of its own prepared statement. That
    // is the per-operation status, for free.
    applied: ops.map((_, index) => (batch[index + 2]?.meta.changes ?? 0) > 0),
  };
}

/**
 * Turn the batch outcome into the per-operation response.
 *
 * Never `WHERE op_id IN (...)` with one bound parameter per id: D1 caps bound
 * parameters at 100 per query — not SQLite's usual 999 — and that lookup breaks at the
 * batch sizes this service advertises. Newly applied operations come from a range
 * select over the reserved window, which costs zero parameters per operation, and the
 * duplicates come from a single `json_each` lookup that binds the whole id list as ONE
 * parameter.
 */
async function describe(
  env: Env,
  session: Session,
  ops: Envelope[],
  outcome: { priorHigh: number; epoch: number; applied: boolean[] },
): Promise<{
  protocol: number;
  epoch: number;
  serverHighWatermark: number;
  results: PushResult[];
}> {
  // Exactly this batch's newly assigned operations: everything above the pre-push
  // watermark. A pure index range scan on (repo_id, seq).
  const assigned = await env.DB.prepare(
    `SELECT op_id, seq FROM ops
      WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3
      ORDER BY seq`,
  )
    .bind(session.repoId, outcome.epoch, outcome.priorHigh)
    .all<{ op_id: string; seq: number }>();

  const seqByOpId = new Map<string, number>();
  for (const row of assigned.results) seqByOpId.set(row.op_id, row.seq);

  // One extra query, and only when something actually deduplicated — which means this
  // is a replay of an already-applied batch, the exact case the response shape exists
  // to serve.
  const duplicates = ops.filter((_, index) => !outcome.applied[index]).map((op) => op.opId);
  if (duplicates.length > 0) {
    const original = await env.DB.prepare(
      `SELECT op_id, seq FROM ops
        WHERE repo_id = ?1 AND epoch = ?2
          AND op_id IN (SELECT value FROM json_each(?3))`,
    )
      .bind(session.repoId, outcome.epoch, JSON.stringify(duplicates))
      .all<{ op_id: string; seq: number }>();
    for (const row of original.results) seqByOpId.set(row.op_id, row.seq);
  }

  const results: PushResult[] = ops.map((op, index) => {
    const seq = seqByOpId.get(op.opId);
    if (seq === undefined) {
      // Unreachable: an operation is either newly inserted above the watermark or was
      // already present. If it is neither, something is wrong that a client must not
      // treat as an acknowledgement.
      throw new SyncError("unavailable", "could not resolve a sequence for an accepted operation");
    }
    // A `duplicate` carries the seq of its ORIGINAL application, not a new one. That is
    // the whole point of the field: a client that lost an acknowledgement reconciles
    // from this response without re-deriving anything. `duplicate` is a success.
    return { opId: op.opId, status: outcome.applied[index] ? "applied" : "duplicate", seq };
  });

  // The watermark AFTER this push. Note that it can exceed max(seq) in `results`:
  // slots reserved for deduplicated operations go unused, so `...1039, 1041...` is a
  // correct sequence. Strictly increasing, never dense.
  const serverHighWatermark = outcome.priorHigh + ops.length;

  return {
    protocol: ops[0]?.protocol ?? 1,
    epoch: outcome.epoch,
    serverHighWatermark,
    results,
  };
}

function intOrThrow(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SyncError("validation", `${field} must be an integer`);
  }
  return value;
}
