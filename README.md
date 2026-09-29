# staple

**A local-first task tracker for coding agents: the execution layer next to your team's board.**

Markdown plans point at each other, drift, and die with the session that held them.
staple turns a plan into an epic and tickets that carry the whole context: agents know
what comes next, a new session resumes where a dead one stopped, and new work lands
under the same epic. Local-first, one file per repository, next to Linear, GitHub or
ClickUp (integrations planned). [Why staple](https://github.com/vpetkovic/staple-tracker/blob/master/docs/why-staple.md) tells the whole story.

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

The first run sets the repository up in a `.staple/` folder, writes
`.staple/AGENTS.md` (the protocol your agents follow) and opens the web UI. Then
connect your agent harness to the MCP server:

```bash
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
codex mcp add staple --env STAPLE_AGENT=codex -- npx -y staple-cli mcp
```

To have `staple` on your `PATH` instead of fetching it each time, run
`npx staple-cli install --yes`: a versioned runtime and a launcher at
`~/.local/bin/staple`, no `sudo`, with rollback. Add `--update-path` to put
`~/.local/bin` on your `PATH`.

[Install and first workspace](https://github.com/vpetkovic/staple-tracker/blob/master/docs/getting-started.md) walks through the
first workspace, [Connect your agent](https://github.com/vpetkovic/staple-tracker/blob/master/docs/connect-your-agent.md) covers other
MCP clients, and [How an agent works a ticket](https://github.com/vpetkovic/staple-tracker/blob/master/docs/working-a-ticket.md) is the
loop your agents follow.

## What you get

- **Plans become tickets.** An epic per feature, a ticket per step, dependencies
  that decide what is ready, and the plan stored on the epic
  ([plans become tickets](https://github.com/vpetkovic/staple-tracker/blob/master/docs/plans-to-tickets.md),
  [epics and dependencies](https://github.com/vpetkovic/staple-tracker/blob/master/docs/epics-and-dependencies.md)).
- **Handoff and resume.** Atomic claims, a worklog after each step, and a
  deliberate, logged takeover when a session dies
  ([how an agent works a ticket](https://github.com/vpetkovic/staple-tracker/blob/master/docs/working-a-ticket.md),
  [handoff and resume](https://github.com/vpetkovic/staple-tracker/blob/master/docs/handoff.md)).
- **A person in the loop.** The pickup queue sets the order agents take work in,
  and approval gates make work wait for your sign-off
  ([pickup queue](https://github.com/vpetkovic/staple-tracker/blob/master/docs/queue.md), [approval gates](https://github.com/vpetkovic/staple-tracker/blob/master/docs/approval-gates.md)).
- **Milestones and autopilot runs.** A date and a definition of done over a set of
  epics, and one agent working a scope ticket after ticket within a budget
  ([milestones](https://github.com/vpetkovic/staple-tracker/blob/master/docs/milestones.md), [autopilot runs](https://github.com/vpetkovic/staple-tracker/blob/master/docs/runs.md)).
- **Web UI.** Tasks, queue, dependency graph, milestones, estimates and usage, on
  localhost ([web UI tour](https://github.com/vpetkovic/staple-tracker/blob/master/docs/web-ui.md),
  [budget and estimates](https://github.com/vpetkovic/staple-tracker/blob/master/docs/budget-and-estimates.md)).
- **Across machines and repositories.** Optional cloud sync between two machines,
  and one hub over every repository on this one
  ([cloud sync](https://github.com/vpetkovic/staple-tracker/blob/master/docs/cloud-sync.md), [several repositories](https://github.com/vpetkovic/staple-tracker/blob/master/docs/hub.md)).

## Everyday commands

```bash
staple inbox                                # what is ready, in pickup order
staple new "Add a health check endpoint"    # file it
staple start APP-1 --agent claude           # claim it, atomically
staple doc APP-1 plan --put plan.md         # the plan lives on the ticket
staple comment APP-1 "route added, tests next"
staple done APP-1                           # finish it; the inbox shows what it unblocked

staple open                                 # the web UI; Ctrl-C stops it
staple queue add APP-2 --at 1               # say what gets picked up next
staple start APP-2 --steal-if-stale 1h      # take over a dead agent's claim
```

`staple help` lists every command; the [CLI reference](https://github.com/vpetkovic/staple-tracker/blob/master/docs/cli.md) documents them.

## Autopilot

A **run** is one agent working a scope (the pickup queue, an epic or a milestone)
ticket after ticket, within a budget: a ticket count, an end time, a rate-limit
ceiling. After every ticket the agent asks `staple run continue`, and the tracker
answers `take`, `wait` or `stop`. Autopilot never merges: each ticket's work stays on
its own branch for a person to review.

```bash
staple run start --scope queue --max-tickets 5 --until 4h
staple run drive --agent claude                   # drive it: a fresh headless session per ticket
staple run status                                 # your live run, and what would stop it now
staple run stop -m "enough for today"
```

[Autopilot runs](https://github.com/vpetkovic/staple-tracker/blob/master/docs/runs.md) covers the ways to drive a run and goal runs over
a milestone.

## Documentation

The [documentation](https://github.com/vpetkovic/staple-tracker/blob/master/docs/README.md) is grouped by what you want to do:

- **Start here:** [Why staple](https://github.com/vpetkovic/staple-tracker/blob/master/docs/why-staple.md),
  [Install and first workspace](https://github.com/vpetkovic/staple-tracker/blob/master/docs/getting-started.md),
  [Connect your agent](https://github.com/vpetkovic/staple-tracker/blob/master/docs/connect-your-agent.md)
- **Working with agents:** [How an agent works a ticket](https://github.com/vpetkovic/staple-tracker/blob/master/docs/working-a-ticket.md),
  [Plans become tickets](https://github.com/vpetkovic/staple-tracker/blob/master/docs/plans-to-tickets.md),
  [Handoff and resume](https://github.com/vpetkovic/staple-tracker/blob/master/docs/handoff.md)
- **Planning:** [Epics and dependencies](https://github.com/vpetkovic/staple-tracker/blob/master/docs/epics-and-dependencies.md),
  [Approval gates](https://github.com/vpetkovic/staple-tracker/blob/master/docs/approval-gates.md), [The pickup queue](https://github.com/vpetkovic/staple-tracker/blob/master/docs/queue.md),
  [Milestones and goals](https://github.com/vpetkovic/staple-tracker/blob/master/docs/milestones.md), [Autopilot runs](https://github.com/vpetkovic/staple-tracker/blob/master/docs/runs.md)
- **Across machines and repositories:** [Cloud sync](https://github.com/vpetkovic/staple-tracker/blob/master/docs/cloud-sync.md),
  [Several repositories](https://github.com/vpetkovic/staple-tracker/blob/master/docs/hub.md)
- **The web UI:** [Tour](https://github.com/vpetkovic/staple-tracker/blob/master/docs/web-ui.md),
  [Budget and estimates](https://github.com/vpetkovic/staple-tracker/blob/master/docs/budget-and-estimates.md)
- **Reference:** [CLI](https://github.com/vpetkovic/staple-tracker/blob/master/docs/cli.md), [MCP tools](https://github.com/vpetkovic/staple-tracker/blob/master/docs/mcp-tools.md),
  [Configuration](https://github.com/vpetkovic/staple-tracker/blob/master/docs/configuration.md), [Errors and exit codes](https://github.com/vpetkovic/staple-tracker/blob/master/docs/errors.md)

The design documents behind the code live in
[design/](https://github.com/vpetkovic/staple-tracker/tree/master/design).

## Contributing

Running from a checkout, building the UI and the package, and the test gates
are in [CONTRIBUTING.md](https://github.com/vpetkovic/staple-tracker/blob/master/CONTRIBUTING.md).

## License

MIT. See [LICENSE](https://github.com/vpetkovic/staple-tracker/blob/master/LICENSE).
