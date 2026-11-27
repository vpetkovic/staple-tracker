/**
 * The Overview's blocks, each one a reusable widget fed from the report. The Board is a composition
 * of these and nothing else, which is the point of the widget library: a block knows its data, not
 * the page it sits on.
 *
 * Every block takes `report` possibly undefined and shows its own loading state until it arrives;
 * a block with nothing to draw in the period says so in words instead of drawing an empty chart.
 */
import type { ReactNode } from "react";
import { BarList } from "@/components/analytics/BarList";
import { BurstCards } from "@/components/analytics/BurstCards";
import { seriesColor, type ChartSeries } from "@/components/analytics/chart-parts";
import { ColumnChart, columnChartTable, type ColumnPoint } from "@/components/analytics/ColumnChart";
import { FeatureTable } from "@/components/analytics/FeatureTable";
import { changeRatio, formatCount, formatDay, formatDayRange, formatEffortHours, formatHours, formatMultiple, formatNumber, formatPercent } from "@/components/analytics/format";
import { Heatmap, heatmapTable } from "@/components/analytics/Heatmap";
import { ReturnRange } from "@/components/analytics/ReturnRange";
import { SegmentedBar } from "@/components/analytics/SegmentedBar";
import { StatTile } from "@/components/analytics/StatTile";
import { Widget, type WidgetState } from "@/components/analytics/Widget";
import { ShowDetails } from "@/components/plain/PlainCard";
import type { AnalyticsReport, CostModel, ReturnReport, TrendBucket } from "./proto-api";
import { computeReturn, profileOf } from "./return-model";

export interface OverviewProps {
  report: AnalyticsReport | undefined;
  returns: ReturnReport | undefined;
  model: CostModel | null;
  /** "vs the 30 days before", or "" when the period has nothing before it. */
  against: string;
  onOpenReturn: () => void;
  onOpenTicket: (workspace: string, ref: string) => void;
}

const LOADING: WidgetState = { kind: "loading" };
const stateOf = (report: AnalyticsReport | undefined, has: (report: AnalyticsReport) => boolean, empty: { title: string; hint?: string }): WidgetState =>
  report === undefined ? LOADING : has(report) ? { kind: "ready" } : { kind: "empty", ...empty };
const NOTHING_HINT = "Nothing was recorded in this period. Try a longer one.";

export function chartSeries(report: AnalyticsReport): ChartSeries[] {
  return report.series.map((item) => ({ id: item.id, label: item.label, color: seriesColor(item.slot) }));
}
const workspaceColor = (report: AnalyticsReport, prefix: string) => seriesColor(report.series.find((item) => item.id === prefix)?.slot ?? 0);

/** Buckets as chart slots: the tooltip names each one, the axis ticks only a few. */
export function trendPoints(buckets: readonly TrendBucket[], bucket: "day" | "week" | "month"): ColumnPoint[] {
  return buckets.map((item, index) => {
    const label = bucket === "day" ? formatDay(item.t) : bucket === "week" ? `Week of ${formatDay(item.t)}` : formatDay(item.t).split(" ")[0] ?? item.t;
    const every = bucket === "day" ? (buckets.length > 16 ? 7 : buckets.length > 8 ? 2 : 1) : bucket === "week" ? (buckets.length > 14 ? 4 : 2) : 1;
    return { key: item.t, label, tick: index % every === 0 ? (bucket === "month" ? label : formatDay(item.t)) : undefined, values: item.values };
  });
}
const sum = (values: Record<string, number>) => Object.values(values).reduce((total, value) => total + value, 0);
const bucketWord = { day: "day", week: "week", month: "month" } as const;
/** A tile's sparkline: the period in at most fourteen columns, so each stays a readable mark. */
function sparkValues(buckets: readonly TrendBucket[]): number[] {
  const values = buckets.map((bucket) => sum(bucket.values));
  const size = Math.ceil(values.length / 14);
  if (size <= 1) return values;
  const out: number[] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size).reduce((total, value) => total + value, 0));
  return out;
}
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------- the KPI row

