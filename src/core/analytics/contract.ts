/**
 * THE ANALYTICS WIRE CONTRACT: what `/api/analytics*` answers, field by field.
 *
 * This module has no imports on purpose. The web app imports it type-only
 * (`src/ui/app/src/lib/analytics-api.ts`), so the server and the widgets read one definition
 * and cannot drift; anything imported here would be dragged into the app's type check.
 *
 * The agreed text of this contract is the `api-contract` document on the Analytics epic in the
 * tracker. A change here is a change to that document, agreed by both of its owners.
 *
 * ## Conventions
 *
 *  - Hours are decimal hours, rounded to 0.01. Rates and money are in `currency`, unrounded.
 *  - Days are calendar days `YYYY-MM-DD` in the read's `tz`. Instants are ISO-8601 UTC.
 *  - `null` is "not known" or "not applicable", never zero. A zero is a measured zero.
 *  - Percentiles are the LOWER quantile, `sorted[floor(p × (n − 1))]`, as everywhere else in
 *    staple (`design/timing-semantics.md`, "Quantile method").
 *  - Every list is complete for the period; nothing is paged. A caveat says when a figure
 *    rests on partial data.
 */

export type DateKey = string;
export type Bucket = "day" | "week" | "month";
export type AgentTypeId = "engineering" | "design" | "documentation" | "research" | "orchestration";
export type AttemptStandingId = "completed" | "yielded" | "failed" | "interrupted" | "orphaned" | "open";

/** A workspace the read covers. `available: false` is a registered workspace this machine could not open. */
export interface AnalyticsWorkspaceRef {
  readonly slug: string;
  readonly prefix: string;
  readonly available: boolean;
}

export interface AnalyticsPeriod {
  readonly from: DateKey;
  readonly to: DateKey;
  readonly tz: string;
  /** Calendar days from `from` to `to`, both included. */
  readonly days: number;
  readonly bucket: Bucket;
  /** False when the caller named no period and the read chose all time. */
  readonly explicit: boolean;
  /** The first and last day the scope shows any activity (a ticket created, an attempt, a ticket done), all time. */
  readonly firstActivity: DateKey | null;
  readonly lastActivity: DateKey | null;
}

/** The constants every figure below is computed with. Echoed so a surface can print its method. */
export interface AnalyticsDefinitions {
  /** One attempt contributes at most this many agent-hours (a session left open overnight is not a day of work). */
  readonly attemptCapHours: number;
  /** The working week an FTE-equivalent is measured against. */
  readonly fteHoursPerWeek: number;
  /** The working day an active-day FTE is measured against. */
  readonly fteHoursPerDay: number;
  /** A sprint ends after more than this many days with nothing done. */
  readonly sprintGapDays: number;
  /** A run of completion days needs at least this many tickets done to count as a sprint. */
  readonly sprintMinDone: number;
  /** A done ticket with no attempt, closed within this many seconds of its creation, reads as closed on import. */
  readonly importWindowSeconds: number;
}

/** The handful of figures a header or a "since last time" strip shows. */
export interface AnalyticsHeadline {
  readonly done: number;
  readonly epicsDone: number;
  readonly bugsFixed: number;
  readonly agentHours: number;
  readonly ftePeriod: number | null;
  readonly peakConcurrency: number;
  readonly medianCycleHours: number | null;
  readonly attemptSuccessRate: number | null;
  readonly plannedHours: number;
}

/** One bucket of the time series. */
export interface SeriesPoint {
  /** First and last day of the bucket, clipped to the period. */
  readonly start: DateKey;
  readonly end: DateKey;
  readonly done: number;
  readonly created: number;
  readonly agentHours: number;
  /** Most attempts running at one instant inside the bucket. */
  readonly peakConcurrency: number;
  /** Per workspace slug; a workspace with nothing in the bucket is absent. */
  readonly byWorkspace: Readonly<Record<string, { readonly done: number; readonly agentHours: number }>>;
}

