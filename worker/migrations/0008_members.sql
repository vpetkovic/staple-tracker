-- 0008_members.sql
--
-- Members: named people who own devices, and the join requests that admit them.
--
-- Additive only. Nothing here rewrites or drops an existing column, and nothing here is
-- read by push, pull, snapshot, leases or the fold. A member is an authorization fact
-- about who may admit, remove and revoke; the operation log never learns about one. A
-- device's member is derived from its server-stamped `device_id`, which is what keeps
-- attribution unforgeable without a second stamp on every operation.
--
-- Members apply only to repositories whose vocabulary is not 'hub'. A hub registry has
-- no members, and its connect paths stay exactly as they were.

-- One row per person in a workspace.
CREATE TABLE members (
  repo_id    TEXT    NOT NULL,
  member_id  TEXT    NOT NULL,

  -- What the assignee field holds, and what a person sees on a member chip.
  name       TEXT    NOT NULL,

  -- The name as uniqueness compares it: `name.normalize("NFKC").toLowerCase()`, computed
  -- in the Worker (members.ts `nameKey`) on every write that sets `name`. Stored rather
  -- than derived in SQL because SQLite's `lower` folds ASCII only, so "Ćiro" and "ćIRO"
  -- would both pass a `lower(name)` index; this column is what the unique index holds.
  name_key   TEXT    NOT NULL,

  -- The member who connected the repository first. There is no owner transfer in v1,
  -- and the owner cannot be removed.
  is_owner   INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),

  created_at INTEGER NOT NULL,

  -- Set when the owner removes the member. The row stays, so history still has a name
  -- for the devices it attributes to, and the name stays taken.
  removed_at INTEGER,

  PRIMARY KEY (repo_id, member_id)
) STRICT;

-- Names are unique per repository under the Unicode-aware fold `name_key` holds. Every
-- lookup by name reads this index, and it is the race-free floor under the routes' checks.
CREATE UNIQUE INDEX members_name ON members (repo_id, name_key);

-- One owner per repository, by construction rather than by convention.
CREATE UNIQUE INDEX members_owner ON members (repo_id) WHERE is_owner = 1;

-- Which member a device belongs to. NULL on every hub device, and on a device of a
-- repository that has no members yet.
ALTER TABLE devices ADD COLUMN member_id TEXT;

CREATE INDEX devices_member ON devices (repo_id, member_id);

-- A pending device-flow pairing.
--
-- The joiner keeps a 256-bit request secret and sends only its SHA-256, so the row
-- holds a verifier and never a credential. The device token is minted when the joiner
-- collects it after approval and is returned once; it is never stored here. The code is
-- what two people compare out loud. It identifies the request and is not a credential.
CREATE TABLE join_requests (
  repo_id               TEXT    NOT NULL,
  request_id            TEXT    NOT NULL,

  -- 8 Crockford base32 characters, upper case, stored without the dash.
  code                  TEXT    NOT NULL,

  request_secret_sha256 BLOB    NOT NULL,

  device_id             TEXT    NOT NULL,
  label                 TEXT,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,

  -- 'expired' is never stored: it is `pending` or `approved` past `expires_at`.
  status                TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'denied', 'collected')),

  -- Set on approval: the member the device joins, and the device that approved it.
  member_id             TEXT,
  approved_by_device    TEXT,

  PRIMARY KEY (repo_id, request_id)
) STRICT;

CREATE INDEX join_requests_code ON join_requests (repo_id, code, status);
CREATE INDEX join_requests_status ON join_requests (repo_id, status, expires_at);

-- The backfill. One owner member named 'owner' per WORKSPACE repository that already
-- has devices, and every device of that repository assigned to it. Before this migration
-- everyone holding a device shared one enrollment secret, so they were one party; the
-- owner renames the member with `staple cloud members rename`. Hub repositories, and
-- repositories whose vocabulary is still unclaimed, are untouched here: an unclaimed one
-- gets its owner at its next accepted connect (devices.ts).
--
-- `member_id` is a v4-shaped uuid from `randomblob`, the same shape the Worker mints.
INSERT INTO members (repo_id, member_id, name, name_key, is_owner, created_at, removed_at)
  SELECT r.repo_id,
         lower(hex(randomblob(4))) || '-' ||
         lower(hex(randomblob(2))) || '-4' ||
         substr(lower(hex(randomblob(2))), 2) || '-' ||
         substr('89ab', 1 + (abs(random()) % 4), 1) ||
         substr(lower(hex(randomblob(2))), 2) || '-' ||
         lower(hex(randomblob(6))),
         'owner',
         'owner',
         1,
         CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
         NULL
    FROM repos r
   WHERE r.vocabulary = 'workspace'
     AND EXISTS (SELECT 1 FROM devices d WHERE d.repo_id = r.repo_id)
     AND NOT EXISTS (SELECT 1 FROM members m WHERE m.repo_id = r.repo_id);

UPDATE devices
   SET member_id = (SELECT m.member_id FROM members m
                     WHERE m.repo_id = devices.repo_id AND m.is_owner = 1)
 WHERE member_id IS NULL
   AND repo_id IN (SELECT repo_id FROM repos WHERE vocabulary = 'workspace');
