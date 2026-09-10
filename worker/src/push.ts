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
 *
 * The same reservation claims the repository's vocabulary (STA-290), and every insert
 * is conditioned on the reservation having happened, so a batch either reserves, claims
 * and writes, or does none of the three. See `applyBatch`.
 */

import type { Session } from "./auth.js";
import type { Env } from "./env.js";
import { SyncError, json } from "./errors.js";
import { REGISTRY_ENTITIES, type Envelope, validateEnvelope } from "./envelope.js";
import { readJson } from "./http.js";
import { maxBatchSize, planOf } from "./limits.js";
import { log, tokenFingerprint } from "./log.js";
import {
  type Vocabulary,
  storedVocabulary,
  vocabularyOf,
  vocabularyRefusal,
} from "./vocabulary.js";

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
  const { ops, vocabulary } = parseBatch(body, env, session, protocol);

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
  // to a client whose outbox drained between deciding to push and pushing. It has no
  // vocabulary, so it claims none: `vocabulary` is null exactly when the batch is empty.
  if (vocabulary === null) {
    return json({
      protocol,
      epoch: session.epoch,
      serverHighWatermark: session.lastSeq,
      results: [],
    });
  }

  /**
   * The vocabulary, refused early when authentication already knows the answer.
   *
   * This costs no statement, and it is not the guard that matters: a request that
   * authenticated against an unclaimed repository passes it whatever it carries, and the
   * batch in `applyBatch` is what decides that race.
   */
  if (session.vocabulary !== null && session.vocabulary !== vocabulary) {
    throw vocabularyRefusal(session.vocabulary, vocabulary);
  }

  const now = Date.now();
  const results = await applyBatch(env, session, ops, vocabulary, now);
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
): { ops: Envelope[]; vocabulary: Vocabulary | null } {
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

  /**
   * A batch may not mix the registry vocabulary with the workspace one.
   *
   * A hub's log holds only `registration` and `crossLink`; a workspace's holds only the
   * other thirteen. Nothing legitimate produces a batch containing both, because nothing
   * legitimate has both a hub and a workspace in hand at once. Refused here, in memory,
   * as `validation`, because it is wrong whatever the repository holds.
   *
   * It is also what gives a non-empty batch exactly ONE vocabulary, which is the thing
   * `applyBatch` claims and checks against `repos.vocabulary` (STA-290). That
   * per-repository rule is the structural half: a batch of registry operations alone no
   * longer lands wherever the credential points. It costs no query either — the
   * repository's vocabulary arrives with the credential, and the race-free check rides
   * statements the batch already had.
   */
  const registry = ops.filter((op) => REGISTRY_ENTITIES.has(op.entity)).length;
  if (registry > 0 && registry < ops.length) {
    throw new SyncError(
      "validation",
      "a batch may not mix hub registry entities with workspace entities",
      { registryCount: registry, opCount: ops.length },
    );
  }

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

  return { ops, vocabulary: ops[0] === undefined ? null : vocabularyOf(ops[0].entity) };
}

/**
 * The atomic batch: `N + 2` statements, all-or-nothing.
 *
 * Returns the per-operation applied/deduplicated flags and the pre-push watermark.
 *
 * ## The reservation is the one decision, and every insert is conditioned on it
 *
 * `[1]` reserves the window only when the repository is still on the session's epoch
 * AND holds this batch's vocabulary or none yet, and it claims the vocabulary in the
 * same statement. Each insert then requires the repository to be on that epoch and to
 * hold that vocabulary AFTERWARDS. The two predicates are the same predicate seen from
 * either side of the claim, so an insert lands exactly when `[1]` matched:
 *
 *   - Two first pushes of different vocabularies race. D1 runs one batch to the end
 *     before the other starts. The first claims; the second's `[1]` matches nothing, its
 *     inserts match nothing, and it writes no row, reserves no slot and claims nothing.
 *   - A restore moved the epoch after authentication. `[1]` matches nothing, and neither
 *     does any insert. This used to rely on the inserts' computed seqs colliding with
 *     rows that already exist, which does not happen when the window falls on slots
 *     that deduplication left unused — the rows then landed, unreserved, in the new
 *     epoch below its watermark.
 *
 * Neither outcome raises inside the batch, because D1 has no conditional abort, so both
 * are read afterwards from `[0]`: the repository row as it stood before this batch, read
 * inside the same transaction and therefore exactly what `[1]` tested.
 */
