# Design documents

This folder is for people working on staple itself. It holds the contracts and
design notes the code is built against: the store's guarantees, the cloud sync
protocol, how time and cost are measured, and how the package ships. Source
comments cite these files by name.

The documentation site does not render this folder. Guides for people using
staple are in [docs/](../docs/README.md); [CONTRIBUTING.md](../CONTRIBUTING.md)
covers the development setup.

| Document | What it is |
|---|---|
| [semantics.md](semantics.md) | What an issue is and what the store guarantees: statuses and guards, kinds, derived parent status, atomic checkout, claims, liveness and takeover, the dependency graph, approval gates, revisioned documents, duplicate and replay guards |
| [queue.md](queue.md) | The pickup queue's contract: plan and effective order, the resolver and its eligibility ladder, scoped pickup, advisory and strict policy, the override, entry lifecycle, revisions, storage, events and surfaces |
| [milestones.md](milestones.md) | Milestones: identity as a kind, metadata and derived state, UTC dates, membership, order, progress, the goal check and pace, gating, lifecycle, their place in the queue, events and surfaces |
| [runs.md](runs.md) | Autopilot runs: the `run continue` contract and its JSON, stop and wait reasons, `run drive`, stop hooks and the CLI survey, goal mode, events and the web UI's run surfaces |
| [sync.md](sync.md) | The cloud sync contract and its operations: identity, what synchronizes and what never leaves the machine, the local sync tables, the operation envelope, routes and limits, ordering and epochs, conflicts, leases, the hub registry, the three consents, trust boundaries, protocol evolution, backup and purge |
| [timing-semantics.md](timing-semantics.md) | What every time number means: elapsed time and agent work, boundary rules, the estimate ratio, quality states, calibration, forecasts and the controlled runs that validate them |
| [execution-telemetry.md](execution-telemetry.md) | Execution attempts, provider usage-limit windows and budget samples: the data model, where each lives, what synchronizes, and the surfaces that read it |
| [architecture.md](architecture.md) | Where each part of the code lives, the agent surface (the protocol file `init` writes, the MCP server for harnesses, the For agents tab), workspace and hub topology, known limits |
| [migration.md](migration.md) | Moving a legacy `.tasks` workspace to `.staple`, schema upgrades on open, and diagnosing a schema mismatch with `staple doctor` |
| [packaging.md](packaging.md) | What the published `staple-cli` package contains, how the build proves it, and how `staple install` keeps a versioned runtime and launcher |

The worker that serves cloud sync has its own notes in
[worker/README.md](../worker/README.md).
