# Autopilot runs

The contract behind autopilot runs, for people working on staple. The user guide is [docs/runs.md](../docs/runs.md).

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
                 [--gate-owner W] [--goal-cap N]
staple run status [<run-id>] [--all]
staple run stop [<run-id>] [-m why]
staple run pause [<run-id>]
staple run resume [<run-id>]
staple run continue [--run <run-id>] [--outcome done|failed] [--reason R]
staple run drive [--run <run-id> | --scope <queue|ref> [start options]] --agent <claude|codex|custom> [...]
staple run hook install|bind|unbind|<provider>-stop [...]
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

Every answer also carries `goal`: on a goal run (a run over a milestone, see
[Goal mode](#goal-mode)) the goal check now, else `null`.

`run` is the run as `staple run status <id> --json` prints it under `run`. Its `counts`:
`tickets` is the distinct tickets taken, the number `--max-tickets` caps; `taken` is every
take, so a ticket retried after a failure is one ticket and two takes; `done`, `failed`
and `open` count takes by how each ended. `run status` prints `1/5 tickets (2 takes)`.
`continue_run` over MCP answers the same object.

### Reason codes

Stable: never renamed. Stop reasons, first match wins:

| Reason | When | Run ends |
|---|---|---|
| `stopped_by_human` | somebody ran `run stop` (`run.stop.by`, `run.stop.note`) | `stopped` |
| `touched_main_line` | `run drive` saw a session move `master` or `main` (`detail.ticket`, `detail.moves`) | `stopped` |
| `budget` | `detail.budget` is `tickets` (the run took `--max-tickets` distinct tickets), `time` (`--until` passed), `ceiling` (a current rate-limit window's high-water use reached `--ceiling`) or `goal_children` (a goal run's scope is empty short of its goal and it created its `--goal-cap` tickets) | `stopped` |
| `failure_streak` | the last two recorded outcomes are both `failed` | `stopped` |
| `scope_gone` | the scope no longer resolves: its issue was deleted (a restore can remove it) or it holds nothing any more (a parent left with no children). `detail.why` says which | `stopped` |
| `vp_blocked` | a ticket the run took is blocked on a named person, or nothing is workable and something in scope is | `stopped` |
| `gate_pending` | the scope issue holds a person's open gate, or nothing is workable and something in scope does. Open is `pending`, or a person's `changes_requested`, which still holds the work beneath it (`detail.gates[].state` says which; without it the run would wait on that work for ever). A goal run's gate on its milestone is not one | `stopped` |
| `goal_met` | a goal run: nothing unresolved is left in scope and every criterion of the milestone is met; the milestone stays gated to its owner | `completed` |
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
staple run drive [--run <id> | --scope <queue|ref> [--max-tickets N] [--until T] [--ceiling P [--ceiling-account A]]
                 [--gate-owner W] [--goal-cap N]]
                 --agent <claude|codex|custom> [--command "<template>"] [--model M] [--full-access]
                 [--finish in_review|done] [--ticket-timeout D] [--retry-after S]
                 [--poll S] [--instructions <file>] [--cwd <dir>] [--forget-stale-session]
                 [--dry-run] [--json]
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
  mid-grace. A driver interrupted after its session moved the main line still
  sends that failure before it exits (the run is already stopped). A driver
  killed outright (`kill -9`) cannot end its session. The next driver to attach
  finds the session's process group in the dead driver's `driver.json` and, if
  a group of that id is still running, **refuses** (`conflict`, exit 4), naming
  the group, the ticket and when the session started: process ids are reused,
  and proving the group is still that session needs its start time or
  environment, which on macOS only another process (`ps`) can read. It never
  kills a process it cannot prove is its own. A person checks it
  (`ps -o pid,lstart,command -g <pgid>`), ends it if it is the session
  (`kill -TERM -<pgid>`) and drives again, or drives again with
  `--forget-stale-session` to go on without touching it
  (`stale_session_forgotten`). Either way a ticket never has two sessions
  unknowingly.
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
  Ending a session early (a stop, a timeout, Ctrl-C) works the same way, and
  the grace lasts until the whole group is gone, not only its leader: a
  `custom` template runs under `/bin/sh -c`, which on Debian and Ubuntu (dash)
  forks the agent instead of exec-ing it, and the agent still gets its grace
  when that shell dies at once on TERM. A driver that fails with an error
  mid-session ends the session the same way before it exits, so no session
  outlives its driver unnamed. In a container, run the driver under an init
  (`docker run --init`, or tini): as PID 1 the driver does not reap the
  session's orphaned children, their zombies keep the group "running" until
  each grace runs out, and a stop can take up to ten seconds even when the
  session ended at once.
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
  anywhere ends the run. `run stop` itself records the run's held ticket
  `failed` with reason `stopped_by_human: <note>` and releases it, on every
  path that stops a run, driver or none; within one poll the driver sends TERM
  to the session's process group, KILL five seconds later, prints the stop and
  exits 0. Recording it failed rather than
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
  on the run refused (`conflict`), even when two start at the same instant. A
  lock whose owner is no longer running is stale and taken over, one taker at a
  time: under a second exclusive lock (`driver.lock.takeover`) the owner is
  read again and a still-stale lock is replaced whole by a rename, so of many
  drivers starting over a dead one's lock exactly one owns it (a test starts
  six at once, five times). A lock that vanishes between two reads is read
  again, never a crash. It is a file rather than a column:
  no migration, and no write transaction every few seconds against the
  database the session works in.
- **`--dry-run`** starts nothing and claims nothing: it prints the next
  ticket, the environment, the exact command (the brief as
  `"$(cat <brief_file>)"`) and the brief. With `--scope <milestone>` the brief carries
  the goal section the goal run's would, and `--gate-owner` and `--goal-cap` are read
  and refused as `run start` reads them; no gate is opened.
- **`--json`** prints one object per line: `attached`, `take`,
  `session_started`, `session_ended` (`ended`: `exited`, `timeout`, `stopped`,
  `interrupted`; `exitCode`; the stated `outcome` and `reason`, null when the
  tracker reads it), `wait`, `stop` (the stop answer's `reason`, `message`,
  `detail` and `recorded`), `stale_session_forgotten` (`pid`, `ticket`,
  `driverPid`: a dead driver's session group left running under
  `--forget-stale-session`), `main_line_unguarded` (`reason`: once, at attach)
  and `main_line_moved` (`ref`, `moves`).

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
recorded `failed` with reason `touched_main_line: …`, the run is stopped with
its own reason, `touched_main_line` (by `staple run drive`, the ticket and the
moves in `detail`), and the driver exits: nothing more runs until a person
looks. A repository whose refs live in a reftable (`extensions.refStorage =
reftable` in its config) has no ref files to read: the driver says once, at
attach, that it cannot guard the main line there (`main_line_unguarded`) and
reads nothing, rather than reporting that nothing moved. It sees the local repository only; a push
straight to a remote that leaves the local refs alone is the remote's branch
protection's to refuse.

## Interactive sessions: stop hooks

`run drive` (tier A) starts a fresh session per ticket. A session a person is
**already in** keeps working a run through its agent CLI's stop hook (tier B):
a command the CLI runs whenever the agent is about to end its turn, and whose
answer can keep the turn going with a new prompt. Where a CLI has no such hook,
the instructions are the adapter (tier C, below). Code: `src/core/run-hook.ts`
(the decision, bindings), `src/core/run-hook-providers.ts` (one row per CLI);
CLI: `src/commands/run-hook.ts`.

```
staple run hook install <provider> [--print] [--user | --project | --local] [--staple CMD] [--dir DIR]
staple run hook bind [--run <run-id>] [--session <id>] [--provider <provider>]
staple run hook unbind [--session <id>] [--provider <provider>] | --run <run-id>
staple run hook <provider>-stop [--max-repeats N] [--max-blocks N]      # run by the CLI, payload on stdin
```

In a Claude Code session, for example:

```sh
staple run hook install claude --print     # the stanza for ~/.claude/settings.json; paste it once
staple run start --scope ABC-40 --max-tickets 5
staple run hook bind                       # this session now works that run
# end the turn: the hook hands the session ABC-41, already checked out
```

**Binding.** A hook fires for every session of the CLI it is installed in, so
it acts only for a session bound to a run. `bind` writes
`<staple home>/run-sessions/<provider>-<session>.json` (the run, its workspace
database, the actor): the session may `cd` into a worktree the workspace cannot
be found from, and a file needs no migration. The session id is `--session`,
else the variable the CLI exports to the agent's shell commands (Claude Code:
`CLAUDE_CODE_SESSION_ID`, which the docs say "matches the session_id field in
the hook JSON input and is updated on /clear"; Gemini CLI: `GEMINI_SESSION_ID`,
documented for hooks). A CLI that exports none gets a **pending** binding: the
directory `bind` ran in, claimed by that provider's next stop whose session
works there or below it (never above it: a session in `$HOME` is not the one
that ran `bind` in a project), within ten minutes. The agent that ran `bind`
ends its turn next, so that stop is almost always its own; the claim is a
rename, so two sessions stopping at once never both get it. Run `bind` from the
directory the session works in; `--session` binds exactly. After `/clear` (a
new session id) the old binding no longer matches: unbind it and bind again.

