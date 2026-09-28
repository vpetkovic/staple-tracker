# staple

**A local-first task tracker for coding agents.** Tickets your agents can claim,
plan inside, hand off, and finish — instead of a `plan.md` that goes stale the
moment a session dies.

State is one copyable SQLite file per repository. No account, no cloud, no
daemon, no native dependencies.

## Start here

```bash
npx staple-cli
```

Requirements: Node >= 22.5. Nothing else.

Run that in a repository and staple sets the workspace up if it needs it — the
database at `.staple/staple.db`, the agent protocol at `.staple/AGENTS.md` —
then opens the local web UI: inbox, board, subtask tree, dependency graph, task
detail. The first run asks a couple of questions; `--yes` accepts the defaults.

Then wire your agent harness to it:

```bash
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
```

That is the whole install. One package, one executable, both surfaces: the CLI,
and the MCP stdio server under `staple mcp`.

Want `staple` on your `PATH` instead of fetching it every time?

```bash
npx staple-cli install --yes
```

Installs a versioned, user-owned runtime plus a launcher at
`~/.local/bin/staple` — no `sudo`, atomic switch, verified rollback.

## Everyday commands

The loop, end to end:

```bash
staple inbox                                # what's ready, in pickup order
staple new "Port the claim guard" -p high   # file it
staple checkout STA-42 --agent claude       # claim it, atomically
staple doc STA-42 plan --put plan.md        # the plan lives on the ticket
staple comment STA-42 "guard ported, tests green"
staple done STA-42                          # and see what it unblocked
```

Two more worth knowing on day one:

```bash
staple open                                 # the web UI, foreground, Ctrl-C to stop
staple queue add STA-42 --at 1              # say what gets picked up next, explicitly
staple checkout STA-42 --steal-if-stale 1h  # take over a dead agent's claim
```

`staple inbox`'s order is the pickup queue: a plan a human writes, with queued
epics expanding to their leaf work. `staple queue --help` explains it.

That last one is the point of the whole tool: when an agent is killed
mid-ticket, the next one reads the worklog, takes the claim, and keeps going.

`staple help` lists every command.

## Autopilot

Tell an agent to keep going and it can: a **run** is one agent working a scope
ticket after ticket — the whole pickup queue, an epic, or a milestone — within
a budget (a ticket count, an end time, a rate-limit ceiling). The tracker
decides whether the run goes on, never the prompt: after every ticket the agent
asks `staple run continue` and does what it answers — `take` (the next ticket,
already claimed for it), `wait`, or `stop`.

```bash
staple queue next --scope STA-40            # what a run over STA-40 would take next
staple run start --scope queue --max-tickets 5 --until 4h
staple run start --scope STA-40 --override -m "ship this first"   # under a strict queue
staple run status                           # your live run, and what would stop it now
staple run continue --json                  # take | wait | stop: the one question a driver asks
staple run continue --outcome failed --reason "build broke"
staple run pause                            # hold it; `run resume` lets it go on
staple run stop -m "enough for today"
```

### Starting one from an agent

Three tiers, one contract:

- **A. `run drive` — the default.** A headless driver that starts a fresh
  session per ticket (so a fresh context per ticket) with the ticket's brief,
  and records how it ended. Sessions get the provider's own permissions —
  your Claude Code settings, your Codex config — never more, unless you opt in
  to that provider's allow-everything switch with `--full-access`.

  ```bash
  staple run drive --scope STA-40 --agent claude --model sonnet --dry-run   # the command and brief; starts nothing
  staple run drive --scope STA-40 --agent codex --max-tickets 3 --until 2h
  staple run drive --run <run-id> --agent claude --finish done --full-access
  staple run drive --scope queue --agent custom --command 'my-agent --prompt-file {brief_file}'
  ```

- **B. Stop hooks, for a session you are already in.** Whenever the agent is
  about to end its turn, the hook asks the tracker and hands it the next
  ticket. Supported: Claude Code, Codex CLI, Gemini CLI, Cursor, GitHub Copilot
  CLI, Factory Droid, Qwen Code.

  ```bash
  staple run hook install claude --print      # the settings stanza; paste it once (--user writes it)
  staple run start --scope STA-40 --max-tickets 5
  staple run hook bind                        # this session now works that run; end your turn
  staple run hook unbind                      # let the session go
  ```

  The CLI runs the hook itself (`staple run hook claude-stop`, `codex-stop`,
  `gemini-stop`, `cursor-stop`, `copilot-stop`, `droid-stop`, `qwen-stop`);
  you never call it by hand.