export interface DeliverySection {
  /** Tickets whose status reached the `done` category inside the period (milestones excluded). */
  readonly done: number;
  readonly created: number;
  readonly cancelled: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly byPriority: Readonly<Record<string, number>>;
  readonly epicsDone: number;
  readonly bugsFixed: number;
  readonly daysWithDone: number;
  readonly bestDay: { readonly date: DateKey; readonly done: number } | null;
  /** Open tickets NOW (not in the period), by status category. */
  readonly openNow: Readonly<Record<string, number>>;
}

export interface ModelRow {
  /** The model the harness reported, verbatim, or null when none was recorded. */
  readonly model: string | null;
  /** The harness name (`claude_code`, `codex`, …), or null when none was recorded. */
  readonly harness: string | null;
  readonly attempts: number;
  readonly completed: number;
  readonly agentHours: number;
}

export interface CapacitySection {
  /** Agent work inside the period, each attempt capped at `attemptCapHours` and clipped to the period. */
  readonly agentHours: number;
  /** The same without the cap. */
  readonly agentHoursUncapped: number;
  /** Of `agentHours`, the orchestrator lane's. */
  readonly orchestrationHours: number;
  /** Attempts that ran at any point in the period. */
  readonly attempts: number;
  /** Of those, how many the cap shortened. */
  readonly attemptsCapped: number;
  /** Distinct agent names. */
  readonly agents: number;
  /** Days on which any attempt ran. */
  readonly activeDays: number;
  /** agentHours ÷ (days ÷ 7 × fteHoursPerWeek); null for an empty period. */
  readonly ftePeriod: number | null;
  /** agentHours ÷ (activeDays × fteHoursPerDay); null with no active day. */
  readonly fteActiveDays: number | null;
  /** agentHours ÷ fteHoursPerWeek. */
  readonly workWeeks: number;
  readonly peakConcurrency: { readonly count: number; readonly at: string | null };
  readonly byModel: readonly ModelRow[];
}

export interface HistogramBin {
  readonly label: string;
  readonly minHours: number;
  /** Exclusive; null for the open last bin. */
  readonly maxHours: number | null;
  readonly count: number;
}

export interface SpeedSection {
  /** First start (`startedAt`) to done, for tickets done in the period that were started and not closed on import. */
  readonly cycle: {
    readonly n: number;
    readonly medianHours: number | null;
    readonly p25Hours: number | null;
    readonly p75Hours: number | null;
    readonly under1h: number;
    readonly under4h: number;
  };
  /** Created to done, same population without the started requirement. */
  readonly lead: { readonly n: number; readonly medianHours: number | null; readonly within24h: number };
  readonly histogram: readonly HistogramBin[];
  readonly cycleByKind: Readonly<Record<string, { readonly n: number; readonly medianHours: number | null }>>;
  /** Agent work per done ticket (all its attempts, all time, capped), for done tickets that have any. */
  readonly effortPerTicket: { readonly n: number; readonly medianHours: number | null };
}

export interface ReliabilitySection {
  /** Attempts started in the period. */
  readonly started: number;
  readonly outcomes: Readonly<Record<AttemptStandingId, number>>;
  /** completed ÷ (started − open); null when none has ended. */
  readonly successRate: number | null;
}

export interface EstimatesSection {
  /**
   * Planned effort of the tickets done in the period: each one's own estimate, except that a
   * ticket with an estimated descendant contributes nothing (its descendants carry the plan;
   * counting both would count it twice).
   */
  readonly planned: { readonly hours: number; readonly tickets: number; readonly ofDone: number };
  /** Done tickets with both an own estimate and measured agent work. */
  readonly pairs: {
    readonly n: number;
    readonly estimateHours: number;
    readonly workHours: number;
    /** Median of work ÷ estimate. */
    readonly medianRatio: number | null;
    /** How many took less agent work than their estimate. */
    readonly underEstimate: number;
  };
}

