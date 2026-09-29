---
title: Approval gates
description: Hold an epic for your review before agents go on, then approve it, let part of it through, or send it back.
---

# Approval gates

Use a gate when agents should stop and wait for you: to check a design before the
rest of an epic is built on it, or to sign off a feature before it counts as done. A
gate holds an epic (or any ticket with children) on a named person. Until that person
approves, no agent can start the work under it, and the epic cannot close.

The example continues the password reset epic from
[Plans become tickets](plans-to-tickets.md). The tokens ticket, APP-2, is done, and you
want to review the token design before the email and the form are built on it.

## 1. Gate the epic

```bash
staple gate APP-1 --owner VP -m "Review the token design before the email and form go on"
```

```text
⊙  APP-1     awaiting_approval Password reset · epic  [awaiting VP]
```

An agent can ask for your review the same way, with MCP `gate_task`. In the web UI,
**Ask for approval…** in a task's menu opens the same request.

A gate goes on a ticket with children. For a single ticket that is finished and waits
for you to look, move it to `in_review` instead.

## 2. What agents see while it waits

Everything open under the epic moves out of the ready list:

```text
READY (pickup order):
  (nothing ready)
QUEUED (waiting on a human — checkout is refused):
  ⊙  APP-1     awaiting_approval Password reset · epic  [awaiting VP]
  ○  APP-6     todo        Rate-limit reset requests per address  [awaiting VP on APP-1]
  ◌  APP-3     backlog     Send the reset email  [awaiting VP on APP-1]
  ◌  APP-4     backlog     Reset form sets the new password  [awaiting VP on APP-1]
  ◌  APP-5     backlog     Document the reset flow  [awaiting VP on APP-1]
```

An agent that tries to take one is refused with exit code 9, and told to take
something else:

```text
error(gated): APP-3 is queued behind APP-1, awaiting approval by VP. Pick a different task — approval is a human action, not a retry.
```

`.staple/AGENTS.md` teaches agents that `gated` means stop and move on, never retry. An
agent already working a ticket when the gate went up may finish it.

## 3. Review it

`staple show APP-1` shows the gate, the epic's documents and every ticket under it.
In the web UI, open the epic: a **Review gate** block sits at the top of the task
detail, with the held tickets as a checklist. Group the Tasks view by *Pickup order*
to see every gate waiting for you first, under *Pending approval*.

## 4. Decide

You have three answers.

**Approve all of it.** Every held ticket goes back to the ready list, and the epic
takes the status its tickets give it (done, if they all finished while you read):

```bash
staple approve APP-1          # MCP approve_task
```

```text
◌  APP-1     backlog     Password reset · epic  [gate approved]
```

**Let part of it through.** Name the tickets that may go on. They and everything under
them are released; the rest stay held and the gate stays open:

```bash
staple approve APP-1 --children APP-6
```

```text
⊙  APP-1     awaiting_approval Password reset · epic  [released APP-6; still awaiting VP]
```

**Send it back.** Your note is stored as a comment on the epic, the epic returns to
`todo`, and the held tickets stay held:

```bash
staple request-changes APP-1 -m "Tokens must be hashed at rest. Fix that first."   # MCP request_changes
```

```text
○  APP-1     todo        Password reset · epic  [changes requested; children stay queued]
```

In the web UI these are **Approve all**, **Approve selected** and **Send back**, which
asks for the note before it sends. Each asks you to type your name as the signer.

## 5. Resubmit after changes

An agent reads your note on the epic, does the fix (usually as a new ticket under it),
and gates the epic again for your second look:

```bash
staple gate APP-1 --owner VP -m "Tokens are hashed now"
```

Approving that gate ends the cycle. A new gate can go on the same epic any time
later, for the next review.

## Good to know

- Only `gate`, `approve` and `request-changes` move a ticket into or out of
  `awaiting_approval`. `staple status` refuses, so nobody drains a gate by accident.
- A gate on a [milestone](milestones.md#7-sign-it-off) holds the
  milestone's close for your sign-off, and leaves its members free to be worked.
- An [autopilot run](runs.md) stops when it reaches work only your gate can release,
  and tells you which gate.

## Next

- [Epics and dependencies](epics-and-dependencies.md): blocks, statuses and what is ready.
- [The pickup queue](queue.md): set the order agents take work in.
- [Autopilot runs](runs.md): let an agent work an epic until your review is needed.
