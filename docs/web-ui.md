# Web UI

```bash
staple open      # prints http://127.0.0.1:4400/?token=… and opens your browser
```

One command, no daemon: the server runs in the foreground and Ctrl-C closes it
along with every database handle. `--hub` serves every registered workspace at
once; the browser behaviour follows `config browser=auto|always|never`.

Views: subtask tree, dependency graph and milestones, plus a detail panel with documents,
comments, and the agent-payload pane, and the Work Workspace Settings dialog for
the status and kind vocabularies and the settings registry.

## Grouping

The tree is ungrouped by default: one hierarchy, parents over children. The
"Group" control adds an axis — status, pickup order, epic, or kind — and each
axis is a way of *displaying* the same rows, never a second copy of them.

**Expansion.** Every parent has one expand/collapse state, keyed by the issue
and shared by every axis, so an epic folded in the ungrouped view is folded
under Group by Epic and vice versa; the choice survives the poll, a view switch,
and a reload. On first visit — before you have clicked anything — a parent is
**open when it, or anything beneath it, is active** (in progress, in review, or
blocked) and **folded otherwise**, so live work is on screen and the backlog is
not a wall. Group by Epic uses exactly that default; the epic's own row is the
top of its section, its chevron is the only fold, and nothing is collapsed on
your behalf.

**Epic sections.** Under Group by Epic every row sits under its top-level
ancestor, with the epic itself as the section's first row (dimmed, when the
current filter removed it) and "No epic" last for rows that have none. Adjacent
sections are separated by one rule — 8px of air plus a hairline — whether the
next section is headed by a real epic, a ghost of one, or the "No epic" header,
at every width. There is no gap between an epic and its own first task.

## Sorting

The "Sort" control sits beside "Group" and names both halves of its own state without
being opened — "Sort: Activity · Most active first", never an arrow you have to
decode. Every mode is a real radio in a labelled group, so Tab and Enter operate it.
The choice is stored **per workspace and per view** under the same
`staple:view:v1` key as the grouping; a scope you have never set uses the default, and
setting one back to the default forgets it rather than pinning it.

**Sorting is not the queue.** Ordering the list by queue position is a statement about
your screen; it cannot move an item in the pickup plan, change checkout eligibility, or
reorder a dependency. See `docs/queue.md`.

Direction flips the **primary key only** — every tie-break below runs forwards in both
directions, so two rows that tie never swap and "descending, then ascending" is exactly
where you started. Under Queue position, unqueued rows come last in both directions.
Every chain ends in the identifier, which is unique and compared **numerically on the
number part**, so STA-9 precedes STA-10 and the list cannot reshuffle on the 1.5s poll.

| Mode | Orders by | Tie-break chain, in order | Parent rollup |
| --- | --- | --- | --- |
| **Activity** (default) | a live claim first, then the configured status order | priority → newest update → identifier | best activity tier in the subtree |
| **Queue position** | the pickup plan's position; queued rows before unqueued | activity → priority → newest update → identifier | earliest queue position in the subtree |
| **Status** | the workspace's configured status order | priority → newest update → identifier | — |
| **Priority** | critical → high → medium → low | activity → newest update → identifier | — |
| **Updated** | when anything last moved | priority → identifier | latest update in the subtree |
| **Created** | when the ticket was filed | priority → identifier | — |
| **Identifier** | the number, numerically | — (identifiers are unique) | — |
| **Title** | alphabetically, locale-aware | identifier | — |

Only three modes roll a parent up over its descendants, and each is named above; the
other five read the row and nothing else. A rollup counts only rows the current filter
kept, so an order is always accountable from what is on the screen. A status the
workspace order does not mention ranks last but still ranks.

Sorting orders **siblings**: it never lifts a child out from under its parent, and it
applies inside a group exactly as it does in the ungrouped view. Under Group by Status
the activity tier is inert — every row in a status bucket ranks equally on it — so the
default mode there is priority, then the newest update, then the identifier.

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

## Work Workspace Settings

