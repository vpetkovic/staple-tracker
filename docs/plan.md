---
title: The plan
sidebar_label: The plan
description: Keep ideas out of the task list. Let them mature, put them on horizons and a timeline, and promote them to epics when they are ready.
---

# The plan

Use the plan for work you have not committed to yet. Ideas live above the tracker: they never
show up in the task list, the queue or an agent's `next`, and they take no ticket number. You
let an idea mature, give it a horizon and dates when you know them, and promote it to an epic
when it is ready. From then on its progress and real dates come from that work.

## 1. Turn planning on

Planning is **experimental** and may change. The workspace setting `features.planning`
defaults to **false** and synchronizes across devices. In **Settings → Experimental**, turn
on **Planning (experimental)**. At the terminal, a person with a configured humanName can run:

```bash
staple settings set features.planning true --person
```

`staple plan enable --person` sets the same flag. Agents read it with `get_setting` or
`staple settings get features.planning`; they cannot change it. `show_about` reports its state.

With the flag off, Plan and its lenses, drawer tabs, palette commands and Tasks horizon
chip, axis and filter are absent. CLI, MCP and HTTP planning operations refuse. Pickup
answers and run briefs carry no horizon-run instructions. Existing horizons appear as
plain milestones and promoted epics as ordinary epics. Ideas remain unnumbered drafts,
never tasks or pickup work. Disabling deletes nothing; enabling restores all planning data.

This adds the `idea` and `milestone` kinds and two horizons: Now and Next. A horizon
is a milestone, so it also shows under **Milestones** with its progress, and queueing it queues
its ideas' work.

## 2. Capture and shape ideas

Type in **Capture an idea** and press Enter. A new idea is **raw**. Drag it to **Exploring**
while questions are open and to **Shaped** when the scope is clear, or use the card's menu.
Open an idea and it opens in the same panel as any task, with the tabs an idea needs: **Plan**
(its brief, open questions, decisions, horizon, dates and linked work), Connections, Documents,
Files, Activity, For agents and Time. An idea shows no ticket number until it is promoted.

Agents capture too. An idea has no ticket number yet, so on the command line you name it by
the id `staple idea ls` prints:

```bash
staple idea new "Coach shares a program by link" --brief "Read-only link, no account needed"
staple idea ask <id> "Expire links after 30 days?"
```

## 3. Schedule on horizons

The **Ideas** lens is for thinking: it holds ideas that are raw or exploring, each card showing
how much of its plan is written (★ for the three sections shaping needs) and the horizon it is
aimed at. Marking an idea shaped hands it over: the **Horizons** lens is for delivery, shaped,
started and shipped work by horizon, with shaped work that has no horizon under *Unscheduled*
(*Ready, no horizon yet*). A shaped idea whose plan has gone incomplete since is flagged there
and cannot be scaffolded until it is complete again.

In the **Horizons** lens, drag a shaped idea from Unscheduled into a horizon. Give a horizon a
date (**add a date**) and it becomes a release line; ideas past it are flagged. Add, rename and
remove horizons from the column header and **+ Horizon**. Removing a horizon returns its ideas
to Unscheduled. A horizon that still holds open work, or that is in the queue, cannot be removed
until you move that work or take it off the queue; the refusal names what to move. Cancelling
a horizon's work never removes the horizon: with nothing open or done left in it, it reads as
planned, and it ships when work in it is done.

The work of every idea on a horizon is that milestone's membership: you never add it by hand.
Move an idea to another horizon and its work moves with it. Something you placed in a milestone
yourself stays where you put it.

Maturity and horizon are separate: an exploring idea on Next is a reserved slot (it stays in
Ideas, with a ◇ Next chip); a shaped idea with no horizon is ready whenever you are.

Each horizon's header shows its progress, how many records on it shipped (✓ 2 shipped), what is
late or not started (counting work added to it by hand and ideas still being explored), and two
buttons. **Queue** puts the whole horizon in the pickup queue, exactly as queueing a task does (it
reads *Queued* once it is there). The second is its **run setting**: how far agents take the
horizon when they pick its work up, and its goal (a list of criteria). Nothing starts from it; it
is a setting agents read with every ticket of the horizon:

- **Until its work is done**: agents take its work from the queue until every member has landed,
  and it ships with the last one.
- **Until its goal is met**: agents work toward the goal, check each criterion, and may add the
  tickets it still needs; then it waits for your approval to close (*Waiting for your approval*).
- **Stop for review after each epic**: agents finish one epic and stop until you release the next.

Only you set it (the CLI: `staple horizon set Now --run goal --goal "Checkout works end to end"
--person`). A shipped record reads the same everywhere, with ✓ and the date it shipped; a horizon
whose work has all landed folds to a ✓ summary.

A horizon without a run setting is worked through the queue, as any milestone. A goal run is
allowed only after the person explicitly selects the goal mode. Stopping a goal run leaves its
approval gate standing: stopping execution does not approve the goal. The horizon stays open and
reads "Waiting for your approval" until the person approves or requests changes. Work and epic
modes do not create this goal gate. A pending gate takes precedence over a completed progress bar
in the board, drawer and timeline.

In **Tasks**, every task whose work belongs to a horizon shows a ◇ chip with the horizon's name
(a short one on a phone; tap it for the whole name), **Group: Horizon** sections the list by
horizon, and the **Horizon** filter keeps the work of the horizons you pick. Horizons themselves
are not rows in Tasks: they are the sections and the chips. Plain milestones still are.

An idea can have sub-ideas (open it and set **Part of**). They fold under the parent's card,
with a summary such as "1 late · 6 not started". A sub-idea on a different horizon shows in
that column, marked with its parent.

## 4. Plan dates on the timeline

The **Timeline** lens shows each idea's planned window as a bar, grouped by horizon. Drag a
bar to move it and drag its ends to change the dates. Ideas without dates are listed under
their horizon with **add dates**. The vertical lines are today and each dated horizon. An arrow
runs from an idea to each idea that waits on it, red when the one waiting starts first; a
shipped bar ends in ✓. A dependency counts when a line of the Dependencies section starts with
the other idea's ticket number, the key its title starts with (C2 in "C2 Checkout API"), or a row
key from its breakdown (42.1). Other words are left as text, even ones with digits like OAuth2.

## 5. Write the plan

An idea is a plan an agent can build from. Its **Plan** tab holds the sections: Goal, Context
and constraints, Decisions, Open questions, the **Task breakdown** (a row per task: key, title,
estimate, what it waits on, when it is done, owner, notes), Acceptance criteria, Dependencies,
Out of scope, Risks, and Sources and files. The three marked ★ are required before it can be
shaped: a goal, a breakdown of titled rows, and acceptance criteria. A row without its own "done
when" inherits the plan's acceptance criteria and says so; its task is labelled
`acceptance-inherited` until someone sharpens it. Rows may not wait on a key the breakdown does
not hold, or on each other in a circle. Every open question must be answered or deferred too.
The meter at the top says what is still missing. If a shaped idea is edited so it no longer
passes, it stays shaped and reads **shaped · plan incomplete**, with Scaffold and Promote held
back until it passes again.
Each section reads as formatted text (headings, lists, quotes, tables); press **Edit** beside a
section to change it, click away to save, or press Escape to put it back.

Agents can write all of it. A plan you already have as a file comes in whole:

```bash
staple idea import Plans/PLAN-7-checkout.md --parent <id> --horizon Now --maturity exploring --person
```

It reads the headings and task tables, attaches the file, and lists anything it kept in Context
instead of the section it was under.

## 6. Start the work

