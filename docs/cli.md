---
title: CLI
description: Every staple command, grouped by what you are doing, with its main flags and a short example.
---

# CLI

Use this page to find the command for what you are doing. Commands are grouped by
task: tickets, planning, runs, sync, several repositories, the web UI, budget and
estimates, and setup. Each group links to the guide that walks through it.

To look something up from the terminal:

1. `staple help` lists every command and flag.
2. `staple <command> --help` prints one command's part of it, and does nothing else.
   `run`, `queue`, `cloud`, `budget`, `attempt`, `attempts`, `compare`, `timing`,
   `calibrate` and `forecast` have a page of their own, and so do `staple run drive --help` and
   `staple run hook --help`.
3. Every command that has an [MCP tool](mcp-tools.md) behaves the same through it.

## Global flags and `--json`

| Flag | What it does |
|---|---|
| `--json` | Machine-readable output: the full objects, ISO-8601 timestamps. `events` prints one JSON object per line. An error is one JSON line on stderr. |
| `--db <path>` | Use this workspace database instead of the one found by walking up from the current directory. |
| `--ws <slug\|prefix>` | Use a registered workspace by name or prefix, from anywhere. `STAPLE_DB`, when set, wins over it. |

Writes are recorded under `STAPLE_AGENT`, else `$USER`. `start`, `done`, `cancel`,
`status`, `estimate` and `release` also take `--agent <name>` to say who acts.

Durations (`--estimate`, `--if-stale`, `--steal-if-stale`) are `90s`, `30m`, `2h`,
`3d`, or a number of seconds. `run start --until` takes a duration or an ISO time with
a zone. An error under `--json` looks like this:

```json
{"code":"conflict","message":"Checkout refused: status is \"in_progress\" (held by claude), expected one of todo, backlog, blocked. Pick a different task — do not retry.","detail":{"currentStatus":"in_progress","heldBy":"claude","blockers":[]},"retryable":false}
```

Every `code`, its exit status and what to do about it is in
[Errors and exit codes](errors.md).

## Set up and diagnose

Guide: [Install and first workspace](getting-started.md).

| Command | What it does |
|---|---|
| `staple` | Set this repository up if it needs it, then open the web UI. `--yes` takes the defaults. |
| `staple init [--yes] [--slug s]` | Create and register a workspace, write `.staple/AGENTS.md` for agents, and exit. `--global <slug>` makes one outside any repository. |
| `staple install [--yes] [--update-path]` | Install a runtime so `staple` is on your PATH. `install status` shows it; `--rollback` returns to the previous one. |
| `staple doctor [--json]` | Check the home, config, workspace, UI port and runtime, read-only. Exits 1 when a check fails and prints the repair. |
| `staple doctor --fix --only <check> --yes` | Apply one named repair. |
| `staple mcp` | Start the MCP server on stdio. Your agent's client runs it ([Connect your agent](connect-your-agent.md)). |
| `staple config` | This machine's settings and where each came from. |
| `staple config set <key> <value>` | Set `browser`, `port` or `setupComplete`. |
| `staple config home <path> --move --yes` | Move the staple home, verify it, then switch to it. |
| `staple settings` | This workspace's settings. `settings get <key>` and `settings set <key> <value>` read and write one. |
| `staple statuses ls` | This workspace's statuses, in order. `add`, `rename`, `recategorize`, `reorder` and `rm` change them. |
| `staple kinds ls` | This workspace's kinds (`epic`, `task`, `bug`, `chore`, `spike`). Same verbs as `statuses`, except `recategorize`. |

```bash
staple init --yes
staple settings set queue.policy strict
staple statuses add needs_qa --category review --after in_review
staple kinds add milestone --label Milestone      # turns milestones on
```

What each setting does is in [Configuration](configuration.md).

## Tickets

Guides: [How an agent works a ticket](working-a-ticket.md),
[Handoff and resume](handoff.md).