export interface RhythmSection {
  /** Tickets done, `[weekday][hour]`, weekday 0 = Monday, in `tz`. */
  readonly heatmap: readonly (readonly number[])[];
  /** Done between 22:00 and 06:00. */
  readonly night: number;
  readonly weekend: number;
}

export interface EpicRow {
  readonly workspace: string;
  readonly identifier: string;
  readonly title: string;
  readonly status: string;
  readonly category: string | null;
  /** Non-milestone descendants, all time. */
  readonly descendants: number;
  readonly descendantsDone: number;
  /** Of those, done inside the period. */
  readonly doneInPeriod: number;
  /** Earliest descendant created, latest descendant done. */
  readonly startedOn: DateKey | null;
  readonly lastDoneOn: DateKey | null;
  /** The epic's own completion day, when it is done. */
  readonly completedOn: DateKey | null;
  /** Agent-hours over the epic and its descendants, all time, capped. */
  readonly agentHours: number;
}

export interface WorkspaceRow {
  readonly slug: string;
  readonly prefix: string;
  readonly done: number;
  readonly created: number;
  readonly bugsFixed: number;
  readonly epicsDone: number;
  readonly agentHours: number;
  readonly activeDays: number;
  readonly firstActivity: DateKey | null;
  readonly lastActivity: DateKey | null;
  /** Up to five epics done in the period, most descendants done first. */
  readonly features: readonly { readonly identifier: string; readonly title: string; readonly descendantsDone: number }[];
}

export interface SprintRow {
  readonly start: DateKey;
  readonly end: DateKey;
  readonly days: number;
  readonly done: number;
  readonly agentHours: number;
  readonly bestDay: { readonly date: DateKey; readonly done: number };
  /** Up to three epics completed inside the sprint with at least three descendants done. */
  readonly features: readonly { readonly workspace: string; readonly identifier: string; readonly title: string; readonly descendantsDone: number }[];
  /** Workspace slugs, most done first. */
  readonly workspaces: readonly string[];
}

export type AgentTypeReasonId = "orchestrator_lane" | "rule" | "label" | "agent_name" | "title" | "kind" | "default";

export interface AgentTypeRow {
  readonly type: AgentTypeId;
  readonly attempts: number;
  /** Measured lens: agent-hours of attempts of this type in the period. */
  readonly agentHours: number;
  /** Planned lens: planned hours of done tickets of this type in the period. */
  readonly plannedHours: number;
  readonly plannedTickets: number;
  /** How many attempts each rule typed. */
  readonly reasons: Readonly<Partial<Record<AgentTypeReasonId, number>>>;
  /** The agent names with the most attempts of this type, at most five. */
  readonly topAgents: readonly { readonly name: string; readonly attempts: number }[];
}

export interface AgentRow {
  readonly name: string;
  readonly attempts: number;
  readonly agentHours: number;
  /** The type most of this agent's attempts derived to, and the rule that typed them. */
  readonly type: AgentTypeId;
  readonly reason: { readonly code: AgentTypeReasonId; readonly detail: string | null };
  /** True when its attempts derived to more than one type (by ticket). */
  readonly mixed: boolean;
}

/** The paper trail beside the work, counted in the period by each row's own timestamp. */
export interface RecordSection {
  readonly comments: number;
  /** Documents whose first revision was written in the period. */
  readonly documents: number;
  readonly files: number;
  readonly fileBytes: number;
  /** Documents by key (`plan`, `worklog`, `context`, …), most first. */
  readonly byDocumentKey: readonly { readonly key: string; readonly count: number }[];
}

export type CaveatCode =
  | "no_model"
  | "reconstructed"
  | "open_attempts"
  | "capped_attempts"
  | "done_without_agent_time"
  | "closed_on_import"
  | "estimates_partial"
  | "workspace_unavailable"
  | "mapping_fallback"
  | "default_cost_model"
  | "home_not_synced"
  | "several_homes"
  /** The profile in use has no spend entry that costs anything in force in the period (a fresh company profile): the AI cost reads 0. */
  | "no_ai_spend";

