-- 0005_repository_vocabulary.sql
--
-- Which vocabulary a repository holds: a hub's registry, or a workspace's data (STA-290).
--
-- A hub's log holds only `registration` and `crossLink`; a workspace's holds only the
-- other thirteen entities. Before this column the service could not tell the two apart,
-- so a `registration` pushed at a workspace's `repo_id` was accepted. From then on every
-- protocol-1 client of that workspace was refused at `GET /ops` and `GET /snapshot` with
-- a non-retryable 426, permanently, and a restore carried the row into the new epoch.
--
--   'hub'       — the log may hold only registry entities
--   'workspace' — the log may hold only workspace entities
--   NULL        — nothing has been written yet; the FIRST push claims it, atomically, in
--                 the same D1 batch that reserves its sequence numbers (see push.ts)
--
-- Set once and never rewritten by the Worker: every statement that writes it is guarded
-- by `vocabulary IS NULL OR vocabulary = <the same value>`. An operator may provision a
-- repository with it already set; see worker/README.md, "Provisioning a repository".
--
-- The CHECK is not decoration. Provisioning is a hand-written INSERT, so a typo such as
-- 'Hub' is the likely mistake, and without the CHECK it would produce a repository whose
-- vocabulary no push can ever match. With it, the INSERT itself is refused. NULL passes a
-- CHECK, which is what leaves an unclaimed repository legal.
ALTER TABLE repos ADD COLUMN vocabulary TEXT CHECK (vocabulary IN ('hub', 'workspace'));

-- The backfill, from every repository's existing log, in EVERY epoch — the operations a
-- restore left behind in an older epoch are still evidence of what the repository is.
--
--   any workspace entity    -> 'workspace'
--   otherwise, any entity   -> 'hub'        (every entity is a registry entity)
--   no operations at all    -> NULL          (left for the first push to claim)
--
-- A log that holds BOTH is pre-0005 contamination, and it becomes 'workspace'. The
-- registry rows are the contamination: the permanent 426 only ever hurts a workspace's
-- protocol-1 clients, so the workspace is the thing the repository was provisioned for.
-- Calling it 'hub' would refuse that workspace's own devices on their next push. The
-- cleanup for exactly this case is the recovery recipe in worker/README.md, "If a
-- registry operation lands in a WORKSPACE's log", which removes the registry rows and the
-- backups that captured them. Until it is run those rows stay readable at protocol 2 and
-- still refuse protocol-1 readers, exactly as before this migration; what changes is that
-- no further registry operation can be written into the repository.
--
-- The entity names are the registry vocabulary from worker/src/envelope.ts,
-- `REGISTRY_ENTITIES`. They are spelled out here because a migration must describe the
-- data as it was when it ran, not follow the source as it changes later.
UPDATE repos
   SET vocabulary = CASE
         WHEN EXISTS (SELECT 1 FROM ops o
                       WHERE o.repo_id = repos.repo_id
                         AND o.entity NOT IN ('registration', 'crossLink')) THEN 'workspace'
         WHEN EXISTS (SELECT 1 FROM ops o
                       WHERE o.repo_id = repos.repo_id) THEN 'hub'
         ELSE NULL
       END;
