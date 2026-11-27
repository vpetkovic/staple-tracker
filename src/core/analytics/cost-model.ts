/**
 * The cost model: what the ROI page prices agent work with, and what it compares it against.
 *
 * Four parts, each one registered workspace setting (`settings-registry.ts`, category
 * `analytics`), so each syncs through the workspace's operation log as an ordinary `setting`
 * entity and each is its own conflict unit: editing rates on one device and AI spend on
 * another never collides.
 *
 *  - `analytics.roles`: the human roles, each with an hourly rate.
 *  - `analytics.roleMapping`: which role each agent type stands in for, and the person's own
 *    agent-type rules (`agent-type.ts`).
 *  - `analytics.scenario`: who pays. `solo`: one person directs the agents and their time is
 *    an opportunity cost. `company`: an employee directs them and their time is a wage. Both
 *    price the director's time the same way; the scenario says which question the page asks.
 *  - `analytics.aiSpend`: what the AI costs per month, as entries with a start month, so a plan
 *    change mid-period is priced at the plan in force each day.
 *
 * ## Defaults are assumptions
 *
 * Every part has a default so the page is useful before anyone configures it, and every
 * default carries `savedAt: null`. Beyond that, each part lists in `assumed` the figures still
 * at their shipped default (`director.hourlyRate`, `roles.<id>.hourlyRate`, …): the server
 * fills it for an unsaved part, and the page drops an id when the person changes that figure
 * and saves the rest. So changing one rate never silently blesses "8 hours a day".
 *
 * ## Validation is the registry's
 *
 * `costModelPartProblem` is the registry's validator for the `costModel` schema arm, so the
 * store refuses a malformed value on write and the read boundary refuses one on read, by the
 * same sentence.
 */
import { AGENT_TYPES, isAgentType, type AgentType, type AgentTypeRule } from "./agent-type.js";

export const COST_MODEL_PARTS = ["roles", "roleMapping", "scenario", "aiSpend"] as const;
export type CostModelPart = (typeof COST_MODEL_PARTS)[number];

export const COST_MODEL_KEYS: Readonly<Record<CostModelPart, string>> = {
  roles: "analytics.roles",
  roleMapping: "analytics.roleMapping",
  scenario: "analytics.scenario",
  aiSpend: "analytics.aiSpend",
};

/**
 * How the agents standing in for a role are paid for: a flat `subscription` (a plan), or
 * metered `api` usage. VP's ruling (2026-11-26): companies pay API prices by default, and each
 * role can be set either way.
 */
export const BILLING_KINDS = ["subscription", "api"] as const;
export type Billing = (typeof BILLING_KINDS)[number];

export interface Role {
  /** Stable id the mapping refers to: lowercase letters, digits and dashes. */
  readonly id: string;
  readonly title: string;
  /** What an hour of this role costs, in the scenario's currency. */
  readonly hourlyRate: number;
  /** How this role's agents are billed. Unset follows the scenario (`billingOf`). */
  readonly billing?: Billing;
}

/** Figure ids still at their shipped default (see the module comment). */
export type Assumed = readonly string[];

export interface RolesValue {
  readonly roles: readonly Role[];
  readonly assumed?: Assumed;
  readonly savedAt: string | null;
}

export interface RoleMappingValue {
  /** The role each agent type stands in for, by role id. Every agent type is present. */
  readonly types: Readonly<Record<AgentType, string>>;
  readonly rules: readonly AgentTypeRule[];
  readonly assumed?: Assumed;
  readonly savedAt: string | null;
}

export const SCENARIO_MODES = ["solo", "company"] as const;
export type ScenarioMode = (typeof SCENARIO_MODES)[number];

export interface ScenarioValue {
  readonly mode: ScenarioMode;
  /** ISO 4217 code every amount in the model is in. */
  readonly currency: string;
  /** The person directing the agents. */
  readonly director: {
    readonly title: string;
    /** solo: what an hour of their time is worth elsewhere; company: their loaded hourly cost. */
    readonly hourlyRate: number;
    /** Staple does not record a person's time, so it is estimated per day agents ran. */
    readonly hoursPerActiveDay: number;
  };
  readonly assumed?: Assumed;
  readonly savedAt: string | null;
}

