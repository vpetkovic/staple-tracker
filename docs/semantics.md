# Semantics

What an issue is, and what the store guarantees about it. Every rule here is
covered by a test in `test/`.

## Statuses and guards

`backlog → todo → in_progress → in_review → done`, plus `blocked` and
`cancelled`.

These are enforced as **guards, not a transition table**: `in_progress`
requires an assignee **and** zero unresolved blockers; a transition that
violates a guard is refused with a `validation` error naming what is missing.
Timestamps (`startedAt`, `completedAt`, the blocked-cycle stamp) are written
automatically as a side effect of the transition, never by a caller.

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
