---
title: Several repositories
description: Work across several repositories from one machine with the hub.
---

# Several repositories

This page explains how one machine works with several repositories: the hub
that registers each workspace, and how agents reach a workspace other than the
one they run in.

## What this page will cover

- The hub: the list of workspaces on this machine.
- Opening the web UI over every workspace.
- Pointing a command or an MCP call at another workspace.
- Blocking a ticket on a ticket in another repository.

Until this page is written, the [CLI reference](cli.md#the-machine-registry)
covers the hub commands.

<!-- Source material for the rewrite: design/architecture.md, "Workspace topology"; design/sync.md, "The hub registry is a set, not a map". -->
