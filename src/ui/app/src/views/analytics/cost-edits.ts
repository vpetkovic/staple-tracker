/**
 * Every change the person makes to the cost model, as the model it leaves on screen and the
 * one `CostModelWrite` that saves it (`POST /api/analytics/cost-model`).
 *
 * The model is five parts, each saved whole: `roles` and `roleMapping` are shared by both
 * profiles, `scenario` says which profile is in use, and `solo` and `company` are the two
 * profiles. An edit writes only the parts it changes. A part written without `assumed` would
 * read as fully confirmed, so every part carries its remaining `assumed` ids, less the figure
 * the person just set.
 *
 * Pure: the ids of new entries and roles are passed in, so a test can name the exact write.
 */
import type {
  AgentTypeId,
  AiSpendEntryValue,
  AiSpendEntryWrite,
  CostModelValue,
  CostModelWrite,
  CostProfileValue,
  CostProfileWrite,
  CostRole,
  CostTypeRule,
  ProfileId,
  SpendKind,
} from "@/lib/analytics-api";
import { activeProfile, catchAllRole, matchersOf, type RuleField } from "./return-model";

/** One edit: the model to show at once, the write that saves it, and the field a refusal belongs to. */
export interface CostEdit {
  next: CostModelValue;
  write: CostModelWrite;
  field: string;
}

/** A new entry covers every month (the dialog does not expose dates in this release). */
export const EVERY_MONTH = "2000-01";

const entryWrite = (entry: AiSpendEntryValue): AiSpendEntryWrite => ({
  id: entry.id,
  label: entry.label,
  kind: entry.kind,
  monthlyAmount: entry.monthlyAmount,
  ...(entry.kind === "subscription" ? { quantity: entry.quantity ?? 1 } : {}),
  roleId: entry.roleId,
  from: entry.from,
  to: entry.to,
});

export const profileWrite = (profile: CostProfileValue): CostProfileWrite => ({
  director: { ...profile.director },
  rates: { ...profile.rates },
  entries: profile.entries.map(entryWrite),
  assumed: [...profile.assumed],
});
const rolesWrite = (model: CostModelValue): NonNullable<CostModelWrite["roles"]> => ({ roles: model.roles.roles.map((role) => ({ id: role.id, title: role.title })), assumed: [...model.roles.assumed] });
const mappingWrite = (model: CostModelValue): NonNullable<CostModelWrite["roleMapping"]> => ({ types: { ...model.roleMapping.types }, rules: model.roleMapping.rules.map((rule) => ({ ...rule })), assumed: [...model.roleMapping.assumed] });

/** Change the profile in use; `settled` ids stop being assumptions. */
function inProfile(model: CostModelValue, field: string, change: (profile: CostProfileValue) => Partial<CostProfileValue>, ...settled: string[]): CostEdit {
  const mode = model.scenario.mode;
  const before = activeProfile(model);
  const profile: CostProfileValue = { ...before, ...change(before), assumed: before.assumed.filter((id) => !settled.includes(id)) };
  return { next: { ...model, [mode]: profile }, write: { [mode]: profileWrite(profile) }, field };
}

function withRoles(model: CostModelValue, roles: readonly CostRole[], field: string): CostEdit {
  const next = { ...model, roles: { ...model.roles, roles } };
  return { next, write: { roles: rolesWrite(next) }, field };
}

function withMapping(model: CostModelValue, mapping: Pick<CostModelValue["roleMapping"], "types" | "rules">, field: string): CostEdit {
  const next = { ...model, roleMapping: { ...model.roleMapping, ...mapping } };
  return { next, write: { roleMapping: mappingWrite(next) }, field };
}

/** A single-field rule that names a role: one chip on that role's page. */
export const isChip = (rule: CostTypeRule, roleId: string): boolean => rule.roleId === roleId && matchersOf(rule).length === 1;

/** An agent name as the person types it ("design") becomes a glob for names that contain it. */
export const agentGlob = (value: string): string => (value.includes("*") ? value : `*${value}*`);
/** The glob as a chip shows it: `*design*` reads "design", any other glob as written. */
export const agentWords = (glob: string): string => (/^\*[^*]+\*$/.test(glob) ? glob.slice(1, -1) : glob);
/** What a rule stores for what the person typed into one field. */
const storedValue = (field: RuleField, value: string): string => (field === "agent" ? agentGlob(value) : field === "workspace" ? value.toUpperCase() : value);

