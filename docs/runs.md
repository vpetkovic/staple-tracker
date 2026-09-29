---
title: Autopilot runs
description: Let one agent work an epic, a milestone or the whole queue ticket after ticket, watch it, pause or stop it, and know why it stopped.
---

# Autopilot runs

Use a run to let an agent keep going without you: every ticket in an epic, a milestone
or the whole queue, one after another, until the work is done, a budget runs out, or
something needs you. After each ticket, staple decides whether the run goes on, not
the prompt. A run never merges: it leaves branches and draft pull requests for you.

The examples use the audit log epic, APP-7: APP-8, and APP-9, which waits on it.

## 1. Start a run

```bash
staple run start --scope APP-7 --max-tickets 5 --until 4h    # MCP start_run
```

`--scope` is an epic (or any ticket with children), a milestone, or `queue` for the
whole [pickup queue](queue.md). The run takes tickets in queue order. The budget is
optional: `--max-tickets`, `--until` (`90m`, `4h`, or a date and time), and
`--ceiling 80` to stop once your provider's usage limit is 80% used.

## 2. Choose how it is driven

Something has to open a session for each ticket. Pick one:

| Way | Use it when | How |
|---|---|---|
| **`run drive`** | You want it unattended. Each ticket gets a fresh headless session and a clean context | `staple run drive --scope APP-7 --agent claude` (or `codex`, or `custom --command "…"`); it starts the run too |
| **Stop hook** | You are in a Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI, Droid or Qwen Code session and want it to carry on there | Once: `staple run hook install claude --print`, paste into your settings. Then `run start`, and `staple run hook bind` in the session |
| **Instructions only** | Your agent has neither | `run start`, then tell the agent: "after each ticket, call `staple run continue` and do what it says" |

`run drive` prints each step:

```text
take     APP-8 Record sign-ins
ended    APP-8 exited 0 after 1s -> the tracker reads the outcome
recorded APP-8 done
wait     waiting_on_others: Nothing in scope is workable for this run now; APP-8 (unavailable), APP-9 (blocked) still open. (again in 60s)
```

Sessions finish by moving their ticket to `in_review`, and review counts as open work.
Here APP-9 waits on APP-8, so the run waits for your review. Close reviewed tickets as
the run goes, or pass `--finish done` to let sessions close their own.

Each session is told to work on its own branch, keep a plan and worklog on the ticket,
run the repository's checks, and record an adversarial review before handing on.
`--instructions <file>` adds your repository's rules. Sessions get the permissions your
Claude Code or Codex setup allows, no more. `--dry-run` prints the next ticket, the
command and the brief, and starts nothing.

## 3. Watch it

```bash
staple run status          # MCP run_status
```

```text
run ebfaa715-…  active  claude over milestone APP-11
  started 2026-09-29T14:24:40.957Z · 1/5 tickets, until 2026-09-29T18:24:40.957Z · 0 done, 0 failed, 1 open
    1  APP-10    open
```

In the web UI, each live run is a card in the sidebar's **Autopilot** section with
what it is working on, what is left, and **Stop**. The ticket it holds wears an
*Autopilot* badge. **Run history** shows every run and ticket, with Pause and Resume.
When a run stops, open pages say why and link to what needs you.

## 4. Pause, resume or stop

```bash
staple run pause                             # MCP pause_run
staple run resume                            # MCP resume_run
staple run stop -m "Reviewing APP-8 first"   # MCP stop_run, or Stop in the web UI
```

**Pause** lets the current session finish and takes nothing new until you resume.
**Stop** ends the run now: the session is ended within seconds and its ticket goes back
to the queue with your note. A stopped run stays stopped; start a new one to carry on.

## 5. Why it stopped

| Reason | Meaning |
|---|---|
| `scope_empty` | Everything in scope is done or cancelled |
| `budget` | It reached `--max-tickets`, `--until` or `--ceiling` |
| `failure_streak` | Two tickets in a row failed; read their comments and logs |
| `gate_pending` | What is left waits on an [approval gate](approval-gates.md) |
| `vp_blocked` | A ticket is blocked on a person |
| `touched_main_line` | A session moved `master` or `main` |
| `goal_met` | A goal run's criteria are all met (below) |

Work only others can move (a review, another agent's claim, a dependency) makes the
run wait, not stop.

## Goal runs over a milestone

A run over a [milestone](milestones.md) works toward its goal criteria:

```bash
staple run start --scope APP-11 --gate-owner VP --goal-cap 5
```

1. It [gates](approval-gates.md) the milestone to `--gate-owner`, so the milestone
   cannot close without that person's sign-off.
2. It works the milestone's tickets like any run.
3. When they are done and every criterion is marked met, it stops `goal_met`, with the
   milestone waiting for approval.
4. Otherwise it files a *Goal check* ticket. That session judges each criterion
   against the evidence, marks it, and files follow-up tickets for the unmet ones,
   which the run then works. `--goal-cap` limits the tickets it may file (5); at the
   cap it stops `budget` for you to decide.

## A run never merges

Each ticket's work stays on its own branch (`autopilot/app-8`), with a draft pull
request when there is a remote. Sessions are told never to merge or push to `master`
or `main`, and `run drive` checks: if either moves, the run stops with
`touched_main_line`. Landing the work is your call.

Runs stay on the machine that started them. The tickets, comments and statuses they
produce sync like any other.

## Next

- [How an agent works a ticket](working-a-ticket.md): what each session does.
- [Milestones and goals](milestones.md): write the criteria a goal run works toward.
- [Handoff and resume](handoff.md): when a session dies mid-ticket.
