---
name: staple
description: Work with the Staple task tracker through MCP or CLI. Use when creating Staple tickets, taking work from its pickup queue, updating task context or progress, resuming interrupted work, or answering questions about Staple tickets and queues.
---

# Work with Staple

Read the target repository's `.staple/AGENTS.md` before working. It is the
repository-specific protocol; this skill helps discover and use it. Follow effective
instruction documents returned with a ticket or run as well. Do not replace project
rules with assumptions from another repository.

## Resolve the workspace and runtime

Use the configured Staple MCP tools or the installed `staple` CLI. For CLI reads
and writes, request `--json`, after the command and its positional arguments.
If Staple is unavailable, report that and follow the project's setup instructions.
Do not run a source checkout against live tracker data or read its database with SQL.

The workspace is normally discovered from the working directory, including linked
Git worktrees. For another project or an ambiguous location, use MCP's `ws` with
its registered slug or prefix, or CLI `--ws <slug>`. `staple hub ls --json` lists
registered workspaces. Never guess a database path or initialize a second tracker
to work around a missing workspace.

Use one agent identity throughout the session. Pass MCP `actor` on writes, or set
`STAPLE_AGENT` for CLI commands. Keep the identity used to claim work when commenting
and checkpointing; those writes establish the holder's liveness.

## Choose the narrow operation

| Request | MCP | CLI |
|---|---|---|
| Show the queue or what is next to a person | `show_queue` | `inbox --json` |
| Show a ticket to a person | `show_ticket` | `show <ref> --json` |
| Show progress | `show_progress` | `show <ref> --json` |
| Check version and workspace | `show_about` | `--version`, then `hub ls --json` |
| Select authorized work internally | `next_task` | `queue next --json` |
| Read full context for a named ticket | `get_task` | `show <ref> --json` |
| Search for existing work | `list_tasks` with `q` | `ls -q <query> --json` |

Use the native display tools for person-facing questions when available. Preserve
their complete results so MCP Apps hosts can render the views. If rendering or the
tool is unavailable, say so and provide the useful text fallback. A queue question
does not authorize claiming work. Do not fetch a whole workspace tree for one ticket.

## Record, claim and work

1. Search for an existing ticket that owns the requested outcome. Before durable
   changes, create one if needed with context, acceptance criteria, a plan-time
   estimate and the appropriate kind. Use `bug` for observed incorrect behavior,
   `chore` for upkeep, `spike` for investigation and `task` for other defined outcomes.
   An epic groups independently completable tickets; agents claim its leaves.
2. For queue pickup, use `next_task` and respect its order. Read the candidate's
   full context, blockers, instructions and existing worklog before claiming it
   once with `checkout_task`. A named task still has to satisfy the claim guards.
3. Record the branch, checkout path and base commit in a comment. Store the plan
   and relevant context as keyed documents using `put_document`. Include the
   material needed to resume the work, rather than only pointing to a past chat.
4. Comment at meaningful milestones and keep a `worklog` document current with
   Done, Next and Files touched. Use `base_revision` when replacing a document;
   re-read and merge after `revision_conflict`.
5. Verify the outcome and record concrete evidence, including pending checks.
   Attach screenshots and logs as files, not base64 in documents. Use the project's
   review status while a PR awaits merge. Mark done only when its completion rules
   are met; tracking work never grants permission to commit, merge or deploy it.
6. Before interruption or handoff, checkpoint the worklog and branch pointer and
   leave ownership explicit. Resume from that context rather than starting over.
   Automated runs require the latest worklog to be written during the current
   session (interactive hooks use the current ticket tenure), with content under
   Done, Next and Files touched. Write "none" for an empty section. A headless
   session fails as `no_worklog` without it; interactive hooks ask for the checkpoint
   before advancing, subject to the usual human-stop and loop-limit controls.

## Link provider issues and pull requests

Staple can link a ticket to a GitHub issue or pull request, a Linear issue or an Azure DevOps work item and keep
a read-only copy of its title and state beside the ticket. It never writes to the
provider, and a link never changes the ticket's status.

- When you open a pull request for a ticket, or a ticket exists because of an issue
  the person named, link it: `integration_write` with `action: "link"`, the ticket
  `ref`, the exact `url` and `confirmed: true`. Read the ticket first; `confirmed`
  states that you checked the target.
- `integration_read` answers the questions: `preview` (what a URL is and which
  tickets already link it), `list` (a ticket's links), `mapping` (what this workspace
  searches), `connections` and `health`. Prefer an exact URL to `search`.
- A workspace links only the repositories, teams and projects mapped to it. On
  `outside_scope`, or when a connection is not ready, relay what the answer says to
  the person. Signing in, configuring connections, mapping sources and sharing a
  saved copy with other devices are their decisions.
- Stacked pull requests are explicit: set the parent with `action: "stack"`. Numbers
  and branch names never imply ancestry.

## Respect refusals and human decisions

- `conflict`: another holder owns it. Take different eligible work; do not retry
  or steal. Takeover requires an explicit human request and a fresh stale-claim check.
- `gated`: the named person must approve. Neither waiting nor a takeover bypasses it.
- `out_of_order`: take the expected eligible ticket; do not send an override yourself.
- Blocked work remains blocked until its real dependency resolves. Do not mark the
  blocker done or rewrite the queue just to make a checkout pass.
- Planning is experimental and off by default. Read `get_setting` for
  `features.planning` before using idea or horizon tools. Only a person enables it.
  Ideas are drafts, not claimable tickets. If pickup returns `planSteps`, take only
  steps whose `who` is `agent`; surface person-owned decisions and questions.
- For an authorized autopilot run, call `continue_run` after each ticket and obey
  `take`, `wait` or `stop`. Do not turn ordinary ticket work into an unrequested run.
- Cloud connection, restore, purge, device revocation and registry adoption are
  separate human decisions. Never use them as an automatic repair for a failed call.
- Keep credentials and private data out of ticket text, attachments and public Git
  history. Use narrow tools instead of direct database access.

Consult the running tool schemas or `staple help` for arguments not shown here.
Keep this skill aligned with the Staple version in use; do not assume newer tools
exist on an older server.
