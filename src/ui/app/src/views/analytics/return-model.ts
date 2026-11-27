/**
 * The Return lens's adapter: what the server's `RoiResponse` says, in the shape the page draws.
 *
 * Every figure is the server's (`GET /api/analytics/roi`, `src/core/analytics/contract.ts`).
 * Nothing here prices anything: the value of the work, the cost, the return, each role's AI
 * lines and their arithmetic all arrive computed. The adapter only joins the two lenses role by
 * role, puts the roles the work came from ahead of the ones it did not, and names the figures
 * still at their shipped default, so the components read one plain object.
 *
 *   value of the work  =  Σ over roles ( hours priced at that role × that role's rate )
 *   cost               =  AI spend for the period  +  the directing person's hours × their rate
 *   return             =  value ÷ cost
 *
 * Hours are counted two ways and never blended: MEASURED agent time and PLANNED effort (the
 * estimates on the finished tickets). On one workspace, a role's AI lines count for the role's
 * `share` and the shared lines and directing time for `basis.share`; the server applies both,
 * and the page prints them.
 */
import type {
  AgentTypeId,
  AiSpendEntryValue,
  Caveat,
  CaveatCode,
  CostModelValue,
  CostProfileValue,
  CostTypeRule,
  ProfileId,
  RoiAiEntry,
  RoiLens,
  RoiResponse,
} from "@/lib/analytics-api";
import { formatNumber, formatPercent } from "@/components/analytics/format";

/** A full-time week, for "Team to match it". The server's `definitions.fteHoursPerWeek`; `RoiResponse` does not echo the definitions. */
export const FTE_HOURS_PER_WEEK = 40;
/** The server's `definitions.attemptCapHours`, for the sentence that says agent time is capped. */
export const ATTEMPT_CAP_HOURS = 12;
/** The rate a role the profile does not set reads at (the contract's default). */
export const DEFAULT_RATE = 100;

export const AGENT_TYPES: readonly AgentTypeId[] = ["engineering", "design", "documentation", "research", "orchestration"];

/** One AI line as the page prints it: the entry, what it costs a month, and what it cost this scope in the period. */
export interface AiLine {
  id: string;
  label: string;
  kind: RoiAiEntry["kind"];
  /** The price of one a month (a subscription), or the bill a month (an API bill). */
  perMonth: number;
  /** How many are bought; null for an API bill. */
  quantity: number | null;
  /** The server's cost for the period, the share already applied. */
  cost: number;
}

/** One role, both lenses joined. */
export interface RoleView {
  roleId: string;
  title: string;
  rate: number;
  measuredHours: number;
  plannedHours: number;
  measuredValue: number;
  plannedValue: number;
  /** Done tickets in the period priced at the role. */
  tickets: number;
  /** Of those, the ones whose estimate counts. */
  estimatedTickets: number;
  present: boolean;
  /** The part of the role's own AI lines this scope carries. */
  share: number;
  aiCost: number;
  aiLines: AiLine[];
  /** The agent types whose work landed on the role in this period. */
  types: AgentTypeId[];
}

/** One lens's headline figures. */
export interface LensView {
  hours: number;
  value: number;
  /** Return on total cost; null when nothing was spent. */
  multiple: number | null;
  net: number;
  /** Value hours per directing hour; null with no directing time. */
  leverage: number | null;
  /** Full-time people it would take to put the hours in over the period. */
  fte: number;
}

export interface ReturnView {
  currency: string;
  /** The sign amounts are written with ("$" for USD). */
  sign: string;
  mode: ProfileId;
  /** "all workspaces", or the workspace's slug. */
  scope: string;
  hub: boolean;
  period: { from: string; to: string; days: number; weeks: number };
  /** Present roles, the server's order (most value first). */
  roles: RoleView[];
  /** Roles in the list that did no work in scope, in the list's order. */
  absent: RoleView[];
  /** Every role in the list, present or not, for the role page. */
  all: RoleView[];
  shared: { cost: number; lines: AiLine[] };
  director: { hours: number; rate: number; cost: number; activeDays: number; hoursPerActiveDay: number };
  /** The scope's share of the shared AI and directing time: 1 on the hub. */
  share: number;
  aiSpend: number;
  cost: number;
  measured: LensView;
  /** Null when no finished ticket in the period carries an estimate. */
  planned: LensView | null;
  breakEvenRate: number | null;
  /** Finished tickets, and how many of them carry an estimate that counts. */
  estimates: { covered: number; total: number };
  caveats: Partial<Record<CaveatCode, Caveat>>;
  /** Roles the mapping or a rule names that the list lacks, and the role their hours are priced at. */
  fallbacks: { missingRoleId: string; usedTitle: string; type: AgentTypeId | null; rule: number | null }[];
}

