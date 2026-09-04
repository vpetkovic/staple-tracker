# staple documentation

Reference material, parked here until the docs site lands. Unpolished on
purpose — the content is accurate, the prose is not finished.

| Page | What it covers |
|---|---|
| [semantics.md](semantics.md) | Statuses and guards, atomic claims, the dependency graph, revisioned documents |
| [agents.md](agents.md) | The protocol `init` writes, the MCP tool surface, harness ergonomics |
| [continuity.md](continuity.md) | Claims, staleness, takeover, and the takeover drill |
| [queue.md](queue.md) | The pickup queue: plan vs effective order, the resolver, advisory vs strict, human override, storage — the R2 contract, not yet built |
| [milestones.md](milestones.md) | Milestones: the `milestone` kind, UTC inclusive dates, ordered membership that never re-parents, count-each-leaf-once progress, queue expansion — the R3 contract, not yet built |
| [cli.md](cli.md) | The command surface, estimates vs actuals, `--json`, exit codes |
| [web-ui.md](web-ui.md) | `staple open`, the stack, the theme, the auth model |
| [configuration.md](configuration.md) | The staple home, the bootstrap locator, `config.json` |
| [migration.md](migration.md) | Moving a legacy `.tasks` workspace, and why it is more than a rename |
| [packaging.md](packaging.md) | How `staple-cli` is built, and the user-owned runtime installer |
| [architecture.md](architecture.md) | Where the code lives, workspace topology, known limits |

Hacking on staple itself is in [CONTRIBUTING.md](../CONTRIBUTING.md);
cutting a release is in [RELEASING.md](../RELEASING.md).