| Command | What it does |
|---|---|
| `staple new <title>` | File a ticket. `-d text`, `-p priority`, `--parent R`, `--kind K`, `--blocked-by R1,R2`, `--estimate 2h`, `--criteria "a;b"`, `--assignee A`. |
| `staple ls` | List open tickets. `--status s1,s2`, `--kind k`, `--assignee A`, `-q text`; `--all` includes finished ones. |
| `staple show <ref>` | One ticket in full: status, claim, time, parents, blockers, comments, documents and files. |
| `staple tree [ref]` | Tickets as a tree under their epics. |
| `staple board` | A kanban board in the terminal. |
| `staple inbox` | What is ready to take, what waits on a person, and what is blocked, in pickup order. `--hub` covers every workspace. |
| `staple start <ref>` | Claim a ticket and move it to `in_progress`. `checkout` is the same command. |
| `staple done <ref> [-m text]` | Finish it. `cancel` drops it. |
| `staple release <ref>` | Give the claim back; the ticket returns to `todo`. |
| `staple status <ref> <status>` | Move a ticket to any status the rules allow. |
| `staple comment <ref> <text>` | Add a comment. |
| `staple doc <ref> <key> --put <file>` | Store a document on a ticket (a plan, a worklog). Without `--put` it prints the latest; `--revisions` lists the history. |
| `staple file attach <ref> <path>` | Attach a file. The type is sniffed from the bytes. `--caption` and `--filename` are optional. |
| `staple file ls <ref>` | List a ticket's files. Metadata only: type, size, and hash. |
| `staple file get <id> --out <path>` | Write one file's bytes to a path. |
| `staple file rm <id>` | Remove a file. |
| `staple file adopt <ref> [<doc-key>]` | Turn a document that holds base64 evidence (a `Media type:` and `SHA-256:` header over base64) into a real file. Without a key it adopts every such document on the ticket. A document whose bytes do not match its SHA-256 or media type is flagged and not converted. The old revision keeps the bytes. The current document becomes a short note naming the file, unless the file is over 256 KB: its bytes stay on this machine, so the document keeps them for other machines. A second run creates nothing. `--revision N` adopts an older revision. |
| `staple events [--since N]` | The workspace's event log. `--follow` streams new events; `--exec CMD` runs a command for each. |
| `staple wait <ref> [--timeout S]` | Wait until a ticket is ready or finished. |

```bash
staple new "Reset email" --parent APP-1 --blocked-by APP-2 --estimate 90m
staple start APP-2
staple doc APP-2 plan --put plan.md
staple done APP-2 -m "merged"
```

Taking over from an agent that died:

```bash
staple start APP-3 --steal-if-stale 30m        # take over a silent claim
staple release APP-3 --if-stale 2h             # or just free it
```

## Planning

### Epics and dependencies

Guides: [Plans become tickets](plans-to-tickets.md),
[Epics and dependencies](epics-and-dependencies.md).

| Command | What it does |
|---|---|
| `staple new <title> --kind epic` | File an epic; give tickets `--parent` to put them under it. |
| `staple blocked-by <ref> R1,R2` | Replace a ticket's blockers. `--none` clears them. |
| `staple block <ref> --owner O --action TEXT` | Mark a ticket blocked on a person, saying who and what. |
| `staple link <blocker> <blocked>` | Make a ticket wait on a ticket in another repository. |

### Approval gates

Guide: [Approval gates](approval-gates.md).

| Command | What it does |
|---|---|
| `staple gate <ref> --owner O [-m text]` | Hold an epic for a person's review. Its open tickets wait until they approve. |
| `staple approve <ref>` | Release the whole epic. `--children R1,R2` releases only those. |
| `staple request-changes <ref> -m text` | Send it back with a note. The tickets under it stay held. |

### The pickup queue

Guide: [The pickup queue](queue.md).

