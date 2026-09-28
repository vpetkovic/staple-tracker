# Autopilot runs

A **run** is one agent working a scope ticket after ticket: the whole pickup
queue, an epic (or any parent), or a milestone. It carries a budget (a ticket
count, an end time, a rate-limit ceiling) and a state (`active`, `paused`,
`stopped`, `completed`). The tracker decides whether the run goes on, never the
prompt: every provider asks one question after every ticket, `run continue`,
and does what the answer says.

Runs are local to the machine that started them and are never synchronized.
The claims, statuses and attempts their tickets produce replicate as they
always did. Code: `src/core/run-store.ts`; CLI: `staple run`; MCP: `start_run`,
`run_status`, `stop_run`, `pause_run`, `resume_run`, `continue_run`.

## Commands

```
staple run start --scope <queue|ref> [--max-tickets N] [--until T] [--ceiling P [--ceiling-account A]]
                 [--gate-owner W] [--goal-cap N]
staple run status [<run-id>] [--all]
staple run stop [<run-id>] [-m why]
staple run pause [<run-id>]
staple run resume [<run-id>]
staple run continue [--run <run-id>] [--outcome done|failed] [--reason R]
staple run drive [--run <run-id> | --scope <queue|ref> [start options]] --agent <claude|codex|custom> [...]
```

`--actor A` (else `$STAPLE_AGENT`, else `$USER`) says who acts. Without a run
id, a command means the actor's one live (active or paused) run. Actors are
compared exactly, as claims are: `Bot` and `bot` are two actors with two runs.

## `run continue`: the contract

One call, one transaction, one of three actions. The CLI exits 0 for all
three, so a driver loops on `action` and never on the exit code. A non-zero
exit is a real error (a bad flag, several live runs and no `--run`, a refused
outcome) and is printed as the usual error envelope on stderr.

### What it does, in order

1. **Find the run.** `--run`, else the actor's one live run. None at all is
   `stop` with reason `no_run` and `run: null`, not an error: the loop has one
   exit, the stop answer. Several live runs and no `--run` is refused
   (`validation`, exit 2); name one. With `--run`, an `--actor` that is not the
   run's actor is refused: only a run's actor continues it.
