---
title: Architecture
description: Where each part of staple lives in the source tree, how workspaces and the hub fit together, and the known limits of the current build.
---

# Architecture

## Where the code lives

| Piece | File | What it does |
|---|---|---|
| CLI | `src/cli.ts`, `src/commands/` | Argument parsing and the human and CI surface; larger verbs (`queue`, `milestone`, `run`, `budget`, `cloud`, `doctor`, `add`, `discover`, …) live in `src/commands/` — see [cli.md](cli.md) |
| MCP server | `src/mcp.ts`, `src/mcp-attempts.ts`, `src/core/telemetry/mcp-tools.ts`, `src/core/telemetry/mcp-read-tools.ts` | 65 stdio tools, the agent surface; each calls the same store method the CLI does |
| Packaged entrypoint | `src/package/staple.ts` | The published `staple` binary: dispatches `mcp` to the MCP server and everything else to the CLI — see [packaging.md](packaging.md) |
| Core store | `src/core/store.ts` | Issues, statuses, kinds, guards, claims, dependencies, approval gates, comments, documents, settings — see [semantics.md](semantics.md) |
| Workspace open | `src/core/workspace.ts`, `src/core/open.ts`, `src/core/db.ts` | Walk-up resolution, the newer-schema refusal, and the snapshot taken before a schema upgrade |
| Schema migrations | `src/core/migrations/workspace/`, `src/core/migrations/hub/` | Numbered migrations (workspace 001–016, hub 001–008) and the runner that applies them on open — see [migration.md](migration.md#schema-upgrades-on-open) |
| Path migration | `src/core/path-migration.ts` | The journalled `.tasks/tasks.db` → `.staple/staple.db` move behind `staple migrate` |
| Hub | `src/core/hub.ts`, `src/core/hub-repair.ts`, `src/core/hub-follow.ts` | Workspace registry, unique prefixes, cross-workspace links, holistic views |
| Settings registry | `src/core/settings-registry.ts` | Every machine preference and workspace setting, typed once — see [configuration.md](configuration.md) |
| Pickup queue | `src/core/queue-store.ts` | The human-ordered plan and its effective order — see [queue.md](queue.md) |
| Milestones | `src/core/milestones.ts`, `src/core/milestone-store.ts`, `src/core/milestone-goal.ts` | Dated plans over epics and tasks, their goal and criteria — see [milestones.md](milestones.md) |
| Projects | `src/core/project-store.ts`, `src/core/projects.ts` | Tracked projects an issue can belong to |
| Autopilot runs | `src/core/run-store.ts`, `src/core/run-driver.ts`, `src/core/run-hook.ts` | A run over a scope, its stop rules, the headless driver and the interactive stop hooks — see [runs.md](runs.md) |
| Execution telemetry | `src/core/telemetry/` | Execution attempts, provider budget samples and limit windows, automatic collection, timing, calibration and forecasts — see [execution-telemetry.md](execution-telemetry.md) |
| Cloud sync client | `src/core/cloud/` | Connect, push and pull of operations, conflicts, leases, automatic sync, backups and the hub registry on the service — see [sync.md](sync.md) |
| Sync service | `worker/` | The Cloudflare Worker and its D1 operation log (`worker/migrations/`); a separate npm package, not part of `staple-cli` — see [worker/README.md](https://github.com/vpetkovic/staple-tracker/blob/master/worker/README.md) |
| Machine configuration | `src/config/` | Home resolution, the bootstrap locator, `config.json`, home moves |
| Installer | `src/install/` | `staple install`: versioned runtimes, the launcher, rollback, schema repair planning |
| Setup | `src/onboarding/` | The setup service `staple init` and bare `staple` share |
| Agent guide | `src/core/agents-template.ts` | The working protocol `init` writes to `.staple/AGENTS.md` |
| Web UI server | `src/ui/server.ts` | `staple open`: token-gated JSON API + serves the built app; per-workspace or `--hub` |
| Web UI app | `src/ui/app/` | Vite + React + Tailwind with Radix primitives — Tasks, Queue, Graph, Milestones, Estimates and Usage views, the detail panel and Settings — see [web-ui.md](web-ui.md) |
| Tests | `test/`, `*.test.ts(x)` beside the UI code | Store semantics, CLI and MCP surfaces, migrations and crash drills, the packed runtime, sync, telemetry, UI |
| Smoke | `scripts/smoke-mcp.ts` | Full JSON-RPC agent workflow over stdio |

## Workspace topology

A workspace is one SQLite file: `.staple/staple.db` in a repository (found by
walk-up), or `~/.staple/workspaces/<slug>.db` for global ones.

Every workspace registers in `~/.staple/hub.db` and gets a unique identifier
prefix (`STA-1`, `WOR-3`), so identifiers are unambiguous cross-repository
references. Cross-workspace `blocks` edges live in the hub; a blocker whose file
is not on this machine reports *unresolvable → treat as blocked*.

The registry is **derived** state: the authoritative slug and prefix live in the
workspace file, so a row can be removed (`staple hub unregister`, or
`staple hub prune` for rows whose file is gone) without losing anything, and a
workspace still on disk re-registers itself from its own stamped prefix on the
next resolution. Removing a row never touches the workspace database — the write
path takes a hub connection and a slug, and is handed no path to reach one with.
Cross-links are the exception to "derived", since they exist only in the hub:
unregistering refuses while a link names the workspace rather than dangling or
silently deleting the edge.

`STAPLE_HOME` relocates the hub — see [configuration.md](configuration.md) for
the full resolution order.

Walk-up prefers `.staple/staple.db` and still finds a legacy `.tasks/tasks.db`.
Both checks happen **per directory** before moving up, so a migrated repository
nested inside an unmigrated one resolves to itself. A directory holding two different canonical databases is refused, not
guessed at — see [migration.md](migration.md).

## Known limits

Gaps in the current build, so nobody discovers them the hard way:

- Plain SQL in the store modules rather than a query builder, and SQLite only.
- Labels are a JSON column and search is `LIKE`; there is no full-text index.
- Holistic reads open one connection per workspace file rather than one
  `ATTACH` union.
- There are no connectors to other trackers (GitHub Issues, ClickUp) and no
  harness connectors: `staple doctor` reports its `harnesses` check as `skip`
  for that reason. Cloud sync between staple workspaces is built; see
  [sync.md](sync.md).
- A dependency cycle that mixes workspace-local and cross-workspace edges is
  not detected: the hub checks cycles over its own edges, and each workspace
  over its own.
- Node's `node:sqlite` prints an `ExperimentalWarning` on Node 22.