/** One limit on what the figures can claim: `count` of `of` records are affected. */
export interface Caveat {
  readonly code: CaveatCode;
  readonly count: number;
  readonly of: number | null;
}

/** `GET /api/analytics`. */
export interface AnalyticsReport {
  readonly asOf: string;
  readonly scope: { readonly kind: "hub" | "workspace"; readonly workspaces: readonly AnalyticsWorkspaceRef[] };
  readonly period: AnalyticsPeriod;
  readonly definitions: AnalyticsDefinitions;
  readonly headline: AnalyticsHeadline;
  /** The same headline over the equally long window just before `from`; null when the period is all time. */
  readonly previous: { readonly from: DateKey; readonly to: DateKey; readonly headline: AnalyticsHeadline } | null;
  readonly series: readonly SeriesPoint[];
  readonly delivery: DeliverySection;
  readonly capacity: CapacitySection;
  readonly speed: SpeedSection;
  readonly reliability: ReliabilitySection;
  readonly estimates: EstimatesSection;
  readonly rhythm: RhythmSection;
  readonly epics: readonly EpicRow[];
  readonly workspaces: readonly WorkspaceRow[];
  readonly sprints: readonly SprintRow[];
  readonly agentTypes: readonly AgentTypeRow[];
  readonly agents: readonly AgentRow[];
  readonly record: RecordSection;
  readonly caveats: readonly Caveat[];
}

// ------------------------------------------------------------------ the cost model

/** What a spend entry is: a flat plan bought in some quantity, or a metered API bill. */
export type SpendKind = "subscription" | "api";
export type ProfileId = "solo" | "company";

/** A role, shared by both profiles. Its rate is each profile's. */
export interface CostRole {
  readonly id: string;
  readonly title: string;
}

/** A person's rule: every matcher given must match (at least one); exactly one of `type` and `roleId`. */
export interface CostTypeRule {
  /** Agent name glob, `*` wildcards, case-insensitive. */
  readonly agent?: string;
  /** Workspace prefix. */
  readonly workspace?: string;
  readonly kind?: string;
  readonly label?: string;
  /** A whole word (or words, in order) of the ticket title, case-insensitive. */
  readonly title?: string;
  readonly type?: AgentTypeId;
  readonly roleId?: string;
}

/**
 * One AI spend line. On a read every field is present: `kind` is `subscription` when stored
 * without one, `quantity` is 1 for a subscription stored without one and null for an API bill,
 * and `roleId` is null for spend the whole team shares. On a write `kind`, `quantity` and
 * `roleId` are optional, and an API bill carries no quantity.
 */
export interface AiSpendEntryValue {
  readonly id: string;
  readonly label: string;
  readonly kind: SpendKind;
  /** The price of one, per month. */
  readonly monthlyAmount: number;
  /** Subscriptions: how many are bought; the month costs `monthlyAmount × quantity`. API bills: null. */
  readonly quantity: number | null;
  /** The role this spend is for, or null when the team shares it. A role no longer in the list counts as shared. */
  readonly roleId: string | null;
  readonly from: string;
  readonly to: string | null;
}

/** An entry as a write may send it. */
export interface AiSpendEntryWrite {
  readonly id: string;
  readonly label: string;
  readonly kind?: SpendKind;
  readonly monthlyAmount: number;
  readonly quantity?: number;
  readonly roleId?: string | null;
  readonly from: string;
  readonly to: string | null;
}

/** One payer's figures (VP's ruling, 2026-11-26: "a company's setup can differ from mine"). */
export interface CostProfileValue {
  readonly director: { readonly title: string; readonly hourlyRate: number; readonly hoursPerActiveDay: number };
  /** Every role's hourly rate, by role id. On a read every role in the list is present; one the profile did not set reads at 100 and is listed in `assumed`. */
  readonly rates: Readonly<Record<string, number>>;
  readonly entries: readonly AiSpendEntryValue[];
  readonly assumed: readonly string[];
  readonly savedAt: string | null;
}

