# Site primitives

The building blocks for marketing pages (`src/pages`, and the two landing pages in `landing/`: see "Choosing the landing page" in CONTRIBUTING.md), and the animated scenes those pages show features with (see "Scenes" below). Docs pages do not use
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
| `ApprovalGate` | An epic waits on a person; Approve is pressed; the tickets under it become ready. |
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
   places.
5. Use the landing page's example data (prefix APP, the Multi-tenancy epic) and claim
   nothing the docs do not. An integration that is not shipped carries the Planned chip.
6. Add it to `scenes/catalog.ts` and `scenes/index.ts`, then look at it on `/scenes` at
   every width, in both themes, and with reduced motion.

## Rules

- One accent: `--st-accent` (and its text, hover and background variants). Use
  it for the primary action, links and small markers, not for large areas.
- Hairline borders (`--st-hairline` with `--st-border`), no shadows.
- Motion is short (`--st-duration-*`, `--st-ease`) and `custom.css` turns
  animations and transitions off under `prefers-reduced-motion`.
- Text pairs meet WCAG AA in both themes. A new text colour has to be a token and
  measured against the surfaces it sits on.
