---
title: Working with a teammate
description: Share one synced workspace with another person. They join by showing a short code that someone already in the workspace approves, so no secret travels over chat.
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

## 2. Let the repository say where the service is

```bash
staple cloud share-endpoint --yes
```

```text
Wrote .staple/repository.json. Commit it so teammates can `staple cloud join`.
```

Commit and push `.staple/repository.json`. It now carries the service address,
which is not a secret, so your teammate's `join` needs no arguments. Skip this
step if you'd rather send the address yourself: they then run
`staple cloud join --endpoint <url>`.

## 3. Your teammate joins

On their machine:

```bash
git clone <your-repo> && cd <your-repo>
staple init --yes
staple cloud join
```

`join` first shows the service, the repository and their device, with the
warning above, and waits for a yes. Nothing is sent before that. Then it shows a
code and waits:

```text
Your join code:

   ┌─────────────────────────┐
   │    G G Q Z - A A T R    │
   └─────────────────────────┘

Waiting for approval until 12:08:16 PM. Ctrl-C cancels; nothing is stored until approval.
```

In the web UI the same flow starts from **Join the shared workspace**, on the
empty task list or under **Settings → Cloud account**.

## 4. You approve

The code is not a password. It only names their request, so read it to each
other on a call, or compare it in chat. Then approve it:

```bash
staple cloud requests
staple cloud approve GGQZ-AATR --as marko
```

```text
Approved GGQZ-AATR: marko joins as a new member.
The joining terminal picks up its credential on its own within seconds.
```

In the web UI, a toast says **Join request** while automatic sync is on, and
**Settings → Members** lists every pending request with **Approve** and **Deny**.
Their terminal finishes on its own:

```text
Joined https://sync.example.com as marko.
Automatic sync is OFF. Run `staple cloud sync` to download the workspace.
```

Their device starts with automatic sync and backups off, like any new device.
They turn them on with `staple cloud auto on` if they want them.

To add **another device of your own**, run `staple cloud join` on it and
approve it from a device you already have with `--to <your name>`.

## 5. Split the work

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

## 6. See who did what

Every change carries the device that made it, stamped by the service, so it
cannot be faked. The web UI shows that device's member as a chip next to the
agent on activity, documents and comments: `VP claude-ab12 moved AII-14 to
in_review`. If two of you edit the same field while apart, staple keeps both
values for you to settle ([conflicts](cloud-sync.md#7-settle-conflicts)).

## 7. Remove someone

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

Agents may sync, read the member list and work tickets. They may not join,
approve, deny, rename or remove anyone. These are people's decisions, and there
is no MCP tool for them.

## Next

- [Cloud sync](cloud-sync.md): connecting, consents, backups and conflicts.
- [CLI reference](cli.md#cloud-sync): every `staple cloud` command at a glance.