The settings surface is titled exactly that. It opens from the gear in the
header, from the command palette, or by URL: `?settings` opens it on its first
category and `?settings=kinds` focuses one. Opening from the gear pushes one
history entry, so Back closes it and lands on the page you were on; moving
between categories replaces that entry rather than adding to it; Forward
reopens it. A deep-link arrival pushed nothing, so closing strips the
parameter in place.

**Two panes.** Left, the categories, exactly as the registry serves them —
grouped under *Workspace* and *Global*, in registry order, with no list of
their own in the browser: registering a category in
`src/core/settings-registry.ts` is the whole of adding it to the nav. Right,
the selected category, with its scope named beside its heading. Under the
title a scope line says which workspace is being edited and where global
preferences live (the `global.path` the envelope reports). Scroll position is
kept per category, and selecting one does not move focus off the nav.

**Narrow screens** (below 768px) stack the panes: the category list first,
then the category, with a Back button in the header that returns to the list
and puts focus back on the category you were in. The stacked frame is the
whole viewport, so no form is clipped by a centred dialog.

**Full screen.** On wide displays a toggle in the header takes the dialog
edge to edge and back; it is per open and never persisted, so the shell
always reopens as a dialog. Esc closes, as every dialog in the app does.

What a category holds is decided by its registry `editor`: `statuses` and
`kinds` are the two vocabulary editors below; a `fields` category renders a
control per registered definition (see *Registry-driven categories*).

### Form primitives

Every category is built from one set of primitives (`settings/form/`), so
saving, cancelling, dirty state, inline errors and conflicts behave the same
way everywhere:

- **Field** — a label, a description, the control, an inline error
  (`role="alert"`, tied to the control with `aria-describedby`) and a scope
  tag that says *Workspace* or *Global* and where the value came from
  (`default`, `workspace`, `config`). **Section** groups fields and carries the
  error that belongs to no single field.
- **ActionBar** — *Save changes* / *Cancel* / *Reset to defaults*. Nothing is
  written until Save; Cancel drops the draft; Reset is offered only by forms
  that have defaults to go back to. While a save is in flight the bar says
  *Saving…* and every control is disabled; a refused save keeps the draft and
  puts the store's sentence on the row or field it names, or on the section
  when it names none. Nothing is paraphrased and nothing is retried.
- **ReorderList** — drag by the handle, or the per-row *Move up* / *Move down*
  buttons (always visible), or alt+arrow on the row. After a keyboard move
  focus stays on the moved row: on the same button, or on the other one when
  the row reached an end and that button became disabled.
- **Destructive confirmation** — a removal opens an inline confirmation under
  the row, with the migrate-to picker when issues still carry it; the
  confirm button stays disabled until a target is chosen.

**Unsaved changes.** A form with a draft reports it to the shell, and every
way out — the X, Esc, a click outside, the narrow layout's Back, selecting
another category, closing the tab — asks first: *Discard changes* or *Keep
editing*. Nothing leaves a dirty form on a keypress.

**External revisions.** The 1.5s poll republishes the settings envelope while
the dialog is open. A clean form simply shows the new state. A dirty form
remembers the served state it started from; when that moves underneath it
(another tab, an agent through MCP, the CLI) a conflict banner appears and
Save is held until you choose: *Reload* drops the draft and shows the new
state, *Keep my changes* keeps the draft and makes the next save a deliberate
overwrite. The store remains the authority — a batch it refuses after that
comes back as a refusal on the responsible row.

### Statuses and kinds

The status set and the kind vocabulary are workspace data, not staple's
(see [semantics.md](semantics.md)).

