---
title: Epics and dependencies
description: Group work under epics, order it with dependencies, and read what is ready.
---

# Epics and dependencies

This page explains how epics group work and how dependencies decide what is
ready to pick up.

## What this page will cover

- Kinds: epics, tasks and your own kinds.
- Parents and children, and how an epic's status follows its children.
- Blocking one ticket on another (`staple blocked-by`), and when a ticket is ready to pick up.
- Statuses and the moves between them.

Until this page is written, the [CLI reference](cli.md#kinds) covers kinds and
the commands that set dependencies.

<!-- Source material for the rewrite: design/semantics.md (statuses, kinds, derived parent status, the blocks graph). -->
