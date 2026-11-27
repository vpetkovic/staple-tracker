/**
 * The Overview's adapter: `GET /api/analytics` (`AnalyticsReport`) and `GET /api/analytics/roi`
 * as the shapes the widgets draw. Pure functions, no React: the widgets in `overview-parts.tsx`
 * call these and only lay the answers out.
 *
 * Every word the page says about the data lives here too (kinds, priorities, outcomes, model
 * families, document keys, caveats), so a label reads the same on a chart, its table and the
 * method notes.
 */
import { seriesColor, type ChartSeries } from "@/components/analytics/chart-parts";
import type { BarListItem } from "@/components/analytics/BarList";
import type { Burst } from "@/components/analytics/BurstCards";
import type { ColumnPoint } from "@/components/analytics/ColumnChart";
import type { FeatureRow } from "@/components/analytics/FeatureTable";
import { changeRatio, formatDay, formatDayRange, formatEffortHours, formatHours } from "@/components/analytics/format";
import type { SegmentPart } from "@/components/analytics/SegmentedBar";
import type { Coverage } from "@/components/analytics/Widget";
import type { AnalyticsHeadline, AnalyticsQuery, AnalyticsReport, Bucket, Caveat, CaveatCode, RoiResponse } from "@/lib/analytics-api";

// ---------------------------------------------------------------- the read itself

/**
 * Does this answer belong to this query? While a new period or workspace loads, the hook keeps the
 * previous answer; the page shows it dimmed rather than as the new one. Outside hub mode every
 * read is the one workspace, whatever scope was asked.
 */
export function answers(report: Pick<AnalyticsReport, "period" | "scope">, query: AnalyticsQuery, hubMode: boolean): boolean {
  const scope = query.scope ?? "hub";
  const scoped = !hubMode || (scope === "hub" ? report.scope.kind === "hub" : report.scope.kind === "workspace" && report.scope.workspaces[0]?.slug === scope);
  const from = query.from === undefined ? !report.period.explicit : report.period.explicit && report.period.from === query.from;
  return scoped && from && (query.to === undefined || report.period.to === query.to);
}

/** Nothing ever happened in scope: no ticket created, no attempt, nothing done. The page's empty state. */
export const isEmptyScope = (report: AnalyticsReport): boolean => report.period.firstActivity === null;

/** "All time" was clamped to the longest period one read covers, so the history goes further back than the page. */
export const historyGoesFurther = (report: AnalyticsReport): boolean =>
  !report.period.explicit && report.period.firstActivity !== null && report.period.firstActivity < report.period.from;

/** The page's words for a clamped "all time": what it covers, and how far back the history goes. */
export const furtherHistorySentence = (report: AnalyticsReport): string =>
  `All time here is ${formatDayRange(report.period.from, report.period.to)}, the longest period one read covers. The history goes back further, to ${formatDay(report.period.firstActivity ?? report.period.from)}, ${(report.period.firstActivity ?? report.period.from).slice(0, 4)}.`;

/** "vs prior 30 days", or "" when the period has nothing before it (all time). */
export const againstWords = (report: AnalyticsReport): string => (report.previous ? `vs prior ${report.period.days} days` : "");

/** A headline figure's signed change against the period before; null with no period before or no base. */
export function headlineChange(report: AnalyticsReport, key: keyof AnalyticsHeadline): number | null {
  if (!report.previous) return null;
  return changeRatio(report.headline[key], report.previous.headline[key]);
}

/** Attempts that ended (the success rate's base): started, less those still open. */
export const endedAttempts = (report: AnalyticsReport): number => report.reliability.started - report.reliability.outcomes.open;

// ---------------------------------------------------------------- workspaces as series

export const OTHER_LANE = "other";

export interface WorkspaceLanes {
  /** Bottom to top: the busiest workspaces in the session's order, then "Other workspaces". */
  readonly series: ChartSeries[];
  /** The series a workspace's figures are drawn in. */
  laneOf(slug: string): string;
  /** The workspace's own colour, whatever lane it is drawn in. */
  colorOf(slug: string): string;
}

