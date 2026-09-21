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
 * is never a flag on anything, and it requires the repository id typed back in its
 * body, checked here rather than only at the terminal.
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
 *   1. `begin`  — record the current epoch at its head as a `pre-restore` backup (the
 *                 undo), write the audit row, decide `toEpoch = epoch + 1`. Both backups
 *                 are read from the fold checkpoint (`fold-store.ts`), so `begin` first
 *                 folds what the checkpoint lacks of the source's cutoff and of the head,
 *                 and refuses, retryably and changing nothing, while that is more than
 *                 one request can do.
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
 * **Why it is chunked.** A request has 10 ms of CPU and 50 D1 queries on the free plan,
 * and a restore stages one operation per entity, so a single-shot restore would work on a
 * demo repository and fail permanently on a real one. `stage` writes
 * `restoreStageEntities` at a time (200 free, 1,000 paid), no more than `RESTORE_PAGE_WORK` of
 * estimated isolate time, in packed statements, folds them into the new epoch's checkpoint with
 * what the turn has left, and keeps its progress durable in D1 rather than in a request.
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
import { type BackupEntity, forBackup, materializedVerb } from "./fold.js";
import {
  type FoldBudget,
  advanceFold,
  entityCount,
  foldBehind,
  pinMark,
  reachFold,
  restorePage,
  stageWork,
  utf8Bytes,
} from "./fold-store.js";
import { countEscapes } from "./fold-work.js";
import { assertBodySize, readJson } from "./http.js";
import {
  FOLD_WRITE_BYTES,
  PAGE_BYTES,
  PROTOCOL_MAX,
  RESTORE_PAGE_WORK,
  PROTOCOL_MIN,
  ROW_BYTES,
  planOf,
  requestFoldBudget,
  restoreStageEntities,
} from "./limits.js";
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
  /** 'inline' (entities in `state`) or 'fold' (the checkpoint at epoch/cutoff_seq). */
  content: string;
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
  /** Staged rows counted up to `staged_seq`; see `stagedCount`. */
  staged_count: number;
  staged_seq: number | null;
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

  const backup = await captureBackup(env, session, repo, "manual", label, requestFoldBudget(planOf(env)));

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
 * Record the fold of the current epoch at its high-water mark as a backup. Shared by
 * `create` and by the automatic pre-restore capture, because the undo a restore takes must
 * be exactly as good as the backup a human takes deliberately — a weaker one would be a
 * worse undo in the one situation where the undo is the only thing left.
 *
 * ## A row, not a copy
 *
 * The backup's entities are the fold of (`epoch`, `cutoff_seq`), and that fold is already
 * kept: `fold-store.ts` holds every entity at every point the checkpoint has passed, and
 * serves any cutoff exactly. Operations at or below a cutoff never change — the log is
 * append-only and `seq` only climbs — so the fold at this cutoff is fixed the moment the row
 * is written. So a backup is ONE row, and copying the entities into it, as the Worker before
 * this one did, is gone with the fold of the whole log per backup it cost and the 2 MB row
 * it could not outgrow.
 *
 * The checkpoint does have to reach the cutoff first, because what the row records — how
 * many entities, of which kinds, from how many operations — is the fold's, not the log's:
 * two revisions written as one number are one key in the log and two entities in the fold,
 * and a restore stages exactly the fold's. Normally it is within a few hundred operations
 * of the head (every pull moves it on) and this request's budget covers the rest. When it is
 * not — a large log straight after this Worker was deployed — the request refuses with
 * `foldBehind` (`reachFold`), retryable, having moved the fold on by its budget, and
 * nothing is written.
 */
