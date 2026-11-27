/**
 * The cost model: what the ROI page prices agent work with, and what it compares it against.
 *
 * Five parts, each one registered workspace setting (`settings-registry.ts`, category
 * `analytics`), so each syncs through the workspace's operation log as an ordinary `setting`
 * entity and each is its own conflict unit.
 *
 * Shared by whoever pays, because the work is the same:
 *  - `analytics.roles`: the human roles, ids and titles.
 *  - `analytics.roleMapping`: which role each agent type stands in for, and the person's own
 *    agent-type rules (`agent-type.ts`).
 *  - `analytics.scenario`: the profile in use (`solo` or `company`) and the currency.
 *
 * One PROFILE per payer (VP's ruling, 2026-11-26: "a company's setup can differ from mine"),
 * each its own setting so that editing the company profile on one device can never change a
 * solo figure, a sync merge included:
 *  - `analytics.solo`, `analytics.company`: the director (rate, hours per active day), each
 *    role's hourly rate, and the AI spend entries, each assigned to a role or shared by the team
 *    (VP's ruling, 2026-11-26: "assign the AI subscription cost to each team member, with the
 *    quantity"). Nothing is split between roles by a hidden rule.
 *
 * `solo`: one person directs the agents and their time is an opportunity cost. `company`: an
 * employee directs them and their time is a wage. Both price the director's time the same way;
 * the profile says which question the page asks. Switching profiles copies nothing.
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
 * `costModelPartProblem` is the registry's validator for these settings, so the store refuses
 * a malformed value on write and the read boundary refuses one on read, by the same sentence.
 */
import { AGENT_TYPES, isAgentType, type AgentType, type AgentTypeRule } from "./agent-type.js";

export const SCENARIO_MODES = ["solo", "company"] as const;
export type ScenarioMode = (typeof SCENARIO_MODES)[number];

export const COST_MODEL_PARTS = ["roles", "roleMapping", "scenario", "solo", "company"] as const;
export type CostModelPart = (typeof COST_MODEL_PARTS)[number];

export const COST_MODEL_KEYS: Readonly<Record<CostModelPart, string>> = {
  roles: "analytics.roles",
  roleMapping: "analytics.roleMapping",
  scenario: "analytics.scenario",
  solo: "analytics.solo",
  company: "analytics.company",
};

/** What a spend entry is: a flat `subscription` (a plan, bought in some quantity), or a metered `api` bill. */
export const SPEND_KINDS = ["subscription", "api"] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