| Command | What it does |
|---|---|
| `staple queue` | The plan as you ordered it. `--effective` shows the order agents receive. |
| `staple queue next` | The one ticket to take next, and what it skipped and why. `--scope <ref>` stays inside one epic or milestone. |
| `staple queue add <ref>` | Queue a ticket, an epic or a milestone. `--before R`, `--after R`, `--at N` place it. |
| `staple queue mv <ref> --at N` | Move an entry. `queue reorder r1,r2,…` sets the whole order. |
| `staple queue rm <ref>` | Take an entry out. `queue prune` drops the finished ones. |
| `staple start <ref> --override -m <why>` | Take a ticket out of turn when `queue.policy` is `strict`. Recorded with your reason. |

`--base N` on a queue change refuses it if someone changed the queue since you
last listed it.

### Milestones

Guide: [Milestones and goals](milestones.md). Run
`staple kinds add milestone --label Milestone` once per workspace first.

| Command | What it does |
|---|---|
| `staple milestone new <title>` | Create one. `--target 2026-10-31`, `--start D`, `--criteria "a;b"`, `--from-epic R`; `--preview` writes nothing. |
| `staple milestone ls` | Milestones in progress. `--all` includes finished ones. |
| `staple milestone show <ref>` | Progress, members, the goal criteria and the pace against the date. |
| `staple milestone add <milestone> <ref>` | Add an epic or ticket. `rm` removes it; `mv <ref> --to M` moves it to another milestone. |
| `staple milestone reorder <milestone> r1,r2,…` | Set the members' order. |
| `staple milestone set <ref>` | Change the dates (`none` clears one), the description or the criteria. |
| `staple milestone criterion <ref> <n> --met --evidence E` | Judge goal criterion `n`: `--met`, `--unmet` or `--unknown`. Evidence is a ticket, `REF:doc` or text. |

```bash
staple milestone new "Launch" --target 2026-10-31 --from-epic APP-1 --criteria "Users can reset;Emails send"
staple milestone criterion APP-7 1 --met --evidence APP-4
```

## Autopilot runs

Guide: [Autopilot runs](runs.md).

| Command | What it does |
|---|---|
| `staple run start --scope <queue\|ref>` | Start one agent working the queue, an epic or a milestone, ticket after ticket. `--max-tickets N`, `--until 4h`, `--ceiling P` (stop at P% of a usage limit). |
| `staple run continue` | After each ticket: `take` the next (already claimed), `wait`, or `stop`. `--outcome failed --reason R` records a failure. |
| `staple run status [--all]` | A run, and whether it would stop now and why. |
| `staple run pause` / `resume` | Hold a run without ending it, then let it go on. |
| `staple run stop [-m why]` | End a run. |
| `staple run drive --agent claude` | Drive a run headless: a fresh `claude`, `codex` or custom session per ticket. `--dry-run` shows the next brief. |
| `staple run hook install claude --project` | Keep the session you are in working the run instead. `run hook bind` ties it to the run. |

```bash
staple run start --scope APP-1 --max-tickets 5 --until 4h
staple run continue
```

```text
take     APP-3 Reset email
  APP-3 is next in issue APP-1 by the pickup queue's order.
```

A run over a milestone works toward its goal criteria; `--gate-owner` and
`--goal-cap` shape it.

## Cloud sync

Guide: [Cloud sync](cloud-sync.md). Off until you connect.

| Command | What it does |
|---|---|
| `staple cloud` | This machine's connection, read from local files. `--refresh` asks the service. |
| `staple cloud connect --endpoint U --token S` | Connect after showing what will be sent. Automatic sync stays off. |
| `staple cloud sync` | Send this machine's changes and fetch the others'. `--all` does every connected workspace. |
| `staple cloud auto on\|off` | Let this machine sync without being asked. |
| `staple cloud conflicts` | Fields two machines set differently. `cloud resolve <id> --take local\|remote` settles one. |
| `staple cloud devices` | Machines connected to this repository. `devices revoke <id>` cuts one off. |
| `staple cloud backup enable` | Allow backups on the service. `backup create`, `backup ls`, `backup rm`; `cloud restore <id> --confirm <repo>` rewinds. |
| `staple cloud lease acquire <ref>` | Claim a ticket across machines, not only on this one. |
| `staple cloud disconnect` | Remove this machine's credential. Local data stays. |

