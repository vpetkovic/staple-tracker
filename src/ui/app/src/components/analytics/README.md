# Analytics widgets

Charts and figures for reports. Each widget takes data and options and knows nothing about the
page it sits on: it never fetches, never reads the URL and never decides what a number means. The
caller ranks, folds, formats and words the data; the widget draws it.

The header comment at the top of each file is the same contract as its section here. Change both
together.

## Using them

- Import `analytics.css` once in the page (or app) that shows them. It holds the series colours,
  the heat ramp and the forced-colours rules. Everything else the widgets wear is an app token.
- Put a chart inside a `Widget`. The frame owns loading, empty, error and partial data, so the chart
  only ever draws real data.
- Give every chart a table twin (`columnChartTable`, `heatmapTable`) through `Widget`'s `table`, so
  no value lives only in a tooltip or a colour.
- Say numbers with `format.ts`, so a figure reads the same on a tile, an axis, a tooltip and a table.

Rules every widget keeps:

- **Keyboard.** A chart is one tab stop. Its keys move an active slot or cell; Escape clears it.
  Every control has a visible focus ring (`focus-ring` or `focus-ring-inset`) and an accessible name.
- **Screen reader.** A chart is a named image (`ariaLabel`). Its readout is said once, through one
  polite live region; the visible tooltip is hidden from assistive technology.
- **Touch.** On a coarse pointer the house base layer makes every button at least 44px tall. These
  widgets keep their desk size (`min-h-0`) and grow an invisible tap area of at least 32px
  (`before:absolute before:-inset-…`).
- **Forced colours.** Marks are background fills, so each mark carries `data-mark` and keeps its own
  colour; tracks (`data-track`) get a system-colour outline, gridlines (`data-gridline`) are drawn
  in `GrayText`, and the active slot or cell (`data-active`) gets a `Highlight` outline.
- **Reduced motion.** Skeletons stop pulsing and nothing moves on hover.

Tests sit beside each module: `<Module>.test.tsx` renders markup and pins the data contract;
`widgets-browser.test.tsx` mounts `widgets.fixture.tsx` in Chromium and checks keys, clicks, touch
sizes, forced colours and reduced motion. It needs `npm run build:ui` and a Playwright Chromium.

## Widget

The frame every widget sits in: a title, one plain sentence, the body, the partial-data note and
"What does this mean?". It owns four states: loading, empty, error and partial coverage. A state
replaces the body and keeps the frame and its height, so a page never jumps when data arrives.

| Prop | Type | Meaning |
|---|---|---|
| `title` | `string` | What this is. Also the section's accessible name. |
| `sentence` | `ReactNode` | The answer in a sentence. Shown only when ready. |
| `state` | `WidgetState` | `ready` (default), `loading`, `empty` with `title` and `hint`, or `error` with `message` and an optional `onRetry`. |
| `coverage` | `Coverage \| null` | `covered` of `total` `noun` that `have` something. Draws nothing when everything is covered. |
| `help` | `ReactNode` | The method in two or three sentences, behind "What does this mean?". |
| `table` | `WidgetTable` | The chart's table twin. Given one, the header carries a Table switch that swaps the body. |
| `actions` | `ReactNode` | Controls in the header, before the Table switch. |
| `footer` | `ReactNode` | Extra content in the footer row, shown only when ready. |
| `minBodyHeight` | `number` | Height held while loading, empty or failed. Default 120. |
| `className`, `bodyClassName` | `string` | Classes for the frame and the body. |

States: loading is a polite status that says "Loading {title}". Empty shows its own words. Error is
an alert with "Try again" when there is an `onRetry`. Every state other than ready drops the
sentence, the Table switch, the coverage note and the help.

`CoverageNote` is the partial-data note on its own, for a figure outside a widget.

```tsx
<Widget title="Agent time" sentence="Agents worked 633 hours." state={state} table={columnChartTable("Day", series, points)}
  coverage={{ covered: 248, total: 346, noun: "finished tickets", have: "have an estimate" }} help="Counted from claim to done.">
  <ColumnChart series={series} points={points} ariaLabel="Agent hours per day: 633 h in total." />
</Widget>
```

## StatTile

One headline number: the label, the figure, what it means in a sentence, how it moved against the
period before and its shape over time.

| Prop | Type | Meaning |
|---|---|---|
| `label` | `string` | What is measured, sentence case. The tile's accessible name. |
| `value` | `ReactNode \| null` | The figure, already formatted. `null` means nothing to measure yet. |
| `unit` | `string` | Trails the figure, smaller. |
| `sentence` | `ReactNode` | The figure in human terms. |
| `delta` | `StatDelta` | `ratio` (signed share, null when there is no base), `against` ("vs the 30 days before") and `goodWhen` (`up`, `down` or `neutral`). |
| `trend` | `readonly number[]` | Values in time order for the sparkline; the last is the current bucket. Two or more draw it. |
| `note` | `ReactNode` | A caveat that limits the figure, with the dashed partial mark. |
| `emptyText` | `string` | Words for `value: null`. Default "Nothing to measure yet". |
| `loading` | `boolean` | Draws the tile's own skeleton. |
| `onOpen` | `() => void` | Makes the whole tile a button. |
| `openLabel` | `string` | The button's accessible name. Default `label`. |
| `className`, `children` | | Classes for the tile; extra content under the sentence. |