/**
 * Every part carries `assumed`: the ids of the figures still at their shipped default
 * (`roles.<id>.hourlyRate`, `director.hourlyRate`, `director.hoursPerActiveDay`,
 * `entries.<id>.monthlyAmount`). The server fills it for an unsaved part; the page drops an id
 * when the person changes that figure, and sends the rest back on save.
 */
export interface CostModelValue {
  /** Shared by both profiles. */
  readonly roles: { readonly roles: readonly CostRole[]; readonly assumed: readonly string[]; readonly savedAt: string | null };
  /** Shared by both profiles. */
  readonly roleMapping: {
    readonly types: Readonly<Record<AgentTypeId, string>>;
    readonly rules: readonly CostTypeRule[];
    readonly assumed: readonly string[];
    readonly savedAt: string | null;
  };
  /** The profile in use, and the currency of every amount. Switching `mode` copies nothing. */
  readonly scenario: { readonly mode: ProfileId; readonly currency: string; readonly assumed: readonly string[]; readonly savedAt: string | null };
  /** Each its own setting, so editing one profile on one device can never change the other, a sync merge included. */
  readonly solo: CostProfileValue;
  readonly company: CostProfileValue;
}

export type CostModelPartId = "roles" | "roleMapping" | "scenario" | "solo" | "company";

/** Where the model is saved, as this machine sees it. */
export interface CostModelHome {
  /** The workspace holding the model, or null when none does yet (every part is a default). */
  readonly slug: string | null;
  readonly prefix: string | null;
  /** True when that workspace is connected to cloud sync, so the model reaches other devices. */
  readonly synced: boolean;
  /** Other registered workspaces that also hold a saved model (an older one), newest first. */
  readonly others: readonly { readonly slug: string; readonly prefix: string; readonly savedAt: string }[];
  /** Where a first save goes when there is no home: the scope's workspace, or the hub's first connected one. */
  readonly suggested: string | null;
}

/** `GET /api/analytics/cost-model`. */
export interface CostModelResponse {
  readonly model: CostModelValue;
  /** Per part: `saved` in the home, or `default` (an assumption). */
  readonly source: Readonly<Record<CostModelPartId, "saved" | "default">>;
  readonly home: CostModelHome;
  readonly agentTypes: readonly AgentTypeId[];
}

/** A profile as a write sends it. Rates may name a subset of the roles. */
export interface CostProfileWrite {
  readonly director: { readonly title: string; readonly hourlyRate: number; readonly hoursPerActiveDay: number };
  readonly rates: Readonly<Record<string, number>>;
  readonly entries: readonly AiSpendEntryWrite[];
  readonly assumed?: readonly string[];
}

/** `POST /api/analytics/cost-model`. Parts left out are unchanged. */
export interface CostModelWrite {
  /** The workspace to save in. Required when there is no home yet; when given and different, the whole model moves there. */
  readonly home?: string;
  readonly roles?: { readonly roles: readonly CostRole[]; readonly assumed?: readonly string[] };
  readonly roleMapping?: { readonly types: Readonly<Record<AgentTypeId, string>>; readonly rules: readonly CostTypeRule[]; readonly assumed?: readonly string[] };
  readonly scenario?: { readonly mode: ProfileId; readonly currency: string; readonly assumed?: readonly string[] };
  readonly solo?: CostProfileWrite;
  readonly company?: CostProfileWrite;
  /** Return these parts to their defaults (a reset is journaled as a delete). */
  readonly reset?: readonly CostModelPartId[];
}

/** One spend line on a role's row, or on the shared row: the entry and what it cost this scope in the period. */
export interface RoiAiEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: SpendKind;
  readonly monthlyAmount: number;
  readonly quantity: number | null;
  /** Prorated over the period by day, and times `basis.share` for a single workspace. */
  readonly cost: number;
}

