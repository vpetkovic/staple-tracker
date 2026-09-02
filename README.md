# staple — local-first task tracker for coding agents

A smaller paperclip: a clean-room rebuild of the ticket system inside
[paperclipai/paperclip](https://github.com/paperclipai/paperclip) (MIT) as a
standalone, portable tool agents use instead of scattered `plan.md` files.

**Zero native dependencies.** Storage is Node's built-in `node:sqlite`;
state is one copyable SQLite file per workspace. No account, no cloud
database, no daemon.

## Quickstart

```bash
npx staple-cli   # onboard + open the UI
```

Requirements: Node >= 22.5. Nothing else.

Run it in a repository and it sets the workspace up if it needs it — the
database at `.staple/staple.db`, the agent protocol at `.staple/AGENTS.md` —
then opens the local web UI (board, tree, dependency graph, task detail). The
first run asks a couple of questions; pass `--yes` to accept the defaults. In
CI or any other non-interactive context, `npx staple-cli --yes` performs the
setup but refuses to start the UI server — it prints where things live and the
explicit `staple open` command instead, so automation never hangs on a server.

Wire an agent harness:

```bash
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
```

That is the whole install for both surfaces: `staple-cli` is one package with
one executable, `staple`, serving the CLI and the MCP stdio server
(`staple mcp`) from the same entrypoint.

### Always-on install (optional)

`npx` fetches on demand. If you want a `staple` command on your `PATH`:

```bash
npx staple-cli install --yes
```

installs a versioned, user-owned runtime under your Staple home plus a small
launcher at `~/.local/bin/staple` — no `sudo`, atomic switch, verified
rollback. Details in [Install (user-owned runtime)](#install-user-owned-runtime).

Hacking on staple itself — running from a checkout, building the UI, tests?
See [CONTRIBUTING.md](CONTRIBUTING.md).

## What's here

| Piece | File | What it does |
|---|---|---|
| Core store | `src/core/store.ts` | Issues with Paperclip's semantics (see below) |
| Hub | `src/core/hub.ts` | Workspace registry, unique prefixes, cross-workspace links, holistic views |
| Agent guide | `src/core/agents-template.ts` | The working protocol `init` writes to `.staple/AGENTS.md` |
| MCP server | `src/mcp.ts` | 16 stdio tools — the whole agent surface |
| CLI | `src/cli.ts` | Human/CI mirror of the tools |
| Web UI server | `src/ui/server.ts` | `staple open`: token-gated JSON API + serves the built app; per-workspace or `--hub` |
| Web UI app | `src/ui/app/` | Vite + React + shadcn/ui (new-york) on Paperclip's CSS token sheet — inbox, board, tree, dependency graph, detail panel |
| Tests | `test/` | Guard/claim/dependency/document semantics, CLI JSON, wait/follow, UI auth, and the [takeover drill](#takeover-drill) |
| Smoke | `scripts/smoke-mcp.ts` | Full JSON-RPC agent workflow over stdio |

### Semantics cloned from Paperclip (verified by tests)

- Statuses `backlog → todo → in_progress → in_review → done` + `blocked`/`cancelled`,
  with guards, not a transition table: `in_progress` needs an assignee **and**
  zero unresolved blockers; timestamps stamp automatically.
- **Atomic checkout/release**: one `UPDATE … WHERE status IN (…) RETURNING`
  claim; losers get a conflict that says *pick a different task*; re-claim by
  the same agent is idempotent (crash recovery).
- **`blocks` dependency graph** with BFS cycle detection, set-replacement
  writes, and **level-triggered `blockers_resolved` events**
  (`sha256(sorted blocker ids + blocked-cycle stamp)` dedup — re-blocking
  re-arms the wake). Parents get `children_complete` when the last child lands;
  `blockParentUntilDone` is a real edge.
- **Keyed revisioned documents** (`plan`, `notes`, …) with `baseRevision`
  optimistic concurrency and restore — the plan.md replacement.
- Idempotency-key replay on create, normalized-title duplicate guard among open
  siblings, one live machine-origin issue per source (partial unique index).
- `unblockDescriptor`: blocked work names who must act and what clears it.

### Topology (per the evaluation)

Workspace = one SQLite file: `.staple/staple.db` in a repo (found by walk-up), or
`~/.staple/workspaces/<slug>.db` for global ones. Every workspace registers in
`~/.staple/hub.db` and gets a unique identifier prefix (`STA-1`, `WOR-3`), so
identifiers are unambiguous cross-repo references. Cross-workspace `blocks`
edges live in the hub; a blocker whose file isn't on this machine reports
*unresolvable → treat as blocked*. `STAPLE_HOME` relocates the hub — see
[Machine configuration](#machine-configuration) for the full resolution order.

Walk-up prefers `.staple/staple.db` and still finds a legacy `.tasks/tasks.db`
during the compatibility window. Both checks happen **per directory** before
moving up, so a migrated repository nested inside an unmigrated one resolves to
itself. A directory holding two different canonical databases is refused, not
guessed at — see [Migrating a `.tasks` workspace](#migrating-a-tasks-workspace).

### The protocol init teaches

A repo `staple init` also writes **`.staple/AGENTS.md`** — the working protocol,
rendered with that workspace's own slug and prefix, so the next harness to arrive
learns it from the repo instead of from whoever briefed the last one. It covers the
loop, the identity rule (act under the identity you claimed with, all session,
or your own writes stop counting as liveness), the **worklog** convention
(`Done` / `Next` / `Files touched`, revised at every milestone — a checkpoint
written *before* the interruption is the handoff; one written at the end never
survives a kill), the branch pointer to comment at checkout, and the continuity
rules below. An existing `AGENTS.md` is **never overwritten** — init says it kept
it. `--global` workspaces get no guide: the file exists to be found in a repo,
and `~/.staple/workspaces/` is not one. The MCP `init` tool behaves identically
and returns `guidePath` / `guideWritten`. Source: `src/core/agents-template.ts`.

### The agent surface (MCP)

The [quickstart](#quickstart) command registers the stdio server with Claude
Code; any MCP client can launch `npx -y staple-cli mcp` the same way, with
`STAPLE_AGENT` naming the agent.

Agent loop: `inbox` → `checkout_task` (conflict = pick another, never retry) →
`put_document` the plan → work, `add_comment` progress → `update_task` done →
`events_since` to see what your completion unblocked. `cross_link` +
`hub_overview` cover cross-repo dependencies.

Harness ergonomics, all in-protocol:

- The server starts from **any** directory. With no workspace above cwd, tools
  answer `not_found` with instructions instead of crashing the connection; the
  `init` tool creates a workspace headlessly, and every workspace tool takes an
  optional `ws` (hub slug or prefix) to target any registered workspace per call.
- **Writes require an identity**: pass `actor` per call or set `STAPLE_AGENT`.
  There is no silent default — misconfigured harnesses fail loudly instead of
  polluting the audit trail. `add_comment` takes an `idempotency_key`; replayed
  creates/comments carry `replayed: true`.
- Tools declare annotations (7 read-only, `checkout_task` idempotent), return
  `structuredContent` (arrays wrap as `{items}`), and list tools paginate:
  `{items, nextCursor, hasMore}` with opaque cursors. `get_task` includes
  cross-workspace blockers and can inline document bodies
  (`include_documents: true`).
- **Continuity after an agent dies.** Every held issue carries a `claim`
  (`heldBy`, `lastActivityAt`, `heldSeconds`, `idleSeconds`) derived from the
  checkout plus the newest event or comment *by that holder*, so a caller can
  tell a working agent from one a usage limit killed hours ago. Taking the task
  over is explicit and opt-in: `checkout_task` accepts `steal_if_idle_seconds`
  and `release_task` accepts `if_idle_seconds`, and both refuse a fresher holder
  by name — `Checkout refused: held by opus-x, active 3m ago. Pick a different
  task.` A successful takeover logs `claim_stolen` / `claim_released_stale` with
  the previous holder and their last activity.

  There is **no sweeper, no daemon, no TTL, and nothing automatic**: a claim
  never expires on its own, and staleness is information plus an affordance you
  invoke when a human says "continue". Blockers still win — a steal is refused
  while dependencies are unresolved, however dead the holder looks.

### Takeover drill

Prove the handoff works on your own machine, with two different harnesses:

1. In harness one (say Claude Code), have it `checkout` a task, comment the
   branch pointer, and `put_document … worklog` a *Done / Next / Files touched*
   checkpoint after the **first** step of real work. Then kill the session —
   no release, no goodbye. That is the whole simulation.
2. In harness two (say `codex`), in a fresh thread, say only: **"continue"**.
   It should run `staple inbox` (the row reads `held 2h · silent 2h`),
   `staple checkout <ref> --steal-if-stale 1h`, then `staple show <ref>` plus
   `staple doc <ref> worklog` — and pick up from the `Next` it finds there.
3. Afterwards, check three things: the *artifact* is finished (not just the
   ticket), `staple show <ref>` names the second harness as assignee, and
   `staple events` carries `claim_stolen` with the first harness as
   `previousHolder`. If the second harness had to ask you a question to
   continue, the checkpoint was too thin — that is the drill failing, not the
   agent.

`test/takeover-drill.test.ts` is the executable version of exactly this: agent
`drill-claude` works a scratch repo over the **CLI** and dies mid-task, agent
`drill-codex` finishes it over a real **MCP** server, and its resume is a pure
function of one `get_task` payload — so the test cannot pass on anything the
tracker did not carry.

## CLI at a glance

```
staple init [--global <slug>]         staple start|done|cancel|release <ref>
       (repo-local also writes .staple/AGENTS.md, never clobbering an edited one)
staple new <title> [--parent R]       staple block <ref> --owner O --action TEXT
       [--blocked-by R1,R2] [-p prio] staple blocked-by <ref> R1,R2 | --none
staple ls | show <ref> | tree | board staple link <blocker> <blocked>   (cross-ws)
staple inbox [--hub] [--assignee A]   staple doc <ref> <key> [--put f --base N]
staple events [--since N]             staple hub [ls|links|events]
staple open [--port 4400] [--hub]     staple config [show|set|home]
staple migrate [--yes]                staple doctor [--json] [--fix --only <check>]
staple install [status|--rollback]    staple add <path> --yes | discover <root>

staple wait <ref> [--timeout s] [--interval ms]     block until ready or finished
staple events --follow [--since N] [--max N]        stream events as they land
       [--exec CMD]                                 run CMD per event (JSON arg + $STAPLE_EVENT)

staple start <ref> --steal-if-stale <30m|2h|3600>   take over a dead agent's claim
staple release <ref> --if-stale <dur>               free a dead agent's claim
```

`staple help` has the full option list; `staple ui` is a compatibility alias
for `staple open`.

`ls` and `show` print `held 2h · silent 45m` on in_progress rows, and `--json`
carries the same numbers as `claim`. Both takeover flags are explicit: without
one, a claim held by another agent is refused exactly as before.

`wait` and `--follow --exec` are the wake affordance: an orchestrator blocks on
a blocker instead of polling, and hooks (Claude Code hooks, notify servers)
fire the moment `blockers_resolved` / `children_complete` land.

### Estimates vs actuals

One stored number and a handful of read-time derivations, so you can say what
agentic execution actually cost against the plan-time human figure.

```bash
staple new "Port the claim guard" --estimate 90m   # record it WHEN YOU PLAN
staple status STA-42 in_progress --estimate 2h     # re-estimate
staple status STA-42 backlog --no-estimate         # clear it
```

Durations are the same vocabulary as `--if-stale`: `90s`, `30m`, `2h`, `3d`, or
a bare number of seconds. An estimate must be a positive whole number of seconds
and at most 365 days — `--estimate 0` is refused, because "estimated at nothing"
and "no estimate recorded" are different facts and only one of them has a
dedicated flag.

**Only the estimate is stored.** The actual is `activeSeconds`, reconstructed at
read time by replaying the event log into `in_progress` **intervals** — entering
opens one, leaving closes one. Three things follow, and each of them was a real
complaint about the earlier two-timestamp version:

- **Blocked and parked time is free.** `in_progress → blocked → in_progress` is
  two intervals, and the week in between is simply not one. No special case
  needed; a `now − startedAt` span had no way to express it.
- **The clock stops when the agents do.** An open interval ends at the holder's
  `lastActivityAt` — the same C1 derivation the stale-claim badge uses — and
  never at `now`. An agent that died on Friday is not several days deeper into
  its estimate by Monday. `countedThrough` reports where the clock stopped.
- **An epic has no stopwatch.** An interval opened by staple's own "a child
  started, so the parent is in progress" flip is excluded. A parent's actual is
  the **aggregation of its children**; `ownActiveSeconds` sits beside it and is
  normally `null`.

The honest limit: this measures an agent's **write cadence**. Twenty silent
minutes before a crash are not counted. Under-counting silence beats billing a
dead process for a weekend — the second error compounds without limit.

`in_review` is measured separately as `reviewSeconds` and never folded into the
actual: waiting on a human reviewer is a queue, not execution. It surfaces only
when nonzero. And a workspace imported from another tool, with no usable event
log, falls back to `completedAt − startedAt` with `approximate: true`, which
every surface renders as "approx".

Nothing is cached, and there is deliberately no `active_seconds` column: a
derived reading frozen onto an entity you serialize, hand to an MCP client and
hold for a session is a number that stopped being true the instant it was
written. This is the same rule `claim` follows, and for the same reason — so
timing rides **beside** the issue, never on it:

```bash
staple show STA-42
# status in_progress (v3) · priority high · @claude · held by claude
# claim  held 3h · silent 2m (last activity 2026-09-02T00:40:45Z)
# time   est 2h · ran 3h10m · counted through 2026-09-02T00:40:45Z
```

`--json` and the MCP/HTTP read payloads carry the full object as `timing`, plus
`childrenTiming` keyed by child identifier:

```json
{"timing":{"estimatedSeconds":14400,"ownActiveSeconds":null,"activeSeconds":15000,
  "reviewSeconds":null,"approximate":false,"countedThrough":null,"childCount":3,
  "childrenEstimatedSeconds":12600,"childrenActiveSeconds":15000,
  "childStatusCounts":{"backlog":1,"todo":0,"in_progress":1,"in_review":0,
                       "done":1,"blocked":0,"cancelled":0}},
 "childrenTiming":{"STA-43":{"estimatedSeconds":5400,"activeSeconds":3600,"…":"…"}}}
```

Rollups sum **direct children only**, and each child contributes its own
`activeSeconds` — so a child that is itself a parent contributes its aggregate,
which is exactly the number its row on screen shows. The table adds up, and an
epic-of-epics reports its grandchildren's work rather than zero. Estimates stay
strictly depth-1, because a parent's estimate is a plan for its whole subtree and
adding it to its children's would double-count the plan. A sum is `null` — never
`0` — when no child contributed one.

Every surface takes it: MCP `create_task`/`update_task` via `estimate_seconds`
(explicit `null` clears, absent leaves alone), HTTP `create`/`update` via
`estimateSeconds`, and the CLI as above. `list_tasks` and `inbox` carry the
scalar `estimatedSeconds` but not the rollup object — those shapes exist to make
choosing a task cheap.

### Machine-readable output

`--json` is a global flag on every task command (`ls`, `show`, `inbox`, `board`,
`tree`, `events`, `start`, `done`, `new`, `doc`, …). It emits the store objects
unformatted, so timestamps are full ISO-8601 with a `Z` suffix rather than the
truncated forms the human tables print. `events --json` emits **NDJSON** — one
event object per line. Human output is unchanged when the flag is absent.

Errors under `--json` are a single line of JSON on **stderr**, carrying the same
fields on every surface (the MCP server nests it under an `error` key in its
text block; the UI server adds a legacy `error` alias for `message`):

```json
{"code":"conflict","message":"Checkout refused: …","detail":{"currentStatus":"in_progress","heldBy":"other-agent","blockers":[]},"retryable":false}
```

`retryable` is the branchable bit: only `revision_conflict` is worth retrying.
A checkout conflict means *pick a different task*.

Exit codes let CI branch without parsing stderr:

| code | meaning | | code | meaning |
|---|---|---|---|---|
| 0 | success | | 4 | `conflict` |
| 1 | unknown error | | 5 | `duplicate` |
| 2 | `validation` | | 6 | `cycle` |
| 3 | `not_found` | | 7 | `revision_conflict` |
| | | | 8 | `timeout` (`wait` only) |

## Machine configuration

Everything staple keeps per-machine — `hub.db`, the UI token, `config.json`, and
global workspaces — lives in one directory, the **staple home**. It is resolved
in exactly one place (`src/config/`), in this order:

| # | Source | Notes |
|---|---|---|
| 1 | `--home <path>` | Configuration and diagnostic commands only, not a global flag |
| 2 | `STAPLE_HOME` | Wins over the locator; handy for tests and portable setups |
| 3 | Bootstrap locator | Written by `staple config home`; see the table below |
| 4 | `~/.staple` | The default when nothing else says otherwise |

The **bootstrap locator** deliberately lives *outside* the home, because a file
that says where the home is cannot live inside it:

| Platform | Locator |
|---|---|
| macOS | `~/Library/Application Support/Staple/bootstrap.json` |
| Linux | `$XDG_CONFIG_HOME/staple/bootstrap.json`, else `~/.config/staple/bootstrap.json` |
| Windows | `%APPDATA%\Staple\bootstrap.json` |

Schema v1 is `{ "schemaVersion": 1, "home": "<absolute-path>" }`, written 0600 in
a 0700 directory. A relative path, a filesystem root, or an unknown
`schemaVersion` is refused rather than guessed at; an *absent* locator is not an
error, it just means `~/.staple`.

### `config.json`

`<home>/config.json` holds durable preferences only — never per-project state,
which belongs in the workspace database.

```jsonc
{
  "schemaVersion": 1,
  "browser": "auto",        // auto | always | never
  "port": 4400,             // preferred UI port
  "setupComplete": false,
  "connectors": {}          // reserved for future connector receipts
}
```

Three properties are load-bearing:

- **Sparse.** Only keys you actually set are written. Defaults stay live, so
  changing a default later still reaches machines that ran `config set` once.
- **Forward-compatible.** Keys written by a newer staple are preserved untouched
  across a rewrite by an older one, instead of being silently dropped.
- **Refused, not replaced.** A corrupt file or a newer `schemaVersion` is a hard
  validation error naming the path. Falling back to defaults would read as
  robustness and behave as data loss — the next write would overwrite the file.

Both files are written through a validated temporary file in the same directory
and then `rename(2)`d over the target, so a reader sees the old bytes or the new
bytes, never half of each.

### Commands

```bash
staple config                       # effective settings and where each came from
staple config --json                # the same, machine-readable
staple config set port 4500         # browser | port | setupComplete
staple config home /vol/staple --move --yes
```

`config` prints one setting per line with the key in a fixed 14-column field:

```
home          /Users/you/.staple  (default)
config        /Users/you/.staple/config.json  (absent)
locator       /Users/you/Library/Application Support/Staple/bootstrap.json  (absent)
browser       auto  (default)
port          4400  (default)
setup         incomplete  (default)
```

The source label is the point: `default`, `config`, `env`, `locator`, or `flag`.
A `4400` you chose and a `4400` you inherited are different facts.

### Moving the home

Changing the home once data exists is a migration, not a key assignment:

```bash
staple config home /Volumes/work/staple --move --yes
```

It requires an absolute path, refuses a filesystem root, refuses a non-empty
destination rather than merging into it, and refuses a destination nested inside
the source. It checkpoints the databases, copies, **verifies the destination, and
only then** updates the bootstrap locator — so a failure anywhere leaves the old
home live and untouched. The old home is *retained* afterwards; delete it once
you have confirmed the new one works.

Two things it will tell you about rather than silently paper over:

- If `STAPLE_HOME` is set, it outranks the locator, so the move you just made
  will not take effect until you unset it. You get a warning.
- Hub registrations that point *inside* the old home are reported, not rewritten
  — repointing them is `staple init` in the affected workspace.

## Migrating a `.tasks` workspace

Repository state used to live at `.tasks/tasks.db`. It now lives at
`.staple/staple.db`. Legacy workspaces keep working — walk-up still finds them —
and moving one is a single explicit command:

```bash
staple migrate          # preview: prints the plan, changes nothing, exits 2
staple migrate --yes    # apply
```

`staple init` in a legacy repository **adopts** the existing database rather than
creating a new one beside it, and says so. Nothing migrates data implicitly.

### Why this is more than a rename

The failure mode worth engineering against is not a lost file, it is a *forked*
one: two writable databases for the same workspace, each accumulating history
nobody reconciles. Everything below exists to make that impossible.

**A write barrier, held throughout.** The migration takes SQLite's write lock on
the source (`BEGIN IMMEDIATE`) before it copies anything and holds it until the
legacy file has been moved aside. If another process is writing — a `staple open`
server, an MCP server, another agent — it waits a bounded five seconds and then
refuses, having copied nothing.

**A WAL-safe snapshot.** The copy is `VACUUM INTO` from a second connection while
the barrier is held, so it reads *through* the write-ahead log. Work another
process committed and never checkpointed comes across. A migration that copied
the `.db` file and guessed about `-wal` / `-shm` sidecars would silently drop it.

**Validation before cutover.** The snapshot gets `integrity_check`, a row-count
comparison against the still-locked source, a column-set comparison per table,
the ordered schema migrations every other open runs, and a slug/prefix identity
check. Only then is it renamed into place — atomically, with the directory
fsynced.

**A journal, and a rollback copy.** `.staple/migration.json` records the
migration id, source and target paths, the source's slug, prefix, schema version
and device+inode identity, the snapshot's SHA-256, the hub path before and after,
and every state transition with its timestamp. States are `planned`, `locked`,
`snapshotted`, `target_installed`, `hub_repaired`, `complete`,
`rollback_required`; each is fsynced *before* the change it describes. The legacy
database and its sidecars are moved to `.staple/rollback-<id>/`, never deleted.

**Crash recovery, tested by crashing.** Re-running `staple migrate --yes` after
an interruption resumes from the journal. Recovery reads recorded facts only —
never modification times. The test suite SIGKILLs a real process at each of the
six reachable state boundaries and proves every issue survives:

| crashed at | on disk | `staple migrate --yes` does |
|---|---|---|
| `planned`, `locked` | legacy untouched, no target | discards temporaries, starts the copy again |
| `snapshotted` | snapshot present, legacy untouched | verifies the hash, resumes at install |
| `target_installed` | **both** databases present | verifies the target hash, retires the legacy file, repairs the hub |
| `hub_repaired` | migrated, legacy already retired | reopens, verifies identity, marks complete |
| `complete` | done | reports that it is already current |

Before `target_installed` the legacy workspace is still authoritative and every
ordinary command keeps working against it. At `target_installed` — the one window
where two canonical databases genuinely coexist — every command refuses with
exit 4 and names the resume command, rather than picking one.

**Ambiguity is refused, loudly.** Two different canonical databases in one
directory, with no journal explaining them, stops everything with exit 4 and both
absolute paths. Staple will not choose by modification time: whichever history
lost would vanish without a trace. If the target is missing or its hash does not
match after installation, the journal records `rollback_required` and blocks
mutation; the legacy copy is still there and still readable.

**One hub row.** The migrated workspace's own registration is repointed at the
new path, realpath-normalised (macOS stores the same file as both `/var/…` and
`/private/var/…`). Nothing else in the registry is touched, and a registry
conflict is a warning, not a failed migration — the data is already safe by then.

## Web UI

```bash
staple open      # prints http://127.0.0.1:4400/?token=… and opens your browser
```

One command, no daemon: the server runs in the foreground and Ctrl-C closes it
along with every database handle. `--hub` serves every registered workspace at
once; the browser behaviour follows `config browser=auto|always|never`. Pages
served to loopback carry their own token, so the browser never sees a token
screen. The token (for curl, agents, remote tabs) lives in `~/.staple/ui-token`
(0600) and survives restarts; delete the file to rotate it.

The page is a Vite + React + TypeScript app in `src/ui/app/`, shipped inside the
package as a prebuilt static bundle that `src/ui/server.ts` reads off disk.

**Stack.** React 19, Tailwind v4, [shadcn/ui](https://ui.shadcn.com) in the *new-york*
style, `radix-ui` primitives, `lucide-react` icons. All of it is a **devDependency** —
staple's runtime dependencies are compiled into the published bundle, because
what ships is the built app, not the toolchain that made it.

**Theme.** The app runs on Paperclip's own CSS custom-property sheet, lifted verbatim
from [github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip) (MIT)
into `src/ui/app/src/styles/paperclip-tokens.css` — 531 custom properties covering the
light/dark scales, the radius and type ladders, motion, and the `.status-chip`
color-mix recipe. staple's status enum is a subset of Paperclip's `--status-task-*`
family, so a status chip is one variable, and the two tools look like relatives on
purpose.

**Auth.** Every `/api/*` route is gated by the per-process token
(`X-Staple-Token`, `Authorization: Bearer`, or `?token=`), compared with
`timingSafeEqual`; writes are `POST`-only and Origin-checked. The app reads the
token out of its own URL once, keeps it in `sessionStorage`, and strips it from the
address bar. Arriving without a valid token renders an explanation, not a blank page.

Working on the app itself is a contributor path — dev server, rebuild loop, and
the rest are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Packaging

staple publishes as **`staple-cli`**, one npm package exposing one executable named
`staple`. `npx -y staple-cli` and an installed `staple` run the same entrypoint, and
that entrypoint serves both surfaces — the CLI, and the MCP stdio server under
`staple mcp`. There is no second package and no separate MCP binary. Releases are
cut by CI from version tags — see [RELEASING.md](RELEASING.md).

The build bundles the entrypoint with esbuild into one ESM file. Everything
non-builtin is compiled in — the MCP SDK, Zod, Ajv, all of it — and only Node's
own modules stay external, `node:sqlite` foremost. The published runtime
therefore resolves nothing from `node_modules`, needs no TypeScript and no `tsx`, and
runs on Node >= 22.5 and nothing else. The build fails if an unresolved non-builtin
import survives, if the bin loses its shebang or its executable bit, or if anything
other than runtime output lands in the payload.

```text
staple-cli-<version>.tgz
  package.json            generated — name staple-cli, bin staple, dependencies {}
  staple.mjs              the bundle: CLI + MCP server + every runtime dependency
  assets/index.html       the Vite UI bundle, copied beside staple.mjs
  assets/assets/*         its hashed js/css
  README.md  LICENSE  THIRD-PARTY-NOTICES.md
```

The layout is flat because the installer stages a packed runtime into
`<home>/runtime/versions/<version>/` as `staple.mjs` next to `assets/`, so tarball
contents copy into a version directory verbatim.

**The source `package.json` stays `private`.** The published metadata is generated by
the build, so a stray `npm publish` at the repository root cannot ship the source tree.
Publication runs against the generated package; the version is read from the source
`package.json`, so there is still one place to bump it.

`test/package-tarball.test.ts` is the acceptance: it builds the payload, packs it,
installs the tarball into a temporary prefix with `--offline`, and then drives the
installed binary from a directory outside this repository with no `node_modules` near
it — `init`, `new`, `ls --json`, a `staple mcp` handshake with a real tool call, and a
`staple open` that serves its own bundled assets. Nothing in it is skippable: every
input is a local file.

## Install (user-owned runtime)

`staple install` puts a versioned runtime under your Staple home and a small launcher
on your `PATH`. It never uses `sudo` and never writes outside the home and the launcher
directory.

```bash
npx staple-cli install --yes          # install the version you just ran, plus ~/.local/bin/staple
staple install status                 # what is active, what rollback would do
staple install --rollback --yes       # back to the previous version
```

`--from <dir|tarball>` installs a specific payload — an unpacked package directory or
a packed `.tgz`. With no `--from`, the payload is the directory of the running module,
which is why `npx staple-cli install` installs exactly what you just ran.

**Layout.** Versions are immutable directories; one small pointer selects among them.

```text
<home>/runtime/versions/<version>/staple.mjs
<home>/runtime/versions/<version>/assets/index.html
<home>/runtime/versions/<version>/manifest.json
<home>/runtime/current.json
```

`current.json` records the active version, the previous one, a manifest hash, and an
entrypoint **relative** to `<home>/runtime`. Nothing in it names the home, which is why
`staple config home <path> --move` relocates the whole tree as a plain directory copy.

**The switch is one atomic write.** Install stages the payload under
`<home>/runtime/staging/`, verifies it (every file present at its recorded size and
sha256, exec bit intact, exactly one node shebang, manifest version matching the
directory), promotes it with a rename, verifies it again at the final path, and only
then rewrites `current.json`. A failure at any earlier step leaves an unreferenced
directory and the previous runtime still live — `current.json` is never touched.

**Rollback verifies before it switches.** A rollback target has been sitting on disk
since the last install and may have rotted; one that fails verification is refused and
you stay on the current version. Rolling back records the version you left, so a
rollback taken by mistake is undone by rolling back again.

**The launcher contains no absolute path.** On every run it re-derives
`STAPLE_HOME` → bootstrap locator → `~/.staple`, then reads `current.json`, then execs
that entrypoint. So a home move needs no change to the launcher, and an upgrade needs
no rewrite of it. It refuses to overwrite a `staple` on the launcher path that it did
not write.

**PATH is a separate consent.** `--yes` covers the home and the launcher directory.
Editing a shell profile additionally requires `--update-path`, and writes a marked
`# >>> staple >>>` block that a second install will not duplicate. Without it, install
prints the exact export line and leaves the runtime usable by absolute path.

## Prototype simplifications (deliberate)

- Plain SQL behind one storage module instead of Drizzle (the production
  discipline from the evaluation — dialect-neutral core — would formalize this).
- Labels are a JSON column, search is `LIKE` (FTS5 is available when needed),
  holistic reads open one connection per file (ATTACH union is the optimization).
- No sync engine yet — that's M2 (GitHub Issues), M3 (ClickUp) per the plan.
- Combined local+cross cycles spanning three files aren't detected (each layer
  guards its own edges).

Node's `node:sqlite` prints an experimental warning on 22.x; it's stable in 24.
