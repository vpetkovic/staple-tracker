---
title: Configuration
description: What you can set in staple and where, from machine and workspace settings to environment variables, budget capture and the files staple keeps.
---

# Configuration

Use this page to change how staple behaves and to find where a setting lives.
There are three places, and each answers a different question:

| Where | What it is for | Read and change it with |
|---|---|---|
| Machine settings | Preferences of this computer, such as the web UI port | `staple config`, `staple config set` |
| Workspace settings | Rules for one repository's work, shared by everyone on it | `staple settings`, `staple settings set`, or **Settings** in the web UI |
| Environment variables | Who is acting and which workspace, per shell or per agent | your shell or your agent's MCP configuration |

## Machine settings

These stay on this computer and never sync.

| Key | Values | Default | What it does |
|---|---|---|---|
| `browser` | `auto`, `always`, `never` | `auto` | Whether `staple open` opens a browser tab |
| `port` | 1 to 65535 | `4400` | The port the web UI prefers; a busy one falls back to a free port |
| `setupComplete` | `true`, `false` | `false` | Whether first-run setup has been done |

```bash
staple config set port 4500
staple config
```

```text
home          /Users/you/.staple  (default)
config        /Users/you/.staple/config.json  (present)
locator       /Users/you/Library/Application Support/Staple/bootstrap.json  (absent)
browser       auto  (default)
port          4500  (config)
setup         incomplete  (default)
```

The label after each value says where it came from: `default` until you set it,
`config` after.

## Workspace settings

These belong to the repository's workspace, so every agent and every machine that
syncs it sees the same value.

| Key | Values | Default | What it does |
|---|---|---|---|
| `queue.policy` | `advisory`, `strict` | `advisory` | Whether the [pickup queue](queue.md) only orders work, or refuses an agent that takes a ticket out of turn |
| `kinds.default` | a kind from `staple kinds ls` | `task` | The kind a new ticket gets when none is given |
| `kinds.appearance` | an icon per kind | built-in icons | The icon each kind shows; set it in the web UI under **Settings → Task types** |

```bash
staple settings set queue.policy strict
staple settings
```

```text
kinds.default = task  (default)
kinds.appearance = {}  (default)
queue.policy = strict  (workspace)
```

A value outside the list is refused with exit 2 and names the key. Every change is
recorded with who made it. Agents read these with the `get_setting` tool and should
change them only when a person asks.

Statuses and kinds are workspace settings too, with their own commands:
`staple statuses` and `staple kinds` ([CLI reference](cli.md#set-up-and-diagnose)).

## Environment variables

| Variable | What it does |
|---|---|
| `STAPLE_AGENT` | The name every claim, comment and document is recorded under. Set one per agent, such as `claude` or `codex`. Without it the CLI uses `$USER`, and the MCP server refuses a write that records who acted unless it passes `actor`. |
| `STAPLE_DB` | Pin commands and the MCP server to one workspace database, such as `/path/to/repo/.staple/staple.db`. It wins over the current directory and over `--ws`. |
| `STAPLE_WS` | For the MCP server: a workspace slug or prefix to use by default. The CLI takes `--ws` instead. |
| `STAPLE_HOME` | Where staple keeps this machine's files, instead of `~/.staple`. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | Where Claude Code and Codex keep their files. Budget capture looks there, and falls back to `~/.claude` and `~/.codex`. |

Staple also sets variables for the commands it starts: `STAPLE_EVENT` for
`staple events --exec`, and `STAPLE_AGENT`, `STAPLE_DB`, `STAPLE_RUN` and
`STAPLE_RUN_TICKET` for the sessions `staple run drive` launches.

```bash
STAPLE_AGENT=codex-2 staple checkout APP-3
```

## Budget capture

Recording your provider's usage limits is off until you turn it on, and stays on
this machine. One command does all of it and shows the plan first:

```bash
staple budget setup --claude-account personal --codex-account work        # the plan; changes nothing
staple budget setup --claude-account personal --codex-account work --yes  # apply it
staple budget status                                                      # is it working?
staple budget unsetup --yes                                               # undo exactly what setup did
```

The account names are labels you choose. `staple budget live on --yes` also asks
the provider for current usage, which is the one budget setting that uses the
network. The web UI does the same under **Settings → Usage**
([the Usage section in detail](../design/web-ui.md#usage--budget)).
[Budget and estimates](budget-and-estimates.md) shows what you get from it.

## Where staple keeps its files

- **Each repository**: `.staple/` beside your code. It holds the workspace database,
  which is git-ignored, and two files to commit: `AGENTS.md`, the protocol for agents,
  and `repository.json`, the repository's identity for cloud sync.
- **This machine**: the staple home, `~/.staple` unless `STAPLE_HOME` says otherwise.
  It holds the list of workspaces, the web UI's token, `config.json`, global
  workspaces and budget readings.

To move the home once it has data in it:

```bash
staple config home /Volumes/work/staple --move --yes
```

It copies and verifies the new home before switching to it, and leaves the old one in
place for you to delete. If `STAPLE_HOME` is set, unset it or the move will not take
effect.

## Checking the setup

```bash
staple doctor
```

It reads everything above and prints one line per check, with the command that fixes
a failed one. It changes nothing; `staple doctor --fix --only <check> --yes` applies
one repair.

Going deeper: [configuration in detail](../design/configuration.md) covers how the
home is found, how settings are defined and validated, and how to add one.
