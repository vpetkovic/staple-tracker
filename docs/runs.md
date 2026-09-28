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
staple run start --scope <queue|ref> [--max-tickets N] [--until T] [--ceiling P [--ceiling-account A]] [--override -m why]
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

`--max-tickets` counts distinct tickets: a ticket retried after a failure is
still one ticket. `--override -m why` is for `queue.policy = strict` (below).

`run continue` is the only write path for tickets: it takes, claims, and
records outcomes. The store's `recordTicketTaken` and `recordTicketOutcome` are
a low-level record for tests and hand repair, exposed by no CLI verb or MCP
tool; an adapter must not call them, or it bypasses the claim and the stop
rules.

## `run continue`: the contract

One call, one transaction, one of three actions. The CLI exits 0 for all
three, so a driver loops on `action` and never on the exit code. A non-zero
exit is a real error (a bad flag, several live runs and no `--run`, a refused
outcome) and is printed as the usual error envelope on stderr.

### What it does, in order

1. **Find the run.** `--run`, else the actor's one live run. With none live,
   the actor's most recently ended run that still has an unsettled ticket (a
   run stopped by a person or a budget mid-ticket): its ticket is settled in
   step 2 and its stop reason answered, so the claim does not leak and the
   driver hears why the run ended. With neither, `stop` with reason `no_run`
   and `run: null`, not an error: the loop has one exit, the stop answer. Several live runs and no `--run` is refused
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
     on a live run it is **not finished**. Nothing is recorded; step 5 hands it
     back (`resumed: true`). On an ended run nothing will come back to it, so
     it is recorded `failed` (reason: the run's stop reason) and released,
     rather than left held for good.
   - Else the actor's attempt that ended on it after it was taken: `completed`
     (review or done) is `done`, `failed` is `failed`.
   - Else the ticket's status: `done`, `review` and `gated` categories mean the
     work was handed on (`done`); anything else means it left the actor's hands
     unfinished (`failed`, with a reason naming the status, any new holder and
     how the attempt ended). Counting that as a failure is the safe direction:
     two in a row stop the run for a person to look. This includes a ticket a
     person cancelled, and one another agent took over: two of those in a row
     stop the run too.
   - No current ticket (the run has taken nothing yet, or recorded everything
     it took): nothing is recorded, and `--outcome` is ignored (`recorded: null`).
3. **Ended or paused.** An ended run answers `stop` with the reason it ended
   with. A paused run answers `wait` with reason `paused` and changes nothing
   else: pausing is not stopping, and the run picks up where it was on
   `run resume`. A finished ticket is still recorded on a paused or ended run.
4. **Stop rules** (below). First, a ticket the actor is still working that is
   no longer inside the scope (the scope is gone, or the ticket left it) is
   recorded `failed` and released rather than resumed. A trip ends the run and
   answers `stop`. When
   nothing is workable but the scope still holds unresolved work, the answer is
   `wait` with reason `waiting_on_others`, and the run stays live.
5. **Take.** In this order: the current ticket if it is being resumed; another
   row in scope the actor already holds (finish your own work before claiming
   more); else the scoped queue's next eligible row. **The take is the claim**:
   the checkout runs in the same transaction, so `take` means the ticket is
   already held by the actor, and two drivers asking at once never get the same
   row (the loser's read sees it claimed and is handed the next). Do not check
   it out again. The ticket is recorded on the run (`run_ticket_taken`).
   Under `queue.policy = strict` the checkout can refuse the row (below); the
   answer is then `wait` with reason `out_of_order`.

On a resume, or a retry of a ticket the run already took, the ticket budget is
not read: `--max-tickets` caps the distinct tickets a run takes, and handing
back or retrying one it has taken takes no new one (so `--max-tickets 1` still
retries its one ticket once after a failure). Every other rule applies, so a
time budget or a ceiling can stop a run when a ticket would be handed back;
that ticket is then recorded `failed` with the stop's reason and released: an
ended run holds nothing.

### Strict queue policy

Under `queue.policy = strict`, a checkout later in the plan than an eligible
queued row is refused `out_of_order`. A run is held to the **whole plan**,
exactly like any agent: scoping a run is not a way to jump the queue. When the
scoped queue's next row is refused, `continue` answers `wait` with reason
`out_of_order` and the refusal's detail (`expected`, `position`,
`expectedPosition`); nothing is claimed or recorded. It clears when the plan's
earlier rows are taken, or when a person queues the scope ahead of them.

A person who wants the run to work its scope first says so when starting it:
`run start --scope <ref> --override -m "<why>"` (MCP `start_run`
`override_reason`). The reason is mandatory, as for `checkout --override`, and
is on the run (`run.override`). Each take the plan would refuse is then an
override checkout with that reason, which writes `queue_overridden` with the
same payload a human's `checkout --override` writes (the actor is the run's).
A take the plan allows, and a resume, write no override. Under `advisory`
nothing is refused and the override is never used.

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
{ "action": "wait", "reason": "paused" | "waiting_on_others" | "out_of_order",
  "detail": {…}, "message": "…", "retryAfterSeconds": 60,
  "recorded": {…} | null, "run": {…} }