**One run, one session.** `bind` is refused (`conflict`) for a run another
session is bound to, or a pending binding made elsewhere waits for, naming it;
a pending binding is never claimed for a run a session already works. To move a
run to another session, `staple run hook unbind --run <id>` removes every
binding of it first. Rebinding the same session changes nothing. `bind` is also
refused for an ended run and for a run a live `run drive` is attached to: two
adapters never work one run. For the same reason the hook
does nothing in a session `run drive` started (`STAPLE_RUN_TICKET` is set), in
a sub-agent, and for a run a live driver has since attached to.

**The decision**, for a bound session, in order:

| Situation | Answer |
|---|---|
| the run's current ticket is still held by its actor, in an active status | keep going: finish it, or state the failure (`run continue --outcome failed --reason …`); nothing is recorded |
| it was handed on (review, done, gated) with no `review: …` comment since the run took it | keep going: review it adversarially and record the review. The rule `run drive` enforces as `no_review`, reached the interactive way: the session is asked to do it, not failed |
| otherwise, `run continue` answers `take` | keep going: "next ticket REF "title"", already checked out to the run's actor, with the steps (read it, branch, plan and worklog, gates, adversarial review, `in_review`), the environment to act as the actor (`STAPLE_AGENT=… STAPLE_DB=…`), never merge to master or main. A goal check gets the goal-check steps instead |
| `wait` | the session may stop, with the reason shown: a wait can last hours, and a session held in a loop burns its turn budget for nothing. Ask again later, or bind again |
| `stop` | the session may stop, with the stop reason (and who stopped it, and why) shown; the binding is removed |