/** A role: shared by both profiles. Its rate is each profile's. */
export interface Role {
  /** Stable id the mapping and the profiles refer to: lowercase letters, digits and dashes. */
  readonly id: string;
  readonly title: string;
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

export interface ScenarioValue {
  /** The profile in use. */
  readonly mode: ScenarioMode;
  /** ISO 4217 code every amount in the model is in. */
  readonly currency: string;
  readonly assumed?: Assumed;
  readonly savedAt: string | null;
}

export interface AiSpendEntry {
  readonly id: string;
  readonly label: string;
  /** The price of one, per month. */
  readonly monthlyAmount: number;
  /** First month it applies, `YYYY-MM`. */
  readonly from: string;
  /** Last month it applies, `YYYY-MM`, or null for "still paying". */
  readonly to: string | null;
  /** Which bill this is. Unset is `subscription`. */
  readonly kind?: SpendKind;
  /** Subscriptions only: how many are bought (default 1, also for null). The month costs `monthlyAmount × quantity`. */
  readonly quantity?: number | null;
  /** The role this spend is for, or null (the default) for spend shared by the whole team. A role no longer in the list reads as shared. */
  readonly roleId?: string | null;
}

/** One payer's figures. */
export interface ProfileValue {
  /** The person directing the agents. */
  readonly director: {
    readonly title: string;
    /** solo: what an hour of their time is worth elsewhere; company: their loaded hourly cost. */
    readonly hourlyRate: number;
    /** Staple does not record a person's time, so it is estimated per day agents ran. */
    readonly hoursPerActiveDay: number;
  };
  /** Each role's hourly rate, by role id. A role without one is priced at `DEFAULT_ROLE_RATE`, assumed. */
  readonly rates: Readonly<Record<string, number>>;
  readonly entries: readonly AiSpendEntry[];
  readonly assumed?: Assumed;
  readonly savedAt: string | null;
}

export interface CostModel {
  readonly roles: RolesValue;
  readonly roleMapping: RoleMappingValue;
  readonly scenario: ScenarioValue;
  readonly solo: ProfileValue;
  readonly company: ProfileValue;
}

// ------------------------------------------------------------------ defaults

/** The rate a role without one in the active profile is priced at, and listed as assumed. */
export const DEFAULT_ROLE_RATE = 100;

const SHIPPED_RATES: Readonly<Record<string, number>> = Object.freeze({ "software-engineer": 100, "design-engineer": 95, "technical-writer": 70 });
const RATE_ASSUMED = Object.keys(SHIPPED_RATES).map((id) => `roles.${id}.hourlyRate`);

export const DEFAULT_ROLES: RolesValue = Object.freeze({
  roles: Object.freeze([
    Object.freeze({ id: "software-engineer", title: "Software Engineer" }),
    Object.freeze({ id: "design-engineer", title: "Design Engineer" }),
    Object.freeze({ id: "technical-writer", title: "Technical Writer" }),
  ]),
  assumed: Object.freeze([]),
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

export const DEFAULT_SCENARIO: ScenarioValue = Object.freeze({ mode: "solo", currency: "USD", assumed: Object.freeze([]), savedAt: null });

/** Just me: one $200 subscription. */
export const DEFAULT_SOLO: ProfileValue = Object.freeze({
  director: Object.freeze({ title: "You", hourlyRate: 100, hoursPerActiveDay: 8 }),
  rates: SHIPPED_RATES,
  entries: Object.freeze([Object.freeze({ id: "ai-plan", label: "AI subscription", monthlyAmount: 200, from: "2000-01", to: null, kind: "subscription" as const, quantity: 1, roleId: null })]),
  assumed: Object.freeze(["director.hourlyRate", "director.hoursPerActiveDay", ...RATE_ASSUMED, "entries.ai-plan.monthlyAmount"]),
  savedAt: null,
});

/** A company: no spend entered yet, so a fresh company profile says there is none. */
export const DEFAULT_COMPANY: ProfileValue = Object.freeze({
  director: Object.freeze({ title: "Employee", hourlyRate: 100, hoursPerActiveDay: 8 }),
  rates: SHIPPED_RATES,
  entries: Object.freeze([]),
  assumed: Object.freeze(["director.hourlyRate", "director.hoursPerActiveDay", ...RATE_ASSUMED]),
  savedAt: null,
});

export const DEFAULT_COST_MODEL: CostModel = Object.freeze({
  roles: DEFAULT_ROLES,
  roleMapping: DEFAULT_ROLE_MAPPING,
  scenario: DEFAULT_SCENARIO,
  solo: DEFAULT_SOLO,
  company: DEFAULT_COMPANY,
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
const MAX_QUANTITY = 100_000;

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
    if (!isObject(role)) return `role ${index + 1} must be an object {id, title}`;
    const roleExtra = unknownField(role, ["id", "title"], `role ${index + 1}`);
    if (roleExtra) return roleExtra;
    if (typeof role.id !== "string" || !ROLE_ID.test(role.id)) return `role ${index + 1}'s id must be lowercase letters, digits and dashes`;
    if (seen.has(role.id)) return `role id "${role.id}" appears twice`;
    seen.add(role.id);
    if (!isText(role.title, 80)) return `role "${role.id}" needs a title of at most 80 characters`;
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
  if (!isObject(value)) return "an object {mode, currency, savedAt}";
  const extra = unknownField(value, ["mode", "currency", "assumed", "savedAt"], "the scenario");
  if (extra) return extra;
  if (typeof value.mode !== "string" || !(SCENARIO_MODES as readonly string[]).includes(value.mode)) return `mode must be one of ${SCENARIO_MODES.join(", ")}`;
  if (typeof value.currency !== "string" || !CURRENCY.test(value.currency)) return "currency must be a three-letter ISO 4217 code such as USD";
  return savedAtProblem(value);
}

/** A by-role-id map: at most `MAX_ROLES` keys, each a role id, each value passing `valid`. */
function byRoleProblem(value: unknown, where: string, valid: (entry: unknown) => boolean, expected: string): string | null {
  if (!isObject(value)) return `${where} must map role ids to ${expected}`;
  const keys = Object.keys(value);
  if (keys.length > MAX_ROLES) return `${where} names at most ${MAX_ROLES} roles`;
  for (const key of keys) {
    if (!ROLE_ID.test(key)) return `${where} names "${key}", which is not a role id`;
    if (!valid(value[key])) return `${where}.${key} must be ${expected}`;
  }
  return null;
}

function entryProblem(entry: unknown, index: number, seen: Set<string>): string | null {
  const where = `spend entry ${index + 1}`;
  if (!isObject(entry)) return `${where} must be an object {id, label, monthlyAmount, from, to, kind}`;
  const entryExtra = unknownField(entry, ["id", "label", "monthlyAmount", "from", "to", "kind", "quantity", "roleId"], where);
  if (entryExtra) return entryExtra;
  if (typeof entry.id !== "string" || !ROLE_ID.test(entry.id)) return `${where}'s id must be lowercase letters, digits and dashes`;
  if (seen.has(entry.id)) return `spend entry id "${entry.id}" appears twice`;
  seen.add(entry.id);
  if (!isText(entry.label, 80)) return `${where} needs a label of at most 80 characters`;
  if (!isAmount(entry.monthlyAmount, MAX_MONTHLY)) return `${where}'s monthlyAmount must be a number from 0 to ${MAX_MONTHLY}`;
  if (typeof entry.from !== "string" || !MONTH.test(entry.from)) return `${where}'s from must be a month YYYY-MM`;
  if (entry.to !== null && (typeof entry.to !== "string" || !MONTH.test(entry.to))) return `${where}'s to must be a month YYYY-MM or null`;
  if (typeof entry.to === "string" && entry.to < entry.from) return `${where} ends (${entry.to}) before it starts (${entry.from})`;
  if (entry.kind !== undefined && !(SPEND_KINDS as readonly unknown[]).includes(entry.kind)) return `${where}'s kind must be one of ${SPEND_KINDS.join(", ")}`;
  if (entry.roleId !== undefined && entry.roleId !== null && (typeof entry.roleId !== "string" || !ROLE_ID.test(entry.roleId))) return `${where}'s roleId must name a role id, or be null for spend the team shares`;
  // null is a read's "no quantity" echoed back: the same as leaving it out.
  if (entry.quantity !== undefined && entry.quantity !== null) {
    if (entry.kind === "api") return `${where} is an API bill, which has no quantity`;
    if (typeof entry.quantity !== "number" || !Number.isInteger(entry.quantity) || entry.quantity < 0 || entry.quantity > MAX_QUANTITY) {
      return `${where}'s quantity must be a whole number from 0 to ${MAX_QUANTITY}`;
    }
  }
  return null;
}

function profileProblem(value: unknown, mode: ScenarioMode): string | null {
  const name = `the ${mode} profile`;
  if (!isObject(value)) return `an object {director, rates, entries, savedAt}`;
  const extra = unknownField(value, ["director", "rates", "entries", "assumed", "savedAt"], name);
  if (extra) return extra;
  const director = value.director;
  if (!isObject(director)) return "director must be an object {title, hourlyRate, hoursPerActiveDay}";
  const directorExtra = unknownField(director, ["title", "hourlyRate", "hoursPerActiveDay"], "the director");
  if (directorExtra) return directorExtra;
  if (!isText(director.title, 80)) return "director.title must be text of at most 80 characters";
  if (!isAmount(director.hourlyRate, MAX_RATE)) return `director.hourlyRate must be a number from 0 to ${MAX_RATE}`;
  if (!isAmount(director.hoursPerActiveDay, 24)) return "director.hoursPerActiveDay must be a number from 0 to 24";
  const rates = byRoleProblem(value.rates, "rates", (rate) => isAmount(rate, MAX_RATE), `a number from 0 to ${MAX_RATE}`);
  if (rates) return rates;
  if (!Array.isArray(value.entries) || value.entries.length > MAX_SPEND_ENTRIES) return `entries must be a list of at most ${MAX_SPEND_ENTRIES}`;
  const seen = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    const problem = entryProblem(entry, index, seen);
    if (problem) return problem;
  }
  return savedAtProblem(value);
}

/** Why `value` is not a valid `part`, or null. The registry's validator for these settings. */
export function costModelPartProblem(part: CostModelPart, value: unknown): string | null {
  switch (part) {
    case "roles":
      return rolesProblem(value);
    case "roleMapping":
      return roleMappingProblem(value);
    case "scenario":
      return scenarioProblem(value);
    case "solo":
    case "company":
      return profileProblem(value, part);
  }
}

// ------------------------------------------------------------------ pricing

/** The profile in use. */
export const activeProfile = (model: CostModel): ProfileValue => model[model.scenario.mode];

/** An entry's kind: `subscription` unless it says `api`. */
export const kindOf = (entry: AiSpendEntry): SpendKind => entry.kind ?? "subscription";

/** What one month of an entry costs: a subscription's price times how many are bought; an API bill as entered. */
export const monthlyCostOf = (entry: AiSpendEntry): number => (kindOf(entry) === "subscription" ? entry.monthlyAmount * (entry.quantity ?? 1) : entry.monthlyAmount);

const inForce = (entry: AiSpendEntry, month: string): boolean => month >= entry.from && (entry.to === null || month <= entry.to);

/**
 * The AI spend that falls inside `days` (calendar days): each day costs its month's cost
 * divided by the days in that month, summed over every entry in force that month. Proration by
 * day is what makes a two-week period cost half a month.
 */
export function aiSpendFor(entries: readonly AiSpendEntry[], days: readonly string[]): number {
  let total = 0;
  for (const day of days) {
    const month = day.slice(0, 7);
    const [year, monthNumber] = month.split("-").map(Number) as [number, number];
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    for (const entry of entries) if (inForce(entry, month)) total += monthlyCostOf(entry) / daysInMonth;
  }
  return total;
}

/** True when some entry that costs anything is in force on at least one of `days`. */
export function spendCovers(entries: readonly AiSpendEntry[], days: readonly string[]): boolean {
  const months = new Set(days.map((day) => day.slice(0, 7)));
  return entries.some((entry) => monthlyCostOf(entry) > 0 && [...months].some((month) => inForce(entry, month)));
}

/** A role as the active profile prices it. */
export interface PricedRole extends Role {
  readonly hourlyRate: number;
}

/** One spend line on a role's row (or the shared row): the entry, and what it cost in the period for this scope. */
export interface AiEntryCost {
  readonly id: string;
  readonly label: string;
  readonly kind: SpendKind;
  readonly monthlyAmount: number;
  /** Subscriptions: how many (default 1). API bills: null. */
  readonly quantity: number | null;
  readonly cost: number;
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
  readonly estimatedTickets: number | null;
  /**
   * True when the role did work in the scope and period: it has agent-hours or caught a
   * finished ticket. VP's ruling (2026-11-26): a role the team did not need does not cost
   * anything, so an absent role's entries cost 0 here.
   */
  readonly present: boolean;
  /**
   * The share of this role's entries this scope carries: 1 on the hub; on one workspace, the
   * role's agent-hours there over its agent-hours on the hub (its finished tickets when it has
   * no hours anywhere); 0 when absent.
   */
  readonly share: number;
  /** The sum of the spend entries assigned to this role, times `share`. Nothing is split between roles. */
  readonly aiCost: number;
  readonly aiEntries: readonly AiEntryCost[];
}

/** The ROI under one lens. Every input is echoed so a surface can print the formula. */
export interface RoiResult {
  readonly lens: "measured" | "planned";
  /** Hours a human team would have needed, under this lens. */
  readonly valueHours: number;
  /** valueHours priced at each role's rate: what the equivalent team would have cost. */
  readonly value: number;
  readonly byRole: readonly RoleValue[];
  /** Every spend entry's cost: the roles' plus the shared. */
  readonly aiCost: number;
  /** The entries assigned to no role (or to a role no longer in the list). */
  readonly sharedAiCost: number;
  readonly sharedAiEntries: readonly AiEntryCost[];
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
 * The role each agent type and each role-naming rule is priced at, with the active profile's
 * rate. Either can name a role that is not in the list: the list and the mapping are separate
 * settings and sync separately, so a role deleted on one device can still be named by a mapping
 * saved on another. That one is priced at the first role and reported, never dropped (dropping
 * it would silently undercount the value).
 */
export function resolveRoles(model: CostModel): {
  roleOf: (type: AgentType) => PricedRole;
  role: (id: string) => PricedRole;
  has: (id: string) => boolean;
  fallbacks: MappingFallback[];
} {
  const profile = activeProfile(model);
  // Own keys only: a role id such as `constructor` must not find `Object.prototype`.
  const priced = (role: Role): PricedRole => ({ ...role, hourlyRate: Object.hasOwn(profile.rates, role.id) ? profile.rates[role.id]! : DEFAULT_ROLE_RATE });
  const roles = new Map(model.roles.roles.map((role) => [role.id, priced(role)]));
  const first = roles.get(model.roles.roles[0]!.id)!;
  const fallbacks: MappingFallback[] = [];
  const resolved = new Map<AgentType, PricedRole>();
  for (const type of AGENT_TYPES) {
    const wanted = model.roleMapping.types[type];
    const role = roles.get(wanted);
    resolved.set(type, role ?? first);
    if (!role) fallbacks.push({ type, rule: null, missingRoleId: wanted, usedRoleId: first.id });
  }
  for (const [index, rule] of model.roleMapping.rules.entries()) {
    if (rule.roleId !== undefined && !roles.has(rule.roleId)) fallbacks.push({ type: null, rule: index, missingRoleId: rule.roleId, usedRoleId: first.id });
  }
  return { roleOf: (type) => resolved.get(type)!, role: (id) => roles.get(id) ?? first, has: (id) => roles.has(id), fallbacks };
}

/** What one role collected under one lens, before pricing. Keyed by the role id it was priced to. */
export interface RoleTally {
  readonly hours: number;
  readonly types: ReadonlySet<AgentType>;
  readonly tickets: number;
  readonly estimatedTickets: number | null;
}

/** An entry's line for this scope and period: `cost` is its prorated cost already times the scope's share. */
export function entryCost(entry: AiSpendEntry, cost: number): AiEntryCost {
  const kind = kindOf(entry);
  return { id: entry.id, label: entry.label, kind, monthlyAmount: entry.monthlyAmount, quantity: kind === "subscription" ? (entry.quantity ?? 1) : null, cost };
}

export function roi(input: {
  readonly lens: "measured" | "planned";
  /** Hours by role id. A role id the list does not hold is priced at the first role (see `resolveRoles`). */
  readonly byRole: ReadonlyMap<string, RoleTally>;
  /** Every spend entry of the profile in use with its cost over the period, before any share. */
  readonly aiEntries: ReadonlyArray<{ readonly entry: AiSpendEntry; readonly cost: number }>;
  /** The roles present in the scope, by (resolved) role id, each with the share of its own entries the scope carries. */
  readonly roleShares: ReadonlyMap<string, number>;
  /** The share of the team's shared entries (and of the director's time) the scope carries. */
  readonly sharedShare: number;
  readonly directorHours: number;
  readonly model: CostModel;
}): RoiResult {
  const roles = resolveRoles(input.model);
  type Held = { role: PricedRole; hours: number; types: Set<AgentType>; tickets: number; estimatedTickets: number | null; aiEntries: AiEntryCost[] };
  const merged = new Map<string, Held>();
  const hold = (id: string): Held => {
    const role = roles.role(id);
    let held = merged.get(role.id);
    if (!held) {
      held = { role, hours: 0, types: new Set<AgentType>(), tickets: 0, estimatedTickets: input.lens === "planned" ? 0 : null, aiEntries: [] };
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
    if (held.estimatedTickets !== null) held.estimatedTickets += tally.estimatedTickets ?? 0;
  }
  // Each entry lands whole on the role it names, at that role's share (0 for a role that did no
  // work here, which still gets a row so its lines can be shown), or on the shared row.
  const sharedAiEntries: AiEntryCost[] = [];
  const shareOf = (id: string): number => input.roleShares.get(id) ?? 0;
  for (const { entry, cost } of input.aiEntries) {
    if (typeof entry.roleId === "string" && roles.has(entry.roleId)) hold(entry.roleId).aiEntries.push(entryCost(entry, cost * shareOf(entry.roleId)));
    else sharedAiEntries.push(entryCost(entry, cost * input.sharedShare));
  }
  const sum = (lines: readonly AiEntryCost[]): number => lines.reduce((total, line) => total + line.cost, 0);
  const byRole: RoleValue[] = [...merged.values()]
    .map(({ role, hours, types, tickets, estimatedTickets, aiEntries }) => ({
      roleId: role.id,
      title: role.title,
      hourlyRate: role.hourlyRate,
      hours,
      value: hours * role.hourlyRate,
      types: AGENT_TYPES.filter((type) => types.has(type)),
      tickets,
      estimatedTickets,
      present: input.roleShares.has(role.id),
      share: shareOf(role.id),
      aiCost: sum(aiEntries),
      aiEntries,
    }))
    .sort((a, b) => b.value - a.value || b.hours - a.hours || a.roleId.localeCompare(b.roleId));
  const valueHours = byRole.reduce((total, role) => total + role.hours, 0);
  const value = byRole.reduce((total, role) => total + role.value, 0);
  const sharedAiCost = sum(sharedAiEntries);
  const aiCost = byRole.reduce((total, role) => total + role.aiCost, 0) + sharedAiCost;
  const rate = activeProfile(input.model).director.hourlyRate;
  const directorCost = input.directorHours * rate;
  const totalCost = aiCost + directorCost;
  return {
    lens: input.lens,
    valueHours,
    value,
    byRole,
    aiCost,
    sharedAiCost,
    sharedAiEntries,
    director: { hours: input.directorHours, hourlyRate: rate, cost: directorCost },
    totalCost,
    net: value - totalCost,
    returnOnTotalCost: totalCost > 0 ? value / totalCost : null,
    returnOnAiSpend: aiCost > 0 ? value / aiCost : null,
    breakEvenRate: valueHours > 0 ? totalCost / valueHours : null,
    outputMultiplier: input.directorHours > 0 ? valueHours / input.directorHours : null,
  };
}
