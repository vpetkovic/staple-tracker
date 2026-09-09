-- 0002_devices.sql
--
-- Device credentials. The server stores only a hash of a token, never the token,
-- so a database disclosure does not yield working credentials.

CREATE TABLE devices (
  repo_id      TEXT    NOT NULL,
  device_id    TEXT    NOT NULL,

  -- SHA-256 of the bearer token, as raw bytes. The plaintext is shown once at
  -- connect time and never stored, never logged, never returned again.
  token_sha256 BLOB    NOT NULL,

  label        TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,

  -- Set by `DELETE /v1/repos/{repoId}/devices/{deviceId}`. Membership is checked on
  -- every request, not at connection time, so a revoked device fails its very next
  -- request without disturbing any other device.
  revoked_at   INTEGER,

  PRIMARY KEY (repo_id, device_id)
) STRICT;

-- The hot-path index. Authentication looks a credential up BY its digest rather than
-- fetching a row by device id and then comparing, which sidesteps timing-safe
-- comparison entirely: SHA-256 preimage resistance is the guarantee, and no secret
-- comparison happens anywhere in the request path.
--
-- It also means that even a full statement dump in a D1 error exposes only a hash.
CREATE UNIQUE INDEX devices_token ON devices (token_sha256);
