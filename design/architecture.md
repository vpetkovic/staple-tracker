# Architecture

## Where the code lives

| Piece | File | What it does |
|---|---|---|
| CLI | `src/cli.ts`, `src/commands/` | Argument parsing and the human and CI surface; larger verbs (`queue`, `milestone`, `run`, `budget`, `cloud`, `doctor`, `add`, `discover`, …) live in `src/commands/` — see [cli.md](../docs/cli.md) |
| MCP server | `src/mcp.ts`, `src/mcp-attempts.ts`, `src/core/telemetry/mcp-tools.ts`, `src/core/telemetry/mcp-read-tools.ts` | 65 stdio tools, the agent surface; each calls the same store method the CLI does |
| Packaged entrypoint | `src/package/staple.ts` | The published `staple` binary: dispatches `mcp` to the MCP server and everything else to the CLI — see [packaging.md](packaging.md) |
| Core store | `src/core/store.ts` | Issues, statuses, kinds, guards, claims, dependencies, approval gates, comments, documents, settings — see [semantics.md](semantics.md) |
| Workspace open | `src/core/workspace.ts`, `src/core/open.ts`, `src/core/db.ts` | Walk-up resolution, the newer-schema refusal, and the snapshot taken before a schema upgrade |
| Schema migrations | `src/core/migrations/workspace/`, `src/core/migrations/hub/` | Numbered migrations (workspace 001–016, hub 001–008) and the runner that applies them on open — see [migration.md](migration.md#schema-upgrades-on-open) |
| Path migration | `src/core/path-migration.ts` | The journalled `.tasks/tasks.db` → `.staple/staple.db` move behind `staple migrate` |
| Hub | `src/core/hub.ts`, `src/core/hub-repair.ts`, `src/core/hub-follow.ts` | Workspace registry, unique prefixes, cross-workspace links, holistic views |
| Settings registry | `src/core/settings-registry.ts` | Every machine preference and workspace setting, typed once — see [configuration.md](../docs/configuration.md) |
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

## The agent surface

The user guides ([Connect your agent](../docs/connect-your-agent.md),
[How an agent works a ticket](../docs/working-a-ticket.md)) say how to use these. This
section records how they are built and why.

### The protocol file `init` writes

A repo-local `staple init` also writes **`.staple/AGENTS.md`**
(`src/core/agents-template.ts`): the working protocol, rendered with that
workspace's own slug and identifier prefix, so the next harness to arrive learns it
from the repository instead of from whoever briefed the last one.

It covers:

- the loop (inbox, checkout, plan document, estimate, comments, done, events);
- the **identity rule**: act under the identity you claimed with, all session, or
  your own writes stop counting as liveness;
- **parents close themselves**: an epic's status follows its children, so the last
  child to land closes it (see [semantics.md](semantics.md#a-parents-status-is-derived-from-its-children)).
  What is still owed is the **summary comment**, and an explicit `staple done <epic>`
  remains allowed, idempotent, and immune to the derivation afterwards;
- the **worklog convention**: `Done` / `Next` / `Files touched`, revised at every
  milestone. A checkpoint written *before* the interruption is the handoff; one
  written at the end never survives a kill;
- the branch pointer to comment at checkout;
- the **pickup queue rule**: plan order versus effective order, and the three
  non-retryable refusals. It is the part an agent is most likely to get wrong,
  because every symptom of getting it wrong looks like a transient failure: READY
  is the effective queue rather than a presentation sort it may re-rank; a queued
  epic or milestone stands for its open leaf work and is never a checkout target;
  `staple queue next` answers before you claim; and `conflict` (exit 4), `gated`
  (exit 9) and `out_of_order` (exit 10) each mean STOP and take what the refusal
  names. Retrying, waiting and `--steal-if-stale` clear none of the three. The guide
  also tells an agent not to reorder the plan and not to send `--override`: both
  work for it, both record it as the actor, and both are a human's decision;
- **approval gates**: how a design-first ticket ends (`staple gate <ref> --owner
  <who>`, not a held claim), that the inbox's QUEUED section is never pickable, and
  that checkout of it is refused with `gated`;
- the continuity rules ([semantics.md](semantics.md#claims-liveness-and-takeover));
- **the vocabulary is the workspace's**: read the statuses and kinds (`staple
  statuses ls`, `staple kinds ls`, MCP `list_statuses` / `list_kinds`) rather than
  assuming them, remember that all behaviour keys off the status category, and edit
  the vocabulary only when a human asks;
- **attempts and lanes**: yield (`release`) or pause (`staple attempt pause <ref>
  --reason awaiting_input`) when a blocker appears mid-work, so the wait reads as
  `blocked` or `paused` rather than as work; and how an orchestrator coordinates
  without claiming: `staple attempt open <epic> --role orchestrator` at the start
  of a coordination session, `staple attempt end <epic> --role orchestrator` at
  handoff (MCP `record_attempt_event` with `event: "open"` / `"end"` and `role:
  "orchestrator"`). That time is `orchestrationSeconds`, never `workSeconds`
  ([timing-semantics.md](timing-semantics.md#the-orchestrator-lane));
- **autopilot runs** ([runs.md](runs.md)): after every ticket, ask `staple
  run continue --json` (MCP `continue_run`) and do what it answers: `take` (the
  ticket is already checked out to you), `wait` or `stop`. The three ways a run is
  worked (the `staple run drive` driver, a stop hook, or the agent calling `run
  continue` itself), and the rules that hold for all three: finish before you ask,
  record a `review:` comment before you hand a ticket on, never merge or push to
  master or main, and stop when told to;
- the **wiring**: `claude mcp add staple … -- staple mcp` and the MCP tools that
  mirror the loop.

An existing `AGENTS.md` is **never overwritten**; `init` says it kept it. `--global`
workspaces get no guide: the file exists to be found in a repo, and
`~/.staple/workspaces/` is not one. The MCP `init` tool behaves identically and
returns `guidePath` / `guideWritten`.

### The MCP server for harnesses

Everything a harness needs is in-protocol, so it never needs out-of-band setup:

- **The server starts from any directory.** With no workspace above the working
  directory, tools answer `not_found` *with instructions* instead of crashing the
  connection. The `init` tool creates a workspace headlessly, and every workspace
  tool takes an optional `ws` (hub slug or prefix) to target any registered
  workspace per call.
- **Writes require an identity.** Pass `actor` per call or set `STAPLE_AGENT`.
  There is no silent default: a misconfigured harness fails loudly rather than
  polluting the audit trail with anonymous writes.
- **Replay is explicit.** `add_comment` takes an `idempotency_key`; replayed
  creates and comments come back with `replayed: true`.
- **Tools declare annotations**: 25 read-only; among the writes, 15 are
  `idempotentHint: true` (`checkout_task`, `set_estimate`, `set_blocked_by`,
  `cross_link`, `hub_prune`, `init`, `update_milestone`, `set_setting`,
  `enqueue_task`, `prune_queue`, `pause_run`, `resume_run`, `stop_run`,
  `conflict_resolve`, `record_budget_sample`), and return `structuredContent`
  (arrays wrap as `{items}`).
- **List tools paginate**: `{items, nextCursor, hasMore}` with opaque cursors. The
  telemetry lists answer `{items, truncated, nextCursor, coverage}` instead
  ([MCP tools](../docs/mcp-tools.md#execution-telemetry)).
- `get_task` includes cross-workspace blockers and can inline document bodies with
  `include_documents: true`.

### The For agents tab

The web UI's detail panel has a **For agents** tab
(`src/ui/app/src/detail/tabs/AgentViewTab.tsx`) that renders the exact `get_task`
payload for an issue, both with and without `include_documents`, plus its token
cost. It exists because a human hands over an issue believing the ticket says one
thing while the agent receives a payload that says something slightly different,
and nothing else shows the two side by side.

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

`STAPLE_HOME` relocates the hub — see [configuration.md](../docs/configuration.md) for
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
