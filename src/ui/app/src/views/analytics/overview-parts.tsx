/**
 * The Overview's blocks, each one a reusable widget fed from the report. The Board is a composition
 * of these and nothing else, which is the point of the widget library: a block knows its data, not
 * the page it sits on.
 *
 * Every block takes `report` possibly undefined and shows its own loading state until it arrives;
 * a block with nothing to draw in the period says so in words instead of drawing an empty chart.
 */
import { CircleDashed } from "lucide-react";
import type { ReactNode } from "react";
import { BarList } from "@/components/analytics/BarList";
import { BurstCards } from "@/components/analytics/BurstCards";
import type { ChartSeries } from "@/components/analytics/chart-parts";
import { ColumnChart, columnChartTable, type ColumnPoint } from "@/components/analytics/ColumnChart";
import { FeatureTable } from "@/components/analytics/FeatureTable";
import { formatCount, formatDay, formatDayRange, formatEffortHours, formatHours, formatMultiple, formatNumber, formatPercent } from "@/components/analytics/format";
import { Heatmap, heatmapTable } from "@/components/analytics/Heatmap";
import { ReturnRange } from "@/components/analytics/ReturnRange";
import { SegmentedBar } from "@/components/analytics/SegmentedBar";
import { StatTile } from "@/components/analytics/StatTile";
import { Widget, type WidgetState } from "@/components/analytics/Widget";
import { ShowDetails } from "@/components/plain/PlainCard";
import type { AnalyticsHeadline, AnalyticsReport, CaveatCode, RoiResponse } from "@/lib/analytics-api";
import {
  againstWords,
  burstsOf,
  caveatSentences,
  coverageOf,
  documentBars,
  endedAttempts,
  featureRows,
  furtherHistorySentence,
  headlineChange,
  historyGoesFurther,
  kindParts,
  kindSpeedBars,
  modelBars,
  outcomeParts,
  parallelPoints,
  priorityParts,
  returnTile,
  sparkValues,
  trendPoints,
  workspaceBars,
  workspaceLanes,
} from "./overview-data";

export interface OverviewProps {
  report: AnalyticsReport | undefined;
  /** The return on AI spend for the same query; undefined while it loads, null when it could not be read. */
  roi: RoiResponse | null | undefined;
  /** The session's workspace slugs in order: each workspace's colour slot is its place here. */
  order: readonly string[];
  onOpenReturn: () => void;
  onOpenTicket: (workspace: string, ref: string) => void;
}

const LOADING: WidgetState = { kind: "loading" };
const stateOf = (report: AnalyticsReport | undefined, has: (report: AnalyticsReport) => boolean, empty: { title: string; hint?: string }): WidgetState =>
  report === undefined ? LOADING : has(report) ? { kind: "ready" } : { kind: "empty", ...empty };
const NOTHING_HINT = "Nothing was recorded in this period. Try a longer one.";
const bucketWord = { day: "day", week: "week", month: "month" } as const;
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const tableFirst = (report: AnalyticsReport) => (report.period.bucket === "day" ? "Day" : "Starting");

