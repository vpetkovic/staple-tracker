/**
 * The return on AI spend, as arithmetic and nothing else. Every figure the Return lens shows is
 * computed here from the role hours the report carries and the cost model the person owns, so the
 * page can recompute as a figure changes and the formulas it prints are the ones it ran.
 *
 *   value of the work  =  Σ over roles ( hours that role would have put in × that role's rate )
 *   cost               =  AI spend for the period  +  the directing person's hours × their rate
 *   return             =  value ÷ cost
 *
 * Hours are counted two ways and never blended: MEASURED agent time (what the attempts recorded,
 * each capped; conservative, because agents are fast and run in parallel) and PLANNED effort (the
 * estimates on the finished tickets; closer to what a person would have needed, but only for the
 * tickets that carry an estimate).
 *
 * AI spend has two kinds. Subscriptions are flat monthly plans; the API bill is the monthly
 * invoice. Each role's agents are billed one way or the other, and each kind is shared out over
 * its roles by their agent time, so every role shows what replacing it with AI cost.
 * Spend and directing time belong to the person, not to a workspace: a single-workspace view
 * takes the share of both that matches its share of agent time.
 */
import type { Billing, CostModel, CostProfile, ReturnReport } from "./proto-api";

export interface RoleLine {
  roleId: string;
  title: string;
  rate: number;
  billing: Billing;
  measuredHours: number;
  plannedHours: number;
  measuredValue: number;
  plannedValue: number;
  /** This role's share of the AI spend of its billing kind. */
  aiCost: number;
  tickets: number;
  estimatedTickets: number;
}
export interface ValueSide {
  hours: number;
  value: number;
  /** value ÷ cost; null when the cost is 0. */
  multiple: number | null;
  net: number;
  /** Work-hours delivered per hour the person put in. */
  leverage: number | null;
  /** Full-time people it would take to put those hours in over the period. */
  fte: number;
}
export interface ReturnResult {
  roles: RoleLine[];
  directingHours: number;
  personCost: number;
  subscriptionSpend: number;
  apiSpend: number;
  aiSpend: number;
  cost: number;
  /** Spend of a kind that no role with agent time is billed by: counted in the total, shown as its own line. */
  unallocated: Record<Billing, number>;
  /** Roles billed by API while no API bill is entered: the AI cost is understated. */
  apiBillMissing: boolean;
  share: number;
  measured: ValueSide;
  /** Null when no finished ticket in the period carries an estimate. */
  planned: ValueSide | null;
  /** The blended hourly rate at which measured agent time exactly pays for the cost. */
  breakEvenRate: number | null;
}

const FTE_HOURS_PER_WEEK = 40;

export const DEFAULT_RATE = 100;

/** The figures of the profile in use. */
export function profileOf(model: CostModel): CostProfile {
  return model.profiles[model.scenario];
}
export function rateOf(model: CostModel, roleId: string): number {
  return profileOf(model).rates[roleId] ?? DEFAULT_RATE;
}
export function billingOf(model: CostModel, roleId: string): Billing {
  return profileOf(model).billing[roleId] ?? (model.scenario === "company" ? "api" : "subscription");
}
/** A subscription line's monthly cost: its price × how many are paid for. */
export function lineCost(line: { perMonth: number; quantity: number }): number {
  return line.perMonth * Math.max(0, line.quantity ?? 1);
}

export function computeReturn(report: ReturnReport, model: CostModel): ReturnResult {
  const share = report.share ?? 1;
  const months = report.period.months;
  const profile = profileOf(model);
  const subscriptionSpend = profile.spend.reduce((sum, line) => sum + lineCost(line), 0) * months * share;
  const apiSpend = (profile.apiPerMonth ?? 0) * months * share;
  const base = model.roles.map((role) => {
    const hours = report.roles.find((row) => row.roleId === role.id);
    return { role, rate: rateOf(model, role.id), billing: billingOf(model, role.id), measuredHours: hours?.measuredHours ?? 0, plannedHours: hours?.plannedHours ?? 0, tickets: hours?.tickets ?? 0, estimatedTickets: hours?.estimatedTickets ?? 0 };
  });
  const hoursBilled = (kind: Billing) => base.filter((row) => row.billing === kind).reduce((sum, row) => sum + row.measuredHours, 0);
  const pool: Record<Billing, { spend: number; hours: number }> = { subscription: { spend: subscriptionSpend, hours: hoursBilled("subscription") }, api: { spend: apiSpend, hours: hoursBilled("api") } };
  const roles: RoleLine[] = base.map(({ role, rate, billing, measuredHours, plannedHours, tickets, estimatedTickets }) => ({
    roleId: role.id,
    title: role.title,
    rate,
    billing,
    measuredHours,
    plannedHours,
    measuredValue: measuredHours * rate,
    plannedValue: plannedHours * rate,
    aiCost: pool[billing].hours > 0 ? (pool[billing].spend * measuredHours) / pool[billing].hours : 0,
    tickets,
    estimatedTickets,
  }));
  const directingHours = report.directing.activeDays * profile.person.hoursPerActiveDay * share;
  const personCost = directingHours * profile.person.rate;
  const aiSpend = subscriptionSpend + apiSpend;
  const cost = aiSpend + personCost;
  const weeks = report.period.days / 7;
  const side = (hours: number, value: number): ValueSide => ({
    hours,
    value,
    multiple: cost > 0 ? value / cost : null,
    net: value - cost,
    leverage: directingHours > 0 ? hours / directingHours : null,
    fte: weeks > 0 ? hours / (weeks * FTE_HOURS_PER_WEEK) : 0,
  });
  const measuredHours = roles.reduce((sum, role) => sum + role.measuredHours, 0);
  const plannedHours = roles.reduce((sum, role) => sum + role.plannedHours, 0);
  return {
    roles,
    directingHours,
    personCost,
    subscriptionSpend,
    apiSpend,
    aiSpend,
    cost,
    unallocated: { subscription: pool.subscription.hours > 0 ? 0 : subscriptionSpend, api: pool.api.hours > 0 ? 0 : apiSpend },
    apiBillMissing: pool.api.hours > 0 && (profile.apiPerMonth ?? 0) <= 0,
    share,
    measured: side(measuredHours, roles.reduce((sum, role) => sum + role.measuredValue, 0)),
    planned: plannedHours > 0 ? side(plannedHours, roles.reduce((sum, role) => sum + role.plannedValue, 0)) : null,
    breakEvenRate: measuredHours > 0 ? cost / measuredHours : null,
  };
}

/** The words that change with who pays. One formula, two ways of saying whose money it is. */
export function scenarioWords(scenario: CostModel["scenario"]) {
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
