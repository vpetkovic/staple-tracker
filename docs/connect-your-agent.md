---
title: Connect your agent
description: Wire Claude Code, Codex or any MCP client to staple, name the agent, and point it at the protocol.
---

# Connect your agent

Use this page to give your coding agent staple's tools. Agents work the tracker
through staple's MCP server, the same package started with `mcp`, so there is nothing
else to run. Set it up once per machine, then every repository with a `.staple/`
folder works.

## 1. Pick a name for the agent

`STAPLE_AGENT` names the agent. Every claim, comment and document it writes is
recorded under that name, and a write with no name is refused, so a misconfigured
agent fails loudly instead of writing anonymously. Use one name per harness
(`claude`, `codex`), or one per session if you run several at once
(`claude-7f3a`), so the web UI shows who did what.

## 2. Add the server

**Claude Code**

```bash
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
```

**Codex**

```bash
codex mcp add staple --env STAPLE_AGENT=codex -- npx -y staple-cli mcp
```

**Any other MCP client** starts the same command. In a client that takes a JSON
configuration:

```json
{
  "mcpServers": {
    "staple": {
      "command": "npx",
      "args": ["-y", "staple-cli", "mcp"],
      "env": { "STAPLE_AGENT": "my-agent" }
    }
  }
}
```

With `staple` [installed on your PATH](getting-started.md#2-put-staple-on-your-path-optional),
use `staple mcp` in place of `npx -y staple-cli mcp`.

The server starts from any directory and uses the workspace above the agent's working
directory. Outside a repository with staple, its tools answer with instructions
instead of failing, and its `init` tool sets a repository up.

## 3. Point the agent at the protocol

`staple init` wrote `.staple/AGENTS.md`, the rules agents follow in this repository.
Your agent does not read files in `.staple/` on its own, so add one line to the
instructions file it does read, `CLAUDE.md` for Claude Code or `AGENTS.md` at the
root for Codex:

```markdown
This repository tracks its work in staple. Read .staple/AGENTS.md before you start.
```

[How an agent works a ticket](working-a-ticket.md) explains what the protocol asks.

## 4. Check it works

Start a new session in the repository and ask:

> What is in the staple inbox?

The agent calls the `inbox` tool and answers with the same READY and BLOCKED lists
that `staple inbox` prints. Then give it real work:

> Take the next staple ticket and work it.

It asks `next_task` which ticket to take, claims it with `checkout_task`, and follows
the loop. Watch it happen in the web UI (`staple open`).

## If it doesn't work

| What you see | What to do |
|---|---|
| The agent has no staple tools | Restart the session: MCP servers load when a session starts. `claude mcp list` or `codex mcp list` shows whether it is registered. |
| Writes fail with "This write needs an agent identity" | `STAPLE_AGENT` is missing from the server's environment. Add it with `-e` (Claude Code) or `--env` (Codex). |
| Tools answer `not_found` with instructions | The agent is working outside a repository with staple. Run `staple init` there, or let the agent call `init`. |

[MCP tools](mcp-tools.md) lists every tool and its arguments.