/**
 * The workspaces drawn as their own series. The three busiest (tickets done, then agent time) keep
 * their own series when the scope has more than four, and the rest fold into "Other workspaces";
 * with four or fewer every active one is its own. A workspace's colour slot is its position in
 * `order` (the session's workspace list), never its rank, so filtering or a new period never
 * repaints it.
 */
export function workspaceLanes(report: AnalyticsReport, order: readonly string[] = report.scope.workspaces.map((workspace) => workspace.slug)): WorkspaceLanes {
  const totals = new Map<string, { done: number; hours: number }>();
  for (const point of report.series) {
    for (const [slug, figures] of Object.entries(point.byWorkspace)) {
      const total = totals.get(slug) ?? { done: 0, hours: 0 };
      total.done += figures.done;
      total.hours += figures.agentHours;
      totals.set(slug, total);
    }
  }
  const position = (slug: string) => {
    const index = order.indexOf(slug);
    return index === -1 ? order.length + report.scope.workspaces.findIndex((workspace) => workspace.slug === slug) : index;
  };
  const ranked = [...totals.entries()]
    .filter(([, total]) => total.done > 0 || total.hours > 0)
    .sort(([a, x], [b, y]) => y.done - x.done || y.hours - x.hours || position(a) - position(b))
    .map(([slug]) => slug);
  const own = new Set(report.scope.workspaces.length > 4 ? ranked.slice(0, 3) : ranked);
  const colorOf = (slug: string) => {
    const index = order.indexOf(slug);
    return seriesColor(index === -1 ? 0 : index + 1);
  };
  const series: ChartSeries[] = [...own].sort((a, b) => position(a) - position(b)).map((slug) => ({ id: slug, label: slug, color: colorOf(slug) }));
  if (ranked.length > own.size) series.push({ id: OTHER_LANE, label: "Other workspaces", color: seriesColor(0) });
  return { series, laneOf: (slug) => (own.has(slug) ? slug : OTHER_LANE), colorOf };
}

// ---------------------------------------------------------------- over time

const bucketLabel = (start: string, bucket: Bucket) => (bucket === "day" ? formatDay(start) : bucket === "week" ? `Week of ${formatDay(start)}` : (formatDay(start).split(" ")[0] ?? start));

/** One chart slot per bucket: the tooltip names each one, the axis ticks only a few. */
function slots(report: AnalyticsReport, values: (point: AnalyticsReport["series"][number]) => Record<string, number>): ColumnPoint[] {
  const { bucket } = report.period;
  const count = report.series.length;
  const every = bucket === "day" ? (count > 60 ? 28 : count > 16 ? 7 : count > 8 ? 2 : 1) : bucket === "week" ? (count > 14 ? 4 : 2) : count > 14 ? 3 : 1;
  return report.series.map((point, index) => {
    const label = bucketLabel(point.start, bucket);
    return { key: point.start, label, tick: index % every === 0 ? (bucket === "month" ? label : formatDay(point.start)) : undefined, values: values(point) };
  });
}

/** Tickets done or agent hours per bucket, stacked by workspace lane. */
export function trendPoints(report: AnalyticsReport, metric: "done" | "agentHours", lanes: WorkspaceLanes): ColumnPoint[] {
  return slots(report, (point) => {
    const values: Record<string, number> = Object.fromEntries(lanes.series.map((series) => [series.id, 0]));
    for (const [slug, figures] of Object.entries(point.byWorkspace)) {
      const lane = lanes.laneOf(slug);
      values[lane] = Math.round(((values[lane] ?? 0) + figures[metric]) * 100) / 100;
    }
    return values;
  });
}

/** The most agents at once in each bucket. */
export const parallelPoints = (report: AnalyticsReport): ColumnPoint[] => slots(report, (point) => ({ n: point.peakConcurrency }));

/** A tile's sparkline: the period in at most fourteen columns, so each stays a readable mark. */
export function sparkValues(report: AnalyticsReport, metric: "done" | "agentHours"): number[] {
  const values = report.series.map((point) => point[metric]);
  const size = Math.ceil(values.length / 14);
  if (size <= 1) return values;
  const out: number[] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size).reduce((total, value) => total + value, 0));
  return out;
}

// ---------------------------------------------------------------- what got built

