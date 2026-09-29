---
title: Documentation
description: What staple is, where to start, and every reference page grouped by what you want to do.
---

# staple documentation

staple is a local-first task tracker for coding agents. Each repository keeps its
tickets in one SQLite file, `.staple/staple.db`. Agents claim, plan, hand off and
finish work through the CLI or the MCP server, and you follow along in a local web
UI. A pickup queue, milestones and autopilot runs decide what gets worked next.
Cloud sync is optional and lets two machines share one workspace.

## Where to start

```bash
npx staple-cli                      # set this repository up and open the web UI
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
npx staple-cli install --yes        # optional: put `staple` on your PATH
```

[Getting started](getting-started.md) walks through these three lines: the first
workspace, the MCP wiring and the agent loop. Read [agents.md](agents.md) next. It
covers the protocol your agents follow and the MCP tools they use.
[cli.md](cli.md) documents every command.

## Getting started

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Install, the first workspace, MCP wiring for Claude Code and Codex, one ticket through the agent loop |
| [Packaging and install](packaging.md) | The `staple-cli` package, `npx` versus `staple install`, the versioned runtime and launcher |
| [Web UI](web-ui.md) | `staple open` and every view: tasks, queue, graph, milestones, estimates, usage, task detail, autopilot runs, settings |
| [Configuration](configuration.md) | The staple home, `config.json`, machine and workspace settings, `doctor` |

## Working with agents

| Page | What it covers |
|---|---|
| [Agents](agents.md) | The protocol `init` writes to `.staple/AGENTS.md`, the MCP tool surface, harness setup |
| [Semantics](semantics.md) | Statuses and guards, kinds, atomic checkout, the dependency graph, approval gates, revisioned documents |

## Planning: queue, milestones and runs

| Page | What it covers |
|---|---|
| [The pickup queue](queue.md) | The ordered plan of what agents take next, the effective order, advisory versus strict policy, overrides |
| [Milestones](milestones.md) | Dated plans over epics and tasks, derived state and progress, goal criteria, milestones in the queue |
| [Autopilot runs](runs.md) | Working a scope ticket after ticket, budget and stop rules, the take, wait or stop decision |

## Sync and continuity

| Page | What it covers |
|---|---|
| [Cloud sync](sync.md) | Sharing a workspace between machines: what travels, ordering, conflicts, leases, consents, backups, the hub registry |
| [Continuity](continuity.md) | Claims, staleness, taking over a dead agent's work |

## Reference

| Page | What it covers |
|---|---|
| [CLI](cli.md) | Every command and flag, `--json` shapes, exit codes |
| [Execution telemetry](execution-telemetry.md) | Execution attempts, provider usage-limit windows and budget samples |
| [Timing semantics](timing-semantics.md) | Elapsed time versus agent work, the number an estimate is compared against, calibration and [forecasts](timing-semantics.md#forecasts) |

## Internals

| Page | What it covers |
|---|---|
| [Architecture](architecture.md) | Where the code lives, workspace and hub topology, known limits |
| [Migrating a `.tasks` workspace](migration.md) | Moving a legacy workspace, schema upgrades, schema mismatch diagnosis |

Working on staple itself is covered in [CONTRIBUTING.md](https://github.com/vpetkovic/staple-tracker/blob/master/CONTRIBUTING.md), and
cutting a release in [RELEASING.md](https://github.com/vpetkovic/staple-tracker/blob/master/RELEASING.md).
