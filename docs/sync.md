# Cloud sync

Optional, repository-scoped synchronization so two machines share one Staple
workspace and coordinate agent claims. Local SQLite stays the working database:
every read and every write a command performs still goes to `.staple/staple.db`,
and sync moves *operations* between that file and the cloud out of band. Nothing
on this page changes what a command does when it is not asked to sync.

This is the contract the S tickets implement — not yet built. Every rule names
the test that pins it, or that will. Where this page and
[semantics.md](semantics.md) disagree, semantics.md describes today and this page
the target.

## Two invariants the rest of the page serves

**A workspace that has not been connected makes no Staple-owned network call.**
Not on install, not on `init`, not on `open`, not on CLI startup, not on an MCP
tool call, not on UI startup. No telemetry, no update check, no discovery probe,
no crash report, no "is a newer version available". There is no allowlist and no
single exception — the count is zero, and
[the network rule](#the-network-rule--and-the-test-that-proves-it) specifies the
test that says so.

**Connect, automatic sync and backup are three separate consents.** Storing a
credential does not start synchronizing. Synchronizing does not start backing up.
Each is a distinct explicit decision, each writes its own state, and each is
revocable without the other two. See [Three consents](#three-consents).

Everything else here — the envelope, the ordering, the tombstones, the leases —
exists to make those two survivable rather than aspirational.

## Identity is the UUID, never the identifier

`issues.id` is a `randomUUID()` and is the **sync identity of an issue**. It is
generated locally, never reissued, and is the only thing an operation names.

`issues.identifier` (`STA-42`) is a **display allocation**, and it is the single
hardest value in the schema to replicate. It comes from `meta.next_issue_number`,
a per-database counter consumed by an atomic `INSERT … ON CONFLICT DO UPDATE …
RETURNING`, and it carries a `UNIQUE` index. Two devices creating issues offline
both mint `STA-250`. Last-writer-wins on that column loses an issue.

**The counter is provisional; the server is the allocator.**

- An unconnected repository allocates from `meta.next_issue_number` exactly as it
  does today. Nothing changes, and nothing can collide, because nothing is shared.
- A connected repository allocates the same way, and marks the identifier
  **provisional** until the issue's `create` operation is accepted. `staple new`
  makes no network call, so offline creation keeps working.
- On acceptance, the server assigns the canonical number from the repository's own
  counter and returns it in the push response. The device renumbers, emits nothing
  further, and retains the provisional identifier as a resolvable alias — it is
  already in somebody's commit message.

One authority allocates, so there is no collision to detect and no distributed
tie-break to get subtly wrong on one device. The cost is that an identifier
created offline on a connected repository can change once, at first push, and
surfaces must show provisional identifiers as provisional rather than pretending
they are settled.

`meta.next_issue_number` therefore **never synchronizes**: it is a local
provisional allocator, not shared state.

`meta.prefix` and `meta.slug` do synchronize, and must. The prefix is baked into
every identifier ever minted, so two devices disagreeing about it produces two
identifier namespaces in one repository. The prefix is also hub-allocated, which
makes it the one value where the local hub and the sync service both have a claim
— the sync service wins, and `staple doctor` reports the disagreement rather than
silently repointing either one.

## What synchronizes

### Entity operations

These tables replicate as field-level operations on a single entity, keyed by the
entity's own primary key.

| Table | Key | Fields that travel |
|---|---|---|
| `issues` | `id` | `identifier`, `title`, `normalized_title`, `description`, `status`, `status_version`, `priority`, `parent_id`, `depth`, `assignee`, `created_by`, `labels`, `acceptance_criteria`, `block_parent_until_done`, `unblock_owner`, `unblock_action`, `origin_kind`, `origin_id`, `idempotency_key`, `estimated_seconds`, `kind`, `project_id`, `gate_state`, `gate_owner`, `gate_requested_by`, `gate_requested_at`, `gate_resolved_by`, `gate_resolved_at`, `gate_released`, `started_at`, `completed_at`, `cancelled_at`, `created_at`, `updated_at` |
| `comments` | `id` | `issue_id`, `author`, `author_type`, `body`, `idempotency_key`, `deleted_at`, `created_at` |
| `documents` | `(issue_id, key)` | `current_revision`, `title`, `updated_at` |
| `document_revisions` | `(issue_id, key, revision)` | `body`, `author`, `change_summary`, `created_at` — immutable once written |
| `relations` | `(blocker_id, blocked_id, type)` | `created_by`, `created_at` — `relations.id` is a local `AUTOINCREMENT` and does **not** travel |
| `projects` | `id` | `slug`, `name`, `kind`, `source_kind`, `source`, `created_at`, `updated_at` |
| `workspace_statuses` | `id` | `label`, `category`, `sort_order`, `is_builtin` |
| `workspace_kinds` | `id` | `label`, `sort_order`, `is_builtin` |
| `milestone_meta` | `issue_id` | `target_date`, `start_date`, `updated_at` — `members_revision` is derived, see below |
| `meta` | `key` | **only** `slug`, `prefix`, and rows matching `setting:*` |

`meta` is the one table that cannot take a single classification, so it is an
allowlist and the default is deny. `setting:*` includes keys this build has no
definition for: `unknownSettingKeys()` already preserves them unread, and sync
carries them through unchanged for the same reason — an older device round-tripping
a workspace must not delete a newer device's settings.

`projects.source` is **redacted per row, keyed on its sibling column**. When
`source_kind = 'local'` it holds an absolute filesystem path, which discloses the
device's directory layout and, on macOS and Linux, the account name out of
`/Users/<name>`. That value is replaced with `null` on the way out and the local
value is preserved on the way in. When `source_kind = 'github'` it is a public URL
and replicates unchanged. This is the only column-level redaction in the contract,
and it is conditional — stripping it unconditionally would break GitHub-sourced
projects for no privacy gain.

**Attribution is disclosed, deliberately.** `issues.checkout_agent`,
`comments.author` and the `actor` on every event are agent identity strings that
often derive from `$STAPLE_AGENT` or a hostname. They replicate, because sharing
claims and attribution is the entire point of a multi-device tracker — and they
are named here so that nobody discovers later that a machine name travelled.
`comments.body` and `document_revisions.body` are unbounded free text and are the
highest-value content in the database; see [Trust boundaries](#trust-boundaries)
for what that means when it is stored in D1.

`issues.checkout_agent` and `issues.checkout_at` travel, but never as a plain
field write — they are the projection of a lease and are covered by
[Claims](#claims-a-local-checkout-is-not-a-global-lease).

### Ordered collections replicate whole, not row by row

`queue_entries` and `milestone_members` both carry a `rank INTEGER NOT NULL
UNIQUE` (globally unique, and per-milestone unique respectively). Two devices
reordering offline produce colliding ranks that no row-level merge can repair
without inventing an order neither human asked for.

So they do not replicate row by row. Each is one operation carrying the **entire
ordered list of entity ids plus the base revision it was computed from**:

- `queue.replace` — `{ entries: [issueId…], baseRevision }`, against
  `store.queue().revision()`
- `milestone.replaceMembers` — `{ milestoneId, members: [issueId…], baseRevision }`,
  against `milestone_meta.members_revision`

**There is no per-row queue or membership operation.** No `queue.insert`, no
`milestone.addMember` on the wire. Membership changes only ever travel as a whole
replaced list, which is what makes the `UNIQUE` rank constraints unreachable: rank
is never transported, it is recomputed densely from list order inside the same
transaction that applies the list. A concurrent insert on two devices cannot
violate a constraint, because neither device ever sends a rank.

The `baseRevision` in these operations is the entity's version from
`sync_entity_versions`, **not** `meta.queue_revision` or
`milestone_meta.members_revision`. Those two are device-local
cache-invalidation and CAS counters for the local editor; they are derived, they
merge as `max()` so the local optimistic-concurrency checks stay monotonic, and
they are bumped on apply like any other local write. Two counters, deliberately:
one is what this database has seen, the other is what the repository agreed. The
existing local editor keeps using the local one and needs no change
([queue.md](queue.md)).

A `replace` whose `baseRevision` is behind the applied version is a conflict on
the *plan*, recorded whole — both orderings preserved — and never merged. A human
reordered a plan; the machine does not get to average two plans.

`queue_entries.added_by`, `added_at` and `note` ride along inside the entry
objects.

### Events are re-derived, never transported

`events` does not synchronize. **`events.seq` is a device-local `AUTOINCREMENT`
and must never be used as a sync cursor**, in either direction — it orders one
database's history and nothing else.

Instead, **applying an operation emits the same local event the original mutation
emitted**, with the originating `actor` and a `deviceId` in the payload. The
audit trail converges in content while every device keeps its own monotonic
sequence, so `staple events --follow` keeps working, `--since N` keeps meaning
what it meant, and the UI timeline and timing replay reconstruct from a log whose
ordering is locally coherent. `claim_stolen`, `blockers_resolved` and
`children_complete` are produced locally on apply, not replicated.

**Every event emitter must supply a `dedup_key`.** Three of the four
(`milestone-store.ts`, `queue-store.ts`, `project-store.ts`) currently hardcode
`NULL`, so they have no dedup token at all; `store.ts` is the only one that
supplies one. Re-derivation plus the `sync_applied` ledger already makes double
emission impossible, so this is belt and braces rather than the primary defence —
but an at-least-once transport with an unkeyed event table is one retry away from
a duplicated timeline, and the seam lane is unifying those four emitters anyway.

This is a deliberate departure from the mutation inventory's classification, which
reads `events` as synchronizable. Transporting it would mean merging four
emitters' rows across devices, three of them with no dedup token, into a table
whose primary key is a local counter and whose unique index is a level-triggered
wake mechanism. Re-derivation gets the same converged content for free, because
the operation that caused the event is already being replicated and the event is a
pure function of it. (Pinned by the S3 lane's echo-suppression tests — an applied
operation must emit the event and must **not** journal a new outbound operation.)

## What never leaves the machine

An exhaustive list. Anything not on it and not in the tables above is a bug in
this contract, not a judgement call for an implementer.

| Value | Where it lives | Why it stays |
|---|---|---|
| The whole hub database | `~/.staple/hub.db` | `workspaces.path` is an absolute filesystem path and the registry names every *other* repository on the machine. Cross-repository topology is not this repository's business. |
| `meta.next_issue_number` | workspace db | Per-database counter; see [Identity](#identity-is-the-uuid-never-the-identifier). |
| `meta.settings_revision`, `meta.queue_revision` | workspace db | Derived cache-invalidation and CAS counters. Merged as `max()` so local optimistic concurrency stays monotonic. |
| `meta.schema_version` | workspace db | **Correctness, not privacy.** It describes the format *this binary* understands. Replicating it lets an older build be told it is newer than it is, defeating the `assertNotNewer` upgrade guard that exists precisely because version and file must travel together. |
| `meta` keys outside `slug`, `prefix`, `setting:*` | workspace db | Default-deny. A local counter added later must not start synchronizing because nobody updated this page. |
| `projects.source` where `source_kind = 'local'` | workspace db | An absolute filesystem path; discloses directory layout and the OS account name. Redacted per row, see above. |
| `events` (whole table) | workspace db | Re-derived on apply, see above. |
| `relations.id` | workspace db | Local `AUTOINCREMENT` surrogate. The natural key is `(blocker_id, blocked_id, type)`, which the `UNIQUE` constraint already declares. |
| `sqlite_sequence` | workspace db | SQLite's own `AUTOINCREMENT` high-water marks. Rebuilt by SQLite. |
| `.staple/snapshots/*.db` | workspace directory | Pre-migration snapshots — full copies of an older database. Replicating one would be catastrophic. |
| `queue_entries.rank`, `milestone_members.rank` | workspace db | Positional, recomputed from list order. |
| Cloud credentials | staple home, OS keychain or `0600` file | See [Trust boundaries](#trust-boundaries). |
| Device id and device secret | machine config | A device identifies itself; it is not a property of the repository. |
| `sync.auto`, `sync.backup` consent flags | machine config | Per-device by design, see [Three consents](#three-consents). |
| Sync cursors, outbox rows, applied-op ledger | workspace db, sync tables | Local bookkeeping about a shared log; not part of the shared log. |
| Absolute paths, hostnames, usernames | anywhere | Staple never *adds* one to a payload. Text a human typed into a title or a comment body is that human's to control. |

**The connection itself is machine-local.** Credentials and consent flags live in
the staple home, never in `.staple/staple.db` and never in the repository. This is
not tidiness: the workspace database synchronizes, so a credential stored there
would replicate itself to every device, and a `sync.auto` flag stored there would
mean one device enabling automatic sync silently enabled it for everybody — which
is exactly the consent this page promises not to spend on someone's behalf.

## The local sync tables

Sync bookkeeping is **additive**: it lands as new tables in the workspace
database and alters none of the thirteen that already exist. Nothing here
replicates — it is this device's record of its relationship to a shared log.

| Table | Key | Holds |
|---|---|---|
| `sync_entity_versions` | `(entity, entity_id)` | `version` — bumped once per journaled mutation, in the same transaction as the domain write. This is the `baseVersion` an envelope carries. |
| `sync_outbox` | `op_id` | `client_seq`, `entity`, `entity_id`, `verb`, `base_version`, `payload`, `actor`, `created_at`, `acknowledged_seq` — `NULL` until the server accepts it |
| `sync_applied` | `op_id` | `seq`, `applied_at` — the deduplication ledger that makes re-delivery a no-op |
| `sync_tombstones` | `(entity, entity_id)` | `deleted_at`, `device_id`, `op_id` |
| `sync_conflicts` | `id` | `entity`, `entity_id`, `field`, `base_value`, `local_value`, `remote_value`, `local_op_id`, `remote_op_id`, `local_device_id`, `remote_device_id`, `local_at`, `remote_at`, `detected_at`, `resolved_at`, `resolved_by`, `resolution` |
| `sync_leases` | `entity_id` | `fencing_token`, `holder`, `device_id`, `server_expires_at`, `acquired_at`, `renewed_at` |
| `sync_devices` | `device_id` | `label`, `last_seen_at`, `revoked_at` — a read cache of the server's device list, never authoritative |
| `sync_state` | single row | `repository_id`, `epoch`, `cursor`, `head_seq`, `last_sync_at`, `bootstrap_cursor`, `client_seq_high_water` |

The entity version lives in a side table rather than as a `version` column on
each synchronized table for one reason: it is sync metadata, not domain state,
and putting it beside the domain rows would make every existing schema-equivalence
and fixture test negotiate a change that has nothing to do with what an issue is.

### `client_seq_high_water` is allocated, never derived

`sync_state.client_seq_high_water` is a persisted monotonic counter, bumped on
allocation inside the same transaction as the domain write and the outbox row.
`sync_outbox.client_seq` is the per-row record of what was allocated. The two are
not the same thing, and the counter is **never** recomputed from the outbox.

**Deriving the next `clientSeq` from `MAX(sync_outbox.client_seq)` is forbidden.**
It is the obvious optimization — the value is right there, and the extra column
looks redundant — and it silently destroys data twice over:

- **Outbox compaction rewinds it.** Pruning acknowledged rows is a routine,
  correct operation, and it drops exactly the rows the maximum was reading. The
  counter restarts, the device re-mints operation ids the server already holds,
  the server deduplicates them and returns each original `seq`, and the client
  marks genuinely new work as acknowledged. The write is gone, no error is raised
  anywhere, and the two databases disagree from then on.
- **Re-bootstrap rewinds it.** A device that hydrates after a restore starts with
  an empty outbox and the same collision follows, against a log that explicitly
  still contains the originals because epoch bumps do not truncate.

Both failures are silent, which is what makes them worth this much prose. A
counter that only ever moves forward, stored where nothing prunes it, costs one
column.

`sync_state` holds the `repository_id` as well as the manifest, deliberately. The
manifest is the git-recoverable copy; `sync_state` is what the database itself
believes it is, and `staple doctor` compares the two. They disagree exactly when a
directory was copied or a manifest was hand-edited, which is the case worth
naming.

**Credentials are not in this list and never will be.** They live in the staple
home. This database synchronizes.

## Repository identity

A connected repository is identified by a UUID that survives cloning, because the
thing being shared is the repository, not the directory or the database file.

`.staple/repository.json` is checked in:

```json
{ "repositoryId": "0e77fa01-…", "format": 1 }
```

Non-secret by construction — an id and a format number, nothing else. It carries
no endpoint, no account, no token, and no membership. Publishing it discloses that
a repository *may* be connected and nothing about what is in it or who can read
it. `.staple/.gitignore` ignores `staple.db*` and deliberately does not ignore
this file, the same way it deliberately does not ignore `AGENTS.md`.

A fresh clone therefore recovers the identity from git alone, with no database
and no secret, which is what makes `staple cloud sync` on a bare clone able to
hydrate rather than to guess.

**A copied directory is indistinguishable from a clone, and converges.** Both
carry the same `repositoryId`, both push the same entity ids, and identical
content merges to itself. That is the correct outcome for a clone and a
surprising one for a fork, so forking is explicit: `staple cloud fork-id` mints a
new `repositoryId`, drops the local cursors and outbox, and leaves the original
repository untouched. A repository whose manifest names an id the server does not
know, or one the device is not a member of, fails closed with `forbidden` — it
never auto-creates a repository to make the error go away.

Two different repositories presenting the same `repositoryId` is a manifest that
was copied without forking. The server cannot detect it and does not try; the
diagnostic is local — `staple doctor` reports when a workspace's manifest id is
also registered to a different workspace path in the hub.

## The journal seam and what it owes

There is **no write chokepoint today**. Mutation is spread across roughly 45
functions and 52 independent `db.prepare(…).run()` sites, and the only existing
transaction wrappers are `tx()` in `src/core/db.ts` — which is not re-entrant —
and `WorkspaceStore.atomically()`, which nests via savepoints. Journalling is
therefore not a matter of adding a hook to an existing funnel; it is the work of
building the funnel. This section states what the funnel owes, so the lane doing
it has a target rather than a theme.

Every replicated mutation passes through one seam that guarantees, per logical
mutation:

1. **One transaction.** The domain rows, the `sync_entity_versions` bump, the
   `sync_outbox` row and the event are committed together or not at all. A failed
   mutation leaves no changed domain state and no orphaned outbox row.
2. **Exactly one operation.** One logical mutation journals one envelope, not one
   per table touched. `checkoutIssue` writes several columns and emits an event;
   it journals a single `issue.update`.
3. **A deterministic `opId`.** Derived, never random, so a retry regenerates it —
   see [the envelope](#the-operation-envelope). The `clientSeq` it is derived from
   is allocated from `sync_state.client_seq_high_water` in the same transaction,
   never read back out of the outbox.
4. **Echo suppression.** Applying a pulled operation performs the same domain
   write through the same seam and **must not** journal a new outbound operation.
   Without this, two devices synchronize forever.
5. **Idempotency-key respect.** `issues.idempotency_key` and
   `comments.idempotency_key` already exist and already deduplicate at the
   surface. A replayed key must produce no second outbound operation, not merely
   no second row.
6. **A `dedup_key` on every event.** See [above](#events-are-re-derived-never-transported).
7. **Nothing outside the boundary.** Schema migrations, snapshot writes and hub
   writes go nowhere near the seam. They are not repository state.

Re-entrancy is the trap. A seam that opens its own transaction while
`atomically()` already holds a savepoint will either deadlock or silently split a
mutation into two operations, and the second is worse because it converges
wrongly instead of failing loudly.

## The operation envelope

One shape, for every mutation, on the wire and in the outbox.

```json
{
  "opId":      "sha256-hex-32",
  "repoId":    "0e77fa01-…",
  "protocol":  1,
  "schema":    10,
  "entity":    "issue",
  "entityId":  "3f2b…",
  "verb":      "update",
  "baseVersion": 7,
  "payload":   { "status": "in_progress", "assignee": "opus-s1" },
  "deviceId":  "d41c…",
  "actor":     "opus-s1",
  "clientSeq": 412,
  "createdAt": "2026-09-05T12:23:31.876Z"
}
```

`entity` is one of `issue`, `comment`, `document`, `documentRevision`, `relation`,
`project`, `status`, `kind`, `setting`, `milestone`, `queue`, `lease`, `conflict`.
`verb` is `create`, `update`, `delete`, `replace` (ordered collections only), or
`renumber` (issues only).

`opId` is **deterministic**:
`sha256(repoId + "\n" + epoch + "\n" + deviceId + "\n" + clientSeq)`, first 32 hex
characters. A replayed or retried push regenerates byte-identical ids and the
server's uniqueness check absorbs it. An operation id is never random, because a
random one cannot be deduplicated after a lost acknowledgement.

**The `epoch` is in the derivation, and it has to be.** Operation ids are scoped
to an epoch exactly as `seq` and cursors already are. Without it, a device that
re-bootstraps after a restore re-mints ids that collide with operations still
present in the log — the epoch bump is non-truncating, so the originals are
*definitely* still there — and the collision happens in precisely the path the
epoch mechanism exists to make safe.

`clientSeq` is a per-device monotonic counter allocated inside the same
transaction as the domain write. Its home is
`sync_state.client_seq_high_water`, and the rules for it are in
[The local sync tables](#the-local-sync-tables). **It is never derived from the
outbox.**

Server-side, operation uniqueness is scoped **`(repoId, epoch, opId)`**, not
`opId` alone. The client derivation already makes ids epoch-unique, so this is
defence in depth: a client that gets the derivation wrong is *rejected* rather
than silently deduplicated. That distinction is the whole point — a wrong id that
deduplicates is indistinguishable from success, and loses the write.

`payload` carries **only the fields the mutation actually changed**, not the whole
row. Full-row writes would turn every concurrent edit into a conflict on fields
nobody touched.

`baseVersion` is the entity's local version immediately before the mutation. Each
synchronized entity row gains a monotonic `version` bumped once per journaled
mutation (the S2 migration). `baseVersion` is `null` for `create`.

**Unknown fields are preserved, never dropped.** A device receiving an entity
field it has no column for stores it verbatim and re-emits it unchanged on its own
later operations for that entity. This is the same discipline the settings
registry already applies to `setting:*` meta rows it has no definition for —
preserved, never read — and it is what lets a fleet run mixed versions through a
schema upgrade without the older device silently deleting the newer one's data.

## Routes and limits

One versioned prefix, `/v1`. Every repository-scoped route carries the
`repoId` in the path so authorization can be decided before the body is parsed,
and every request carries `Authorization: Bearer <token>`,
`Staple-Protocol: <n>` and `Staple-Device: <deviceId>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/capabilities` | Supported protocol `{ min, max }` and the current limits. The only unscoped route. |
| `POST` | `/v1/repos/{repoId}/connect` | Bind this device, mint a repository-scoped credential |
| `POST` | `/v1/repos/{repoId}/ops` | Push a batch |
| `GET` | `/v1/repos/{repoId}/ops` | Pull a page — `?cursor=&limit=` |
| `GET` | `/v1/repos/{repoId}/snapshot` | Bootstrap: materialized state plus the cutoff cursor |
| `POST` | `/v1/repos/{repoId}/leases` | Acquire a lease |
| `POST` | `/v1/repos/{repoId}/leases/{entityId}/renew` | Heartbeat |
| `DELETE` | `/v1/repos/{repoId}/leases/{entityId}` | Release — presents the fencing token |
| `GET` | `/v1/repos/{repoId}/devices` | List devices |
| `DELETE` | `/v1/repos/{repoId}/devices/{deviceId}` | Revoke a device |
| `GET` | `/v1/repos/{repoId}/backups` | List backups |
| `POST` | `/v1/repos/{repoId}/backups` | Create a backup |
| `POST` | `/v1/repos/{repoId}/backups/{backupId}/restore` | Restore |
| `DELETE` | `/v1/repos/{repoId}` | Purge — requires a separate typed confirmation token |

Push takes `{ protocol, deviceId, ops: [envelope…] }` and returns a per-operation
status, never a bare accepted/rejected split:

```jsonc
{
  "protocol":            1,
  "epoch":               7,
  "serverHighWatermark": 1042,
  "results": [
    { "opId": "…", "status": "applied",   "seq": 1039 },
    { "opId": "…", "status": "duplicate", "seq": 812  },
    { "opId": "…", "status": "applied",   "seq": 1041 }
  ]
}
```

**A `duplicate` carries the `seq` of its original application, not a new one.**
That is the whole point: a client that lost an acknowledgement reconciles from
this response without re-deriving anything. `duplicate` is a success, not an
error.

Because the batch is atomic, "partially applied" only ever means "some of these
were already here from an earlier *successful* attempt". It never means this
attempt half-succeeded.

### Limits

**The server advertises its limits and the client sizes batches from them.** Not
from a constant compiled into the client — the ceilings differ by plan, and a
client that hardcodes the paid number fails permanently on the free one.
`/v1/capabilities` returns `{ protocol: {min,max}, maxBatchSize, maxOpBytes,
maxPullLimit }`.

| Limit | Value | Why that number |
|---|---|---|
| Operations per push batch | **200** paid, **25** free | A push costs `N + 4` D1 statements, against a queries-per-Worker-invocation ceiling of 1,000 paid and **50** free |
| Single operation payload | **512 KiB** | Well under D1's 2 MB maximum row size, with headroom for the envelope |
| Pull page `limit` | default 200, maximum **500** | |
| Requests per device | 60/min, burst 120 | Policy, not a platform limit |

These replace the numbers this page carried before the Cloudflare research
landed; the earlier batch size of 500 was set without knowing the
queries-per-invocation ceiling and would have failed outright on the free plan.

Body size is checked from `Content-Length` and rejected **before** the body is
parsed. The free plan allows 10 ms of CPU per request, so a limit enforced after
`await request.json()` is enforced too late to help.

Exceeding a limit is `payload_too_large` or `rate_limited` — never a silent
truncation, and never a partially accepted batch. A document revision larger than
the payload cap is refused at journal time, on the device, with the same code, so
the failure surfaces where the human is rather than three hours later in a
background sync.

## Ordering, cursors and epochs

**The server assigns the order.** On accepting a batch it stamps each operation
with a `seq`, and that total order is the only order any device replays. Client
timestamps are metadata: they are recorded, they break ties where a tie-break is
needed, and they are never trusted for ordering or for expiry.

**`seq` is strictly increasing. It is not dense, and gaps are legal.** Sequence
numbers are reserved for a whole batch before the rows are written, so an
operation that turns out to be a duplicate leaves its reserved slot unused.
`…1039, 1041…` is a correct sequence. **A client must never assert
`next == last + 1`**, never treat a gap as data loss, and never derive a count
from a range. Pull is `WHERE seq > cursor ORDER BY seq`, which is gap-tolerant by
construction. The high-water mark only ever increases and is never recomputed from
`MAX(seq)`, so compaction and tombstone removal cannot rewind it.

**Pull is cursor-paged.** A cursor is an opaque string; clients treat it as bytes,
never parse one, and never synthesise one. It encodes four fields — a format
version, the repository id, the epoch, and the exclusive lower bound `seq` — and
it is **not signed**, because every field is re-validated against the
authenticated session and a forged cursor can only ask for rows the caller is
already entitled to. Signing would add a secret to rotate and remove no threat.

`GET /v1/repos/{repoId}/ops?cursor=…&limit=…` returns operations strictly after
the cursor, in ascending `seq`, within the current epoch, bounded by `limit`, plus
the next cursor and whether more remain. `hasMore` is computed by fetching
`limit + 1` and trimming — never by a `COUNT(*)`, which scans. A cursor naming a
different repository or a superseded epoch is rejected with `cursor_invalid` or
`epoch_changed` — never silently reset to the beginning, because a silent reset
replays the entire history into a live database.

**Apply is one transaction per page**, and idempotent: every applied `opId` is
recorded, and a re-delivered operation is a no-op. Within a page, operations apply
in `seq` order; an operation whose referent does not exist yet is deferred to the
end of the page and retried once. If it is still unresolvable when the page ends,
the page fails whole with `validation` and nothing is committed. Causality across
devices is mostly self-enforcing — a device cannot edit an entity it has never
seen, so the edit necessarily sorts after the create — but "mostly" is not a
guarantee to build an apply loop on.

**Bootstrap is a snapshot cutoff plus the ordered tail.** A hydrating device reads
a materialized snapshot taken at `seq = C`, then pulls from cursor `C` forward.
Writes concurrent with the snapshot are in the tail, so nothing is missed and
nothing is applied twice. Both halves resume from bounded cursors after an
interruption.

**An epoch is a discontinuity.** `epoch` is an integer stamped on the repository
and embedded in every cursor. A restore that moves remote state backwards
increments it. A device presenting a cursor from an older epoch gets
`epoch_changed`, which is not retryable: it must re-bootstrap before it may push
again. This exists so a restore can never quietly move the log out from under a
device that has already read past the restore point.

**An epoch bump is non-truncating.** The old operations stay, the high-water mark
keeps climbing, and `seq` is therefore a permanent identifier that is never reused
within a repository's lifetime. The alternative — delete everything and reset the
counter — is simpler and cheaper in storage, and is rejected because the fenced
lease tokens depend on a monotonic value that never restarts, and because a
restore is exactly the moment somebody wants the pre-restore rows for forensics.

### What the server cannot do

Three platform facts the protocol is shaped around, so that no lane designs
against a capability that does not exist:

- **There is no cross-request transaction.** None. A batched set of statements is
  a real SQL transaction and rolls back whole on any failure, and that is the only
  atomicity primitive available. Any design needing a transaction to span two HTTP
  requests — a multi-request bootstrap, a lock held across a round trip — is
  unimplementable and must be redesigned rather than approximated.
- **There is no separate coordinator, and none is needed.** The database is
  single-threaded and processes queries one at a time, which is exactly the
  serialization a coordinator would add. Sequence assignment is done in SQL: one
  statement reserves `N` slots by incrementing the high-water mark, and the
  inserts compute their own positions from the reserved window, all inside the one
  atomic batch. Nothing reads a number into application code and writes it back —
  that is the lost update this design exists to avoid.
- **`RETURNING` is not relied on.** The push response is derived from the
  pre-push watermark plus each statement's own applied/not-applied result, so the
  contract holds whether or not `RETURNING` is available. Deriving the response
  with `op_id IN (…)` is also forbidden: bound parameters are capped at 100 per
  query and that lookup would break at the batch sizes above.

**Sync never transports a database file.** No `staple.db`, no `-wal`, no `-shm`,
no `VACUUM INTO` output, in either direction, for sync or for backup. Operations
only. A SQLite file copied between machines carries page-level state that has
nothing to do with what the two repositories agree about.

## Deletion is a tombstone

**This section designs a capability the tracker does not currently have.** No
surface deletes an issue today — not CLI, not MCP, not HTTP. Rows leave only by
`ON DELETE CASCADE` when a parent goes, and `comments.deleted_at` is the schema's
only soft delete. Nothing below describes existing behaviour; it is the contract
deletion must meet *if and when* a delete surface is added, and it exists now
because a replicated system that acquires deletion later without tombstones
acquires resurrection at the same time.

Nothing synchronized is ever hard-deleted as a replicated act.

A `delete` verb writes a tombstone row — `(entity, entityId, deletedAt,
deviceId, opId)` — and the local row is removed only after the tombstone is
durable in the same transaction. Applying an `update` for a tombstoned entity is
a **no-op, not a resurrection**: the tombstone wins regardless of arrival order,
which is what makes convergence order-independent.

Tombstones are retained for the compaction horizon (below) and no less. A
tombstone dropped while any device's cursor is still behind it is exactly how a
deleted issue comes back to life, so compaction is bounded by the oldest live
device cursor and by nothing else.

`comments.deleted_at` is a soft delete that already exists and stays a field
update, not a tombstone — a redacted comment is still a comment. Hard deletion of
a comment row is a tombstone like anything else.

**Compaction preserves**: every unacknowledged outbox operation, every tombstone
newer than the oldest live cursor, every operation newer than the oldest live
cursor, and the conflict records referenced by any unresolved or recently
resolved conflict. A device that has not synced for longer than the horizon is
not silently broken — its next pull returns `epoch_changed` and it re-bootstraps.

Pruning **acknowledged** outbox rows is routine and safe, and it is safe only
because `client_seq_high_water` lives outside the outbox
([above](#client_seq_high_water-is-allocated-never-derived)). Compaction must
never be the thing that decides what the next operation id will be.

## Conflicts are preserved, never resolved silently

**No path applies last-write-wins.** Not for `updated_at`, not for `seq`, not for
"the server is authoritative". A conflict is data, and resolving it is a decision
a human or an agent makes on the record.

Detection is field-scoped: an incoming operation conflicts when its `baseVersion`
is behind the local entity version **and** its payload field set intersects the
fields changed by the local operations in between. Disjoint field sets are not a
conflict — two devices setting `priority` and `estimated_seconds` on one issue
both apply, and the version bumps twice.

A conflict record retains both sides in full: entity, field, base value, local
value, remote value, both `opId`s, both `deviceId`s, both timestamps. Unrelated
operations keep flowing while it sits unresolved — one contested field does not
stop the repository.

Resolution emits a **new** operation with `baseVersion` set to the post-conflict
version. History is never rewritten and no side is discarded from the record. The
resolution's `opId` is derived deterministically from the conflict id and the
chosen value, so replaying a resolution converges everywhere instead of forking
again. The conflict record survives its own resolution and survives compaction,
because "who chose what, and what the other option was" is the only thing that
makes a merged repository auditable afterwards.

Ordered collections conflict whole ([above](#ordered-collections-replicate-whole-not-row-by-row)):
both plans are retained and the human picks one, or edits a third.

## Claims: a local checkout is not a global lease

[continuity.md](continuity.md) describes today's model — an explicit claim, no
sweeper, no TTL, no expiry, takeover only when a human says "continue". None of
that changes. What changes is that a *connected* repository can make a claim
globally exclusive, and a disconnected one cannot and must stop implying it does.

**Offline, a checkout is local-only.** It still refuses a fresher holder on this
machine, it still refuses through gates and blockers, and it still records
`claim_stolen`. It says nothing about the other machine. So the claim payload
grows a scope, and every surface reports it:

- `claim.scope: "local"` — this database only. No global exclusivity is claimed.
- `claim.scope: "lease"` — a server lease is held; the claim is globally exclusive.

An agent that reads `local` and behaves as though it read `lease` is the failure
this field exists to prevent. Offline acquisition is **allowed** — refusing to
work without a network would be a worse tracker — and it is *labelled*, not
silently upgraded on the next sync.

**Connected, exclusivity comes from a fenced server lease.** Acquisition is a
server round trip; two devices racing produce one winner and one `conflict` that
is not retryable. Every lease carries a monotonically increasing fencing token and
a server-authoritative expiry. Renewal is a bounded, observable heartbeat.
Completing or releasing a remote task presents the fencing token, and a holder
that was expired, stolen or revoked is rejected — a stale token can never write,
however convinced its holder is. Client clocks have no authority over expiry.

Pulled lease operations project deterministically onto `checkout_agent` and
`checkout_at`, so `ls`, `show` and `inbox` keep rendering the fields they already
render; the token and the server expiry live in the sync tables, not in new
`issues` columns.

Takeover stays explicit. `--steal-if-stale` and `--if-stale` still mean what
[continuity.md](continuity.md) says they mean; connected, they additionally
require the server to agree the lease is stale. There is still **no sweeper and
no automatic takeover**, on either side of the wire.

## Three consents

Three decisions, three pieces of state, three revocations. None implies another.

| Consent | Granted by | Writes | Revoked by |
|---|---|---|---|
| **Connect** | `staple cloud connect` | credential in OS keychain or `0600` file, plus `sync.connected` and the endpoint in machine config | `staple cloud disconnect` |
| **Automatic sync** | `staple cloud auto on` | `sync.auto = true` in machine config | `staple cloud auto off` |
| **Backup** | `staple cloud backup enable` | `sync.backup = true` in machine config, plus a server-side flag | `staple cloud backup disable` |

All three are **per-device**. Enabling automatic sync on a laptop does not enable
it on a build machine, because the flag is machine-local and consent given on one
machine is not consent given on another.

**Connect shows before it asks.** It prints the endpoint, the `repositoryId` and
the account it is about to bind, and performs **no remote mutation** before the
answer. A declined connect leaves no credential, no config key and no server-side
record.

**A successful connection leaves sync manual.** Manual is the default and stays
the default; the only thing that synchronizes is `staple cloud sync`, run by a
human or an agent that decided to. Automatic mode is a second, separately named
decision, and turning it off does not disconnect.

What a surface may do at each stage:

- **Before connect** — render "not connected" and a static hint naming
  `staple cloud connect`. Static text. No probe, no reachability check, no "we
  noticed you might want to connect". The UI does not prompt.
- **After connect, manual** — offer a sync action and report cursor, pending
  count, epoch, device and mode. Ordinary commands still make no request; a
  `staple ls` on a connected repository in manual mode is as silent as a `staple
  ls` on a disconnected one, and that is a tested assertion, not an intention.
- **After automatic** — bounded triggers only: startup, post-write, long-running
  session, pre-checkout. Coalesced, jittered backoff, cancellable, bounded
  timeout. **A tracker command never blocks indefinitely on Cloudflare**; sync
  failure degrades to manual and reports, it does not hang `staple checkout`.
- **After backup** — export and retention commands appear. They do not touch
  cursors and cannot change convergence.

## The network rule — and the test that proves it

Today the runtime contains **zero outbound network call sites**. `src/ui/server.ts`
is an inbound listener bound to `127.0.0.1`; the one `fetch()` in the tree is in
the browser bundle (`src/ui/app/src/lib/api.ts`) calling its own origin on a
relative path; the installer stages a local payload and downloads nothing. The
invariant is therefore not a reduction to be achieved — it is a floor to be held,
and the assertion is literally zero rather than an allowlist.

### What counts as a violation

**Any attempted outbound call to a non-loopback destination, from the Staple
process, is a violation** — attempted, not succeeded. A DNS lookup that fails is
a violation. A socket that is refused is a violation. Intent is what is being
tested, so the spy counts calls, not results.

Not violations:

- `server.listen(port, "127.0.0.1")` — an inbound loopback listener is how
  `staple open` works.
- A connection whose destination is `127.0.0.1`, `::1`, `localhost` or a unix
  socket path.
- A subprocess the user explicitly invoked (`--exec` hooks under `staple events
  --follow` run the user's own command).

### Where the test lives and what it spies on

`test/network-silence.test.ts`, with the harness in
`test/fixtures/network-spy.ts`. The harness installs its spies **before the code
under test is imported**, and patches, at minimum:

| Target | Members |
|---|---|
| `globalThis.fetch` | the function itself |
| `node:net` | `connect`, `createConnection`, `Socket.prototype.connect` |
| `node:tls` | `connect`, `TLSSocket.prototype.connect` |
| `node:dns` and `node:dns/promises` | `lookup`, `resolve`, `resolve4`, `resolve6`, `resolveAny`, `resolveSrv`, `resolveTxt` |
| `node:http` | `request`, `get`, `Agent.prototype.createConnection` |
| `node:https` | `request`, `get`, `Agent.prototype.createConnection` |
| `node:http2` | `connect` |
| `node:dgram` | `createSocket` — UDP is still egress |
| `globalThis.WebSocket` | the constructor |

The list is a minimum, not a ceiling. It is written as "every egress primitive
Node exposes", so a lane that reaches for one not named here adds it to the
harness rather than concluding it is permitted.

Each spy records `(target, member, destination, stack)` and then **throws** rather
than proceeding, so a violation fails loudly at its call site instead of being
counted and forgotten.

The harness self-checks: it makes one sentinel call to a non-loopback address and
asserts the spy recorded it. A network-silence test that passes because the spy
was never installed is worse than no test, and this is the assertion that
distinguishes the two.

### The trap: `wrangler dev` runs remote by default

**`wrangler dev` defaults to remote execution.** `--local` is `false` unless
passed. A script that starts a dev Worker without `--local` reaches Cloudflare,
runs against real infrastructure, and does it silently.

This is the most likely way the zero-network invariant gets violated by accident,
and the violation would be invisible: the offending call happens in a `wrangler`
subprocess, not in the Staple process the spy is watching, so a network-silence
test could pass at the exact moment the suite was talking to the internet.

Every local invocation passes `--local` explicitly. No exceptions, no
convenience wrapper that omits it, and the flag is asserted present by whatever
script starts it rather than trusted to a default that has already changed once.

### Where the Worker's own tests live

The Worker is a self-contained package under `worker/`, with its own
`package.json` and its own test runner pinned to the version its Cloudflare
tooling requires. The repository root keeps its existing runner and its existing
suite, and root `npm test` neither runs nor is affected by the Worker's tests.
Two runners in one repository is the deliberate cost of not dragging 93 existing
test files through a major-version upgrade to satisfy a directory that did not
exist last week.

### The scenarios that must assert zero

Disconnected, on a workspace with no `repository.json` and no credential:

`install` · `init` · `new` · `ls` · `show` · `status` · `checkout` · `release` ·
`comment` · `doc --put` · `queue` · `inbox` · `events` · `tree` · `board` ·
`doctor` · `migrate` · `hub ls` · an MCP `initialize` handshake plus one call of
every mutating tool · `staple open` startup plus one authenticated API request.

Connected in manual mode, the same list asserts zero. Only `staple cloud sync`,
`staple cloud connect`, `staple cloud status --refresh` and the explicitly named
backup and purge commands may call out, and each is exercised separately with the
spy asserting the destination is the configured endpoint and nothing else.

The browser bundle is out of a Node process spy's reach, so it is covered
separately: the built asset is asserted to contain no absolute origin other than
the loopback one it is served from.

**No telemetry, no update check, no discovery request, ever.** Not gated behind a
flag, not "anonymous", not opt-out. There is no code path to disable, because
there is no code path. A future feature that needs one adds it to this section
first, with its own consent, or it does not ship.

## Trust boundaries

**The server is trusted for exactly two things**: assigning the total order of
operations, and arbitrating leases with an authoritative clock. It is trusted for
nothing else. Content it returns is schema-validated on arrival like any other
input, and a client never executes, resolves or path-joins anything it received.

**The server is not trusted for confidentiality against its own operator.** In
the first release, operation payloads are stored in plaintext in D1. Issue titles,
descriptions, comment bodies and document revisions are readable by whoever holds
the Cloudflare account. There is no client-side encryption, and pretending
otherwise would be the worst thing this page could do. **If you would not paste an
issue body into a hosted database, do not connect that repository.** End-to-end
encryption is a named limit below, not a silent omission.

**Credentials are repository-scoped bearer tokens.** Possession is membership, so
compromise is bounded to one repository — a token for one repository is rejected
for another, and an operation whose `repoId` does not match the credential's is
rejected before it is parsed. Tokens are least-privilege, stored on the device in
OS-protected storage with a `0600` file fallback, and never written to the
workspace database, the repository manifest, or git.

**The server stores only a hash of the token, never the token.** A database
disclosure therefore does not yield working credentials. `repoId` is bound into
every server statement from the authenticated session and never from the request
body, which makes cross-repository access structurally impossible rather than
merely checked; a body-supplied `repoId` that disagrees with the token's scope is
`forbidden`.

**Redaction is total.** No token, in whole or in part, appears in logs, events,
error messages, `--json` output, `staple doctor`, or the UI. Server logs redact on
the way in, not on the way out.

**TLS is required.** No plaintext transport, no certificate-validation escape
hatch, no `NODE_TLS_REJECT_UNAUTHORIZED` accommodation. A non-HTTPS endpoint is
refused at connect time, so it cannot be configured and discovered later.

**Every request is authorized before it is interesting.** Membership is checked
on every request, not at connection time; a revoked device fails its very next
request server-side, without disturbing other devices. Requests are bounded by
documented batch, payload and rate limits, and exceeding one is a stable typed
error rather than a truncation.

## Protocol evolution

Two version numbers, deliberately separate.

**`protocol`** is the wire contract — the envelope, the verbs, the routes. It is
an integer, currently `1`, sent in every envelope and as a request header. The
server advertises `{ min, max }`. A client outside that range is refused with
`protocol_unsupported`, carrying the supported range, **before any write** — no
partial batch, no half-applied page. The server supports the current version and
the one before it for at least one release cycle, so a fleet upgrades one machine
at a time.

**`schema`** is the workspace migration number, currently heading for `010`. A
device receiving operations stamped with a schema newer than it understands
refuses with `schema_ahead` and says which version to upgrade to. It never applies
part of a page and never guesses at a column it does not have. This mirrors the
refusal the migration runner already performs on a database written by a newer
build ([migration.md](migration.md)).

Within a protocol version, change is **additive only**: new optional fields, new
entity kinds, new verbs. Removing a field, renaming one, or changing the meaning
of an existing one requires a new protocol integer. Unknown fields are preserved
and re-emitted ([the envelope](#the-operation-envelope)), which is what makes
additive change safe on a mixed fleet.

### Error taxonomy

Errors reuse the shape the CLI already returns —
`{ code, message, retryable }` — and extend the existing vocabulary rather than
inventing a parallel one.

| Code | HTTP | Retryable | Means |
|---|---|---|---|
| `validation` | 400 | no | Malformed envelope, unresolvable referent, bad field |
| `auth` | 401 | no | Missing or invalid credential |
| `forbidden` | 403 | no | Not a member of this repository, or cross-repository `repoId` |
| `revoked` | 403 | no | This device was revoked; re-connect required |
| `not_found` | 404 | no | Unknown repository or entity |
| `conflict` | 409 | no | Lease lost, or a `baseVersion` conflict the server refused |
| `epoch_changed` | 409 | no | Cursor is from a superseded epoch; re-bootstrap |
| `cursor_invalid` | 400 | no | Cursor is unparseable or from another repository |
| `payload_too_large` | 413 | no | Batch or single payload exceeds the documented cap |
| `schema_ahead` | 422 | no | Operation stamped with a schema this device cannot apply |
| `protocol_unsupported` | 426 | no | Client protocol outside the server's supported range |
| `rate_limited` | 429 | **yes** | Bounded backoff, honour `Retry-After` |
| `unavailable` | 503 | **yes** | Transient server or transport failure |
| `offline` | — | **yes** | Client-side: no connectivity. Local work continues. |

Only `rate_limited`, `unavailable` and `offline` are retried. Everything else is a
decision for a human, and retrying it is how a client turns one bad request into a
sustained one.

## Backup, disconnect and purge are three different things

Conflating them is the most expensive mistake available here, so they are named
apart and behave apart.

**Disconnect** is local. `staple cloud disconnect` removes this device's
credential, stops all later cloud traffic, and preserves the entire local
database including pending outbox operations. Remote state is untouched, other
devices are unaffected, and reconnecting later resumes from the preserved cursor
or re-bootstraps.

**Purge** is remote, separately named, and never a flag on disconnect.
`staple cloud purge` deletes the repository's remote operations, materialized
state and backups. It requires typed confirmation, prints a retention disclosure
first — what is stored, where, for how long, and who can read it — and does not
touch the local database. Every other device's next request fails `not_found` and
they keep their local state.

**Backup** is a third opt-in and is disaster recovery, not convergence. It is a
point-in-time export with its own retention and its own commands. Creating,
retaining or deleting a backup changes no cursor and no convergence state.

**Restore is epoch-safe or it is not a restore.** It either appends compensating
operations that move the log forward, or it increments the epoch and forces every
device through a bounded re-bootstrap. It never moves remote state behind an
active cursor within the same epoch, it requires confirmation and a compatibility
check, and it takes a recoverable pre-restore snapshot first. It never merges
database files.

## What this is not — the STA-26 boundary

This epic replicates **Staple to Staple**. Every device runs the same schema, the
same vocabulary and the same semantics, so an operation means the same thing
everywhere and the only hard problems are ordering, exclusivity and consent.

External tracker integration — GitHub Issues, ClickUp, TaskLink field ownership —
is a different problem and stays a different epic. It maps Staple's model onto a
foreign one that has its own ids, its own statuses, its own permissions and its
own idea of what a comment is. It needs field ownership rules (which side wins for
which field), provider mapping, per-provider credentials and per-provider rate
limits. **None of that is defined here, and nothing here should be read as
defining it.**

What the two share, at most, is the journal: the S3 mutation seam records every
local mutation once, and an adapter may *read* that journal instead of
re-discovering changes by polling. What they must not share is a second
reconciliation engine. If an adapter appears to need its own outbox, its own
conflict table and its own retry loop, that is the signal for the STA-26
reevaluation to resolve — not a licence to build a parallel one alongside this
contract.

Concretely, this page defines no TaskLink field, no external id column, no
provider adapter and no field-ownership policy. It does not reserve names for
them either.

## Known limits

Honest gaps, so nobody discovers them the hard way.

- **No end-to-end encryption.** Payloads are plaintext in D1. The account
  operator can read every issue body. Stated in
  [Trust boundaries](#trust-boundaries) and repeated here because it is the single
  most important thing to know before connecting.
- **The hub does not synchronize.** Cross-workspace `blocks` edges and the
  identifier-prefix registry stay machine-local derived state in the first
  release, so a cross-workspace blocker resolved on one machine is not visible on
  another. `unresolvable → treat as blocked` ([architecture.md](architecture.md))
  is still the behaviour.
- **Provisional identifiers change once.** An issue created offline on a connected
  repository is renumbered when the server allocates its canonical number. The
  provisional identifier remains a resolvable alias, but a number written into a
  commit message before the first push points at an alias rather than the primary.
  Per-device number ranges would avoid the churn at the cost of an allocator
  round trip before the first offline creation; that trade is revisitable if the
  churn proves noisy in practice.
- **`document_revisions` has no foreign key to `issues`.** Orphaned revisions are
  already reachable locally today; sync does not introduce the hazard and does not
  fix it either.
- **`cross_links` is repository state trapped in a machine-local file.** A
  cross-workspace dependency is a fact about two repositories, but it lives in the
  hub, which does not synchronize. Naming the tension is all this release does
  about it.
- **Ordered-collection conflicts are all-or-nothing.** Two humans reordering the
  queue offline get two whole plans and pick one. There is no per-row merge, on
  purpose.
- **A device offline longer than the compaction horizon re-bootstraps.** Its
  pending local work survives — the outbox is never compacted — but it pays a full
  hydration to rejoin.
- **Attachments and binary content are out of scope.** Documents are text; the
  payload cap is a text cap.
- **The free plan ceiling is roughly 50,000 operations per day, and it is a hard
  failure.** As of 2026-09-01 the free-tier daily quotas are enforced rather than
  advisory: queries return errors until midnight UTC once the account exceeds
  100,000 rows written per day. The operations table writes about two rows per
  operation — one to the table, one to its unique index — plus one per batch for
  the high-water mark. **This is the scale to design for.** A two-machine tracker
  will not approach it, and nothing in this contract should be optimized as though
  it might.
- **Ten milliseconds of CPU per request on the free plan.** Enough to parse a
  200-operation batch and hash a token; not enough to parse a multi-megabyte body.
  It is why the size check reads `Content-Length` instead of measuring the parsed
  body.
- **One repository per connection.** There is no cross-repository transaction and
  no operation spanning two repositories, by design.
