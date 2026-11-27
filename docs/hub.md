---
title: Several repositories
description: Work across several repositories from one machine. See every workspace, point a command or an agent at another one, and make a ticket wait on work in another repository.
---

# Several repositories

Use this page when your work spans more than one repository on the same machine,
say an API and the web app that calls it. Each repository keeps its own workspace
and its own tickets. The **hub** is this machine's list of those workspaces, and
it is what lets you see them together, reach one from another, and make a ticket
in one wait on a ticket in another.

The examples use two repositories: `app` (prefix `APP`), which holds the password
reset epic from [Plans become tickets](plans-to-tickets.md), and `web` (prefix `WEB`).

## 1. Register each repository

Setting a repository up registers it. Run this in each one:

```bash
staple init --yes
```

Every workspace gets its own prefix, so an identifier like `APP-3` or `WEB-1`
names one ticket on the whole machine. To register repositories that already have
a `.staple` folder (after a fresh clone, say), look for them under a folder:

```bash
staple discover ~/work
```

```text
Scanned 5 directories under ~/work (max depth 6).

+ unregistered     api                  ~/work/api
                   not in the hub yet
  registered       app                  ~/work/app
                   already registered at this exact path
  registered       web                  ~/work/web
                   already registered at this exact path

1 candidate(s) can be registered. Nothing has been written.
  staple discover ~/work --all-found --yes
  staple discover ~/work --select api --yes
```

Nothing is written until you add `--yes`. `staple add <path> --yes` registers a
single repository.

## 2. List them

```bash
staple hub                   # MCP hub_overview
```

```text
APP    app                  repo    available  ~/work/app/.staple/staple.db
WEB    web                  repo    available  ~/work/web/.staple/staple.db
```

## 3. See everything at once

```bash
staple inbox --hub
staple open --hub
```

```text
app          ◌  APP-1     backlog     Password reset · epic
app          ◌  APP-3     backlog     Send the reset email
app          ◌  APP-4     backlog     Reset form sets the new password
app          ◌  APP-5     backlog     Document the reset flow
web          ◌  WEB-1     backlog     Reset password page
```

`inbox --hub` lists the open tickets of every workspace, each with its workspace's
name. Run `staple inbox` inside one repository for its ready and blocked split.
`staple open --hub` serves the [web UI](web-ui.md) over every workspace: the rail
lists them under *Workspaces*, and *All workspaces* shows Tasks, Graph and
Milestones across all of them. The Queue asks you to pick one, because each
workspace keeps its own pickup order. [Analytics](analytics.md) reads them all,
with its own workspace filter.

## 4. Work in another repository without moving

Any command takes `--ws` with a workspace's name or prefix:

```bash
staple ls --ws web           # by name, or by prefix: --ws WEB
```

```text
◇ ◌  WEB-1     backlog     Reset password page
```

Agents do the same with the `ws` argument that most MCP tools take, for example
`get_task` with `{"ref": "WEB-1", "ws": "web"}`. `hub_overview` lists the names
and prefixes they can pass.

## 5. Make a ticket wait on another repository

The reset page in `web` cannot ship before `app` sends the reset email:

```bash
staple link APP-3 WEB-1      # MCP cross_link
staple hub links
```

```text
app/APP-3 blocks web/WEB-1
APP-3 blocks WEB-1  (app → web)
```

The link holds WEB-1 back in `web` the way a local blocker would. `staple queue
next` and MCP `next_task` skip it and name the link, `staple inbox` lists it under
BLOCKED, and `staple show WEB-1` names it:

```text
skipped  WEB-1     blocked   WEB-1 is blocked by APP-3 in app.
```

```text
blocked across repositories by: APP-3 in app (todo) — checkout is refused until they resolve
```

Checkout refuses it, on the CLI and over MCP (`checkout_task`):

```text
error(conflict): Checkout refused: WEB-1 is blocked across repositories by APP-3 in app. Pick a different task, or ask a person to step over it with --override -m "<why>".
```

A blocker this machine cannot read, because its repository is not here or the
ticket is gone, holds the ticket too, and the message says it `cannot be resolved
on this machine`. If a person decides the work goes ahead anyway, they take it
with a reason, and the step is recorded on the ticket as `cross_blocker_overridden`.
Taking over a stale claim with `--steal-if-stale` does not step over the link on
its own; it needs the override too:

```bash
staple checkout WEB-1 --override -m "the email is live in staging"
```

The link also shows in the task detail in the web UI, in `get_task` over MCP (as
`crossBlockers`), and in the Graph, drawn dashed. A link that would close a loop,
through other links or through either repository's own `--blocked-by` edges, is
refused, and so is a local edge that would close one through a link. The local
edges of a repository that is not on this machine cannot be seen, so a loop
through one is only caught on a machine that has both.

When APP-3 is done, or moved to any status `app` files under done or cancelled,
WEB-1 is ready again. The hub records it, in the hub and as
`cross_blockers_resolved` on WEB-1 in `web` (`staple events`):

```bash
staple hub events
```

```text
   1  2026-09-29T14:58:41  cross_blockers_resolved  {"workspace":"web","identifier":"WEB-1","blockers":["APP-3"]}
```

## 6. Tidy the list

```bash
staple hub unlink APP-3 WEB-1   # remove one link (MCP cross_unlink)
staple hub unregister web       # drop a workspace from the list (MCP hub_unregister)
staple hub prune                # list workspaces whose folder is gone
```

`staple hub prune --yes` removes what `prune` lists. Unregistering never touches
the workspace's tickets: the next staple command run
in that repository registers it again. It refuses while a link names the
workspace; remove the link first, or pass `--with-links`.

## Across machines

The hub belongs to one machine. To carry a workspace's tickets to another machine,
use [cloud sync](cloud-sync.md) for each repository. `staple hub registry` can
also publish this machine's list of workspaces to the sync service, so another
machine can adopt it. That is a separate consent, off until you grant it with
`staple hub registry publish --enable`.

## Next

- [Cloud sync](cloud-sync.md): share a workspace between machines.
- [Web UI tour](web-ui.md): the views `open --hub` serves.
- [CLI reference](cli.md#several-repositories): tidying the hub; `staple help`
  lists every hub command.