/** An epic's title as a feature's name: without a tracker tag ("[EPIC-49] ", "R4: ") and with a capital. */
export function featureTitle(title: string): string {
  const bare = title.replace(/^\[[^\]]+\]\s*/, "").replace(/^[A-Z]{1,2}\d*:\s*/, "");
  return `${bare.charAt(0).toUpperCase()}${bare.slice(1)}`;
}

const inPeriod = (report: AnalyticsReport, day: string | null) => day !== null && day >= report.period.from && day <= report.period.to;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;

export interface FeatureLine extends FeatureRow {
  /** The workspace slug, for opening the ticket. */
  slug: string;
}

/** Epics that shipped or moved in the period: shipped first, then most closed in the period. */
export function featureRows(report: AnalyticsReport, lanes: WorkspaceLanes): FeatureLine[] {
  const many = report.scope.kind === "hub";
  return report.epics
    .map((epic) => ({ epic, shipped: epic.category === "done" && inPeriod(report, epic.completedOn) }))
    .filter(({ epic, shipped }) => shipped || epic.doneInPeriod > 0)
    .sort((a, b) => Number(b.shipped) - Number(a.shipped) || b.epic.doneInPeriod - a.epic.doneInPeriod || a.epic.identifier.localeCompare(b.epic.identifier))
    .map(({ epic, shipped }) => ({
      ref: epic.identifier,
      slug: epic.workspace,
      title: featureTitle(epic.title),
      workspace: many ? { label: epic.workspace, color: lanes.colorOf(epic.workspace) } : undefined,
      closed: epic.descendantsDone,
      children: epic.descendants,
      shipped,
      agentHours: epic.agentHours,
      spanDays: epic.startedOn && epic.lastDoneOn ? daysBetween(epic.startedOn, epic.lastDoneOn) : null,
    }));
}

/** Agent time by workspace, most first, each in its own colour. */
export function workspaceBars(report: AnalyticsReport, lanes: WorkspaceLanes): BarListItem[] {
  return report.workspaces
    .filter((row) => row.agentHours > 0 || row.done > 0)
    .sort((a, b) => b.agentHours - a.agentHours || b.done - a.done)
    .map((row) => ({ id: row.slug, label: row.slug, value: row.agentHours, text: formatEffortHours(row.agentHours), detail: `${row.done.toLocaleString("en-US")} closed`, color: lanes.colorOf(row.slug) }));
}

/** The bursts work arrived in, oldest first, each feature with its size from the epic list. */
export function burstsOf(report: AnalyticsReport): Burst[] {
  const size = new Map(report.epics.map((epic) => [`${epic.workspace}/${epic.identifier}`, epic.descendants]));
  return [...report.sprints]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((sprint) => ({
      from: sprint.start,
      to: sprint.end,
      days: sprint.days,
      ticketsDone: sprint.done,
      agentHours: sprint.agentHours,
      bestDay: { day: sprint.bestDay.date, count: sprint.bestDay.done },
      features: sprint.features.map((feature) => ({ title: featureTitle(feature.title), closed: feature.descendantsDone, children: size.get(`${feature.workspace}/${feature.identifier}`) ?? feature.descendantsDone })),
    }));
}

// ---------------------------------------------------------------- mix