Two lists. Each row has an editable label, a drag handle, and — for statuses —
a category select; removing a row that issues still carry requires a target to
migrate them onto. Reorder by dragging, or with the per-row move buttons, which
are the keyboard path and are always visible rather than revealed on hover.
Edits accumulate as a draft — the list shows what Save will produce, with the
usage count moved along by a migrate-to removal — and Save posts them as one
ordered, all-or-nothing batch of the same ops the MCP tools take. A refusal
is the store's own sentence, on the row it names. A kind row carries one thing
more: its glyph, which is also the control that changes it (see
[Glyph picker](#glyph-picker)).

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

The same envelope carries the **settings registry**
(see [configuration.md](configuration.md#the-settings-registry)): `registry`
lists every category with its scope and editor and every typed definition;
`values` holds this workspace's registered values, each with its `source`
(`default` or `workspace`) and version; `unknownKeys` names stored keys this
build has no definition for; and `global` is the machine's `config.json` with
each value's `source` (`default` or `config`) — served read-only, because its
write path is `staple config set`. `target: "settings"` takes
`{ op: "set", key, value }` / `{ op: "reset", key }` ops for workspace keys
and refuses a global one. `lib/settings.ts` exposes `settingCategories()`,
`settingDefinitions()` and `settingValue()` over the served registry; nothing
in the browser restates a definition.

### Registry-driven categories

A `fields` category is its definitions, rendered as controls chosen by each
one's value schema: a boolean is a switch, an integer a number field with the
schema's bounds, a string a text field whose description carries the pattern
hint, an enum a select over the registry's values. Each control sits in a
Field with the definition's label and description, its scope tag and source,
and its own *Reset* to the default. Values are checked against the schema
before the round trip; the store still refuses on its own terms, and that
sentence lands on the field whose key it names. Save posts `target:
"settings"` ops — `set` per changed key, `reset` for a stored value sent back
to its default. Global-scope definitions render disabled with the sentence
naming `staple config set`. Registering a definition is the whole of adding
it to the page: nothing in the form names a setting.

**Workflow** is the first such category in workspace scope, and its first
control is the queue policy
([configuration.md](configuration.md#queuepolicy)): a select over `advisory`
and `strict`, with the registry's description stating before you save what
`strict` changes for agents, and the scope tag beside it saying *Workspace ·
default* until a value is stored and *Workspace · workspace* after. The
category, the control and its explanation all come from the registry entry;
`fields-form.test.tsx` renders a second fixture toggle beside it and pins
that none of the shell's files names the setting or the category.

Adding a setting or a category of your own is a registry entry and nothing
else — the checklist is
[configuration.md → Adding a setting](configuration.md#adding-a-setting). That
the claim holds end to end is asserted rather than assumed:
`test/settings-verification.test.ts` registers a category no build has ever
had, serves it through the real HTTP server and renders this shell from that
envelope, then reads the shell's own sources to prove none of them names it;
`settings/settings-verification.test.tsx` renders every breakpoint with both a
registry-driven and a vocabulary category, and pins the unsaved-changes guard,
the conflict banner's two ways out, and the label, scope, error and
`aria-current` wiring over every field and button on the surface.

## Glyph catalog

Every kind wears one **appearance** record — `{ source, value, label, fallback }`
— resolved by the server and served on each row of `/api/settings` `kinds[]`,
the same record `staple kinds ls --json` and MCP `list_kinds` answer. The
operator's choices live in the `kinds.appearance` workspace setting (see
[configuration.md](configuration.md#the-settings-registry)); a kind with no
entry wears the built-in mark, and a kind that has none wears a generic one.
`lib/kind-appearance.ts` mirrors the built-in table so the first paint, before
the fetch lands, already shows the right marks, and `kindAppearance(id)` in
`lib/settings.ts` is the accessor every row, group header, form and graph node
resolves through. No
colour travels in the record: hue is a status-category property, and a kind
glyph is monochrome by design.

### One resolver

There is exactly one component in the browser that turns an appearance record
into pixels: `components/task-list/KindGlyph.tsx`. Given no `appearance` prop it
resolves the served record itself through `useKindAppearance(id)` — the
`kindAppearance` accessor wrapped in a `useSyncExternalStore` subscription to the
settings snapshot — and then draws the arm the record names: `emoji` and `svg`
through `SafeGlyph`, `lucide` through the catalog chunk, `none` (and anything
that fails validation, including a Lucide key the catalog does not know) through
its own hand-drawn mark, so a slot is never empty. Because the resolution happens
inside the glyph, every surface gets it by drawing `<KindGlyph kind={…}/>` and
nothing else: ungrouped and grouped rows and the epic-headed sections
(`TaskRowLine`), kind group headers (`views/tree/TreeGrid.tsx`), graph nodes and
the epic picker (`views/graph/`), the create dialog and the detail panel's kind
editor, and the settings preview. And because the subscription is to the same
snapshot the settings editor republishes after its POST — and the 1.5 s
fingerprint poll refetches — **changing a kind's glyph repaints every one of them
without a reload**. The `appearance` prop survives for the one caller drawing
something not saved yet: the picker's preview. The `lucide` arm is asynchronous
(the catalog is its own chunk); the built-in mark is the synchronous fallback
while it loads, cached module-wide so only the first glyph on a page waits.
`components/task-list/kind-glyph.test.tsx` renders all six seeded kinds and one
custom kind at the row, header, graph-node, picker and form sites, and swaps the
published envelope to prove the re-render.

The catalog a `lucide` value names is not a hand-kept list: it is generated
from the INSTALLED `lucide-react`, and checked in. The server validates only
that a value is *shaped* like a key (the manifest is browser code); the
browser's `resolveIcon` decides whether it exists, and an unknown key answers
`undefined` — the cue to draw the fallback.

```bash
npx tsx scripts/gen-lucide-catalog.ts    # after bumping lucide-react, or editing the category table
```

That writes two modules under `src/ui/app/src/lib/`. `icon-catalog.generated.ts`
is data only — the pinned `LUCIDE_VERSION`, the category list, and every canonical
key with its category and aliases. `icon-previews.generated.ts`
names every icon by a real import from `lucide-react`, so a key that does not
exist in the package fails `npm run typecheck` and `npm run build:ui`, not a user.
`test/lucide-catalog-freshness.test.ts` regenerates in memory and fails, with the
command above, if the checked-in text is stale.

The source of truth is the package's own `dynamicIconImports` map. A key that
points at itself is canonical; one that points elsewhere is an alias, and aliases
never become keys — `alert-triangle` collapses onto `triangle-alert`, is recorded
on that entry, and its words join the entry's search terms (Lucide's aliases are
its synonym list: `home` finds `house`). The package ships
no tags or categories, so the category comes from an ordered keyword table in the
generator — first row sharing a word with the key wins, then the same pass over
alias words, then `other`. Deterministic and offline: the same version gives the
same catalog on every machine.

`lib/icon-catalog.ts` is what the app consumes. It rebuilds the human label
("Triangle Alert"), the search terms, and the alias map from the manifest at
load, so the checked-in data stays small enough for the main view to carry
(rows resolve persisted keys synchronously). `resolveIcon(key)` accepts a
canonical key, an alias, or "Triangle Alert" and answers the canonical entry (or
`undefined` — the cue to fall back); `searchIcons(query, { category, limit })` is
ranked (exact key, whole word, prefix, alias word, substring) and stable;
`loadIconComponent(key)` reaches the React component through `import()`, so the
module that names every icon is its own chunk (about 140 kB gzipped) and the main
view never pays for icons it does not draw. Importing the catalog module costs
the manifest alone, about 12 kB gzipped.

### Custom glyphs

When the catalog is not enough, a kind can wear an **emoji** or a **custom
SVG**. Both are validated in core (`src/core/kind-appearance.ts`), and both
are drawn by one browser primitive, `components/task-list/SafeGlyph.tsx`, which
`KindGlyph` delegates an `emoji` or `svg` record to, drawing its own built-in
mark for anything else. The **glyph picker** below is how an operator chooses
one.

An **emoji** value is bounded by grapheme clusters, not bytes: `Intl.Segmenter`
counts what a person sees as one glyph, so a joined family (`👨‍👩‍👧‍👦`, eleven
UTF-16 units) or a flag is one, and the bound is 1 to 2 of them with a ceiling
of 32 units. Whitespace, control characters, lone surrogates and a value with
no visible code point (a bare zero-width joiner) are refused. The browser draws
it as text, which is safe by construction.

A **custom SVG** goes through `src/core/svg-sanitize.ts` — pure string work, no
DOM, no dependency — and only the sanitiser's **canonical output** is ever
stored, served or drawn. The security model has three walls:

1. **The write boundary.** `kinds.appearance` accepts an `svg` value only if it
   is exactly the sanitiser's output (a fixed point: sanitising it again
   returns it unchanged). A raw document is refused with a sentence saying to
   sanitise it first; a hostile one is refused with the reason. The sanitiser
   is an allowlist, not a denylist: `svg`, `g`, `path`, `circle`, `ellipse`,
   `rect`, `line`, `polyline`, `polygon`, `defs`, `clipPath`, `symbol`, `use`
   and a `title`/`desc`, with the presentation and geometry attributes those
   take. It **refuses** `<script>`, `<foreignObject>`, `<style>`, `<image>`,
   `<a>`, animation elements, a nested `<svg>`, every `on*` attribute,
   `javascript:`/`data:`/`vbscript:` URLs in any attribute (including
   entity-encoded spellings), `url(` to anything but a local `#id`, an `href`
   that is not a local `#id`, `@import` or `url(` in a `style`, DOCTYPE and
   entity declarations (so a billion-laughs document never reaches a parser),
   CDATA, processing instructions, undeclared entities, control characters,
   malformed or truncated markup, more than 512 elements or 32 levels, and
   anything over 8 KiB. It **strips** what an editor leaves behind: the XML
   declaration, comments, `xmlns:*`, `class`, `data-*`, `style` (when it
   carries nothing external), unknown attributes, and `width`/`height`/`x`/`y`
   on the root.
2. **The canonical form.** The root is rewritten as
   `<svg xmlns viewBox role="img" aria-label>`: the `viewBox` is normalised
   (derived from a plain width and height when absent) and bounded to ±4096 with
   a positive width and height of at most 4096; absolute sizing is gone, so the
   glyph inherits the caller's box; every `fill` and `stroke` becomes
   `currentColor` unless it is `none`, so the glyph takes the row's colour like
   the built-in marks; and exactly one `<title>` carries the accessible name —
   the document's own root `<title>` if it had one, else the record's `label`,
   else its `aria-label`, else the document is refused. Attributes are written
   in one order with escaped values, so equal drawings give equal strings.
3. **The browser's gate.** `safeGlyph` in `lib/kind-appearance.ts` does not
   trust the wire: before anything is injected it holds the value to the exact
   shape the sanitiser writes (that root, only those elements, no handler, no
   non-local reference) and answers null for everything else. `SafeGlyph`
   places the canonical body inside an `<svg>` it owns — which sets the size,
   the recorded `viewBox` and the accessible name — and that body is the only
   string in the app that ever reaches `dangerouslySetInnerHTML`. Null draws
   the record's terminal `fallback` as text, so an invalid record costs the row
   nothing but its custom mark.

The same suites that prove this live in `test/svg-sanitize.test.ts`,
`test/kind-appearance.test.ts`, `test/store-settings.test.ts` (custom glyphs),
`test/contract-kind-appearance.test.ts` (a hostile save is refused and no
surface carries executable markup) and
`components/task-list/safe-glyph.test.tsx`.

### Glyph picker

Every row of the Kinds editor carries its glyph, and the glyph *is* the control:
pressing it (*Change glyph for Epic*) opens the picker under that row. Three
tabs, one preview, and one form contract — `{ source, value, label, fallback }`
— whichever tab produced the choice. `settings/glyph-picker/` holds it:
`glyph-picker-model.ts` is every decision as a function, `GlyphPicker.tsx` the
wiring, `GlyphPreview.tsx` the preview.

**The catalog tab** is a search field over names and Lucide's own aliases
(`alert-triangle` finds `triangle-alert`), a category filter over
`ICON_CATEGORIES`, and a live count. The grid is a `listbox` that takes focus
itself and names its active cell through `aria-activedescendant` — which is
what makes a WINDOWED grid navigable at all, since the cell holding the
"focus" need not be in the DOM until the arrow key that reaches it scrolls it
into the window. Arrows step a cell or a row, Home and End jump, Enter or
Space chooses, Escape closes; the index is clamped rather than wrapped. Only a
viewport's worth of cells plus two overscan rows exist at a time and two
spacers stand in for the rest, so scrolling ~1,800 icons costs the DOM a few
dozen nodes. Each cell is a `role="option"` with the icon's label as its
accessible name.

The icon COMPONENTS arrive through `loadIconComponents()` — the `import()`
that makes `icon-previews.generated.ts` its own chunk — and only once the
catalog tab is open, so a page that never opens the picker never fetches them.
Until they land a cell is a placeholder box, and the search, the keyboard and
the choice all work without them. The main bundle therefore carries the
manifest (data only, ~11 kB gzipped — `resolveIcon` answers synchronously) and
never the 142 kB gzipped of icon code.

**The emoji tab** is one field, held to the same grapheme rule core states
(`isEmojiGlyph`). **The custom SVG tab** posts the raw document to
`POST /api/glyph/sanitize` — core's `sanitizeSvg`, over the wire, writing
nothing; the route exists because the store accepts an `svg` value only as
that function's canonical output and the sanitiser is Node-only code the
browser cannot import. Only the answer becomes a choice; the raw text never
enters the draft, and a refusal is the sanitiser's own sentence.

A **recents** strip remembers the last twelve choices in `localStorage`
(`staple:glyph-recents`). An `svg` is not remembered: a canonical document is
up to 8 KiB, and twelve of those is not what a recents strip is for.

**The preview** is not a second renderer. It hands the appearance the draft
currently holds to the same `KindGlyph` a list row draws, at the row's 12 px
and the graph node's 14 px, so what the picker shows is what those surfaces
will show by construction — every source, `lucide` included, since the glyph
resolves all of them itself. Beside it are the accessible name and the terminal
fallback, both bounded exactly as core bounds them, and *Reset to default* —
offered only when this kind has an entry to drop. The picker sits beside the
chooser when the shell is two-pane or full screen and below it when the shell
is stacked, from the same `STACKED_QUERY` the dialog uses, so the two never
disagree about how wide the world is.

**Nothing here writes.** A choice enters a SECOND draft — the
`kinds.appearance` map, posted to `target: "settings"` — held beside the
vocabulary ops rather than inside them, because the store lets that map name
only CONFIGURED kinds: a glyph for a kind the same draft is adding can only be
written after the kinds batch lands. Save therefore posts the ops first and the
map second (one `set` of the whole map, or `reset` when nothing is customised
any more), and a refusal on the second cannot re-post the first. The user sees
ONE form all the same: one dirty state, one ActionBar whose summary counts
both halves, one Cancel that drops both, one unsaved-changes guard, and one
conflict banner for either half moving underneath.

`settings/glyph-picker/glyph-picker-model.test.ts` pins the arithmetic,
`glyph-picker.test.tsx` the markup, and `test/ui-glyph-sanitize.test.ts` the
route.

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

**Rolled-up plans in the rows.** The per-child `est` is the child's *effective*
plan — the same figure its parent counts it as — so under STA-156 the STA-157
line reads `est 11h`, not a dash, and the parent's planned headline is exactly
the sum of what the child lines show. Where each figure came from (`own
estimate`, `inherited from 3 of 3 descendants`) is the tooltip on the figure,
never a third line per child, and the child's delta is measured against that
same plan. The headline is also written once as a single sentence for screen
readers — planned, actual, difference, coverage, source, in that order — with
the visible figures hidden from the accessibility tree so nothing is heard
twice. In the task list, a folded parent in comfortable density shows the same
rolled-up plan as `est 11h` beside its progress bar, in the existing rollup slot
at the count's own size, so the row does not grow; it is absent rather than
`est —` when nothing beneath is estimated, and hidden below the two-line
breakpoint where the title has the whole row.

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
