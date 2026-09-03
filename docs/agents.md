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

Nineteen stdio tools. The loop they exist for:

`inbox` → `checkout_task` (a conflict means pick another, never retry) →
`put_document` the plan → work, `add_comment` progress → `update_task` done →
`events_since` to see what your completion unblocked. `cross_link` +
`hub_overview` cover cross-repository dependencies.

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
- **Tools declare annotations** — 7 read-only, `checkout_task` idempotent — and
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