export function KpiRow({ report, returns, model, against, onOpenReturn, className }: Pick<OverviewProps, "report" | "returns" | "model" | "against" | "onOpenReturn"> & { className?: string }) {
  const loading = report === undefined;
  const delta = (measure: { value: number | null; previous: number | null } | undefined, goodWhen: "up" | "down" | "neutral") =>
    against && measure ? { ratio: changeRatio(measure.value, measure.previous), against, goodWhen } : undefined;
  const capacity = report?.capacity;
  const delivery = report?.delivery;
  const speed = report?.speed;
  const reliability = report?.reliability;
  const result = returns && model ? computeReturn(returns, model) : null;
  const low = result?.measured.multiple ?? null;
  const high = result?.planned?.multiple ?? null;
  return (
    <div className={className} data-kpi-row>
      <StatTile
        label="Agent capacity"
        loading={loading}
        value={capacity && (capacity.agentHours.value ?? 0) > 0 ? formatCount(capacity.agentHours.value ?? 0) : null}
        unit="h"
        sentence={capacity ? <>About {formatNumber(capacity.fte, 1)} full-time engineers, up to {capacity.peakParallel.count} agents at once.</> : null}
        trend={capacity ? sparkValues(capacity.trend) : undefined}
        delta={delta(capacity?.agentHours, "neutral")}
        emptyText="No agent time recorded"
      />
      <StatTile
        label="Features shipped"
        loading={loading}
        value={delivery ? formatCount(delivery.featuresDone.value ?? 0) : null}
        sentence={delivery ? <>{plural(delivery.ticketsDone.value ?? 0, "ticket")} closed{(delivery.bugsFixed.value ?? 0) > 0 ? `, ${delivery.bugsFixed.value} of them bug fixes` : ""}.</> : null}
        trend={delivery ? sparkValues(delivery.trend) : undefined}
        delta={delta(delivery?.ticketsDone, "up")}
      />
      <StatTile
        label="Time to done"
        loading={loading}
        value={speed && speed.cycleMedianHours.value !== null ? formatHours(speed.cycleMedianHours.value) : null}
        sentence={speed && speed.ticketsDone > 0 ? <>Typical ticket, claim to done. {formatPercent(speed.sameDay / speed.ticketsDone)} closed within a day of being filed.</> : null}
        delta={delta(speed?.cycleMedianHours, "down")}
        emptyText="No finished tickets with a claim time"
      />
      <StatTile
        label="Agent reliability"
        loading={loading}
        value={reliability && reliability.success.value !== null ? formatPercent(reliability.success.value) : null}
        sentence={reliability ? <>of {plural(reliability.ended, "finished attempt")} did the job.</> : null}
        delta={delta(reliability?.success, "up")}
        emptyText="No attempts ended in this period"
      />
      <StatTile
        label="Return on AI spend"
        loading={loading || returns === undefined}
        value={low !== null && high !== null ? `${formatMultiple(low).replace("×", "")}–${formatMultiple(high)}` : low !== null ? formatMultiple(low) : null}
        sentence={result ? <>Work returned for every 1 it cost, counted two ways.</> : null}
        note={model && profileOf(model).assumed.length > 0 ? "Default rates until you set yours" : undefined}
        onOpen={onOpenReturn}
        openLabel="Open the return on AI spend"
        emptyText="Set rates and AI spend to see it"
      >
        {low !== null ? <ReturnRange compact className="mt-1" low={{ value: low, label: "measured agent time" }} high={high !== null ? { value: high, label: "planned effort" } : null} /> : null}
      </StatTile>
    </div>
  );
}

// ---------------------------------------------------------------- capacity and delivery over time