- **C. Instructions only.** Any agent that can run a shell follows
  `.staple/AGENTS.md`: call `staple run continue --json` after every ticket and
  do what it says.

### When a run stops

First match wins, and the reason is recorded on the run:

- a person stopped it (`run stop`, or Stop in the web UI);
- a `run drive` session moved `master` or `main`;
- the budget ran out: its tickets, its time, the rate-limit ceiling, or a goal
  run's allowance of tickets it may create;
- two tickets failed in a row;
- the scope is gone (deleted, or holds nothing any more);
- a ticket, or the only work left, is blocked on a person;
- the scope, or the only work left, is awaiting someone's approval;
- a goal run's goal is met;
- nothing is left to do.

Work only other people can move — someone else's claim, a dependency, a ticket
in review — makes the run wait, not stop.

### Milestone goal mode

A run over a milestone is a **goal run**: the milestone's acceptance criteria
are its definition of done. A milestone's status is derived from its members,
like any parent's, and `staple milestone show` prints its pace — done work and
the remaining estimate against the target date: on track, behind, overdue.

```bash
staple kinds add milestone                  # once per workspace
staple milestone new "October release" -d "Autopilot ready for users" \
  --criteria "README documents it;A run drives a ticket end to end" --target 2026-10-31
staple milestone set STA-40 -d "Autopilot ready for everyone"
staple run start --scope STA-40 --gate-owner alice --goal-cap 3
staple milestone criterion STA-40 1 --met --evidence STA-41
staple milestone criterion STA-40 2 --unmet --evidence "no end-to-end run yet" \
  --follow-up "Drive one ticket end to end"
```

- The agent marks each criterion `met` or `unmet` with evidence: a ticket
  (counts while it is done), a ticket's document (`STA-41:plan`), or text. The
  tracker weighs the marks at every read; a criterion reworded since, or whose
  evidence is reopened, reads `unknown` again.
- The run gates the milestone to its owner (`--gate-owner`, default `VP`) as it
  starts, so it never closes itself unreviewed when its last member lands.
- When the work runs out short of the goal, the run creates a goal-check
  ticket to judge the criteria and file follow-ups for the unmet ones — at most
  `--goal-cap` tickets (default 5), then it stops. When every criterion is
  met it stops, leaving the milestone gated for the owner to approve.

### Watching from the web UI

The web UI watches and stops runs; it never starts one. Each live run is a
banner in the workspace rail — scope, tickets it has done and work left, what it is on, what
would stop it — with a **Stop** button. Tasks a run holds wear an
**Autopilot** badge, **Run history** lists every run with its tickets and why
it ended, and every open page shows a notice when a run stops, linking what
needs a person. A milestone's detail shows its goal: each criterion's verdict
and evidence, the pace, the gate.

Stop works from your phone too: open the UI through a tailnet forwarder and
the page sends its token header on every write. The forwarder must refuse any
`Host` but its own tailnet name, or a rebinding page could write as well (see
[the web UI's auth](https://github.com/vpetkovic/staple-tracker/blob/master/docs/web-ui.md#auth)).

### It never merges

Autopilot never merges to `master` or `main`. Each session leaves its work on
a branch, `autopilot/<ref>`, stacked on the last, with a draft pull request if
there is a remote; landing it is your call. The driver checks: a session that
moves `master` or `main` fails its ticket and stops the run. Review is
enforced too: every ticket must carry an adversarial `review: …` comment
before it is handed on, or the driver records it failed (`no_review`).

The details — the `run continue` JSON contract and reason codes, the drive
brief, every hook-capable CLI and its evidence, goal checks — are in
[`docs/runs.md`](https://github.com/vpetkovic/staple-tracker/blob/master/docs/runs.md),
[`docs/milestones.md`](https://github.com/vpetkovic/staple-tracker/blob/master/docs/milestones.md#goal)
and [`docs/queue.md`](https://github.com/vpetkovic/staple-tracker/blob/master/docs/queue.md).

## Docs

Reference material lives in
[`docs/`](https://github.com/vpetkovic/staple-tracker/tree/master/docs) —
semantics, the agent surface, continuity, configuration, packaging. A proper
docs site is coming.

## Contributing

Hacking on staple itself — running from a checkout, building the UI, the test
gates — is in
[CONTRIBUTING.md](https://github.com/vpetkovic/staple-tracker/blob/master/CONTRIBUTING.md).

## License

MIT. See `LICENSE`.
