/**
 * Backups, restore and purge — disaster recovery, which is not convergence.
 *
 * Contract: `docs/sync.md`, "Backup, disconnect and purge are three different things".
 *
 * ## The three things, kept apart on purpose
 *
 * **Backup** is a point-in-time fold of the log, stored beside it. Creating, listing
 * or deleting one moves no cursor, no `last_seq`, no `epoch` and no lease. Nothing in
 * this file writes to `ops`, `leases` or `devices` except the restore path, and the
 * restore path is the one that announces itself by moving the epoch.
 *
 * **Purge** destroys the remote state and is a separate verb with its own route. It
 * is never a flag on anything.
 *
 * **Restore** is the dangerous one and gets the rest of this comment.
 *
 * ## Restore: stage into the next epoch, then flip
 *
 * A restore that only bumped the epoch would be silent, total data loss reported as
 * success. `GET /snapshot` folds `WHERE repo_id = ? AND epoch = ?` — the CURRENT
 * epoch — so a device that re-bootstraps into a freshly bumped, empty epoch hydrates
 * an empty repository, while the pre-restore rows sit in the table being retained for
 * forensics nobody asked for. The contract's two legal shapes are *append
 * compensating operations* or *bump the epoch AND re-materialise*; bumping alone is
 * not one of them.
 *
 * So a restore materialises the backup's folded state as real operations stamped with
 * the NEW epoch, and only then moves the repository onto it:
 *
 *   1. `begin`  — fold the current epoch and store it as a `pre-restore` backup (the
 *                 undo), write the audit row, decide `toEpoch = epoch + 1`.
 *   2. `stage`  — write the backup's entities into `epoch = toEpoch`, in chunks.
 *   3. `commit` — one guarded statement moves `repos.epoch` to `toEpoch`.
 *
 * **Staging is invisible.** Both `pull` and `snapshot` filter on `session.epoch`, and
 * a session's epoch comes from the `repos` row, so until step 3 no device can see a
 * single staged row — not by pulling, not by bootstrapping, not by cursor. That gives
 * the cutover transactional semantics across three HTTP requests without a
 * transaction spanning them, and it is why the order is stage-then-flip rather than
 * flip-then-materialise. Flipping first would open a window in which a device
 * re-bootstraps into a half-materialised epoch and hydrates half a repository, which
 * is the same silent loss the ruling forbids, only narrower and harder to notice.
 *
 * **Why it is chunked.** The free plan allows 50 D1 queries per invocation; staging N
 * entities costs N+1. A single-shot restore would work on a demo repository and fail
 * permanently on a real one, so `stage` takes `maxBatchSize` entities at a time — the
 * same ceiling, from the same place, that push sizes its batches from — and progress
 * is durable in D1 rather than held in a request.
 *
 * **Non-truncating, still.** Nothing here deletes an operation. `repos.last_seq`
 * keeps climbing across the flip, so `seq` is never reused, fenced lease tokens stay
 * monotonic, and the pre-restore epoch's rows stay queryable. What "non-truncating"
 * does NOT mean is that a snapshot spans epochs — it does not, and it should not,
 * because a snapshot that did would hydrate a device onto a timeline nobody is on.
 *
 * ## The operation ids a restore mints
 *
 * `sha256(repoId \n epoch \n "restore" \n restoreId \n entityKey)`, first 32 hex
 * characters. A client id is `sha256(repoId \n epoch \n deviceId \n clientSeq)` —
 * four fields where this has five, so a restored operation cannot collide with a
 * device's own by construction rather than by luck. That matters because the dedupe
 * index is `(repo_id, epoch, op_id)` and a collision inside one epoch is absorbed
 * silently: the colliding operation would be reported `duplicate` with the other
 * one's `seq`, and the client would read that as an acknowledgement.
 */

import { type Session, sha256 } from "./auth.js";
import { entityKey } from "./cursor.js";
import type { Env } from "./env.js";
import { protocolForEntities } from "./envelope.js";
import { SyncError, json } from "./errors.js";
import { type BackupEntity, foldLog, forBackup, materializedVerb } from "./fold.js";
import { readJson } from "./http.js";
import { PROTOCOL_MAX, PROTOCOL_MIN, maxBatchSize, planOf } from "./limits.js";
import { log, tokenFingerprint } from "./log.js";
import {
  type Vocabulary,
  mixedBackupRefusal,
  registryEntitiesJson,
  storedVocabulary,
  vocabularyRefusal,
} from "./vocabulary.js";

interface RepoRow {
  epoch: number;
  last_seq: number;
  backup_enabled: number;
  vocabulary: string | null;
}