const lineOf = (entry: RoiAiEntry): AiLine => ({ id: entry.id, label: entry.label, kind: entry.kind, perMonth: entry.monthlyAmount, quantity: entry.quantity, cost: entry.cost });

function lensView(lens: RoiLens, days: number): LensView {
  const weeks = days / 7;
  return {
    hours: lens.valueHours,
    value: lens.value,
    multiple: lens.returnOnTotalCost,
    net: lens.net,
    leverage: lens.outputMultiplier,
    fte: weeks > 0 ? lens.valueHours / (weeks * FTE_HOURS_PER_WEEK) : 0,
  };
}

/** The page's view of one ROI answer. `model` is the cost model on screen (the person's latest edit), for the role list. */
export function returnView(roi: RoiResponse, model: CostModelValue = roi.model.model): ReturnView {
  const { measured, planned } = roi;
  const plannedOf = new Map(planned.byRole.map((row) => [row.roleId, row]));
  const listed = new Map(model.roles.roles.map((role) => [role.id, role]));
  const view = (roleId: string): RoleView => {
    const low = measured.byRole.find((row) => row.roleId === roleId);
    const high = plannedOf.get(roleId);
    const rate = low?.hourlyRate ?? high?.hourlyRate ?? model[model.scenario.mode].rates[roleId] ?? DEFAULT_RATE;
    return {
      roleId,
      title: listed.get(roleId)?.title ?? low?.title ?? high?.title ?? roleId,
      rate,
      measuredHours: low?.hours ?? 0,
      plannedHours: high?.hours ?? 0,
      measuredValue: low?.value ?? 0,
      plannedValue: high?.value ?? 0,
      tickets: low?.tickets ?? high?.tickets ?? 0,
      estimatedTickets: high?.estimatedTickets ?? 0,
      present: low?.present ?? false,
      share: low?.share ?? 0,
      aiCost: low?.aiCost ?? 0,
      aiLines: (low?.aiEntries ?? []).map(lineOf),
      types: [...new Set([...(low?.types ?? []), ...(high?.types ?? [])])],
    };
  };
  const roles = measured.byRole.filter((row) => row.present).map((row) => view(row.roleId));
  const presentIds = new Set(roles.map((role) => role.roleId));
  const absent = model.roles.roles.filter((role) => !presentIds.has(role.id)).map((role) => view(role.id));
  const titleOf = (id: string): string => listed.get(id)?.title ?? measured.byRole.find((row) => row.roleId === id)?.title ?? id;
  const caveats: Partial<Record<CaveatCode, Caveat>> = {};
  for (const caveat of roi.caveats) caveats[caveat.code] = caveat;
  const total = measured.byRole.reduce((sum, row) => sum + row.tickets, 0);
  const partial = caveats.estimates_partial;
  const covered = partial?.of != null ? partial.of - partial.count : planned.byRole.reduce((sum, row) => sum + (row.estimatedTickets ?? 0), 0);
  return {
    // The figures were priced with the profile the server read; the words follow it, not the edit in flight.
    currency: roi.model.model.scenario.currency,
    sign: currencySymbol(roi.model.model.scenario.currency),
    mode: roi.model.model.scenario.mode,
    scope: roi.scope.kind === "hub" ? "all workspaces" : (roi.scope.workspaces[0]?.slug ?? "this workspace"),
    hub: roi.scope.kind === "hub",
    period: { from: roi.period.from, to: roi.period.to, days: roi.period.days, weeks: roi.period.days / 7 },
    roles,
    absent,
    all: [...roles, ...absent],
    shared: { cost: measured.sharedAiCost, lines: measured.sharedAiEntries.map(lineOf) },
    director: { hours: measured.director.hours, rate: measured.director.hourlyRate, cost: measured.director.cost, activeDays: roi.basis.activeDaysHub, hoursPerActiveDay: roi.basis.hoursPerActiveDay },
    share: roi.basis.share,
    aiSpend: measured.aiCost,
    cost: measured.totalCost,
    measured: lensView(measured, roi.period.days),
    planned: planned.valueHours > 0 ? lensView(planned, roi.period.days) : null,
    breakEvenRate: measured.breakEvenRate,
    estimates: { covered, total: partial?.of ?? total },
    caveats,
    fallbacks: roi.fallbacks.map((fallback) => ({ missingRoleId: fallback.missingRoleId, usedTitle: titleOf(fallback.usedRoleId), type: fallback.type, rule: fallback.rule })),
  };
}

/** "Copilot $19 × 4 a month", "API bill $230 a month". */
export const planWords = (line: AiLine, sign: string): string => `${line.label} ${sign}${formatNumber(line.perMonth)}${line.kind === "subscription" ? ` × ${line.quantity ?? 1}` : ""} a month`;