export interface AiSpendEntry {
  readonly id: string;
  readonly label: string;
  readonly monthlyAmount: number;
  /** First month it applies, `YYYY-MM`. */
  readonly from: string;
  /** Last month it applies, `YYYY-MM`, or null for "still paying". */
  readonly to: string | null;
  /** Which bill this is. Unset is `subscription`. */
  readonly kind?: Billing;
}

export interface AiSpendValue {
  readonly entries: readonly AiSpendEntry[];
  readonly assumed?: Assumed;
  readonly savedAt: string | null;
}

export interface CostModel {
  readonly roles: RolesValue;
  readonly roleMapping: RoleMappingValue;
  readonly scenario: ScenarioValue;
  readonly aiSpend: AiSpendValue;
}

// ------------------------------------------------------------------ defaults

export const DEFAULT_ROLES: RolesValue = Object.freeze({
  roles: Object.freeze([
    Object.freeze({ id: "software-engineer", title: "Software Engineer", hourlyRate: 100 }),
    Object.freeze({ id: "design-engineer", title: "Design Engineer", hourlyRate: 95 }),
    Object.freeze({ id: "technical-writer", title: "Technical Writer", hourlyRate: 70 }),
  ]),
  assumed: Object.freeze(["roles.software-engineer.hourlyRate", "roles.design-engineer.hourlyRate", "roles.technical-writer.hourlyRate"]),
  savedAt: null,
});

export const DEFAULT_ROLE_MAPPING: RoleMappingValue = Object.freeze({
  types: Object.freeze({
    engineering: "software-engineer",
    design: "design-engineer",
    documentation: "technical-writer",
    research: "software-engineer",
    // No attempt is in the orchestrator lane today, so a manager role would open at 0 h.
    orchestration: "software-engineer",
  }),
  rules: Object.freeze([]),
  assumed: Object.freeze([]),
  savedAt: null,
});

export const DEFAULT_SCENARIO: ScenarioValue = Object.freeze({
  mode: "solo",
  currency: "USD",
  director: Object.freeze({ title: "You", hourlyRate: 100, hoursPerActiveDay: 8 }),
  assumed: Object.freeze(["director.hourlyRate", "director.hoursPerActiveDay"]),
  savedAt: null,
});

export const DEFAULT_AI_SPEND: AiSpendValue = Object.freeze({
  entries: Object.freeze([Object.freeze({ id: "ai-plan", label: "AI subscriptions", monthlyAmount: 200, from: "2000-01", to: null })]),
  assumed: Object.freeze(["entries.ai-plan.monthlyAmount"]),
  savedAt: null,
});

export const DEFAULT_COST_MODEL: CostModel = Object.freeze({
  roles: DEFAULT_ROLES,
  roleMapping: DEFAULT_ROLE_MAPPING,
  scenario: DEFAULT_SCENARIO,
  aiSpend: DEFAULT_AI_SPEND,
});

// ------------------------------------------------------------------ validation