`staple cloud --help` covers the rest, including `fork-id` and `purge`.

## Several repositories

Guide: [Several repositories](hub.md).

| Command | What it does |
|---|---|
| `staple hub` | Every workspace registered on this machine. `hub links` and `hub events` cover the ones between them. |
| `staple discover <root>` | Find workspaces under a folder; `--all-found --yes` or `--select a,b --yes` registers them. |
| `staple add <path> --yes` | Register one repository. |
| `staple hub unregister <slug>` | Drop one entry. The workspace itself is untouched. |
| `staple hub prune [--yes]` | Drop entries whose folder is gone. Without `--yes` it only shows them. |
| `staple hub unlink <blocker> <blocked>` | Remove a cross-repository link. |
| `staple hub registry` | Share this machine's list of workspaces through the sync service: `connect`, `publish --enable`, `adopt --apply`. |

## The web UI

Guide: [Tour](web-ui.md).

| Command | What it does |
|---|---|
| `staple open` | Serve the web UI and open it. `--port 4400`, `--no-browser`; `--hub` shows every workspace. Ctrl-C stops it. |

## Budget and estimates

Guide: [Budget and estimates](budget-and-estimates.md).

| Command | What it does |
|---|---|
| `staple estimate <ref> <dur>` | Change only the estimate. `--clear` removes it. |
| `staple compare <ref> [<ref>…]` | Total labor, how much of it is estimated, and the longest dependency chain, side by side. |
| `staple forecast <ref>` | How much work is left, from how long similar work took, and what it costs your usage limits. |
| `staple calibrate` | How long each kind of work takes against its estimate. `--for <ref>` forecasts one ticket. |
| `staple timing quality` | How much of the recorded time can be trusted. |
| `staple attempts <ref>` | Every agent session on a ticket. `staple attempt <id>` shows one. |
| `staple attempt pause <ref> --reason R` | Report a pause on the ticket you hold. `resume`, `milestone -m label` and `interrupt` too. |
| `staple budget` | Each account's usage limits: what is left, when it resets, and your pace. |
| `staple budget setup --claude-account A --yes` | Turn on capture of Claude Code and Codex usage in one step. Without `--yes` it shows the plan. `budget unsetup --yes` reverses it. |
| `staple budget status` | Whether capture is working, and what is missing. |
| `staple budget capture on\|off` | Turn capture on or off by hand. `budget bind` names the account a harness spends from; `budget bindings` lists them and `budget unbind` removes one. |
| `staple budget ingest --source S` | Record a reading by hand (`manual`), from a Claude Code status line, or from a Codex session file. `budget setup` wires this up for you. |
| `staple budget collect` | Read new Codex session files now; setup runs it every few minutes. |
| `staple budget live on --yes` | Also ask the provider for current usage. Off by default. |
| `staple budget history --account A` | One account's readings. `budget forget <id> --yes` removes a wrong one. |

```bash
staple compare APP-1
```

```text
APP-1 · Password reset (epic, in_progress)
  labor 6h (own estimate; units beneath add up to 4h30m) · 3 of 3 units planned · 1 cancelled
  planned path 4h30m · APP-2 > APP-3 > APP-4
  remaining path 2h30m · APP-3 > APP-4
```

Checkout, `status` and `done` also take `--harness`, `--model` and `--account`, so
time and usage land under the right model and account.

Going deeper: [the CLI in detail](../design/cli.md) has every command's JSON
shape, refusal and rule.