// stop: the loop ends
{ "action": "stop", "reason": "<stop reason>" | "no_run",
  "detail": {…}, "message": "…", "recorded": {…} | null, "run": {…} | null }
```

`run` is the run as `staple run status <id> --json` prints it under `run`.
`continue_run` over MCP answers the same object.

### Reason codes

Stable: never renamed. Stop reasons, first match wins:

| Reason | When | Run ends |
|---|---|---|
| `stopped_by_human` | somebody ran `run stop` (`run.stop.by`, `run.stop.note`) | `stopped` |
| `budget` | `detail.budget` is `tickets` (the run took `--max-tickets` distinct tickets), `time` (`--until` passed) or `ceiling` (a current rate-limit window's high-water use reached `--ceiling`) | `stopped` |
| `failure_streak` | the last two recorded outcomes are both `failed` | `stopped` |
| `scope_gone` | the scope no longer resolves: its issue was deleted (a restore can remove it) or it holds nothing any more (a parent left with no children). `detail.why` says which | `stopped` |
| `vp_blocked` | a ticket the run took is blocked on a named person, or nothing is workable and something in scope is | `stopped` |
| `gate_pending` | the scope issue awaits approval, or nothing is workable and something in scope does | `stopped` |
| `scope_empty` | nothing unresolved is left in scope | `completed` |
| `no_run` | the actor has no live run (`continue` only; `run` is null) | — |

`run status` never fails because of one run's scope: a gone scope reads as
decision `scope_gone`.

Wait reasons: `paused` (`detail` is empty), `out_of_order` (strict policy,
above) and `waiting_on_others`
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
  sleep short (`--retry-after` must be above 0, and every wait sleeps at least
  once). `stop`: print the reason and exit 0. Non-zero is a driver error
  only (a bad flag, a provider not on PATH, the store refusing), as the usual
  error envelope. A driver interrupted (Ctrl-C, SIGTERM) ends its session,
  records nothing and exits 130: the run stays live and the ticket stays held,
  so the next `run drive --run <id>` is handed it back (`resumed`) and starts
  a fresh session on it, whose brief says it is resuming (read what the last
  session left; post a fresh review). The signal handler stays installed: a
  second Ctrl-C KILLs the session at once instead of killing the driver
  mid-grace. A driver killed outright (`kill -9`) cannot end its session; the
  next driver to attach finds the session's process group in the dead
  driver's `driver.json`, ends it (TERM, then KILL) and says so (`reaped`)
  before it resumes the ticket, so a ticket never has two sessions.
- **Providers are rows** (`DRIVE_PROVIDERS`): the executable, its arguments
  with placeholders, the model flag, variables not to inherit. Adding a
  provider is a row.

  | `--agent` | Session |
  |---|---|
  | `claude` | `claude -p <brief> --output-format json --no-session-persistence [--model M]` |
  | `codex` | `codex exec --color never -C <workspace> <brief> [-m M]` |
  | `custom` | `--command "<template>"`, run by `/bin/sh -c` |

  A template's placeholders, each substituted shell-quoted: `{ref}` `{title}`
  `{brief}` (the text) `{brief_file}` `{workspace}` `{db}` `{run}` `{actor}`
  `{model}` (empty without `--model`) `{log_dir}`.
- **Permissions are the provider's own.** The built-in rows pass no permission
  flag: a session gets exactly what that CLI is configured to allow — Claude
  Code's settings files, Codex's `config.toml` — the same as a session you
  would open there yourself. The driver never widens that by itself. A session
  that needs something it is not allowed ends without handing its ticket on,
  which is recorded `failed`, and two in a row stop the run. `--full-access`
  appends each CLI's allow-everything switch for one run (claude
  `--permission-mode bypassPermissions`, codex
  `--dangerously-bypass-approvals-and-sandbox`); it is refused with
  `--agent custom`, whose template states its own. (Codex's
  `workspace-write` sandbox keeps `.git` read-only, so a Codex session can only
  branch and commit under a config that allows it, or `--full-access`.)
- **The session's world.** It runs in the workspace's directory (`--cwd` to
  change it), in its own process group, with `STAPLE_AGENT` (the run's actor:
  the take already claimed the ticket for it), `STAPLE_DB` (this workspace's
  database: the default for every `staple` command the session runs, over the
  directory it is in and over `--ws`), `STAPLE_RUN` and `STAPLE_RUN_TICKET`
  set. `STAPLE_DB` is a default, not a sandbox: an explicit `--db <path>` in
  the session still opens that database. The brief tells the session to pass
  neither; nothing enforces it.
- **Nothing outlives its session.** When the session's leader exits, its
  process group is ended too (TERM, then KILL after five seconds): a
  background `sleep &` or dev server it left behind does not keep running.
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
  | exit 0, ticket moved on, no `review: …` comment since the session began | `failed`, `no_review: …` — the brief's review step is the one part of it the tracker checks |
  | non-zero exit or a signal | `failed`, `session exited N` |
  | past `--ticket-timeout` | `failed`, `timed out: …`; the process group is ended |
  | the run ended while it worked | `failed`, `stopped_by_human: …` (or the reason the run ended) |
  | the driver was interrupted | nothing: left held for the next driver to resume |
  | `master` or `main` moved during the session | `failed`, `touched_main_line: …`, and the run is stopped |

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
  `<.staple>/runs/<run-id>/NNN-<ref>-<UTC instant>.{brief.md,stdout.log,stderr.log}`,
  printed at start; the instant keeps every session's files its own, across
  drivers resuming one ticket. `runs/` carries its own `.gitignore` of `*`.
- **Attached driver.** While it runs, the driver keeps `driver.json` in that
  directory (pid, host, agent, heartbeat every poll, the ticket and session pid)
  and removes it on exit. `run status` (`run_status`) answers it as `driver`,
  with `alive` (is the pid running; null when the driver is on another host),
  so a UI can show a run is being driven. One driver per run: `driver.lock`,
  created exclusively and holding the owner's pid, makes a second `run drive`
  on the run refused (`conflict`), even when two start at the same instant; a
  lock whose owner is no longer running is stale and taken over. It is a file rather than a column:
  no migration, and no write transaction every few seconds against the
  database the session works in.
- **`--dry-run`** starts nothing and claims nothing: it prints the next
  ticket, the environment, the exact command (the brief as
  `"$(cat <brief_file>)"`) and the brief.
- **`--json`** prints one object per line: `attached`, `take`,
  `session_started`, `session_ended` (`ended`: `exited`, `timeout`, `stopped`,
  `interrupted`; `exitCode`; the stated `outcome` and `reason`, null when the
  tracker reads it), `wait`, `stop` (the stop answer's `reason`, `message`,
  `detail` and `recorded`), `reaped` (a dead driver's session group ended:
  `pid`, `ticket`, `driverPid`) and `main_line_moved` (`ref`, `moves`).

**No MCP tool.** An MCP call answers and returns; a driver is a local process
that owns child sessions for hours and must outlive any one client. What MCP
needs of it is there already: `run_status` shows the attached driver and
`stop_run` stops it.

**It never merges, and it checks.** The driver spawns exactly one kind of
process, the provider's session, and runs no git of its own. Landing work is a
person's decision: the brief forbids it, and the run leaves a stack of branches
(and pull requests) behind. Because a brief is only words, the driver also
reads where `master` and `main` point in the session's repository before and
after every session (plain reads of the loose refs and `packed-refs` in the
repository's common directory; no git process). If either moved, the ticket is
recorded `failed` with reason `touched_main_line: …`, the run is stopped (by
`staple run drive`, with the moves in the note) and the driver exits: nothing
more runs until a person looks. It sees the local repository only; a push
straight to a remote that leaves the local refs alone is the remote's branch
protection's to refuse.

## Events

`run_started`, `run_stopped` (with `reason`, `detail`, `by`), `run_state_changed`
(pause and resume), `run_ticket_taken` and `run_ticket_recorded`, all in
`staple events --follow`. A take also writes the ordinary `checkout` event on
the ticket, and a stated failure on a held ticket its `release`.