export function HoursTrend({ report, className, height }: { report: AnalyticsReport | undefined; className?: string; height?: number }) {
  const series = report ? chartSeries(report) : [];
  const points = report ? trendPoints(report.capacity.trend, report.period.bucket) : [];
  const capacity = report?.capacity;
  return (
    <Widget
      className={className}
      title="Agent time"
      sentence={capacity ? <>Hours agents spent working, per {bucketWord[report!.period.bucket]}{series.length > 1 ? ", by workspace" : ""}. Agents ran on {plural(capacity.activeDays.value ?? 0, "day")} of {report!.period.days}.</> : null}
      state={stateOf(report, (data) => (data.capacity.agentHours.value ?? 0) > 0, { title: "No agent time in this period", hint: NOTHING_HINT })}
      table={report ? columnChartTable(report.period.bucket === "day" ? "Day" : "Starting", series, points) : undefined}
      minBodyHeight={200}
      help={
        capacity ? (
          <>
            Agent time is the length of every recorded attempt, added up. One attempt counts for at most {capacity.capHours} hours, so a session left open overnight does not inflate it ({formatEffortHours(capacity.agentHoursUncapped)} without the cap). Agents run in parallel, so this is effort, not hours on the clock.
          </>
        ) : null
      }
    >
      <ColumnChart series={series} points={points} height={height} format={(value) => formatEffortHours(value)} totalLabel="All workspaces" ariaLabel={`Agent hours per ${report?.period.bucket ?? "day"}: ${formatEffortHours(capacity?.agentHours.value ?? 0)} in total.`} />
    </Widget>
  );
}

export function DoneTrend({ report, className, height }: { report: AnalyticsReport | undefined; className?: string; height?: number }) {
  const series = report ? chartSeries(report) : [];
  const points = report ? trendPoints(report.delivery.trend, report.period.bucket) : [];
  const delivery = report?.delivery;
  return (
    <Widget
      className={className}
      title="Tickets closed"
      sentence={delivery ? <>Finished tickets per {bucketWord[report!.period.bucket]}. Something closed on {plural(delivery.daysWithDone, "day")}{delivery.bestDay ? <>; the best was {delivery.bestDay.count} on {formatDay(delivery.bestDay.day)}</> : null}.</> : null}
      state={stateOf(report, (data) => (data.delivery.ticketsDone.value ?? 0) > 0, { title: "No tickets closed in this period", hint: NOTHING_HINT })}
      table={report ? columnChartTable(report.period.bucket === "day" ? "Day" : "Starting", series, points) : undefined}
      minBodyHeight={200}
    >
      <ColumnChart series={series} points={points} height={height} format={(value) => plural(value, "ticket")} totalLabel="All workspaces" ariaLabel={`Tickets closed per ${report?.period.bucket ?? "day"}: ${delivery?.ticketsDone.value ?? 0} in total.`} />
    </Widget>
  );
}

// ---------------------------------------------------------------- what got built

export function FeaturesWidget({ report, className, limit = 8, onOpenTicket }: { report: AnalyticsReport | undefined; className?: string; limit?: number; onOpenTicket: (workspace: string, ref: string) => void }) {
  const all = report?.scope.kind === "all";
  const slugOf = new Map(report?.scope.workspaces.map((workspace) => [workspace.prefix, workspace]) ?? []);
  const rows = (report?.delivery.features ?? []).map((feature) => ({
    ref: feature.ref,
    title: feature.title,
    workspace: all ? { label: slugOf.get(feature.workspace)?.name ?? feature.workspace, color: workspaceColor(report!, feature.workspace) } : undefined,
    closed: feature.closed,
    children: feature.children,
    shipped: feature.shipped,
    agentHours: feature.agentHours,
    spanDays: feature.spanDays,
  }));
  const shipped = rows.filter((row) => row.shipped).length;
  const workspaceOf = new Map(report?.delivery.features.map((feature) => [feature.ref, slugOf.get(feature.workspace)?.slug ?? ""]) ?? []);
  return (
    <Widget
      className={className}
      title="What got built"
      sentence={report ? <>{plural(shipped, "feature")} shipped and {plural(rows.length - shipped, "more", "more")} moved forward. A feature is an epic; it ships when the epic closes.</> : null}
      state={stateOf(report, (data) => data.delivery.features.length > 0, { title: "No feature moved in this period", hint: "A feature shows here when a ticket under an epic closes." })}
      minBodyHeight={220}
    >
      <FeatureTable rows={rows} limit={limit} onOpen={(ref) => onOpenTicket(workspaceOf.get(ref) ?? "", ref)} />
    </Widget>
  );
}

