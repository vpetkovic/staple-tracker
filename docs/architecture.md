# Architecture

## Where the code lives

| Piece | File | What it does |
|---|---|---|
| Core store | `src/core/store.ts` | Issues, guards, claims, dependencies — see [semantics.md](semantics.md) |
| Hub | `src/core/hub.ts` | Workspace registry, unique prefixes, cross-workspace links, holistic views |
| Agent guide | `src/core/agents-template.ts` | The working protocol `init` writes to `.staple/AGENTS.md` |
| MCP server | `src/mcp.ts` | 20 stdio tools — the whole agent surface |
| CLI | `src/cli.ts` | Human/CI mirror of the tools |
| Web UI server | `src/ui/server.ts` | `staple open`: token-gated JSON API + serves the built app; per-workspace or `--hub` |
| Web UI app | `src/ui/app/` | Vite + React + shadcn/ui (new-york) — inbox, board, tree, dependency graph, detail panel |
| Tests | `test/` | Guard/claim/dependency/document semantics, CLI JSON, wait/follow, UI auth, and the takeover drill |
| Smoke | `scripts/smoke-mcp.ts` | Full JSON-RPC agent workflow over stdio |

## Workspace topology

A workspace is one SQLite file: `.staple/staple.db` in a repository (found by
walk-up), or `~/.staple/workspaces/<slug>.db` for global ones.

Every workspace registers in `~/.staple/hub.db` and gets a unique identifier
prefix (`STA-1`, `WOR-3`), so identifiers are unambiguous cross-repository
references. Cross-workspace `blocks` edges live in the hub; a blocker whose file
is not on this machine reports *unresolvable → treat as blocked*.

`STAPLE_HOME` relocates the hub — see [configuration.md](configuration.md) for
the full resolution order.

Walk-up prefers `.staple/staple.db` and still finds a legacy `.tasks/tasks.db`
during the compatibility window. Both checks happen **per directory** before
moving up, so a migrated repository nested inside an unmigrated one resolves to
itself. A directory holding two different canonical databases is refused, not
guessed at — see [migration.md](migration.md).

## Known limits

Honest gaps, so nobody discovers them the hard way:

- Plain SQL behind one storage module rather than a query builder. A
  dialect-neutral core would formalize this.
- Labels are a JSON column and search is `LIKE`; FTS5 is available when the
  data justifies it.
- Holistic reads open one connection per workspace file. An `ATTACH` union is
  the optimization when that starts to hurt.
- No sync engine yet. GitHub Issues and ClickUp connectors are planned, not
  built.
- Combined local + cross-workspace dependency cycles spanning three files are
  not detected — each layer guards its own edges.
- Node's `node:sqlite` prints an experimental warning on 22.x; it is stable in
  24.
