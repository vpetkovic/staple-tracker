---
title: Install and first workspace
description: Install staple, set up a repository, open the web UI and file the first tickets.
---

# Install and first workspace

Use this page to go from nothing to a repository your agents can work in: install
staple, set the repository up, open the web UI and file your first tickets. It takes
about five minutes and needs Node 22.5 or later, nothing else.

> [!NOTE]
> `staple-cli` is not on npm until its first release. Until then, build the package
> from a checkout with `npm run pack:package` (see
> [CONTRIBUTING.md](../CONTRIBUTING.md)) and use
> `npx -y file:/absolute/path/to/checkout/dist-package/staple-cli-<version>.tgz`
> wherever these docs say `npx staple-cli` or `npx -y staple-cli`.

## 1. Set up the repository

At the root of a git repository, run:

```bash
npx staple-cli
```

The first run asks a few questions, sets the repository up and opens the web UI.
Where there is no terminal to answer in (CI, a script), run `npx staple-cli init --yes`
instead: the same setup with the defaults, and no UI.

```text
Created workspace "app" (prefix APP) at /work/app/.staple/staple.db — registered in hub.
Wrote the agent protocol guide to /work/app/.staple/AGENTS.md — read it before working this repo.
Wrote /work/app/.staple/.gitignore so the database stays out of git; AGENTS.md is deliberately NOT ignored.
```

The prefix is the first three letters of the directory name, in capitals: tickets in
a repository called `app` are `APP-1`, `APP-2`, and in `payments-service` they are
`PAY-1`, `PAY-2`. If another repository on this machine already has
a workspace called `app`, `init --yes` stops with a `conflict`. Name this one yourself with
`staple init --yes --slug <name>`, and staple picks a prefix no other workspace uses
(`APPA`, for example).

Everything lives in a new `.staple/` folder:

- **Your tickets**, in one local file that git ignores.
- **`AGENTS.md`**, the working protocol for agents in this repository. Commit it.
  [How an agent works a ticket](working-a-ticket.md) explains what it is for.
- **`repository.json`**, which lets [cloud sync](cloud-sync.md) recognise the
  repository on another machine. Commit it.

Commit the folder (its own `.gitignore` keeps the tickets out) so every clone, and
every agent in it, gets the same protocol:

```bash
git add .staple && git commit -m "chore: set up staple"
```

## 2. Put `staple` on your PATH (optional)

`npx` runs staple without installing anything. To type `staple` instead, install a
runtime under your home directory (no `sudo`, with rollback):

```bash
npx staple-cli install --yes --update-path
```

The rest of the docs write `staple`. Without the install, read it as `npx staple-cli`.

## 3. Open the web UI

```bash
staple open
```

```text
staple ui — workspace "app" at http://localhost:4400/
```

The UI runs until you press Ctrl-C, on port 4400 or a free port if that one is busy.
It shows the board, the ticket tree, dependencies and every ticket's plan, worklog
and comments. [Tour](web-ui.md) covers each view.

## 4. File your first tickets

Create two tickets, the second waiting on the first:

```bash
staple new "Add a health check endpoint"
staple new "Document the endpoint" --blocked-by APP-1
staple inbox
```

```text
READY (pickup order):
  ◌  APP-1     backlog     Add a health check endpoint
BLOCKED:
  ◌  APP-2     backlog     Document the endpoint  [waiting on APP-1]
```

The inbox is what an agent reads first: READY is the work it may take, in order, and
BLOCKED is waiting on other work. When APP-1 is done, APP-2 moves to READY on its own.

## 5. Connect your agent

Wire Claude Code, Codex or another MCP client to staple, then ask your agent to take
the next ticket: [Connect your agent](connect-your-agent.md).

## Next

- [How an agent works a ticket](working-a-ticket.md): the loop your agents follow.
- [Plans become tickets](plans-to-tickets.md): turn a feature plan into an epic.
- [Configuration](configuration.md): machine preferences and workspace settings.

Going deeper: [packaging and install](../design/packaging.md) covers the runtime,
upgrades and rollback.
