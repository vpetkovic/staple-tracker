# Site primitives

The building blocks for marketing pages (`src/pages`, and the landing pages in `landing/`: see "Choosing the landing page" in CONTRIBUTING.md), the animated scenes those pages show features with (see "Scenes" below), and the parts the experiment pages share (`landing/parts/`). Docs pages do not use
them: they are Markdown from `../docs`, styled by `src/css/custom.css`.

Colours, type, spacing, radii, control sizes, durations and fonts come from
the tokens in `src/css/tokens.css`; components read `var(--st-*)`, so both
themes work without per-component dark rules. Only small local geometry (a dot's
size, a hover nudge) is literal.

| Component | Import | Use it for |
| --- | --- | --- |
| `Section` | `@site/src/components/Section` | A full-width band with a centred container. `tone="subtle"` for an alternate surface with hairlines, `width="narrow"` for the reading measure, `spacing="tight"` for half the vertical padding. |
| `Eyebrow` | `@site/src/components/Eyebrow` | The small mono label above a heading. |
| `Heading`, `Lead` | `@site/src/components/Heading` | The type scale. `as` picks the element for the outline (`h1` to `h4`, `p`), `size` picks the look (`display`, `xl`, `lg`, `md`); they are independent. `Lead` is the paragraph under a heading. Both take `align="center"`. |
| `Button`, `ButtonRow` | `@site/src/components/Button` | A link styled as a button: `variant="primary"` for the one main action in a view, `secondary` for the rest; `size="lg"` in heroes. `ButtonRow` wraps a group. |
| `Card`, `CardGrid` | `@site/src/components/Card` | A hairline panel with `title`, optional `eyebrow` and body; `to` makes the whole card a link, `titleAs` picks the title element for the outline (default `h3`). `CardGrid` lays cards out in one column on phones and `columns` (3 by default, or 2) from 768 px up. |
| `Terminal` | `@site/src/components/Terminal` | A short shell session. `lines` is an array: `$ ` starts a command (the prompt is not selectable; a long command wraps under itself), `# ` a comment, anything else output. |
| `CopyCommand` | `@site/src/components/CopyCommand` | A shell command with a copy button, for when the call to action is a command (`npx staple-cli`). `variant` as on `Button`; it sits in a `ButtonRow` beside `size="lg"` buttons at the same height. |
| `Screenshot` | `@site/src/components/Screenshot` | A web UI capture in a hairline frame, switching with the theme. `name` is the stem under `static/img/screens` (`<name>-light.webp`, `<name>-dark.webp`, 1280 x 800 at 2x); `alt` says what it shows; `priority` for the one above the fold. Below 768 px, `phone` swaps in the web UI's own phone layout (`<name>-phone-light.webp`, `<name>-phone-dark.webp`, 390 x 560 at 2x); without one, `focus` picks the top-left corner of a zoomed crop of the desk capture. |
| `PlanFlow`, `FlowFile`, `FlowTickets`, `FlowEvents` | `@site/src/components/PlanFlow` | A numbered flow of steps (`steps`: `title`, `text`, `visual`), three across from 997 px and stacked below, with a decorative connector between steps; `label` names the list for screen readers. The step visuals are text in hairline panels with a `title` (or `name`) and optional `meta` in the bar, so they switch with the theme: `FlowFile` a Markdown file (`name`, `lines`; a line starting with `#` is a heading), `FlowTickets` an epic and its tickets (`tickets`: `id`, `title`, `state` of `done`, `active`, `ready` or `waiting`, and optional `epic`, `note`, `added` to outline one filed later), `FlowEvents` a short timeline (`events`: `who`, `text`, `tone` of `warn` for an interruption or `accent` for the outcome). |

A page composes them:

```tsx
<Section>
  <Eyebrow>Queue</Eyebrow>
  <Heading>Set the order once.</Heading>
  <Lead>Agents take the next ticket from the queue you ordered.</Lead>
  <ButtonRow>
    <Button to="/docs/queue">Read about the queue</Button>
  </ButtonRow>
</Section>
```

## Scenes