/** One limit on the figures, with the dashed partial-data mark. */
function Note({ id, children, attribute }: { id: string; children: ReactNode; attribute: "data-caveat" | "data-page-note" }) {
  return (
    <p className="inline-flex min-h-6 items-start gap-1.5 text-label text-muted-foreground" {...{ [attribute]: id }}>
      <CircleDashed aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** The caveats that limit one widget, each as a sentence beside its partial-data note. */
function CaveatNotes({ report, codes }: { report: AnalyticsReport | undefined; codes: readonly CaveatCode[] }) {
  if (!report) return null;
  return (
    <>
      {caveatSentences(report, codes).map((note) => (
        <Note key={note.code} id={note.code} attribute="data-caveat">
          {note.sentence}
        </Note>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- the KPI row

export function KpiRow({ report, roi, onOpenReturn, className }: Pick<OverviewProps, "report" | "roi" | "onOpenReturn"> & { className?: string }) {
  const loading = report === undefined;
  const against = report ? againstWords(report) : "";
  const delta = (key: keyof AnalyticsHeadline, goodWhen: "up" | "down" | "neutral") => (report && against ? { ratio: headlineChange(report, key), against, goodWhen } : undefined);
  const headline = report?.headline;
  const lead = report?.speed.lead;
  const ret = roi ? returnTile(roi) : null;
  const measured = ret?.measured ?? null;
  const planned = ret?.planned ?? null;
  // The figure reads low to high, whichever count is the smaller.
  const low = measured !== null && planned !== null ? Math.min(measured, planned) : measured;
  const high = measured !== null && planned !== null ? Math.max(measured, planned) : planned;
  return (
    <div className={className} data-kpi-row>
      <StatTile
        label="Agent capacity"
        loading={loading}
        value={headline && headline.agentHours > 0 ? formatCount(headline.agentHours) : null}
        unit="h"
        sentence={headline && headline.agentHours > 0 ? <>About {formatNumber(headline.ftePeriod ?? 0, 1)} full-time {formatNumber(headline.ftePeriod ?? 0, 1) === "1" ? "engineer" : "engineers"}, up to {plural(headline.peakConcurrency, "agent")} at once.</> : null}
        trend={report ? sparkValues(report, "agentHours") : undefined}
        delta={delta("agentHours", "neutral")}
        emptyText="No agent time recorded"
      />
      <StatTile
        label="Features shipped"
        loading={loading}
        value={headline ? formatCount(headline.epicsDone) : null}
        sentence={headline ? <>{plural(headline.done, "ticket")} closed{headline.bugsFixed > 0 ? `, ${headline.bugsFixed.toLocaleString("en-US")} of them bug fixes` : ""}.</> : null}
        trend={report ? sparkValues(report, "done") : undefined}
        delta={delta("done", "up")}
      />
      <StatTile
        label="Time to done"
        loading={loading}
        value={headline && headline.medianCycleHours !== null ? formatHours(headline.medianCycleHours) : null}
        sentence={lead && lead.n > 0 ? <>Typical ticket, claim to done. {formatPercent(lead.within24h / lead.n)} closed within a day of being filed.</> : null}
        delta={delta("medianCycleHours", "down")}
        emptyText="No finished tickets with a claim time"
      />
      <StatTile
        label="Agent reliability"
        loading={loading}
        value={headline && headline.attemptSuccessRate !== null ? formatPercent(headline.attemptSuccessRate) : null}
        sentence={report && headline?.attemptSuccessRate !== null ? <>of {plural(endedAttempts(report), "finished attempt")} did the job.</> : null}
        delta={delta("attemptSuccessRate", "up")}
        emptyText="No attempts ended in this period"
      />
      <StatTile
        label="Return on AI spend"
        loading={loading || roi === undefined}
        value={low !== null && high !== null && formatMultiple(low) !== formatMultiple(high) ? `${formatMultiple(low).replace("×", "")}–${formatMultiple(high)}` : low !== null ? formatMultiple(low) : null}
        sentence={low !== null ? <>Work returned for every 1 it cost, counted two ways.</> : null}
        note={ret?.assumed ? "Default rates until you set yours" : undefined}
        onOpen={onOpenReturn}
        openLabel="Open the return on AI spend"
        emptyText={roi === null ? "Could not be worked out" : "Set rates and AI spend to see it"}
      >
        {measured !== null ? <ReturnRange compact className="mt-1" low={{ value: measured, label: "measured agent time" }} high={planned !== null ? { value: planned, label: "planned effort" } : null} /> : null}
      </StatTile>
    </div>
  );
}

// ---------------------------------------------------------------- capacity and delivery over time

export function HoursTrend({ report, order, className, height }: { report: AnalyticsReport | undefined; order: readonly string[]; className?: string; height?: number }) {
  const lanes = report ? workspaceLanes(report, order) : null;
  const series = lanes?.series ?? [];
  const points = report && lanes ? trendPoints(report, "agentHours", lanes) : [];
  const capacity = report?.capacity;
  return (
    <Widget
      className={className}
      title="Agent time"
      sentence={report && capacity ? <>Hours agents spent working, per {bucketWord[report.period.bucket]}{series.length > 1 ? ", by workspace" : ""}. Agents ran on {plural(capacity.activeDays, "day")} of {report.period.days}.</> : null}
      state={stateOf(report, (data) => data.capacity.agentHours > 0, { title: "No agent time in this period", hint: NOTHING_HINT })}
      table={report ? columnChartTable(tableFirst(report), series, points) : undefined}
      footer={<CaveatNotes report={report} codes={["capped_attempts", "reconstructed"]} />}
      minBodyHeight={200}
      help={
        report && capacity ? (
          <>
            Agent time is the length of every recorded attempt, added up, with pauses taken out. One attempt counts for at most {report.definitions.attemptCapHours} hours, so a session left open overnight does not inflate it ({formatEffortHours(capacity.agentHoursUncapped)} without the cap). Agents run in parallel, so this is effort, not hours on the clock.
          </>
        ) : null
      }
    >
      <ColumnChart series={series} points={points} height={height} format={(value) => formatEffortHours(value)} totalLabel="All workspaces" ariaLabel={`Agent hours per ${report?.period.bucket ?? "day"}: ${formatEffortHours(capacity?.agentHours ?? 0)} in total.`} />
    </Widget>
  );
}

export function DoneTrend({ report, order, className, height }: { report: AnalyticsReport | undefined; order: readonly string[]; className?: string; height?: number }) {
  const lanes = report ? workspaceLanes(report, order) : null;
  const series = lanes?.series ?? [];
  const points = report && lanes ? trendPoints(report, "done", lanes) : [];
  const delivery = report?.delivery;
  return (
    <Widget
      className={className}
      title="Tickets closed"
      sentence={report && delivery ? <>Finished tickets per {bucketWord[report.period.bucket]}. Something closed on {plural(delivery.daysWithDone, "day")}{delivery.bestDay ? <>; the best was {delivery.bestDay.done} on {formatDay(delivery.bestDay.date)}</> : null}.</> : null}
      state={stateOf(report, (data) => data.delivery.done > 0, { title: "No tickets closed in this period", hint: NOTHING_HINT })}
      table={report ? columnChartTable(tableFirst(report), series, points) : undefined}
      minBodyHeight={200}
    >
      <ColumnChart series={series} points={points} height={height} format={(value) => plural(value, "ticket")} totalLabel="All workspaces" ariaLabel={`Tickets closed per ${report?.period.bucket ?? "day"}: ${delivery?.done ?? 0} in total.`} />
    </Widget>
  );
}

// ---------------------------------------------------------------- what got built

export function FeaturesWidget({ report, order, className, limit = 8, onOpenTicket }: { report: AnalyticsReport | undefined; order: readonly string[]; className?: string; limit?: number; onOpenTicket: (workspace: string, ref: string) => void }) {
  const rows = report ? featureRows(report, workspaceLanes(report, order)) : [];
  const shipped = rows.filter((row) => row.shipped).length;
  const workspaceOf = new Map(rows.map((row) => [row.ref, row.slug]));
  return (
    <Widget
      className={className}
      title="What got built"
      sentence={report ? <>{plural(shipped, "feature")} shipped and {plural(rows.length - shipped, "more", "more")} moved forward. A feature is an epic; it ships when the epic closes.</> : null}
      state={stateOf(report, () => rows.length > 0, { title: "No feature moved in this period", hint: "A feature shows here when a ticket under an epic closes." })}
      coverage={report ? coverageOf(report, "done_without_agent_time", "finished tickets", "have agent time") : null}
      minBodyHeight={220}
    >
      <FeatureTable rows={rows} limit={limit} onOpen={(ref) => onOpenTicket(workspaceOf.get(ref) ?? "", ref)} />
    </Widget>
  );
}

export function WorkspacesWidget({ report, order, className }: { report: AnalyticsReport | undefined; order: readonly string[]; className?: string }) {
  const rows = report ? workspaceBars(report, workspaceLanes(report, order)) : [];
  return (
    <Widget
      className={className}
      title="Where the time went"
      sentence={report ? <>Agent time by workspace, with what it closed there.</> : null}
      state={stateOf(report, (data) => data.workspaces.some((row) => row.agentHours > 0), { title: "No agent time in this period", hint: NOTHING_HINT })}
      minBodyHeight={140}
    >
      <BarList ariaLabel="Agent time by workspace" items={rows} />
    </Widget>
  );
}

export function BurstsWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const bursts = report ? burstsOf(report) : [];
  const days = bursts.reduce((total, burst) => total + burst.days, 0);
  const definitions = report?.definitions;
  return (
    <Widget
      className={className}
      title={bursts.length === 1 ? "One burst of work" : `${bursts.length} bursts of work`}
      sentence={report && definitions ? <>Work arrives in bursts: runs of days with tickets closing and no gap over {definitions.sprintGapDays} days. They took {days} of the {report.period.days} days.</> : null}
      state={stateOf(report, (data) => data.sprints.length > 0, { title: `No burst of ${definitions?.sprintMinDone ?? 10} or more tickets`, hint: "A burst is a run of days with tickets closing." })}
      minBodyHeight={96}
    >
      <BurstCards bursts={bursts} />
    </Widget>
  );
}

// ---------------------------------------------------------------- speed

export function SpeedWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const speed = report?.speed;
  const cycle = speed?.cycle;
  const points: ColumnPoint[] = (speed?.histogram ?? []).map((bin) => ({ key: bin.label, label: bin.label, tick: bin.label, values: { n: bin.count } }));
  const series: ChartSeries[] = [{ id: "n", label: "Tickets", color: "var(--viz-accent)" }];
  return (
    <Widget
      className={className}
      title="How long a ticket takes"
      sentence={
        cycle && cycle.medianHours !== null ? (
          <>
            Half of finished tickets took under {formatHours(cycle.medianHours)} from claim to done
            {cycle.p25Hours !== null && cycle.p75Hours !== null ? <>; the middle half took {formatHours(cycle.p25Hours)} to {formatHours(cycle.p75Hours)}</> : null}.
          </>
        ) : null
      }
      state={stateOf(report, (data) => data.speed.cycle.n > 0, { title: "No finished tickets with a claim time", hint: NOTHING_HINT })}
      table={speed ? { columns: ["Time from claim to done", "Tickets"], rows: speed.histogram.map((bin) => [bin.label, bin.count]) } : undefined}
      coverage={report && cycle ? { covered: cycle.n, total: report.delivery.done, noun: "finished tickets", have: "have a claim time" } : null}
      footer={<CaveatNotes report={report} codes={["closed_on_import"]} />}
      help="The clock runs from an agent first claiming a ticket to it being marked done, so it includes waiting on review. Tickets finished without a claim have no start and are left out."
      minBodyHeight={200}
    >
      <ColumnChart series={series} points={points} legend={false} height={150} format={(value) => plural(value, "ticket")} ariaLabel="Finished tickets by time from claim to done" />
      {speed && cycle && cycle.n > 0 ? (
        <dl className="mt-3 grid grid-cols-3 gap-3 border-t pt-3">
          <Fact term="Under an hour" figure={formatPercent(cycle.under1h / cycle.n)} detail={`${cycle.under1h} of ${cycle.n}`} />
          <Fact term="Under 4 hours" figure={formatPercent(cycle.under4h / cycle.n)} detail={`${cycle.under4h} of ${cycle.n}`} />
          {speed.lead.n > 0 ? <Fact term="Filed and done in a day" figure={formatPercent(speed.lead.within24h / speed.lead.n)} detail={`${speed.lead.within24h} of ${speed.lead.n}`} /> : null}
        </dl>
      ) : null}
    </Widget>
  );
}

export function SpeedByKindWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const rows = report ? kindSpeedBars(report) : [];
  return (
    <Widget
      className={className}
      title="Typical time by kind"
      sentence={report ? <>The median from claim to done. Epics stay open until their children close, so they run long.</> : null}
      state={stateOf(report, () => rows.length > 0, { title: "No finished tickets with a claim time", hint: NOTHING_HINT })}
      minBodyHeight={120}
    >
      <BarList ariaLabel="Median time from claim to done, by kind" labelWidth="7.5rem" items={rows} />
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

const OUTCOME_TONES: Record<string, string> = { completed: "var(--viz-accent)", yielded: "var(--viz-series-4)", interrupted: "var(--viz-series-2)", failed: "var(--plain-risk-fg)", orphaned: "var(--viz-series-5)", open: "var(--viz-series-other)" };

export function OutcomesWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const reliability = report?.reliability;
  return (
    <Widget
      className={className}
      title="How attempts ended"
      sentence={report && reliability && reliability.successRate !== null ? <>{formatPercent(reliability.successRate)} of {plural(endedAttempts(report), "finished attempt")} did the job.</> : null}
      state={stateOf(report, (data) => data.reliability.started > 0, { title: "No attempts in this period", hint: NOTHING_HINT })}
      footer={<CaveatNotes report={report} codes={["open_attempts"]} />}
      help="An attempt is one agent session on one ticket. Handed back means the agent stopped and released the ticket for someone else; interrupted means the session ended without saying why; session lost means it went away without closing the attempt. Attempts still running are left out of the share that did the job."
      minBodyHeight={80}
    >
      <SegmentedBar ariaLabel="Attempts by how they ended" parts={(report ? outcomeParts(report) : []).map((part) => ({ ...part, color: OUTCOME_TONES[part.id] }))} />
    </Widget>
  );
}

export function ModelsWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const rows = report ? modelBars(report) : [];
  return (
    <Widget
      className={className}
      title="Who did the work"
      sentence={report ? <>Attempts by model family, read from what each agent session reported.</> : null}
      state={stateOf(report, () => rows.length > 0, { title: "No attempts in this period", hint: NOTHING_HINT })}
      coverage={report ? coverageOf(report, "no_model", "attempts", "logged their model") : null}
      help="Staple records the model only when the agent's harness reports it. Where it did not, the harness is named when it is known, and the rest is counted as no model logged."
      minBodyHeight={140}
    >
      <BarList ariaLabel="Attempts by model family" labelWidth="10.5rem" items={rows} />
    </Widget>
  );
}

export function ParallelWidget({ report, className, height = 120 }: { report: AnalyticsReport | undefined; className?: string; height?: number }) {
  const points = report ? parallelPoints(report) : [];
  const peak = report?.capacity.peakConcurrency;
  return (
    <Widget
      className={className}
      title="Agents at once"
      sentence={report && peak && peak.count > 0 ? <>The most agents working at the same moment, each {bucketWord[report.period.bucket]}. The peak was {peak.count}{peak.at ? <> on {formatDay(peak.at.slice(0, 10))}</> : null}.</> : null}
      state={stateOf(report, (data) => data.capacity.peakConcurrency.count > 0, { title: "No agents ran in this period", hint: NOTHING_HINT })}
      table={report ? { columns: [tableFirst(report), "Most agents at once"], rows: points.map((point) => [point.label, point.values.n ?? 0]) } : undefined}
      minBodyHeight={160}
    >
      <ColumnChart series={[{ id: "n", label: "Agents at once", color: "var(--viz-accent)" }]} points={points} legend={false} height={height} format={(value) => plural(value, "agent")} ariaLabel={`Peak concurrent agents per ${report?.period.bucket ?? "day"}; the highest was ${peak?.count ?? 0}.`} />
    </Widget>
  );
}

// ---------------------------------------------------------------- rhythm, mix, estimates, record

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourName = (hour: number) => `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "am" : "pm"}`;
const HOUR_NAMES = Array.from({ length: 24 }, (_, hour) => hourName(hour));
const HOUR_TICKS = Array.from({ length: 24 }, (_, hour) => (hour % 3 === 0 ? `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? "a" : "p"}` : ""));
const zoneName = (tz: string) => tz.replaceAll("_", " ");

export function RhythmWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  const rhythm = report?.rhythm;
  const total = rhythm ? rhythm.heatmap.reduce((sum, row) => sum + row.reduce((inner, value) => inner + value, 0), 0) : 0;
  return (
    <Widget
      className={className}
      title="When the work lands"
      sentence={
        report && rhythm && total > 0 ? (
          <>
            Tickets closed by weekday and hour ({zoneName(report.period.tz)}). {formatPercent(rhythm.night / total)} closed between 10 pm and 6 am, and {rhythm.weekend.toLocaleString("en-US")} on weekends: work that happened while you were away.
          </>
        ) : null
      }
      state={stateOf(report, () => total > 0, { title: "No tickets closed in this period", hint: NOTHING_HINT })}
      table={rhythm ? heatmapTable(rhythm.heatmap, WEEKDAYS, HOUR_NAMES) : undefined}
      minBodyHeight={170}
    >
      <Heatmap cells={rhythm?.heatmap ?? []} rows={WEEKDAYS} columns={HOUR_TICKS} columnNames={HOUR_NAMES} format={(value) => plural(value, "ticket")} ariaLabel="Tickets closed by weekday and hour of day" />
    </Widget>
  );
}

export function MixWidget({ report, className }: { report: AnalyticsReport | undefined; className?: string }) {
  return (
    <Widget className={className} title="What kind of work" sentence={report ? <>Finished tickets by kind and by priority.</> : null} state={stateOf(report, (data) => data.delivery.done > 0, { title: "No tickets closed in this period", hint: NOTHING_HINT })} minBodyHeight={130}>
      <div className="flex flex-col gap-4">
        <SegmentedBar ariaLabel="Finished tickets by kind" parts={report ? kindParts(report) : []} />
        <SegmentedBar ariaLabel="Finished tickets by priority" tone="ordinal" parts={report ? priorityParts(report) : []} />
      </div>
    </Widget>
  );
}

export function EstimatesWidget({ report, className, onOpenEstimates }: { report: AnalyticsReport | undefined; className?: string; onOpenEstimates?: () => void }) {
  const pairs = report?.estimates.pairs;
  return (
    <Widget
      className={className}
      title="Planned effort against agent time"
      sentence={
        pairs && pairs.n > 0 && pairs.medianRatio !== null ? (
          <>
            On {plural(pairs.n, "ticket")} with both an estimate and recorded time, agents used a typical {formatPercent(pairs.medianRatio)} of the estimate. Estimates are planning figures, close to what a person would need.
          </>
        ) : null
      }
      state={stateOf(report, (data) => data.estimates.pairs.n > 0, { title: "No estimated tickets finished in this period", hint: "Estimate tickets when you plan them and this fills in." })}
      coverage={report ? coverageOf(report, "estimates_partial", "finished tickets", "have an estimate") : null}
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
          { id: "estimated", label: "Estimated", value: pairs?.estimateHours ?? 0, text: formatEffortHours(pairs?.estimateHours ?? 0), color: "var(--viz-muted-mark)" },
          { id: "actual", label: "Agent time", value: pairs?.workHours ?? 0, text: formatEffortHours(pairs?.workHours ?? 0) },
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
      <BarList ariaLabel="Ticket documents by type" labelWidth="8.5rem" items={report ? documentBars(report) : []} />
    </Widget>
  );
}

/** What limits the whole page, said above it: a workspace this computer could not open, or a clamped "all time". */
export function PageNotes({ report }: { report: AnalyticsReport | undefined }) {
  if (!report) return null;
  const notes = [
    ...caveatSentences(report, ["workspace_unavailable"]).map((note) => ({ id: note.code as string, sentence: note.sentence })),
    ...(historyGoesFurther(report) ? [{ id: "history", sentence: furtherHistorySentence(report) }] : []),
  ];
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-page-notes>
      {notes.map((note) => (
        <Note key={note.id} id={note.id} attribute="data-page-note">
          {note.sentence}
        </Note>
      ))}
    </div>
  );
}

/** How the page counts, and what limits each count. Closed by default: the caveats that matter sit on their widgets. */
export function MethodNotes({ report }: { report: AnalyticsReport | undefined }) {
  if (!report) return null;
  const { definitions, capacity, period, scope } = report;
  return (
    <ShowDetails dense label="How this is measured">
      <ul className="max-w-3xl list-disc space-y-1.5 pl-5 text-body text-text-secondary" data-method-notes>
        <li>
          Read from {scope.kind === "hub" ? "every workspace on this computer" : `the ${scope.workspaces[0]?.slug ?? "chosen"} workspace`}, {formatDayRange(period.from, period.to)}, in {zoneName(period.tz)} time. Ideas and milestones are not tickets and are left out. A feature is an epic.
        </li>
        {historyGoesFurther(report) ? <li>{furtherHistorySentence(report)}</li> : null}
        <li>
          Agent time adds up recorded attempts with their pauses taken out, each capped at {definitions.attemptCapHours} hours ({formatEffortHours(capacity.agentHoursUncapped)} without the cap). An attempt's hours count on the days it ran.
        </li>
        <li>Full-time equivalent is agent hours ÷ ({definitions.fteHoursPerWeek} hours × the weeks in the period). It describes capacity, not that a person would have needed exactly that long.</li>
        <li>
          A burst is a run of days with tickets closing and no gap over {definitions.sprintGapDays} days, with at least {definitions.sprintMinDone} tickets closed. A ticket closed within {Math.round(definitions.importWindowSeconds / 60)} minutes of being created, with no agent, reads as closed on import.
        </li>
        {caveatSentences(report).map((note) => (
          <li key={note.code} data-method-caveat={note.code}>
            {note.sentence}
          </li>
        ))}
      </ul>
    </ShowDetails>
  );
}
