# Semantics

What an issue is, and what the store guarantees about it. Every rule here is
covered by a test in `test/`.

## Statuses and guards

A workspace starts with `backlog → todo → in_progress → in_review → done`, plus
`blocked` and `cancelled` — but that list is a **seed, not the law**. Statuses
live in `workspace_statuses` and can be added, renamed, reordered and removed
(`staple statuses`, MCP `list_statuses`/`update_statuses`).

These are enforced as **guards, not a transition table**: `in_progress`
requires an assignee **and** zero unresolved blockers; a transition that
violates a guard is refused with a `validation` error naming what is missing.
Timestamps (`startedAt`, `completedAt`, the blocked-cycle stamp) are written
automatically as a side effect of the transition, never by a caller.

## Kinds — declared, never derived

Every issue carries a `kind` (`issues.kind`, NOT NULL, default `task`). Like
statuses, the vocabulary is data: it lives in `workspace_kinds` and is edited
with `staple kinds` or MCP `update_kinds`, so validation asks the workspace what
it has rather than consulting a compile-time list. That is why adding
`milestone` needs no code change and why the MCP schemas type `kind` as a string
rather than an enum — an enum would silently strip a configured kind on output.

Unlike a status, a kind carries **no category and therefore no behaviour**.
Nothing branches on it: an epic is not checked out differently, does not derive
its status differently, and is not ordered differently. It is a label for humans
and for filtering, and keeping it inert is deliberate — the moment a kind
implied a rule, adding one would mean adding a rule nobody had tested.

The name is the whole design: **kind is declared, not derived**. A `task` that
gains children stays a `task`. Surfaces may *suggest* promoting it to an `epic`,
but nothing recomputes the field, because a value that rewrites itself is a
value nobody can rely on having set. Migration 005 marked every issue that
already had children as an `epic` exactly once, at upgrade time, to give
existing backlogs a sensible starting shape; it has not run since.

## Categories — why a configurable status set is still safe

Every status carries a **category** from a fixed, non-configurable set:

`unstarted` · `ready` · `active` · `review` · `gated` · `blocked` · `done` · `cancelled`

**All behaviour keys off the category, never off the status id.** Checkout
claims from `ready`/`unstarted`/`blocked`; a claim only ever sits in `active`;
`done` and `cancelled` are what "resolved" means; the derived parent ladder
reads its children's categories; `release` returns work to `ready`. A custom
status therefore inherits a behaviour that already has tests, instead of
arriving as a string nothing knows what to do with — and the guards above stay
exactly as strict in a workspace that renamed all seven built-ins.

The categories themselves are deliberately **not** data. Making them editable
would mean making the guards editable, which is a rules engine rather than a
tracker.

Two orders are derived from the configuration, and configured order only ever
breaks ties **within** a category tier — so reordering statuses reorders the
tree and the board, but can never lift `done` above `in_progress`:

- list/board rank: `active, review, gated, blocked, ready, unstarted, done, cancelled`
- inbox pickup: `active, review, ready, unstarted`

**Removal is guarded twice.** A status that issues still carry needs
`--migrate-to <status>`, and every such row moves in the same transaction (as a
vocabulary rename, not as N status transitions — the event log is history and
is never rewritten). A status that is the last member of a category staple
writes into — `unstarted`, `ready`, `active`, `blocked`, `done`, `cancelled` —
is refused outright, however unused it is: emptying one leaves a workspace that
cannot complete a task. `review` and `gated` may be emptied, because nothing can
enter a category with no members.

Issue **kinds** (`epic`, `task`, `bug`, `chore`, `spike`) are the same kind of
list without the categories: they label what a ticket *is* and carry no
behaviour.

## Atomic checkout and release

A checkout is one statement:

```sql
UPDATE issues SET ... WHERE id = ? AND status IN (…) RETURNING *
```

Two agents racing for the same issue means exactly one `UPDATE` matches. The
loser gets a `conflict` error whose message says *pick a different task* — it
is not a retryable condition, and treating it as one is the classic way to
build a livelock. A re-claim by the agent that already holds the issue is
idempotent, which is what makes crash recovery work.

Release is the inverse and returns the issue to `todo`.

## The `blocks` dependency graph

- **Cycle detection** is a BFS over the whole graph on every write: adding a
  proposed blocker may not create a path from the issue back to that blocker.
- **Writes are set replacement**, never incremental add: `blocked-by A,B`
  means the blocker set *is* `{A, B}` afterwards. There is no "remove one
  blocker" call to get wrong.
- **`blockers_resolved` is level-triggered.** The dedup key is
  `sha256(sorted blocker ids + blocked-cycle stamp)`, so the wake fires once
  per (dependent, exact blocker set, blocked cycle). Re-blocking mints a new
  cycle stamp and therefore a new key, which re-arms the wake.
- Parents get `children_complete` when the last child lands.
  `blockParentUntilDone` is a real edge in the graph, not a computed view.
- `unblockDescriptor` makes blocked work actionable: it names **who** must act
  and **what** clears it. A blocked ticket with no descriptor is a dead end.

## Revisioned documents

Documents are keyed per issue (`plan`, `notes`, `worklog`, …) and revisioned.
Writes take a `baseRevision` for optimistic concurrency; a stale base is a
`revision_conflict`, which is the one error worth retrying. Any revision can be
restored.

This is the `plan.md` replacement: the plan lives *with* the ticket, so the
agent that inherits the ticket inherits the plan.

## Duplicate and replay guards

- **Idempotency-key replay on create.** Re-sending a create with the same key
  returns the original issue with `replayed: true` rather than a second issue.
  `add_comment` takes one too.
- **Normalized-title duplicate guard** among open siblings, so two agents
  planning the same subtask produce one ticket.
- **One live machine-origin issue per source**, enforced by a partial unique
  index — an importer that runs twice does not fork the backlog.
