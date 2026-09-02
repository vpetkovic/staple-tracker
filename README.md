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
staple checkout STA-42 --steal-if-stale 1h  # take over a dead agent's claim
```

That last one is the point of the whole tool: when an agent is killed
mid-ticket, the next one reads the worklog, takes the claim, and keeps going.

`staple help` lists every command.

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
