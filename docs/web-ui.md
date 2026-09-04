# Web UI

```bash
staple open      # prints http://127.0.0.1:4400/?token=… and opens your browser
```

One command, no daemon: the server runs in the foreground and Ctrl-C closes it
along with every database handle. `--hub` serves every registered workspace at
once; the browser behaviour follows `config browser=auto|always|never`.

Views: subtask tree, dependency graph and milestones, plus a detail panel with
documents, comments, and the agent-payload pane, and a workspace settings dialog
for the status and kind vocabularies.

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

## Milestones

The third tab beside Graph — also "Go to milestones" in the command palette —
is the planning view for [milestones](milestones.md): dated, human-ordered plans
that contain epics and tasks without moving them. It needs the `milestone` kind
configured (`staple kinds add milestone --label Milestone`); without it the
page shows the store's own refusal naming that command.

**Left, the plan.** Every milestone in plan order, then target date, then
identifier — an unplanned milestone sits below every planned one, and a date
never reorders a plan. Each row shows the target date, member count, a progress
bar with `done/countable` and the percent, the derived state, the risk, and the
queue's answer: `next: STA-67 (#4)` once R3d fills it, a muted "not queued yet"
until then. Resolved milestones follow the page's "show done" filter.

**Right, one milestone.** Title, start and target dates, owner, plan position;
rollups (progress, blocked, gated, active, ready); the ordered members drawn
with the same row as the tree, so kind glyph, status glyph and identifier read
the same everywhere. A member epic's own children follow it indented, read-only
— membership never rewrites hierarchy and neither does this list. A member added
with a note shows the note under its row.

**Editing membership.** Every member has Open, Move up, Move down and Remove
buttons, always visible, plus alt+arrow on the row; the form under the list adds
an identifier with an optional note. Each write carries the view's `revision` as
`baseRevision`, and the store refuses a stale one with `revision_conflict`: the
page shows "Member order changed elsewhere" with the store's sentence and a
Reload, rather than a refusal, because the fix is to read again. Any other
refusal is the store's own sentence. Drag is deliberately absent — the row list
carries no drag wiring, and the buttons are the keyboard path either way.

**States without colour.** Planned `○`, active `◐`, overdue `!`, done `✓`,
cancelled `×` — glyph and word together, so no state is told by hue alone; an
active milestone whose members have all landed says "all members done" beside
the badge until a human closes it. Blocked and gated are not milestone states
(they are facts about members) and appear as `⊘ n blocked` / `◇ n gated` in the
risk line.

**Layout.** Below `md` (48rem) the two panes stack: the list, then the detail
with a "Back to milestones" button. From `md` up they split. The expand button in
the detail header gives it the whole content box at any width; press it again to
return.

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