export const KIND_WORDS: Record<string, string> = { task: "Tasks", bug: "Bug fixes", chore: "Chores", spike: "Spikes", epic: "Features (epics)" };
const KIND_ORDER = ["task", "bug", "chore", "spike", "epic"];
const PRIORITY_ORDER = ["critical", "high", "medium", "low"];
const capital = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1).replace(/[-_]/g, " ")}`;
const rank = (order: readonly string[]) => (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);

function partsOf(counts: Readonly<Record<string, number>>, order: readonly string[], words: Record<string, string>): SegmentPart[] {
  const at = rank(order);
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([a, x], [b, y]) => at(a) - at(b) || y - x || a.localeCompare(b))
    .map(([id, value]) => ({ id, label: words[id] ?? capital(id), value }));
}

export const kindParts = (report: AnalyticsReport): SegmentPart[] => partsOf(report.delivery.byKind, KIND_ORDER, KIND_WORDS);
export const priorityParts = (report: AnalyticsReport): SegmentPart[] => partsOf(report.delivery.byPriority, PRIORITY_ORDER, {});

// ---------------------------------------------------------------- speed

/** The median time from claim to done by kind, the kinds with most tickets first. */
export function kindSpeedBars(report: AnalyticsReport): BarListItem[] {
  return Object.entries(report.speed.cycleByKind)
    .flatMap(([kind, row]) => (row.medianHours === null || row.n === 0 ? [] : [{ kind, n: row.n, medianHours: row.medianHours }]))
    .sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind))
    .map((row) => ({ id: row.kind, label: KIND_WORDS[row.kind] ?? capital(row.kind), value: row.medianHours, text: formatHours(row.medianHours), detail: `${row.n.toLocaleString("en-US")} tickets` }));
}

// ---------------------------------------------------------------- reliability

const OUTCOME_ORDER = ["completed", "yielded", "interrupted", "failed", "orphaned", "open"] as const;
export const OUTCOME_WORDS: Record<(typeof OUTCOME_ORDER)[number], string> = {
  completed: "Finished the job",
  yielded: "Handed back",
  interrupted: "Interrupted",
  failed: "Failed",
  orphaned: "Session lost",
  open: "Still running",
};

export const outcomeParts = (report: AnalyticsReport): SegmentPart[] =>
  OUTCOME_ORDER.filter((id) => report.reliability.outcomes[id] > 0).map((id) => ({ id, label: OUTCOME_WORDS[id], value: report.reliability.outcomes[id] }));

/**
 * The model family an attempt reported. The model string is the harness's own (`claude-opus-5-5`,
 * `opus-5.5`, `gpt-6.1-sol`), so families are read from the words in it; a harness that reported no
 * model is named, and an attempt with neither is "No model logged".
 */
export function modelFamily(model: string | null, harness: string | null): string {
  const word = (model ?? "").toLowerCase();
  if (word !== "") {
    if (word.includes("fable")) return "Claude Fable";
    if (word.includes("opus")) return "Claude Opus";
    if (word.includes("sonnet")) return "Claude Sonnet";
    if (word.includes("haiku")) return "Claude Haiku";
    if (word.includes("gpt") || word.includes("codex")) return "Codex (GPT)";
    if (word.includes("gemini")) return "Gemini";
    return model!;
  }
  if (harness === "claude_code") return "Claude, model not logged";
  if (harness === "codex") return "Codex, model not logged";
  if (harness) return `${capital(harness)}, model not logged`;
  return "No model logged";
}

/** Attempts by model family, most first; the families without a logged model are quiet rows. */
export function modelBars(report: AnalyticsReport): BarListItem[] {
  const families = new Map<string, number>();
  for (const row of report.capacity.byModel) {
    const family = modelFamily(row.model, row.harness);
    families.set(family, (families.get(family) ?? 0) + row.attempts);
  }
  return [...families.entries()]
    .filter(([, attempts]) => attempts > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([label, attempts]) => ({ id: label, label, value: attempts, text: attempts.toLocaleString("en-US"), muted: /not logged|No model/.test(label) }));
}

// ---------------------------------------------------------------- the paper trail

const DOCUMENT_WORDS: Record<string, string> = { plan: "Plans", worklog: "Worklogs", context: "Context", "decision-log": "Decision logs", decisions: "Decisions", brief: "Briefs", spec: "Specs", rules: "Rules" };

/** Documents by key: the six most written, and the rest as one quiet row. */
export function documentBars(report: AnalyticsReport): BarListItem[] {
  const ranked = [...report.record.byDocumentKey].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const head: BarListItem[] = ranked.slice(0, 6).map((row) => ({ id: row.key, label: DOCUMENT_WORDS[row.key] ?? capital(row.key), value: row.count, text: row.count.toLocaleString("en-US") }));
  const rest = ranked.slice(6);
  if (rest.length === 0) return head;
  const count = rest.reduce((total, row) => total + row.count, 0);
  return [...head, { id: "other", label: `Other (${rest.length} ${rest.length === 1 ? "type" : "types"})`, value: count, text: count.toLocaleString("en-US"), muted: true }];
}

// ---------------------------------------------------------------- caveats

export const caveatOf = (report: AnalyticsReport, code: CaveatCode): Caveat | null => report.caveats.find((caveat) => caveat.code === code && caveat.count > 0) ?? null;

/** A caveat whose count is the records WITHOUT something, as the widget's partial-data note. */
export function coverageOf(report: AnalyticsReport, code: CaveatCode, noun: string, have: string): Coverage | null {
  const caveat = caveatOf(report, code);
  if (!caveat || caveat.of === null || caveat.of <= 0) return null;
  return { covered: Math.max(0, caveat.of - caveat.count), total: caveat.of, noun, have };
}

const count = (value: number, one: string, many = `${one}s`) => `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
const of = (caveat: Caveat) => (caveat.of !== null && caveat.of > 0 ? ` of ${caveat.of.toLocaleString("en-US")}` : "");

