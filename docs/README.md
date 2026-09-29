---
title: Documentation
description: What staple is, where to start, and every page grouped by what you want to do.
---

# staple documentation

staple is a local-first task tracker for coding agents. Each repository keeps its
tickets in one SQLite file, `.staple/staple.db`. Agents claim, plan, hand off and
finish work through the CLI or the MCP server, and you follow along in a local web
UI. A pickup queue, milestones and autopilot runs decide what gets worked next.
Cloud sync is optional and lets two machines share one workspace.

## Quick start

```bash
npx staple-cli                      # set this repository up and open the web UI
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
npx staple-cli install --yes        # optional: put `staple` on your PATH
```

[Install and first workspace](getting-started.md) walks through these three lines.
[Connect your agent](connect-your-agent.md) covers other MCP clients, and
[How an agent works a ticket](working-a-ticket.md) the loop your agents follow.

## Start here

| Page | What it is for |
|---|---|
| [Why staple](why-staple.md) | Why staple exists and where it fits next to Linear, GitHub or ClickUp |
| [Install and first workspace](getting-started.md) | Install staple, set up a repository and take one ticket through the loop |
| [Connect your agent](connect-your-agent.md) | Wire Claude Code, Codex or any MCP client to staple |

## Working with agents

| Page | What it is for |
|---|---|
| [How an agent works a ticket](working-a-ticket.md) | The loop every agent follows: claim, plan, worklog, done |
| [Plans become tickets](plans-to-tickets.md) | Turn an implementation plan into an epic with tickets agents work through |
| [Handoff and resume](handoff.md) | Pick up work after a session dies, hits a limit or changes hands |

## Planning

| Page | What it is for |
|---|---|
| [Epics and dependencies](epics-and-dependencies.md) | Group work under epics and order it with dependencies |
| [The pickup queue](queue.md) | Set the order agents take work in |
| [Milestones and goals](milestones.md) | Put a date and a goal on work from several epics, and track it |
| [Approval gates](approval-gates.md) | Hold an epic for your review, then approve it or send it back |
| [Autopilot runs](runs.md) | Let one agent work a scope ticket after ticket, within a budget |

## Across machines and repositories

| Page | What it is for |
|---|---|
| [Cloud sync](cloud-sync.md) | Share one workspace between two machines |
| [Several repositories](hub.md) | Work across several repositories from one machine |

## The web UI

| Page | What it is for |
|---|---|
| [Tour](web-ui.md) | Every view of the local web UI and what you do there |
| [Budget and estimates](budget-and-estimates.md) | Estimate work, compare it with what it took, watch your provider budget |

## Reference

| Page | What it is for |
|---|---|
| [CLI](cli.md) | Every command and flag |
| [MCP tools](mcp-tools.md) | Every tool the MCP server offers |
| [Configuration](configuration.md) | The staple home, machine preferences and workspace settings |
| [Errors and exit codes](errors.md) | What each error means and what to do about it |

Working on staple itself is covered in [CONTRIBUTING.md](https://github.com/vpetkovic/staple-tracker/blob/master/CONTRIBUTING.md),
and cutting a release in [RELEASING.md](https://github.com/vpetkovic/staple-tracker/blob/master/RELEASING.md).
The design documents behind the code (sync protocol, timing, telemetry, the store's
guarantees) live in the repository's [design/](https://github.com/vpetkovic/staple-tracker/tree/master/design) folder.
