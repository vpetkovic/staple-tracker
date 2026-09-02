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
- the **worklog convention** — `Done` / `Next` / `Files touched`, revised at
  every milestone. A checkpoint written *before* the interruption is the
  handoff; one written at the end never survives a kill;
- the branch pointer to comment at checkout;
- the continuity rules in [continuity.md](continuity.md).

An existing `AGENTS.md` is **never overwritten** — `init` says it kept it.
`--global` workspaces get no guide: the file exists to be found in a repo, and
`~/.staple/workspaces/` is not one. The MCP `init` tool behaves identically and
returns `guidePath` / `guideWritten`.

Source: `src/core/agents-template.ts`.

## The MCP surface

```bash
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
```

Any MCP client can launch `npx -y staple-cli mcp` the same way, with
`STAPLE_AGENT` naming the agent. There is no separate MCP binary — `staple mcp`
is the same entrypoint as the CLI.

Sixteen stdio tools. The loop they exist for:

`inbox` → `checkout_task` (a conflict means pick another, never retry) →
`put_document` the plan → work, `add_comment` progress → `update_task` done →
`events_since` to see what your completion unblocked. `cross_link` +
`hub_overview` cover cross-repository dependencies.

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