interface BackupRow {
  backup_id: string;
  epoch: number;
  cutoff_seq: number;
  entity_count: number;
  op_count: number;
  schema_version: number;
  protocol: number;
  kind: string;
  created_at: number;
  created_by_device: string;
}

interface RestoreRow {
  restore_id: string;
  from_backup_id: string;
  pre_restore_backup_id: string;
  from_epoch: number;
  to_epoch: number;
  guard_seq: number;
  entity_count: number;
  status: string;
}

/**
 * The repository row, with the consent flag.
 *
 * Read fresh in every backup route rather than carried on the session. The session's
 * epoch is captured at authentication and is advisory; a restore decides an epoch
 * from a value it read in the same request that acts on it.
 */
async function readRepo(env: Env, repoId: string): Promise<RepoRow> {
  const row = await env.DB.prepare(
    `SELECT epoch, last_seq, backup_enabled, vocabulary FROM repos WHERE repo_id = ?1`,
  )
    .bind(repoId)
    .first<RepoRow>();
  if (!row) throw new SyncError("not_found", "no such repository");
  return row;
}

/**
 * The server-side half of the third consent.
 *
 * `docs/sync.md` grants backup with "`sync.backup = true` in machine config, plus a
 * server-side flag", and BOTH halves are required. The machine-local half cannot
 * stand alone: it is a file on the device, so a device that merely holds a valid
 * credential could create and delete backups because its own config said it could.
 * The server flag is the half that is not the client's to assert.
 *
 * `forbidden` rather than `validation`, because this is an authorization answer: the
 * credential is fine and the request is well-formed, and the thing that is missing is
 * permission that a human has not granted.
 */
function assertBackupConsent(repo: RepoRow): void {
  if (repo.backup_enabled !== 1) {
    throw new SyncError(
      "forbidden",
      "backup is not enabled for this repository. It is a separate consent from " +
        "connecting and from automatic sync: enable it with `staple cloud backup enable`.",
    );
  }
}

/** `sha256(...)` as the first 32 hex characters, matching the client's `deriveOpId`. */
async function opIdHex(input: string): Promise<string> {
  const digest = await sha256(input);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * A v4-shaped identifier for a backup or a restore.
 *
 * `crypto.randomUUID()` is available in the Workers runtime and is the right source:
 * these are not derived from anything, and nothing should be able to guess the id of
 * a backup it did not create.
 */
function newId(): string {
  return crypto.randomUUID();
}

// --------------------------------------------------------------------- consent

/**
 * PUT /v1/repos/{repoId}/backup — set the server-side backup flag.
 *
 * ADDITIVE to the route table in `docs/sync.md`. The contract names the flag but no
 * route that writes it, and a consent that only exists in a file on the device is not
 * the two-sided consent the contract describes. Body: `{ "enabled": true|false }`.
 *
 * Disabling does NOT delete existing backups. Withdrawing permission to make new ones
 * is a different decision from destroying the ones already made, and a device that
 * conflated them would delete a human's only copy of their data as a side effect of
 * turning a flag off. Deleting a backup is its own verb, and purge is another.
 */
export async function setBackupConsent(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.enabled !== "boolean") {
    throw new SyncError("validation", "enabled must be a boolean");
  }

  const result = await env.DB.prepare(`UPDATE repos SET backup_enabled = ?2 WHERE repo_id = ?1`)
    .bind(session.repoId, body.enabled ? 1 : 0)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new SyncError("not_found", "no such repository");

  log({
    event: "backup.consent",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
  });

  return json({ protocol, backupEnabled: body.enabled });
}

// --------------------------------------------------------------------- backups

/**
 * POST /v1/repos/{repoId}/backups — take a point-in-time fold.
 *
 * Reads the log and writes ONE row to `backups`. It does not touch `repos`, so
 * `last_seq` and `epoch` are exactly what they were, and it does not touch `ops`,
 * `leases`, `devices` or any cursor. That is the "does not change convergence state"
 * requirement, and it is a property of the statements below rather than of a
 * promise: there are only two, and one of them is a SELECT.
 */
export async function createBackup(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  startedAt: number,
): Promise<Response> {
  const repo = await readRepo(env, session.repoId);
  assertBackupConsent(repo);

  const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
  const label = typeof body.label === "string" ? body.label : null;

  const backup = await captureBackup(env, session, repo, "manual", label);

  log({
    event: "backup.create",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
    epoch: repo.epoch,
    entity_count: backup.entityCount,
    op_count: backup.opCount,
    seq_to: repo.last_seq,
    duration_ms: Date.now() - startedAt,
  });

  return json({
    protocol,
    backup: {
      backupId: backup.backupId,
      epoch: repo.epoch,
      cutoffSeq: repo.last_seq,
      entityCount: backup.entityCount,
      opCount: backup.opCount,
      schemaVersion: backup.schemaVersion,
      kind: "manual",
      createdAt: backup.createdAt,
      createdByDevice: session.deviceId,
    },
  });
}