`scenes/` holds small animated pieces of staple's web UI, rebuilt in HTML and CSS: one per
feature, showing only the UI that feature is about. A landing page puts one beside the
copy for that feature. `/scenes` (noindex, not in the sitemap, not linked) shows all of
them by name at the widths of the cells they may sit in: check a change there.

| Scene | Shows |
| --- | --- |
| `PlanToTickets` | A Markdown plan becomes an epic, its tickets and their dependencies. |
| `QueuePickup` | An agent asks what is next, gets the top ready ticket and claims it. |
| `TicketContext` | Done-when criteria are ticked; the worklog document moves to a new version. |
| `Handoff` | A session goes silent; another agent takes the claim over and reads the worklog. |
| `ApprovalGate` | An epic waits on a person; Approve all is pressed; the tickets under it become ready. |
| `AutopilotRun` | Tickets go done one after another, then the budget stops the run. |
| `MilestoneGoal` | Goal criteria are marked met with evidence; the progress fills. |
| `TrackerSync` | staple beside GitHub Issues, ClickUp and Linear, each marked Planned. |
| `Budget` | Provider limits as gauges with the reserve; an estimate against what the work took. |
| `OneStore` | A command in the terminal changes the same ticket in the web UI and over MCP. |

Use one with no props; it fills the width of its container:

```tsx
import {QueuePickup} from '@site/src/components/scenes';

<div className={styles.cell}>
  <QueuePickup />
</div>
```

Every scene takes the same optional props (`SceneOptions`): `fade="bottom"` runs the last
rows out under a fade and `fade="none"` shows the fragment whole (each scene has its own
default), `bar={false}` drops the window bar, `loop` replays it while it is in view and
adds a pause control, and `className`. `SCENES` (`scenes/catalog.ts`) lists them all with
a name and a one-line story.

How a scene behaves, which `Scene` and `useScenePlayback` take care of:

- It starts when about a third of it has scrolled into view, plays once (under five
  seconds) and rests on its final state. It rewinds once it has left the view, so it
  plays again on re-entry.
- The final state is what the server renders and what `prefers-reduced-motion: reduce`
  gets: no timer is set and nothing moves.
- It is an image to assistive technology: `role="img"` with a sentence in `aria-label`,
  and the drawn UI hidden from the accessibility tree. Nothing inside a scene is
  focusable. The pause control of a looping scene sits outside the image.
- It adapts to its container, not the viewport: the frame is a size container named
  `scene`, and scenes use `@container scene (min-width: …)`.

To add a scene:

1. Write `scenes/<Name>.tsx` around `<Scene label title meta timeline>`. `timeline` lists
   when each step begins, in milliseconds; the child is a function of `step` (0 before
   anything happened, `timeline.length` at the end). Keep the last step under about 3.5
   seconds.
2. Build it from `parts.tsx`: `Row`, `List`, `StatusGlyph`, `Priority`, `Agent`, `Chip`,
   `Label`, `Meter`, `Pointer`, and the motion parts `Reveal` (arrives), `Swap` (one thing
   replaces another in the same box), `Typed` (a typed line) and `Wide` (words a narrow
   cell drops). Status hues, the two small type sizes and the step duration are tokens
   (`--st-status-*`, `--st-text-ui`, `--st-text-2xs`, `--st-duration-scene`).
3. Every step must occupy the same box: change opacity, transform and colour, never
   size. Something that arrives holds its place from the start.
4. A state class has to outrank the rule it changes (`.row.rowLit`, not `.rowLit`): the
   production CSS is minified across files, and two rules of equal weight can swap
   places. That reaches other components too: new CSS once greyed the status marks of
   `PlanFlow` on the landing page. After adding CSS, compare `/` and `/classic` from a
   production build with the build before your change.
5. Use the landing page's example data (prefix APP, the Multi-tenancy epic) and claim
   nothing the docs do not. An integration that is not shipped carries the Planned chip.
6. Add it to `scenes/catalog.ts` and `scenes/index.ts`, then look at it on `/scenes` at
   every width, in both themes, and with reduced motion.

## The bento landing page

