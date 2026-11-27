/**
 * A page of the interactive widgets for `widgets-browser.test.tsx`, which bundles it with esbuild
 * and mounts it in Chromium. Not part of the app: nothing imports it, and it uses inline styles
 * only so it adds no classes to the app's stylesheet. Every callback appends to `widgetEvents`.
 */
import { createRoot } from "react-dom/client";
import { BarList } from "./BarList";
import { BurstCards } from "./BurstCards";
import { ColumnChart, columnChartTable, type ColumnPoint } from "./ColumnChart";
import { FeatureTable, type FeatureRow } from "./FeatureTable";
import { Heatmap } from "./Heatmap";
import { ReturnRange } from "./ReturnRange";
import { SegmentedBar } from "./SegmentedBar";
import { StatTile } from "./StatTile";
import { Widget } from "./Widget";
import type { ChartSeries } from "./chart-parts";

const events: string[] = [];
(window as unknown as { widgetEvents: string[] }).widgetEvents = events;
const log = (event: string) => () => events.push(event);

const series: ChartSeries[] = [
  { id: "a", label: "Staple", color: "var(--viz-series-1)" },
  { id: "b", label: "Docs", color: "var(--viz-series-2)" },
];
const points: ColumnPoint[] = [
  { key: "d1", label: "Nov 1", tick: "1", values: { a: 2, b: 0 } },
  { key: "d2", label: "Nov 2", values: { a: 1, b: 3 } },
  { key: "d3", label: "Nov 3", tick: "3", values: { a: 6, b: 2 } },
];
const features: FeatureRow[] = Array.from({ length: 10 }, (_, index) => ({ ref: `STA-${index + 1}`, title: `Feature ${index + 1}`, closed: 2, children: 4, shipped: index === 0, agentHours: 12, spanDays: 3 }));
const hours = (value: number) => `${value} h`;

function Fixture() {
  return (
    <main style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, maxWidth: 900 }}>
      <Widget title="Hours per day" sentence="Agents worked 14 hours." table={columnChartTable("Day", series, points)} help="How it is counted." coverage={{ covered: 3, total: 4, noun: "tickets", have: "have an estimate" }}>
        <ColumnChart series={series} points={points} format={hours} ariaLabel="Hours per day: 14 h in total." />
      </Widget>
      <Widget title="Rhythm">
        <Heatmap cells={[[0, 1, 5], [10, 3, 0]]} rows={["Mon", "Tue"]} columns={["12a", "", "2a"]} columnNames={["12 am", "1 am", "2 am"]} format={(value) => `${value} tickets`} ariaLabel="Tickets closed by weekday and hour" />
      </Widget>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <StatTile label="Return" value="2.4×" sentence="It paid for itself." trend={[1, 2, 3]} delta={{ ratio: 0.2, against: "vs before", goodWhen: "up" }} onOpen={log("open-return")} openLabel="Open the Return lens" />
        <StatTile label="Agent time" value="633 h" loading />
      </div>
      <Widget title="What got built">
        <FeatureTable rows={features} onOpen={(ref) => events.push(`open:${ref}`)} />
      </Widget>
      <Widget title="Waiting" state={{ kind: "loading" }} />
      <Widget title="Broken" state={{ kind: "error", message: "The server said 500.", onRetry: log("retry") }} />
      <Widget title="Marks">
        <SegmentedBar ariaLabel="Attempts" parts={[{ id: "a", label: "Done", value: 7 }, { id: "b", label: "Failed", value: 3 }]} />
        <BarList ariaLabel="By workspace" items={[{ id: "a", label: "Staple", value: 4, text: "4 h" }]} />
        <ReturnRange low={{ value: 0.8, label: "low" }} high={{ value: 3.4, label: "high" }} />
        <ReturnRange low={{ value: 2.1, label: "low" }} high={{ value: 2.4, label: "high" }} compact />
      </Widget>
      <Widget title="Bursts">
        <BurstCards bursts={[{ from: "2026-11-02", to: "2026-11-06", days: 5, ticketsDone: 84, agentHours: 96, bestDay: { day: "2026-11-04", count: 41 }, features: [{ title: "Analytics page", closed: 6, children: 8 }] }]} />
      </Widget>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