/**
 * Fold the current epoch and persist it. Shared by `create` and by the automatic
 * pre-restore capture, because the undo a restore takes must be exactly as good as
 * the backup a human takes deliberately — a weaker one would be a worse undo in the
 * one situation where the undo is the only thing left.
 */
async function captureBackup(
  env: Env,
  session: Session,
  repo: RepoRow,
  kind: "manual" | "pre-restore",
  label: string | null,
): Promise<{
  backupId: string;
  entityCount: number;
  opCount: number;
  schemaVersion: number;
  createdAt: number;
}> {
  const folded = await foldLog(env, session.repoId, repo.epoch, repo.last_seq);
  const backupId = newId();
  const createdAt = Date.now();

  await env.DB.prepare(
    `INSERT INTO backups
       (repo_id, backup_id, epoch, cutoff_seq, entity_count, op_count, schema_version,
        protocol, kind, created_at, created_by_device, state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      session.repoId,
      backupId,
      repo.epoch,
      repo.last_seq,
      folded.entities.length,
      folded.opCount,
      folded.schemaVersion,
      /**
       * The lowest protocol that can REPLAY this backup, not this build's ceiling.
       *
       * It used to be `PROTOCOL_MAX`, which was indistinguishable from this while
       * there was only one version. It is not the same thing, and the difference
       * shows the moment the range moves: `beginRestore` refuses a backup whose
       * stored protocol is outside `[PROTOCOL_MIN, PROTOCOL_MAX]`, so stamping the
       * ceiling would mark every ordinary workspace backup as needing protocol 2
       * merely because the Worker that took it happened to know about the hub
       * registry. A Worker rolled back one version would then refuse to restore
       * backups containing nothing it does not understand — refusing to open the
       * parachute because it was folded by a newer machine.
       *
       * `protocolForEntities` reads the same per-entity table validation uses, so a
       * backup's stamp cannot disagree with what the wire would accept. A workspace
       * backup stamps 1; a hub backup stamps 2 because `registration` requires it.
       */
      protocolForEntities(folded.entities),
      kind,
      createdAt,
      session.deviceId,
      // `forBackup` drops the per-field provenance and nothing else. It describes THIS
      // epoch — versions that restart and operation ids that are re-minted the moment a
      // restore runs — so it is meaningless on the other side of the one operation a
      // backup exists to serve. Same fold, one field lighter.
      JSON.stringify({ label, entities: folded.entities.map(forBackup) }),
    )
    .run();

  return {
    backupId,
    entityCount: folded.entities.length,
    opCount: folded.opCount,
    schemaVersion: folded.schemaVersion,
    createdAt,
  };
}

/**
 * GET /v1/repos/{repoId}/backups — list, newest first.
 *
 * `state` is deliberately not in the projection. A list is metadata; shipping every
 * backup's full folded contents to answer "what backups exist" would put the entire
 * repository on the wire once per row.
 */
export async function listBackups(
  env: Env,
  session: Session,
  protocol: number,
): Promise<Response> {
  const repo = await readRepo(env, session.repoId);
  assertBackupConsent(repo);

  const rows = await env.DB.prepare(
    `SELECT backup_id, epoch, cutoff_seq, entity_count, op_count, schema_version,
            protocol, kind, created_at, created_by_device
       FROM backups WHERE repo_id = ?1 ORDER BY created_at DESC`,
  )
    .bind(session.repoId)
    .all<BackupRow>();

  return json({
    protocol,
    epoch: repo.epoch,
    backups: rows.results.map(describeBackup),
  });
}

function describeBackup(row: BackupRow): Record<string, unknown> {
  return {
    backupId: row.backup_id,
    epoch: row.epoch,
    cutoffSeq: row.cutoff_seq,
    entityCount: row.entity_count,
    opCount: row.op_count,
    schemaVersion: row.schema_version,
    protocol: row.protocol,
    kind: row.kind,
    createdAt: row.created_at,
    createdByDevice: row.created_by_device,
  };
}

/**
 * DELETE /v1/repos/{repoId}/backups/{backupId} — retention, one row at a time.
 *
 * ADDITIVE to the contract's route table, which names create and list but nothing
 * that removes one. "Its own retention" is not implementable without a delete, and
 * the alternative — an automatic expiry job — would delete a human's backups on a
 * schedule nobody typed.
 *
 * A backup referenced by an in-flight restore is refused: it is the source that
 * restore is still staging from, and deleting it mid-restore would strand the restore
 * with no way to finish and no way to explain itself.
 */
export async function deleteBackup(
  env: Env,
  session: Session,
  protocol: number,
  backupId: string,
): Promise<Response> {
  const repo = await readRepo(env, session.repoId);
  assertBackupConsent(repo);

  const inFlight = await env.DB.prepare(
    `SELECT restore_id FROM restores
      WHERE repo_id = ?1 AND status = 'staging'
        AND (from_backup_id = ?2 OR pre_restore_backup_id = ?2)`,
  )
    .bind(session.repoId, backupId)
    .first<{ restore_id: string }>();
  if (inFlight) {
    throw new SyncError(
      "conflict",
      "this backup is the source or the undo of a restore that has not finished",
      { restoreId: inFlight.restore_id },
    );
  }

  const result = await env.DB.prepare(`DELETE FROM backups WHERE repo_id = ?1 AND backup_id = ?2`)
    .bind(session.repoId, backupId)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new SyncError("not_found", "no such backup");

  log({
    event: "backup.delete",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
  });

  return json({ protocol, backupId, deleted: true });
}

// --------------------------------------------------------------------- restore

/**
 * POST /v1/repos/{repoId}/backups/{backupId}/restore — resumable, three-phase.
 *
 * One route, called in a loop until it answers `done`. Which phase runs is decided
 * from durable state, not from a flag the caller sets:
 *
 *   no `restoreId` in the body      -> begin
 *   staged < entityCount            -> stage the next chunk
 *   staged == entityCount           -> commit
 *
 * Keeping it to one route is not tidiness: `begin`, `stage` and `commit` as three
 * routes would each need their own authorization, their own consent check and their
 * own guard against being called out of order, and three copies of a guard is how one
 * of them ends up subtly different.
 *
 * The response always reports `staged`, `entityCount` and `status`, so a caller that
 * lost its place mid-restore recovers by calling again with the same `restoreId` and
 * being told where it actually got to. Progress is read from `ops` rather than from a
 * counter, so it is what happened rather than what was recorded as having happened.
 */
export async function restoreBackup(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  backupId: string,
  startedAt: number,
): Promise<Response> {
  const repo = await readRepo(env, session.repoId);
  assertBackupConsent(repo);

  const body = await readJson(request);
  const restoreId = body.restoreId;

  if (restoreId === undefined || restoreId === null) {
    return beginRestore(env, session, protocol, repo, backupId, body, startedAt);
  }
  if (typeof restoreId !== "string" || restoreId.length === 0) {
    throw new SyncError("validation", "restoreId must be a non-empty string");
  }

  const restore = await env.DB.prepare(
    `SELECT restore_id, from_backup_id, pre_restore_backup_id, from_epoch, to_epoch,
            guard_seq, entity_count, status
       FROM restores WHERE repo_id = ?1 AND restore_id = ?2`,
  )
    .bind(session.repoId, restoreId)
    .first<RestoreRow>();
  if (!restore) throw new SyncError("not_found", "no such restore");
  if (restore.from_backup_id !== backupId) {
    throw new SyncError("validation", "this restore is not restoring that backup");
  }
  if (restore.status === "committed") {
    // Idempotent rather than an error: a client that lost the last response and
    // retried must be told it succeeded, not told it did something wrong.
    return json({
      protocol,
      restoreId: restore.restore_id,
      status: "committed",
      done: true,
      epoch: restore.to_epoch,
      entityCount: restore.entity_count,
      staged: restore.entity_count,
    });
  }
  if (restore.status !== "staging") {
    throw new SyncError("conflict", `this restore was ${restore.status}`);
  }

  const staged = await stagedCount(env, session.repoId, restore.to_epoch);
  if (staged < restore.entity_count) {
    return stageRestore(env, session, protocol, repo, restore, staged, startedAt);
  }
  return commitRestore(env, session, protocol, repo, restore, startedAt);
}

/** How much of the new epoch already exists. The authority on progress. */
async function stagedCount(env: Env, repoId: string, toEpoch: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1 AND epoch = ?2`,
  )
    .bind(repoId, toEpoch)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Phase one: take the undo, write the audit record, and reserve the next epoch.
 *
 * The pre-restore backup is taken BEFORE anything is staged and before the audit row
 * exists, so there is no ordering in which a restore has begun and the way back has
 * not been captured. The contract requires "a recoverable pre-restore snapshot"; this
 * is that snapshot, it is an ordinary backup row, and it is restorable by exactly the
 * same route that is about to run — which is the only way to know it works.
 */
async function beginRestore(
  env: Env,
  session: Session,
  protocol: number,
  repo: RepoRow,
  backupId: string,
  body: Record<string, unknown>,
  startedAt: number,
): Promise<Response> {
  /**
   * The typed confirmation, checked server-side as well as at the terminal.
   *
   * The CLI already demands the repository id typed back, and that is where it means
   * something to a human. Requiring it on the wire too means a script that reaches
   * this route directly cannot destroy a timeline with a bare POST — the id has to be
   * in the request, which is not something a mistyped loop supplies by accident.
   */
  if (body.confirm !== session.repoId) {
    throw new SyncError(
      "validation",
      "restore requires the repository id in `confirm`. Nothing was changed.",
    );
  }

  const existing = await env.DB.prepare(
    `SELECT restore_id FROM restores WHERE repo_id = ?1 AND status = 'staging'`,
  )
    .bind(session.repoId)
    .first<{ restore_id: string }>();
  if (existing) {
    // Two concurrent restores would interleave their entities into one epoch and
    // produce a timeline that is neither backup.
    throw new SyncError("conflict", "a restore is already in flight for this repository", {
      restoreId: existing.restore_id,
    });
  }

  const source = await env.DB.prepare(
    `SELECT backup_id, epoch, cutoff_seq, entity_count, op_count, schema_version,
            protocol, kind, created_at, created_by_device
       FROM backups WHERE repo_id = ?1 AND backup_id = ?2`,
  )
    .bind(session.repoId, backupId)
    .first<BackupRow>();
  if (!source) throw new SyncError("not_found", "no such backup");

  /**
   * The compatibility check the contract asks for, on the half the server owns.
   *
   * The server checks PROTOCOL, because the envelope shape it is about to write is
   * the protocol's business and the server is the party writing those rows. It does
   * NOT check `schema_version`: the workspace migration number is stored and never
   * interpreted here, exactly as `ops.schema_version` is, and the device is the only
   * party that knows which schemas it can apply. The client refuses `schema_ahead`
   * before it ever calls this route.
   */
  if (source.protocol < PROTOCOL_MIN || source.protocol > PROTOCOL_MAX) {
    throw new SyncError("protocol_unsupported", "this backup was written by an incompatible protocol", {
      min: PROTOCOL_MIN,
      max: PROTOCOL_MAX,
    });
  }

  /**
   * And the same check against THIS REQUEST's negotiated protocol, which is a
   * different question with a different answer.
   *
   * The check above asks whether this SERVER can write the backup's envelopes. This
   * one asks whether the CALLER will be able to read what it is asking for. A
   * protocol-1 device restoring a protocol-2 backup would succeed here and then be
   * refused by `GET /snapshot` on the very next call — having already moved the
   * repository onto an epoch it cannot hydrate, and having spent the pre-restore
   * capture doing it. The data would be intact and the device would be stuck, which
   * is the worst available combination because it looks like corruption.
   *
   * Refused before the undo is captured and before anything is staged, so declining
   * costs nothing and the remedy — upgrade, then restore — is in the response.
   */
  if (source.protocol > protocol) {
    throw new SyncError(
      "protocol_unsupported",
      "this backup contains operations this request's protocol cannot read; upgrade before restoring it",
      { min: PROTOCOL_MIN, max: PROTOCOL_MAX, requiredProtocol: source.protocol },
    );
  }

  await assertRestorableVocabulary(env, session.repoId, backupId, repo);

  const undo = await captureBackup(env, session, repo, "pre-restore", null);

  const restoreId = newId();
  const toEpoch = repo.epoch + 1;
  await env.DB.prepare(
    `INSERT INTO restores
       (repo_id, restore_id, from_backup_id, pre_restore_backup_id, from_epoch, to_epoch,
        guard_seq, entity_count, staged_count, status, device_id, actor, began_at, committed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 'staging', ?9, ?10, ?11, NULL)`,
  )
    .bind(
      session.repoId,
      restoreId,
      backupId,
      undo.backupId,
      repo.epoch,
      toEpoch,
      repo.last_seq,
      source.entity_count,
      session.deviceId,
      typeof body.actor === "string" ? body.actor : null,
      Date.now(),
    )
    .run();

  log({
    event: "restore.begin",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
    epoch: repo.epoch,
    entity_count: source.entity_count,
    seq_to: repo.last_seq,
    duration_ms: Date.now() - startedAt,
  });

  return json({
    protocol,
    restoreId,
    status: "staging",
    done: false,
    fromEpoch: repo.epoch,
    toEpoch,
    entityCount: source.entity_count,
    staged: 0,
    preRestoreBackupId: undo.backupId,
  });
}

/**
 * A restore writes operations, so it obeys the repository's vocabulary (STA-290).
 *
 * Staging materialises the backup's entities as rows straight into D1, without going
 * through `push.ts`, so the rule has to be applied here too or a restore would be the
 * one route left that can put registry rows into a workspace's log. That was the
 * irreversibility the ticket named: a restore used to carry the contamination into the
 * new epoch.
 *
 * Decided at BEGIN, before the undo is captured and before anything is staged, so a
 * refusal costs nothing — and asked again at the top of every stage turn, for a restore
 * that began before the rule existed (see `stageRestore`):
 *
 *   - a backup holding BOTH vocabularies is refused whatever the repository holds. Only a
 *     repository contaminated before migration 0005 can produce one, whether the backup was
 *     captured before 0005 or after it, before the recovery recipe was run.
 *   - a backup of the other vocabulary is refused.
 *   - an UNCLAIMED repository is claimed for the backup's vocabulary, here, with the same
 *     guarded statement push uses. Claiming at begin rather than at the first stage is
 *     what stops a push of the other vocabulary, arriving while the restore stages, from
 *     claiming the repository out from under the entities being staged. Once claimed a
 *     vocabulary is never rewritten, so nothing a later stage turn does needs the check.
 *   - an empty backup has no vocabulary and claims nothing.
 *
 * The backup's vocabulary is counted in SQL over the stored fold, with the registry
 * names bound as ONE parameter, so `begin` still never parses a backup's state in the
 * Worker — it did not before this check, and a refusal should not be what starts. One
 * query per call; a push pays none.
 */
async function assertRestorableVocabulary(
  env: Env,
  repoId: string,
  backupId: string,
  repo: RepoRow,
): Promise<void> {
  const counted = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(json_extract(e.value, '$.entity') IN (SELECT value FROM json_each(?3))), 0)
              AS registry
       FROM backups b, json_each(b.state, '$.entities') e
      WHERE b.repo_id = ?1 AND b.backup_id = ?2`,
  )
    .bind(repoId, backupId, registryEntitiesJson())
    .first<{ total: number; registry: number }>();
  const total = counted?.total ?? 0;
  const registry = counted?.registry ?? 0;
  if (total === 0) return;
  if (registry > 0 && registry < total) throw mixedBackupRefusal();

  const offered: Vocabulary = registry === total ? "hub" : "workspace";
  const held = storedVocabulary(repo.vocabulary);
  if (held === offered) return;
  if (held !== null) throw vocabularyRefusal(held, offered);

  const claim = await env.DB.prepare(
    `UPDATE repos SET vocabulary = ?2
      WHERE repo_id = ?1 AND (vocabulary IS NULL OR vocabulary = ?2)`,
  )
    .bind(repoId, offered)
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    // Claimed by a push between `readRepo` and this statement, and not for this backup.
    const now = await env.DB.prepare(`SELECT vocabulary FROM repos WHERE repo_id = ?1`)
      .bind(repoId)
      .first<{ vocabulary: string | null }>();
    const winner = storedVocabulary(now?.vocabulary);
    if (winner === null) throw new SyncError("not_found", "no such repository");
    throw vocabularyRefusal(winner, offered);
  }
}

/**
 * Phase two: write the next chunk of entities into the new epoch.
 *
 * The batch mirrors push's, and for the same reason: the sequence numbers are
 * computed IN SQL from the reserved window, so nothing reads a counter into
 * JavaScript and writes it back. Both statements are guarded on the repository still
 * being at `from_epoch`, so a stage that races a commit writes nothing rather than
 * appending orphans to an epoch that has already gone live.
 */
async function stageRestore(
  env: Env,
  session: Session,
  protocol: number,
  repo: RepoRow,
  restore: RestoreRow,
  staged: number,
  startedAt: number,
): Promise<Response> {
  if (repo.epoch !== restore.from_epoch) {
    throw new SyncError("epoch_changed", "the repository moved epoch while this restore was staging", {
      currentEpoch: repo.epoch,
    });
  }

  /**
   * Checked again on every turn, not only at begin. For a restore that began after
   * migration 0005 this is a no-op — begin already claimed or matched the vocabulary,
   * and a claimed vocabulary is never rewritten. It exists for a restore that BEGAN
   * before 0005 and is still staging: nothing checked that one, and without this it
   * would stage a contaminated backup into a workspace's next epoch with the rule in
   * force. Refused, it stays `staging`; worker/README.md's recovery recipe says how to
   * abandon it.
   */
  await assertRestorableVocabulary(env, session.repoId, restore.from_backup_id, repo);

  const source = await env.DB.prepare(
    `SELECT state, schema_version FROM backups WHERE repo_id = ?1 AND backup_id = ?2`,
  )
    .bind(session.repoId, restore.from_backup_id)
    .first<{ state: string; schema_version: number }>();
  if (!source) throw new SyncError("not_found", "the backup being restored no longer exists");

  const parsed = JSON.parse(source.state) as { entities: BackupEntity[] };
  const chunk = parsed.entities.slice(staged, staged + maxBatchSize(planOf(env)));
  if (chunk.length === 0) {
    throw new SyncError("conflict", "the backup holds fewer entities than the restore expects");
  }

  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const statements = [
    env.DB.prepare(
      `UPDATE repos SET last_seq = last_seq + ?3 WHERE repo_id = ?1 AND epoch = ?2`,
    ).bind(session.repoId, restore.from_epoch, chunk.length),
  ];

  for (let index = 0; index < chunk.length; index += 1) {
    const entity = chunk[index]!;
    const { verb, payload } = materializedVerb(entity);
    const opId = await opIdHex(
      `${session.repoId}\n${restore.to_epoch}\nrestore\n${restore.restore_id}\n` +
        `${entityKey(entity.entity, entity.entityId)}`,
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO ops
           (repo_id, seq, epoch, op_id, device_id, entity, entity_id, verb, base_version,
            payload, actor, client_seq, schema_version, created_at, server_ts)
         SELECT ?1, r.last_seq - ?2 + ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?17, ?10, ?11, ?12, ?13, ?14, ?15
           FROM repos r
          WHERE r.repo_id = ?1 AND r.epoch = ?16
            AND NOT EXISTS (
              SELECT 1 FROM ops o
               WHERE o.repo_id = ?1 AND o.epoch = ?4 AND o.op_id = ?5)`,
      ).bind(
        session.repoId,
        chunk.length,
        index + 1,
        restore.to_epoch,
        opId,
        session.deviceId,
        entity.entity,
        entity.entityId,
        verb,
        JSON.stringify(payload),
        `restore:${restore.restore_id}`,
        // `client_seq` is a RECORD of which allocation produced an operation, never an
        // allocator. These rows were not allocated by any device's counter, so the
        // ordinal within the restore is the honest value — and writing a device's real
        // `client_seq` here is precisely the collision the epoch in `op_id` exists to
        // prevent.
        staged + index + 1,
        // Carried from the backup, not from this build. `ops.schema_version` is stored
        // and never interpreted by the server, and a restored operation describes the
        // schema its DATA was written under — not the one the restoring device happens
        // to be running.
        source.schema_version,
        createdAt,
        now,
        restore.from_epoch,
        /**
         * `baseVersion`: null for `create`, and 0 for everything else.
         *
         * The envelope contract requires an integer for every verb except `create`,
         * and 0 is the honest one here: the new epoch has no prior version of
         * anything, so there is no earlier version for a restored `replace` or
         * `delete` to name. Devices hydrate a restored epoch through `/snapshot`,
         * which carries folded state and no `baseVersion` at all, so this value is
         * only ever read by something reading the raw log — and what it should read
         * there is "no prior version", not "this was a create".
         */
        verb === "create" ? null : 0,
      ),
    );
  }

  await env.DB.batch(statements);

  const nowStaged = await stagedCount(env, session.repoId, restore.to_epoch);
  await env.DB.prepare(
    `UPDATE restores SET staged_count = ?3 WHERE repo_id = ?1 AND restore_id = ?2`,
  )
    .bind(session.repoId, restore.restore_id, nowStaged)
    .run();

  log({
    event: "restore.stage",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
    epoch: restore.to_epoch,
    entity_count: nowStaged,
    duration_ms: Date.now() - startedAt,
  });

  return json({
    protocol,
    restoreId: restore.restore_id,
    status: "staging",
    done: false,
    fromEpoch: restore.from_epoch,
    toEpoch: restore.to_epoch,
    entityCount: restore.entity_count,
    staged: nowStaged,
  });
}