async function applyBatch(
  env: Env,
  session: Session,
  ops: Envelope[],
  vocabulary: Vocabulary,
  now: number,
): Promise<{ priorHigh: number; epoch: number; applied: boolean[] }> {
  const n = ops.length;

  const statements: D1PreparedStatement[] = [
    // [0] The repository as it stood before this batch, read INSIDE the transaction. The
    //     values from authentication are not good enough: another push, a claim or a
    //     restore may have landed since.
    env.DB.prepare(
      `SELECT last_seq AS prior_high, epoch, vocabulary FROM repos WHERE repo_id = ?1`,
    ).bind(session.repoId),

    // [1] Reserve N slots and claim the vocabulary. One statement, so two concurrent
    //     pushes can neither reserve the same window nor claim different vocabularies.
    //     `SET vocabulary = ?4` never changes a set value: the WHERE admits only NULL or
    //     the same value.
    env.DB.prepare(
      `UPDATE repos SET last_seq = last_seq + ?2, vocabulary = ?4
        WHERE repo_id = ?1 AND epoch = ?3
          AND (vocabulary IS NULL OR vocabulary = ?4)`,
    ).bind(session.repoId, n, session.epoch, vocabulary),
  ];

  // [2..N+1] One insert per operation, each computing its own slot from the reserved
  //          window as (window_end - N) + j. `j` is a bound literal, so no statement
  //          depends on a value that passed through JavaScript. 17 bound parameters,
  //          against D1's cap of 100 per statement.
  const insert = env.DB.prepare(
    `INSERT INTO ops (repo_id, seq, epoch, op_id, device_id, entity, entity_id, verb,
                      base_version, payload, actor, client_seq, schema_version,
                      created_at, server_ts)
     SELECT ?1, r.last_seq - ?2 + ?3, r.epoch, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
       FROM repos r
      WHERE r.repo_id = ?1
        AND r.epoch = ?16
        AND r.vocabulary = ?17
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
        session.epoch, // ?16 the epoch `[1]` reserved in
        vocabulary, // ?17 the vocabulary `[1]` claimed or found
      ),
    );
  }

  let batch: D1Result[];
  try {
    batch = await env.DB.batch(statements);
  } catch (err) {
    // The batch rolled back entirely — `repos.last_seq` is unchanged and no row was
    // written, so the client may retry the identical batch safely. An epoch that moved
    // under the reservation no longer surfaces here (see above), but one that moved
    // after this batch failed for another reason is still worth naming as what it is.
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

  const head = batch[0]?.results?.[0] as
    | { prior_high: number; epoch: number; vocabulary: string | null }
    | undefined;
  if (!head) {
    // The repository row is gone: purged between authentication and this statement.
    throw new SyncError("not_found", "repository is not known to this server");
  }

  // `[1]`'s predicate, read back from the row it tested. When either half fails, `[1]`
  // matched nothing and neither did any insert, so nothing was reserved, claimed or
  // written, and the refusal says which half. Vocabulary first: it is permanent, while an
  // epoch change is answered by a re-bootstrap that would only reach the same refusal.
  const held = storedVocabulary(head.vocabulary);
  if (held !== null && held !== vocabulary) {
    throw vocabularyRefusal(held, vocabulary);
  }
  if (head.epoch !== session.epoch) {
    throw new SyncError("epoch_changed", "epoch moved during the push; re-bootstrap", {
      currentEpoch: head.epoch,
      mustRebootstrap: true,
    });
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