export function WorkspacesWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const rows = report?.delivery.byWorkspace ?? [];
  return (
    <Widget
      className={className}
      title="Where the time went"
      sentence={report ? <>Agent time by workspace, with what it closed there.</> : null}
      state={stateOf(report, (data) => data.delivery.byWorkspace.some((row) => row.agentHours > 0), { title: "No agent time in this period", hint: NOTHING_HINT })}
      minBodyHeight={140}
    >
      <BarList
        ariaLabel="Agent time by workspace"
        items={rows.map((row) => ({
          id: row.id,
          label: row.label,
          value: row.agentHours,
          text: formatEffortHours(row.agentHours),
          detail: `${row.ticketsDone} closed`,
          color: workspaceColor(report!, row.id),
        }))}
      />
    </Widget>
  );
}

export function BurstsWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const bursts = report?.delivery.bursts ?? [];
  const days = bursts.reduce((total, burst) => total + burst.days, 0);
  return (
    <Widget
      className={className}
      title={bursts.length === 1 ? "One burst of work" : `${bursts.length} bursts of work`}
      sentence={report ? <>Work arrives in bursts: runs of days with tickets closing and no gap over 5 days. They took {days} of the {report.period.days} days.</> : null}
      state={stateOf(report, (data) => data.delivery.bursts.length > 0, { title: "No burst of ten or more tickets", hint: "A burst is a run of days with tickets closing." })}
      minBodyHeight={96}
    >
      <BurstCards bursts={bursts} />
    </Widget>
  );
}

// ---------------------------------------------------------------- speed

export function SpeedWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const speed = report?.speed;
  const points: ColumnPoint[] = (speed?.histogram ?? []).map((bin) => ({ key: bin.label, label: bin.label, tick: bin.label, values: { n: bin.count } }));
  const series: ChartSeries[] = [{ id: "n", label: "Tickets", color: "var(--viz-accent)" }];
  return (
    <Widget
      className={className}
      title="How long a ticket takes"
      sentence={
        speed && speed.cycleMedianHours.value !== null ? (
          <>
            Half of finished tickets took under {formatHours(speed.cycleMedianHours.value)} from claim to done
            {speed.cycleP25Hours !== null && speed.cycleP75Hours !== null ? <>; the middle half took {formatHours(speed.cycleP25Hours)} to {formatHours(speed.cycleP75Hours)}</> : null}.
          </>
        ) : null
      }
      state={stateOf(report, (data) => data.speed.measured > 0, { title: "No finished tickets with a claim time", hint: NOTHING_HINT })}
      table={speed ? { columns: ["Time from claim to done", "Tickets"], rows: speed.histogram.map((bin) => [bin.label, bin.count]) } : undefined}
      coverage={speed ? { covered: speed.measured, total: speed.ticketsDone, noun: "finished tickets", have: "have a claim time" } : null}
      help="The clock runs from an agent claiming a ticket to it being marked done, so it includes waiting on review. Tickets finished without a claim have no start and are left out."
      minBodyHeight={200}
    >
      <ColumnChart series={series} points={points} legend={false} height={150} format={(value) => plural(value, "ticket")} ariaLabel="Finished tickets by time from claim to done" />
      {speed && speed.measured > 0 ? (
        <dl className="mt-3 grid grid-cols-3 gap-3 border-t pt-3">
          <Fact term="Under an hour" figure={formatPercent(speed.under1h / speed.measured)} detail={`${speed.under1h} of ${speed.measured}`} />
          <Fact term="Under 4 hours" figure={formatPercent(speed.under4h / speed.measured)} detail={`${speed.under4h} of ${speed.measured}`} />
          <Fact term="Filed and done in a day" figure={formatPercent(speed.sameDay / speed.ticketsDone)} detail={`${speed.sameDay} of ${speed.ticketsDone}`} />
        </dl>
      ) : null}
    </Widget>
  );
}