export interface RoiRoleValue {
  readonly roleId: string;
  readonly title: string;
  readonly hourlyRate: number;
  readonly hours: number;
  readonly value: number;
  readonly types: readonly AgentTypeId[];
  /** Done tickets in the period that landed on this role. */
  readonly tickets: number;
  /** Planned lens: of those, the ones whose estimate counts ("47 h estimated on 15 of the 20 tickets"). Null on the measured lens. */
  readonly estimatedTickets: number | null;
  /** The sum of the spend entries assigned to this role. Nothing is split between roles. */
  readonly aiCost: number;
  readonly aiEntries: readonly RoiAiEntry[];
}

export interface RoiLens {
  readonly lens: "measured" | "planned";
  readonly valueHours: number;
  readonly value: number;
  /** Roles with hours or tickets under this lens, and every role a spend entry is assigned to. */
  readonly byRole: readonly RoiRoleValue[];
  /** Every entry's cost: the roles' `aiCost` plus `sharedAiCost`. */
  readonly aiCost: number;
  /** The entries the team shares (assigned to no role, or to a role no longer in the list). */
  readonly sharedAiCost: number;
  readonly sharedAiEntries: readonly RoiAiEntry[];
  readonly director: { readonly hours: number; readonly hourlyRate: number; readonly cost: number };
  readonly totalCost: number;
  readonly net: number;
  readonly returnOnTotalCost: number | null;
  readonly returnOnAiSpend: number | null;
  readonly breakEvenRate: number | null;
  readonly outputMultiplier: number | null;
}

/** `GET /api/analytics/roi`. */
export interface RoiResponse {
  readonly asOf: string;
  readonly period: AnalyticsPeriod;
  readonly scope: AnalyticsReport["scope"];
  readonly model: CostModelResponse;
  readonly measured: RoiLens;
  readonly planned: RoiLens;
  /** How the costs were found, so the formula can be printed. */
  readonly basis: {
    /** The profile in use's AI spend over the period, before the share. */
    readonly aiSpendHub: number;
    readonly directorHoursHub: number;
    /** Days agents ran anywhere in the hub. */
    readonly activeDaysHub: number;
    readonly hoursPerActiveDay: number;
    /** This scope's share of the hub's agent-hours in the period: 1 for the hub. The spend and the director's time are multiplied by it. */
    readonly share: number;
    readonly scopeAgentHours: number;
    readonly hubAgentHours: number;
  };
  readonly agentTypes: readonly AgentTypeRow[];
  /** A role the mapping (`type`) or a rule (`rule`, its index) names that the role list lacks, priced at `usedRoleId`. */
  readonly fallbacks: readonly { readonly type: AgentTypeId | null; readonly rule: number | null; readonly missingRoleId: string; readonly usedRoleId: string }[];
  readonly caveats: readonly Caveat[];
}

/** One done ticket that landed on a role, and why. */
export interface RoiTicket {
  readonly workspace: string;
  readonly identifier: string;
  readonly title: string;
  readonly type: AgentTypeId;
  readonly reason: { readonly code: AgentTypeReasonId; readonly detail: string | null };
  /** Its own estimate when the planned lens counts it; null otherwise. */
  readonly plannedHours: number | null;
  /** Agent-hours of its own attempts, all time, each capped. */
  readonly agentHours: number;
}

/** `GET /api/analytics/roi/tickets?roleId=…`: the done tickets in the period priced at one role, most agent-hours first. */
export interface RoiTicketsResponse {
  readonly roleId: string;
  readonly period: AnalyticsPeriod;
  /** Every such ticket; `tickets` holds the first `limit` of them. */
  readonly total: number;
  readonly limit: number;
  readonly tickets: readonly RoiTicket[];
  /** Measured hours priced at this role on tickets NOT done in the period (still open, or done outside it). */
  readonly otherAgentHours: number;
}