const ROLE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_ROLES = 30;
const MAX_RULES = 50;
const MAX_SPEND_ENTRIES = 50;
const MAX_RATE = 100_000;
const MAX_MONTHLY = 100_000_000;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const isAmount = (value: unknown, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const isInstant = (value: unknown): boolean => typeof value === "string" && !Number.isNaN(Date.parse(value)) && /T/.test(value);

function unknownField(value: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  return extra === undefined ? null : `${where} has an unknown field "${extra}"`;
}

function savedAtProblem(value: Record<string, unknown>): string | null {
  if (value.assumed !== undefined) {
    if (!Array.isArray(value.assumed) || value.assumed.length > 200 || !value.assumed.every((id) => isText(id, 160))) {
      return "assumed must be a list of at most 200 figure ids";
    }
  }
  return value.savedAt === null || isInstant(value.savedAt) ? null : "savedAt must be an ISO-8601 instant or null";
}

function rolesProblem(value: unknown): string | null {
  if (!isObject(value)) return "an object {roles, savedAt}";
  const extra = unknownField(value, ["roles", "assumed", "savedAt"], "the role list");
  if (extra) return extra;
  if (!Array.isArray(value.roles) || value.roles.length === 0 || value.roles.length > MAX_ROLES) return `roles must list 1 to ${MAX_ROLES} roles`;
  const seen = new Set<string>();
  for (const [index, role] of value.roles.entries()) {
    if (!isObject(role)) return `role ${index + 1} must be an object {id, title, hourlyRate}`;
    const roleExtra = unknownField(role, ["id", "title", "hourlyRate", "billing"], `role ${index + 1}`);
    if (roleExtra) return roleExtra;
    if (typeof role.id !== "string" || !ROLE_ID.test(role.id)) return `role ${index + 1}'s id must be lowercase letters, digits and dashes`;
    if (seen.has(role.id)) return `role id "${role.id}" appears twice`;
    seen.add(role.id);
    if (!isText(role.title, 80)) return `role "${role.id}" needs a title of at most 80 characters`;
    if (!isAmount(role.hourlyRate, MAX_RATE)) return `role "${role.id}"'s hourlyRate must be a number from 0 to ${MAX_RATE}`;
    if (role.billing !== undefined && !(BILLING_KINDS as readonly unknown[]).includes(role.billing)) return `role "${role.id}"'s billing must be one of ${BILLING_KINDS.join(", ")}`;
  }
  return savedAtProblem(value);
}

function ruleProblem(rule: unknown, index: number): string | null {
  const where = `rule ${index + 1}`;
  if (!isObject(rule)) return `${where} must be an object`;
  const extra = unknownField(rule, ["agent", "workspace", "kind", "label", "title", "type", "roleId"], where);
  if (extra) return extra;
  if ((rule.type === undefined) === (rule.roleId === undefined)) return `${where} must set exactly one of type and roleId`;
  if (rule.type !== undefined && !isAgentType(rule.type)) return `${where}'s type must be one of ${AGENT_TYPES.join(", ")}`;
  if (rule.roleId !== undefined && (typeof rule.roleId !== "string" || !ROLE_ID.test(rule.roleId))) return `${where}'s roleId must name a role id`;
  const matchers = ["agent", "workspace", "kind", "label", "title"].filter((field) => rule[field] !== undefined);
  if (matchers.length === 0) return `${where} must match on at least one of agent, workspace, kind, label or title`;
  for (const field of matchers) if (!isText(rule[field], 120)) return `${where}'s ${field} must be text of at most 120 characters`;
  return null;
}

function roleMappingProblem(value: unknown): string | null {
  if (!isObject(value)) return "an object {types, rules, savedAt}";
  const extra = unknownField(value, ["types", "rules", "assumed", "savedAt"], "the role mapping");
  if (extra) return extra;
  if (!isObject(value.types)) return "types must map every agent type to a role id";
  const typeExtra = Object.keys(value.types).find((key) => !isAgentType(key));
  if (typeExtra !== undefined) return `types names "${typeExtra}", which is not an agent type (${AGENT_TYPES.join(", ")})`;
  for (const type of AGENT_TYPES) {
    const role = value.types[type];
    if (typeof role !== "string" || !ROLE_ID.test(role)) return `types.${type} must name a role id`;
  }
  if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES) return `rules must be a list of at most ${MAX_RULES}`;
  for (const [index, rule] of value.rules.entries()) {
    const problem = ruleProblem(rule, index);
    if (problem) return problem;
  }
  return savedAtProblem(value);
}

function scenarioProblem(value: unknown): string | null {
  if (!isObject(value)) return "an object {mode, currency, director, savedAt}";
  const extra = unknownField(value, ["mode", "currency", "director", "assumed", "savedAt"], "the scenario");
  if (extra) return extra;
  if (typeof value.mode !== "string" || !(SCENARIO_MODES as readonly string[]).includes(value.mode)) return `mode must be one of ${SCENARIO_MODES.join(", ")}`;
  if (typeof value.currency !== "string" || !CURRENCY.test(value.currency)) return "currency must be a three-letter ISO 4217 code such as USD";
  const director = value.director;
  if (!isObject(director)) return "director must be an object {title, hourlyRate, hoursPerActiveDay}";
  const directorExtra = unknownField(director, ["title", "hourlyRate", "hoursPerActiveDay"], "the director");
  if (directorExtra) return directorExtra;
  if (!isText(director.title, 80)) return "director.title must be text of at most 80 characters";
  if (!isAmount(director.hourlyRate, MAX_RATE)) return `director.hourlyRate must be a number from 0 to ${MAX_RATE}`;
  if (!isAmount(director.hoursPerActiveDay, 24)) return "director.hoursPerActiveDay must be a number from 0 to 24";
  return savedAtProblem(value);
}