`landing/Bento.tsx` sets its headlines in a serif display face (Fraunces, SIL Open Font
License 1.1, from `@fontsource-variable/fraunces`), as the blend page does. Both render
`SerifFont` (see "Parts the experiment pages share"), so no other page downloads the
face: keep `--st-font-serif` out of components that other pages use. The page's pieces:

- The hero's ticket chips (`CHIPS`, drawn by `TicketChips`) drift only while the motion
  state from `useDrift` is `on`, which it is once the page has loaded in a browser that
  did not ask for reduced motion. The Pause button holds the chips and the changing
  word; out of view they hold too.
- The sheet draws the dashed vertical rules once, at the column boundaries (3, 5 and 4
  of 12 from 1280 px, two equal columns from 768 px, the two edges on a phone). A band
  is one row of that grid; `tick` puts the solid mark on a heading.
- `Cell` is one feature: a serif title, two lines and a scene inside `fragment`, which
  cuts the scene's lower edge off (`cut="row"` cuts a whole row).

## The walkthrough landing page

`landing/Walkthrough.tsx` uses Geist only, set heavy and tight (`--st-weight-heavy`,
`--st-tracking-heavy`), with pills for its eyebrows and buttons. Its pieces:

- The hero's decoration is the staple of the logo, nested (`Staples`): SVG strokes in
  the accent colour, driven in once on load, still under reduced motion. Its width and
  the headline's size both follow the height of a short screen, so the button stays in
  view; under 560 px of height (a phone on its side) the decoration is left out.
- A headline is two lines (`Lines`) at every width, because its size follows the room
  it has: `--st-text-sans-hero` and `--st-text-sans-2xl` follow the viewport, and
  `--st-text-sans-xl` follows the feature's column (`cqw`). A line longer than the
  longest one today ("A plan becomes an epic.") needs a smaller factor in the token.
- `CHAPTERS` (in `parts/content.tsx`) is the walk-through: three chapters that follow
  the three steps, each a list of features. `Feature` is one section: a pill, the headline, a paragraph or
  three points, a docs link, and exactly one scene in a `panel`. On a phone the order
  is pill, headline, panel, copy, and the panel reaches into the gutter (edge to edge
  under 350 px) so the scene keeps the 300 px the kit draws for; the page's other
  boxes reach into the gutter with it. From 768 px the panel and the copy sit side by
  side under the headline, and from 997 px the headline joins the copy; the sides
  alternate in both.
- Every rule in a media query starts at `main.page`, and media queries that set the
  same thing cover ranges that do not overlap: the minified CSS can reorder rules of
  equal weight.
- The FAQ (`Faq`) is native `details`, so it works by keyboard and without JavaScript.
  Every answer says what the docs say and links the page that says it.

## The blend landing page

`landing/Blend.tsx` is one drawing sheet read in order: the serif headlines and dashed
rules of the bento page, the pace of the walkthrough page, and a layout of its own.
Every band has a legend on the left (a mono eyebrow and a serif heading with the tick)
and its content on the right, on twelve columns: 3, 4 and 5 from 1280 px, 3.5, 4 and
4.5 from 1024 px, two equal columns from 768 px, one below. A band draws the sheet's
edges and the rules between its columns itself. Its pieces:

- The hero is as wide as the sheet, with the copy on the left and the ticket chips to
  its right from 1024 px (`wideFrom` on `TicketChips`); below that the chips sit in a
  band above the copy and one below.
- The three steps are the spine of the page: the strip under the hero (`Steps`), the
  groups of the index, and the first line of every feature's kicker.
