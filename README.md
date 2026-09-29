# staple

**A local-first task tracker for coding agents.** Agents claim tickets, keep
their plan and worklog on the ticket, hand work off and finish it, so a killed
session is picked up where it stopped instead of starting over from a stale
`plan.md`. You follow along, set the order and approve what matters in a local
web UI.

Each repository keeps its tickets in one SQLite file, `.staple/staple.db`. No
account, no daemon, no native dependencies. Cloud sync between machines is
there when you want it and off until you turn it on.

## Quick start

Requirements: Node >= 22.5.

`staple-cli` is not on npm until its first release. Until then, build the
package from a checkout (`npm run pack:package`, see
[CONTRIBUTING.md](https://github.com/vpetkovic/staple-tracker/blob/master/CONTRIBUTING.md)) and put
`npx -y file:/absolute/path/to/checkout/dist-package/staple-cli-<version>.tgz`
wherever this page says `npx staple-cli` or `npx -y staple-cli`.

```bash
npx staple-cli                      # set this repository up, then open the web UI
```

The first run creates `.staple/staple.db` and `.staple/AGENTS.md` (the protocol
your agents follow) and opens the web UI. The one question it can ask is whether
to move a legacy `.tasks` workspace (`--yes` takes the default). Then connect
your agent harness to the MCP server:

```bash
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
codex mcp add staple --env STAPLE_AGENT=codex -- npx -y staple-cli mcp
```

To have `staple` on your `PATH` instead of fetching it each time, run
`npx staple-cli install --yes`: a versioned runtime and a launcher at
`~/.local/bin/staple`, no `sudo`, with rollback. Add `--update-path` to put
`~/.local/bin` on your `PATH` ([packaging](https://github.com/vpetkovic/staple-tracker/blob/master/design/packaging.md)).

[Getting started](https://github.com/vpetkovic/staple-tracker/blob/master/docs/getting-started.md) walks through the first workspace,
the MCP wiring and the loop your agents follow, one ticket from created to done.

## What you get

- **Claims and dependencies.** Atomic checkout, claims that go stale when an
  agent dies and can be taken over on the record, `blocks` edges that decide
  what is ready ([dependencies](https://github.com/vpetkovic/staple-tracker/blob/master/docs/epics-and-dependencies.md), [handoff](https://github.com/vpetkovic/staple-tracker/blob/master/docs/handoff.md)).
- **The pickup queue.** An ordered plan of what agents take next, advisory or
  strict, with overrides recorded ([queue](https://github.com/vpetkovic/staple-tracker/blob/master/docs/queue.md)).
- **Approval gates.** Park a parent on a person; its subtree waits until they
  approve or request changes ([gates](https://github.com/vpetkovic/staple-tracker/blob/master/docs/approval-gates.md)).
- **Milestones and goal mode.** Dated plans over epics and tasks with derived
  progress, a pace verdict and acceptance criteria judged with evidence
  ([milestones](https://github.com/vpetkovic/staple-tracker/blob/master/docs/milestones.md)).
- **Autopilot runs.** One agent works a scope ticket after ticket within a
  budget, and the tracker decides when it stops ([runs](https://github.com/vpetkovic/staple-tracker/blob/master/docs/runs.md)).
- **Cloud sync.** Optional: two machines share one workspace through a
  Cloudflare Worker you deploy, with conflicts kept, never guessed
  ([cloud sync](https://github.com/vpetkovic/staple-tracker/blob/master/docs/cloud-sync.md)).
- **Web UI.** Tasks, queue, dependency graph, milestones, estimates, usage,
  task detail, autopilot runs and settings, on localhost ([web UI](https://github.com/vpetkovic/staple-tracker/blob/master/docs/web-ui.md)).
- **Budget and estimates.** Estimates against measured agent work, calibrated
  forecasts, and the Claude and Codex rate-limit windows the work will cost
  ([timing](https://github.com/vpetkovic/staple-tracker/blob/master/docs/budget-and-estimates.md), [provider budget](https://github.com/vpetkovic/staple-tracker/blob/master/docs/cli.md#provider-budget)).
- **The hub.** Every workspace on the machine registers in one hub, with unique
  prefixes, cross-repository `blocks` links and a hub-wide inbox
  ([several repositories](https://github.com/vpetkovic/staple-tracker/blob/master/docs/hub.md)).

## Everyday commands

```bash
staple inbox                                # what is ready, in pickup order
staple new "Port the claim guard" -p high   # file it
staple checkout STA-42 --agent claude       # claim it, atomically
staple doc STA-42 plan --put plan.md        # the plan lives on the ticket
staple comment STA-42 "guard ported, tests green"
staple done STA-42                          # finish it; the inbox shows what it unblocked

staple open                                 # the web UI; Ctrl-C stops it
staple queue add STA-42 --at 1              # say what gets picked up next
staple checkout STA-42 --steal-if-stale 1h  # take over a dead agent's claim
```

`staple help` lists every command; [docs/cli.md](https://github.com/vpetkovic/staple-tracker/blob/master/docs/cli.md) documents them.

## Autopilot

A **run** is one agent working a scope (the pickup queue, an epic or a
milestone) ticket after ticket, within a budget: a ticket count, an end time, a
rate-limit ceiling. After every ticket the agent asks `staple run continue` and
does what it answers: `take` (the next ticket, already claimed), `wait` or
`stop`. The tracker decides, never the prompt.

```bash
staple run start --scope queue --max-tickets 5 --until 4h
staple run drive --scope STA-40 --agent claude    # a fresh headless session per ticket
staple run status                                 # your live run, and what would stop it now
staple run stop -m "enough for today"
```

Three ways to drive one:

- **`run drive`** starts a fresh Claude Code, Codex or custom session per
  ticket with the ticket's brief, under the provider's own permissions.
- **Stop hooks** keep a session you are already in working the run: Claude
  Code, Codex, Gemini CLI, Cursor, Copilot CLI, Factory Droid and Qwen Code
  (`staple run hook install claude --user` once, then `staple run hook bind`;
  the hook runs `staple` from your `PATH` unless `--staple CMD` says otherwise).
- **Instructions only:** any agent that can run a shell follows
  `.staple/AGENTS.md`.

A run over a milestone is a **goal run**: the milestone's criteria are its
definition of done, it gates the milestone to a reviewer (`--gate-owner`) so it
never closes unreviewed, and it can file follow-up tickets for unmet criteria.

Autopilot never merges. `run drive` leaves each ticket's work on its own
branch, fails a session that moves `master` or `main`, and requires a
`review: …` comment on every ticket. The web UI watches runs and stops them; it
never starts one.

The `run continue` contract, stop rules and reason codes, the drive brief,
every supported hook and goal mode in full: [design/runs.md](https://github.com/vpetkovic/staple-tracker/blob/master/design/runs.md); the guide is [docs/runs.md](https://github.com/vpetkovic/staple-tracker/blob/master/docs/runs.md).

## Documentation

[docs/](https://github.com/vpetkovic/staple-tracker/blob/master/docs/README.md) is the reference: every page, grouped by what you want
to do.

## Contributing

Running from a checkout, building the UI and the package, and the test gates
are in [CONTRIBUTING.md](https://github.com/vpetkovic/staple-tracker/blob/master/CONTRIBUTING.md).

## License

MIT. See [LICENSE](https://github.com/vpetkovic/staple-tracker/blob/master/LICENSE).
