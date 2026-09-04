# Agents

## The protocol `init` writes

A repo-local `staple init` also writes **`.staple/AGENTS.md`** — the working
protocol, rendered with that workspace's own slug and identifier prefix, so the
next harness to arrive learns it from the repository instead of from whoever
briefed the last one.

It covers:

- the loop (below);
- the **identity rule** — act under the identity you claimed with, all session,
  or your own writes stop counting as liveness;
- **parents close themselves** — an epic's status follows its children, so the
  last child to land closes it (see [semantics.md](semantics.md)). Nobody has to
  remember to close an epic; what is still owed is the **summary comment**, and
  an explicit `staple done <epic>` remains allowed, idempotent, and immune to
  the derivation afterwards;
- the **worklog convention** — `Done` / `Next` / `Files touched`, revised at
  every milestone. A checkpoint written *before* the interruption is the
  handoff; one written at the end never survives a kill;
- the branch pointer to comment at checkout;
- **approval gates** — how a design-first ticket ends (`staple gate <ref>
  --owner <who>`, not a held claim), that the inbox's QUEUED section is never
  pickable, and that checkout of it is refused with `gated`;
- the continuity rules in [continuity.md](continuity.md).

An existing `AGENTS.md` is **never overwritten** — `init` says it kept it.
`--global` workspaces get no guide: the file exists to be found in a repo, and
`~/.staple/workspaces/` is not one. The MCP `init` tool behaves identically and
returns `guidePath` / `guideWritten`.

Source: `src/core/agents-template.ts`.

The pickup queue rule — READY is the effective queue order, containers expand
to leaf work, and a strict-mode `out_of_order` refusal means stop, not retry —
is specified in [queue.md](queue.md) and joins this guide when R2e lands.

## The MCP surface

```bash
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
```

Any MCP client can launch `npx -y staple-cli mcp` the same way, with
`STAPLE_AGENT` naming the agent. There is no separate MCP binary — `staple mcp`
is the same entrypoint as the CLI.

Forty stdio tools. The loop they exist for:

`inbox` (or `next_task`) → `checkout_task` (a conflict means pick another, never
retry; `out_of_order` means take the one it names) → `put_document` the plan →
work, `add_comment` progress → `update_task` done → `events_since` to see what
your completion unblocked. `cross_link` + `hub_overview` cover cross-repository
dependencies.

### The milestone tools

Eight tools over dated, human-ordered plans ([milestones.md](milestones.md)),
usable only in a workspace whose vocabulary has the reserved `milestone` kind —
otherwise every one refuses with `validation` naming `staple kinds add
milestone`. All of them return **one shape**, the same object `staple milestone
show --json` prints and `GET /api/milestone` answers:
`{milestone: {identifier, title, status, kind, assignee, targetDate, startDate,
state, planPosition}, progress: {total, countable, counts, percent, complete},
revision, members: [{identifier, title, kind, status, position, rank, parent,
nestedUnder, addedBy, addedAt, note}], next}`.

- **`list_milestones`** `{all?}` and **`get_milestone`** `{ref}` — read-only.
  A non-milestone `ref` is `validation` naming its kind; unknown is `not_found`.
- **`create_milestone`** `{title?, description?, target_date?, start_date?,
  from_epic?, preview?}`. With `from_epic` the epic becomes the ONE member and
  its children come along by descent — nothing is re-parented. `preview: true`
  writes nothing and returns `{preview: true, milestone: {title, targetDate,
  startDate}, members: [{identifier, position}], hierarchyChanges: []}`; the
  commit returns the view plus `hierarchyChanges: []`, naming the same changes.
- **`update_milestone`** `{ref, target_date?, start_date?}` — the two dates
  only (`YYYY-MM-DD`, UTC calendar days; `null` clears one). Everything else is
  `update_task`.