/** The caveat as one plain sentence, for the widget it limits and for the method notes. */
export function caveatSentence(caveat: Caveat, report: AnalyticsReport): string {
  const cap = report.definitions.attemptCapHours;
  switch (caveat.code) {
    case "no_model":
      return `${caveat.count.toLocaleString("en-US")}${of(caveat)} attempts did not log their model, so the model split covers only the rest.`;
    case "reconstructed":
      return `${caveat.count.toLocaleString("en-US")}${of(caveat)} attempts have times rebuilt from older logs, which are less precise than times recorded as the work happened.`;
    case "open_attempts":
      return `${count(caveat.count, "attempt")} had not ended when this was read, or lost their session. Their time counts up to their last activity.`;
    case "capped_attempts":
      return `${count(caveat.count, "attempt")} ran longer than ${cap} hours and ${caveat.count === 1 ? "counts" : "count"} as ${cap}.`;
    case "done_without_agent_time":
      return `${caveat.count.toLocaleString("en-US")}${of(caveat)} finished tickets have no agent time recorded, so the agent time here leaves their work out.`;
    case "closed_on_import":
      return `${count(caveat.count, "ticket")} closed on import (finished within minutes of being created, with no agent) ${caveat.count === 1 ? "is" : "are"} counted as delivered and left out of speed.`;
    case "estimates_partial":
      return `${caveat.count.toLocaleString("en-US")}${of(caveat)} finished tickets have no estimate, so planned effort covers only the rest.`;
    case "workspace_unavailable": {
      const missing = report.scope.workspaces.filter((workspace) => !workspace.available).map((workspace) => workspace.slug);
      return `${count(caveat.count, "workspace")} could not be opened on this computer${missing.length > 0 ? ` (${missing.join(", ")})` : ""}, so ${caveat.count === 1 ? "its" : "their"} work is missing from every figure.`;
    }
    default:
      // The Return lens's own codes (`mapping_fallback`, `default_cost_model`, …) are said there.
      return "";
  }
}

/** The codes the Overview speaks to, in the order the method notes list them. */
export const OVERVIEW_CAVEATS: readonly CaveatCode[] = [
  "workspace_unavailable",
  "capped_attempts",
  "open_attempts",
  "reconstructed",
  "done_without_agent_time",
  "closed_on_import",
  "estimates_partial",
  "no_model",
];

/** Every Overview caveat in the report, as sentences. */
export function caveatSentences(report: AnalyticsReport): { code: CaveatCode; sentence: string }[] {
  return OVERVIEW_CAVEATS.flatMap((code) => {
    const caveat = caveatOf(report, code);
    return caveat ? [{ code, sentence: caveatSentence(caveat, report) }] : [];
  });
}

// ---------------------------------------------------------------- the return tile

export interface ReturnTile {
  /** Return on total cost counted from measured agent time (the low end), and from planned effort (the high end). */
  measured: number | null;
  planned: number | null;
  /** The profile in use still holds a shipped default figure. */
  assumed: boolean;
}

export function returnTile(roi: RoiResponse): ReturnTile {
  const model = roi.model.model;
  const profile = model[model.scenario.mode];
  return {
    measured: roi.measured.returnOnTotalCost,
    planned: roi.planned.returnOnTotalCost,
    assumed: profile.assumed.length > 0,
  };
}