/**
 * Phase three: move the repository onto the epoch that is already fully materialised.
 *
 * Two guards, and they refuse different disasters.
 *
 * The FIRST is `epoch = from_epoch` on the update itself, so two commits cannot both
 * apply and a commit cannot apply after somebody else moved the epoch.
 *
 * The SECOND is `guard_seq`. If any operation landed in the OLD epoch after this
 * restore began, that work is in neither the backup being restored nor the
 * pre-restore fold taken at `begin` — committing would discard it with no undo
 * anywhere. The contract's requirement is that a restore "never moves remote state
 * behind a device that has already read past the restore point"; the epoch bump
 * handles the devices, and this handles the work. It refuses rather than merging,
 * because merging a concurrent write into a restored timeline is a conflict
 * resolution nobody asked for and the server is explicitly not trusted to do.
 */
async function commitRestore(
  env: Env,
  session: Session,
  protocol: number,
  repo: RepoRow,
  restore: RestoreRow,
  startedAt: number,
): Promise<Response> {
  if (repo.epoch !== restore.from_epoch) {
    throw new SyncError("epoch_changed", "the repository moved epoch while this restore was staging", {
      currentEpoch: repo.epoch,
    });
  }

  const intruder = await env.DB.prepare(
    `SELECT seq FROM ops
      WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3
      ORDER BY seq LIMIT 1`,
  )
    .bind(session.repoId, restore.from_epoch, restore.guard_seq)
    .first<{ seq: number }>();
  if (intruder) {
    throw new SyncError(
      "conflict",
      "operations were accepted into the current epoch after this restore began. They are " +
        "in neither the backup nor the pre-restore snapshot, so committing would destroy " +
        "them. Take a fresh backup, or start the restore again.",
      { seq: intruder.seq },
    );
  }

  const committedAt = Date.now();
  const [flip] = await env.DB.batch([
    env.DB.prepare(`UPDATE repos SET epoch = ?3 WHERE repo_id = ?1 AND epoch = ?2`).bind(
      session.repoId,
      restore.from_epoch,
      restore.to_epoch,
    ),
    env.DB.prepare(
      `UPDATE restores SET status = 'committed', committed_at = ?3
        WHERE repo_id = ?1 AND restore_id = ?2 AND status = 'staging'`,
    ).bind(session.repoId, restore.restore_id, committedAt),
  ]);

  if ((flip?.meta.changes ?? 0) === 0) {
    throw new SyncError("epoch_changed", "the repository moved epoch before this commit applied", {
      currentEpoch: repo.epoch,
    });
  }

  log({
    event: "restore.commit",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
    epoch: restore.to_epoch,
    entity_count: restore.entity_count,
    duration_ms: Date.now() - startedAt,
  });

  return json({
    protocol,
    restoreId: restore.restore_id,
    status: "committed",
    done: true,
    fromEpoch: restore.from_epoch,
    toEpoch: restore.to_epoch,
    epoch: restore.to_epoch,
    entityCount: restore.entity_count,
    staged: restore.entity_count,
    preRestoreBackupId: restore.pre_restore_backup_id,
  });
}