Open a shaped idea and press **Scaffold epic and tasks**. It shows first what it will create, and
confirming creates exactly that: if the plan changed since the preview, the confirm is refused
and you preview again. The preview shows
the epic (this same record, now with a ticket number) and a task for every breakdown row, with
its estimate, what it waits on, and when it is done. Confirm, and each task gets those fields and
a context page, so an agent can work it from the ticket alone. Shaped sub-ideas become child
epics the same way. A sub-idea can be scaffolded before its parent; its epic moves under the
parent's once the parent is scaffolded too, and nothing is created twice. Scaffolding again creates only rows written since. **Promote to epic** does
the promotion alone: the idea itself becomes the epic and takes its ticket number now. Its brief, questions, decisions, comments and history stay on it, and on a
horizon it joins that horizon's milestone. Break it into tickets as you would any epic. A
sub-idea can be promoted on its own; when its parent is promoted later, the sub-idea's epic
moves under the parent's. Or **Adopt** an issue that already exists; an idea can link several,
promoted or not. From then on the idea reads **started**, then **shipped** when all of its work
is done, and the timeline adds the real dates from that work: a solid bar for what has happened,
a dashed one to the forecast end, hatched where it runs past the plan.

A parent's state is its own. Work under its sub-ideas shows on the parent as progress, dates
and late or not-started counts, but it never starts, ships or reopens the parent, and dropping a
parent leaves its sub-ideas as they are. A promoted idea is an ordinary epic: its title, brief
and documents can be edited even once it has shipped.

The window an idea has when it starts is kept as its **baseline**. If you re-plan later, the
timeline keeps the baseline as an outline behind the new plan, so a slip stays visible. Choose
**Reset baseline to the plan** in the idea's ⋯ menu to make the current window the new baseline.

## What each state offers

An idea offers only the actions that fit where it stands, and every button, menu and command
follows the same rules:

| State | You can |
|---|---|
| Raw | edit it, ask and decide, start exploring, drop it, move it under another idea |
| Exploring | everything raw can, plus reserve a horizon and plan dates, then mark it shaped |
| Shaped | schedule and date it, scaffold or promote it, adopt existing work, or send it back to exploring |
| Started | re-plan it, adopt more work, unlink work, reset the baseline, open the epic |
| Shipped | open the epic, or link more work (open work reopens it); nothing is edited any more, not its documents or files either |
| Dropped | restore it |

A raw idea is never scheduled or promoted, and an idea already started or promoted never offers
promotion again. A horizon can be queued or run to its goal while it holds open work, and removed only once it
holds no open work and is not in the queue. Ask for something a state does not offer and the refusal names the state and what it
offers instead.

## Late and not started

- **late** (red): linked work finished, or is forecast to finish, after the planned end or the
  horizon's date, or that day has passed while it is still open.
- **not started** (amber): it is not promoted, nothing is linked yet, and the planned start has
  passed.

## Who decides what

Agents capture ideas, edit titles and briefs, add and resolve questions, record decisions, and
adopt or unlink work. They can promote an idea only once you have marked it shaped. Maturity,
horizons, dates, order and the baseline are yours: you set them in the Plan view, or on the
command line with `--person`, which records the change under your name
(`staple config set humanName "Your Name"` first):

For an exploring idea:

```bash
staple idea set <id> --maturity shaped --horizon Next --start 2027-01-05 --target 2027-02-12 --person
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
| `staple idea promote`, `adopt` | `start_idea` | Promote the idea to an epic, or adopt an issue |
| `staple idea scaffold [--confirm FP]` | `scaffold_idea` (`confirm`, `fingerprint`) | Preview, then promote it and create its tasks from the breakdown |
| `staple idea plan`, `task`, `defer` | `update_idea` (`plan`, `defer_question`) | Write plan sections and breakdown rows; defer a question |
| `staple idea import <plan.md>` | | Capture an idea from a plan file |
| `staple idea unlink` | `unlink_idea` | Remove a link |
| `staple idea reset-baseline --person` | `reset_idea_baseline` (view button only) | Make the current window the baseline |

The design contract is [design/plan.md](https://github.com/vpetkovic/staple-tracker/blob/master/design/plan.md).

Undated work without a horizon lives in Unscheduled. Named horizons can have no date, but only dated horizons appear in Milestones. Plan remembers your lens, open record, scroll and filters per workspace. A milestone links straight to each of its planned ideas.