2. **Settle the current ticket** (the run's last ticket with no outcome), in
   any run state:
   - `--outcome` wins. `--outcome failed` on a ticket the actor still holds
     also releases the claim and ends its attempt `failed` with `--reason`, so
     a dead session's ticket goes back to the queue. If it is still the first
     row, the same call takes it again: a failed ticket is retried once, and a
     second failure in a row is a `failure_streak` stop. `--outcome done` on a
     ticket the actor still holds is refused (`validation`): move it to review
     or done first.
   - Nothing stated and the actor still holds the ticket in an active status:
     it is **not finished**. Nothing is recorded; step 5 hands it back
     (`resumed: true`).
   - Else the actor's attempt that ended on it after it was taken: `completed`
     (review or done) is `done`, `failed` is `failed`.
   - Else the ticket's status: `done`, `review` and `gated` categories mean the
     work was handed on (`done`); anything else means it left the actor's hands
     unfinished (`failed`, with a reason naming the status, any new holder and
     how the attempt ended). Counting that as a failure is the safe direction:
     two in a row stop the run for a person to look.
   - No current ticket (the run has taken nothing yet, or recorded everything
     it took): nothing is recorded, and `--outcome` is ignored (`recorded: null`).
3. **Ended or paused.** An ended run answers `stop` with the reason it ended
   with. A paused run answers `wait` with reason `paused` and changes nothing
   else: pausing is not stopping, and the run picks up where it was on
   `run resume`. A finished ticket is still recorded on a paused or ended run.
4. **Stop rules** (below). A trip ends the run and answers `stop`. When
   nothing is workable but the scope still holds unresolved work, the answer is
   `wait` with reason `waiting_on_others`, and the run stays live.
5. **Take.** In this order: the current ticket if it is being resumed; another
   row in scope the actor already holds (finish your own work before claiming
   more); else the scoped queue's next eligible row. **The take is the claim**:
   the checkout runs in the same transaction, so `take` means the ticket is
   already held by the actor, and two drivers asking at once never get the same
   row (the loser's read sees it claimed and is handed the next). Do not check
   it out again. The ticket is recorded on the run (`run_ticket_taken`).

On a resume the ticket budget is not read: `--max-tickets` caps what a run
takes, and handing back the ticket it is still working takes nothing. Every
other rule applies, so a time budget or a ceiling can stop a run mid-ticket;
the ticket stays claimed and shows as open on the run.

### Strict queue policy

Under `queue.policy = strict`, a plain checkout of unqueued work is refused
`out_of_order` while any queued row elsewhere is eligible. A run's take reads
that guard **inside the run's scope**: the person who scoped the run to an
epic or a milestone ordered that work ahead of the rest of the queue. Queued
rows inside the scope still come first, and the take is always the scoped
queue's own `next`, so the guard never refuses it. No override is used and no
`queue_overridden` event is written. A run over the whole queue reads the
guard exactly as a plain checkout does.

### JSON shapes

Every answer carries `recorded`: what this call recorded for the previous
ticket, or null.

```jsonc
// recorded
{ "ref": "ABC-12", "outcome": "done" | "failed", "reason": "…" | null,
  "source": "stated" | "attempt" | "status" }

// take: the ticket is claimed for you; work it, then call continue again
{ "action": "take", "ref": "ABC-13", "issueId": "…", "title": "…",
  "why": "ABC-13 is next in issue ABC-10 by the pickup queue's order.",
  "resumed": false, "recorded": {…} | null, "run": {…} }

// wait: take nothing now; ask again after retryAfterSeconds, or end the session
{ "action": "wait", "reason": "paused" | "waiting_on_others",
  "detail": {…}, "message": "…", "retryAfterSeconds": 60,
  "recorded": {…} | null, "run": {…} }

// stop: the loop ends
{ "action": "stop", "reason": "<stop reason>" | "no_run",
  "detail": {…}, "message": "…", "recorded": {…} | null, "run": {…} | null }
```

Every answer also carries `goal`: on a goal run (a run over a milestone, see
[Goal mode](#goal-mode)) the goal check now, else `null`.

`run` is the run as `staple run status <id> --json` prints it under `run`.
`continue_run` over MCP answers the same object.

### Reason codes

Stable: never renamed. Stop reasons, first match wins:

| Reason | When | Run ends |
|---|---|---|
| `stopped_by_human` | somebody ran `run stop` (`run.stop.by`, `run.stop.note`) | `stopped` |
| `budget` | `detail.budget` is `tickets` (the run took `--max-tickets`), `time` (`--until` passed), `ceiling` (a current rate-limit window's high-water use reached `--ceiling`) or `goal_children` (a goal run's scope is empty short of its goal and it created its `--goal-cap` tickets) | `stopped` |
| `failure_streak` | the last two recorded outcomes are both `failed` | `stopped` |
| `vp_blocked` | a ticket the run took is blocked on a named person, or nothing is workable and something in scope is | `stopped` |
| `gate_pending` | the scope issue awaits approval, or nothing is workable and something in scope does (a goal run's own gate on its milestone is not one) | `stopped` |
| `goal_met` | a goal run: nothing unresolved is left in scope and every criterion of the milestone is met; the milestone stays gated to its owner | `completed` |
| `scope_empty` | nothing unresolved is left in scope | `completed` |
| `no_run` | the actor has no live run (`continue` only; `run` is null) | — |

Wait reasons: `paused` (`detail` is empty) and `waiting_on_others`
(`detail.rows`: each unresolved row in scope the run cannot take, with the
queue's `eligibility` (`claimed`, `blocked`, `gated`, `unavailable`) and
`reason`). Work that only others can move (another agent's claim, a dependency,
a ticket in review) is a wait, not an empty scope: the queue's own contract is
that a null `next` with unresolved rows skipped is stuck, not empty. A wait
lasts until somebody moves that work, or a budget or a person stops the run.

"Inside the scope" has one definition, the queue's (`queue next --scope`):
under the epic or parent, or, for a milestone, a member or anything under a
member or under the milestone. The scope issue itself is never a ticket.

## A driver loop

The whole provider contract is: call `continue`, act on `action`, repeat.

```sh
export STAPLE_AGENT=my-agent
staple run start --scope ABC-40 --max-tickets 10 --until 4h --json >/dev/null

flags=()
while :; do
  answer=$(staple run continue "${flags[@]}" --json) || exit 1   # non-zero: a real error
  flags=()
  case $(jq -r .action <<<"$answer") in
    take)
      ref=$(jq -r .ref <<<"$answer")                     # already claimed for you
      my-agent-cli --prompt "Work $ref with staple. Move it to in_review when done." ||
        flags=(--outcome failed --reason "session exited $?")
      ;;                                                 # on success the outcome is read off the ticket
    wait) sleep "$(jq -r .retryAfterSeconds <<<"$answer")" ;;
    stop) jq -r '"stopped: \(.reason): \(.message)"' <<<"$answer"; break ;;
  esac
done
```

A failed session is reported on the next `continue`, which records it,
releases the claim and answers what to do after it (a take, or a
`failure_streak` stop). A session that exits cleanly while still holding its
ticket gets it back (`resumed: true`); a driver that considers that session
over passes `--outcome failed` instead.

An agent inside one session (an MCP client) makes the same calls with
`continue_run`: work the `take`, call `continue_run` again, end the session on
`stop`, and on `wait` either end the session or ask again later.

## `run drive`: the headless driver

`run drive` is the driver loop above, built in: it calls `continue` in-process
and, for every `take`, launches one **fresh** headless agent session on that
ticket, waits for it, and states how it ended on the next `continue`. A fresh
session per ticket means a fresh context per ticket, and any provider with a
headless CLI can drive. Code: `src/core/run-driver.ts` (loop, provider table),
`src/core/run-brief.ts` (the brief), `src/core/run-attachment.ts` (the driver
file); CLI: `src/commands/run-drive.ts`.

```
staple run drive [--run <id> | --scope <queue|ref> [--max-tickets N] [--until T] [--ceiling P]]
                 --agent <claude|codex|custom> [--command "<template>"] [--model M]
                 [--finish in_review|done] [--ticket-timeout D] [--retry-after S]
                 [--poll S] [--instructions <file>] [--cwd <dir>] [--dry-run] [--json]
```

- **Which run.** `--run`, else `--scope` starts one (with `run start`'s budget
  options, refused as `run start` refuses them), else the actor's one live run.
- **The loop.** `take`: write the brief, run the session, record. `wait`: sleep
  `retryAfterSeconds` (or `--retry-after`) and ask again; an ended run cuts the
  sleep short. `stop`: print the reason and exit 0. Non-zero is a driver error
  only (a bad flag, a provider not on PATH, the store refusing), as the usual
  error envelope. A driver interrupted (Ctrl-C, SIGTERM) ends its session,
  records nothing and exits 130: the run stays live and the ticket stays held,
  so the next `run drive --run <id>` is handed it back (`resumed`) and starts
  a fresh session on it.
- **Providers are rows** (`DRIVE_PROVIDERS`): the executable, its arguments
  with placeholders, the model flag, variables not to inherit. Adding a
  provider is a row.

  | `--agent` | Session |
  |---|---|
  | `claude` | `claude -p <brief> --output-format json --permission-mode bypassPermissions --no-session-persistence [--model M]` |
  | `codex` | `codex exec --dangerously-bypass-approvals-and-sandbox --color never -C <workspace> <brief> [-m M]` |
  | `custom` | `--command "<template>"`, run by `/bin/sh -c` |

  A template's placeholders, each substituted shell-quoted: `{ref}` `{title}`
  `{brief}` (the text) `{brief_file}` `{workspace}` `{db}` `{run}` `{actor}`
  `{model}` (empty without `--model`) `{log_dir}`. A headless session has
  nobody to answer a permission prompt, so the built-in rows grant what their
  CLI needs up front; use `custom` for anything tighter. (Codex's
  `--sandbox workspace-write` keeps `.git` read-only: a session under it can
  neither branch nor commit, so it is not the default.)
- **The session's world.** It runs in the workspace's directory (`--cwd` to
  change it), in its own process group, with `STAPLE_AGENT` (the run's actor:
  the take already claimed the ticket for it), `STAPLE_DB` (this workspace's
  database, so its `staple` commands cannot reach another workspace),
  `STAPLE_RUN` and `STAPLE_RUN_TICKET` set.
- **The brief** tells a session that knows nothing: the ticket and how to read
  it; that it is already checked out (do not check out, release or take
  anything else, do not call `run` commands); to put the work on a branch,
  `autopilot/<ref>`, off the current HEAD (sessions run one after another in
  one checkout, so the branches stack) and comment the branch on the ticket;
  plan and worklog documents; the repository's gates, counts read; an
  **adversarial review before finishing**, reproduced rather than read, by a
  sub-agent where the provider can start one; commit on the branch, and a draft
  pull request if there is a remote; **never merge to master or main, never
  push to them**; then comment the evidence and move the ticket to `in_review`
  (default) or `done` (`--finish done`). `--instructions <file>` appends this
  repository's own rules (its gates, its conventions).
- **Outcome.** The session's end, mapped once:

  | Session | Recorded |
  |---|---|
  | exit 0, ticket moved on (review, done, gated) | nothing stated: the tracker reads the attempt or status (`done`) |
  | exit 0, ticket still held in an active status | `failed`, `session exited 0 but left … and still held` |
  | non-zero exit or a signal | `failed`, `session exited N` |
  | past `--ticket-timeout` | `failed`, `timed out: …`; the process group is ended |
  | the run ended while it worked | `failed`, `stopped_by_human: …` (or the reason the run ended) |
  | the driver was interrupted | nothing: left held for the next driver to resume |

  A stated `failed` on a held ticket releases it and ends its attempt, so the
  ticket goes back to the queue; the tracker retries it once, and two failures
  in a row stop the run (`failure_streak`).
- **Stop mid-ticket.** The driver reads the run every `--poll` seconds (5)
  while a session works. `staple run stop` (or `stop_run`, or the UI) from
  anywhere ends the run; within one poll the driver sends TERM to the session's
  process group, KILL five seconds later, records the ticket `failed` with
  reason `stopped_by_human: …` (released, not left held by a session that no
  longer exists), prints the stop and exits 0. Recording it failed rather than
  leaving it open is deliberate: an open ticket stays claimed by nobody alive.
  The run has already ended, so the failure starts no streak. A **pause** lets
  the session finish; the next `continue` then answers `wait`. A time budget or
  a ceiling is read by the next `continue`, so it never cuts a session short;
  bound a session with `--ticket-timeout`.
- **Logs.** Each session's brief, stdout and stderr go to
  `<.staple>/runs/<run-id>/NNN-<ref>.{brief.md,stdout.log,stderr.log}`, printed
  at start. `runs/` carries its own `.gitignore` of `*`.
- **Attached driver.** While it runs, the driver keeps `driver.json` in that
  directory (pid, host, agent, heartbeat every poll, the ticket and session pid)
  and removes it on exit. `run status` (`run_status`) answers it as `driver`,
  with `alive` (is the pid running; null when the driver is on another host),
  so a UI can show a run is being driven; a second `run drive` on a run whose
  driver is alive is refused (`conflict`). It is a file rather than a column:
  no migration, and no write transaction every few seconds against the
  database the session works in.
- **`--dry-run`** starts nothing and claims nothing: it prints the next
  ticket, the environment, the exact command (the brief as
  `"$(cat <brief_file>)"`) and the brief.
- **`--json`** prints one object per line: `attached`, `take`,
  `session_started`, `session_ended` (`ended`: `exited`, `timeout`, `stopped`,
  `interrupted`; `exitCode`; the stated `outcome` and `reason`, null when the
  tracker reads it), `wait`, and `stop` (the stop answer's `reason`, `message`,
  `detail` and `recorded`).

**No MCP tool.** An MCP call answers and returns; a driver is a local process
that owns child sessions for hours and must outlive any one client. What MCP
needs of it is there already: `run_status` shows the attached driver and
`stop_run` stops it.

**It never merges.** The driver spawns exactly one kind of process, the
provider's session, and runs no git of its own; a test holds that. Landing work
is a person's decision: the brief forbids it, and the run leaves a stack of
branches (and pull requests) behind.

## Goal mode

A run over a milestone is a **goal run**: the milestone's own acceptance
criteria (docs/milestones.md, "Goal") are what it works toward, and the
milestone is the goal, not a separate document. Code: `src/core/milestone-goal.ts`
(the pure rules), `run-store.ts` (the run's half), `milestone-store.ts` (marks).

```
staple milestone new "October" -d "What it is for" --criteria "Docs written;Tests pass"
staple run start --scope ABC-40 --gate-owner VP [--goal-cap 5]
staple milestone criterion ABC-40 1 --met --evidence ABC-41
staple milestone criterion ABC-40 2 --unmet --evidence "no tests" --follow-up "Write the tests"
```

**Start.** `--gate-owner` names the person the milestone is gated to; without
it the milestone's assignee, and with neither the start is refused
(`validation`). `--goal-cap N` (default 5, 0 allowed) caps the tickets the run
may create itself. Both are refused on any other scope.

**The gate is opened at the start.** A milestone closes itself when its last
member lands, as a parent does, unless a gate is open on it. So the run gates the
milestone to its owner as it starts, with a comment saying why. That is the only
design that holds whoever lands the last member: another agent, a person, or a
device that syncs the landing in. The gate is an ordinary gate and replicates; a
run-local rule would not. A milestone's gate queues nothing through membership
(docs/milestones.md, "Gating a milestone"), so the members stay workable and the
run keeps taking them. The run records the gate's `gate_requested_at` as
`run.goal.gatedAt`; that gate is **not** a `gate_pending` stop. A gate a person
opened (before the run, or after answering the run's) still is.

The run keeps a gate open from then on:

- before it adds a member (a goal check or a follow-up), it gates again if the
  gate was approved: approved is history, and the new work is unreviewed;
- a person's `changes_requested` also holds the close, so it is left standing
  while the run works;
- at `goal_met` it gates again unless its own gate is still pending, which
  answers a `changes_requested` the way re-gating always does: the work goes back
  for a second read.

A milestone with nothing in it yet cannot be gated; the run gates it before the
first member it adds itself. A milestone a person resolved while the run worked
is their decision: the run ends `scope_empty`.

**The goal check.** When the scope empties (where a run over an epic would end
`scope_empty`):

1. every criterion met: stop `goal_met` (ends `completed`), the milestone left
   gated to its owner, never closed;
2. else, with room under the cap: the run creates a **goal-check ticket**
   (`Goal check: <milestone title>`, label `goal-check`), makes it a member and
   takes it. `run status` shows this as `{stop: false, goalCheck}`;
3. else: stop `budget`, `detail.budget` `goal_children`, the milestone gated.

A milestone with no criteria has none left to show: its goal is that its
members land, and the run ends `goal_met` when they have.

**Judging.** The tracker never judges a criterion: there is no model inside it.
The agent does, with `staple milestone criterion` (MCP
`mark_milestone_criterion`), and the tracker decides what each mark is still
worth at every check, deterministically:

| Mark | Reads |
|---|---|
| none | `unknown` (the default) |
| on a criterion reworded since | `unknown` |
| `met`, a cited ticket not done (or since reopened), or a cited document gone | `unknown`, with why |
| otherwise | what was marked |

Evidence is a ticket (`ABC-12`, counts while it is done), a document on a ticket
(`ABC-12:plan`, counts while it exists) or text. `met` needs at least one piece;
a cited ticket or document must exist. A session may cite its own ticket before
closing it: the criterion reads `unknown` until the ticket is done.

**Tickets the run creates** are attributed to it: `createdBy` the run's actor,
`originKind` `run`, `originId` `<run id>/<n>`, a `goal-check` or
`goal-follow-up` label, and a membership noted `created by goal run <id>`. They
are members, never children, so the milestone's gate never holds them. A
follow-up is filed by marking a criterion `unmet` with `--follow-up "<title>"`
(`--follow-up-description`) from the actor's live goal run over the milestone
(or `--run`); its acceptance criterion is the criterion it answers. Every one
counts against the cap, goal checks included; past it the follow-up is refused
and the run's next empty scope stops `budget`. `run.goal.children` lists them.

**What each answer carries.** `goal` on `take`, `wait`, `stop` and
`run status`:

```jsonc
{ "milestone": { "identifier": "ABC-40", "title": "October", "status": "awaiting_approval" },
  "criteria": [ { "position": 1, "text": "Docs written", "verdict": "met", "marked": "met",
                  "evidence": [ { "kind": "ticket", "value": "ABC-41", "ref": "ABC-41",
                                  "document": null, "status": "done", "holds": true, "problem": null } ],
                  "note": null, "markedBy": "bot", "markedAt": "…", "runId": "…", "why": null } ],
  "counts": { "met": 1, "unmet": 0, "unknown": 1, "total": 2 },
  "met": false,
  "pace": { … },                                   // docs/milestones.md, "Goal"
  "children": { "cap": 5, "created": 1, "left": 4, "refs": ["ABC-44"] },
  "gate": { "state": "pending", "owner": "VP", "requestedAt": "…", "ownedByRun": true } }
```

`run.goal` is `{gateOwner, childCap, children: [{identifier, title, status,
purpose}], gatedAt}` on a goal run and `null` otherwise.

**`run drive`.** A goal run's brief gains a goal section: the criteria as the
check reads them and the verb to mark one, with "mark only what your work
shows". A goal-check ticket's brief says it is the goal check: judge each
criterion against the evidence, file follow-ups for the unmet ones (and how many
are left), change no code, and close it with `staple done` whatever `--finish`
says.

**Local.** Marks are machine-local like runs (workspace migration 016): the
verdicts are the driving agent's on this machine. The goal itself (description,
criteria), the evidence, the tickets the run creates and the gate all replicate.

## Events

`run_started`, `run_stopped` (with `reason`, `detail`, `by`), `run_state_changed`
(pause and resume), `run_ticket_taken` and `run_ticket_recorded`, all in
`staple events --follow`. A goal run adds `run_goal_gated` (the run opened a gate
on its milestone) and `run_goal_child_created`, and a mark writes
`milestone_criterion_marked`; none names an issue, like the run events. A take also writes the ordinary `checkout` event on
the ticket, and a stated failure on a held ticket its `release`.
