-- 0003_leases.sql
--
-- Fenced, server-expired leases. The second and last thing the server is trusted
-- for: arbitrating exclusivity with an authoritative clock.
--
-- There is deliberately no materialized-state table in this schema. `GET /snapshot`
-- folds the operation log on read rather than maintaining a projection, for three
-- reasons: it keeps a push at the N+4 statements the wire contract advertises, it
-- adds nothing to the free plan's 100,000-rows-written-per-day budget, and it leaves
-- no derived state that can go stale relative to the log. The fold is a pure
-- function of the log, so there is nothing to repair.

CREATE TABLE leases (
  repo_id       TEXT    NOT NULL,

  -- The issue the lease covers. One live lease per entity per repository, which the
  -- primary key enforces rather than the application checking for it.
  entity_id     TEXT    NOT NULL,

  -- Monotonically increasing, allocated from repos.last_fencing_token. Never reused
  -- within a repository's lifetime, including across an epoch bump, which is why the
  -- counter lives on the repo row and not on this one. A holder presents its token on
  -- every write; a token that is behind the current one cannot write, however
  -- convinced its holder is that it still holds the lease.
  fencing_token INTEGER NOT NULL,

  -- The agent identity. Disclosed deliberately: sharing claims is the entire point.
  holder        TEXT    NOT NULL,
  device_id     TEXT    NOT NULL,

  acquired_at   INTEGER NOT NULL,
  renewed_at    INTEGER NOT NULL,

  -- Server-authoritative expiry, computed from the server clock at acquire and at
  -- every renew. Client clocks have no authority over expiry, so this is never
  -- derived from anything in a request body.
  expires_at    INTEGER NOT NULL,

  PRIMARY KEY (repo_id, entity_id)
) STRICT;

-- Expiry sweeps are lazy: an acquire deletes the entity's own expired row inside its
-- own batch. There is no sweeper and no automatic takeover, on either side of the
-- wire — that is the continuity model, not an omission. This index exists so that a
-- future bounded reaper, if one is ever justified, is a range scan rather than a
-- table scan.
CREATE INDEX leases_expires_at ON leases (repo_id, expires_at);
