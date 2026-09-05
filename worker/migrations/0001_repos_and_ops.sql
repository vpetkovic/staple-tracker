-- 0001_repos_and_ops.sql
--
-- The operation log and the per-repository counters that order it.
--
-- These are the WORKER's D1 migrations and are numbered independently of the
-- workspace SQLite migrations in `src/core/migrations/workspace`. That series is
-- heading for `010`; this one starts at `0001` and always will. They describe two
-- different databases and share nothing but a project.

-- One row per connected repository. Everything that must be globally serialized
-- for a repository is a counter on this row, so a single `UPDATE ... SET c = c + N`
-- inside a batch is the whole of the concurrency control. D1 is backed by a single
-- Durable Object and processes queries one at a time, and `batch()` is a real SQL
-- transaction, so this is race-free without any coordinator in front.
CREATE TABLE repos (
  repo_id            TEXT    PRIMARY KEY,

  -- Bumped by a restore. A discontinuity, never a version. Non-truncating: the old
  -- operations stay and `last_seq` keeps climbing, so `seq` is a permanent
  -- identifier that is never reused within a repository's lifetime.
  epoch              INTEGER NOT NULL DEFAULT 1,

  -- The monotonic high-water mark. NEVER recomputed from MAX(ops.seq): deriving it
  -- would let compaction or tombstone removal rewind it, and every cursor in the
  -- fleet is a promise that it cannot.
  last_seq           INTEGER NOT NULL DEFAULT 0,

  -- Monotonic fencing-token source for leases. Separate from `last_seq` because a
  -- lease is not an operation, and shares its one property that matters: it only
  -- ever increases, so a stale token is always recognisably stale.
  last_fencing_token INTEGER NOT NULL DEFAULT 0,

  -- SHA-256 of the repository enrollment secret. The bearer that `POST /connect`
  -- accepts when a device has no credential yet. Only the hash is stored; see
  -- 0002 for the same discipline applied to device tokens.
  enroll_sha256      BLOB,

  created_at         INTEGER NOT NULL
) STRICT;

-- The ordered operation log. One row per accepted operation, per epoch.
CREATE TABLE ops (
  repo_id        TEXT    NOT NULL,

  -- Server-assigned total order. Strictly increasing, NOT dense: slots are reserved
  -- for a whole batch before the rows are written, so an operation that turns out to
  -- be a duplicate leaves its reserved slot unused. `...1039, 1041...` is correct.
  seq            INTEGER NOT NULL,

  epoch          INTEGER NOT NULL,

  -- Client-derived, deterministic, opaque to the server. Never parsed here.
  op_id          TEXT    NOT NULL,

  device_id      TEXT    NOT NULL,
  entity         TEXT    NOT NULL,
  entity_id      TEXT    NOT NULL,
  verb           TEXT    NOT NULL,

  -- The entity's local version immediately before the mutation; NULL for `create`.
  -- Stored and returned verbatim. The server does not detect conflicts — conflict
  -- detection is field-scoped and belongs to the applying device, which is the only
  -- party that knows what its own local version is.
  base_version   INTEGER,

  -- The envelope payload, verbatim JSON. Only the fields the mutation changed.
  -- Stored as received: unknown fields are preserved and re-emitted, which is what
  -- lets a mixed-version fleet round-trip without an older build deleting a newer
  -- one's data.
  payload        TEXT    NOT NULL,

  actor          TEXT    NOT NULL,
  client_seq     INTEGER NOT NULL,

  -- The workspace migration number the operation was stamped with. Stored, never
  -- interpreted. A device receiving a schema it does not understand refuses with
  -- `schema_ahead`; that check belongs to the device, which knows what it can apply.
  schema_version INTEGER NOT NULL,

  -- The client's own timestamp, ISO-8601, as sent. Metadata only: recorded, used to
  -- break ties where a tie-break is needed, and NEVER trusted for ordering or expiry.
  created_at     TEXT    NOT NULL,

  -- The server clock at acceptance. The only clock with any authority.
  server_ts      INTEGER NOT NULL,

  PRIMARY KEY (repo_id, seq)
) WITHOUT ROWID, STRICT;

-- The idempotency key, and the single most important line in this file.
--
-- SCOPED BY EPOCH, deliberately. `opId` is derived from
-- sha256(repoId, epoch, deviceId, clientSeq). `deviceId` lives in machine config and
-- survives a client-side database rebuild; `clientSeq` lives only in the workspace
-- database, which a re-bootstrap rebuilds from zero. An epoch bump forces exactly
-- that re-bootstrap and is explicitly non-truncating, so the pre-restore operations
-- are still sitting in this table.
--
-- Without `epoch` in this index, a restored client re-mints ids identical to its own
-- pre-restore operations, the dedupe absorbs genuinely new work as a duplicate, and
-- the push response hands back the seq of the ORIGINAL application — which the client
-- reads as an acknowledgement. Silent data loss, in precisely the restore path the
-- epoch mechanism exists to make safe.
--
-- The amended derivation already makes cross-epoch collisions impossible. This index
-- is here anyway, because a client on an older build or one that gets the derivation
-- wrong must be rejected by the database rather than silently deduplicated into data
-- loss. Defense in depth on the side where the damage is unrecoverable.
CREATE UNIQUE INDEX ops_op_id ON ops (repo_id, epoch, op_id);
