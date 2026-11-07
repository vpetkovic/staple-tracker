---
title: The plan
sidebar_label: The plan
description: Keep ideas out of the task list. Let them mature, put them on horizons and a timeline, and start them as epics when they are ready.
---

# The plan

Use the plan for work you have not committed to yet. Ideas live above the tracker: they never
show up in the task list, the queue or an agent's `next`. You let an idea mature, give it a
horizon and dates when you know them, and start it as an epic when it is ready. From then on
its progress and real dates come from that work.

## 1. Turn planning on

Open **Plan** in the web UI and press **Turn on planning**, or run:

```bash
staple plan enable
```

This adds the `idea` and `horizon` kinds and three horizons: Now, Next and Later.

## 2. Capture and shape ideas

Type in **Capture an idea** and press Enter. A new idea is **raw**. Drag it to **Exploring**
while questions are open and to **Shaped** when the scope is clear, or use the card's menu.
Open an idea to write its brief, add open questions, tick them off and record decisions.

Agents capture too:

```bash
staple idea new "Coach shares a program by link" --brief "Read-only link, no account needed"
staple idea ask PRJ-41 "Expire links after 30 days?"
```

## 3. Schedule on horizons

In the **Horizons** lens, drag a shaped idea from Unscheduled into a horizon. Give a horizon a
date (**add a date**) and it becomes a release line; ideas past it are flagged. Add, rename and
remove horizons from the column header and **+ Horizon**. Removing a horizon returns its ideas
to Unscheduled.

Maturity and horizon are separate: an exploring idea on Next is a reserved slot; a shaped idea
with no horizon is ready whenever you are.

An idea can have sub-ideas (open it and set **Part of**). They fold under the parent's card,
with a summary such as "1 late · 6 not started". A sub-idea on a different horizon shows in
that column, marked with its parent.

## 4. Plan dates on the timeline

The **Timeline** lens shows each idea's planned window as a bar, grouped by horizon. Drag a
bar to move it and drag its ends to change the dates. Ideas without dates are listed under
their horizon with **add dates**. The vertical lines are today and each dated horizon.

## 5. Start the work

Open an idea and press **Start as an epic**: staple creates an epic, stores the brief on it as
its `plan` document, and links it. Or **Adopt** an issue that already exists. An idea can link
several. From then on the idea reads **started**, then **shipped** when everything linked is
done, and the timeline adds the real dates from that work: a solid bar for what has happened,
a dashed one to the forecast end, hatched where it runs past the plan.

The window an idea has when it starts is kept as its **baseline**. If you re-plan later, the
timeline keeps the baseline as an outline behind the new plan, so a slip stays visible. Press
**Reset to the plan** in the idea to make the current window the new baseline.

## Late and not started

- **late** (red): linked work finished, or is forecast to finish, after the planned end or the
  horizon's date, or that day has passed while it is still open.
- **not started** (amber): nothing is linked yet and the planned start has passed.

## Who decides what

Agents capture ideas, edit titles and briefs, add and resolve questions, record decisions, and
adopt or unlink work. They can start an idea only once you have marked it shaped. Maturity,
horizons, dates, order and the baseline are yours: you set them in the Plan view, or on the
command line with `--person`, which records the change under your name
(`staple config set humanName "Your Name"` first):

```bash
staple idea set PRJ-41 --maturity shaped --horizon Next --start 2027-01-05 --target 2027-02-12 --person
staple horizon new "Q2" --date 2027-06-30 --person
```

An agent trying any of these gets a `validation` refusal that says so.

## Reference

| CLI | MCP | What |
|---|---|---|
| `staple idea ls`, `staple plan show` | `list_ideas` | The plan: horizons and ideas with stage and flags |
| `staple idea show` | `get_idea` | One idea with its brief, questions, decisions and links |
| `staple horizon ls` | `list_horizons` | Horizons in order |
| `staple idea new` | `capture_idea` | Capture a raw idea |
| `staple idea set`, `ask`, `resolve`, `decide` | `update_idea` | Edit an idea |
| `staple idea start`, `adopt` | `start_idea` | Start an epic, or adopt an issue |
| `staple idea unlink` | `unlink_idea` | Remove a link |
| `staple idea reset-baseline --person` | `reset_idea_baseline` (view button only) | Make the current window the baseline |

The design contract is [design/plan.md](https://github.com/vpetkovic/staple-tracker/blob/master/design/plan.md).