async function captureBackup(
  env: Env,
  session: Session,
  repo: RepoRow,
  kind: "manual" | "pre-restore",
  label: string | null,
  budget: FoldBudget,
): Promise<{
  backupId: string;
  entityCount: number;
  opCount: number;
  schemaVersion: number;
  createdAt: number;
}> {
  await reachFold(env, session.repoId, repo.epoch, repo.last_seq, { budget });
  // Reached, so this is a mark already — unless a concurrent request's step carried the
  // checkpoint past the cutoff, when the tail is folded and written. Either way every restore
  // turn pages the backup in stage order without folding anything on top.
  const summary = await pinMark(env, session.repoId, repo.epoch, repo.last_seq);
  const entities = entityCount(summary);
  const backupId = newId();
  const createdAt = Date.now();

  await env.DB.prepare(
    `INSERT INTO backups
       (repo_id, backup_id, epoch, cutoff_seq, entity_count, op_count, schema_version,
        protocol, kind, created_at, created_by_device, state, content)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'fold')`,
  )
    .bind(
      session.repoId,
      backupId,
      repo.epoch,
      repo.last_seq,
      entities,
      summary.opCount,
      summary.schemaVersion,
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
      protocolForEntities(Object.keys(summary.kinds).map((entity) => ({ entity }))),
      kind,
      createdAt,
      session.deviceId,
      // The label, and how many entities of each kind the fold holds — which is what a
      // restore's vocabulary check reads (`assertRestorableVocabulary`). Never the
      // entities: they are the checkpoint's, at this cutoff.
      JSON.stringify({ label, kinds: summary.kinds }),
    )
    .run();

  return {
    backupId,
    entityCount: entities,
    opCount: summary.opCount,
    schemaVersion: summary.schemaVersion,
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
    `SELECT backup_id, content, epoch, cutoff_seq, entity_count, op_count, schema_version,
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
 * counter, so it is what happened rather than what was recorded as having happened —
 * counted above the restore's `guard_seq`, so it costs what the restore wrote and not a
 * read of the whole log (`stagedCount`).
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
            guard_seq, entity_count, status, staged_count, staged_seq
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

  const staged = await stagedCount(env, session.repoId, restore);
  if (staged < restore.entity_count) {
    return stageRestore(env, session, protocol, repo, restore, staged, startedAt);
  }
  return commitRestore(env, session, protocol, repo, restore, startedAt);
}

/**
 * How much of the new epoch already exists. The authority on progress.
 *
 * Counted from the rows themselves, so it is what happened rather than what was recorded — but
 * not counted again from the start on every turn. Every stage turn records, in the same batch as
 * the rows it writes, how many staged rows there are up to the seq it reserved to
 * (`restores.staged_count` at `restores.staged_seq`, `stageRestore`), so a turn counts only the
 * rows above that: the ones a turn wrote after it, which is none unless a turn is in flight
 * beside this one. Counting every staged row on every turn read the whole restore once per
 * turn — rows read growing with the square of the restore, against the free plan's 5 million a
 * day.
 *
 * A restore begun before `staged_seq` existed has none, and is counted once from `guard_seq`.
 * Above `guard_seq` is every row a restore staged — a stage reserves its seqs after `begin` read
 * the high-water mark — and never the rest of the log; `beginRestore` refuses while the target
 * epoch holds rows from before.
 */
async function stagedCount(env: Env, repoId: string, restore: RestoreRow): Promise<number> {
  const counted = restore.staged_seq === null ? 0 : restore.staged_count;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1 AND seq > ?3 AND epoch = ?2`,
  )
    .bind(repoId, restore.to_epoch, restore.staged_seq ?? restore.guard_seq)
    .first<{ n: number }>();
  return counted + (row?.n ?? 0);
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
    `SELECT backup_id, content, epoch, cutoff_seq, entity_count, op_count, schema_version,
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

  /**
   * A backup kept as a fold is restorable once the checkpoint of its epoch has reached its
   * cutoff: from then on every stage turn reads a bounded page of it. Taking the backup
   * usually got it there (`captureBackup`); when it did not — a large log straight after
   * this Worker was deployed — this request moves it on by its budget, and if that is not
   * enough it refuses BEFORE anything is changed: no undo, no audit row, no staged row.
   * The refusal is retryable and carries how far the fold has got, and each attempt moves
   * it further, so asking again finishes.
   */
  const budget: FoldBudget = requestFoldBudget(planOf(env));
  if (source.content === "fold") {
    await reachFold(env, session.repoId, source.epoch, source.cutoff_seq, { budget });
  }
  // And the undo's: the current epoch at its head, which `captureBackup` needs reached.
  // Here, before the vocabulary claim below, so a refusal leaves the repository row as it was.
  try {
    await reachFold(env, session.repoId, repo.epoch, repo.last_seq, { budget });
  } catch (err) {
    /**
     * One progress for the two folds, so `foldedSeq` still climbs from one refusal to the next —
     * a client stops asking the first time it does not (`whileFolding`, src/core/cloud/client.ts).
     * A backup of an older epoch is folded first, and every operation of the current epoch is
     * above its cutoff: seqs only climb, and a restore commits only when nothing landed in the
     * old epoch after it began. So once the source is reached, the current epoch's progress
     * counts from the source's cutoff — even a request whose budget the source used up, and a
     * current epoch whose checkpoint has no mark yet.
     */
    if (err instanceof SyncError && typeof err.detail.foldedSeq === "number" && source.content === "fold" && source.epoch !== repo.epoch) {
      throw foldBehind(Math.max(err.detail.foldedSeq, source.cutoff_seq), repo.last_seq);
    }
    throw err;
  }

  /**
   * The epoch this restore will fill must be empty.
   *
   * It is, unless a restore's `restores` row was deleted by hand and its staged operations
   * were not (worker/README.md, "Abandoning a restore", deletes both together). Rows left
   * like that used to count as this restore's progress, so it skipped that many entities
   * and committed as though it had staged them all. Refused instead, before anything is
   * changed, so the progress count above `guard_seq` is exactly the rows this restore wrote.
   * One scan per restore, and only once the fold is ready.
   */
  const orphaned = await env.DB.prepare(`SELECT seq FROM ops WHERE repo_id = ?1 AND epoch = ?2 LIMIT 1`)
    .bind(session.repoId, repo.epoch + 1)
    .first<{ seq: number }>();
  if (orphaned) {
    throw new SyncError(
      "conflict",
      `epoch ${repo.epoch + 1} already holds operations from a restore that was abandoned without ` +
        "removing them. Remove them first (worker/README.md, \"Abandoning a restore\"). Nothing was changed.",
      { epoch: repo.epoch + 1 },
    );
  }

  await assertRestorableVocabulary(env, session.repoId, backupId, repo);

  const undo = await captureBackup(env, session, repo, "pre-restore", null, budget);

  const restoreId = newId();
  const toEpoch = repo.epoch + 1;
  /**
   * The new epoch's checkpoint starts at `guard_seq`: a mark there, holding nothing, is true —
   * the epoch has no operation at or below it (checked above) and every row this restore
   * stages is reserved above it. Without it the first fold of the new epoch would read from
   * seq 0, through every operation of every older epoch, to find its own. Any fold rows the
   * epoch already has are from a restore abandoned after it staged, whose operations are
   * gone, so they describe nothing and are cleared first. All of it in one batch with the
   * audit row, so a restore never exists without its floor.
   */
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM fold_versions WHERE repo_id = ?1 AND epoch = ?2`).bind(
      session.repoId,
      toEpoch,
    ),
    env.DB.prepare(`DELETE FROM fold_marks WHERE repo_id = ?1 AND epoch = ?2`).bind(session.repoId, toEpoch),
    env.DB.prepare(
      `INSERT INTO fold_marks (repo_id, epoch, seq, op_count, schema_version, kinds)
       VALUES (?1, ?2, ?3, 0, 0, '{}')`,
    ).bind(session.repoId, toEpoch, repo.last_seq),
    env.DB.prepare(
      `INSERT INTO restores
         (repo_id, restore_id, from_backup_id, pre_restore_backup_id, from_epoch, to_epoch,
          guard_seq, entity_count, staged_count, status, device_id, actor, began_at, committed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 'staging', ?9, ?10, ?11, NULL)`,
    ).bind(
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
    ),
  ]);

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
  // An inline backup is counted over its entities in SQL; a fold backup from the counts
  // of each kind it recorded when it was taken. Neither is parsed whole in the Worker.
  const counted = await env.DB.prepare(
    `SELECT CASE WHEN b.content = 'fold' THEN b.state END AS summary,
            (SELECT COUNT(*) FROM json_each(b.state, '$.entities')) AS total,
            (SELECT COALESCE(SUM(json_extract(e.value, '$.entity') IN (SELECT value FROM json_each(?3))), 0)
               FROM json_each(b.state, '$.entities') e) AS registry
       FROM backups b
      WHERE b.repo_id = ?1 AND b.backup_id = ?2`,
  )
    .bind(repoId, backupId, registryEntitiesJson())
    .first<{ summary: string | null; total: number; registry: number }>();
  let total = counted?.total ?? 0;
  let registry = counted?.registry ?? 0;
  if (typeof counted?.summary === "string") {
    const kinds = (JSON.parse(counted.summary) as { kinds?: Record<string, number> }).kinds ?? {};
    const registryKinds = new Set(JSON.parse(registryEntitiesJson()) as string[]);
    total = 0;
    registry = 0;
    for (const [kind, count] of Object.entries(kinds)) {
      total += count;
      if (registryKinds.has(kind)) registry += count;
    }
  }
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
 * The next entities a restore stages, in the order a snapshot pages them.
 *
 * An INLINE backup — every backup a Worker before the checkpoint took — holds them in its
 * `state`, and the chunk is the next slice of that array, as it always was. A FOLD backup
 * holds them in the checkpoint at its epoch and cutoff, and the chunk is the next page of
 * that fold after the last entity already staged: the staged rows are the authority on
 * progress, and their newest seq names the entity the last turn ended on. `beginRestore`
 * refused to start until the checkpoint had reached the cutoff, so the page is bounded.
 */