export function SpeedByKindWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const rows = report?.speed.byKind ?? [];
  return (
    <Widget
      className={className}
      title="Typical time by kind"
      sentence={report ? <>The median from claim to done. Epics stay open until their children close, so they run long.</> : null}
      state={stateOf(report, (data) => data.speed.byKind.length > 0, { title: "No finished tickets with a claim time", hint: NOTHING_HINT })}
      minBodyHeight={120}
    >
      <BarList ariaLabel="Median time from claim to done, by kind" labelWidth="7.5rem" items={rows.map((row) => ({ id: row.id, label: row.label, value: row.medianHours, text: formatHours(row.medianHours), detail: `${row.count} tickets` }))} />
    </Widget>
  );
}

function Fact({ term, figure, detail }: { term: string; figure: ReactNode; detail?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-label text-muted-foreground">{term}</dt>
      <dd className="mt-0.5">
        <span className="text-title font-semibold">{figure}</span>
        {detail ? <span className="ml-1.5 text-label whitespace-nowrap text-muted-foreground tabular-nums">{detail}</span> : null}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------- reliability and the workforce

export function OutcomesWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const reliability = report?.reliability;
  const tones: Record<string, string> = { completed: "var(--viz-accent)", yielded: "var(--viz-series-4)", interrupted: "var(--viz-series-2)", failed: "var(--plain-risk-fg)", running: "var(--viz-series-other)" };
  return (
    <Widget
      className={className}
      title="How attempts ended"
      sentence={
        reliability && reliability.success.value !== null ? (
          <>
            {formatPercent(reliability.success.value)} of {plural(reliability.ended, "finished attempt")} did the job{reliability.medianAttemptMinutes !== null ? <>. A typical attempt ran {formatHours(reliability.medianAttemptMinutes / 60)}</> : null}.
          </>
        ) : null
      }
      state={stateOf(report, (data) => data.reliability.attempts > 0, { title: "No attempts in this period", hint: NOTHING_HINT })}
      help="An attempt is one agent session on one ticket. Handed back means the agent stopped and released the ticket for someone else; interrupted means the session ended without saying why."
      minBodyHeight={80}
    >
      <SegmentedBar ariaLabel="Attempts by how they ended" parts={(reliability?.outcomes ?? []).map((part) => ({ ...part, color: tones[part.id] }))} />
    </Widget>
  );
}

export function ModelsWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const rows = report?.reliability.byModel ?? [];
  const coverage = report?.coverage.model;
  return (
    <Widget
      className={className}
      title="Who did the work"
      sentence={report ? <>Attempts by model family, read from what each agent session reported or from its name.</> : null}
      state={stateOf(report, (data) => data.reliability.byModel.length > 0, { title: "No attempts in this period", hint: NOTHING_HINT })}
      coverage={coverage ? { ...coverage, noun: "attempts", have: "logged their model" } : null}
      help="Staple records the model only when the agent's harness reports it. Where it did not, the family is guessed from the agent's name, and what cannot be guessed is counted as no model logged."
      minBodyHeight={140}
    >
      <BarList ariaLabel="Attempts by model family" labelWidth="10.5rem" items={rows.map((row) => ({ id: row.id, label: row.label, value: row.value, text: row.value.toLocaleString("en-US"), muted: /not logged|No model/.test(row.label) }))} />
    </Widget>
  );
}

