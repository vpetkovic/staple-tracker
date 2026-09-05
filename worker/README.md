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
npm test                          # 117 tests, in the Workers runtime, no network
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
    cursor.ts          opaque cursors
    errors.ts          the error taxonomy
    limits.ts          everything /v1/capabilities advertises
    log.ts             THE ONLY console.* in this Worker
  test/                117 tests
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

Backup, restore and purge (`/backups`, `DELETE /v1/repos/{repoId}`) are **not
implemented here** — they belong to the restore lane, and implementing them without the
retention and confirmation semantics that lane owns would be worse than not having them.

---

## The two designs worth knowing before you edit anything

### Sequence assignment happens in SQL, and there is no Durable Object

A D1 database is backed by a single Durable Object and processes queries one at a time,
and `batch()` is a real SQL transaction that rolls back whole on any failure. That is
exactly the serialization a coordinator in front would add — so adding one would charge
$0.15/M requests plus duration for a guarantee D1 hands over for free, add a hop, and
put an irreversible `new_sqlite_classes` class migration in a public repository.

So a push is one `batch()`:

```
[0]        SELECT last_seq AS prior_high, epoch FROM repos WHERE repo_id = ?
[1]        UPDATE repos SET last_seq = last_seq + N WHERE repo_id = ? AND epoch = ?
[2..N+1]   INSERT INTO ops (...) SELECT ?, r.last_seq - N + j, r.epoch, ... FROM repos r
             WHERE r.repo_id = ? AND NOT EXISTS (... o.epoch = r.epoch AND o.op_id = ?)
```

Each insert computes its own slot from the reserved window. **Nothing reads a number
into JavaScript and writes it back** — that is the lost update this shape exists to
avoid. `RETURNING` is not used: it is undocumented across the entire D1 doc set and
`results` is documented as empty for writes.

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
- **100 bound parameters per query** — not SQLite's usual 999. The insert binds 15, well
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
INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, enroll_sha256, created_at)
VALUES ('<repository uuid>', 1, 0, 0, X'<sha256 hex>', <unix millis>);
```

```bash
npx wrangler d1 execute staple-sync-dev --remote -c wrangler.local.toml --file seed.sql
```

The first device then calls `POST /v1/repos/{repoId}/connect` presenting the enrollment
secret as its bearer, and receives a device token. Later devices may present either the
enrollment secret or an existing device token. An unknown `repoId` fails closed with
`forbidden` and is **never** auto-created — an unknown id is far more likely to be a
copied manifest than a new repository, and auto-creating turns that into a silently
forked workspace.

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
