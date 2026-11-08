---
title: MCP tools
description: Every tool the staple MCP server offers, grouped by what an agent is doing, with its CLI equivalent and whether it writes.
---

# MCP tools

Use this page to find the tool an agent calls for a job, and the command you would
type for the same thing. The server offers 75 tools: 73 for the agent, grouped the
same way as the [CLI reference](cli.md), and two that only its views call
([Buttons in a view](#buttons-in-a-view)). A tool and its command follow the same rules, and most
answer the same object the command prints with `--json`.

1. Add the server once per machine, naming the agent
   ([Connect your agent](connect-your-agent.md) covers Codex and other clients, and
   what to run until `staple-cli` is on npm):

   ```bash
   claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
   ```

2. Ask your agent to list its staple tools. Each has a description and typed
   arguments; the client shows them.
3. Most tools take `ws` (a workspace slug or prefix) to reach another repository, and
   every write that records who acted takes `actor` when `STAPLE_AGENT` is not set.

The loop an agent follows, described in
[How an agent works a ticket](working-a-ticket.md):

`next_task` → `checkout_task` → `put_document` (the plan) → `add_comment` as it goes
→ `update_task` to `done` → `events_since` to see what that unblocked.

## Tickets

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `inbox` | What is ready, waiting on a person, or blocked, in pickup order | `staple inbox` | no |
| `list_tasks` | List tickets by status, kind, assignee or text | `staple ls` | no |
| `get_task` | One ticket in full: claim, time, gate, blockers, attempts, and file metadata | `staple show` | no |
| `create_task` | File a ticket, with parent, blockers and estimate | `staple new` | yes |
| `update_task` | Change status or fields; `status: "done"` finishes it | `staple status`, `staple done` | yes |
| `checkout_task` | Claim a ticket and start it | `staple start` | yes |
| `release_task` | Give a claim back | `staple release` | yes |
| `add_comment` | Add a comment | `staple comment` | yes |
| `list_comments` | A ticket's comments, oldest first | `staple show` | no |
| `put_document` | Store a plan, worklog or other document on a ticket. `instructions: true` makes it an instruction document for everything beneath the ticket | `staple doc --put` | yes |
| `get_document` | Read a document, latest or by revision | `staple doc` | no |
| `list_files` | A ticket's files: type, size, and hash. Never the bytes | `staple file ls` | no |
| `attach_file` | Attach a file from a path or from base64. The type is sniffed from the bytes | `staple file attach` | yes |
| `export_file` | Write one file's bytes to a path | `staple file get` | yes |
| `remove_file` | Remove a file | `staple file rm` | yes |
| `events_since` | What changed since a point in the event log | `staple events --since` | no |
| `record_attempt_event` | Report a pause, resume, checkpoint or interruption on the ticket you hold | `staple attempt pause` (and `resume`, `milestone`, `interrupt`) | yes |

## Planning

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `set_blocked_by` | Replace a ticket's blockers | `staple blocked-by` | yes |
| `gate_task` | Hold an epic for a person's review | `staple gate` | yes |
| `approve_task` | Release a held epic, or some of its tickets | `staple approve` | yes |
| `request_changes` | Send a held epic back with a note | `staple request-changes` | yes |
| `list_queue` | The pickup plan, and the order agents receive | `staple queue` | no |
| `next_task` | The one ticket to take next, and what it skipped | `staple queue next` | no |
| `enqueue_task` | Add a ticket, epic or milestone to the plan | `staple queue add` | yes |
| `dequeue_task` | Take an entry out of the plan | `staple queue rm` | yes |
| `move_queue_entry` | Move one entry | `staple queue mv` | yes |
| `reorder_queue` | Set the whole order | `staple queue reorder` | yes |
| `prune_queue` | Drop finished entries | `staple queue prune` | yes |
| `list_milestones` | Milestones, with progress | `staple milestone ls` | no |
| `get_milestone` | One milestone: members, goal and pace | `staple milestone show` | no |
| `create_milestone` | Create one, optionally from an epic | `staple milestone new` | yes |
| `update_milestone` | Change dates, description or criteria | `staple milestone set` | yes |
| `mark_milestone_criterion` | Judge one goal criterion met, unmet or unknown, with evidence | `staple milestone criterion` | yes |
| `add_milestone_member` | Add an epic or ticket | `staple milestone add` | yes |
| `remove_milestone_member` | Remove a member | `staple milestone rm` | yes |
| `move_milestone_member` | Move a member, or into another milestone | `staple milestone mv` | yes |
| `reorder_milestone_members` | Set the members' order | `staple milestone reorder` | yes |
| `list_ideas` | The plan: horizons and ideas with stage, late and not started | `staple idea ls` | no |
| `get_idea` | One idea: brief, questions, decisions, links | `staple idea show` | no |
| `list_horizons` | Horizons in order | `staple horizon ls` | no |
| `capture_idea` | Capture a raw idea | `staple idea new` | yes |
| `update_idea` | Edit title, brief, plan sections, questions (answer or defer) and decisions | `staple idea set`, `ask`, `resolve`, `decide` | yes |
| `start_idea` | Promote an idea to an epic in place, or adopt an issue | `staple idea promote`, `adopt` | yes |
| `scaffold_idea` | Preview, then create, an idea's epic and its tasks from the breakdown | `staple idea scaffold` | yes |
| `unlink_idea` | Remove a link from an idea | `staple idea unlink` | yes |

## Autopilot runs

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `start_run` | Start working a scope ticket after ticket. `instructions` gives the run its own | `staple run start` | yes |
| `continue_run` | After each ticket: take the next (with its `instructions`), wait, or stop | `staple run continue` | yes |
| `run_status` | A run, and whether it would stop now | `staple run status` | no |
| `pause_run` | Hold a run | `staple run pause` | yes |
| `resume_run` | Let a held run go on | `staple run resume` | yes |
| `stop_run` | End a run | `staple run stop` | yes |

## Cloud sync

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `cloud_status` | Whether this machine syncs this repository, from local files | `staple cloud` | no |
| `conflict_list` | Fields two machines set differently | `staple cloud conflicts` | no |
| `conflict_resolve` | Settle one conflict | `staple cloud resolve` | yes |

Connecting, disconnecting, automatic sync, backups, revoking and purging have no
tool. They are a person's decisions.

## Several repositories

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `hub_overview` | Every workspace on this machine, and the links between them | `staple hub` | no |
| `cross_link` | Make a ticket wait on a ticket in another repository | `staple link` | yes |
| `cross_unlink` | Remove that link | `staple hub unlink` | yes |
| `hub_unregister` | Drop one workspace from this machine's list | `staple hub unregister` | yes |
| `hub_prune` | Drop entries whose folder is gone; previews unless `apply` | `staple hub prune` | yes |

## Budget and estimates

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `set_estimate` | Change only the estimate; `null` clears it | `staple estimate` | yes |
| `compare_plans` | Labor, estimate coverage and the longest chain of named tickets | `staple compare` | no |
| `forecast` | Work left under a ticket, and what it costs your usage limits | `staple forecast` | no |
| `calibration_cohorts` | How long each kind of work takes against its estimate | `staple calibrate` | no |
| `timing_quality` | How much of the recorded time can be trusted | `staple timing quality` | no |
| `list_attempts` | Every agent session on a ticket | `staple attempts` | no |
| `get_attempt` | One session in detail | `staple attempt <id>` | no |
| `get_budget` | Each account's usage limits and pace | `staple budget` | no |
| `list_budget_samples` | One account's usage readings | `staple budget history` | no |
| `record_budget_sample` | Record a usage reading; refused until a person turns capture on | `staple budget ingest` | yes |
| `forget_budget_samples` | Remove wrong readings; previews unless `confirm: true` | `staple budget forget` | yes |

Turning budget capture on is a person's decision and has no tool
([Budget and estimates](budget-and-estimates.md)).

## Setup and settings

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `init` | Create a workspace when a tool reports there is none | `staple init` | yes |
| `get_setting` | Read a workspace setting, such as `queue.policy` | `staple settings get` | no |
| `set_setting` | Change a workspace setting | `staple settings set` | yes |
| `list_statuses` | This workspace's statuses | `staple statuses ls` | no |
| `update_statuses` | Add, rename, reorder or remove statuses | `staple statuses add` (and the rest) | yes |
| `list_kinds` | This workspace's kinds | `staple kinds ls` | no |
| `update_kinds` | Add, rename, reorder or remove kinds | `staple kinds add` (and the rest) | yes |

Change settings, statuses, kinds or the queue order only because a person asked.

## Views in the thread

Some tools also have a view: a small page that a client supporting
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) draws inside the
conversation instead of showing the tool's text. A client without MCP Apps shows the
same answer as text, so every view tool works everywhere.
[Views in the thread](mcp-apps.md) shows each view, which clients draw them, and when
an agent calls them.

| Tool | What it does | View | Writes |
|---|---|---|---|
| `show_about` | Which staple this is: version, workspace, tickets by status, the views it has | `ui://staple/about` | no |
| `show_ticket` | One ticket as a card: status, criteria, gate, attempt, branch, time, and a link to it | `ui://staple/ticket` | no |
| `show_progress` | One ticket's current attempt: its milestones, time against the estimate, last activity | `ui://staple/progress` | no |
| `show_queue` | The pickup queue in lanes: Ready in pickup order, Gated with the owner, In progress with who holds what | `ui://staple/queue` | no |

`checkout_task` draws the same ticket card (its answer carries it as `ticket`), so the
ticket an agent claims shows in the thread without an extra call. A view never calls a
tool on its own: some clients, T3 Code among them, ask you before every call a view makes.

An agent calls `show_ticket` right after a `staple checkout` (it does not follow
`checkout_task` with it: that claim already drew the card), `show_progress` after it
records a milestone (once; you refresh that view for later ones), and `show_queue` when you ask
what is next. To choose its own work it calls `next_task`.

The server lists its views as `ui://staple/<name>` resources (`resources/list`). Each is one
HTML file with nothing to download, shipped inside `staple-cli`. A tool names its view in
`_meta.ui.resourceUri`, and its results carry the same `_meta.ui`.

### Buttons in a view

Approve and Request changes on the ticket card, and Approve on the queue view, call two
tools that only a view may call. They declare MCP Apps `_meta.ui.visibility: ["app"]`, so a
client that follows the standard offers them to the view and leaves them out of the agent's
tool list.

| Tool | What it does | Called by | Writes |
|---|---|---|---|
| `approve_gate_from_view` | Approve the whole gate on `ref` as the person on this machine | the card's and the queue's Approve (`view`: `ticket_card` or `queue`) | yes |
| `request_changes_from_view` | Send the gate on `ref` back with the person's note, as that person | the card's Request changes (`view`: `ticket_card`) | yes |

They take no `actor`. The decision is recorded under `humanName` from the machine's
config (`staple config set humanName "Mira Lane"`, see
[Configuration](configuration.md#your-name-in-the-views)), or under the gate's owner while
that is unset, never under `STAPLE_AGENT`. The comment they write is the person's (author
type `user`) and names the view, for example "Approved by Mira Lane from the ticket card.",
and the `gate_approved` or `gate_changes_requested` event carries `via`. `show_ticket` reports
the decision as `ticket.decision` (`by`, `via`), and its text says "from the ticket card".

An agent that decides a gate calls `approve_task` or `request_changes`, and is recorded as
itself, with no `via`.

The client enforces the visibility, not staple: the server cannot tell a view's call from
an agent's. A client that ignores `visibility` would let an agent call these tools under the
person's name ([Views in the thread](mcp-apps.md#your-clicks-are-recorded-as-you)).

## When a tool refuses

A refusal is a tool result with `isError` and an object with `code`, `message`,
`detail` and `retryable`. The four an agent meets most:

- `conflict`: someone else has it. Pick a different ticket; do not retry.
- `gated`: a person must approve first. Pick a different ticket.
- `out_of_order`: the plan puts another ticket first. Take `detail.expected[0]`.
- `revision_conflict`: someone changed it since you read it. Read again, then retry.

[Errors and exit codes](errors.md) lists every code.

Going deeper: [the MCP tools in detail](../design/mcp-tools.md) has the argument
and answer shapes.