async function nextChunk(
  env: Env,
  repoId: string,
  restore: RestoreRow,
  source: { content: string; epoch: number; cutoff_seq: number; state: string | null },
  staged: number,
  budget: FoldBudget,
): Promise<BackupEntity[]> {
  const size = restoreStageEntities(planOf(env));
  const room = Math.min(RESTORE_PAGE_WORK, budget.work ?? RESTORE_PAGE_WORK);
  if (source.content !== "fold") {
    // At most `size` entities, no more than `PAGE_BYTES` of their state and no more than the turn's
    // room to stage them (`stageWork`) — at least one.
    const parsed = JSON.parse(source.state ?? "{}") as { entities?: BackupEntity[] };
    const chunk: BackupEntity[] = [];
    let bytes = 0;
    let work = 0;
    for (const entity of restoreOrder(parsed.entities ?? []).slice(staged, staged + size)) {
      const text = JSON.stringify(entity.state);
      const weight = utf8Bytes(text);
      const cost = stageWork(weight, countEscapes(text));
      if (chunk.length > 0 && (bytes + weight > PAGE_BYTES || work + cost > room)) break;
      chunk.push(entity);
      bytes += weight;
      work += cost;
    }
    return chunk;
  }
  // Normally a no-op: `beginRestore` folded the source to its cutoff and the backup made it a
  // mark, and a checkpoint only moves forward. Not after an operator cleared it mid-restore
  // (README, "The fold checkpoint"), when this folds it back a turn at a time instead of
  // wedging the restore.
  await reachFold(env, repoId, source.epoch, source.cutoff_seq, { budget });
  await pinMark(env, repoId, source.epoch, source.cutoff_seq);
  const last = await env.DB.prepare(
    `SELECT entity, entity_id FROM ops WHERE repo_id = ?1 AND seq > ?3 AND epoch = ?2 ORDER BY seq DESC LIMIT 1`,
  )
    .bind(repoId, restore.to_epoch, restore.guard_seq)
    .first<{ entity: string; entity_id: string }>();
  const after = last ? entityKey(last.entity, last.entity_id) : null;
  const page = await restorePage(env, repoId, source.epoch, source.cutoff_seq, after, size, PAGE_BYTES, {
    work: Math.min(RESTORE_PAGE_WORK, budget.work ?? RESTORE_PAGE_WORK),
    atLeastOne: budget.folded !== true,
  });
  // Folding the backup's epoch took this turn's room, so it stages nothing and says so; asked again,
  // there is nothing left to fold and the turn stages.
  if (page.length === 0 && budget.folded === true) throw foldBehind(source.cutoff_seq, source.cutoff_seq);
  return page.map(forBackup);
}

