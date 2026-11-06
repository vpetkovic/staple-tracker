---
title: Working with a teammate
description: Share one synced workspace with another person. Send them a link, they show a short code, you approve it, and from then on both machines stay in sync on their own.
---

# Working with a teammate

Use this page when someone else should work on the same tickets as you: a friend
on a side project, or a colleague on a small team. Each of you keeps your own
copy of the tickets, your own agents and your own web UI. The sync service keeps
the copies in step, and it knows who is who.

You need a workspace that is already connected to a sync service
([Cloud sync](cloud-sync.md)). The person who connected it first is its
**owner**.

> [!WARNING]
> Synced data is not encrypted end to end. Whoever runs the sync service can
> read the tickets, and so can every member of the workspace. Tell your
> teammate before they join.

## Who can do what

| | Owner | Member | Agent |
| --- | --- | --- | --- |
| Approve a new person | yes | no | no |
| Add another device of their own | yes | yes | no |
| Remove one of their own devices | yes | yes | no |
| Remove another member | yes | no | no |
| Restore a backup or purge the service | yes | no | no |

Members have names, not accounts. A member owns one or more devices, so your
laptop and your desktop are both you. The service checks every one of these
rules; the CLI and the web UI only hide what you cannot do.

## 1. Name yourself (owner, once)

The first device to connect becomes the owner, listed as `owner`. Give it your name:

```bash
staple cloud members rename owner VP
```

```text
Renamed owner to VP.
```

## 2. Send your teammate a link

In the web UI open **Settings → Members → Invite someone**, type their name if
you like, and press **Generate**. Copy the link, the terminal command, or a
ready-to-send message, and send it however you talk to them. From a terminal:

```bash
staple cloud share --as marko
```

```text
Hi marko, VP invited you to the Staple workspace "ai-inbox-supabase".

Open this link to join:
https://sync.example.com/join/1a06b9f7-…?n=ai-inbox-supabase&p=AII&by=VP&as=marko

Or paste this into a terminal:
staple cloud join 'https://sync.example.com/join/1a06b9f7-…?n=ai-inbox-supabase&p=AII&by=VP&as=marko'
```

The link holds no secret. It names the service, the workspace and who invited
whom. Nobody gets in without the approval in step 4, so a link that leaks admits
nobody.

## 3. Your teammate joins from the link

They don't need a clone. Opening the link shows a page with **Open in Staple**
and the same command to copy. Either one shows a preview first: your name, the
workspace's name, the service, their device, and that automatic sync will be on.
Nothing is sent before they agree. Then their device shows a code and waits:

```text
Your join code:

   ┌─────────────────────────┐
   │    1 D C 9 - S C R M    │
   └─────────────────────────┘
```

If they run the command inside a clone of the repository, staple uses that
clone. Otherwise it creates the workspace on their machine with your workspace's
name, so they see `ai-inbox-supabase` exactly as you do.

## 4. You approve

The code is not a password. It only names their request, so read it to each
other on a call, or compare it in chat. In the web UI a toast says
**Join request**, and **Settings → Members** lists it with the name from your
invite already filled in. From a terminal:

```bash
staple cloud requests
staple cloud approve 1DC9-SCRM            # takes the name from the invite
```

Their side finishes on its own, opens the workspace, and starts syncing.

## 5. A shared workspace always syncs

Once a workspace has two or more members, every device in it syncs
automatically, the owner's included. A change on one machine reaches the other
within about half a minute with the web UI open, and at the next command
otherwise. Nobody has to run `staple cloud sync`. Turning it off is refused:

```text
error(forbidden): Automatic sync is on because this workspace is shared with marko;
every device keeps it on, so nobody works on a stale copy. To stop syncing, leave
the workspace or run `staple cloud disconnect`.
```

You can always tell a shared workspace apart. The web UI shows
**⇄ Shared · 2 members** with each member's initials and a sync dot next to the
workspace name, and the workspace switcher marks it **⇄ shared**. The command
line starts `ls`, `inbox` and `cloud status` with:

```text
shared with marko · syncing automatically
```

To add **another device of your own**, open the same kind of link on it (or
run `staple cloud join`) and approve it from a device you already have with
`--to <your name>`.

## 6. Split the work

Assign tickets to members by name. The assignee picker in the web UI lists the
members first, and `--assignee marko` works on the command line.

- **Mine / All.** The task list has a Mine/All toggle. Mine hides tickets
  assigned to the other members, so it shows yours and the unassigned ones.
  `staple ls --mine` and `staple inbox --mine` do the same.
- **Pickup.** `staple queue next`, and every agent that asks for the next ticket,
  skip tickets assigned to another member:

  ```text
  skipped AII-4 (assigned to marko)
  ```

  `--any-assignee` turns that off for one call.
- **Claims.** An agent that takes your ticket keeps your name on it, so the row
  reads `VP · claude-ab12 Working`. When a claim must hold across both machines,
  take a lease: `staple cloud lease acquire AII-21`.

## 7. See who did what

Every change carries the device that made it, stamped by the service, so it
cannot be faked. The web UI shows that device's member as a chip next to the
agent on activity, documents and comments: `VP claude-ab12 moved AII-14 to
in_review`. If two of you edit the same field while apart, staple keeps both
values for you to settle ([conflicts](cloud-sync.md#7-settle-conflicts)).

## 8. Remove someone

Only the owner removes a member, and must type the name back:

```bash
staple cloud members remove marko --confirm marko
```

```text
Removed marko. 1 device(s) lose access on their next request.
They keep their local data. Their past work stays attributed to them.
```

On their machine, the next sync stops with
`removed from this workspace by VP`, and `staple cloud status` says so too. To
let them back in, they run `staple cloud join` again and you approve it with
`--as marko`. They come back as the same member, with their history.

## What agents may do

Agents may sync, read the member list and work tickets. They may not share, join,
approve, deny, rename or remove anyone. These are people's decisions, and there
is no MCP tool for them.

## Next

- [Cloud sync](cloud-sync.md): connecting, consents, backups and conflicts.
- [CLI reference](cli.md#cloud-sync): every `staple cloud` command at a glance.
