---
title: Getting started
description: Install staple, set up a repository, connect Claude Code or Codex over MCP, and follow one ticket through the agent loop.
---

# Getting started

This page takes one repository from nothing to an agent working a ticket: install,
the first workspace, the MCP wiring, and the loop your agents follow. It needs
Node >= 22.5 and nothing else.

## Install

```bash
npx staple-cli              # set this repository up, then open the web UI
```

`npx` fetches the package and runs it; nothing is installed globally. To have
`staple` on your `PATH` instead, install a versioned runtime and a launcher at
`~/.local/bin/staple` (no `sudo`, with rollback):

```bash
npx staple-cli install --yes
```

Add `--update-path` to put `~/.local/bin` on your `PATH`. The rest of this page
writes `staple`; with no install, read it as
`npx staple-cli`. [Packaging and install](packaging.md) covers the runtime,
upgrades and rollback.

> [!NOTE]
> `staple-cli` is not on npm until its first release. Until then, build the
> package from a checkout with `npm run pack:package` (see
> [CONTRIBUTING.md](../CONTRIBUTING.md)) and use
> `npx -y file:/absolute/path/to/checkout/dist-package/staple-cli-<version>.tgz`
> wherever this page says `npx staple-cli` or `npx -y staple-cli`.

## Set up a repository

Run `staple` (or `npx staple-cli`) at the root of a git repository. The first
run sets the repository up and then opens the web UI:

- `.staple/staple.db` is the workspace: one SQLite file with every ticket,
  comment, document and event. Its ticket prefix comes from the directory name
  (its first three letters: `my-app` gets `MYA-1`, `MYA-2`, …, unless another
  workspace on this machine holds `MYA`); the first run prints it.
- `.staple/AGENTS.md` is the protocol your agents follow, written with this
  workspace's slug and prefix. Commit it. An existing one is never
  overwritten.
- `.staple/repository.json` holds the repository's identity, which cloud sync
  uses to recognise it on another machine. Commit it.
- `.staple/.gitignore` keeps the database out of git.
- The workspace is registered in the hub, so `staple open --hub` and
  cross-repository links can find it.

The UI runs in the foreground on `http://localhost:4400/` (a free port if 4400
is busy) until you press Ctrl-C. Where there is no terminal (CI, a script), use
`staple init --yes`: the same setup, then exit. [Configuration](configuration.md) covers the staple home
and machine settings, and [Web UI](web-ui.md) every view.

## Connect your agent

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
[Agents](agents.md) lists every MCP tool.

## The agent loop

Every agent follows one loop, whether it calls MCP tools or the CLI. Create two
tickets, the second waiting on the first:

```bash
staple new "Add a health check endpoint"
staple new "Document the endpoint" --blocked-by MYA-1
staple inbox
```

```text
READY (pickup order):
  ◌  MYA-1     backlog     Add a health check endpoint
BLOCKED:
  ◌  MYA-2     backlog     Document the endpoint  [waiting on MYA-1]
```

An agent then works the first ticket through to done. The MCP tool for each step
is on the right:

```bash
staple queue next                               # next_task: the one ticket to take
staple start MYA-1                              # checkout_task: claim it, atomically
staple doc MYA-1 plan --put plan.md             # put_document: the plan
staple estimate MYA-1 2h                        # set_estimate: how long it should take
staple comment MYA-1 "route added, tests next"  # add_comment: progress
staple done MYA-1                               # update_task: finish it
```

A claim is exclusive: when two agents race for one ticket, one gets it and the
other gets a `conflict` and picks another ticket rather than retrying. Finishing
MYA-1 makes MYA-2 ready, and the next `staple inbox` lists it under READY. An agent
that dies holding a claim leaves it to go stale, and another agent can take it
over on the record ([continuity](continuity.md)).

The CLI takes the agent name from `--agent`, then `STAPLE_AGENT`, then your user
name. [Semantics](semantics.md) has the rules behind statuses, claims and
dependencies.

## Next

- [The pickup queue](queue.md): set the order agents take work in.
- [Milestones](milestones.md): dated plans with goal criteria.
- [Autopilot runs](runs.md): one agent works a scope ticket after ticket.
- [Cloud sync](sync.md): share a workspace between two machines.
- [CLI](cli.md): every command and flag.
