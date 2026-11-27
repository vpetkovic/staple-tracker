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
 * AI spend is assigned, never split by a formula: each subscription (a price × how many) and each
 * API bill belongs to the role whose agents use it, or to the whole team. A role's AI cost is the
 * sum of its own lines for the period.
 * Roles come from the work: a role that caught no ticket in scope is not part of this team, so it
 * is left out and its AI lines cost nothing here. On a single workspace a role's lines count for
 * that workspace's share of the role's agent time; shared lines and directing time count for the
 * workspace's share of all agent time.
 */
import type { CostModel, CostProfile, ReturnReport, SpendLine } from "./proto-api";

export interface AiLine {
  id: string;
  label: string;
  kind: SpendLine["kind"];
  perMonth: number;
  quantity: number;
  /** What the line costs a month: price × how many, or the API bill. */
  monthly: number;
  /** What it cost over the period (and, on one workspace, that workspace's share). */
  cost: number;
}
export interface RoleLine {
  roleId: string;
  title: string;
  rate: number;
  measuredHours: number;
  plannedHours: number;
  measuredValue: number;
  plannedValue: number;
  /** The AI lines assigned to this role, and their sum for the period. */
  aiLines: AiLine[];
  aiCost: number;
  tickets: number;
  estimatedTickets: number;
  /** Did any of this role's work happen in scope? A role with none is left out of the page and of the cost. */
  present: boolean;
  /** The part of the role's AI lines this scope carries: 1 for every workspace, else this workspace's share of the role's agent time. */
  share: number;
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
  /** AI lines no role is assigned: shared by the whole team. */
  sharedLines: AiLine[];
  sharedAiCost: number;
  aiSpend: number;
  cost: number;
  /** No AI spend is entered in the profile in use: the cost is the person's time alone. */
  aiMissing: boolean;
  months: number;
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
/** What a line costs a month: a subscription is its price × how many are paid for; an API bill is the bill. */
export function lineCost(line: Pick<SpendLine, "kind" | "perMonth" | "quantity">): number {
  return line.kind === "api" ? line.perMonth : line.perMonth * Math.max(0, line.quantity ?? 1);
}

export function computeReturn(report: ReturnReport, model: CostModel): ReturnResult {
  const share = report.share ?? 1;
  const months = report.period.months;
  const profile = profileOf(model);
  const known = new Set(model.roles.map((role) => role.id));
  const all = report.scope.kind === "all";
  const ai = (line: SpendLine, part: number): AiLine => ({ id: line.id, label: line.label, kind: line.kind, perMonth: line.perMonth, quantity: line.quantity, monthly: lineCost(line), cost: lineCost(line) * months * part });
  const total = (lines: readonly AiLine[]) => lines.reduce((sum, line) => sum + line.cost, 0);
  const roles: RoleLine[] = model.roles.map((role) => {
    const hours = report.roles.find((row) => row.roleId === role.id);
    const rate = rateOf(model, role.id);
    const measuredHours = hours?.measuredHours ?? 0;
    const plannedHours = hours?.plannedHours ?? 0;
    // Roles come from the work: one that caught nothing in scope is not part of this team and costs nothing here.
    const present = (hours?.tickets ?? 0) > 0 || measuredHours > 0;
    const hubHours = hours?.hubMeasuredHours ?? 0;
    const part = !present ? 0 : all ? 1 : hubHours > 0 ? Math.min(1, measuredHours / hubHours) : 0;
    const aiLines = present ? profile.spend.filter((line) => line.roleId === role.id).map((line) => ai(line, part)) : [];
    return { roleId: role.id, title: role.title, rate, measuredHours, plannedHours, measuredValue: measuredHours * rate, plannedValue: plannedHours * rate, aiLines, aiCost: total(aiLines), tickets: hours?.tickets ?? 0, estimatedTickets: hours?.estimatedTickets ?? 0, present, share: part };
  });
  // A line with no role, or for a role that no longer exists, is the whole team's.
  const sharedLines = profile.spend.filter((line) => line.roleId === null || !known.has(line.roleId)).map((line) => ai(line, share));
  const sharedAiCost = total(sharedLines);
  const aiSpend = sharedAiCost + roles.reduce((sum, role) => sum + role.aiCost, 0);
  const directingHours = report.directing.activeDays * profile.person.hoursPerActiveDay * share;
  const personCost = directingHours * profile.person.rate;
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
    sharedLines,
    sharedAiCost,
    aiSpend,
    cost,
    aiMissing: aiSpend <= 0,
    months,
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
