-- 0007_fold_revision_index.sql
--
-- Where a document revision sits in the fold checkpoint, indexed, so placing a revision reads the
-- few revisions it can collide with rather than every revision of its document; and where a
-- restore's progress was last counted, so a turn counts only what it staged.
--
-- Why: a fold step placed each `documentRevision` create against every revision of its document,
-- loaded whole. A step of k creates on a document of R revisions cost k x R, and one create on a
-- document of 4,000 revisions measured 152 ms of isolate time against the free plan's 10.
-- worker/src/fold-revisions.ts has the design; worker/README.md, "The fold checkpoint", the numbers.

-- The document a revision belongs to (its id up to and including the last `/`), its number as the
-- placement reads it (`Number` of the rest, when that is an integer), and a key for its body:
-- equal exactly when two bodies are the same value. NULL on every other entity.
ALTER TABLE fold_versions ADD COLUMN doc TEXT;
ALTER TABLE fold_versions ADD COLUMN rev REAL;
ALTER TABLE fold_versions ADD COLUMN body_key TEXT;

-- The numbers a document's revisions hold, in order: which are taken from a number upward.
CREATE INDEX fold_versions_revisions ON fold_versions (repo_id, epoch, doc, rev, seq) WHERE doc IS NOT NULL;
-- The revisions of a document holding one body: whether a revision is already there.
CREATE INDEX fold_versions_revision_bodies ON fold_versions (repo_id, epoch, doc, body_key, rev) WHERE doc IS NOT NULL;

-- Every row the checkpoint holds was written without those columns, so it is cleared and built
-- again from `ops` by the requests that read it. Nothing is lost: every row of both tables is a
-- function of the log alone (worker/README.md, "Clearing it is safe").
DELETE FROM fold_versions;
DELETE FROM fold_marks;
-- Except the floor of a restore still staging: the epoch it fills holds nothing at or below its
-- `guard_seq`, so a mark there is still true, and without it that epoch's fold would read from seq
-- 0 through every older epoch to find its own operations (`beginRestore`, backups.ts).
INSERT OR IGNORE INTO fold_marks (repo_id, epoch, seq, op_count, schema_version, kinds)
  SELECT repo_id, to_epoch, guard_seq, 0, 0, '{}' FROM restores WHERE status = 'staging';

-- The seq up to which `staged_count` counts a restore's staged rows. NULL on a restore begun
-- before this migration, whose count is taken once from `guard_seq`.
ALTER TABLE restores ADD COLUMN staged_seq INTEGER;