export function ParallelWidget({ report, className, height = 120 }: { report: AnalyticsReport | undefined; className?: string; height?: number }) {
  const days = report?.capacity.parallelByDay ?? [];
  const every = days.length > 60 ? 28 : days.length > 16 ? 7 : days.length > 8 ? 2 : 1;
  const points: ColumnPoint[] = days.map((day, index) => ({ key: day.t, label: formatDay(day.t), tick: index % every === 0 ? formatDay(day.t) : undefined, values: { n: day.value } }));
  const peak = report?.capacity.peakParallel;
  return (
    <Widget
      className={className}
      title="Agents at once"
      sentence={peak && peak.count > 0 ? <>The most agents working at the same moment, each day. The peak was {peak.count}{peak.at ? <> on {formatDay(peak.at.slice(0, 10))}</> : null}.</> : null}
      state={stateOf(report, (data) => data.capacity.peakParallel.count > 0, { title: "No agents ran in this period", hint: NOTHING_HINT })}
      table={report ? { columns: ["Day", "Most agents at once"], rows: days.map((day) => [formatDay(day.t), day.value]) } : undefined}
      minBodyHeight={160}
    >
      <ColumnChart series={[{ id: "n", label: "Agents at once", color: "var(--viz-accent)" }]} points={points} legend={false} height={height} format={(value) => plural(value, "agent")} ariaLabel={`Peak concurrent agents per day; the highest was ${peak?.count ?? 0}.`} />
    </Widget>
  );
}

// ---------------------------------------------------------------- rhythm, mix, estimates, record

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourName = (hour: number) => `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "am" : "pm"}`;
const HOUR_NAMES = Array.from({ length: 24 }, (_, hour) => hourName(hour));
const HOUR_TICKS = Array.from({ length: 24 }, (_, hour) => (hour % 3 === 0 ? `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? "a" : "p"}` : ""));

export function RhythmWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const rhythm = report?.rhythm;
  return (
    <Widget
      className={className}
      title="When the work lands"
      sentence={
        rhythm && rhythm.ticketsDone > 0 ? (
          <>
            Tickets closed by weekday and hour ({report!.tz.replace("_", " ")}). {formatPercent(rhythm.night / rhythm.ticketsDone)} closed between 10 pm and 6 am, and {rhythm.weekend} on weekends: work that happened while you were away.
          </>
        ) : null
      }
      state={stateOf(report, (data) => data.rhythm.ticketsDone > 0, { title: "No tickets closed in this period", hint: NOTHING_HINT })}
      table={rhythm ? heatmapTable(rhythm.heat, WEEKDAYS, HOUR_NAMES) : undefined}
      minBodyHeight={170}
    >
      <Heatmap cells={rhythm?.heat ?? []} rows={WEEKDAYS} columns={HOUR_TICKS} columnNames={HOUR_NAMES} format={(value) => plural(value, "ticket")} ariaLabel="Tickets closed by weekday and hour of day" />
    </Widget>
  );
}

export function MixWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const mix = report?.delivery.mix;
  return (
    <Widget className={className} title="What kind of work" sentence={report ? <>Finished tickets by kind and by priority.</> : null} state={stateOf(report, (data) => (data.delivery.ticketsDone.value ?? 0) > 0, { title: "No tickets closed in this period", hint: NOTHING_HINT })} minBodyHeight={130}>
      <div className="flex flex-col gap-4">
        <SegmentedBar ariaLabel="Finished tickets by kind" parts={mix?.byKind ?? []} />
        <SegmentedBar ariaLabel="Finished tickets by priority" tone="ordinal" parts={mix?.byPriority ?? []} />
      </div>
    </Widget>
  );
}