- `Tour` is the walk-through. Its markup is nine sections in reading order, which is
  what a phone shows: kicker, headline, scene, copy. Where the `PINNED` query matches (a
  landscape screen at least 1024 px wide and between 40 and 100 em tall; the heights are
  in `em` because the content grows with the reader's font size), the root element
  carries `data-blend-pinned`, and the stylesheet, under the same query, makes the
  walk-through a tall track with a frame pinned under the navbar. The scroll position
  picks the feature, the index marks it with the sheet's tick, and only that feature's
  section shows; its scene is mounted again, so it plays from the start. Picking a
  feature moves the scroll position to its place in the track, which the pinned frame
  hides. `--st-tour-step` is how far the page scrolls for one feature.
- A small script in the page's head sets the attribute before the first paint, so a
  reload is laid out as it was and the browser puts the scroll position back in the same
  layout; the component keeps the attribute in step after that. The script leaves the
  page plain on a fresh visit to an address that names a feature or a piece of text
  (the browser scrolls to it, which only works in the flow of the plain layout); the
  component then opens that feature, unless the reader has scrolled on. If the
  component has not run six seconds later, the script takes the attribute away again.
- The index is then a vertical tablist (arrow keys, Home and End move and select, Enter
  and Space select; Tab goes on into the panel) and the sections are its tabpanels
  (`blend-panel-<id>`). The ones not showing are left unrendered
  (`content-visibility: hidden`), out of the accessibility tree and the tab order, and
  marked `hidden="until-found"`, so the browser's find-in-page reaches their text and
  shows the feature it is in. Focus that is on a tab or inside a feature when scrolling
  replaces it moves to the one that comes.
- Each feature then also has an anchor in the track, at the place the page scrolls to
  for it, which carries the feature's id: a link to `#handoff`, the router's own
  scrolling on back and forward, and the browser's all land there without the
  component. Nothing inside the pinned frame is a target the browser scrolls to: it
  would compute the frame's place as if it were not pinned. For the same reason the
  sections are new elements in each layout.
- Where the query does not match (a short, upright or very tall screen, a large font
  size) or the script has not run, the index is a list of links beside the features,
  which flow down the page and carry the ids. The two layouts differ in height by more
  than a screen, so when one replaces the other (the window is resized, the page
  hydrates plain) the reader is put back where they were: at the same feature, or with
  the band after the walk-through where it was on the screen.
- Keep conditions out of `@supports not`: the minifier folded such a block into the
  rule it was meant to replace. The component checks `CSS.supports` instead.
- The headline of a feature is two lines at every width: `--st-text-serif-feature`
  follows its column (`cqw`). A feature's `accent` (in `parts/content.tsx`) is the part
  of the headline set in italic.
- Rules in a media query start at `main.page`, width ranges that set the same thing do
  not overlap, and the pinned layout, which shares its width with the plain one,
  starts at `main.page .tour.pins`. Under reduced motion nothing inside a feature
  transitions, so the feature that is picked is there at once.

## Parts the experiment pages share

`landing/parts/` holds what more than one of the experiment pages uses. A page that
needs a different look sets the custom properties a part documents; it does not
restyle the part's classes (the minified CSS can reorder rules of equal weight).

| Part | Used by | What it is |
| --- | --- | --- |
| `SerifFont` | bento, blend | Declares the serif face and preloads its two files. Render it once inside `Layout`. |
| `TicketChips`, `useDrift`, `PauseButton` | bento, blend | The chips that drift through a hero (`chips` gives each its places at three widths), whether they may move, and the control that holds them. The page places the button. |
| `Steps` | walkthrough, blend | The three steps in one list, with `--steps-*` properties for its box, lines and titles. |
| `Faq` | walkthrough, blend | The questions as native `details`; `linkClassName` and `linkMark` style the docs link, `--faq-question-*` the questions. |
| `Install` | walkthrough, blend | The install command in a small terminal window with its copy button. |
| `PlanFolder` | bento, blend | The folder of plans that point at each other, as a scene. |
| `CompareTable`, `Planned` | bento, blend | The team's tracker beside staple (`--compare-label` is the width of the label column, a length), and the chip on what is planned. |
| `content.tsx` | all three | The page title, the three steps, the nine features in three chapters, the comparison, the figures and the FAQ. |

## Rules

- One accent: `--st-accent` (and its text, hover and background variants). Use
  it for the primary action, links and small markers, not for large areas.
- Hairline borders (`--st-hairline` with `--st-border`), no shadows.
- Motion is short (`--st-duration-*`, `--st-ease`) and `custom.css` turns
  animations and transitions off under `prefers-reduced-motion`.
- Text pairs meet WCAG AA in both themes. A new text colour has to be a token and
  measured against the surfaces it sits on.