function aiSpendProblem(value: unknown): string | null {
  if (!isObject(value)) return "an object {entries, savedAt}";
  const extra = unknownField(value, ["entries", "assumed", "savedAt"], "the AI spend");
  if (extra) return extra;
  if (!Array.isArray(value.entries) || value.entries.length > MAX_SPEND_ENTRIES) return `entries must be a list of at most ${MAX_SPEND_ENTRIES}`;
  const seen = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    const where = `spend entry ${index + 1}`;
    if (!isObject(entry)) return `${where} must be an object {id, label, monthlyAmount, from, to}`;
    const entryExtra = unknownField(entry, ["id", "label", "monthlyAmount", "from", "to", "kind"], where);
    if (entryExtra) return entryExtra;
    if (typeof entry.id !== "string" || !ROLE_ID.test(entry.id)) return `${where}'s id must be lowercase letters, digits and dashes`;
    if (seen.has(entry.id)) return `spend entry id "${entry.id}" appears twice`;
    seen.add(entry.id);
    if (!isText(entry.label, 80)) return `${where} needs a label of at most 80 characters`;
    if (!isAmount(entry.monthlyAmount, MAX_MONTHLY)) return `${where}'s monthlyAmount must be a number from 0 to ${MAX_MONTHLY}`;
    if (typeof entry.from !== "string" || !MONTH.test(entry.from)) return `${where}'s from must be a month YYYY-MM`;
    if (entry.to !== null && (typeof entry.to !== "string" || !MONTH.test(entry.to))) return `${where}'s to must be a month YYYY-MM or null`;
    if (typeof entry.to === "string" && entry.to < entry.from) return `${where} ends (${entry.to}) before it starts (${entry.from})`;
    if (entry.kind !== undefined && !(BILLING_KINDS as readonly unknown[]).includes(entry.kind)) return `${where}'s kind must be one of ${BILLING_KINDS.join(", ")}`;
  }
  return savedAtProblem(value);
}

/** Why `value` is not a valid `part`, or null. The registry's validator for the `costModel` arm. */
export function costModelPartProblem(part: CostModelPart, value: unknown): string | null {
  switch (part) {
    case "roles":
      return rolesProblem(value);
    case "roleMapping":
      return roleMappingProblem(value);
    case "scenario":
      return scenarioProblem(value);
    case "aiSpend":
      return aiSpendProblem(value);
  }
}