export function EstimatesWidget({ report, className, onOpenEstimates }: { report: AnalyticsReport | undefined; className?: string; onOpenEstimates?: () => void }) {
  const estimates = report?.estimates;
  const pairs = estimates?.pairs;
  return (
    <Widget
      className={className}
      title="Planned effort against agent time"
      sentence={
        pairs && pairs.count > 0 && pairs.medianRatio !== null ? (
          <>
            On {plural(pairs.count, "ticket")} with both an estimate and recorded time, agents used a typical {formatPercent(pairs.medianRatio)} of the estimate. Estimates are planning figures, close to what a person would need.
          </>
        ) : null
      }
      state={stateOf(report, (data) => data.estimates.pairs.count > 0, { title: "No estimated tickets finished in this period", hint: "Estimate tickets when you plan them and this fills in." })}
      coverage={report ? { ...report.coverage.estimates, noun: "finished tickets", have: "have an estimate" } : null}
      footer={
        onOpenEstimates ? (
          <button type="button" onClick={onOpenEstimates} className="focus-ring relative inline-flex h-6 min-h-0 items-center rounded-md text-label font-medium text-muted-foreground before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:text-foreground">
            Open Estimates for accuracy by group
          </button>
        ) : null
      }
      minBodyHeight={90}
    >
      <BarList
        ariaLabel="Estimated hours against agent hours on the same tickets"
        labelWidth="7.5rem"
        items={[
          { id: "estimated", label: "Estimated", value: pairs?.estimatedHours ?? 0, text: formatEffortHours(pairs?.estimatedHours ?? 0), color: "var(--viz-muted-mark)" },
          { id: "actual", label: "Agent time", value: pairs?.actualHours ?? 0, text: formatEffortHours(pairs?.actualHours ?? 0) },
        ]}
      />
    </Widget>
  );
}

export function RecordWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const record = report?.record;
  const megabytes = (record?.fileBytes ?? 0) / 1_048_576;
  return (
    <Widget
      className={className}
      title="The paper trail"
      sentence={record ? <>What agents wrote down while working: {plural(record.comments, "comment")}, {plural(record.documents, "document")} and {plural(record.files, "evidence file")} ({formatNumber(megabytes)} MB).</> : null}
      state={stateOf(report, (data) => data.record.comments + data.record.documents + data.record.files > 0, { title: "Nothing written in this period", hint: NOTHING_HINT })}
      minBodyHeight={120}
    >
      <BarList ariaLabel="Ticket documents by type" labelWidth="8.5rem" items={(record?.docTypes ?? []).map((part) => ({ id: part.id, label: part.label, value: part.value, text: part.value.toLocaleString("en-US"), muted: part.id === "other" }))} />
    </Widget>
  );
}

/** How the page counts, and what limits each count. Closed by default: the caveats that matter sit on their widgets. */
export function MethodNotes({ report }: { report: AnalyticsReport | undefined }) {
  if (!report) return null;
  const { coverage, capacity } = report;
  return (
    <ShowDetails dense label="How this is measured">
      <ul className="max-w-3xl list-disc space-y-1.5 pl-5 text-body text-text-secondary">
        <li>Read from {report.scope.kind === "all" ? "every workspace on this computer" : "this workspace"}, {formatDayRange(report.period.from, report.period.to)}, in {report.tz.replace("_", " ")} time. Ideas and milestones are not tickets and are left out. A feature is an epic.</li>
        <li>Agent time adds up recorded attempts, each capped at {capacity.capHours} hours ({coverage.cappedAttempts} ran longer; {formatEffortHours(capacity.agentHoursUncapped)} without the cap). {coverage.openAttempts > 0 ? `${coverage.openAttempts} attempts are still running and are not counted yet.` : ""}</li>
        <li>Full-time equivalent is agent hours ÷ (40 hours × the weeks in the period). It describes capacity, not that a person would have needed exactly that long.</li>
        {coverage.timing.rebuilt > 0 ? <li>{coverage.timing.rebuilt} of {coverage.timing.rebuilt + coverage.timing.recorded} attempts have times rebuilt from older logs, which are less precise than times recorded as the work happened.</li> : null}
        <li>Only {coverage.model.covered} of {coverage.model.total} attempts logged their model, so the model split is partly read from agent names.</li>
      </ul>
    </ShowDetails>
  );
}
