---
title: Connect your agent
description: Wire Claude Code, Codex or any MCP client to staple, and what the MCP server does for a harness.
---

# Connect your agent

Agents work the tracker through the MCP server, which is the same package started
with `mcp`. `STAPLE_AGENT` names the agent: every write is recorded under that
name, and a write without one is refused.

**Claude Code**

```bash
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
```

**Codex**

```bash
codex mcp add staple --env STAPLE_AGENT=codex -- npx -y staple-cli mcp
```

Any other MCP client launches `npx -y staple-cli mcp` the same way. With
`staple` installed, `staple mcp` replaces `npx -y staple-cli mcp`. The server
starts from any directory and finds the workspace above its working directory.
[MCP tools](mcp-tools.md) lists every tool.

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
- **Tools declare annotations** — 25 read-only; among the writes, 15 are
  `idempotentHint: true` (`checkout_task`, `set_estimate`, `set_blocked_by`,
  `cross_link`, `hub_prune`, `init`, `update_milestone`, `set_setting`,
  `enqueue_task`, `prune_queue`, `pause_run`, `resume_run`, `stop_run`,
  `conflict_resolve`, `record_budget_sample`) — and return `structuredContent`
  (arrays wrap as `{items}`).
- **List tools paginate**: `{items, nextCursor, hasMore}` with opaque cursors.
  The telemetry lists answer `{items, truncated, nextCursor, coverage}` instead
  ([MCP tools](mcp-tools.md#execution-telemetry)).
- `get_task` includes cross-workspace blockers and can inline document bodies
  with `include_documents: true`.