export const costEdits = {
  /** Switch profile. Nothing is copied: each payer keeps its own figures. */
  scenario: (model: CostModelValue, mode: ProfileId): CostEdit => {
    const scenario = { ...model.scenario, mode };
    return { next: { ...model, scenario }, write: { scenario: { mode, currency: scenario.currency, assumed: [...scenario.assumed] } }, field: "scenario" };
  },

  directorRate: (model: CostModelValue, hourlyRate: number): CostEdit =>
    inProfile(model, "director.hourlyRate", (profile) => ({ director: { ...profile.director, hourlyRate } }), "director.hourlyRate"),
  directorHours: (model: CostModelValue, hoursPerActiveDay: number): CostEdit =>
    inProfile(model, "director.hoursPerActiveDay", (profile) => ({ director: { ...profile.director, hoursPerActiveDay } }), "director.hoursPerActiveDay"),

  /** Change an entry's label, price or quantity. Only the price was ever assumed. */
  entry: (model: CostModelValue, id: string, patch: Partial<Pick<AiSpendEntryValue, "label" | "monthlyAmount" | "quantity">>): CostEdit => {
    const key = "monthlyAmount" in patch ? "monthlyAmount" : "quantity" in patch ? "quantity" : "label";
    return inProfile(
      model,
      `entries.${id}.${key}`,
      (profile) => ({ entries: profile.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) }),
      ...("monthlyAmount" in patch ? [`entries.${id}.monthlyAmount`] : []),
    );
  },
  /** A new entry for a role, or with null shared by the whole team. It covers every month. */
  entryAdd: (model: CostModelValue, roleId: string | null, kind: SpendKind, id: string): CostEdit => {
    const entry: AiSpendEntryValue = { id, label: kind === "api" ? "API bill" : "Subscription", kind, monthlyAmount: 0, quantity: kind === "api" ? null : 1, roleId, from: EVERY_MONTH, to: null };
    return inProfile(model, `entries.${id}`, (profile) => ({ entries: [...profile.entries, entry] }));
  },
  entryRemove: (model: CostModelValue, id: string): CostEdit =>
    inProfile(model, `entries.${id}`, (profile) => ({ entries: profile.entries.filter((entry) => entry.id !== id) }), `entries.${id}.monthlyAmount`),

  roleRate: (model: CostModelValue, roleId: string, rate: number): CostEdit =>
    inProfile(model, `roles.${roleId}.hourlyRate`, (profile) => ({ rates: { ...profile.rates, [roleId]: rate } }), `roles.${roleId}.hourlyRate`),

  // The role list and how roles are recognized are shared by both profiles: the work is the same whoever pays.
  roleTitle: (model: CostModelValue, roleId: string, title: string): CostEdit =>
    withRoles(model, model.roles.roles.map((role) => (role.id === roleId ? { ...role, title } : role)), `roles.${roleId}.title`),
  roleAdd: (model: CostModelValue, id: string): CostEdit => withRoles(model, [...model.roles.roles, { id, title: "New role" }], "roles"),
  /**
   * Remove a role, in one save: its agent types move to the role that holds `engineering`, and
   * the rules that named it go. The role holding `engineering` cannot be removed (the page
   * offers no control for it); asking returns null.
   */
  roleRemove: (model: CostModelValue, roleId: string): CostEdit | null => {
    const home = catchAllRole(model);
    if (roleId === home || !model.roles.roles.some((role) => role.id === roleId)) return null;
    const types = Object.fromEntries(Object.entries(model.roleMapping.types).map(([type, id]) => [type, id === roleId ? home : id])) as Record<AgentTypeId, string>;
    const rules = model.roleMapping.rules.filter((rule) => rule.roleId !== roleId);
    const roles = model.roles.roles.filter((role) => role.id !== roleId);
    const next: CostModelValue = { ...model, roles: { ...model.roles, roles }, roleMapping: { ...model.roleMapping, types, rules } };
    return { next, write: { roles: rolesWrite(next), roleMapping: mappingWrite(next) }, field: `roles.${roleId}` };
  },

  /** Give an agent type to a role. A type has exactly one role, so it leaves the one that had it. */
  typeTo: (model: CostModelValue, type: AgentTypeId, roleId: string): CostEdit =>
    withMapping(model, { types: { ...model.roleMapping.types, [type]: roleId }, rules: model.roleMapping.rules }, `types.${roleId}`),
  /**
   * Take an agent type off a role: it goes to the role that holds `engineering`. `engineering`
   * itself, and any type on that role, have nowhere else to go (null): they move by being
   * given to another role.
   */
  typeOff: (model: CostModelValue, type: AgentTypeId): CostEdit | null => {
    const home = catchAllRole(model);
    if (type === "engineering" || model.roleMapping.types[type] === home) return null;
    return withMapping(model, { types: { ...model.roleMapping.types, [type]: home }, rules: model.roleMapping.rules }, `types.${model.roleMapping.types[type]}`);
  },

  /** One chip on a role's page: a rule `{[field]: value, roleId}`, added after the others. Null when it is already there. */
  chipAdd: (model: CostModelValue, roleId: string, field: RuleField, value: string): CostEdit | null => {
    const stored = storedValue(field, value.trim());
    if (stored === "" || model.roleMapping.rules.some((rule) => isChip(rule, roleId) && rule[field] === stored)) return null;
    return withMapping(model, { types: model.roleMapping.types, rules: [...model.roleMapping.rules, { [field]: stored, roleId }] }, `rules.${roleId}.${field}`);
  },
  /** Remove a chip: the single-field rule naming the role with that value. */
  chipRemove: (model: CostModelValue, roleId: string, field: RuleField, stored: string): CostEdit =>
    withMapping(model, { types: model.roleMapping.types, rules: model.roleMapping.rules.filter((rule) => !(isChip(rule, roleId) && rule[field] === stored)) }, `rules.${roleId}.${field}`),
};

/**
 * The write as sent: with nothing saved yet, the first save goes to the suggested workspace
 * without a prompt (the server needs a home to save in).
 */
export function withHome(write: CostModelWrite, home: { slug: string | null; suggested: string | null }): CostModelWrite {
  return home.slug === null && write.home === undefined && home.suggested !== null ? { home: home.suggested, ...write } : write;
}

/** Return both profiles to their shipped figures. The roles, how they are recognized and the profile in use stay. */
export const resetProfiles = (): CostModelWrite => ({ reset: ["solo", "company"] });
/** Move the whole model to another workspace. */
export const moveHome = (slug: string): CostModelWrite => ({ home: slug });

/** A new id for an entry or a role, unique enough for one person's model. */
export const newId = (prefix: "entry" | "role"): string => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * The server's refusal, as the sentence a field shows. A part the store refuses comes back as
 * `<where>: "<setting>" must be <the problem>, got <the value>`: the problem is the sentence.
 */
export function refusalSentence(message: string): string {
  const inner = /"analytics\.[^"]+" must be (.+?), got [[{"\dnt]/s.exec(message);
  const sentence = (inner?.[1] ?? message).trim();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + (/[.!?]$/.test(sentence) ? "" : ".");
}