- **`add_milestone_member`** `{milestone, ref, before? | after? | at?,
  base_revision?, note?}`, **`remove_milestone_member`** `{milestone, ref,
  base_revision?}`, **`move_milestone_member`** `{ref, before? | after? | at? |
  to?, base_revision?}`, **`reorder_milestone_members`** `{milestone, order,
  base_revision?}`. Membership never changes an issue's parent, blockers,
  status or claim. Pass `base_revision` from your last read: a stale one is
  `revision_conflict` (`retryable: true`, `detail.currentRevision`) and the
  order stands. Adding a present member with no position is a replay
  (`replayed: true`, no event); with a position it is a move.

### The gate verbs

Three write tools park work on a human and release it again. All three take
`ref` plus the usual `actor` / `ws`, and all three return the **parent issue
plus its `gate`** — no bespoke result shape, so a caller handles them exactly
like `update_task`.

- **`gate_task`** — `{ref, owner, comment?}`. Moves the parent to
  `awaiting_approval`, clears its claim, and queues every open descendant.
  `owner` is required. Refused on an issue with no children (use status
  `in_review` for a leaf awaiting a human) and while a gate is already
  `pending`; re-gating after `request_changes` is how you resubmit.
  `destructiveHint: true` — it takes a whole subtree out of circulation.
- **`approve_task`** — `{ref, children?, comment?}`. Without `children`: the
  gate resolves, the subtree is released, and the parent is re-derived from its
  children. With `children` (each must be a descendant): only those are
  released and the parent stays parked. `destructiveHint: false` — approving
  only ever widens what may be worked on.
- **`request_changes`** — `{ref, comment}`. `comment` is required and is stored
  as a real comment. The parent returns to `todo` with no automatic
  re-checkout; **the children stay queued.**

**An open gate outranks the automatic close.** A parent normally closes itself
when its last child resolves; one whose gate is `pending` or
`changes_requested` does not, because the review is the remaining work. Answer
the gate and the ordinary rule resumes — `approve_task` on a subtree that has
already finished closes the parent then and there.

None is idempotent: a second whole-gate call is refused rather than absorbed.

The read side carries a **pair**, `gate` and `queuedBy`, as siblings of the
issue on `get_task`, `list_tasks` and every `inbox` entry — the same rule
`claim` and `timing` follow:

- `gate` = `{state, owner, requestedBy, requestedAt, resolvedBy, resolvedAt}`,
  where `state` is `pending | approved | changes_requested`. Non-null means this
  row **holds** a queue. It survives resolution, so a caller re-reading a ticket
  still sees that VP approved it an hour ago.
- `queuedBy` = `{identifier, owner}` — the nearest ancestor holding an active
  gate. Non-null means this row **stands in** a queue, and `checkout_task` on it
  will be refused.

At most one of the two is ever non-null, and which one it is changes the advice
completely: chase the owner, or wait for the row above you.

`inbox` returns three arrays — `ready`, `queued`, `blocked`. An entry in
`queued` with a `gate` and no `queuedBy` *is* the gate; one with `queuedBy` is
behind it. Nothing gated is ever `ready`.

`checkout_task` on a queued issue fails with code **`gated`**, `retryable:
false`, and
`detail: {currentStatus, queuedBy: {identifier, owner}}` — the same triple the
CLI prints and exits `9` on. `steal_if_idle_seconds` does not open it: only the
named human does, via `approve_task`.

The UI server's read routes mirror this exactly, and `/api/agent-context` is
expression-for-expression identical to `get_task`, so the agent-view pane below
shows the gate the agent will actually receive.

### The queue tools

Seven tools over the pickup plan ([queue.md](queue.md)) — an explicit,
human-ordered sequence of what to take next, separate from status, priority and
display grouping.

**Two reads.** **`list_queue`** `{all?, actor?, ws?}` answers
`{revision, entries, effective}`: `entries` is PLAN order — what a human queued,
containers and milestones included — and `effective` is what you actually
receive, with every container expanded depth-first to its open leaf work, the
unqueued band after it in presentation sort, and every row classified
`resolved | gated | blocked | claimed | eligible` with a reason.
**`next_task`** `{actor?, ws?}` answers `{revision, next, skipped}`: the one row
you should take and everything it stepped over. Call it before `checkout_task`
and you will never see `out_of_order`.

