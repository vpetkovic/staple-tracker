-- 0004_backups_and_restores.sql
--
-- Backup is disaster recovery. It is NOT convergence, and nothing in this file is
-- read by push, pull, snapshot or leases. That separation is the point: creating,
-- retaining or deleting a backup must not be able to move a cursor, and the cheapest
-- way to guarantee that is for the convergence path to have no reason to look here.
--
-- Contract: `docs/sync.md`, "Backup, disconnect and purge are three different things".

-- The server-side half of the third consent.
--
-- `docs/sync.md` grants backup with "`sync.backup = true` in machine config, plus a
-- server-side flag". The machine-local half is per-device and lives in the connection
-- record; this half is per-repository and is what stops a device that merely holds a
-- credential from creating backups because its own config file said it could. Both
-- must be true. Defaulting to 0 means an existing repository does not acquire the
-- consent by being migrated.
ALTER TABLE repos ADD COLUMN backup_enabled INTEGER NOT NULL DEFAULT 0;

-- A point-in-time fold of the operation log.
--
-- WHY THE FOLD AND NOT THE OPERATIONS. A backup that stored a range of `ops` rows
-- would be a second copy of the log, and restoring it would mean replaying rows whose
-- `op_id`s already exist — straight into the dedupe index that exists to absorb
-- exactly that. Storing the FOLD instead means a restore materialises fresh
-- operations with fresh ids, which is the only shape that can be re-applied at all.
--
-- It is also the same fold `GET /snapshot` computes, so a restored epoch hydrates
-- through the ordinary bootstrap path with no special case anywhere in the client.
CREATE TABLE backups (
  repo_id           TEXT    NOT NULL,
  backup_id         TEXT    NOT NULL,

  -- The epoch the fold was taken FROM. A backup is only meaningful against the
  -- timeline it was folded from, and restoring it creates a new one; both numbers are
  -- recorded so an audit can say which timeline a repository is actually on.
  epoch             INTEGER NOT NULL,

  -- The `seq` the fold was pinned at. Everything at or below this is in `state`;
  -- everything above it is not, and a restore is exactly the decision to discard it.
  cutoff_seq        INTEGER NOT NULL,

  entity_count      INTEGER NOT NULL,
  op_count          INTEGER NOT NULL,

  -- The highest workspace schema version seen in the folded operations. Stored, never
  -- interpreted here — the same discipline as `ops.schema_version`. A device refuses a
  -- backup it is too old to apply; the server has no opinion, because it has no
  -- migrations and cannot have one.
  schema_version    INTEGER NOT NULL,

  -- The wire protocol in force when the fold was taken. This one the server DOES
  -- check on restore, because the envelope shape it must materialise is protocol's
  -- business and the server is the party writing those rows.
  protocol          INTEGER NOT NULL,

  -- 'manual'      — a human ran `staple cloud backup create`
  -- 'pre-restore' — taken automatically, before a restore mutated anything
  --
  -- The distinction is not cosmetic. A pre-restore backup is the undo, so retention
  -- must never treat it as an ordinary one, and a human listing backups after a bad
  -- restore has to be able to see which row is the way back.
  kind              TEXT    NOT NULL,

  created_at        INTEGER NOT NULL,
  created_by_device TEXT    NOT NULL,

  -- The folded state, verbatim JSON: an array of the same entity objects
  -- `GET /snapshot` returns. Kept whole rather than one row per entity because a
  -- backup is read all-or-nothing and a per-entity table would let a half-deleted
  -- backup exist, which is a restorable object that restores to nonsense.
  state             TEXT    NOT NULL,

  PRIMARY KEY (repo_id, backup_id)
) STRICT;

-- Listing is always "this repository's backups, newest first". The primary key orders
-- by `backup_id`, which is a uuid and therefore orders by nothing useful.
CREATE INDEX backups_created_at ON backups (repo_id, created_at DESC);

-- The audit record. One row per restore ATTEMPT, not per successful restore.
--
-- An abandoned restore is the interesting one — it means somebody pointed a loaded
-- weapon at a repository and then stopped — so the row is written at `begin`, before
-- anything is staged, and is updated in place rather than being deleted on failure.
CREATE TABLE restores (
  repo_id                TEXT    NOT NULL,
  restore_id             TEXT    NOT NULL,

  -- What was restored, and the undo for it. `pre_restore_backup_id` is NOT NULL
  -- because a restore that could not take one must not have started.
  from_backup_id         TEXT    NOT NULL,
  pre_restore_backup_id  TEXT    NOT NULL,

  -- The timeline before, and the one this restore creates. `to_epoch` is decided at
  -- `begin` and every staged row is stamped with it, so the value is known long
  -- before the epoch actually moves.
  from_epoch             INTEGER NOT NULL,
  to_epoch               INTEGER NOT NULL,

  -- The `repos.last_seq` at `begin`. The commit refuses if any operation landed in
  -- the OLD epoch above this mark: that work is not in the backup and not in the
  -- pre-restore fold either, so committing over it would destroy it with no undo.
  guard_seq              INTEGER NOT NULL,

  -- How many entities this restore must materialise, and how many it has. Staging is
  -- chunked across requests against the free plan's 50-queries-per-invocation
  -- ceiling, so progress has to be durable rather than held in a request.
  entity_count           INTEGER NOT NULL,
  staged_count           INTEGER NOT NULL DEFAULT 0,

  -- 'staging'   — rows are being written into `to_epoch`, invisible to every device
  -- 'committed' — the epoch moved; the fleet re-bootstraps
  -- 'abandoned' — explicitly given up; the staged rows were removed
  --
  -- There is no 'failed'. A staging that simply stops stays 'staging' forever and is
  -- visible in this table as exactly that, which is the honest record of what
  -- happened and is resumable.
  status                 TEXT    NOT NULL,

  device_id              TEXT    NOT NULL,
  actor                  TEXT,
  began_at               INTEGER NOT NULL,
  committed_at           INTEGER,

  PRIMARY KEY (repo_id, restore_id)
) STRICT;

-- "Is a restore already in flight for this repository" is asked at the start of every
-- begin, and is the check that stops two concurrent restores from interleaving their
-- staged rows into one incoherent epoch.
CREATE INDEX restores_status ON restores (repo_id, status);
