# Cloud sync

Optional, repository-scoped synchronization so two machines share one Staple
workspace and coordinate agent claims. Local SQLite stays the working database:
every read and every write a command performs still goes to `.staple/staple.db`,
and sync moves *operations* between that file and the cloud out of band. Nothing
on this page changes what a command does when it is not asked to sync.

This is the contract the S tickets implement. It was written before any of it was
built, and most of it now is: the seam, the envelope, identity, the Worker,
connect, manual sync, conflicts, leases, the surfaces, automatic sync and backup
all ship. Every rule names the test that pins it, or that will. Where this page
and [semantics.md](semantics.md) disagree, semantics.md describes today and this
page the target.

**Two parts of this page describe a design that is specified but not yet
shipped**, and they are marked where they appear rather than only here, because a
contract that does not distinguish the two is read as a description of the build:
server-side [identifier allocation](#identity-is-the-uuid-never-the-identifier),
and honouring `Retry-After` in the [error taxonomy](#error-taxonomy). Everything
else on this page is implemented.

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

> **Not yet shipped — the three bullets above are the design, not the build.**
> Neither half of the allocator exists. The push response carries `opId`, `status`
> and `seq` and no identifier, there is no renumber-on-acceptance path, and no
> surface marks an identifier provisional. So the collision this section says
> cannot happen *can*, and what ships instead is detection: `apply.ts` gives the
> incoming issue a locally free provisional identifier and records a
> `sync_conflicts` row on the `identifier` field, applying the rest of the entity
> rather than dropping it. Resolving that conflict frees the contested number and
> renumbers whichever issue was holding it, which is why `renumber` is a real verb
> today — it is emitted by *conflict resolution*, not by an allocation response.
> Nothing is lost silently, but a human settles what one authority was supposed to
> make unaskable. **STA-254** owns closing this, and owns recording which of the
> two options this page names — a single allocator or per-device ranges — was
> taken.

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
ordered list of entity ids**, checked against **the base revision it was computed
from**:

- `queue.replace` — payload `{ order: [issueId…] }`, on the singleton plan entity
- `milestone.replaceMembers` — payload `{ members: [issueId…] }`, on the
  milestone, which the envelope already names in `entityId`

**There is no per-row queue or membership operation.** No `queue.insert`, no
`milestone.addMember` on the wire. Membership changes only ever travel as a whole
replaced list, which is what makes the `UNIQUE` rank constraints unreachable: rank
is never transported, it is recomputed densely from list order inside the same
transaction that applies the list. A concurrent insert on two devices cannot
violate a constraint, because neither device ever sends a rank.

**The base revision is the envelope's `baseVersion`, and is not repeated in the
payload.** It is the entity's version from `sync_entity_versions` — **not**
`meta.queue_revision` or `milestone_meta.members_revision`. Those two are
device-local cache-invalidation and CAS counters for the local editor; they are
derived, they merge as `max()` so the local optimistic-concurrency checks stay
monotonic, and they are bumped on apply like any other local write. Two counters,
deliberately: one is what this database has seen, the other is what the
repository agreed. The existing local editor keeps using the local one and needs
no change ([queue.md](queue.md)).

A `baseRevision` key inside the payload would be a second copy of a number the
envelope already carries for every operation — a second thing that can be wrong,
and one that `screenForConflicts` would additionally have to special-case, since
a payload key on an ordered collection is otherwise a contestable field of that
collection and this one is not. One token, in the one place every operation
already puts it. Likewise `milestoneId`: the envelope's `entityId` is the
milestone, and a payload copy is a second name for it that can disagree.

A `replace` whose `baseVersion` is behind the applied version is a conflict on
the *plan*, recorded whole — both orderings preserved — and never merged. A human
reordered a plan; the machine does not get to average two plans.

**That check is unconditional, and the wording matters.** Field-scoped detection
elsewhere additionally requires the incoming payload to name a field some *local
operation in between* also named, which keeps *"Disjoint field sets are not a
conflict"* true. An ordered collection has no disjoint field sets: it is one
pseudo-field carrying the whole list, so `baseVersion` being behind is already
proof that this device has seen a change to that list which the sender had not.
The extra condition adds nothing here, and reading it off the outbox would cost
the guarantee outright in two ordinary situations — a device holding an order it
*applied* rather than authored has no outbox row and never will, and outbox
compaction routinely prunes the row of a device that did author one. Detection
that expires with housekeeping is not detection. So the comparison stands on the
version alone, on every device, whether or not it can name the operation that
produced the order it is defending.

When it cannot, the conflict record's `localOpId` is `null`. Both orderings are
still retained in full, which is what a human is being asked to choose between;
what is unavailable is only the attribution of the incumbent side. One
consequence follows and is deliberate: a conflict id is derived from the two
operation ids, so a record with an unattributable side has an id no other device
computes. **A resolution therefore settles every open record on that device for
the same `(entity, entityId, field)`**, not only the one whose id it names —
otherwise a decision everyone converged on would leave a device still reporting
an open conflict about a plan that was decided. Records already resolved are
untouched, including ones resolved to a different value.

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
| `workspaces.path`, `workspaces.last_seen_at` | `~/.staple/hub.db` | An absolute filesystem path, and an observation this machine made about its own disk. Neither means anything on another machine. Re-resolved by adoption; see [The hub registry](#the-hub-registry-is-a-set-not-a-map). |
| `hub_events`, `registry_optouts`, hub `meta.schema_version` | `~/.staple/hub.db` | `hub_events` is level-triggered and re-derived from the edges. `registry_optouts` is this machine's decision about its own list and is meaningless elsewhere — that is what makes an unregister local. The schema version stays for the same reason the workspace one does, one row above. |
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
| `sync.auto`, `sync.backup`, `sync.registry` consent flags | machine config | Per-device by design, see [Three consents](#three-consents). |
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
| `sync_field_writes` | `(entity, entity_id, field)` | `base_version`, `op_id`, `device_id`, `written_at` — the NEWEST write of one field, whoever made it. Written by the journal seam, by the apply path and by a bootstrap, so a relayed value and an inherited one both have provenance and a create-time default has none. Only the newest is kept, which bounds the table by live entities rather than by history — so nothing time-based prunes it, and detection cannot expire with housekeeping. |
| `sync_tombstones` | `(entity, entity_id)` | `deleted_at`, `device_id`, `op_id` |
| `sync_conflicts` | `id` | `entity`, `entity_id`, `field`, `base_value`, `local_value`, `remote_value`, `local_op_id`, `remote_op_id`, `local_device_id`, `remote_device_id`, `local_at`, `remote_at`, `detected_at`, `resolved_at`, `resolved_by`, `resolution` |
| `sync_leases` | `entity_id` | `fencing_token`, `holder`, `device_id`, `server_expires_at`, `acquired_at`, `renewed_at` |
| `sync_devices` | `device_id` | `label`, `last_seen_at`, `revoked_at` — a read cache of the server's device list, never authoritative |
| `sync_state` | single row | `repository_id`, `epoch`, `cursor`, `head_seq`, `last_sync_at`, `bootstrap_cursor`, `client_seq_high_water` |

One piece of sync bookkeeping is deliberately not a table: the record that a
database has [seeded](#a-workspaces-history-reaches-the-service-when-it-first-synchronizes)
its repository is a device-local `meta` row, `sync_seed`, because a table would be a
migration and a migration moves the `schema` every operation carries.

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

### A workspace does not have to be a repository

Nothing in the identity path invokes git. The manifest is a plain JSON file, and
version control is only how a *repository-backed* workspace carries its id to a
machine that has no database yet. A workspace created with `staple init --global
<slug>` is never cloned, so it needs no recovery from a tree — it simply needs
somewhere of its own to keep the file.

That somewhere is `<home>/workspaces/<slug>/repository.json`, a directory named
for the workspace, beside the `<slug>.db` it belongs to. Not
`<home>/workspaces/repository.json`: that directory is shared by every global
workspace on the machine, and one manifest there would give all of them one
identity. The database does not move to get this, so an existing global
workspace gains an identity by gaining a sibling directory — no data rewritten,
no registered path changed.

The same is true of a workspace in a plain directory — one that is not in the
staple home and not in a version control checkout either. It keeps its manifest
in its own `.staple/` beside its database, exactly as a repository does, and it
falls under the same rule as a global workspace for the same reason: nothing will
ever clone it, so nothing will ever run `init` in it a second time.

`staple init` mints it, and so does every `openWorkspace` of a workspace that is
not checkout-backed. The asymmetry with a checkout is deliberate: a checkout gets
its identity from `init`, which is the first command anybody runs in a fresh
clone, and minting a file inside somebody's checkout on a read path would be a
surprise — the manifest there is a *committed* file, so an untracked one is a
diff nobody asked for. Every other workspace has no second ritual, so open is the
only door it has.

Whether a workspace is checkout-backed is a bounded walk for a `.git` marker
above its identity directory. It is a file test and never a subprocess, and it
gates nothing about identity — both answers mint one. It decides only which
*copy* story applies, which is the subject of the next section.

### A copied home is not a second device

A global workspace lives at a fixed path inside the staple home, so restoring a
backup of `~/.staple` onto a second machine puts the same identity at the *same*
absolute path on both. There is no clone to tell them apart, and the copy is
worse than a clone in the way that matters: it carries the database, the cursors,
the device credential and `client_seq_high_water`. Two machines allocating client
sequences from one copied counter mint deterministic operation ids for *different*
work, and the server's dedup — the thing that makes a lost acknowledgement safe —
discards the loser silently.

So a home-resident workspace records `sync_state.origin_host`: a digest of the
machine that minted its identity. The digest is the one thing a restore cannot
bring with it, because it is derived from the machine and not from the home.
Detection needs no version control, no network and no second machine to compare
against.

The value is NULL for every checkout-backed workspace, and that is the
semantics rather than an omission. One repository id at two machines is what a
clone *is*, and clones are required to converge. `STAPLE_HOST_ID` overrides the
detection for environments where the heuristic is wrong in either direction;
setting it wrongly defeats the check.

**It is not only the home.** A workspace in a plain directory is in the same
position in every respect that matters: a copy of it — a restored backup, an
rsync, a folder a file-sync service put on a second machine — arrives carrying
the database, the cursors and `client_seq_high_water`, and there is no clone to
tell the two machines apart. So every workspace that is not checkout-backed
records `origin_host`, and the section heading is kept as it was only because
three modules cite it by name.

The binding is to the MACHINE and never to the path, which is what keeps a
*moved* workspace from being read as a *copied* one. Renaming a directory,
re-nesting it, or dragging it across this disk changes nothing and says nothing.
Two copies at two paths on ONE machine are still not detected here — they have
the same fingerprint — and remain the business of the hub collision diagnostic
above.

When the recorded host is not this machine:

- `staple cloud sync` refuses before it opens a session, so nothing is sent and
  no credential is read. The refusal is inside `syncRepository`, which is also
  the only path automatic sync takes.
- `staple cloud lease acquire` refuses, for the same reason: an exclusive claim
  taken under a shared identity is the same hazard.
- `staple cloud status` reports it as a warning rather than dying of it, so
  somebody trying to find out what is wrong gets an answer.
- `staple cloud fork-id` is the way out: a new identity, the positions dropped,
  and the workspace re-bound to this machine. Removing the copy is the other way
  out, and the diagnostic names both because only a person knows which machine
  should keep the identity.

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

**The seam is disarmed until the machine has a device id**, which only `connect`
mints, so a workspace journals nothing until then — and a journal is a record of what
changed, never of what exists. What a workspace held before it was armed reaches the
service by [the seed](#a-workspaces-history-reaches-the-service-when-it-first-synchronizes),
not by the seam.

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
`project`, `status`, `kind`, `setting`, `milestone`, `queue`, `lease`, `conflict` at
protocol 1, plus `registration` and `crossLink` at protocol 2 — the hub registry, and
the reason the vocabulary is version-scoped rather than merely growing. See
[The hub is a repository](#the-hub-is-a-repository-and-that-is-the-whole-mechanism)
and [Protocol evolution](#protocol-evolution). `verb` is `create`, `update`,
`delete`, `replace` (ordered collections only), or `renumber` (issues only).

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

**The hub registry derives its ids differently, and has to.** `clientSeq` lives in
`sync_state`, and `hub.db` has no `sync_state` — so a hub operation id is derived from
the operation itself: `hub:<epoch>:<entity>:<32 hex of entityId, verb, baseVersion and
payload>`, where `baseVersion` is the number of operations the service has already folded
into that entity. It keeps the property that matters, which is that a retry regenerates a
byte-identical id.

**The `baseVersion` term is load-bearing, and it is not this machine's number.** Keyed on
the entity alone the id would be unique per entity per epoch rather than per operation, and
a second write to one registration would be absorbed as a duplicate and read as an
acknowledgement. Hashing the payload closes that and opens the same hole displaced in time:
a registry value can legitimately return to a value it held before — a workspace renamed
back, an edge retracted and re-added — so a slug going `alpha → beta → alpha` re-derives the
first id, collides with its own earlier appearance, and the write is dropped while the push
reports success. `baseVersion` is monotonic in the number of operations folded into the
entity, so no two operations on one entity can share an id however often the content cycles.

Which means the id *does* depend on a counter — the service's, not one nothing allocates.
The Worker's fold counts operations per entity (`entry.version += 1` per row in
`worker/src/fold.ts`), `GET /snapshot` reports that count as the entity's `version`, and the
publishing client reads it back off the snapshot it already fetches in order to compute the
diff, then carries it on the operation as `baseVersion` — 0 for a `create`, because nothing
has been folded yet. The allocation is remote and the read is local, which is exactly what
keeps retries safe: a retry re-reads the snapshot, re-derives the same diff, and so derives
the same base version and a byte-identical id.

The dedupe role of the id is a **backstop rather than the mechanism**, which is worth saying
because the version that hashed only the content was designed as though it were the
mechanism. Idempotency comes from `publishRegistry` re-reading `GET /snapshot` and
re-deriving the diff: an operation that already landed is excluded before an id is computed
at all. The id only has to be unique; being reproducible is what makes a retried batch cheap.

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
| `PUT` | `/v1/repos/{repoId}/backup` | Set the server-side half of the backup consent |
| `GET` | `/v1/repos/{repoId}/backups` | List backups |
| `POST` | `/v1/repos/{repoId}/backups` | Create a backup |
| `DELETE` | `/v1/repos/{repoId}/backups/{backupId}` | Delete one backup — retention |
| `POST` | `/v1/repos/{repoId}/backups/{backupId}/restore` | Restore — resumable; call until `done` |
| `DELETE` | `/v1/repos/{repoId}` | Purge — requires a separate typed confirmation token |

Two of the backup routes were added after this table was first written. `PUT /backup`
exists because the consent table below grants backup with "a server-side flag" and
named no route that writes one, and a consent recorded only in a file on the device is
not the two-sided consent described there. `DELETE /backups/{backupId}` exists because
backup has "its own retention", and retention without a delete is not retention — the
alternative, an expiry job, would destroy a human's backups on a schedule nobody typed.

**Restore is one route called in a loop.** It answers with `staged`, `entityCount` and
`done`; a caller keeps calling with the `restoreId` it was given until `done` is true.
Which phase runs — take the pre-restore snapshot, stage the next chunk, or commit — is
decided from durable state rather than from anything the caller asks for, so a client
that lost its place recovers by calling again and being told where it actually got to.
Staging is chunked at `maxBatchSize` for the same reason a push is.

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

It was not true of one kind of device: one on a build before
[the seed](#a-workspaces-history-reaches-the-service-when-it-first-synchronizes),
which edited issues it had never uploaded. Those edits sit in the log with no create
behind them until some device seeds or heals, and the create then lands at the END
of the log — arbitrarily many pages later, beyond the end-of-page retry. An operation
on an entity this database does not hold, carrying none of the fields only a create
carries (an issue's identifier, a comment's issue, a project's slug, a status's
category), is therefore a missing referent — it is never inserted with invented
values. And a page that fails for a missing referent is answered by **one read of the
snapshot**, applied in one transaction, after which the tail resumes from the cutoff
that snapshot pinned: a snapshot folds every operation on an entity into one state
whatever order they arrived in, so an update followed much later by its create folds
to a complete entity. This is the timeline the device is already on, so nothing is
forgotten — the ledger, versions and field record stay, and inherited provenance is
taken at the fold's own numbers rather than lifted as a re-bootstrap into a new epoch
lifts it. Once per sync; if the snapshot cannot resolve it either, the sync fails,
naming the referent.

**Bootstrap is a snapshot cutoff plus the ordered tail.** A hydrating device reads
a materialized snapshot taken at `seq = C`, then pulls from cursor `C` forward.
Writes concurrent with the snapshot are in the tail, so nothing is missed and
nothing is applied twice. A re-bootstrap — the one an epoch change forces —
resumes both halves from bounded cursors after an interruption. A database's
FIRST synchronization reads the snapshot whole before it writes anything, because
[the seed](#a-workspaces-history-reaches-the-service-when-it-first-synchronizes)
has to know everything the repository holds before it decides what to upload; a
death during that read costs a re-read and leaves nothing half-written. The tail
after it resumes from its cursor like any other.

**A snapshot is paged for resuming, not for applying.** Pages are ordered by entity
key, `"<entity> <entityId>"`, which is a stable order a cursor can resume from and
not a dependency order: `comment …` and `documentRevision …` sort before `issue …`,
a child issue sorts before its parent whenever its UUID does, and `status @order`
sorts before every status it orders. So a device applies what it holds in
dependency order — definitions, then issues parents first, then what names an
issue, then the collections and orders last — and an entity whose referent is on a
later page is **parked** rather than failed. Parked entities are stored with the
bootstrap position, in the same transaction as the page that delivered them, so a
process that dies between pages resumes still holding them. Only when the whole
snapshot is in hand does a missing referent fail, whole and loudly, exactly as the
pull loop fails a page. A vocabulary order is parked until then regardless: applied
before the last status of its class arrives it would silently skip the ids it
cannot find, and there is no referent check that could catch that. Before this, a
fresh device could not hydrate a repository with a single comment in it — the
comment arrived ahead of its issue on every attempt.

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

**Non-truncating means the rows are retained, not that a snapshot spans epochs.**
A snapshot folds only operations stamped with the *current* epoch, and that is
correct: the current epoch is the timeline every connected device is on. The
obligation this places on restore is absolute, and it is the trap in this whole
mechanism — **a restore that bumps the epoch must also materialise the restored
state as operations in the new epoch.** Bumping alone leaves the new epoch empty,
and a device that re-bootstraps into it hydrates nothing while the old rows sit
there being retained for forensics that nobody asked for. The two options a
restore may take are *append compensating operations* or *bump the epoch and
re-materialise*; "bump the epoch" on its own is not one of them.

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

## A workspace's history reaches the service when it first synchronizes

Every workspace that existed before it connected was written while the journal was
disarmed — no device id on the machine, so
[no outbox rows and no version rows](#the-journal-seam-and-what-it-owes). The outbox
is a record of what changed after arming, not of what exists, so without more a
connected workspace uploaded none of its history: the first sync reported *"Pushed
nothing"*, a second device hydrated an empty repository, and the first edit to a
pre-connect issue reached that device as an operation on an entity it had never
received, which the pull loop deferred for ever. That is every real workspace,
because every real workspace predates its connection.

So a database **seeds** the repository: it uploads the state it already holds as
ordinary operations. The code is `src/core/cloud/seed.ts`; the tests are
`test/cloud-seed.test.ts`, whose pre-connect data is made through the real CLI in a
home that has never connected.

**When.** At the first `staple cloud sync` after connecting — by a human, or by
automatic sync a human turned on — and never at `connect`. Connecting is the
consent to upload this repository's data, but it is not consent to synchronize now:
[a successful connection leaves sync manual](#three-consents), and a connected
workspace in manual mode stays exactly as silent as before. The seed runs inside
`syncRepository`, which is the only path either kind of sync takes, so it follows
the same consent rules as every other upload and needs none of its own. `connect`
says, before anything is sent, what the first sync will upload.

**Exactly once per repository per database.** The seed is one local transaction:
the operations and a record that it happened commit together, so however the
process dies it has either seeded or not. The record is a device-local `meta` row,
`sync_seed`, holding the repository id and what was done. Not a column: a column is
a workspace migration, the migration number is what every operation carries as
`schema`, and a device receiving a page stamped above its own schema refuses it
with `schema_ahead` — one bookkeeping column would make every device on an older
build refuse every operation this build emits. `meta` keys outside `slug`, `prefix`
and `setting:*` never replicate, so the row never leaves the machine. It names the
repository because `staple cloud fork-id` mints a new one, and a fork has received
nothing, so it owes a seed of its own — which is also what finally makes a fork's
outbox, dropped by `fork-id`, reach the new repository.

**Resumable.** The upload is the ordinary outbox push: acknowledged operations drop
out, and a batch whose acknowledgement was lost is re-sent with byte-identical ids
and absorbed as `duplicate`. Deciding the seed takes one read of the snapshot and
writes nothing, so a death there costs a re-read.

**What travels.** Everything the repository does not already hold, in an order a
receiver can apply: settings, statuses and their order, kinds and theirs, projects,
issues parents first, blocker sets, comments, document revisions, milestones, and
the plan. A built-in status or kind still carrying the label and category it was
installed with is not sent — every device holds it already, by construction — and
a vocabulary order is sent only when it differs from the one a receiver would build
by appending, which is where a receiver puts an entry it has never seen.

**The first device and a device joining a repository that has data are one rule:**
*upload every local entity the repository does not hold, and take the repository's
state for everything it does.* On an empty repository that is everything this
device holds. Entity ids are UUIDs, so two independent histories share no issue,
comment or project; what they can share is a name, and names are settled like this:

- **The repository's names win, and this device's yield.** The repository's issue
  is already `STA-5` on every connected device; this device's `STA-5` has never been
  seen by anybody. So a local issue whose identifier the repository uses is
  renumbered to the next number above both — and gets a comment saying so, because
  the old number is already in somebody's commit message and there is no alias
  table: the comment travels with the issue, `staple show` prints it, and a search
  for the old identifier finds it. A project slug the repository uses gets a free
  suffix. An issue retry key (`idempotency_key`) or a live external origin the
  repository already holds is cleared on the local duplicate. Each of these happens
  before anything is applied or uploaded, which keeps every `UNIQUE` index on both
  sides reachable: a collision left for a receiver would be a constraint failure
  that fails its page for ever. Without the renumbering, the incoming repository
  issue took the provisional `STA-5+1` and an identifier conflict opened for a
  disagreement no two devices were having.
- **What the repository holds, it keeps.** A status, kind or setting of the same
  name, and anything a copied database shares by id, takes the repository's value.
  Every local value that replaces is reported by name, before and after, in the sync
  output and in `sync_seed`; a value this device never chose — a built-in label
  still at its default — is not a replacement and is not reported.
- **What this device adds to a repository collection, it keeps.** A local issue in
  this device's plan is appended to the repository's plan, and the same for a
  milestone's members and an issue's blocker set. Those are ordinary `replace` and
  `update` operations against the repository's version of the collection.
- **The pre-join journal is replaced by the seed.** A workspace can have been armed
  for part of its life — any other repository connected on the same machine mints
  the device id every workspace arms with — and its outbox then holds updates to
  rows whose create was never journaled, allocated before the creates they need. A
  push sends in allocation order, so that journal cannot be sent as it stands. The
  seed carries every local entity's current state, which already contains every
  effect those operations described, so they are dropped, together with the
  versions and the field record they counted.

The sync reports which case happened, in these words: *"Uploaded N existing items
(…). The repository was empty, so this workspace's history is now the
repository's."* or *"This repository already had data (N items); bootstrapped from
it, and N items of this workspace's were added (…)."*, followed by every
renumbering, cleared token, merge and replaced value.

**The operations are ordinary operations**, and fit [the envelope](#the-operation-envelope)
unchanged: each takes a `client_seq` from `client_seq_high_water` and an id derived
from the repository, the epoch the database is on, the device and that sequence. The
seed's operations are `create`s, and a create records no provenance, so a seeded
entity has no `sync_field_writes` rows — the same line the journal and the server's
fold draw. Its version is **set** to the number of operations the service will hold
for it, not bumped: conflict detection compares every device's counter for an
entity, and only works when they count the same operations, so a counter carried
from a pre-connect journal or a forked repository would leave this device
permanently ahead of every device that hydrates the entity, and a counter that is
ahead stops seeing concurrent edits as conflicts. After a seed, disjoint edits on two
devices converge and an edit to the same field is contested on both, as anywhere
else.

**Chunked like any push.** Batches are sized from `capabilities().maxBatchSize`, as
for every push. D1's 100-bound-parameter cap does not reach them: the Worker binds
one statement per operation and looks duplicates up through one `json_each`
parameter.

**What cannot go, and says so.** The service refuses a payload over `maxOpBytes`
(512 KiB) for the whole batch, so one oversized operation would fail the same push
on every sync and nothing behind it would ever leave. The seed decides instead. A
document revision is immutable and nothing names it, so an oversized one is left
behind and named. Anything else is a row other rows depend on; the seed refuses,
names it, writes nothing, and the fix is to shorten it and sync again. A revision
whose issue no longer exists (see Known limits) is named and left behind, because no
device could place it.

**A database that synchronized under a build that did not seed** is healed once, on
its first sync by a build that does. It has been synchronizing, so an entity it
holds and the repository does not may be one a restore rolled back — which the
restore meant, and re-uploading would undo. A heal therefore sends only what is
provably this device's and provably missing: an entity nothing ever journaled or
applied, an entity the repository holds only as updates with no create, and an
entity with unsent operations and no create anywhere in the outbox. A repository
issue that arrived while a local one sat on its number gets the number back, its open
identifier conflict closed on the record. A device that stopped on the old build's
edits — ones naming rows nobody had uploaded — gets past them on its next sync by
[reading the snapshot](#ordering-cursors-and-epochs), which the heal has made complete.

**A heal sends what is already queued first, under the ids it was queued with, and
never gives an operation a new id.** Any unacknowledged operation may have landed
with its acknowledgement lost — a dropped connection, a killed process, automatic
sync's budget aborting the request — and only its own id comes back `duplicate`; the
same operation under a new id is applied a second time, at a later `seq`, over
whatever landed in between. Measured before this rule: A's edit landed with its
acknowledgement lost, Y set a newer title, A healed, and the log read A, Y, A — so
every device that hydrated afterwards got A's older title. Sending the queue first
also means the survey the heal decides from already counts it. The cost is that a
queued edit can reach the service ahead of the create the heal sends for the entity it
names; a receiver that meets it there recovers from the snapshot, and out of order is
recoverable where applied twice is not.

**Two syncs of one database at once seed once.** A manual `staple cloud sync` can
overlap an automatic one started by an MCP write or the UI, and nothing but the
database's write lock serializes them. So the seed decides whether it is owed — and
whether this is a join or a heal — inside its own transaction, under that lock, and
the second sync to reach it finds the record and does not seed. Before, the second
seeded again from state the first had replaced: every entity created twice on the
service, and this device's counters never agreeing with anyone's again.

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

The second condition is read off `sync_field_writes`, which holds **the newest
write of each field of each entity** — the version it moved off, and the
operation and device that made it. Every path that can change a field writes it:
a locally journaled mutation from the journal seam, an applied remote operation
from the apply path, and a value folded into a
[bootstrap snapshot](#per-field-provenance-through-a-snapshot). For ordered collections the condition is still
[dropped](#ordered-collections-replicate-whole-not-row-by-row), because there is
one field and the version comparison already carries the whole answer.

It used to be read off the outbox, and the outbox is the wrong witness. It is a
queue of what this device has to *send*, and the question is what this device
*holds*:

- **A relayed value was never in it.** A device that applied another device's
  `title` journals nothing — that is [obligation 4](#the-journal-seam-and-what-it-owes) —
  so it held a title somebody had chosen with no row naming it, and handed it to
  the next stale write in silence.
- **It is emptied.** [Compaction](#deletion-is-a-tombstone) prunes acknowledged
  rows as routine, after which even the *author* could no longer defend its own
  edit.

**Detection that expires with housekeeping is not detection.** The field record
does not expire: only the newest write per field is kept, so it is bounded by
live entities rather than by history and nothing time-based ever prunes it.
Compaction removes rows for **tombstoned entities only** — an update to a
tombstoned entity is a no-op regardless of arrival order, so those rows could
never have been evidence for anything.

One limit is real and it is not hidden: a database upgraded to schema 11 whose
outbox had already been compacted has nothing to backfill from. There `localOpId`
is `null`, both values are still retained in full, and the
[settle rule](#ordered-collections-replicate-whole-not-row-by-row) is what closes
a record whose id no other device computes.

### Per-field provenance through a snapshot

A device that **bootstrapped from a snapshot** holds values it neither authored
nor relayed. It used to hold them with no provenance at all, so the next stale
write to an inherited field was accepted in silence.

Recording the snapshot's fields wholesale would have been *wrong*, not merely
incomplete. A `create` carries the entity's whole field inventory, defaults
included, so under that rule a later `priority` edit would contest a `medium`
nobody ever chose — manufacturing conflicts out of defaults, which is worse than
the silence it replaces.

So the fold carries it. Each snapshot entity ships `fieldWrites`: for every key a
**non-`create`** operation touched, the version that write moved off, the
operation id, and its timestamp. Keys only a `create` carried are absent, which is
the whole distinction — a key present is one somebody set, a key absent is one
that arrived carrying its default. That is the same line the journal seam draws
for local writes, so a bootstrapped device ends up holding field-for-field what a
device present for the entire log holds, and the two answer detection identically.

`fieldWrites` is a sibling of `state`, not a transformation of it: a collection
still [arrives identically](#bootstrap-is-a-snapshot-cutoff-plus-the-ordered-tail)
whichever half of a bootstrap carried it. It is bounded by fields written per
entity — a subset of the state's own keys — so the fold grows with live data and
with no term in history, the same bound the field record itself has.

A **backup** stores the fold without it. A restore materialises into a new epoch
that restarts entity versions and re-mints operation ids, so provenance from the
old epoch would name a timeline that no longer exists.

The restored epoch then carries whatever its own materialised operations leave,
and that is not nothing. An entity materialised as a `create` leaves no claim at
all; an ordered collection materialises as a `replace` — that is what
`materializedVerb` is for — and leaves one. So the guarantee is not "no
provenance". It is that **a restore leaves no claim that can outrank a later
write**: a materialised operation is its entity's first in the epoch, so the claim
sits at `baseVersion 0`, and every device hydrates the restored epoch at version 1
before it can write anything, so `base_version >= 1` can never select it. What the
claim buys is attribution — a plan contested after a restore names the restore
operation, which every device computes identically, instead of naming nobody.

There is no cheaper rule that would exclude it. "Skip the entity's first
operation" looks like the tidy generalisation of the create exclusion and is
wrong: an ordered collection's first operation *is* a `replace` in ordinary use,
because `QueueStore.recordPlan` never journals a create. That rule would strip
provenance from the first plan anybody actually chose.

**A re-bootstrap clears the field record.** Every row in it is denominated in the
epoch being left behind — a `base_version` on that epoch's counter and an `op_id`
minted in it — and an epoch bump makes both worthless. Keeping them is not
conservative: a re-bootstrapped device would contest an ordinary post-restore edit
using a row from the discarded timeline, while the device that made the edit
recorded no conflict at all. `beginBootstrap` therefore clears it for the same
reason it already clears `sync_applied`. The versions still stay, because they
govern what this device will go on to *emit*; a field write is never emitted, only
read, and a stale answer to "have I written this since version X" is worse than no
answer. What clearing would lose on its own — provenance for operations still
sitting in the outbox — is replayed back from the outbox once the snapshot half
completes, since that is the one thing a re-bootstrap deliberately preserves.

A conflict record retains both sides in full: entity, field, base value, local
value, remote value, both `opId`s, both `deviceId`s, both timestamps — except
that `localOpId` is `null` when the operation that produced the incumbent value
is not nameable here. Unrelated operations keep flowing while it sits unresolved
— one contested field does not stop the repository.

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
- `claim.lease` — `{ fencingToken, serverExpiresAt }` when the scope is `lease`,
  and `null` when it is `local`. The two facts a local checkout cannot supply, so
  a reader can **confirm** the distinction instead of trusting the word. Both are
  the server's values; rendering `serverExpiresAt` is allowed, deciding from it
  is not.

`scope` is reported by the everyday read surfaces — `ls`, `show` and `inbox`, and
their MCP and HTTP projections — not only by the lease commands. A field visible
only to a reader who already thought to ask about leases does not prevent the
mistake it exists to prevent, because the agent about to make that mistake is
running `inbox`.

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

## The hub registry is a set, not a map

The hub used to be on the never-leaves list whole. The reason given was that
`workspaces.path` is an absolute filesystem path, and that cross-repository
topology is not a repository's business. Both halves of that are still true, and
neither is weakened here.

What the rewrite separates is the **paths** from the **set**. Which workspaces
exist, what they are called, what prefix each one holds and which of them block
each other are facts about the person's work, not about this computer's disk.
Where each one happens to sit is a fact about the disk and stays on it.

So the hub publishes a set:

| In a hub backup | Not in a hub backup |
|---|---|
| `repository_id`, `slug`, `prefix`, `kind`, `added_at` per workspace | `path` — the original objection, and it stands |
| `cross_links`, each end by its workspace's `repository_id` and the issue identifier, with the slugs for display | `last_seen_at`, `hub_events`, `registry_optouts`, `cross_link_changes`, `meta.schema_version` |
| The hub's own id | **Any task. There is no issues table in `hub.db`.** |

That last row is the one to say out loud, because a person will reasonably assume
that backing up "the hub" backs up their work. It does not. Issues, comments,
documents and attachments live in each workspace and are backed up per workspace,
under that workspace's own backup consent. Every surface that offers a hub backup
has to say so in those words.

**Topology still does not ride in a repository's channel.** A hub backup is not
reachable from any workspace's sync or backup; it travels under the hub's own
identity and its own consent or it does not travel. What genuinely changes is
that it *can* travel, and the disclosure that buys is real: a machine that
publishes its registry tells the service the names, prefixes and identities of
every workspace on it, and that they sit together. Until now the wire could not
express that and the invariant was free. It is no longer free, so it is paid for
explicitly — a separate consent, granted by itself, with that sentence in front
of it.

### The hub is a repository, and that is the whole mechanism

The service is repository-scoped end to end: a credential resolves to exactly one
`repo_id`, a backup is a fold of one repository's operation log, and a restore
materialises that fold into a new epoch of the same log. There is no second storage
shape and no route that accepts a blob.

So the hub becomes a repository, scoped by its own identity, and **its operation log
carries the registry**. Backup is then the existing fold and restore is the existing
snapshot. This feature adds no persistence mechanism at all, which is why this shape
was chosen over inventing one.

Two entity kinds, at protocol 2:

| Entity | Key | Payload |
|---|---|---|
| `registration` | the workspace's `repository_id` | `format`, `slug`, `prefix`, `kind`, `addedAt`, all on the `create` only |
| `crossLink` | `rid/` + the blocker's `repository_id`, blocker identifier, blocked `repository_id`, blocked identifier, each percent-encoded, joined with `/` | on the `create`: `format`, `blockerWs`, `blockerIdentifier`, `blockedWs`, `blockedIdentifier`, `type`, `present: true`; on an `update`: `format` and `present` only |

They are two entities rather than one blob because the fold is per entity and is
last-write-wins: one entity holding the whole registry would make every publish
rewrite every workspace, so two machines editing two different workspaces would each
supersede the other's row. **The granularity of the entity is the granularity of the
conflict.**

`replace` and `renumber` are refused for both, by name and not merely by falling
outside the ordered-collection allowlist. Neither is an ordered collection, and
`renumber` is about identifiers the hub does not own.

The cross-link key is an **encoding, not a hash**: `encodeURIComponent` escapes the
separator, so distinct four-tuples cannot collide, and a log row stays readable. It
follows the `document` precedent, whose key is already `"<issueId>/<key>"`. The edge
`type` is deliberately not in the key, so changing an edge's type is an update rather
than a delete plus an unrelated create.

**The key contains no slug** (STA-287). A slug comes from a directory name, so two
machines holding the same repositories under different directory names disagree about
every slug. Keyed on slugs, their links were unrelated entities, and neither machine
could adopt the other's. Keyed on the two repositories' identities, a link is the same
entity on both. The slugs stay in the create's payload so a person reading the log can
tell what the link is. They are the first publisher's names, never updated.

A PR #94 build keyed links on the four slugs and identifiers. Those entities are still
in logs it wrote. They have four components and this key has five, so they can never
be misread as this build's. Publishing ignores them. Adoption reports each one as
skipped, saying the machine that has the link publishes it again under the new key on
its next publish. Neither side crashes on one or loops over it.

**A `registration` with no `repository_id` is not publishable.** The entity id *is*
the adoption key, and minting one locally is the fork the manifest exists to prevent
— the real repository would record its own id later and the registry would hold two
rows for one workspace. Such an entry is reported by name, never invented and never
silently dropped.

**This wire emits no `delete`, for either entity, and the Worker refuses the verb.**
A tombstone is final in the fold, which is right for an `issue` whose id is minted once
and wrong for an entity whose id is **derived from its content**. Removing a cross-link
and adding it back produces the same entity id, lands on the tombstone, and is discarded
while the push reports success — and a restore carries the tombstone into the new epoch,
so the epoch bump is not an escape. Retraction is therefore a field: an `update` to
`present: false`, and linking again is an `update` back to `present: true`, which the
fold's plain merge already handles. A missing `present` reads as present, so edges
published before the field existed are not lost. The `opId` includes the entity's base
version, so a link removed and linked again any number of times never collides with
its own earlier operations.

**`workspaces.repository_id` is written by `staple init`**, from the manifest that is its
authority — measured, not assumed: after clearing the column, `staple ls` and
`staple ls --ws <slug>` both leave it null and `staple init` restores it. It is the adoption key, and until STA-283 nothing on a user-facing
path wrote it at all: `Hub.register()` runs before the manifest exists and `connect` never
touched it. So publish uploaded an empty registry and adoption could not recognise a
workspace this machine already had. A row whose workspace has not been re-inited since is
reconciled at publish, adopt and restore. An identity held by two rows is **reported, not
published** — two clones or two worktrees of one repository legitimately share one, and
publishing both would make the registered name flip between them on every pass.

### Publishing is a union: any number of machines, one converged registry

Any number of machines can publish to one registry. They converge on the same set, and
a machine that is behind can publish safely (STA-287). A publish never refuses a machine
for lacking something the service holds. Before STA-287 it did, because a publish could
destroy another machine's data. Every destructive path is gone now, so a publish only
ever adds:

- **Names are create-only.** A registration's `slug`, `prefix`, `kind` and `addedAt`
  are sent once, on the `create`, and never updated. That is correct, not merely
  convenient: staple has no rename operation. No statement in `src` updates
  `workspaces.slug`, and a workspace's stored slug beats its directory name. So two
  machines disagree about a name only when they chose different directory names at
  `staple init`, and the first name the registry learned is the right one to keep.
  (If two machines' very first publishes cross in flight, the fold keeps the create it
  applies last. Either way, nothing changes the names afterwards.) A machine that calls a
  workspace something else is told so in `renamed` ("this machine calls it
  `alpha-clone`; the registry calls it `alpha`"), and nothing is sent. Measured before
  this rule: two machines alternating publishes emitted one operation per pass, 8 in 8
  passes, for ever. Measured after it, against real workerd: `[3, 0, 0, 0, 0, 0]`, the
  first machine's creates and then nothing from either.
- **A registration is never deleted.** `staple hub unregister` is local. See below.
- **A cross-link is retracted only by the machine that removed it.** `Hub.removeCrossLink`,
  which is what `staple hub unlink` and MCP's `cross_unlink` both call, records
  the removal in `cross_link_changes` (hub migration 004), keyed on the link's portable
  identity. The next publish sends `present: false` for a recorded removal the service
  holds as present, once. A machine that merely *lacks* a link sends nothing. It may never
  have adopted the link, or it may have parked the workspace at one end, and absence is
  not a decision. That authority rule is why a publish cannot destroy anyone's link.
- **A retracted link is put back only by a machine that linked it again.**
  `Hub.addCrossLink` (`staple link`, MCP's `cross_link`, and the UI's cross-workspace
  blockers) records a (re)link. The next publish
  sends `present: true` for it if the service holds the link as retracted, and then
  forgets the record. A machine that still holds a link another machine retracted has a
  copy older than the retraction. It sends nothing, and says so: `adopt --apply` removes
  the copy, and `staple link` followed by a publish shares it again.

**Once holds through a failed publish, too.** A publish can fail after its operation
landed: a later chunk fails, or the Worker commits and the response is lost. Each
recorded act is stamped with the epoch and entity version it is sent against just before
its chunk is pushed, and settled as soon as the chunk lands. On the next publish, an
entity still at the stamped epoch and version means the operation never landed, so it is
sent again against the same version, with the same opId. An entity that has moved means it
landed, or something newer happened after this machine read it. Either way the act is
settled and **not** sent again, so a retry can never overrule a decision another machine
made after seeing this one. Measured against real workerd (`scripts/hub-registry-live.ts`,
step 1.8): a retraction whose response was lost, followed by another machine linking it
again, leaves the link linked. With the check removed, the retry retracted it a second time.

The stamp is kept only for an act that **may** have landed. A push the service refused
with a 4xx rolled back whole (the Worker's batch is atomic, and every 4xx is decided
before it or by its predicate), so the stamp is cleared. A 5xx is ambiguous, because a
step after the commit can still fail, so the publish re-reads once: an entity still at
the stamped version never took the act, and its stamp is cleared. A cleared act is owed
like one never tried, and goes out on the next publish, after a restore too. Only a
possibly-delivered act keeps its stamp through a restore, and then it is settled rather
than replayed into the new epoch. If it did land, another machine may have seen it and
decided otherwise, and the restored backup may hold that newer decision.

A removal record is kept after it is published. It is this machine's standing refusal to
take the link back: an adopt that finds the link present in the registry leaves it removed
here and says so (`kept_removed`). It is never re-sent, either. If another machine links it
again later, that is a newer decision, so it stands in the registry, and this machine keeps
its own copy removed. `staple link` on this machine is what takes it back.

What the service holds that this machine lacks is left alone and **reported**:
`unadopted` on the publish report, printed as "the service holds N entries this machine
doesn't have — `staple hub registry adopt` previews taking them on". An identity this
machine unregistered, and a link it removed, are not counted, because those absences are
this machine's own decisions.

Adoption carries a removal the other way. A link the registry holds as `present: false`
that this machine still has is removed here by `adopt --apply` (`removed`), unless this
machine linked it again since and has not published that yet (`kept_linked`). Taking a
retraction on does not record a removal here, so if another machine links it again later,
the next adopt brings it back.

The whole cycle, measured against real workerd with two homes and two real clones under
different directory names (`scripts/hub-registry-live.ts`, walk 2): A's link reaches B
between B's own names; A's `hub unlink` reaches B, and B's stale copy is neither
re-published nor brought back by a second adopt; A's re-link reaches B; B's unlink
reaches A; A linking it again after that stands in the registry while B keeps its own
removal; and B, while behind, publishes without touching anything of A's.

**A link lands on this machine only where it can.** Adoption matches each end to a local
workspace **by `repository_id`**, never by slug. The identifier must then carry the prefix
this machine holds that repository under. A repository initialised separately on two
machines can get two prefixes, because a prefix is derived from the directory name when
the workspace is first initialised: a clone in `tracker/` gets `TRA` and a clone in
`staple-tracker/` gets `STA`. Then the registry's `TRA-3` names no issue here. **That is a fact about the data, not a defect, and it is the rule:** the
link is reported as skipped with that reason, and staple does not renumber a prefix to
make it fit. The same holds for an identifier the local workspace does not contain, an
end whose workspace did not land here, and a link that would close a cycle. Each is
skipped with its own sentence, and the preview runs the same checks as the apply.

### Adoption, not duplication

A new machine matches an incoming entry on `repository_id`, the clone-surviving
UUID from the tracked `.staple/repository.json`. Slugs and prefixes are names,
and names are exactly what two machines can independently disagree about.

Every adoption begins by filling `workspaces.repository_id` in from each
workspace's own manifest, so a clone this machine has registered is recognised by
identity before any name is compared.

- **Already registered here under that identity** — adopted. This machine's name
  and path stay as they are.
- **Not here at all** — the row lands with **no path**. It states that the
  workspace is registered elsewhere; nothing is invented for it, because a registry
  that points at the wrong directory is believed. If you already have the
  workspace, `staple hub registry locate <slug> --path <dir>` attaches it — and
  **refuses** unless that directory's own `repository.json` holds the row's
  identity, because the one moment somebody offers the wrong directory is the
  moment they are unsure where it went. If you do not have it yet, clone it and run
  `staple init`, which registers the real row against the identity the placeholder
  is holding.
- **Prefix or slug already held by a different identity** — the entry is parked
  and named, and **nothing is renumbered**. A prefix is stamped into the workspace
  database and into every `PREFIX-N` that database ever emitted, including in
  commit messages and handoffs no migration can reach. The hub is derived state
  and does not overrule a stamp. There is no rename verb and no re-stamp verb, so
  the parked entry has exactly two resolutions and the refusal names both: keep
  what you have and leave the published entry out for good with
  `staple hub registry ignore <repositoryId>`, or give up the local row with
  `staple hub unregister <slug>` and adopt again.
- **Previously removed here** — declined, because `registry_optouts` says this
  machine does not want it back. Undone with
  `staple hub registry unignore <repositoryId>`. A **live local row always wins
  over an opt-out**, and re-recording a workspace's identity retires the opt-out:
  the two are contradictory records of one fact, and the row is the one backed by a
  file on disk. Everything currently opted out is listed by
  `staple hub registry status`, because a suppression nobody can see is worse than
  one they can.

There is no outcome in which adoption goes looking for a workspace by scanning the
filesystem. That is `staple discover`'s job, and an adoption that guessed would be
a registry pointed at a directory nobody checked.

Adoption **never deletes a local row**. An incoming set is another machine's
knowledge, not an instruction about what this machine should stop having. The one thing
it removes is a cross-link another machine retracted, and only when this machine has
not linked it again since. See "Publishing is a union" above for the link rules.

### Unregistering is local, and deliberately does not propagate

`staple hub unregister` removes a row here and nowhere else. It is already the
soft half of a pair — the hub is derived state, the authoritative slug and prefix
live in the workspace file, and the next command run inside that repository
re-registers it. Propagating it would turn a reversible local act into an
irreversible remote one: on the other machine there is no repository to
re-register from, so the row would be gone for good.

To keep the removal from being undone by the next adoption, the machine records
the identity in `registry_optouts`, which never leaves. The entry remains on every
other machine, and the surface says so rather than implying otherwise. Removing
an entry from a shared registry is a purge-shaped operation and is **not** offered
yet; see the note on purge.

`--with-links` (and `staple hub prune --with-links`) removes the links naming that
workspace from this hub, and does **not** record them as removals. They go because the
row went, not because anyone decided the links should stop existing. So they stay in the
published registry, and they come back here if the workspace is registered here again and
this machine adopts. `staple hub unlink` is the verb that removes a link everywhere.

### Every limitation of the hub registry, in one place

The rule this list exists to keep: a limitation is either **refused in code, with a message
naming what to do instead**, or **stated here and at the point of consent**. Anything in
neither category is a bug. Each entry below says which it is.

1. **A workspace keeps the first name the registry learned.** Names are create-only, so a
   machine that calls a workspace something else never changes the published name.
   *Reported* on every publish (`renamed`: "this machine calls it X; the registry calls it
   Y"), and *stated* at the point of consent. Nothing is overwritten and nothing is billed
   for it: two machines alternating publishes emit no operations after their creates.
2. **A link lands on a machine only where its identifiers mean something there.** Each end
   is matched by `repository_id`. If this machine holds that repository under a different
   prefix, or its workspace has no such issue, the link is *reported* as skipped with that
   reason on adopt. Staple never renumbers a prefix to make it fit. See "Publishing is a
   union".
3. **A workspace with no `.staple/repository.json` cannot be published**, and neither can
   a link with an end in one. *Refused*, per entry, naming `staple init` in that workspace —
   measured to be the only command that records the identity.
4. **Two local rows sharing one identity** (two clones or worktrees of one repository) are
   parked rather than published, because one identity is one registry entry. *Refused*,
   naming `staple hub unregister`.
5. **A prefix or slug collision on adoption is never resolved by renumbering or renaming.**
   *Refused*, naming the only two performable resolutions: `staple hub registry ignore
   <repositoryId>`, or `staple hub unregister <slug>` followed by adopting again. There is
   no rename verb and no re-stamp verb, and the refusal says so rather than implying one.
   It no longer blocks publishing: the parked entry is reported as one this machine
   doesn't have.
6. **A workspace removal never propagates; a link removal propagates from the machine that
   made it.** `staple hub unregister` stays local, for the reason above. `staple hub unlink`
   is recorded and published once, and a machine that merely lacks a link never retracts
   it. *Stated* here and at consent, and *reported* on the publish that sends it
   (`retracted`) and on the adopt that applies it (`removed`, `kept_removed`, `kept_linked`).
7. **An edge tombstoned by a pre-`present` build cannot be resurrected.** *Reported* as
   unpublishable, naming a restore from a backup taken before the deletion as the only
   route.
8. **A link published by a PR #94 build, under slug names, can't be placed.** *Reported* by
   adopt as skipped, naming what fixes it: the machine that has the link re-publishes it
   under the repositories' identities on its next publish. Publishing ignores the old
   entity, so it never loops.
9. **A repository holds a hub's registry or a workspace's data, never both (STA-290).**
   `repos.vocabulary` is claimed by the repository's first write, or set when it is
   provisioned. After that, a push or a restore of the other vocabulary is *refused* with
   `conflict`, before anything is written, and the client names the remedy: the other
   vocabulary needs its own repository. Registry operations that reached a workspace's log
   before migration `0005` are still there. The recovery recipe in `worker/README.md` is
   what an operator uses to remove them. *Refused*, plus *stated* for the pre-`0005` case.
10. **Provisioning is out of band.** Staple cannot create the hub's `repos` row: there is
   no provisioning route and no account model. *Refused* with a message that names the
   step and points at `worker/README.md`, rather than failing as a permission error —
   which is what the wire genuinely returns.
11. **Adoption never searches the filesystem.** A workspace the hub does not know about
    lands `absent`; attaching it is `staple hub registry locate <slug> --path <dir>`, which
    refuses unless the directory's own identity matches. *Refused*, naming the verb.

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
- **After automatic** — bounded triggers only: startup, post-write and
  long-running session. Coalesced, jittered backoff, cancellable, bounded
  timeout. **A tracker command never blocks indefinitely on Cloudflare**; sync
  failure degrades to manual and reports, it does not hang `staple checkout`.

  **There is deliberately no pre-checkout trigger.** An earlier draft of this
  page listed one. It is not merely unimplemented — it is refused, and the
  reason is what it would mean rather than what it would cost. A pull
  immediately before a local claim returns a view already stale by the time the
  claim is written, and it would read to a human as *"checkout is coordinated
  now"* when the only thing that coordinates a checkout across devices is a
  [lease](#claims-a-local-checkout-is-not-a-global-lease). The leases lane made
  global exclusivity a separately named `cloud` verb precisely so nothing on the
  everyday path depends on a service being reachable; a pre-checkout sync is
  that dependency wearing a better name. `checkout` is a mutation, so it fires
  `post-write` — the claim is pushed promptly once it has been taken, which is
  the half of the value that is true.
- **After backup** — export and retention commands appear. They do not touch
  cursors and cannot change convergence.

### The fourth consent: publishing the hub registry

The heading above says three because three is the number of **per-repository**
consents, and that has not changed. This one is **per-machine**, and it is a
different kind of decision, which is why it is a subsection rather than a fourth row
in that table.

| Consent | Granted by | Writes | Revoked by |
|---|---|---|---|
| **Publish the registry** | `staple hub registry publish --enable` | `sync.registry = true` on the HUB's connection record, keyed by the hub id | `staple hub registry publish --disable` |

**Connect, automatic sync and backup do not imply it, and it implies none of them.**
It is its own consent because it discloses something none of the other three does:

> a machine that publishes its registry tells the service the names, prefixes and
> identities of every workspace on it, and that they sit together.

That sentence appears **verbatim** wherever the consent is granted and wherever it is
refused. It is not reworded per surface: a disclosure with a different wording on
each screen is a disclosure whose strongest wording is whichever screen the person
did not read.

Connecting one repository says nothing about any other repository. Automatic sync
says nothing about *what* is synchronized. Backup says a copy may be **kept**, not
that the shape of the machine may be **described**. Until this feature the wire could
not express the last of those at all and the invariant was free; it is no longer
free, so it is paid for explicitly.

What it does not upload is stated at the same moment, because a person will
reasonably get it wrong about a thing called "the hub": no filesystem paths, no
tasks, and not the list of workspaces this machine has removed —
`registry_optouts` never leaves, which is what keeps `staple hub unregister` local.
`cross_link_changes` never leaves either: a link this machine unlinked or linked again
reaches the registry as that link's `present` flag, and the record of who did it stays
here.

The same block says what publishing from more than one machine does: names are sent once
and never overwritten, nothing another machine published is removed, a link leaves the
registry only when the machine that removed it publishes, and adopt takes on whatever this
machine lacks.

Granting it requires the caller to hand the disclosure back to the setter, verbatim, as
evidence that it rendered one. That is not authentication — the constant is exported and
anyone can look it up — it removes the case where a surface writes the flag having never
had the sentence in hand, which is how a disclosure actually goes missing. Withdrawing
requires no acknowledgement; making it harder to turn off than on would be the wrong
asymmetry in a revocation that has to work offline.

There is **no server-side half** to this consent, unlike backup. There is no wire
spelling for "this machine may describe itself" and no route that takes one, and
inventing a flag would mean the service storing a permission it cannot enforce —
every operation the consent gates is an ordinary push the credential already
authorizes. So it is enforced entirely client-side, by every egress path on that leg
beginning with the check.

Turning it off stops this machine publishing. It does not delete what has already
been published; removing an entry from a shared registry is a purge-shaped operation
and is not offered.

Keeping point-in-time copies of the registry is a **further** decision, and reuses
the ordinary backup consent on the hub's own connection record. A person may
reasonably want the registry replicated and no history of it kept.

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
`staple cloud connect`, `staple cloud status --refresh`, `staple cloud lease
acquire|renew|release` and the explicitly named backup and purge commands may
call out, and each is exercised separately with the spy asserting the
destination is the configured endpoint and nothing else.

The lease commands deserve naming rather than being folded into "the cloud
commands", because of what they are next to. `staple cloud lease acquire` is the
only verb in the tree that both talks to the service and changes an issue's
claim, and the reason `checkout` is still in the zero list above is that the two
are separate commands rather than one command with a flag. The connected
assertions are therefore run on a repository that is connected **and** holds a
row in `sync_leases`: without the row, "`checkout` made no call" could be true
merely because there was no lease to consult, which is the shape of a test that
passes for the wrong reason. `staple cloud lease status` asserts zero on both
sides of the connection, and `staple cloud lease acquire` asserts zero on a
*disconnected* repository — where it still succeeds, claims locally, and says
`scope: "local"`, because offline acquisition is allowed and labelled rather
than refused.

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
an integer, currently `2`, sent in every envelope and as a request header. The
server advertises `{ min, max }`, presently `{ min: 1, max: 2 }`. A client outside
that range is refused with `protocol_unsupported`, carrying the supported range,
**before any write** — no partial batch, no half-applied page. The server supports
the current version and the one before it for at least one release cycle, so a
fleet upgrades one machine at a time.

Protocol 2 adds the two hub registry entities and nothing else. `min` stays at 1,
so every protocol-1 client keeps working unchanged, and the client's own floor
stays at 1 too: `CLIENT_PROTOCOL` is 1 and only the hub registry leg declares 2.
A client that declared 2 for everything would be refused outright by any Worker
not yet redeployed, which would turn a hub feature into a total sync outage on
every repository on the machine.

**`schema`** is the workspace migration number, `010` as of the sync tables. A
device receiving operations stamped with a schema newer than it understands
refuses with `schema_ahead` and says which version to upgrade to. It never applies
part of a page and never guesses at a column it does not have. This mirrors the
refusal the migration runner already performs on a database written by a newer
build ([migration.md](migration.md)).

Within a protocol version, change is **additive only**: new optional fields.
Removing a field, renaming one, or changing the meaning of an existing one requires
a new protocol integer. Unknown fields are preserved and re-emitted
([the envelope](#the-operation-envelope)), which is what makes additive change safe
on a mixed fleet.

**A new entity kind is NOT additive, and this page used to say it was.** That was
wrong about the client that exists, and the correction matters more than the
mistake. An unknown *field* is stored verbatim and re-emitted; an unknown *entity*
is not ignored — `applyToDatabase` throws `Operation names entity "…", which this
build does not know`, and the pull loop defers only an unresolvable referent. So an
older device handed an entity added after its release fails the page and stops
converging, reporting something that reads like corruption rather than like
"upgrade".

Making the client ignore unknown entities instead would be worse: a skipped
operation still advances the cursor, so it would be skipped for ever rather than
deferred — the same silent non-synchronization that filtering a batch client-side
was already reverted for. A refusal is right; it just belongs at the request
boundary rather than inside a fold.

Therefore a new entity kind takes a protocol integer, and the vocabulary is
version-scoped on the server. A protocol-1 client cannot push a protocol-2 entity,
and `GET /ops` and `GET /snapshot` **refuse a page or a fold containing one**, with
`protocol_unsupported`, the supported range, `requiredProtocol`, and the entity
name so the client can say which feature the upgrade is for. A snapshot is refused
over the whole fold rather than per page, because a device that applied the
admissible pages and failed on a later one would be left holding a partial
hydration.

`backups.protocol` records **the lowest protocol that can replay that backup**, not
the ceiling of the Worker that took it. A workspace backup is therefore still
protocol 1 after this change, and a Worker rolled back one version can still
restore it. A restore is also refused when the backup needs a protocol the
*request* cannot read — otherwise the epoch moves, the pre-restore capture is
spent, and the device that asked is left on a timeline it cannot hydrate.

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

**The client surfaces every one of these as itself (STA-251).** Each code is a
`StapleErrorCode` member. A sync failure's envelope `code` is the service's code,
its `retryable` is the column above, and the CLI exits with the code's own number:
`validation` 2, `not_found` 3 and `conflict` 4, shared with the tracker, then 11 to
21 in this table's order (`docs/cli.md`, "Exit codes"). A refusal the client makes
before sending has the same shape as the service's. Examples are the handshake's
`protocol_unsupported`, a pulled operation's `schema_ahead`, an oversized seed row's
`payload_too_large` and the backup consent's `forbidden`. `src/core/cloud/errors.ts`
builds all of them. `detail.cloudCode` and `detail.retryable` repeat the code and the
bit for `--json` consumers that read them from before this. A code the client does not
know is `unavailable`, and so is an `offline` sent by a server, because `offline` is
the client's own condition.

**`conflict` also answers a write in the wrong vocabulary (STA-290).** A repository holds
a hub's registry (`registration`, `crossLink`) or a workspace's data, never both. The
service records which in `repos.vocabulary` and claims it with the repository's first
write. After that, a push or a restore of the other vocabulary is refused before anything
is written, as `conflict` with `repositoryVocabulary` and `requestVocabulary` in the body.
`requestVocabulary` is `"mixed"` for a backup captured before the rule existed that holds
both. It reuses `conflict` rather than adding a code on purpose: a client maps a code it
does not know to `unavailable`, which is retried, so a new code would have made every
released client retry a permanent refusal. The client names the remedy, which is that the
other vocabulary needs its own repository, and `isVocabularyRefusal` in
`src/core/cloud/client.ts` separates this refusal from a lease race. Provisioning and the
cleanup for a repository contaminated before the rule existed are in `worker/README.md`.

**`Retry-After` is not yet honoured**, and the backoff half of that row is the only
half that ships. The Worker sends the header, and the client reads it into
`detail.retryAfter` where `--json` consumers can see it — and then nothing consumes
it: the in-sync schedule is `min(2s, 200ms · 2ⁿ)` over three attempts, so a service
asking for sixty seconds is retried after two hundred milliseconds. Automatic sync
is better behaved by a different mechanism rather than by reading the header — one
attempt per run, with a persisted jittered backoff based at five seconds and capped
at five minutes — so the observable damage today is bounded to manual `staple cloud
sync` against a rate-limited endpoint. It is written down here because the row
above is what an implementer of a *second* transport would read and believe, and a
provider with a real quota is exactly where ignoring the header stops being
cosmetic.

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

**How the epoch-changing form is built**, because "bump the epoch" on its own is
not one of the two options and the difference is invisible from outside. The
server *stages* the backup's folded state as operations stamped with `epoch + 1`
while the repository is still on `epoch`, and only then moves `repos.epoch` in
one guarded statement. Both `GET /ops` and `GET /snapshot` filter on the
session's epoch, so until that flip no device can see a single staged row, and
after it every device re-bootstraps into an epoch that is *already fully
materialised*. Staging before flipping is what makes the cutover atomic across
several requests; flipping first would leave a window in which a device
re-bootstraps into a half-materialised epoch and hydrates half a repository.

The pre-restore snapshot is an ordinary backup with `kind: "pre-restore"`,
restorable by the same route. That is what "recoverable" has to mean: not a
record that a restore happened, but a thing you can restore.

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

**That sharing is a design intent, not a shipped capability, and the reevaluation
resolved it as follows.** As built, an adapter cannot read the journal, for two
reasons that are both small and both load-bearing:

- **The seam is armed by cloud connection.** `Journal.armed()` requires a device
  id *and* `sync_state.repository_id`, and `flush()` returns early without both —
  so on a machine that has never run `staple cloud connect` there are no outbox
  rows and no version rows at all. That is the correct privacy posture for this
  epic and the wrong one for an adapter, because it makes external-tracker sync
  depend on cloud sync being connected, which is precisely the coupling this
  section exists to prevent. Journalling has to become armed by *any* enabled
  replication consumer, not by this one. And arming alone would not be enough: the
  journal records what changed after arming, never what already existed, which is
  why cloud sync [seeds](#a-workspaces-history-reaches-the-service-when-it-first-synchronizes)
  its repository from the database's rows at the first sync. An adapter needs the
  same first step, reading rows rather than the journal.
- **The outbox has one consumer.** `sync_outbox.acknowledged_seq` is a single
  column, written only by the cloud push path; `pending()` means "not yet sent to
  the cloud", and `compact()` deletes rows the cloud has acknowledged. A second
  reader has nowhere to record its own progress and would have its queue pruned by
  the first reader's routine housekeeping. Per-consumer delivery state is the
  missing piece, and no table in migration 010 or 011 carries a provider or remote
  discriminator to hang it on.

So the boundary holds in the direction that matters — **the replication
infrastructure is built and must not be built twice** — while the one thing this
page offered to share needs a bounded generalization first. What an adapter should
reuse rather than reimplement: the outbox and the seam once generalized, the
conflict record and its resolution and settle rules, the per-field detection and
merge engine and its `sync_field_writes` provenance, the credential store's
keychain / `secret-tool` / `0600` mechanism selection, the retryable-code taxonomy,
and both backoff mechanisms. What it must add on top: a field-*ownership* policy,
which does not exist here in any form — arbitration in this epic is version and
provenance based and its answer to a genuine collision is to withhold the field and
escalate, never to declare a winner.

One obligation is easy to miss and expensive to miss. Migration 011's invariant is
that **every** path which can change a field records provenance — the journal
flush, the apply path and a bootstrap all do. An adapter writing Staple rows from
an external system is a *fourth* such path, and one that does not write
`sync_field_writes` silently reopens the relay hole that migration exists to have
closed.

Concretely, this page defines no TaskLink field, no external id column, no
provider adapter and no field-ownership policy. It does not reserve names for
them either.

## Known limits

Honest gaps, so nobody discovers them the hard way.

- **No end-to-end encryption.** Payloads are plaintext in D1. The account
  operator can read every issue body. Stated in
  [Trust boundaries](#trust-boundaries) and repeated here because it is the single
  most important thing to know before connecting.
- **The hub does not synchronize by itself.** Cross-workspace `blocks` edges and the
  identifier-prefix registry are machine-local until a person publishes them with
  `staple hub registry publish` and another machine adopts them with
  `staple hub registry adopt --apply`, both explicit, under the fourth consent (see
  ["The hub registry is a set, not a map"](#the-hub-registry-is-a-set-not-a-map)).
  A blocker's *status* lives in its workspace, so a cross-workspace blocker resolved on
  one machine is visible on another only once that workspace has synced there too.
  `unresolvable → treat as blocked` ([architecture.md](architecture.md)) is still the
  behaviour for a blocker whose workspace is not on this machine.

  `staple cloud connect --all` does **not** change this, and the distinction is
  worth stating because the command reads as though it might. It is a **fan-out
  over locally registered workspaces**, not a synced hub: one gesture on one
  machine, visiting each registered workspace in turn and performing the
  per-repository connect that already existed. Each workspace keeps **its own
  credential**, so revoking one does not disconnect the others; the device id is
  shared, because it always was — one machine is one device in every repository
  it is enrolled in. Nothing in the wire format can say that two repositories sit
  in one hub, so the service never learns that they do. `status --all` and
  `sync --all` are the same shape, and `sync --all` reports a **per-workspace
  outcome**: one workspace failing does not stop the others, and an aggregate
  "sync failed" is not a thing it can print.

  There is deliberately **no `cloud auto --all`**. Connecting in twelve places is
  one decision made twelve times; agreeing that a machine may talk to a service
  *without being asked again* is a different kind of decision, and it stays
  per-workspace so that a hub-wide connect cannot become hub-wide background
  traffic by adding one word.
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
- **`cross_links` is repository state kept in a machine-local file.** A
  cross-workspace dependency is a fact about two repositories, but it lives in the
  hub. The hub registry is how it leaves the machine: published and adopted
  explicitly, never ridden along in either repository's own sync.
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
