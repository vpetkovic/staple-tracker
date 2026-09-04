# Web UI

```bash
staple open      # prints http://127.0.0.1:4400/?token=… and opens your browser
```

One command, no daemon: the server runs in the foreground and Ctrl-C closes it
along with every database handle. `--hub` serves every registered workspace at
once; the browser behaviour follows `config browser=auto|always|never`.

Views: subtask tree and dependency graph, plus a detail panel with documents,
comments, and the agent-payload pane, and the Work Workspace Settings dialog for
the status and kind vocabularies and the settings registry.

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
is the store's own sentence, on the row it names.

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
resolves through (the picker and the rendering rewire are R5d and R5e). No
colour travels in the record: hue is a status-category property, and a kind
glyph is monochrome by design.

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
are drawn by one browser primitive, `components/task-list/SafeGlyph.tsx`;
`KindGlyph` takes an optional `appearance` and delegates an `emoji` or `svg`
record to it, drawing its own built-in mark for anything else (the glyph
picker and the rewiring of every surface are R5d and R5e).

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