/** "34%", "0.5%", "under 0.1%": a share said so a small one never reads as nothing. */
export function sharePercent(share: number): string {
  if (share > 0 && share < 0.0005) return "under 0.1%";
  return formatPercent(share, share < 0.1 ? 1 : 0);
}

/** " × 34% of agent time", the share in the arithmetic of one workspace. */
export const shareWords = (share: number, whose: string): string => ` × ${sharePercent(share)} of ${whose}`;

/** A count of full-time people: "2.7", and "under 0.1" where rounding would say nobody. */
export const peopleWords = (people: number): string => (people > 0 && people < 0.05 ? "under 0.1" : formatNumber(people, 1));

/** The AI lines of a role or the shared row, each with its arithmetic: price × how many a month, × the share on one workspace (null on the hub). */
export function aiDetail(lines: readonly AiLine[], sign: string, share: number | null, whose: string): string {
  return lines.map((line) => `${planWords(line, sign)}${share !== null && share < 1 ? shareWords(share, whose) : ""}`).join(", ");
}

// ---------------------------------------------------------------- the cost model, read

/** The sign an ISO currency is written with ("USD" is "$"); the code itself when there is none. */
export function currencySymbol(code: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((part) => part.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

/** The figures of the profile in use. */
export const activeProfile = (model: CostModelValue): CostProfileValue => model[model.scenario.mode];

/** What one entry costs a month: a subscription is its price × how many, an API bill is the bill. */
export function monthlyOf(entry: Pick<AiSpendEntryValue, "kind" | "monthlyAmount" | "quantity">): number {
  return entry.kind === "api" ? entry.monthlyAmount : entry.monthlyAmount * Math.max(0, entry.quantity ?? 1);
}

/** Is `id` still at its shipped default in the profile in use? */
export const isAssumed = (model: CostModelValue, id: string): boolean => activeProfile(model).assumed.includes(id);

/**
 * The figures of the profile in use still at their shipped default, named for the notice: the
 * ids the server listed, for things that still exist (a role in the list, an entry in the profile).
 */
export function assumedFigures(model: CostModelValue): string[] {
  const profile = activeProfile(model);
  const roles = new Set(model.roles.roles.map((role) => `roles.${role.id}.hourlyRate`));
  const entries = new Set(profile.entries.map((entry) => `entries.${entry.id}.monthlyAmount`));
  return profile.assumed.filter((id) => id.startsWith("director.") || roles.has(id) || entries.has(id));
}

/** The words for the figures `assumedFigures` lists. */
export function assumedWords(ids: readonly string[], whose: string): string[] {
  const words: string[] = [];
  if (ids.includes("director.hourlyRate")) words.push(`${whose} hourly rate`);
  if (ids.includes("director.hoursPerActiveDay")) words.push(`${whose} hours a day`);
  if (ids.some((id) => id.startsWith("entries."))) words.push("AI spend");
  if (ids.some((id) => id.startsWith("roles."))) words.push("role rates");
  return words;
}

/** The role that holds `engineering`: every ticket no rule or word places lands there. */
export const catchAllRole = (model: CostModelValue): string => model.roleMapping.types.engineering;

/** A month key `YYYY-MM` as "Mar 2026". */
export function monthWords(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year ?? 2000, (number ?? 1) - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}
/** The months an entry covers, in words, or null when it covers every month (a new entry does). */
export function entryDates(entry: Pick<AiSpendEntryValue, "from" | "to">): string | null {
  if (entry.to === null && entry.from <= "2000-01") return null;
  if (entry.to === null) return `from ${monthWords(entry.from)}`;
  if (entry.from <= "2000-01") return `until ${monthWords(entry.to)}`;
  return entry.from === entry.to ? monthWords(entry.from) : `${monthWords(entry.from)} to ${monthWords(entry.to)}`;
}

/** A rule's matchers, as the role page words them. */
export const RULE_FIELDS = ["label", "title", "agent", "kind", "workspace"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
export const matchersOf = (rule: CostTypeRule): RuleField[] => RULE_FIELDS.filter((field) => rule[field] !== undefined);

/** The words that change with who pays. One formula, two ways of saying whose money it is. */
export function scenarioWords(scenario: ProfileId) {
  return scenario === "solo"
    ? {
        who: "you",
        whose: "your",
        person: "Your time",
        personShort: "your time",
        personHint: "Nobody pays you for it, so it is an opportunity cost: what the same hours earn at your day rate.",
        rateLabel: "Your hourly rate",
        payer: "You",
        label: "Just me",
      }
    : {
        who: "the company",
        whose: "the employee's",
        person: "Employee time",
        personShort: "an employee's time",
        personHint: "What the company pays for the hours its employee spent directing agents (a loaded hourly cost).",
        rateLabel: "Employee hourly cost",
        payer: "The company",
        label: "A company",
      };
}
