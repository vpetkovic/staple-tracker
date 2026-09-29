# Site primitives

The building blocks for marketing pages (`src/pages`). Docs pages do not use
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
| `Screenshot` | `@site/src/components/Screenshot` | A web UI capture in a hairline frame, switching with the theme. `name` is the stem under `static/img/screens` (`<name>-light.webp`, `<name>-dark.webp`, 1280 x 800 at 2x); `alt` says what it shows; `priority` for the one above the fold. |

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

## Rules

- One accent: `--st-accent` (and its text, hover and background variants). Use
  it for the primary action, links and small markers, not for large areas.
- Hairline borders (`--st-hairline` with `--st-border`), no shadows.
- Motion is short (`--st-duration-*`, `--st-ease`) and `custom.css` turns
  animations and transitions off under `prefers-reduced-motion`.
- Text pairs meet WCAG AA in both themes. A new text colour has to be a token and
  measured against the surfaces it sits on.
