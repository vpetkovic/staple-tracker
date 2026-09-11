# staple-sync — the Cloudflare Worker and its D1 operation log

The server half of [cloud sync](../docs/sync.md). It stores an ordered operation log per
repository, assigns the total order every device replays, and arbitrates leases. It is
trusted for exactly those two things and nothing else.

**This directory is deployed infrastructure, not shipped library code.** It is excluded
from the published `staple-cli` package — see [Packaging](#packaging) — and it is a
self-contained npm package with its own `package.json`, its own lockfile and its own
test runner.

---

## Quick start

```bash
cd worker
npm install --legacy-peer-deps   # see "Why --legacy-peer-deps" below
npm test                          # 208 tests, in the Workers runtime, no network
npm run typecheck
npm run lint:logs                 # no console.* outside src/log.ts
```

`npm test` needs no Cloudflare account, no credentials and no network. It runs inside
`workerd` against Miniflare's D1, with the real `migrations/*.sql` applied.

---

## Layout

```
worker/
  migrations/          D1 migrations, numbered 0001+ (see "Migration numbering")
  src/
    index.ts           router; the order of its checks is the security design
    http.ts            TLS, protocol negotiation, body size, rate limiting
    auth.ts            credential lookup by digest, token minting
    envelope.ts        envelope shape and scope validation
    push.ts            sequence reservation and idempotent insert
    pull.ts            cursor-paged read
    snapshot.ts        bootstrap; folds the log on read
    leases.ts          fenced, server-expired leases
    devices.ts         connect, list, revoke
    backups.ts         backup, epoch-safe restore, purge
    vocabulary.ts      a repository holds a hub registry or a workspace, never both
    fold.ts            the log-to-entity-state fold a backup persists
    cursor.ts          opaque cursors
    errors.ts          the error taxonomy
    limits.ts          everything /v1/capabilities advertises
    log.ts             THE ONLY console.* in this Worker
  test/                208 tests
  scripts/lint-logs.mjs
  wrangler.toml        COMMITTED. Placeholders only.
  wrangler.local.toml  GITIGNORED. Real account and database ids.
```

## Routes

| Method | Path | Auth |
|---|---|---|
| `GET` | `/v1/capabilities` | none — the only unscoped route |
| `POST` | `/v1/repos/{repoId}/connect` | enrollment credential |
| `POST` | `/v1/repos/{repoId}/ops` | device token |
| `GET` | `/v1/repos/{repoId}/ops?cursor=&limit=` | device token |
| `GET` | `/v1/repos/{repoId}/snapshot?cursor=&limit=` | device token |
| `POST` | `/v1/repos/{repoId}/leases` | device token |
| `POST` | `/v1/repos/{repoId}/leases/{entityId}/renew` | device token |
| `DELETE` | `/v1/repos/{repoId}/leases/{entityId}` | device token |
| `GET` | `/v1/repos/{repoId}/devices` | device token |
| `DELETE` | `/v1/repos/{repoId}/devices/{deviceId}` | device token |
| `PUT` | `/v1/repos/{repoId}/backup` | device token |
| `POST` | `/v1/repos/{repoId}/backups` | device token |
| `GET` | `/v1/repos/{repoId}/backups` | device token |
| `DELETE` | `/v1/repos/{repoId}/backups/{backupId}` | device token |
| `POST` | `/v1/repos/{repoId}/backups/{backupId}/restore` | device token |
| `DELETE` | `/v1/repos/{repoId}` | device token, plus `{ "confirm": "<repoId>" }` in the body |

Three of those are **additive** to the route table in `docs/sync.md`, which names create,
list and restore but nothing that writes the backup consent flag and nothing that removes
a backup. `PUT /backup` exists because the contract grants backup with "a server-side
flag" and names no route that sets one; `DELETE /backups/{backupId}` exists because "its
own retention" is not implementable without a delete, and the alternative — an automatic
expiry job — would destroy a human's backups on a schedule nobody typed.

### Backup, restore and purge

See `src/backups.ts`; the short version, because getting it wrong is unrecoverable:

- **Every backup route requires two consents**, one on each side. `sync.backup` in the
  device's machine config, and `repos.backup_enabled` here. The device's half cannot
  stand alone — it is a file on the device — so the server keeps its own.
- **A backup is a fold of the log, not a copy of it.** Storing a range of `ops` rows
  would mean restoring by replaying ids the dedupe index already holds. Storing the fold
  means a restore mints fresh operations, which is the only shape that can be re-applied.
- **A restore stages, then flips.** It writes the backup's entities into `epoch + 1`
  while the repository is still on `epoch`, and only then moves `repos.epoch`. Both
  `pull` and `snapshot` filter on the session's epoch, so nothing is visible until the
  flip and the cutover is atomic across three requests without a transaction spanning
  them.
- **Bumping the epoch alone would be total data loss.** `GET /snapshot` folds the CURRENT
  epoch, so a device re-bootstrapping into a freshly bumped, empty epoch hydrates an
  empty repository while the old rows sit there being retained for forensics nobody
  asked for. Non-truncating means rows are RETAINED; it does not mean a snapshot spans
  epochs, and it must not be made to. `test/backups.test.ts` asserts the restored
  content is visible through `/snapshot` for exactly this reason — a bump-only
  implementation passes every other test in that file.
- **Restore is chunked** at `maxBatchSize`, because staging N entities costs N+1 queries
  against the free plan's ceiling of 50. It is driven by calling the one route in a loop
  until it answers `done`.
- **Purge requires the repository id typed back, on the wire.** The body is
  `{ "confirm": "<repoId>" }` and `confirm` must be exactly the repository the credential
  belongs to; a device token alone does not purge. No body, an empty body or no `confirm`
  is refused `validation` with `confirmation: "missing"` and a message telling the person to
  update staple — that is the bare DELETE every client from before this rule sends. Any
  other value is `confirmation: "mismatch"`. Both are 400, not retryable, and delete
  nothing; `worker/test/purge-fixture.ts` pins the two bodies for this suite and for the
  client's fake. A JSON body rather than a header because restore already takes `confirm`
  that way and the client already sends a DELETE body for lease release. The router's
  body-size check skips DELETE (a bare DELETE has no `Content-Length`), so the purge route
  applies the same cap itself before it reads the body.
- **Purge deletes `devices` last**, so a batch that fails halfway leaves the repository
  still reachable to try again rather than leaving data nobody can reach or delete.

---

## The designs worth knowing before you edit anything

### Sequence assignment happens in SQL, and there is no Durable Object

A D1 database is backed by a single Durable Object and processes queries one at a time,
and `batch()` is a real SQL transaction that rolls back whole on any failure. That is
exactly the serialization a coordinator in front would add — so adding one would charge
$0.15/M requests plus duration for a guarantee D1 hands over for free, add a hop, and
put an irreversible `new_sqlite_classes` class migration in a public repository.

So a push is one `batch()`:

```
[0]        SELECT last_seq AS prior_high, epoch, vocabulary FROM repos WHERE repo_id = ?
[1]        UPDATE repos SET last_seq = last_seq + N, vocabulary = :v
             WHERE repo_id = ? AND epoch = :e AND (vocabulary IS NULL OR vocabulary = :v)
[2..N+1]   INSERT INTO ops (...) SELECT ?, r.last_seq - N + j, r.epoch, ... FROM repos r
             WHERE r.repo_id = ? AND r.epoch = :e AND r.vocabulary = :v
               AND NOT EXISTS (... o.epoch = r.epoch AND o.op_id = ?)
```

Each insert computes its own slot from the reserved window. **Nothing reads a number
into JavaScript and writes it back** — that is the lost update this shape exists to
avoid. `RETURNING` is not used: it is undocumented across the entire D1 doc set and
`results` is documented as empty for writes.

`:v` is the batch's vocabulary (see [A repository holds one vocabulary](#a-repository-holds-one-vocabulary))
and `:e` the epoch read at authentication. **Every insert is conditioned on the
reservation having happened**: its `WHERE` is `[1]`'s predicate as it reads after `[1]`
ran, so an insert lands exactly when `[1]` matched. D1 has no conditional abort, so a
batch that fails the predicate does not raise — it writes nothing, and `[0]`, read inside
the same transaction, says why: another vocabulary (a `conflict`) or another epoch
(`epoch_changed`).

Consequences you must not undo:

- **`seq` is strictly increasing and gaps are legal.** A deduplicated operation's
  reserved slot goes unused, so `…1039, 1041…` is correct. Never assert
  `next == last + 1`, never treat a gap as data loss, never derive a count from a range.
- **`repos.last_seq` is never recomputed from `MAX(ops.seq)`.** Deriving it would let
  compaction rewind it, and every cursor in the fleet is a promise that it cannot.
  There is a test for this.
- **The dedupe index is `(repo_id, epoch, op_id)`**, scoped by epoch. See below.

### Why the uniqueness index carries `epoch`

`opId` derives from `sha256(repoId, epoch, deviceId, clientSeq)`. `deviceId` lives in
machine config and survives a client-side database rebuild; `clientSeq` lives only in
the workspace database, which a re-bootstrap rebuilds from zero. An epoch bump forces
exactly that re-bootstrap and is explicitly **non-truncating**, so the pre-restore
operations are still in the table.

Without `epoch` in the index, a restored client re-mints ids identical to its own
pre-restore operations, the dedupe absorbs genuinely new work as a duplicate, and the
push response returns the seq of the **original** application — which the client reads
as an acknowledgement. Silent data loss, in precisely the restore path the epoch
mechanism exists to make safe.

The amended derivation already makes cross-epoch collisions impossible. The index is
scoped anyway, because a client on an older build must be rejected by the database
rather than silently deduplicated into data loss. Defence in depth on the side where
the damage is unrecoverable.

### A repository holds one vocabulary

A hub's log holds only `registration` and `crossLink`; a workspace's holds only the other
thirteen entities. `repos.vocabulary` (migration `0005`, STA-290) records which one:
`'hub'`, `'workspace'`, or `NULL` for a repository nothing has been written to yet.

- **The first write claims it**, atomically. A push claims it in the `[1]` statement above,
  in the same batch that reserves its sequence numbers. A restore claims it when it
  begins. Two concurrent first pushes of different vocabularies are serialized by D1 and
  exactly one of them writes anything; the other writes no row, reserves no slot and
  claims nothing. `test/vocabulary.test.ts` holds both batches at a gate until both have
  passed every earlier check, then releases them.
- **The other vocabulary is refused at ingest**: registry operations into a workspace
  repository, workspace operations into a hub repository, and a restore of a backup in
  the other vocabulary. The answer is `409 conflict`, not retryable, with
  `repositoryVocabulary` and `requestVocabulary` in the body. A restore of a backup that
  holds both (only a repository contaminated before `0005` can produce one — captured
  before it, or after it but before the recovery recipe below was run) is refused the same way, with
  `requestVocabulary: "mixed"`. Every refusal happens before anything is written; a
  restore refuses before its undo is captured.
- **`conflict` rather than a new code** because every client already released maps a code
  it does not know to `unavailable`, which is retryable. A new code would have turned a
  permanent refusal into a retry loop on every installed build.
- **Set once.** No statement in this Worker changes a vocabulary that is already set.
  Only an operator can, by hand, and the recovery recipe below says when to.
- **A push pays no extra query.** The vocabulary arrives with the credential in the
  authentication query, which lets a push refuse early, and the race-free check rides
  the statements the batch already had. A restore pays one query per call: begin and each
  stage turn count the backup's registry entities in SQL, and an unclaimed repository
  costs begin one more statement to claim.

Before `0005` there was no such rule, so a `registration` pushed at a workspace's
`repoId` was accepted, and every protocol-1 client of that workspace was then refused at
`/ops` and `/snapshot` with a permanent 426. [If a registry operation lands in a
WORKSPACE's log](#if-a-registry-operation-lands-in-a-workspaces-log) is the cleanup for a
repository that was contaminated before the migration ran.

---

## The batch-statement-counting experiment

**Question** (marked `[inferred]` in the Cloudflare research brief, and unresolvable
from the docs): does each statement inside a `d1.batch()` count individually toward
D1's *queries per Worker invocation* limit — 1,000 paid, **50** free?

It matters because it was believed to set the maximum push batch size: a push costs
`N + 2` batch statements plus a couple of standalone queries, so on the free plan
`N + 4 ≤ 50` would have capped N at 46.

**Method.** Against the deployed dev Worker, over real HTTPS, push batches of
increasing N and find where it breaks.

**Result** — every batch succeeded, including one well past the *paid* ceiling:

| N (ops) | statements in the `batch()` | "queries" if counted individually | status |
|---|---|---|---|
| 25 | 27 | 29 | 200 OK |
| 46 | 48 | 50 | 200 OK |
| 60 | 62 | 64 | 200 OK |
| 200 | 202 | 204 | 200 OK |
| 500 | 502 | 504 | 200 OK |
| 998 | 1000 | 1002 | 200 OK |
| **1100** | **1102** | **1104** | **200 OK** |

**Answer: no.** Statements inside a `batch()` do **not** count individually toward the
queries-per-invocation limit — a batch is charged as one. 1,102 statements in a single
invocation exceeds even the paid ceiling of 1,000, so this holds regardless of which
plan the account is on, which is what makes it decisive rather than merely suggestive.

**What this changes, and what it deliberately does not.**

The research brief's stated *reason* for the batch sizes — "`N + 4` against a ceiling of
50 or 1,000" — is wrong in its mechanism. The queries-per-invocation limit is not the
binding constraint on batch size. A push costs about **four** queries against that
ceiling no matter how large N is: one authenticate, one batch, one range read-back, and
one duplicate lookup when something deduplicated.

The advertised sizes stay at **25 free / 200 paid** anyway. They are in the committed
wire contract, this lane implements that contract rather than redesigning it, and the
constraints that actually bind are ones this experiment did not remove:

- **CPU: 10 ms per request on the free plan.** Parsing and validating a large batch is
  real work, and it is now the first thing that would break.
- **Rows written: 100,000/day on the free plan, enforced as a hard failure since
  2026-09-01.** The `ops` table writes ~2 rows per operation (one to the table, one to
  its unique index) plus one per batch for the watermark — roughly **50,000 operations
  per day**. That, not batch size, is the real ceiling, and it is the number to design
  against.
- **30 seconds** of query duration, which applies to the whole batch call.
- **100 bound parameters per query** — not SQLite's usual 999. The insert binds 17, well
  under. This is why the duplicate lookup uses `json_each(?)` with the id list as ONE
  bound parameter instead of `op_id IN (?, ?, …)`, which would break at these sizes.

If the batch size is ever raised, raise it against CPU and the write budget, and
re-measure both. Do not raise it because this table says 1,100 worked.

---

## Local development

```bash
npm run dev        # wrangler dev --local --persist-to ./.wrangler/state
```

**`--local` is mandatory and is NOT the default.** In Wrangler v4 `wrangler dev` runs in
**remote** mode unless `--local` is passed, which means a script that omits it reaches
real Cloudflare infrastructure — silently, in a subprocess, where the repository's
network-silence spy cannot see it. Every invocation in this package passes it
explicitly. Do not add a convenience wrapper that omits it.

```bash
npm run migrate:local   # wrangler d1 migrations apply staple-sync-dev --local
```

Local commands work off the **committed** `wrangler.toml` with its placeholder database
id: Miniflare keys its SQLite file by that id, so local dev, the vitest integration and
`wrangler types` all work with no secrets present anywhere.

---

## Deploying

The repository is **public**. No account id, no database id, no token and no
`workers.dev` URL containing the account subdomain may enter a committed file.

`account_id` is supplied by environment variable. `database_id` cannot be: it is a
required field, there is no environment variable for it, and **Wrangler supports no
`${VAR}` interpolation anywhere in its config file** — a config written that way deploys
with the literal string as the id. So the real values live in a gitignored override
selected with `-c`.

**First time only** — create the database and record its id:

```bash
export CLOUDFLARE_ACCOUNT_ID=<your account id>
npx wrangler d1 create staple-sync-dev          # prints database_id
cp wrangler.toml wrangler.local.toml            # then edit: add account_id,
                                                # replace the placeholder database_id
```

`wrangler.local.toml` is gitignored. Confirm before you go further:

```bash
git check-ignore -v wrangler.local.toml         # must print a match
```

**Every remote operation** goes through the override:

```bash
export CLOUDFLARE_ACCOUNT_ID=<your account id>
npx wrangler d1 migrations apply staple-sync-dev --remote -c wrangler.local.toml
npx wrangler deploy -c wrangler.local.toml
```

Migrations are addressed **by database name**, not by binding name — binding names change
and database names do not.

### Provisioning a repository

`docs/sync.md` defines no provisioning route and no account model, so this Worker does
not invent one. A repository and its first enrollment secret are created out of band:

```sql
-- enroll_sha256 is SHA-256 of the enrollment secret. Store only the hash.
-- vocabulary: 'workspace' for a workspace's repository. See below.
INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, enroll_sha256, created_at, vocabulary)
VALUES ('<repository uuid>', 1, 0, 0, X'<sha256 hex>', <unix millis>, 'workspace');
```

```bash
npx wrangler d1 execute staple-sync-dev --remote -c wrangler.local.toml --file seed.sql
```

**Set `vocabulary` when you know what the repository is for.** A repository holds a
workspace's data (`'workspace'`) or a hub's registry (`'hub'`), never both — see [A
repository holds one vocabulary](#a-repository-holds-one-vocabulary). Provisioned with the
column set, the repository refuses the other vocabulary from its very first push. Left
`NULL` (or omitted from the `INSERT`), it is claimed by whichever vocabulary is written
first, which is correct as long as the first writer is the one you provisioned it for.
Setting it explicitly is what makes a mistyped id at the first connect a refusal instead of
a claim. The column has a `CHECK`, so a typo such as `'Hub'` refuses the `INSERT` itself.

The first device then calls `POST /v1/repos/{repoId}/connect` presenting the enrollment
secret as its bearer, and receives a device token. Later devices may present either the
enrollment secret or an existing device token. An unknown `repoId` fails closed with
`forbidden` and is **never** auto-created — an unknown id is far more likely to be a
copied manifest than a new repository, and auto-creating turns that into a silently
forked workspace.

### Provisioning a HUB

A hub is a repository. There is no hub table and no separate route. Provisioning one is
the `INSERT` above with the hub's id in place of a workspace's, and `vocabulary = 'hub'`:

```sql
-- The hub id comes from `hub.db`'s meta table: `staple hub registry id` prints it.
-- It is minted locally by the FIRST machine and adopted by every later one.
INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, enroll_sha256, created_at, vocabulary)
VALUES ('<hub id>', 1, 0, 0, X'<sha256 hex>', <unix millis>, 'hub');
```

`vocabulary` is the one thing that tells a hub's repository from a workspace's
([A repository holds one vocabulary](#a-repository-holds-one-vocabulary)). Set to `'hub'`,
the repository refuses workspace operations from its first push, and a workspace can never
be pointed at it by mistake. Left `NULL`, the hub's first publish claims it, which is
equally final once it has happened. Either way, after the first write a `registration`
can no longer land in a workspace's log, and a workspace operation can no longer land in a
hub's.

Two things follow from there being no provisioning route, and both have to be visible
in the product rather than discovered:

**1. `forbidden` on a hub's first connect means "not provisioned", and the product must
say so.** It is the same wire answer as "you are not a member", and it always will be —
`devices.ts` answers `forbidden` for an unknown `repoId` precisely so that a caller
cannot enumerate which repository ids this server knows about. What makes the
translation safe for a hub specifically is that a hub id is minted locally and never
typed by a human, so "you fat-fingered the id" is not one of the readings. The client
maps it to a named state that spells out this `INSERT` (`HUB_NOT_PROVISIONED` in
`src/core/cloud/hub-registry-service.ts`). Do not replace that with a generic failure;
it reads as a bug in Staple, and the remedy is an operator action nobody would guess.

**2. The hub id has to reach the second machine out of band, alongside the enrollment
secret.** A replacement machine mints its own hub id on first use, and a machine scoped
to a freshly minted id reads an empty repository — so "restorable after a machine is
lost" would be false however good the rest of the mechanism was. The id is not a secret
and the enrollment secret is, but neither is derivable from anything, and losing either
costs the same recovery. Keep them together.

The hub's log contains only `registration` and `crossLink` operations, which require
**protocol 2**. Consequences worth knowing before you deploy:

- A hub backup is stamped `protocol = 2`, and `POST /backups/{id}/restore` refuses it
  when the request negotiated protocol 1 — otherwise the epoch moves, the pre-restore
  capture is spent, and the device that asked is left on a timeline it cannot hydrate.
- An ordinary workspace backup is still stamped `protocol = 1`, because the stamp is
  the lowest protocol that can REPLAY the backup rather than the ceiling of the Worker
  that took it. A Worker rolled back one version can still restore one.
- `GET /ops` and `GET /snapshot` on a hub refuse a protocol-1 request outright, rather
  than filtering the registry entities out of it. Filtering would advance the cursor
  past operations that were never delivered.

### If a registry operation lands in a WORKSPACE's log

**This recipe is for contamination that happened BEFORE migration `0005` ran, and only
for that.** Since `0005` a repository holds one vocabulary and refuses the other at ingest
([A repository holds one vocabulary](#a-repository-holds-one-vocabulary)): a push of
registry operations into a workspace repository is a `409 conflict` that writes nothing,
and so is a restore of a backup that carries them. No route this Worker serves can put a
`registration` or `crossLink` into a workspace's log any more.

Before `0005` there was no such rule. A `registration` or `crossLink` pushed at a
workspace's `repoId` **was accepted**, and from that moment every protocol-1 client of that
workspace was refused at `/ops` and `/snapshot` with a non-retryable 426. Rows that landed
then are still there after the migration, and the migration does not remove them: it only
classifies the repository. Its backfill calls a log holding both vocabularies
`'workspace'`, because the registry rows are the contamination, so the workspace's own
devices can keep pushing while the rows wait for this recipe. What they cannot do is read:
the 426 on `/ops` and `/snapshot` lasts until the rows are gone.

To find the repositories that need it:

```bash
npx wrangler d1 execute staple-sync-dev --remote -c wrangler.local.toml --command \
  "SELECT DISTINCT repo_id FROM ops WHERE entity IN ('registration','crossLink')
      AND repo_id IN (SELECT repo_id FROM repos WHERE vocabulary = 'workspace');"
```

A workspace whose log held ONLY registry rows when `0005` ran — a mistyped hub id that
reached a freshly provisioned workspace before its own first push — was classified
`'hub'`, because its log gave the migration nothing else to go on. Its own devices are then
refused with `conflict` on their first push. For that case, run the recipe below and then
step 5.

What made this worth a recipe is that it was **irreversible by the one remedy a user has**.
A restore materialised the fold into the new epoch, so the protocol-2 entity was
re-materialised and survived. Since `0005` a restore refuses a backup carrying the other
vocabulary, or both, before it captures its undo, so a contaminated backup can no longer
put the rows back. It can no longer be restored at all, though, which is why step 4
deletes it.

The remedy is operator-side, and it is surgical rather than a purge.

**Step 0 — check for an in-flight restore, and stop if there is one.**

```bash
npx wrangler d1 execute staple-sync-dev --remote -c wrangler.local.toml --command \
  "SELECT restore_id, from_epoch, to_epoch, staged_count, status
     FROM restores WHERE repo_id = '<workspace repo id>' AND status = 'staging';"
```

If that returns a row, **do not delete anything yet, and do not delete the `restores` row.**

**That `SELECT` is a fence in name only, and the recipe does not pretend otherwise.** It is a
point-in-time read and nothing in this service locks a repository: `beginRestore` refuses only
while a `status = 'staging'` row already exists, so any device holding a valid credential can
start a restore in the gap between your `SELECT` and your `DELETE`, and the answer you read is
stale the moment you have it. Treat it as information rather than protection — re-run it
immediately before you delete, revoke the device credentials for the duration if the repository
is live (`DELETE /v1/repos/{repoId}/devices/{deviceId}`, which holds until somebody re-connects
with the enrollment secret), and rely on the epoch predicate in step 3, which is the part that
stays correct even if a restore begins mid-recipe.

`stage` resumes from a slice offset computed from `stagedCount`, which is a bare `COUNT(*)`
of the target epoch rather than a per-restore ledger. Two consequences, both measured:

- **Deleting the `restores` row loses data silently.** The next restore picks the same
  `toEpoch = repo.epoch + 1` and its in-flight guard reads the now-empty `restores` table, so
  the orphaned staged rows still count. Reproduced: the row deleted with 25 orphan ops
  staged, a new restore of a 30-entity backup staged only 5, then committed
  `status: "committed", done: true, staged: 30` — **25 of 30 entities skipped on the
  disaster-recovery path, reported as success.** If you must abandon a restore, delete its
  staged operations in the same statement:
  ```sql
  DELETE FROM ops WHERE repo_id = '<repo id>' AND epoch = <to_epoch>;
  DELETE FROM restores WHERE repo_id = '<repo id>' AND restore_id = '<restore id>';
  ```
  (`status = 'abandoned'` exists in the schema, but nothing writes it and there is no abandon
  route, so it is not a remedy — do not set it and expect anything to honour it.)
- **Deleting contaminated `ops` out of a staging epoch wedges the restore permanently.** The
  count-based window shifts past the deleted row for ever: every poll inserts nothing,
  `staged` never reaches `entityCount`, and `repos.last_seq` climbs unbounded. And because
  nothing writes `'abandoned'`, the wedged row then blocks every future `beginRestore` with
  `conflict`, for ever.

**So: drive the restore to completion first** — call the restore route until it answers
`done` — and only then continue with the steps below. That is the remedy that loses nothing,
**and it is only available while the commit can still apply.** `commitRestore`'s second guard
is `guard_seq`: if any operation landed in `from_epoch` after the restore began, the commit
refuses, and it refuses for good — the intruding row is in neither the backup being restored
nor the pre-restore fold, so nothing can make committing safe later. Nothing gates writes while
a restore stages, either: `POST /ops` has no in-flight check at all, so on a repository with a
live device `done` can be unreachable however many times you poll for it.

**When `done` is unreachable, abandon the restore rather than driving it** — which is the
two-statement form above, the staged operations in `to_epoch` and the `restores` row deleted in
the same sitting, never the row on its own. Stop the writers before you retry or the next
attempt ends the same way: revoking the device credentials is the only fence this service
actually offers. Then take a fresh backup and begin the restore again, which is what the commit
refusal itself tells the caller to do. Abandoning deletes nothing that a device wrote: the
repository stays on `from_epoch` with the concurrent operations intact. What it gives up is the
restore — the state you were rolling back to is reachable again only once the writers are quiet
long enough for one begin-to-commit round to finish.

**Step 1 — capture the rows to a file before deleting anything.** `SELECT *`, not a
four-column projection: a mistyped `repo_id` deletes rows that cannot be reconstructed from
`epoch, seq, entity, entity_id` alone, because `payload`, `actor`, `client_seq`,
`created_at` and `server_ts` are gone with them.

```bash
npx wrangler d1 execute staple-sync-dev --remote -c wrangler.local.toml --json --command \
  "SELECT * FROM ops
    WHERE repo_id = '<workspace repo id>' AND entity IN ('registration','crossLink')
    ORDER BY epoch, seq;" > contaminated-ops.json
```

Read it and confirm the `repo_id` is the one you meant before going further.

**Step 2 — find the contaminated BACKUPS.** There will usually be several: every restore
auto-creates a `pre-restore` backup, so any repository that has been restored since the
operations landed has captured them.

```bash
npx wrangler d1 execute staple-sync-dev --remote -c wrangler.local.toml --command \
  "SELECT backup_id, kind, epoch, protocol, created_at
     FROM backups WHERE repo_id = '<workspace repo id>' AND protocol >= 2;"
```

`protocol >= 2` is the marker — `captureBackup` stamps the lowest protocol that can replay
the fold, so a workspace backup carrying a registry entity is the only reason a workspace
repository would have one stamped 2.

**Step 3 — delete the operations, in every epoch a device can read them from:**

```sql
DELETE FROM ops
 WHERE repo_id = '<workspace repo id>'
   AND entity IN ('registration', 'crossLink')
   AND epoch <= (SELECT epoch FROM repos WHERE repo_id = '<workspace repo id>');
```

**The epoch predicate is what keeps this delete out of an epoch a restore is filling**, and it
is not a belt-and-braces addition to step 0 — it is the part that holds when step 0's read went
stale. `repos.epoch` is the live epoch and a restore stages into `repo.epoch + 1`, so
`epoch <= (SELECT epoch …)` covers every epoch a device can read and excludes exactly the one
under construction. Without it the delete punches a hole in `stagedCount`, which is a bare
`COUNT(*)` of the target epoch rather than a per-restore ledger, while `stage` resumes at
`entities.slice(staged, staged + maxBatchSize)` — so the window steps past the deleted position
for ever, `staged` never reaches `entity_count`, `commitRestore` is therefore never reached at
all, and the `status = 'staging'` row that survives answers every future `beginRestore` with
`conflict`. One `DELETE` run at the wrong moment is a repository that can never be restored
again.

Contamination inside a staging epoch is not left behind by excluding it: those rows are
materialised from the backup, so they become reachable only if that restore commits, and once
it has, `repos.epoch` has moved and running this same statement again removes them.

`seq` gaps are legal and expected — a slot reserved for a deduplicated operation already
goes unused, and `WHERE seq > cursor` is gap-tolerant by construction — so removing rows
does not disturb cursors, and `repos.last_seq` is deliberately left alone so no `seq` is
ever reused. Devices that had already applied the operations are unaffected: they are the
only clients that could read them, and a protocol-2 client tolerates their absence.

**Step 4 — delete every backup step 2 found**, rather than restoring from it:

```sql
DELETE FROM backups WHERE repo_id = '<workspace repo id>' AND backup_id = '<id>';
```

Do this in the same sitting. Since `0005` a restore refuses every one of these with
`conflict` before it touches anything, so none of them can put the rows back, but none of
them can be restored at all either. A backup nobody can restore is clutter that looks like
a rollback point.

Two things to know before you run it. **Some of these will be `kind = 'pre-restore'`, which
is the documented undo for a restore somebody ran.** That undo already stopped working when
`0005` was deployed, and there is no keeping it: step 2 cannot have returned a backup that
predates the contamination. `captureBackup` stamps `protocolForEntities` over the fold it
captured, and a fold holding no registry entity stamps `1`, so `protocol >= 2` selects
exactly the backups that carry the rows. Every one of them was captured after the operations
landed. So the price is explicit: any restore whose `pre-restore` undo appears in step 2's
list is not reversible. Note each `created_at` and tell whoever ran that restore. The
backups worth keeping are the ones step 2 does NOT return — the protocol-1 captures from before
the contamination, which this recipe leaves untouched and which are what a rollback should
use. And this bypasses `DELETE /backups/{id}`'s in-flight
guard, which is another reason step 0 has to be settled first: deleting the backup a staging
restore is reading makes the next `stage` fail with `not_found` and leaves the restore wedged
exactly as above.

**Step 5 — confirm the repository's vocabulary.** After step 3 the log holds only workspace
entities, and `repos.vocabulary` must say so:

```bash
npx wrangler d1 execute staple-sync-dev --remote -c wrangler.local.toml --command \
  "SELECT vocabulary FROM repos WHERE repo_id = '<workspace repo id>';"
```

`'workspace'` is the usual answer, because `0005` classified a log holding both
vocabularies that way. If it says `'hub'`, the log held nothing but the contamination when
the migration ran, and the workspace's own devices are being refused on every push. Correct
it by hand. This is the one write to the column this service leaves to an operator:

```sql
UPDATE repos SET vocabulary = 'workspace'
 WHERE repo_id = '<workspace repo id>'
   AND NOT EXISTS (SELECT 1 FROM ops
                    WHERE repo_id = '<workspace repo id>'
                      AND entity IN ('registration', 'crossLink'));
```

The `NOT EXISTS` makes the statement a no-op until step 3 has actually removed the rows, so
a correction run too early changes nothing.

A restore that BEGAN before `0005` and is still staging is caught too. Every stage turn
repeats begin's check, so one staging a contaminated backup into a workspace is refused with
`conflict` on its next turn and stays `staging`. Abandon it with the two-statement form
under step 0.

Only if the rows cannot be identified is the answer `DELETE /v1/repos/{repoId}` (purge, with
`{ "confirm": "<repo id>" }` as its body, which `staple cloud purge --confirm` sends) and
a re-provision from a device that still holds the data. That is the outcome this recipe
exists to avoid; "no remedy short of a purge" with no documented purge is the difference
between an incident and a dead repository.

### Never

No `wrangler delete`, no `wrangler d1 delete`, no destructive subcommand against any
Cloudflare resource — not to clean up, not to retry a failed create.

---

## Migration numbering

Worker migrations are `0001`, `0002`, … and are numbered **independently of the
workspace SQLite migrations** in `src/core/migrations/workspace`, which are heading for
`010`. They describe two different databases. Do not number the next Worker migration
`010` to "line up" with the workspace series; there is nothing to line up with.

---

## Secret redaction

Workers Logs documents **no** redaction mechanism. The platform's only redaction
guarantee — `REDACTED` for header names containing `auth`, `key`, `secret`, `token`,
`jwt` or `cookie` — applies to Tail Worker events, not to anything you `console.log`
yourself. So redaction here is by construction:

1. `src/log.ts` is the only file that may call `console.*`. Its `LogFields` type is a
   closed record of primitives — no spread, no rest parameter, no `unknown` — so a
   credential cannot be logged because there is no parameter it would fit in.
2. Credentials are accepted **only** from the `Authorization` header, never from a URL
   or query parameter. The invocation log's message is `<Method> <URL>`.
3. `invocation_logs = false` in `wrangler.toml`.
4. Correlation uses a 4-byte fingerprint of the SHA-256 already computed for the lookup
   — never a prefix of the token. "The first few characters" is a real disclosure.
5. Error paths log only the error's **class name**. A D1 failure can echo the failing
   statement; every statement here is parameterised and the credential lookup binds a
   digest, so a dump would expose only a hash — which is not a reason to emit one.

Both halves are gated: `npm run lint:logs` is the static check, and
`test/redaction.test.ts` spies on the real console during real authenticated requests.

---

## Packaging

`worker/` **cannot** reach the published `staple-cli` tarball, and this is structural
rather than a matter of remembering. `scripts/build-package.ts` deletes `dist-package/`,
then writes into it only (a) one esbuild bundle whose single entrypoint is
`src/package/staple.ts`, (b) the Vite UI assets, and (c) README, LICENSE and notices.
The generated `package.json` has an explicit `files` allowlist, and `verifyNoSourceLeaks()`
throws if anything unexpected appears in the output directory.

Verified empirically: `npm run pack:package` produces an 11-file tarball containing
`staple.mjs`, `assets/`, `package.json`, `README.md`, `LICENSE` and
`THIRD-PARTY-NOTICES.md`, and nothing matching `worker`, `wrangler`, `node_modules` or
`*.test.*`.

---

## Testing

```bash
npm test              # from worker/
npm run test:worker   # from the repository root — delegates in here
```

Root `npm test` neither runs these tests nor is affected by them: the root
`vitest.config.ts` excludes `worker/**`.

**Why two runners.** `@cloudflare/vitest-plugin` (and its predecessor
`@cloudflare/vitest-pool-workers`) require vitest 4.1+. The repository root pins vitest 3
across 173 test files. Dragging that suite through a major-version upgrade to satisfy a
directory that did not exist last week is the wrong trade, so `worker/` carries its own
dependency tree.

**Why `--legacy-peer-deps`.** npm 10.9.7 fails with `Cannot read properties of null
(reading 'edgesOut')` while resolving this peer graph — an npm bug, not a broken
dependency set. The flag installs the intended tree (vitest 4.1.11,
`@cloudflare/vitest-plugin` 1.1.4, wrangler 4.129.0).

**There is no `isolatedStorage` option** in `@cloudflare/vitest-plugin@1.x`. The key
appears in older `vitest-pool-workers` documentation and is **silently ignored** by this
version rather than rejected. Setting it and trusting it produced exactly the failure
you would expect — sequence numbers accumulating across tests, every test passing alone
and the suite failing as a whole. `test/setup.ts` truncates in a global `beforeEach`
instead.

**Never run `npm install` at the repository root.** Its `node_modules` is a symlink
shared with other worktrees and other sessions; installing there corrupts them. Inside
`worker/` it is fine and expected.
