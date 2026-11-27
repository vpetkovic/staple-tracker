/**
 * The return on AI spend, as arithmetic and nothing else. Every figure the Return lens shows is
 * computed here from the role hours the report carries and the cost model the person owns, so the
 * page can recompute as a rate is typed and the formulas it prints are the ones it ran.
 *
 *   value of the work  =  Σ over roles ( hours that role would have put in × that role's rate )
 *   cost               =  AI spend for the period  +  the directing person's hours × their rate
 *   return             =  value ÷ cost
 *
 * Hours are counted two ways and never blended: MEASURED agent time (what the attempts recorded,
 * each capped; conservative, because agents are fast and run in parallel) and PLANNED effort (the
 * estimates on the finished tickets; closer to what a person would have needed, but only for the
 * tickets that carry an estimate).
 */
import type { CostModel, ReturnReport } from "./proto-api";

export interface RoleLine {
  roleId: string;
  title: string;
  rate: number;
  measuredHours: number;
  plannedHours: number;
  measuredValue: number;
  plannedValue: number;
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
  aiSpend: number;
  spendPerMonth: number;
  cost: number;
  measured: ValueSide;
  /** Null when no finished ticket in the period carries an estimate. */
  planned: ValueSide | null;
  /** The blended hourly rate at which measured agent time exactly pays for the cost. */
  breakEvenRate: number | null;
}

const FTE_HOURS_PER_WEEK = 40;

export function computeReturn(report: ReturnReport, model: CostModel): ReturnResult {
  const roles: RoleLine[] = model.roles.map((role) => {
    const hours = report.roles.find((row) => row.roleId === role.id);
    const measuredHours = hours?.measuredHours ?? 0;
    const plannedHours = hours?.plannedHours ?? 0;
    return { roleId: role.id, title: role.title, rate: role.rate, measuredHours, plannedHours, measuredValue: measuredHours * role.rate, plannedValue: plannedHours * role.rate, tickets: hours?.tickets ?? 0, estimatedTickets: hours?.estimatedTickets ?? 0 };
  });
  const directingHours = report.directing.activeDays * model.person.hoursPerActiveDay;
  const personCost = directingHours * model.person.rate;
  const spendPerMonth = model.spend.reduce((sum, line) => sum + line.perMonth, 0);
  const aiSpend = spendPerMonth * report.period.months;
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
    aiSpend,
    spendPerMonth,
    cost,
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
        personHint: "Nobody pays you for it, so it is an opportunity cost: what the same hours earn at your day rate.",
        rateLabel: "Your hourly rate",
        payer: "You",
      }
    : {
        who: "the company",
        whose: "the employee's",
        person: "Employee time",
        personHint: "What the company pays for the hours its employee spent directing agents (a loaded hourly cost).",
        rateLabel: "Employee hourly cost",
        payer: "The company",
      };
}