States: `loading` draws a skeleton; `value: null` says the empty words and never a 0. The delta is
green when it moved the way `goodWhen` says, red when the other way and untoned for `neutral`. A
change under half a percent says "No change"; no base says "No earlier period to compare".

`DeltaMark` and `Sparkline` are exported for use on their own.

```tsx
<StatTile label="Agent time" value="633" unit="h" sentence="About 1.5 full-time engineers for 11 weeks."
  delta={{ ratio: 0.32, against: "vs the 30 days before", goodWhen: "up" }} trend={weekly} />
```

## ColumnChart

Columns over an ordered axis: time buckets stacked by series, or the bins of a distribution.

| Prop | Type | Meaning |
|---|---|---|
| `series` | `readonly ChartSeries[]` | Who is stacked, bottom to top, each with its colour. One series draws no legend. |
| `points` | `readonly ColumnPoint[]` | The slots in order: `key`, the `label` the tooltip and table say, an optional `tick` (leave it out to skip that slot's tick) and `values` per series id. |
| `ariaLabel` | `string` | The chart in a sentence: what it shows and its headline. |
| `format` | `(value) => string` | How a value is said in the tooltip and the readout. |
| `axisFormat` | `(value) => string` | How a y tick is said. |
| `totalLabel` | `string` | The total row's name for two or more series. Default "Total". |
| `height` | `number` | Plot height in px. Default 168. |
| `legend` | `boolean` | Draw the legend (two or more series only). Default true. |
| `className` | `string` | Classes for the chart. |

Stacks are proportional to their total against the top clean tick; a series at zero draws no
segment. More than six ticks hide every second one when the chart is under 440px wide.

Keyboard: the plot is one tab stop. Left and Right move the active slot, Home and End jump to the
ends, Escape clears it (Escape with nothing active is left to the page). Hover and focus show the
same tooltip, and the live region says it once: "Nov 3: 6 h Staple, 2 h Docs; 8 h Total".

`columnChartTable(firstColumn, series, points, totalLabel?)` gives the table twin.

```tsx
<ColumnChart series={series} points={points} format={formatEffortHours} totalLabel="All workspaces"
  ariaLabel="Agent hours per day: 633 h in total." />
```

## BarList

Ranked horizontal bars on one baseline, one hue: for comparing parts with each other, or a row of
ratios.

| Prop | Type | Meaning |
|---|---|---|
| `items` | `readonly BarListItem[]` | In the order to draw (the caller ranks). Each has `id`, `label`, `value`, the `text` that says the value, an optional quiet `detail`, an optional `color` and `muted` for a caveat row ("No model logged"). |
| `ariaLabel` | `string` | The list's accessible name. |
| `max` | `number` | The value a full bar stands for. Default the largest value. |
| `labelWidth` | `string` | Width of the label column. Default `9rem`. |
| `className` | `string` | Classes for the list. |

A bar above zero is at least 1.5% wide so it shows; zero draws nothing. A row's `color` paints its
bar (a workspace keeps its series colour); a muted row is the neutral; otherwise the accent.

```tsx
<BarList ariaLabel="Agent time by workspace" items={[{ id: "sta", label: "Staple", value: 490, text: "490 h", detail: "62%" }]} />
```

## SegmentedBar

One whole split into parts: a 28px bar of blocks, each share printed on its block where it fits,
and a legend naming every part with its amount.

| Prop | Type | Meaning |
|---|---|---|
| `parts` | `readonly SegmentPart[]` | In the order to draw, each `{ id, label, value }` with an optional `color`. Parts at zero draw nothing. |
| `ariaLabel` | `string` | What the whole is. Each part's name, amount and share are added to it. |
| `tone` | `"categorical" \| "ordinal"` | Categorical slots in order (default), or one hue dark to light for ordered parts. |
| `format` | `(value) => string` | How an amount is said. |
| `className` | `string` | Classes for the bar. |

Use it for at most six parts and fold a tail into "Other" first. A share is printed on its block
from 9%; every part's name, amount and share stay in the accessible name, and its name and amount
in the legend, so nothing needs hover. With every part at zero the name says "nothing to show".

```tsx
<SegmentedBar ariaLabel="Finished tickets by priority" tone="ordinal" parts={byPriority} />
```

## Heatmap

A week by the hour: rows and columns of counts in five steps of one hue, from nothing to the
busiest cell.

| Prop | Type | Meaning |
|---|---|---|
| `cells` | `readonly (readonly number[])[]` | `cells[row][column]` counts. |
| `rows` | `readonly string[]` | The row names ("Mon"). |
| `columns` | `readonly string[]` | The tick under each column; "" for none. |
| `columnNames` | `readonly string[]` | What each column is called in the readout ("3 am"). |
| `format` | `(value) => string` | How a cell is said ("21 tickets"). |
| `ariaLabel` | `string` | The grid's accessible name. |
| `className` | `string` | Classes for the heatmap. |

Keyboard: the grid is one tab stop. The arrow keys move the active cell (the first lands top left),
Home and End go to the ends of its row, Escape clears it. The readout under the grid is a polite
live region: the active cell, or the busiest hour when none is active.

`heatmapTable(cells, rows, columnNames)` gives the table twin.

```tsx
<Heatmap cells={heat} rows={WEEKDAYS} columns={HOUR_TICKS} columnNames={HOUR_NAMES} format={(n) => `${n} tickets`}
  ariaLabel="Tickets closed by weekday and hour of day" />
```

## FeatureTable

What got built: one row per feature (an epic) with how much of it is closed, the agent time it
took and how long it ran.

| Prop | Type | Meaning |
|---|---|---|
| `rows` | `readonly FeatureRow[]` | In the order to draw. Each has `ref`, `title`, an optional `workspace` (`label`, `color`), `closed` of `children` tickets, `shipped` in the period, `agentHours` and `spanDays` (null when nothing closed). |
| `limit` | `number` | Rows shown before "Show all". Default 8. |
| `onOpen` | `(ref) => void` | Makes each title a button. |
| `hideTitles` | `boolean` | Shows each reference instead of its title, for a screen you are about to share. |
| `className` | `string` | Classes for the table. |

```tsx
<FeatureTable rows={features} limit={6} onOpen={(ref) => openTicket(ref)} />
```

## BurstCards

Work arrives in bursts: one card per run of days with tickets closing.

| Prop | Type | Meaning |
|---|---|---|
| `bursts` | `readonly Burst[]` | Oldest first. Each has `from` and `to` days, `days`, `ticketsDone`, `agentHours`, `bestDay` (`day`, `count`) and up to three `features` (`title`, `closed` of `children`). |
| `hideTitles` | `boolean` | Drops the feature titles. |
| `className` | `string` | Classes for the list. |

An empty list draws no cards; the frame's empty state says why.

```tsx
<BurstCards bursts={bursts} />
```

## ReturnRange

The return on spend as a range, because the value of the work is counted two ways: a low end
(measured agent time) and a high end (planned effort). The scale starts at 0; the zone left of
break-even is tinted as where the work cost more than it returned, and break-even is a labelled
tick. It computes nothing.

| Prop | Type | Meaning |
|---|---|---|
| `low`, `high` | `ReturnEnd \| null` | Multiples as `{ value, label }`. Either may be null; one end then draws alone. Both null draws nothing. |
| `breakEven` | `number` | The break-even multiple. Default 1. |
| `compact` | `boolean` | The bar alone, for a stat tile. |
| `className` | `string` | Classes for the range. |

Each end carries its figure above its dot. Two ends closer than 14% of the scale are printed once,
as "2.1× to 2.4×", over their midpoint.

```tsx
<ReturnRange low={{ value: 0.8, label: "measured agent time" }} high={{ value: 3.4, label: "planned effort" }} />
```

## chart-parts

The pieces the charts share. `ChartSeries` is `{ id, label, color }`. `seriesColor(slot)` gives the
six fixed categorical slots in order and "Other" past them: give an entity one slot and keep it.
`ChartLegend` names two or more series. `ChartTooltip` is the hover and focus box (hidden from
assistive technology; the chart's live region says it). `tooltipAnchor` places it over a slot.

## format

How a number is said, as pure functions with no locale state and no clock.

| Function | Says |
|---|---|
| `formatCount` | 1,284 · 12.9K · 4.2M: whole under 10,000, compact above. |
| `formatNumber` | One decimal under 10, none above, unless given `digits`. |
| `formatHours` | "under a minute", "22 min", "1.1 h", "3 days" from 72 hours. |
| `formatEffortHours` | "9.9 h", "633 h", "1,619 h": never days. |
| `formatMoney` | $950 · $26.6K · $1.2M: whole dollars under 10,000, with a true minus. |
| `formatMultiple` | 0.73× · 2.4× · 12×. |
| `formatPercent` | A ratio as a percent, whole unless given `digits`. |
| `formatDay`, `formatDayRange` | "Nov 4"; "Oct 28 – Nov 26", with the year only when the ends differ in it. |
| `changeRatio` | The signed share of change; null with no value, no base or a zero base. |
| `niceTicks` | 0 and clean steps up to at least the max; `[0, 1]` when there is nothing to scale. |
