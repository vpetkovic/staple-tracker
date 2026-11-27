/**
 * PROTOTYPE DATA LAYER for the Analytics direction preview. It talks to a preview-only stand-in
 * for the analytics routes; the types here are the design lead's PROPOSED payload, posted to the
 * engineering track as the starting point for the `api-contract`. The real API client and hooks
 * (owned by engineering) replace this file; the views read nothing else from it.
 */
export type PeriodPreset = "7d" | "30d" | "90d" | "ytd" | "all" | "custom";
/** What the page asks for: a preset, or `custom` with both days. */
export interface PeriodAsk {
  preset: PeriodPreset;
  from?: string;
  to?: string;
}

/** A figure and the same figure for the period before (null when there is no period before). */
export interface Measure {
  value: number | null;
  previous: number | null;
}
export interface Part {
  id: string;
  label: string;
  value: number;
}
export interface TrendBucket {
  /** The bucket's first day. */
  t: string;
  values: Record<string, number>;
}
export interface FeaturePayload {
  ref: string;
  title: string;
  workspace: string;
  status: string;
  shipped: boolean;
  children: number;
  closed: number;
  closedInPeriod: number;
  agentHours: number;
  spanDays: number | null;
  completedOn: string | null;
}
export interface BurstPayload {
  from: string;
  to: string;
  days: number;
  ticketsDone: number;
  agentHours: number;
  bestDay: { day: string; count: number };
  features: { title: string; workspace: string; closed: number; children: number }[];
}
export interface Covered {
  covered: number;
  total: number;
}

export interface AnalyticsReport {
  generatedAt: string;
  tz: string;
  scope: { kind: "all" | "workspace"; workspaces: { slug: string; prefix: string; name: string }[] };
  period: { preset: PeriodPreset; from: string; to: string; days: number; bucket: "day" | "week" | "month"; previous: { from: string; to: string } | null; firstActivity: string };
  /** The workspaces drawn as their own series (`slot` is the workspace's stable colour slot; 0 = Other). */
  series: { id: string; label: string; slot: number }[];
  empty: boolean;
  capacity: {
    agentHours: Measure;
    agentHoursUncapped: number;
    capHours: number;
    workWeeks: number;
    calendarWeeks: number;
    fte: number;
    activeDays: Measure;
    fteOnActiveDays: number | null;
    attempts: Measure;
    agentNames: number;
    peakParallel: { count: number; at: string | null };
    trend: TrendBucket[];
    parallelByDay: { t: string; value: number }[];
  };
  delivery: {
    ticketsDone: Measure;
    featuresDone: Measure;
    bugsFixed: Measure;
    ticketsTotal: number;
    open: number;
    daysWithDone: number;
    bestDay: { day: string; count: number } | null;
    trend: TrendBucket[];
    features: FeaturePayload[];
    byWorkspace: { id: string; slug: string; label: string; agentHours: number; ticketsDone: number; featuresDone: number; bugsFixed: number; open: number }[];
    bursts: BurstPayload[];
    mix: { byKind: Part[]; byPriority: Part[] };
  };
  speed: {
    cycleMedianHours: Measure;
    cycleP25Hours: number | null;
    cycleP75Hours: number | null;
    measured: number;
    leadMedianHours: number | null;
    under1h: number;
    under4h: number;
    sameDay: number;
    ticketsDone: number;
    histogram: { label: string; count: number }[];
    byKind: { id: string; label: string; medianHours: number; count: number }[];
  };
  reliability: {
    success: Measure;
    attempts: number;
    ended: number;
    medianAttemptMinutes: number | null;
    outcomes: Part[];
    byModel: (Part & { completed: number })[];
  };
  rhythm: { heat: number[][]; night: number; weekend: number; ticketsDone: number };
  estimates: { plannedHours: number; estimatedTickets: number; doneTickets: number; pairs: { count: number; estimatedHours: number; actualHours: number; medianRatio: number | null; beat: number } };
  record: { comments: number; documents: number; files: number; fileBytes: number; docTypes: Part[] };
  coverage: { estimates: Covered; model: Covered; timing: { recorded: number; rebuilt: number }; openAttempts: number; cappedAttempts: number };
}

export interface RoleMatch {
  labels: string[];
  kinds: string[];
  title: string[];
  agent: string[];
  workspaces: string[];
}
export type Billing = "subscription" | "api";
export type Scenario = "solo" | "company";
/** A role: who would have done the work, and the rule that sends tickets to it. Shared by both profiles. */
export interface CostRole {
  id: string;
  title: string;
  match: RoleMatch;
}
/** One thing paid for AI, assigned to the role whose agents use it. */
export interface SpendLine {
  id: string;
  label: string;
  /** A flat monthly plan, or the monthly API invoice. */
  kind: Billing;
  /** The price of ONE subscription a month, or the API bill a month. */
  perMonth: number;
  /** How many subscriptions are paid for (seats). An API bill has none. */
  quantity: number;
  /** The role this is for; null is shared by the whole team. */
  roleId: string | null;
}
/**
 * One payer's figures. "Just me" and "A company" each keep their own, so setting up the company
 * never disturbs your own numbers: the directing person's rate and hours, what each role costs to
 * hire, and the AI subscriptions and API bills assigned to each role.
 */
export interface CostProfile {
  person: { rate: number; hoursPerActiveDay: number };
  /** Hourly rate per role id. */
  rates: Record<string, number>;
  /** What is paid for AI, each line assigned to a role or shared by the whole team. */
  spend: SpendLine[];
  /** Figures still holding a shipped default, shown as assumptions until the person changes them. */
  assumed: string[];
}
export interface CostModel {
  /** The profile in use: who pays. */
  scenario: Scenario;
  currency: string;
  /** In match order; the last role takes everything no other role matched. */
  roles: CostRole[];
  profiles: Record<Scenario, CostProfile>;
  updatedAt: string | null;
}
export interface RoleHours {
  roleId: string;
  measuredHours: number;
  plannedHours: number;
  tickets: number;
  estimatedTickets: number;
  attempts: number;
  by: Record<"label" | "title" | "agent" | "kind" | "workspace" | "rest", number>;
  examples: { ref: string; title: string; by: string; plannedHours: number | null }[];
}
export interface ReturnReport {
  scope: AnalyticsReport["scope"];
  period: { preset: PeriodPreset; from: string; to: string; days: number; months: number };
  model: CostModel;
  roles: RoleHours[];
  /** Days on which agents ran anywhere on this computer. */
  directing: { activeDays: number };
  /** The share of this computer's agent time that the scope holds (1 for all workspaces). */
  share: number;
  capacity: { agentHours: number; hubAgentHours: number; calendarWeeks: number };
  coverage: { estimates: Covered; capHours: number };
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(body.error?.message ?? `The analytics preview data is not available (${response.status}).`);
  return body;
}
const query = (ws: string, period: PeriodAsk) =>
  `?ws=${encodeURIComponent(ws)}&period=${period.preset}${period.preset === "custom" && period.from && period.to ? `&from=${period.from}&to=${period.to}` : ""}`;

export const getAnalytics = (ws: string, period: PeriodAsk) => json<AnalyticsReport>(`/api/analytics${query(ws, period)}`);
export const getReturn = (ws: string, period: PeriodAsk) => json<ReturnReport>(`/api/analytics/return${query(ws, period)}`);
export const saveCostModel = (model: CostModel) => json<CostModel>("/api/analytics/cost-model", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(model) });
export const resetCostModel = () => json<CostModel>("/api/analytics/cost-model", { method: "DELETE" });
