---
title: Plans become tickets
description: Turn a feature plan into an epic with tickets and dependencies, keep the plan on the epic, file new work mid-flight, and see what is next.
---

# Plans become tickets

Use this page when a brainstorm or implementation plan is ready to build. Instead of
a Markdown file whose checkboxes drift, the plan becomes an epic with one ticket per
step and the dependencies between them. Agents work through the tickets, new work
found on the way joins the same epic, and at any moment you can see what is done and
what comes next.

The example is a small feature, password reset, in a repository whose prefix is APP.
Every output below is from a real run, trimmed.

## 1. Start from the plan

Here is the plan, as an agent or you might write it after a brainstorm:

```markdown
# Password reset

Goal: a user who forgot their password can set a new one from an emailed link.

1. Reset tokens: single-use, expire after 30 minutes.
2. Reset email: sends the link. Needs 1.
3. Reset form: checks the token and sets the new password. Needs 1.
4. Docs: the reset flow in the user guide. Needs 2 and 3.
```

Each numbered step becomes a ticket, and each "Needs" becomes a dependency.

## 2. Create the epic and store the plan on it

```bash
staple new "Password reset" --kind epic
staple doc APP-1 plan --put reset-plan.md
```

```text
◌  APP-1     backlog     Password reset · epic
plan @ revision 1
```

The plan now lives on the epic as a document with a revision history, where every
agent that opens the epic finds it. Once it is stored, the Markdown file can go.

## 3. Add a ticket per step, with its dependencies

```bash
staple new "Issue single-use reset tokens" --parent APP-1 --estimate 2h
staple new "Send the reset email" --parent APP-1 --blocked-by APP-2
staple new "Reset form sets the new password" --parent APP-1 --blocked-by APP-2
staple new "Document the reset flow" --parent APP-1 --blocked-by APP-3,APP-4
```

`--parent` puts the ticket under the epic, and `--blocked-by` says what must be done
first. An estimate is optional; give one if you want to compare it with what the work
took.

You do not have to type this yourself. Give your agent the plan and ask:

> Turn this plan into a staple epic, with a ticket per step and the dependencies between them. Store the plan on the epic.

It does the same through MCP: `create_task` with `kind`, `parent` and `blocked_by`,
then `put_document` for the plan.

## 4. Check the shape

```bash
staple tree APP-1
staple inbox
```

```text
◆ ◌  APP-1     backlog     Password reset · epic
  ◇ ◌  APP-2     backlog     Issue single-use reset tokens
  ◇ ◌  APP-3     backlog     Send the reset email
  ◇ ◌  APP-4     backlog     Reset form sets the new password
  ◇ ◌  APP-5     backlog     Document the reset flow

READY (pickup order):
  ◌  APP-1     backlog     Password reset · epic
  ◌  APP-2     backlog     Issue single-use reset tokens
BLOCKED:
  ◌  APP-3     backlog     Send the reset email  [waiting on APP-2]
  ◌  APP-4     backlog     Reset form sets the new password  [waiting on APP-2]
  ◌  APP-5     backlog     Document the reset flow  [waiting on APP-3, APP-4]
```

Apart from the epic itself, only the tokens ticket can start. The rest wait, and each
says on what. Agents take the tickets, not the epic: `queue next` never hands it out. The web UI
shows the same thing as a tree and as a dependency graph.

## 5. Let agents work through it

Point one agent, or several, at the epic. Each asks what to take next within it, and
works that ticket through [the loop](working-a-ticket.md):

```bash
staple queue next --scope APP-1     # MCP next_task with scope "APP-1"
```

When APP-2 is done, both APP-3 and APP-4 become ready, so two agents can work in
parallel. Here a second agent asks while the first holds APP-3:

```text
scope    APP-1 (epic) Password reset
skipped  APP-3     claimed   APP-3 is held by claude.
next     APP-4 (position 2) Reset form sets the new password
```

Each agent stores its own plan and worklog on its ticket, so the epic's plan stays the
feature's plan and every ticket carries the detail of its own step.

## 6. File new work under the same epic

Halfway through the reset email, the agent notices that nothing stops a script from
mailing one address a thousand times. That was not in the plan. Rather than widen
its ticket or leave a note in a file, it files a ticket under the epic:

```bash
staple new "Rate-limit reset requests per address" --parent APP-1 \
  -d "Found while building the reset email: nothing stops a script from mailing one address a thousand times."
staple comment APP-3 "filed APP-6 for rate limiting; out of scope here"
```

The new ticket is part of the feature from that moment: it shows in the tree, the
inbox and the web UI, and the epic is not finished until it is. If other work must
wait for it, add it with `staple blocked-by`.

## 7. See where the feature stands

```bash
staple show APP-1
```

```text
◆ APP-1 · Password reset
status in_progress (v3) · kind epic · priority medium

children:
  ◇ ●  APP-2     done        Issue single-use reset tokens @claude
  ◇ ◐  APP-3     in_progress Send the reset email @claude
  ◇ ◌  APP-4     backlog     Reset form sets the new password
  ◇ ◌  APP-5     backlog     Document the reset flow
  ◇ ◌  APP-6     backlog     Rate-limit reset requests per address

documents: plan@r1
```

Done, in progress, waiting, and the ticket filed on the way, in one place. `staple
inbox` answers what can start now.

## 8. The epic closes itself

You never close the epic by hand. When the last ticket under it is done, it goes
`done` too:

```text
◆ ●  APP-1     done        Password reset · epic
  ◇ ●  APP-2     done        Issue single-use reset tokens @claude
  ◇ ●  APP-3     done        Send the reset email @codex
  ◇ ●  APP-4     done        Reset form sets the new password @claude
  ◇ ●  APP-5     done        Document the reset flow @codex
  ◇ ●  APP-6     done        Rate-limit reset requests per address @codex
```

APP-3 finished under Codex because Claude's session ended while it held it, and Codex
took the ticket over ([Handoff and resume](handoff.md) shows how). What is left is a
summary: what shipped and what was deliberately left out.
Ask the agent that finishes last to write it as a comment on the epic, or add it
yourself with `staple comment APP-1 "…"`.

## Next

- [Epics and dependencies](epics-and-dependencies.md): statuses, kinds and dependency rules.
- [Milestones](milestones.md): put a date and goal criteria on one or more epics.
- [The pickup queue](queue.md): decide which epic agents take first.
- [Autopilot runs](runs.md): let one agent work the whole epic, ticket after ticket.
