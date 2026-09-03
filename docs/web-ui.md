# Web UI

```bash
staple open      # prints http://127.0.0.1:4400/?token=… and opens your browser
```

One command, no daemon: the server runs in the foreground and Ctrl-C closes it
along with every database handle. `--hub` serves every registered workspace at
once; the browser behaviour follows `config browser=auto|always|never`.

Views: subtask tree and dependency graph, plus a detail panel with documents,
comments, and the agent-payload pane, and a workspace settings dialog for the
status and kind vocabularies.

## Auth

Pages served to loopback carry their own token, so the browser never sees a
token screen. The token — for curl, agents, and remote tabs — lives in
`~/.staple/ui-token` (0600) and survives restarts; delete the file to rotate it.

Every `/api/*` route is gated by the per-process token (`X-Staple-Token`,
`Authorization: Bearer`, or `?token=`), compared with `timingSafeEqual`; writes
are `POST`-only and Origin-checked, and every route pins the methods it accepts.
The app reads the token out of its own URL once, keeps it in `sessionStorage`,
and strips it from the address bar. Arriving without a valid token renders an
explanation, not a blank page.

## Workspace settings

The status set and the kind vocabulary are workspace data, not staple's
(see [semantics.md](semantics.md)). The page edits them from a gear in the
header, or from the command palette — "Workspace settings".

Two lists. Each row has an editable label, a drag handle, and — for statuses —
a category select; removing a row that issues still carry requires a target to
migrate them onto. Reorder by dragging, or with the per-row move buttons, which
are the keyboard path and are always visible rather than revealed on hover.
Every edit applies immediately; there is no save button, and a refusal is the
store's own sentence.

Behaviour follows the CATEGORY, never the id. A workspace that adds `pairing` in
`active` gets a claimable status wearing the in-progress glyph and the
in-progress colour, with no new theme token — `styles/app.css` maps the eight
categories onto the existing `--status-task-*` hues.

**Order.** The dialog's list is the CONFIGURED order. Lists and group headers use
the LIST RANK, which the server computes: categories in a fixed sequence (active,
review, gated, blocked, ready, unstarted, then done and cancelled) with the
configured order breaking ties inside each one. So dragging reorders statuses
within a category, and moving one between groups means changing its category.
Rows sort by the same rank, so a header can never sit above rows ordered
differently.

`GET /api/settings` returns the vocabulary, the derived orders, the category set,
and a per-id count of what still carries it. `POST /api/settings` takes
`{ target, ops }` — the same ordered, all-or-nothing op batch as the
`update_statuses` / `update_kinds` MCP tools — and answers with the identical
envelope, so the page re-derives from one response rather than merging. It is
the only route that both reads and writes.

## Analytics

The detail panel's Analytics tab is estimate versus actual for one issue, drawn
entirely from the `timing` and `childrenTiming` the issue payload already
carries (see [cli.md](cli.md), "Estimates vs actuals") — the page adds nothing
up itself, so it can never disagree with `staple show` or with MCP `get_task`.

**One headline.** Leaf and parent alike open with three figures: **planned**,
**actual**, and the **difference**. Planned is the recursive `subtreePlan` —
the issue's own estimate when one is set, otherwise its descendants' — so an
epic nobody estimated over three 4h/3h/4h tasks leads with `11h`, and the epic
above it leads with that same 11h whether or not the middle level was typed
in. Actual is the headline `activeSeconds`, which for a parent is already its
children's aggregate; an epic has no stopwatch of its own. A real duration or
delta is set as a large tabular figure; an absence is the words *No estimate*,
*No work recorded* or *No comparison*, small and muted in the interface face,
never a number and never a dash. Where the plan came from is said beneath it
(`inherited from 3 of 3 descendants`, or `own estimate; descendants add up to
11h`), and under the card one muted line carries the caveats: why there is no
difference, how many children have no plan, whether the time is approximate,
and time spent in review, which is named but never counted as active.

**This issue versus children.** A parent gets one compact block beneath the
headline with two rows. *This issue* is the top-down estimate typed on the
parent and the time it was worked directly; *Children* is the bottom-up plan
(`from 3 of 3 descendants`) and the aggregate actual. Every figure names its
source in words, because the two plans are alternatives — the headline takes
the own estimate when it exists, otherwise the children's — and are never
added. A leaf has nothing to break down and shows the summary only.

**Per child.** Two lines per direct child: identifier, status and delta, then
the title with `est … · ran …`. A child that is itself a parent shows its own
aggregate. Unfinished children mark their delta `*` while the clock is being
fed and `‡` once it has gone idle, and the same distinction is spelled out in
the caveat line. The reading order — headline, breakdown, per child — is the
same in the drawer and on the full-screen page.

## Stack

The page is a Vite + React + TypeScript app in `src/ui/app/`, shipped inside the
package as a prebuilt static bundle that `src/ui/server.ts` reads off disk.

React 19, Tailwind v4, [shadcn/ui](https://ui.shadcn.com) in the *new-york*
style, `radix-ui` primitives, `lucide-react` icons. All of it is a
**devDependency** — staple's runtime dependencies are compiled into the
published bundle, because what ships is the built app, not the toolchain that
made it.

## Theme

`src/ui/app/src/styles/theme-tokens.css` holds 531 CSS custom properties: the
light and dark scales, the radius and type ladders, motion, and the
`.status-chip` color-mix recipe. `src/ui/app/src/styles/app.css` is staple's own
layer on top — the status-to-hue mapping and the SVG chrome for the dependency
graph, which has no Tailwind equivalent.

The load-bearing family is `--status-task-*`: one hue per built-in status, so a
status badge is one variable and light/dark both fall out of the same color-mix.
Since the status set became configurable, the mapping that matters is
`[data-status-category]` — eight categories onto those same hues, declared after
the per-id rules so the category wins. Adding a status never needs a new token.

Working on the app itself is a contributor path — dev server, rebuild loop, and
the rest are in [CONTRIBUTING.md](../CONTRIBUTING.md).