// ----------------------------------------------------------------------- purge

/**
 * DELETE /v1/repos/{repoId} — destroy this repository's remote state.
 *
 * Every table, including the `repos` row itself, so the next request from any device
 * fails `auth` (its credential row is gone) and a device that still holds a manifest
 * gets `forbidden` on connect rather than silently re-creating the repository —
 * `connect` never auto-creates, which is what makes that safe.
 *
 * DIVERGENCE, and it is worth stating plainly: `docs/sync.md` describes purge as
 * requiring "a separate typed confirmation token", and this route does not read one.
 * The typed confirmation is enforced in `staple cloud purge`, which prints the
 * retention disclosure and demands the repository id typed back before it calls
 * anything — and the deployed client sends this DELETE with no body at all. Moving
 * the confirmation onto the wire is a coordinated client-and-server change rather
 * than something this route can add unilaterally: requiring a token the shipped
 * client does not send would make purge permanently impossible instead of merely
 * unimplemented. Flagged for the follow-up that revisits the client's `unsupported`
 * path.
 *
 * The order of the deletes is deliberate. `devices` goes LAST: while it exists, this
 * request's own credential still authenticates, and if the batch fails halfway the
 * repository is still reachable to try again. Deleting credentials first would, on a
 * partial failure, leave data nobody can reach and nobody can delete.
 */
export async function purgeRepository(
  env: Env,
  session: Session,
  protocol: number,
  startedAt: number,
): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ops WHERE repo_id = ?1`).bind(session.repoId),
    env.DB.prepare(`DELETE FROM leases WHERE repo_id = ?1`).bind(session.repoId),
    env.DB.prepare(`DELETE FROM backups WHERE repo_id = ?1`).bind(session.repoId),
    env.DB.prepare(`DELETE FROM restores WHERE repo_id = ?1`).bind(session.repoId),
    env.DB.prepare(`DELETE FROM repos WHERE repo_id = ?1`).bind(session.repoId),
    env.DB.prepare(`DELETE FROM devices WHERE repo_id = ?1`).bind(session.repoId),
  ]);

  log({
    event: "purge",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
    duration_ms: Date.now() - startedAt,
  });

  return json({ protocol, purged: true });
}
