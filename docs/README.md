---
title: Documentation
description: What staple is, where to start, and every page grouped by what you want to do.
---

# staple documentation

staple is a local-first task tracker for coding agents: the execution layer where
agents work through your plans ticket by ticket, next to the board your team already
uses. These pages show you how to use it. Each one starts with what it is for and
takes a few minutes to read.

**New here?** Read [Why staple](why-staple.md) to see whether it fits your project,
then [Install and first workspace](getting-started.md) to set up a repository:

```bash
# set this repository up and open the web UI
npx staple-cli
# give Claude Code staple's tools
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
```

**Already set up?** Find what you want to do below. Guides walk you through a task;
the reference pages at the end are for looking things up.

## Start here

| Page | What it is for |
|---|---|
| [Why staple](why-staple.md) | Why staple exists and where it fits next to Linear, GitHub or ClickUp |
| [Install and first workspace](getting-started.md) | Install staple, set up a repository, open the web UI and file your first tickets |
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
| [Approval gates](approval-gates.md) | Hold an epic for your review, then approve it or send it back |
| [The pickup queue](queue.md) | Set the order agents take work in |
| [Milestones and goals](milestones.md) | Put a date and a goal on work from several epics, and track it |
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
