---
title: Cloud sync
description: Share one workspace between machines through a sync service, with three separate consents, conflicts you settle yourself, and clear lines between disconnecting and destroying.
---

# Cloud sync

Use cloud sync when the same repository's tickets need to be on more than one
machine: your laptop and a build box, or two people's machines. Each machine keeps
its own copy of the tickets and works offline as usual; syncing exchanges the changes
through a sync service you run. Sync is optional and off until you turn it on.
A workspace that was never connected makes no network request at all.

**What travels:** tickets, comments, documents, statuses and kinds, dependencies,
gates, the pickup queue, milestones, workspace settings, and the record of agent
work that estimates are measured against.
**What stays on the machine:** your credential and consents, provider budget
readings, autopilot runs, and file paths.

> [!WARNING]
> Synced data is not encrypted end to end. Whoever runs the sync service can read
> it. Run it on an account you trust.

## Before you start

The first machine needs the service's address (the endpoint) and the repository's
enrollment secret from whoever set the service up. Every machine after that joins by
approval instead, with no secret ([step 6](#6-add-a-device)). Commit
`.staple/repository.json` (the setup in [Install and first workspace](getting-started.md)
does): it is how every clone recognises the same repository, and it holds no secret.

## 1. See where you stand

```bash
staple cloud status          # MCP cloud_status
```

```text
not connected — no credential, no endpoint and no cloud state on this machine

  repository     6cfd92b6-5527-47ec-9549-563c5a2bfdbb
  pending        0
  cursor         none yet
  epoch          0
  checked        local files only (--refresh to ask the endpoint)

  Connect with: staple cloud connect --endpoint <url> --token <secret>
```

`status` reads local files only; `--refresh` asks the service. Once connected,
`pending` counts the changes waiting to be sent, and `cursor` and `epoch` show how far
this machine has caught up. `--all` lists every workspace on this machine.

## 2. Connect: the first consent

```bash
staple cloud connect --endpoint https://sync.example.com --token <enrollment-secret>
```

Before anything is sent, staple shows the service, the repository and this device,
and waits for your yes; without a terminal it only prints that preview. The
credential goes into your OS keychain (or a private file with `--credential-file`),
never into the repository.

A new connection is **manual**: nothing syncs until someone asks.
`staple cloud connect --all …` connects every workspace on this machine in one
go, after showing the list.

In the web UI the same steps are under **Settings → Cloud account** and, per
workspace, **Settings → Cloud sync**.

## 3. Sync

```bash
staple cloud sync            # or --all for every connected workspace
```

This sends what changed here and applies what the other machines did. An
interrupted sync picks up where it stopped.

## 4. Sync automatically: the second consent

```bash
staple cloud auto on
```

This device then syncs on its own when a command starts, after a write, and
during long sessions. A failed sync never blocks a command. `staple cloud auto off`
stops it without disconnecting.

## 5. Keep backups: the third consent

```bash
staple cloud backup enable
staple cloud backup create --label "before the big refactor"
staple cloud backup ls
```

Backups are point-in-time copies on the service, for disaster recovery. Disabling
stops new backups and deletes none.

**The three consents are separate and per device.** Connecting does not turn on
automatic sync or backups, and turning either on for your laptop does not turn it
on for the build box. Each is withdrawn on its own: `cloud disconnect`,
`cloud auto off`, `cloud backup disable`.

## 6. Add a device

The first machine to connect becomes the workspace's **owner**, listed as `owner`
until you rename it (`staple cloud members rename owner <your name>`). Every other
machine, yours or a teammate's, joins by approval. Nobody hands out a secret.

On the new machine:

```bash
git clone <your-repo> && cd <your-repo>
staple init --yes
staple cloud join            # --endpoint <url> if the repository does not name one
```

`join` shows the service, the repository and this device, and waits for your yes.
Then it shows a short code and waits. On a machine that is already connected,
approve it:

```bash
staple cloud approve GGQZ-AATR --to VP          # another device of yours
staple cloud approve GGQZ-AATR --as marko       # a new person (owner only)
```

The code only names the request. The new machine picks up its own credential once
it is approved, and `staple cloud sync` fills it with the shared tickets.
`staple cloud share-endpoint` writes the service address into
`.staple/repository.json`, so `join` needs no arguments. Working with another person
has its own page: [Working with a teammate](working-with-a-teammate.md).

This machine starts manual too: give its own consents with `cloud auto on` and
`cloud backup enable` if you want them here.

A copy of your staple home (`~/.staple`) restored onto another machine is not a
new device: sync refuses on it and `cloud status` says why. Join as above instead,
or run `staple cloud fork-id` to make the copy an independent workspace.

## 7. Settle conflicts

When two machines change the same field to different values while apart, staple
keeps both and applies neither. Everything else keeps syncing.

```bash
staple cloud conflicts                          # MCP conflict_list
staple cloud resolve <id> --take local          # keep this machine's value
staple cloud resolve <id> --take remote         # take the other machine's
staple cloud resolve <id> --value "New title"   # write a third answer
```

```text
No open conflicts.
```

Your choice syncs to every device as a new change (MCP `conflict_resolve`).
`cloud conflicts --all` also lists the settled ones and who chose what.

## 8. Claims across machines

A plain `staple start` claims a ticket on this machine only; another machine
may take it until the next sync. When that matters, take a lease, which the
service grants to one machine only:

```bash
staple cloud lease acquire APP-3
staple cloud lease release APP-3
```

`ls`, `show` and the MCP `claim` object say which kind of claim is held: `local`
or `lease`.

## 9. Disconnect, revoke, restore, purge

| Command | What it does | Undo |
| --- | --- | --- |
| `staple cloud disconnect` | Removes this machine's credential and stops its sync traffic. Local data, pending changes and the service's copy are untouched. | Connect again |
| `staple cloud devices revoke <id>` | **Destructive for that device.** Ends a device's access on the service, from its next request. Use it for a lost or retired machine. Members revoke their own devices; the owner can revoke any, except their own last one. | Join it again (`staple cloud join`) |
| `staple cloud members remove <name> --confirm <name>` | **Owner only.** Ends every device of that member. Their local copy stays, and their past work keeps their name. | Approve a new join `--as <name>`: they come back as the same member |
| `staple cloud restore <backupId> --confirm <repositoryId>` | **Destructive, owner only.** Puts the whole repository back to the backup on every device and discards everything synced since. Takes a backup first. | Restore that pre-restore backup |
| `staple cloud purge --confirm <repositoryId>` | **Destructive and final, owner only.** Deletes everything the service holds for the repository, backups included. Each machine keeps its local tickets. | None |

`staple cloud devices` lists the devices first. Both restore and purge print what
they will do and want the repository id typed back.

## What agents may do

- **May:** check `cloud_status`, list and settle conflicts, run `staple cloud sync`,
  and take a lease when a claim must hold across machines.
- **May not:** connect, join, approve or deny a join, rename or remove a member,
  disconnect, switch automatic sync or backups, revoke a device, restore or purge.
  These are a person's decisions, and have no MCP tool.

## Next

- [Working with a teammate](working-with-a-teammate.md): share a workspace with another person.
- [Several repositories](hub.md): one machine, many workspaces.
- [Handoff](handoff.md): hand a ticket from one session or machine to another.
- [CLI reference](cli.md#cloud-sync): the `staple cloud` commands at a glance;
  `staple cloud --help` lists every one.

Going deeper: [the sync design](../design/sync.md) covers the service, self-hosting
and the protocol.