/**
 * Fold what earlier turns staged, before this one stages more or commits.
 *
 * A turn folds what it staged with what its own budget has left (`stageRestore`), and that is
 * usually enough — but staging an entity and folding the operation it became cost about the same,
 * so a turn whose staging was expensive can leave a little behind. Left alone, "the restored epoch
 * is folded by the time it goes live" would stop being true and the first device to bootstrap onto
 * the new epoch would wait for it. So a turn folds the backlog first and, when its budget cannot
 * finish it, refuses retryably with how far it got: the client asks again while that climbs
 * (`whileFolding`, `src/core/cloud/client.ts`), and no turn is ever asked to fold more than one
 * budget.
 */
async function foldWhatWasStaged(env: Env, repoId: string, restore: RestoreRow, budget: FoldBudget): Promise<void> {
  const staged = await env.DB.prepare(
    `SELECT seq FROM ops WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 ORDER BY seq DESC LIMIT 1`,
  )
    .bind(repoId, restore.to_epoch, restore.guard_seq)
    .first<{ seq: number }>();
  if (!staged) return;
  await reachFold(env, repoId, restore.to_epoch, staged.seq, { budget });
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
/**
 * The order a restore stages a backup's entities in: the order their claims sat in the log
 * the backup was folded from (`BackupEntity.claimSeq`). The new epoch's log is then the old
 * one's order, so a device reading it — or hydrating from its fold — gives a contested
 * identifier or slug to the claim the old epoch gave it to. Staged in the order the backup
 * was stored (by key), the later of two claims on one number could come first, and a fresh
 * device gave the number to it. What the log holds no claim of — a built-in only ever edited —
 * goes first, as it was there before anything; a vocabulary's order goes where it was last
 * written, after the entries it names. A backup from before `claimSeq` keeps its stored order:
 * a restore of it may already be part-way, staged by position.
 */
export function restoreOrder(entities: readonly BackupEntity[]): BackupEntity[] {
  if (!entities.every((entity) => Object.prototype.hasOwnProperty.call(entity, "claimSeq"))) return [...entities];
  return entities
    .map((entity, position) => ({ entity, position }))
    .sort((a, b) => (a.entity.claimSeq ?? Number.NEGATIVE_INFINITY) - (b.entity.claimSeq ?? Number.NEGATIVE_INFINITY) || a.position - b.position)
    .map(({ entity }) => entity);
}

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
    `SELECT content, epoch, cutoff_seq, schema_version,
            CASE WHEN content = 'inline' THEN state END AS state
       FROM backups WHERE repo_id = ?1 AND backup_id = ?2`,
  )
    .bind(session.repoId, restore.from_backup_id)
    .first<{ content: string; epoch: number; cutoff_seq: number; schema_version: number; state: string | null }>();
  if (!source) throw new SyncError("not_found", "the backup being restored no longer exists");

  const budget: FoldBudget = requestFoldBudget(planOf(env));
  await foldWhatWasStaged(env, session.repoId, restore, budget);
  const chunk = await nextChunk(env, session.repoId, restore, source, staged, budget);
  if (chunk.length === 0) {
    throw new SyncError("conflict", "the backup holds fewer entities than the restore expects");
  }

  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const statements = [
    env.DB.prepare(
      `UPDATE repos SET last_seq = last_seq + ?3 WHERE repo_id = ?1 AND epoch = ?2 RETURNING last_seq`,
    ).bind(session.repoId, restore.from_epoch, chunk.length),
  ];

  /**
   * The chunk's operations, packed into as few statements as a bound value's size allows —
   * one statement per entity was the free plan's 50-queries ceiling capping a turn at 25
   * entities, which put a restore of more than 25,000 entities past the client's
   * 1,000-turn guard. Each row is exactly what one statement per entity wrote. A pack is
   * closed at `FOLD_WRITE_BYTES`, because a payload escaped inside it can be twice its own
   * size against D1's 2,000,000-byte bound value, and an operation too large to share one
   * is written alone with its columns bound as they are (`fold-store.ts`, `writeVersions`).
   */
  let packed: string[] = [];
  let bytes = 0;
  // What reading and staging the chunk cost, which the fold of it below does not get to spend again.
  let spent = 0;
  const flush = () => {
    if (packed.length === 0) return;
    statements.push(
      env.DB.prepare(
        `INSERT INTO ops
           (repo_id, seq, epoch, op_id, device_id, entity, entity_id, verb, base_version,
            payload, actor, client_seq, schema_version, created_at, server_ts)
         SELECT ?1, r.last_seq - ?2 + json_extract(j.value, '$.n'), ?3, json_extract(j.value, '$.o'), ?4,
                json_extract(j.value, '$.e'), json_extract(j.value, '$.i'), json_extract(j.value, '$.v'),
                json_extract(j.value, '$.b'), json_extract(j.value, '$.p'), json_extract(j.value, '$.a'),
                json_extract(j.value, '$.c'), ?5, json_extract(j.value, '$.t'), ?6
           FROM repos r, json_each(?8) j
          WHERE r.repo_id = ?1 AND r.epoch = ?7
            AND NOT EXISTS (
              SELECT 1 FROM ops o
               WHERE o.repo_id = ?1 AND o.epoch = ?3 AND o.op_id = json_extract(j.value, '$.o'))`,
      ).bind(
        session.repoId,
        chunk.length,
        restore.to_epoch,
        session.deviceId,
        // Carried from the backup, not from this build. `ops.schema_version` is stored
        // and never interpreted by the server, and a restored operation describes the
        // schema its DATA was written under — not the one the restoring device happens
        // to be running.
        source.schema_version,
        now,
        restore.from_epoch,
        `[${packed.join(",")}]`,
      ),
    );
    packed = [];
    bytes = 0;
  };

  for (let index = 0; index < chunk.length; index += 1) {
    const entity = chunk[index]!;
    const { verb, payload } = materializedVerb(entity);
    const opId = await opIdHex(
      `${session.repoId}\n${restore.to_epoch}\nrestore\n${restore.restore_id}\n` +
        `${entityKey(entity.entity, entity.entityId)}`,
    );
    const item = JSON.stringify({
      // The slot in the window the UPDATE above reserved: the rows take its seqs in order.
      n: index + 1,
      o: opId,
      e: entity.entity,
      i: entity.entityId,
      v: verb,
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
      b: verb === "create" ? null : 0,
      // Inside a JSON string, so `json_extract` hands SQLite exactly these bytes.
      p: JSON.stringify(payload),
      // The original creator when the backup kept one (`fold.ts`, `createdBy`), so the new
      // epoch attributes what it restores as the old one did; the restore otherwise.
      a: entity.createdBy ?? `restore:${restore.restore_id}`,
      // `client_seq` is a RECORD of which allocation produced an operation, never an
      // allocator. These rows were not allocated by any device's counter, so the
      // ordinal within the restore is the honest value — and writing a device's real
      // `client_seq` here is precisely the collision the epoch in `op_id` exists to
      // prevent.
      c: staged + index + 1,
      // The entity's own create time when the backup recorded one, so the new epoch's
      // fold hands a hydrating device the time the thing was written rather than the
      // moment it was restored (`fold.ts`, `BackupEntity.createdAt`).
      t: entity.createdAt ?? createdAt,
    });
    const size = utf8Bytes(item);
    spent += stageWork(size, countEscapes(item));
    if (size > FOLD_WRITE_BYTES) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO ops
             (repo_id, seq, epoch, op_id, device_id, entity, entity_id, verb, base_version,
              payload, actor, client_seq, schema_version, created_at, server_ts)
           SELECT ?1, r.last_seq - ?2 + ?8, ?3, ?9, ?4, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?5, ?17, ?6
             FROM repos r
            WHERE r.repo_id = ?1 AND r.epoch = ?7
              AND NOT EXISTS (SELECT 1 FROM ops o WHERE o.repo_id = ?1 AND o.epoch = ?3 AND o.op_id = ?9)`,
        ).bind(
          session.repoId,
          chunk.length,
          restore.to_epoch,
          session.deviceId,
          source.schema_version,
          now,
          restore.from_epoch,
          index + 1,
          opId,
          entity.entity,
          entity.entityId,
          verb,
          verb === "create" ? null : 0,
          JSON.stringify(payload),
          entity.createdBy ?? `restore:${restore.restore_id}`,
          staged + index + 1,
          entity.createdAt ?? createdAt,
        ),
      );
      continue;
    }
    if (bytes > 0 && bytes + size > FOLD_WRITE_BYTES) flush();
    packed.push(item);
    bytes += size;
  }
  flush();

  /**
   * Progress, counted in the same transaction as the rows: the staged rows up to the seq this turn
   * reserved to, as the count at the last recorded seq plus the rows above it (`stagedCount`). It
   * only moves forward, so a turn that ran beside this one and recorded further is left as it is.
   */
  statements.push(
    env.DB.prepare(
      `UPDATE restores
          SET staged_count = CASE WHEN staged_seq IS NULL THEN 0 ELSE staged_count END
                + (SELECT COUNT(*) FROM ops o
                    WHERE o.repo_id = ?1 AND o.epoch = restores.to_epoch
                      AND o.seq > COALESCE(restores.staged_seq, restores.guard_seq)
                      AND o.seq <= (SELECT last_seq FROM repos WHERE repo_id = ?1)),
              staged_seq = (SELECT last_seq FROM repos WHERE repo_id = ?1)
        WHERE repo_id = ?1 AND restore_id = ?2
          AND (staged_seq IS NULL OR staged_seq < (SELECT last_seq FROM repos WHERE repo_id = ?1))`,
    ).bind(session.repoId, restore.restore_id),
  );

  const [reserved] = await env.DB.batch<{ last_seq: number }>(statements);

  /**
   * Fold what this turn staged, so the new epoch's checkpoint is complete by the commit and
   * every device re-bootstrapping onto it is served its snapshot at once, not told to wait
   * while the whole epoch is folded. Twice a turn's worth folds this turn's rows and catches
   * up any a failed turn left behind. The seqs a turn reserved are above every row already in
   * the new epoch and committed with them, so the mark it writes claims only rows that exist.
   * Nothing reads the new epoch until the flip.
   */
  const stagedTo = reserved?.results[0]?.last_seq;
  if (typeof stagedTo === "number") {
    await advanceFold(env, session.repoId, restore.to_epoch, stagedTo, {
      budget: {
        remaining: 2 * restoreStageEntities(planOf(env)),
        bytes: 2 * (PAGE_BYTES + ROW_BYTES),
        work: Math.max(0, (budget.work ?? 0) - spent),
        folded: true,
      },
    });
  }

  const recorded = await env.DB.prepare(
    `SELECT staged_count, staged_seq FROM restores WHERE repo_id = ?1 AND restore_id = ?2`,
  )
    .bind(session.repoId, restore.restore_id)
    .first<{ staged_count: number; staged_seq: number | null }>();
  const nowStaged = await stagedCount(env, session.repoId, {
    ...restore,
    staged_count: recorded?.staged_count ?? 0,
    staged_seq: recorded?.staged_seq ?? null,
  });

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

  // Everything staged is folded before the epoch goes live, or this turn refuses and the next
  // carries on: what makes "the restored epoch is folded by the time it goes live" true.
  await foldWhatWasStaged(env, session.repoId, restore, requestFoldBudget(planOf(env)));

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
 * **It requires the typed confirmation on the wire** (STA-256): the body is
 * `{ "confirm": "<repositoryId>" }`, and `confirm` must be exactly the repository the
 * credential belongs to. `staple cloud purge` prints the retention disclosure and
 * demands the id typed back, and sends what was typed. Checked here too, because a
 * bearer credential alone is not the confirmation the product promises: any holder of
 * a device token could otherwise destroy the repository with a bare DELETE, which is
 * exactly what every client released before this change sends. Those clients are
 * refused with a message telling the person to update, and nothing is deleted.
 *
 * Refused as `validation` with a `confirmation` detail of `missing` or `mismatch`:
 * non-retryable in every released client, and the same code restore answers a bad
 * `confirm` with. A new code would have mapped to retryable `unavailable` on every
 * installed build. `worker/test/purge-fixture.ts` pins both bodies for this suite and
 * for the fake the client is tested against.
 *
 * The order of the deletes is deliberate. `devices` goes LAST: while it exists, this
 * request's own credential still authenticates, and if the batch fails halfway the
 * repository is still reachable to try again. Deleting credentials first would, on a
 * partial failure, leave data nobody can reach and nobody can delete.
 */
export async function purgeRepository(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  startedAt: number,
): Promise<Response> {
  const confirm = await readPurgeConfirmation(request, env);
  if (confirm === undefined) {
    throw new SyncError(
      "validation",
      "purge refused: the request carried no typed confirmation, and this service requires " +
        "the repository id in `confirm`. Nothing was deleted. Update staple, then run " +
        "`staple cloud purge --confirm <repositoryId>` again.",
      { confirmation: "missing" },
    );
  }
  if (confirm !== session.repoId) {
    // Never echoes what was sent: a caller who put the wrong thing in `confirm` may have
    // put something in it that should not be reflected into a response or a log.
    throw new SyncError(
      "validation",
      "purge refused: `confirm` does not match this repository's id. Nothing was deleted.",
      { confirmation: "mismatch" },
    );
  }

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ops WHERE repo_id = ?1`).bind(session.repoId),
    env.DB.prepare(`DELETE FROM leases WHERE repo_id = ?1`).bind(session.repoId),
    env.DB.prepare(`DELETE FROM backups WHERE repo_id = ?1`).bind(session.repoId),
    env.DB.prepare(`DELETE FROM restores WHERE repo_id = ?1`).bind(session.repoId),
    env.DB.prepare(`DELETE FROM fold_versions WHERE repo_id = ?1`).bind(session.repoId),
    env.DB.prepare(`DELETE FROM fold_marks WHERE repo_id = ?1`).bind(session.repoId),
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

/**
 * The purge's `confirm`, or `undefined` when the request carries none.
 *
 * "None" is three shapes, and all three are the same answer: no body at all (what every
 * client released before STA-256 sends), an empty body, and a JSON object without the
 * key. Anything else goes through the ordinary body rules.
 *
 * The router's body-size check covers POST, PUT and PATCH, and deliberately not DELETE:
 * a bare DELETE sends no `Content-Length`, and requiring one there would refuse every
 * revoke and backup delete. So the cap is applied here, from the header and before the
 * body is read, the same way a push gets it — a purge should not be the one route where
 * the Worker parses a body of any size to find one field.
 */
async function readPurgeConfirmation(request: Request, env: Env): Promise<unknown> {
  if (request.body === null) return undefined;
  if (request.headers.get("Content-Length") === "0") return undefined;
  assertBodySize(request, planOf(env));
  const body = await readJson(request);
  return body.confirm;
}
