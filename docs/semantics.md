# Semantics

What an issue is, and what the store guarantees about it. Every rule here is
covered by a test in `test/`.

## Statuses and guards

A workspace starts with `backlog → todo → in_progress → in_review → done`, plus
`blocked`, `cancelled`, and `awaiting_approval` — the parked state a review gate
puts a parent in, and the one seeded status no caller may write directly (see
[Approval gates](#approval-gates)). But that list is a **seed, not the law**.
Statuses live in `workspace_statuses` and can be added, renamed, reordered and
removed (`staple statuses`, MCP `list_statuses`/`update_statuses`).

These are enforced as **guards, not a transition table**: `in_progress`
requires an assignee **and** zero unresolved blockers; a transition that
violates a guard is refused with a `validation` error naming what is missing.
Timestamps (`startedAt`, `completedAt`, the blocked-cycle stamp) are written
automatically as a side effect of the transition, never by a caller.

## Kinds — declared, never derived

Every issue carries a `kind` (`issues.kind`, NOT NULL, default `task`). The
default is the registered workspace setting `kinds.default` (see
[configuration.md](configuration.md#the-settings-registry)): `task` until a
workspace chooses otherwise, and a chosen kind that is later removed resets it.
Like statuses, the vocabulary is data: it lives in `workspace_kinds` and is edited
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
exactly as strict in a workspace that renamed all eight built-ins.

The categories themselves are deliberately **not** data. Making them editable
would mean making the guards editable, which is a rules engine rather than a
tracker.

Two orders are derived from the configuration, and configured order only ever
breaks ties **within** a category tier — so reordering statuses reorders the
tree and the board, but can never lift `done` above `in_progress`:

- list/board rank: `active, review, gated, blocked, ready, unstarted, done, cancelled`
- inbox pickup: `active, review, ready, unstarted`

The pickup **queue** ([queue.md](queue.md)) will sit in front of the inbox
order once R2 lands: a human-ordered plan READY is derived from, with these
tiers ordering only what the plan does not mention.

**Removal is guarded twice.** A status that issues still carry needs
`--migrate-to <status>`, and every such row moves in the same transaction (as a
vocabulary rename, not as N status transitions — the event log is history and
is never rewritten). A status that is the last member of a category staple
writes into — `unstarted`, `ready`, `active`, `blocked`, `done`, `cancelled` —
is refused outright, however unused it is: emptying one leaves a workspace that
cannot complete a task. `review` may be emptied, because nothing can enter a
category with no members.

`gated` may be emptied too, and the consequence is stated rather than hidden:
`staple gate` writes the FIRST status of that category, so a workspace with no
gated status has no gate command — the refusal names the `statuses add` that
brings it back. Removing `awaiting_approval` is a legitimate configuration for a
team that does not do approvals; it is not a way to keep the command and lose
the status.

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

Rungs 5 and 6 have exactly one exception: **a parent whose gate is still open
does not auto-close.** See [Approval gates](#approval-gates).

Three consequences worth stating out loud:

- **The last child to land closes the parent**, with `completedAt` stamped, and
  a child that comes back out of `done` re-opens it to whatever rung its
  children now imply. Nothing needs to remember to close an epic — unless a
  human was asked to look at it first, which is what a gate is.
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

Estimates roll up the other way round, and to any depth: an issue contributes
its **own estimate if it has one, otherwise the sum of its children's
contributions** — never both. That one rule is what lets a middle epic nobody
estimated pass its children's plan up to its parent while a parent's plan and
its descendants' are never counted twice in one ancestor total. The depth-1
`childrenEstimatedSeconds` keeps its meaning beside it; the recursive figure is
`subtreePlan` (see `docs/cli.md`, "Estimates vs actuals").

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

## Approval gates

A **gate** parks a parent on a named human while its subtree waits. It is the
counterpart of the graph above: a blocker is work waiting on other *work*, a
gate is work waiting on a *person*. Any parent with children can be gated, not
only an epic.

`staple gate <ref> --owner <who>` moves the parent to **`awaiting_approval`**
and **clears its claim** — nobody is working a parked ticket, and leaving
`checkoutAgent` set would make it accrue idle time and read as a stale claim
somebody should steal, which is the exact misreading gates exist to end. The
assignee is left alone: who owns the work is still true while it waits.
(`store-gates.test.ts` — *"moves the parent to awaiting_approval with the owner
recorded"*, *"clears the claim, because nobody is working a parked parent"*.)

**`awaiting_approval` is never ready**, and it is never ready BY CATEGORY: the
inbox pickup tiers are `active, review, ready, unstarted`, and `gated` is not one
of them — so any status a workspace files under `gated` inherits the rule.
`inbox()` routes both the parked parent and everything queued
behind it into a third bucket — `ready` / `queued` / `blocked`. The parent lands
there by its *status*; the children land there by their derived `queuedBy`. The
parent has no `queuedBy` of its own — it is not standing in a queue, it *is* the
queue — and putting it in `blocked` would render it as "? must act", because a
parked parent has no unblock descriptor and deliberately never gets one. A
queued issue that also has unresolved blockers is reported as queued: the
blocker cannot be worked either way, and the gate is the more actionable fact.
(`store-gates.test.ts` — *"puts queued children and the parked parent in
`queued`, never in `ready`"*, *"prefers the gate over a blocker"*, *"returns
them to `ready` on approval"*; `gates-surfaces.test.ts` — *"prints QUEUED
between READY and BLOCKED in `inbox`"* and its MCP twin *"puts the whole gated
set in the inbox `queued` bucket, never `ready`"*.)

**`queuedBy` is derived at read time, never stored.** Walking up from an issue,
the first ancestor holding an **active** gate is the answer, and active means
`pending` **or** `changes_requested` — asking for changes does not drain the
queue. The walk starts at the parent, so a gate holder is never queued behind
itself. Per-child release is a property of the *subtree*: any node on the path
carrying the release flag frees everything below it from the **next** gate
encountered, after which the flag is spent and the climb continues, because a
release granted by one reviewer says nothing about an outer gate somebody else
is holding. The walk is bounded by `MAX_TREE_DEPTH` with a `seen` set, and the
batched read is one scan shared by the whole page rather than a walk per row.
(`store-gates.test.ts` — *"queues every open descendant, not just direct
children"*, *"does not queue the gate holder itself"*, *"names the NEAREST gate
when two are open above"*, *"falls through to the OUTER gate once the inner one
releases it"*, *"carries a release down the whole released subtree"*, *"batches
identically to the single-issue read"*.)

**Only OPEN work can stand in a queue, and only work that has something to
release.** Two eligibility rules run before the ancestor walk, and neither is an
optimisation — each closes a way the review screen lied to a reviewer (STA-154):

- **(a) A resolved issue is never queued.** `done` and `cancelled` carry no
  `queuedBy`, never appear in a gate's checklist, and are never counted in it. A
  queue is a queue of work still to do; holding back something finished releases
  nobody, and a done row reading *"Queued · awaiting VP on STA-119"* is a claim
  the reader cannot act on.
- **(b) A parent that has children but nothing open underneath is not queued
  either.** It has nothing to release, so approving it is a no-op — and a
  reviewer who ticks a no-op, approves it and finds the row unchanged concludes
  the gate is broken. An open **leaf** is unaffected: it has no subtree to be
  empty, and it is the work the gate exists to hold.

Both rules apply everywhere `queuedBy` does, because every surface reads the
same `queuedByFor`: the inbox `queued` bucket, the tree's row captions, the
checkout guard and the reviewer's checklist. (`store-gates.test.ts` — *"never
queues a RESOLVED issue"*, *"does not queue a parent whose open subtree is
EMPTY"*, *"still queues an open LEAF"*, *"queues a parent whose only open
descendant is under a DONE child"*, *"obeys the same eligibility rule: no
resolved rows, no empty-subtree parents"*.)

**The reviewer's checklist is that same derivation read from the gate's end.**
`store.gateQueueOf(<ref>)` answers *standing at this gate, what am I deciding
about?* — a flat, pre-ordered list of the open descendants this gate still holds
and has not released, each carrying the `depth` to indent by. Two more rules:

- **(c) A per-child approve removes the row and its whole subtree at once.** The
  release flag propagates down the subtree inside `queuedByFor`, so every
  released row stops carrying `queuedBy` and leaves the list on the very next
  read, with no reload. Releasing a branch and leaving its subtasks queued would
  release nothing anyone could actually work.
- **(d) The list stops at an inner gate.** `queuedBy` names the *nearest* gate,
  so a subtree parked behind a gate of its own is that reviewer's decision.
  `approve --children` would not refuse it — it is a descendant — but offering
  it would be offering to overrule somebody.

A row whose real parent is not in the list (it was resolved, or had nothing open
under it) is re-parented onto the nearest listed ancestor, so `depth` is always
safe to indent by directly: no row is ever indented under a row that is not on
screen. (`store-gates.test.ts` — the *"gateQueueOf: the rows this gate is
holding, as a tree"* suite.)

**Checkout of a queued issue is refused with its own code, `gated` (exit 9),**
and the position of the guard is the design. It sits *after* the crash-recovery
re-claim, so an agent already holding a ticket when a gate went up above it can
still resume mid-flight work; and *before* everything else, so
`--steal-if-stale` cannot route around it — a stale holder and a closed gate are
unrelated facts. The code is non-retryable on purpose: the instruction is not
"pick a different task right now" but "this one opens when a human opens it".
`wait` will not call a queued issue ready either. The pickup queue adds a third
non-retryable code to this family, `out_of_order` (exit 10) — see
[queue.md](queue.md#policy-advisory-or-strict). (`store-gates.test.ts` —
*"refuses with code `gated`, naming the gate and its owner"*, *"is not bypassed
by --steal-if-stale"*, *"still lets the EXISTING holder re-claim after a
crash"*, *"lets a released child be claimed while its siblings stay queued"*,
*"refuses the parked parent itself"*; `gates-surfaces.test.ts` — *"refuses
checkout of a queued child with exit 9 and a sentence naming both"*, *"projects
the canonical `gated` triple in --json"*, *"`wait` does not call a queued issue
ready"*, and the MCP twin *"refuses checkout_task of a queued issue with the
SAME triple the CLI gives"*.)

**Approval is granular.** With no `--children`, the gate becomes `approved`,
every per-child release flag under it is reset (a stale one would leak into the
next cycle), and the parent's status is **re-derived from its children** by the
ordinary ladder — all-backlog children give `backlog`, a child that kept working
through the gate gives `in_progress`, and nothing open underneath gives `todo`,
because the ladder's "leave it alone" answer would mean leaving it parked. With
`--children`, each named ref must be a **descendant** of the gated issue; those
are released, the parent stays parked and the gate stays active — the reviewer
is letting one thread proceed, not ending the review. A `changes_requested` gate
can be approved, which is one of the two ways the queue ends.
(`store-gates.test.ts` — *"re-derives the parent from its children and drains
every queue"*, *"lands on `todo` when nothing is open underneath"*, *"derives
in_progress when a child kept working through the gate"*, *"clears per-child
release flags so they cannot leak into the next cycle"*, *"per-child approve
keeps the parent parked and the gate pending"*, *"refuses to release a ref that
is not underneath the gate"*, *"refuses a second whole-gate approve"*;
`gates-surfaces.test.ts` — *"approve --children releases only what it names"*,
*"approve with no --children drains the whole queue"*.)

**Request-changes returns the parent and keeps the queue.** One sentence says
all three consequences, and it is the sentence the CLI's `--help`, the MCP
`request_changes` description and the web UI's "Send back" button all carry
verbatim (STA-154):

> Posts your note as a comment on `<ref>`, returns it to todo for the next
> agent, and keeps the queued children parked until you approve.

The web UI calls the action **Send back** and prints that sentence above the
note field, before a word is typed — a reviewer is entitled to know that the
note is stored, that the parent moves, and that the queue does not, *before*
deciding to write one. The command names are unchanged: `staple request-changes`
and the MCP `request_changes` tool. Renaming a shipped verb to improve a button
label would break every script and agent that calls it, and the label was the
thing that was wrong.

The comment is
mandatory and is stored as a **real comment**, not only as event payload — a
reviewer's objection is the first thing the next agent needs, and event payloads
are not where anyone reads. The parent goes to `todo`, pickable by anyone, with
its claim cleared and **no automatic re-checkout** of whoever last held it. The
children **stay queued**: "changes requested" is not "released", and draining
the queue on an objection is the opposite of what the reviewer asked for. The
subtree leaves the queue on a later `approve`, or on a fresh gate cycle.
(`store-gates.test.ts` — *"returns the parent to todo with the comment stored as
a comment"*, *"keeps the children queued — VP's explicit decision"*, *"leaves
the parent itself pickable, by anyone, with no auto re-checkout"*, *"requires a
comment"*, *"can still be approved afterwards — that is how the queue ends"*;
`gates-surfaces.test.ts` — *"request-changes needs a message and says what stays
queued"*.)

The guards, all `validation` or `conflict` errors that name the way out:

- **No leaf gates.** A gate exists to queue the work underneath it; on a leaf
  there is nothing to queue, and the refusal points at `in_review`, which
  already means "finished, waiting on a human" and still ranks READY. Two
  statuses that mean review with no way to tell which one you need is the
  confusion this prevents. (*"refuses a leaf — there would be nothing to
  queue"*; `gates-surfaces.test.ts` *"refuses a gate on a leaf, pointing at the
  status that means leaf-in-review"*.)
- **No owner-less gates.** `--owner` is required — a gate with nobody to chase
  never opens. (*"refuses an owner-less gate: a gate with nobody to chase is a
  dead end"*.)
- **No second gate while one is `pending`**, which would move the owner out from
  under a reviewer who has not answered. Re-gating after `changes_requested` is
  explicitly **allowed** — that is the resubmit loop — and so is a new cycle
  after `approved`. Finished work cannot be gated at all. (*"refuses a second
  gate while one is still PENDING"*, *"ALLOWS re-gating after request-changes —
  that is the resubmit loop"*, *"allows a NEW cycle once the previous gate was
  approved"*, *"refuses to gate work that is already finished"*.)
- **Only the gate commands cross the `gated` boundary**, in both directions —
  the boundary is the CATEGORY, so it holds for a renamed or a second gated
  status just as well. Into it, because a status written without a gate would be
  a parked parent with no owner and no way to approve it; out of it — including
  `done` and `cancelled` — because `status <ref> todo` must not become a quieter
  `approve` that leaves the gate saying `pending` forever while the queue
  silently drains. Non-status edits while parked are fine. (*"refuses a direct
  status write INTO awaiting_approval"*, *"refuses a direct status write OUT of
  it, and names the way out"*, *"refuses `done` too"*, *"still allows a
  non-status edit while parked"*; `gates-surfaces.test.ts` *"refuses to move a
  parked parent with `status`, and names the way out"*.)

**Derivation may not speak over a gate.** A parked parent is immune to the "a
child moved, so recompute the parent" pass, in both directions — otherwise a
child still in flight would un-park it and silently discard the review. The
immunity is stated as the `gated` category, not as the id. Upward, a gated child
is an ordinary rung-4 input: a grandparent whose only open child is parked reads
`blocked`, because an approval nobody has given is not work an agent can pick up.
A workable sibling still derives normally past the gate. (`store-gates.test.ts` —
*"a child moving does not un-park the parent"*, *"a sibling that is still
workable still derives normally past the gate"*, *"lets derivation speak again
once the parent is back in the pre-work band"*.)

**An open gate outranks the automatic close.** Rungs 5 and 6 close a parent when
its last child lands; a parent whose gate is `pending` or `changes_requested`
is exempt, because the review IS the remaining work and closing it would answer
the question the gate was asked to put to a person. `pending` is already covered
by the category immunity above. `changes_requested` is the case that matters:
that parent is back in the workable band with an unanswered gate on it, so
without the rule the last child landing again would close it out from under the
reviewer who asked for the changes — skipping the resubmit loop entirely. Only
the CLOSING rungs are refused; rungs 1-4 still report what is happening
underneath. Once the gate is `approved` the parent follows the normal rule, and
`approve` itself lands the parent on whatever the ladder says — including `done`,
when the whole subtree finished while the reviewer was reading it.
(`store-gates.test.ts` — *"does not auto-close a parent whose gate is still
PENDING"*, *"does not auto-close a parent whose gate is CHANGES_REQUESTED"*,
*"auto-closes normally once the gate is approved"*, *"approve closes the parent
when every child has already landed"*.)

**Events.** Every gate transition emits two: the semantic one, plus a plain
`status_changed`, so the timing replay keeps explaining the row instead of
degrading it to `approximate`.

- `gate` → `status_changed`, then `gate_requested` (`owner`, `previousStatus`,
  `previousHolder`).
- `approve` → `status_changed`, then `gate_approved` (`owner`,
  `releasedDescendants`, `to`).
- `approve --children` → `gate_child_approved` **on each child**, not on the
  parent, and no status event: partial approval is not resolution.
- `request-changes` → `status_changed`, then `gate_changes_requested` (`owner`,
  `comment`).

Parked time is not billed as active time, and a gated ticket's timing stays
exact rather than `approximate`. (`store-gates.test.ts` — *"emits status_changed
AND gate_requested, in that order"*, *"emits status_changed and gate_approved"*,
*"emits gate_child_approved on the CHILD, not on the parent"*, *"gate, approve
and request-changes all keep timing exact"*, *"parked time is not billed as
active time"*.)

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