/** The newest `savedAt` across the parts, or null when every part is a default. */
export function costModelSavedAt(model: CostModel): string | null {
  let newest: string | null = null;
  for (const part of COST_MODEL_PARTS) {
    const at = model[part].savedAt;
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

// ------------------------------------------------------------------ pricing

/** An entry's bill: `subscription` unless it says `api`. */
export const kindOf = (entry: AiSpendEntry): Billing => entry.kind ?? "subscription";

/** How a role's agents are billed: its own setting, else the scenario's default (solo: subscription; company: API). */
export function billingOf(role: Role, scenario: ScenarioValue): Billing {
  return role.billing ?? (scenario.mode === "company" ? "api" : "subscription");
}

const inForce = (entry: AiSpendEntry, month: string): boolean => month >= entry.from && (entry.to === null || month <= entry.to);

/**
 * The AI spend that falls inside `days` (calendar days): each day costs its month's amount
 * divided by the days in that month, summed over every entry in force that month (of `kind`
 * only, when given). Proration by day is what makes a two-week period cost half a month.
 */
export function aiSpendFor(spend: AiSpendValue, days: readonly string[], kind?: Billing): number {
  let total = 0;
  for (const day of days) {
    const month = day.slice(0, 7);
    const [year, monthNumber] = month.split("-").map(Number) as [number, number];
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    for (const entry of spend.entries) {
      if (!inForce(entry, month) || (kind !== undefined && kindOf(entry) !== kind)) continue;
      total += entry.monthlyAmount / daysInMonth;
    }
  }
  return total;
}

/** True when some entry of `kind` is in force on at least one of `days`. */
export function spendCovers(spend: AiSpendValue, days: readonly string[], kind: Billing): boolean {
  const months = new Set(days.map((day) => day.slice(0, 7)));
  return spend.entries.some((entry) => kindOf(entry) === kind && [...months].some((month) => inForce(entry, month)));
}

/** One role's share of the value: the hours attributed to it and what they cost at its rate. */
export interface RoleValue {
  readonly roleId: string;
  readonly title: string;
  readonly hourlyRate: number;
  readonly hours: number;
  readonly value: number;
  /** The agent types whose hours landed on this role. */
  readonly types: readonly AgentType[];
  /** Done tickets in the period that landed on this role. */
  readonly tickets: number;
  /** Planned lens: of those, the ones whose estimate counts. Null on the measured lens. */
  readonly plannedTickets: number | null;
  /** How this role's agents are billed (`billingOf`). */
  readonly billing: Billing;
  /**
   * This role's share of the AI spend of its kind: that spend split over the roles billed the
   * same way, by their (measured) agent-hours. 0 when no role of the kind ran.
   */
  readonly aiCost: number;
}

/** The ROI under one lens. Every input is echoed so a surface can print the formula. */
export interface RoiResult {
  readonly lens: "measured" | "planned";
  /** Hours a human team would have needed, under this lens. */
  readonly valueHours: number;
  /** valueHours priced at each role's rate: what the equivalent team would have cost. */
  readonly value: number;
  readonly byRole: readonly RoleValue[];
  readonly aiCost: number;
  readonly director: { readonly hours: number; readonly hourlyRate: number; readonly cost: number };
  /** aiCost + director.cost. */
  readonly totalCost: number;
  /** value − totalCost. */
  readonly net: number;
  /** value ÷ totalCost; null when totalCost is 0. */
  readonly returnOnTotalCost: number | null;
  /** value ÷ aiCost: the return on what was actually paid out, for the solo case; null when aiCost is 0. */
  readonly returnOnAiSpend: number | null;
  /** totalCost ÷ valueHours: the hourly rate above which the work paid for itself; null when valueHours is 0. */
  readonly breakEvenRate: number | null;
  /** valueHours ÷ director.hours: how many people's output one director produced; null when director.hours is 0. */
  readonly outputMultiplier: number | null;
}

/** A role the mapping or a rule names that the role list does not hold, and the role used instead. */
export interface MappingFallback {
  /** The agent type whose mapping names it, or null for a rule. */
  readonly type: AgentType | null;
  /** The rule's index, or null for the mapping. */
  readonly rule: number | null;
  readonly missingRoleId: string;
  readonly usedRoleId: string;
}

/**
 * The role each agent type and each role-naming rule is priced at. Either can name a role
 * that is not in the list: the list and the mapping are separate settings and sync
 * separately, so a role deleted on one device can still be named by a mapping saved on
 * another. That one is priced at the first role and reported, never dropped (dropping it would
 * silently undercount the value).
 */
export function resolveRoles(model: CostModel): { roleOf: (type: AgentType) => Role; role: (id: string) => Role; fallbacks: MappingFallback[] } {
  const roles = new Map(model.roles.roles.map((role) => [role.id, role]));
  const first = model.roles.roles[0]!;
  const fallbacks: MappingFallback[] = [];
  const resolved = new Map<AgentType, Role>();
  for (const type of AGENT_TYPES) {
    const wanted = model.roleMapping.types[type];
    const role = roles.get(wanted);
    resolved.set(type, role ?? first);
    if (!role) fallbacks.push({ type, rule: null, missingRoleId: wanted, usedRoleId: first.id });
  }
  for (const [index, rule] of model.roleMapping.rules.entries()) {
    if (rule.roleId !== undefined && !roles.has(rule.roleId)) fallbacks.push({ type: null, rule: index, missingRoleId: rule.roleId, usedRoleId: first.id });
  }
  return { roleOf: (type) => resolved.get(type)!, role: (id) => roles.get(id) ?? first, fallbacks };
}

/** What one role collected under one lens, before pricing. Keyed by the role id it was priced to. */
export interface RoleTally {
  readonly hours: number;
  readonly types: ReadonlySet<AgentType>;
  readonly tickets: number;
  readonly plannedTickets: number | null;
}

export function roi(input: {
  readonly lens: "measured" | "planned";
  /** Hours by role id. A role id the list does not hold is priced at the first role (see `resolveRoles`). */
  readonly byRole: ReadonlyMap<string, RoleTally>;
  /** The scope's AI spend for the period, by bill. `aiCost` is their sum. */
  readonly aiCostByKind: Readonly<Record<Billing, number>>;
  /** Measured agent-hours by role id: what each kind's spend is split by, on both lenses. */
  readonly agentHoursByRole: ReadonlyMap<string, number>;
  readonly directorHours: number;
  readonly model: CostModel;
}): RoiResult {
  const { role: roleById } = resolveRoles(input.model);
  type Held = { role: Role; hours: number; types: Set<AgentType>; tickets: number; plannedTickets: number | null; agentHours: number };
  const merged = new Map<string, Held>();
  const hold = (id: string): Held => {
    const role = roleById(id);
    let held = merged.get(role.id);
    if (!held) {
      held = { role, hours: 0, types: new Set<AgentType>(), tickets: 0, plannedTickets: input.lens === "planned" ? 0 : null, agentHours: 0 };
      merged.set(role.id, held);
    }
    return held;
  };
  for (const [id, tally] of input.byRole) {
    if (tally.hours <= 0 && tally.tickets === 0) continue;
    const held = hold(id);
    held.hours += tally.hours;
    for (const type of tally.types) held.types.add(type);
    held.tickets += tally.tickets;
    if (held.plannedTickets !== null) held.plannedTickets += tally.plannedTickets ?? 0;
  }
  // A role that ran carries its share of the spend on both lenses, planned hours or not.
  for (const [id, hours] of input.agentHoursByRole) if (hours > 0) hold(id).agentHours += hours;
  const scenario = input.model.scenario;
  const hoursOfKind: Record<Billing, number> = { subscription: 0, api: 0 };
  for (const held of merged.values()) hoursOfKind[billingOf(held.role, scenario)] += held.agentHours;
  const byRole: RoleValue[] = [...merged.values()]
    .map(({ role, hours, types, tickets, plannedTickets, agentHours }) => {
      const billing = billingOf(role, scenario);
      return {
        roleId: role.id,
        title: role.title,
        hourlyRate: role.hourlyRate,
        hours,
        value: hours * role.hourlyRate,
        types: AGENT_TYPES.filter((type) => types.has(type)),
        tickets,
        plannedTickets,
        billing,
        aiCost: hoursOfKind[billing] > 0 ? (input.aiCostByKind[billing] * agentHours) / hoursOfKind[billing] : 0,
      };
    })
    .sort((a, b) => b.value - a.value || b.hours - a.hours || a.roleId.localeCompare(b.roleId));
  const valueHours = byRole.reduce((sum, role) => sum + role.hours, 0);
  const value = byRole.reduce((sum, role) => sum + role.value, 0);
  // Every bill counts, whether or not a role billed that way ran.
  const aiCost = input.aiCostByKind.subscription + input.aiCostByKind.api;
  const rate = scenario.director.hourlyRate;
  const directorCost = input.directorHours * rate;
  const totalCost = aiCost + directorCost;
  return {
    lens: input.lens,
    valueHours,
    value,
    byRole,
    aiCost,
    director: { hours: input.directorHours, hourlyRate: rate, cost: directorCost },
    totalCost,
    net: value - totalCost,
    returnOnTotalCost: totalCost > 0 ? value / totalCost : null,
    returnOnAiSpend: aiCost > 0 ? value / aiCost : null,
    breakEvenRate: valueHours > 0 ? totalCost / valueHours : null,
    outputMultiplier: input.directorHours > 0 ? valueHours / input.directorHours : null,
  };
}