The hook never changes `run continue`: it states no outcome and lets the
tracker read it off the attempt or the status, exactly as a driver loop does.

**It never traps anyone.** Every CLI with an adapter has a loop signal (this
stop follows a continuation a hook caused; Cursor's is `loop_count` above 0). While it is set, the same reminder
(the same kind, the same ticket) is given at most `--max-repeats` times in a
row (2), and at most `--max-blocks` continuations are asked for in a row (20),
whatever each was for (a ticket flipped between in progress and review changes
the reminder, not the count); past either the session may stop with a message
and the run is left as it is. The continuation guard is also read before
`continue`, so a take the session would not be given the turn for is never
claimed. For Cursor, whose own `loop_limit` the stanza lifts, it is the only
cap. A fresh prompt from the person
resets both. Each CLI has its own cap too (Claude Code: 8 continuations in a
row unless `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` says otherwise): a run of more
tickets than that per prompt pauses at the cap until the person says "carry
on". A person ends the run at any time with `staple run stop` (or the UI's
Stop): the next stop lets the session stop. Interrupting Claude Code runs no Stop
hook at all ("does not run if the stoppage occurred due to a user interrupt"). And the hook command **always exits 0**: an error
of any kind is an allow with the error as the message, never the exit 2 that
most of these CLIs treat as a block whatever the output says.