**Five verbs**, all attributed and all answering the same view:
**`enqueue_task`** `{ref, before?|after?|at?, base_revision?, note?}`,
**`dequeue_task`** `{ref}`, **`move_queue_entry`** `{ref, before?|after?|at?}`,
**`reorder_queue`** `{order}` (every entry, once, atomically) and
**`prune_queue`** (drop the resolved entries). A stale `base_revision` is
refused with `revision_conflict` — the one retryable code — and the server order
stands. **Reordering the plan is a human's job**: a queue mutation is an
actor-attributed event, so an agent that reorders is visible rather than
forbidden, and you should not reorder work you were told to do.

**`out_of_order` is a THIRD instruction.** With `queue.policy = strict`,
`checkout_task` refuses a row the plan puts later than an eligible one:

```json
{"code":"out_of_order",
 "message":"STA-146 is later in the queue than STA-67, which is ready. Take STA-67, or ask a human to reorder or override.",
 "detail":{"policy":"strict","expected":["STA-67"],"position":14,"expectedPosition":2},
 "retryable":false}
```

A `conflict` means somebody got there first, so pick a different task RIGHT NOW.
A `gated` means a person must act. An `out_of_order` means the work is real,
unclaimed and takeable — just not by you, not yet. **Take
`detail.expected[0]`.** Retrying never clears it; nor does waiting; nor does
`steal_if_idle_seconds`. `checkout_task`'s `override_reason` exists for the
human who decides to step over the plan and is recorded as a `queue_overridden`
event — do not send it on your own initiative, and never to make a refusal go
away.

`inbox`'s READY list is derived from the same resolver, so its order already IS
the effective queue: every entry carries its `position`, and a row the plan
reaches carries `planPosition` too.

### Workspace settings

Two tools read and write the registered workspace settings
([configuration.md](configuration.md#the-settings-registry)). **`get_setting`**
`{key, ws?}` is read-only and answers one value with its provenance —
`{key, scope, value, source, version}`, where `source` is `default` until
someone stores a value and `workspace` after. **`set_setting`**
`{key, value, actor?, ws?}` validates through the registry, logs a
`setting_changed` event with actor, previous and new value, and answers the
same shape with the new value. The first registered control is
**`queue.policy`** (`advisory | strict`, default `advisory`): whether the
pickup queue merely orders work or refuses an out-of-order checkout — read it
before assuming the inbox's order is optional, and change it only because a
human asked. Both tools answer the exact object `staple settings get --json`
prints and `/api/settings` serves under `values`, so no surface disagrees
about a value or where it came from.

## Harness ergonomics

All in-protocol, so a harness never needs out-of-band setup:

- **The server starts from any directory.** With no workspace above the working
  directory, tools answer `not_found` *with instructions* instead of crashing
  the connection. The `init` tool creates a workspace headlessly, and every
  workspace tool takes an optional `ws` (hub slug or prefix) to target any
  registered workspace per call.
- **Writes require an identity.** Pass `actor` per call or set `STAPLE_AGENT`.
  There is no silent default: a misconfigured harness fails loudly rather than
  polluting the audit trail with anonymous writes.
- **Replay is explicit.** `add_comment` takes an `idempotency_key`; replayed
  creates and comments come back with `replayed: true`.
- **Tools declare annotations** — 14 read-only, `checkout_task` idempotent — and
  return `structuredContent` (arrays wrap as `{items}`).
- **List tools paginate**: `{items, nextCursor, hasMore}` with opaque cursors.
- `get_task` includes cross-workspace blockers and can inline document bodies
  with `include_documents: true`.

## What the agent actually receives

The web UI has an "agent view" pane that renders the exact `get_task` payload
for an issue, both with and without `include_documents`, plus its token cost.
It exists because a human hands over an issue believing the ticket says one
thing while the agent receives a payload that says something slightly
different, and nothing else shows the two side by side.
