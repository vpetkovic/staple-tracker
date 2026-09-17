-- 0006_fold_checkpoint.sql
--
-- The fold, kept: a checkpoint that snapshot, backup and restore read, advanced in bounded
-- steps. ADDITIVE ONLY: two new tables and one new column with a default. Nothing existing
-- is rewritten, and a database migrated from 0005 works at once — the fold of every epoch
-- starts with no marks and is built from `ops` the first time something needs it.
--
-- Why: the Worker folded the whole log inside one request and refused past 20,000
-- operations, so a repository that size could not be snapshotted, backed up or restored.
-- worker/src/fold-store.ts explains the design; worker/README.md, "The fold checkpoint",
-- gives the operator's view.

-- One row per entity per fold step that changed it: the entity as the fold holds it at the
-- end of that step. `seq` is the last operation in the step that changed it, so an entity
-- at a mark M is its newest row with `seq <= M`. Rows are never updated: a row is a function
-- of the log alone, and two steps that compute it compute the same bytes.
CREATE TABLE fold_versions (
  repo_id      TEXT    NOT NULL,
  epoch        INTEGER NOT NULL,

  -- The entity key `"<entity> <entityId>"`, encoded so that SQLite's byte order is the
  -- JavaScript string order a snapshot pages in (fold-store.ts, `foldOrder`).
  ord          TEXT    NOT NULL,
  seq          INTEGER NOT NULL,

  entity       TEXT    NOT NULL,
  entity_id    TEXT    NOT NULL,
  -- Operations folded into the entity: a hydrating client's initial version.
  version      INTEGER NOT NULL,
  -- The tombstone's server time, or NULL.
  deleted_at   INTEGER,
  -- The seq of the entity's own last operation. Not always `seq`: re-creating a status
  -- rewrites its vocabulary's `@order` (fold.ts, `forgetPlace`) without an operation on it.
  last_seq     INTEGER NOT NULL,
  -- 1 when the last surviving write was a `replace`.
  superseded   INTEGER NOT NULL,
  -- JSON, exactly as `JSON.stringify` wrote it, so a read returns the same key order.
  state        TEXT    NOT NULL,
  field_writes TEXT    NOT NULL,
  created_seq  INTEGER,
  created_at   TEXT,
  created_by   TEXT,
  -- Where a restore stages the entity: `claimSeq` (fold.ts), the seq of its last claim on an
  -- identifier, slug or order, else its create — 0 when the log holds neither. A restore of a
  -- backup pages the fold in (stage_order, ord), which is `restoreOrder` (backups.ts).
  stage_order  INTEGER NOT NULL,

  PRIMARY KEY (repo_id, epoch, ord, seq)
) WITHOUT ROWID, STRICT;

-- A restore's page: the entities after the last one it staged, in stage order.
CREATE INDEX fold_versions_stage ON fold_versions (repo_id, epoch, stage_order, ord, seq);

-- The seq each fold step ended at, with the fold's counts there. A mark is written in the
-- same D1 batch as the versions of its step, so it never exists without them. The newest
-- mark is how far the fold of an epoch has got.
CREATE TABLE fold_marks (
  repo_id        TEXT    NOT NULL,
  epoch          INTEGER NOT NULL,
  seq            INTEGER NOT NULL,
  -- Operations at or below `seq`, and the highest schema among them: what a backup records.
  op_count       INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  -- How many entities of each kind the fold holds here, as a JSON object with sorted keys.
  -- What a snapshot's protocol check and a backup's entity count read instead of every
  -- entity.
  kinds          TEXT    NOT NULL,
  PRIMARY KEY (repo_id, epoch, seq)
) WITHOUT ROWID, STRICT;

-- Where a backup's entities are.
--
--   'inline' — in `state`, as an `entities` array: every backup a Worker before this
--              migration took, and what every existing row becomes by the default.
--   'fold'   — in the checkpoint, as the fold of (`epoch`, `cutoff_seq`). `state` holds
--              the label and the count of entities of each kind, never the entities. A
--              backup is then a row, not a copy, so no backup can outgrow D1's 2 MB row
--              and taking one never copies the repository.
ALTER TABLE backups ADD COLUMN content TEXT NOT NULL DEFAULT 'inline'
  CHECK (content IN ('inline', 'fold'));