**Install.** `install <provider>` prints the stanza (the default, and what to
use on a machine you care about) or, with `--user`, `--project` or `--local`
(Claude Code only), adds it to that settings file, every other member kept, a
copy of the old file under `<staple home>/backups/hooks/` first. A file that is
not a JSON object, or whose hooks member is not the shape the CLI documents (an
object holding an array per event), is refused and left untouched. Installing
twice changes nothing: an entry whose command is exactly the one being
installed, or any staple followed by exactly `run hook <provider>-stop`, is
staple's; `run hook claude-stop-old` is not. `--staple` names the staple command the hook runs (`staple` on the
CLI's PATH by default). Codex and Gemini CLI run a new or changed hook only
after it is trusted (Codex: `/hooks`).

### Which CLIs have a stop hook

Surveyed 2026-09-28 from each CLI's own documentation. "Yes" means a
documented hook that runs when the agent ends its turn and can keep it going
with a prompt of the hook's choosing.

| CLI | Hook | Can keep the turn going | Adapter | Evidence |
|---|---|---|---|---|
| Claude Code | `Stop` | Yes: `{"decision":"block","reason":…}`; loop signal `stop_hook_active`; cap 8 | `claude-stop` | [hooks](https://code.claude.com/docs/en/hooks#stop): "`"block"` prevents Claude from stopping"; "`stop_hook_active` … is `true` when Claude Code is already continuing as a result of a stop hook"; "after stop hooks have continued the turn eight times in a row, Claude Code overrides the next block" |
| Codex CLI | `Stop` | Yes: same answer; `stop_hook_active`; hooks must be trusted | `codex-stop` | [hooks](https://developers.openai.com/codex/hooks): "To keep Codex going, return … `"decision": "block"`"; "`decision: "block"` … automatically creates a new continuation prompt that acts as a new user prompt, using your `reason`"; "`stop_hook_active` … Whether this turn was already continued by `Stop`" |
| Gemini CLI | `AfterAgent` | Yes: `{"decision":"deny","reason":…}`; `stop_hook_active` | `gemini-stop` | [hooks reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md): "`decision`: Set to `"deny"` to reject the response and force a retry"; "`reason` … This text is sent to the agent as a new prompt"; "`stop_hook_active` … already running as part of a retry sequence" |
| Cursor (editor and CLI) | `stop` | Yes: `{"followup_message":…}`; `loop_count`; `loop_limit` (default 5, lifted by the stanza) | `cursor-stop` | [hooks](https://cursor.com/docs/hooks): "`followup_message` … Cursor will automatically submit it as the next user message"; "`loop_count` … how many times the stop hook has already triggered an automatic follow-up for this conversation"; [CLI changelog](https://cursor.com/docs/cli/changelog): "stop hooks with follow-up loops" |
| GitHub Copilot CLI | `agentStop` | Yes: `{"decision":"block","reason":…}` (exit 2 does not block); `stop_hook_active`; cap 8 | `copilot-stop` | [hooks configuration](https://docs.github.com/en/copilot/reference/hooks-configuration): "`agentStop` … Yes — can block and force continuation"; "`"block"` forces another agent turn using `reason` as the prompt" |
| Factory Droid | `Stop` | Yes: Claude Code's answer; `stop_hook_active` | `droid-stop` | [hooks reference](https://docs.factory.ai/reference/hooks-reference): "`decision: "block"` prevents stopping. Include `reason` so Droid knows what to do next" |
| Qwen Code | `Stop` | Yes: Claude Code's answer; `stop_hook_active`; cap 8 | `qwen-stop` | [hooks](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md): Stop `{"decision": "block", "reason": …}`; "ends the turn after `stopHookBlockingCap` blocks (default 8)" |
| Kiro | Agent Stop | Contradictory: [hook types](https://kiro.dev/docs/hooks/types) says "`"decision": "block"`, the `reason` is sent as a new user message"; [hooks](https://kiro.dev/docs/hooks) lists Agent Stop as "Can block? No"; no loop signal documented | none | tier A or C until the docs agree |
| Amp | `agent.end` (TypeScript plugin) | Yes, but in-process: `{ action: 'continue', userMessage }`, no command hook | none | [plugins](https://ampcode.com/docs/markdown/customize/plugins): "`agent.end` fires when the agent finishes a turn. Return `continue` to append a follow-up user message and start another turn". A plugin could call `staple run continue`; tier A (`--agent custom`) or C |
| OpenCode | `session.idle` plugin event | No: the event handler returns nothing; a plugin can only send a prompt of its own | none | [plugins](https://opencode.ai/docs/plugins): `session.idle` under Session Events; tier A or C |
| Cline | `TaskComplete` | No: the extension's is "TaskComplete Hook (coming soon!)"; the SDK maps it to `afterRun`, which wraps a run and does not continue it | none | [extension hooks](https://github.com/cline/cline/blob/main/.clinerules/hooks/README.md), [SDK hooks](https://github.com/cline/cline/blob/main/sdk/examples/hooks/README.md): "`TaskComplete` \| `agent_end` \| `afterRun` when completed"; tier A or C |
| Aider | `--notifications-command` | No: a notification, no payload, cannot block | none | [options](https://aider.chat/docs/config/options.html): "Specify a command to run for notifications instead of the terminal bell"; tier A or C |
| Windsurf (Cascade) | `post_cascade_response` | No: "Post-hooks cannot block since the action has already occurred" | none | [Cascade hooks](https://docs.devin.ai/desktop/cascade/hooks); tier C |

Cursor and Copilot CLI also read Claude Code's settings files; a Claude Code
hook they run gets their own payload and session ids, finds no binding, and
does nothing.

### Tier C: the instructions

With no driver and no hook, the agent is the loop: `.staple/AGENTS.md`
("Autopilot runs", written by `staple init`) tells it to call
`staple run continue --json` after every ticket it hands on and do what the
answer says: `take` is already checked out, `wait` takes nothing, `stop` ends
the loop. The same rules hold in every tier: finish (or state the failure)
before asking, an adversarial review recorded as `review: …` before handing
on, never merge to master or main, and stop means stop.

## Goal mode

A run over a milestone is a **goal run**: the milestone's own acceptance
criteria ([milestones.md](milestones.md#goal)) are what it works toward, and the
milestone is the goal, not a separate document. Code: `src/core/milestone-goal.ts`
(the pure rules), `run-store.ts` (the run's half), `milestone-store.ts` (marks).

```
staple milestone new "October" -d "What it is for" --criteria "Docs written;Tests pass"
staple run start --scope ABC-40 [--gate-owner VP] [--goal-cap 5]
staple milestone criterion ABC-40 1 --met --evidence ABC-41
staple milestone criterion ABC-40 2 --unmet --evidence "no tests" --follow-up "Write the tests"
```

**Start.** `--gate-owner` names the person the milestone is gated to; without
it, `VP` (`DEFAULT_GATE_OWNER`), whoever the milestone's assignee is: the
assignee owns the plan, and the reviewer of a goal is one fixed person unless a
run says otherwise. `--goal-cap N` (default 5, 0 allowed) caps the tickets the run
may create itself. Both are refused on any other scope.

**The gate is opened at the start.** A milestone closes itself when its last
member lands, as a parent does, unless a gate is open on it. So the run gates the
milestone to its owner as it starts, with a comment saying why. That is the only
design that holds whoever lands the last member: another agent, a person, or a
device that syncs the landing in. The gate replicates; a run-local rule would not.

It is a **goal-run gate**: its `gate_requested_by` is `goal-run:<actor>`
(`isGoalRunGate`, `milestones.ts`). That column travels with the gate, so every
run on every device recognises it, and it changes three things, only for such a
gate:

- it holds the milestone's **close** and nothing else: it queues none of the
  milestone's work, members (which no gate holds) or issues parented under it
  (which a person's gate holds), so the run keeps taking them;
- it is **not a `gate_pending` stop** for a goal run over that milestone, whichever
  run opened it: two goal runs over one milestone, on one machine or two, share
  it. `goal.gate.byGoalRun` says it is a run's, `ownedByRun` that this run opened
  it;
- it may stand on a milestone that holds **nothing yet**, so a member a person adds
  later cannot land and close it unreviewed.

A gate a person opened (before the run, or after answering the run's) is an
ordinary gate: it holds the milestone's parented children and it stops the run
`gate_pending`, pending or with changes requested. A person may gate over the
run's pending gate: theirs replaces it (and the run never gates over a pending
gate), so their review wins. Only the run path writes the marker: an actor named
`goal-run:…` is refused on the CLI (`$STAPLE_AGENT`, `--actor`, `--agent`,
`--author`, and the `$USER` fallback when none of those is given), over
MCP, over HTTP (every `actor` field and query parameter) and by the store's gate
itself, and the marker
exempts only a milestone's gate, whatever road it arrived by.

The run keeps a gate open from then on, on **every `continue`** (idempotent), before
it adds a member, and at `goal_met`:

- a pending gate, the run's or anybody's, is left alone;
- an approved gate is history: the run gates again, since whatever lands next
  was not in the review;
- a person's `changes_requested` also holds the close, so it is left standing
  while the run works; at `goal_met` the run gates again, which answers it the
  way re-gating always does: the work goes back for a second read.

A milestone a person resolved while the run worked is their decision: the run
ends `scope_empty`.

**The goal check.** When the scope empties (where a run over an epic would end
`scope_empty`):

1. every criterion met: stop `goal_met` (ends `completed`), the milestone left
   gated to its owner, never closed;
2. else, with room under the cap: the run creates a **goal-check ticket**
   (`Goal check: <milestone title>`, label `goal-check`), makes it a member and
   takes it. `run status` shows this as `{stop: false, goalCheck}`;
3. else: stop `budget`, `detail.budget` `goal_children`, the milestone gated.

Finishing takes no ticket: a goal met with the scope empty ends `goal_met` even
when `--max-tickets` is spent. A goal-check ticket is a new ticket, though: at
the ticket budget the run stops `budget` before creating one.

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
  "pace": { … },                                   // milestones.md, "Goal"
  "children": { "cap": 5, "created": 1, "left": 4, "refs": ["ABC-44"] },
  "gate": { "state": "pending", "owner": "VP", "requestedAt": "…", "requestedBy": "goal-run:bot",
            "byGoalRun": true, "ownedByRun": true } }
```

`run.goal` is `{gateOwner, childCap, children: [{identifier, title, status,
purpose}], gatedAt}` on a goal run and `null` otherwise.

**`run drive`.** A goal run's brief gains a goal section: the criteria as the
check reads them and the verb to mark one, with "mark only what your work
shows". A goal-check ticket's brief says it is the goal check: judge each
criterion against the evidence, file follow-ups for the unmet ones (and how many
are left), change no code, and close it with `staple done` whatever `--finish`
says. The review rule applies to it like any ticket: the session reviews its own
verdicts adversarially (a `met` the evidence does not show, a follow-up that
would not meet its criterion) and records a `review: …` comment, or the driver
fails it `no_review`. A verdict is the one thing a goal check produces, so it is
the thing a review is for; exempting it would let an unreviewed `met` end the run.

**With the other rules.** The goal check sits where `scope_empty` would, so
everything before it still wins: a budget, a failure streak, `scope_gone` (a
deleted or re-kinded milestone: the run then has no goal and `goal` is null), a
person's block or gate. Under `queue.policy = strict` a goal-check ticket is an
ordinary unqueued row in the scope: a take the plan refuses answers `wait
out_of_order` and leaves the ticket created, in scope and counted once; the next
`continue` offers it again rather than creating another. When `continue` settles
the last ticket of an ended goal run (no live run), it answers that run's stop
reason with its `goal`.

**What replicates.** The goal itself (description, criteria), every criterion's
mark, the evidence, the tickets the run creates and the gate all replicate; the
run itself stays machine-local. A mark travels as the milestone field
`criterion<n>` ([sync](sync.md#what-synchronizes)): two devices judging
different criteria never meet, and two judging the same one at once are a
preserved field conflict, settled by a decision like any other.

## Events

`run_started`, `run_stopped` (with `reason`, `detail`, `by`), `run_state_changed`
(pause and resume), `run_ticket_taken` and `run_ticket_recorded`, all in
`staple events --follow`. A goal run adds `run_goal_gated` (the run opened a gate
on its milestone) and `run_goal_child_created`, and a mark writes
`milestone_criterion_marked`; none names an issue, like the run events. A take also writes the ordinary `checkout` event on
the ticket, and a stated failure on a held ticket its `release`.

## In the web UI

The page watches and stops runs; it never starts or continues one.

- **Banner.** Each live run is a card in the rail's **Autopilot** section:
  `Autopilot · <scope> · <n> done this run · <m> left · working|next <ref> · <what would stop it>` (n: tickets this run handed on; m: unresolved work in scope, whoever works it; a milestone's own progress is its detail's), the run's
  state (working, paused, or what it waits on), whether a driver is attached, **Stop** and
  **Details**. On a phone (below 768px) the first live run is also one line above the tab
  bar with a 44px Stop. The section is absent until the workspace has had a run.
- **Badge.** A task a live run holds as its open ticket wears an **Autopilot** badge in the
  list and a line in its detail naming the run.
- **Run history.** The section's **Run history** row (and every Details) opens every run:
  who ran it, over what, started, how long, each ticket with how it went, and how it ended,
  in plain words (`src/ui/app/src/lib/run-text.ts` words every stop and wait reason).
- **Run stopped.** When a run ends, every open page shows a notice within one refresh: why, in
  the history's words, and a link to the reference that needs a person (`goal_met` and a
  `goal_children` budget: the milestone to review; `gate_pending`: the gated issue;
  `vp_blocked`: the blocked ticket; `failure_streak`: the last ticket that failed;
  `touched_main_line`: the ticket whose session moved the main line; otherwise the scope).
  One notice per stop: they are derived from `/api/runs` minus the runs this browser has
  dismissed, opened or stopped itself (localStorage `staple:run-stops:v1`), counted from the
  browser's first read of the server's clock (`now`), so a reload shows the same notices and
  an old stop is not news; keys of runs no longer served are pruned. One compact card shows
  the newest ("N more" expands to three): in the desk's corner, in the flow above the run
  strip on a phone, and, while a task is open, as the detail's last row (inside the modal, so
  it covers nothing and is in the focus order). The app has no service worker, so there is
  no system notification (`src/ui/app/src/lib/run-stops.ts`).
- **Goal view.** A milestone's detail shows its goal in place of "Done when": each criterion
  with the check's verdict, its evidence as links (a ticket opens it, `ABC-12:plan` opens that
  document), who marked it and when, and why an unknown one is unknown (not marked, reworded,
  evidence not done); the pace verdict with its numbers; the gate (whose approval, and whether
  a goal run or a person asked for it); the goal run working it. A ticket a run created
  (`originKind` `run`) says "Created by autopilot" in the member list
  (`src/ui/app/src/lib/goal-text.ts`).
- **Stop** asks first and takes an optional note; the run records `stopped_by_human` with
  the page's person as `by`: the name the task detail remembers (`staple:me`), or the
  one *My tasks* remembers (`staple:me:v1`) when the detail has none or *My tasks* has
  changed since the detail saved its name; with neither, `ui`. Pause and Resume are in the history.

HTTP: `GET /api/runs[?ws=&limit=N]` answers `{runs: [{workspace, run, decision, facts,
driver, goal}], now}` (`now`: the server's clock) (every live run and the `limit` (50) most recent ended ones per workspace, each
the `run status --json` object); `POST /api/run/stop {ws, id, actor?, note?}`,
`POST /api/run/pause|resume {ws, id, actor?}` answer the run's fresh entry. They are
writes like every other (POST only, token, the write rule in [web-ui.md](../docs/web-ui.md#auth)), so
the app on a phone through the tailnet forwarder stops a run: its page sends the token
header. The change fingerprint (`/api/poll`) carries which live runs have a driver attached
and whether it is running, so the banner follows a driver starting or dying.
