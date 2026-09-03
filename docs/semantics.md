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

## A parent's status is derived from its children

**A parent does not have a status of its own to maintain.** An issue with
children reports what its children are doing, recomputed on every child
transition, in the same transaction as the transition itself — there is no
window where a child has moved and its epic still says the old thing.

The ladder, stated in categories (so it survives any renaming):

| # | children | the parent reads |
|---|----------|------------------|
| 0 | **no children at all** | nothing — a leaf is untouched by every rule here |
| 1 | any open child `active` | `active` |
| 2 | else any open child `review` | `review` |
| 3 | else any open child `unstarted`/`ready` | the workable band |
| 4 | else all open children `blocked`/`gated` | `blocked` |
| 5 | nothing open, **every** child `cancelled` | `cancelled` |
| 6 | nothing open, at least one child `done` | `done` |

Three consequences worth stating out loud:

- **The last child to land closes the parent**, with `completedAt` stamped, and
  a child that comes back out of `done` re-opens it to whatever rung its
  children now imply. Nothing needs to remember to close an epic.
- **A parent is `in_progress` only while a child genuinely is.** Rung 1 is the
  only way in, so an epic whose children have all stopped falls back to what is
  actually true underneath it — review, blocked, workable, or finished.
- **`blocked` is exclusive** (rung 4 is last of the open rungs): one blocked
  child beside one workable child is not a blocked parent, because there is
  still work an agent can pick up. A derived-blocked parent carries no unblock
  descriptor of its own — the fact belongs to the blocking child, and the UI
  borrows it from there.

**Derivation may only change what derivation set.** The pre-work band is the
*absence* of a statement, so derivation writes into it freely; everything else —
`in_progress`, `in_review`, `blocked`, `done`, `cancelled` — only when the event
log says derivation itself wrote the current value. So an epic a human closed by
hand, cancelled, parked in `blocked` with an unblock descriptor, or genuinely
checked out is immune until that human moves it. `staple done <epic>` therefore
still works, is idempotent, and sticks.

Every derived transition is a `status_changed` event carrying `derived` (the
rung that fired) and `derivedFrom` (the child that caused it). That marker is
what tells the timeline it was a report rather than a person, and what makes
the **timing** numbers honest: an interval opened by a derived flip is never
billed, so an epic has no stopwatch of its own — its actual is its children's.

The automatic close does not replace the summary. `children_complete` still
fires when the last child lands (before the close, so the wake is never
swallowed), and it is the cue to write what shipped.

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
- Parents get `children_complete` when the last child lands — and then close
  themselves (see the derived ladder above); the wake is the cue to write the
  summary, not to remember to close anything.
  `blockParentUntilDone` is a real edge in the graph, not a computed view. It
  gates *starting* the parent, and if the blocking child is also the parent's
  last open child the parent finishes rather than becoming startable; a human
  who has follow-up work of their own says so by giving the parent a status,
  which derivation then leaves alone.
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
