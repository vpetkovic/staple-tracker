/**
 * THE SETTINGS REGISTRY — R6a (STA-176).
 *
 * One canonical typed definition per setting, in one module, with no database
 * and no filesystem behind it. Every surface that reads or writes a setting —
 * the store (workspace scope), `config/file.ts` (global scope), `/api/settings`,
 * the CLI's `config set` — asks this module what the setting IS and validates
 * through it. Nothing else may carry a second copy of a default, a value shape,
 * or a key name.
 *
 * ## Scope is on the definition, and it is physical
 *
 * A `workspace` setting lives in the workspace database (`meta` rows keyed
 * `setting:<key>`, one versioned JSON envelope each). A `global` setting lives in
 * `<home>/config.json`, under the field its definition names in `configKey`.
 * The two never share a store: a workspace value cannot leak into a machine
 * preference by being written on the wrong surface, because the store refuses a
 * global key and the config file refuses a workspace one.
 *
 * ## Versioning is per setting, not per file
 *
 * Each definition carries `version`, and each persisted workspace value records
 * the version it was written at. Reading an OLDER value runs the definition's
 * `migrate` hook (deterministic: same input, same output, no clock, no I/O) or
 * falls back to the default when there is none; reading a NEWER value is refused
 * with a sentence naming the key, the same posture `config.json` takes for a
 * newer `schemaVersion`. A value is therefore never silently reinterpreted.
 *
 * ## Unknown keys survive
 *
 * A reader only touches the keys it has definitions for. A `setting:*` row
 * written by a newer staple is reported (`unknownKeys`) and left byte-for-byte
 * alone; `config.json` already preserves its own unknown fields. Downgrading a
 * binary must never truncate configuration.
 *
 * ## What is deliberately NOT here
 *
 * No queue policy. R2a is still specifying advisory/strict pickup enforcement
 * and R6d owns registering it once that contract exists — a definition whose
 * `strict` did nothing would be a lie with a select box. The registry ships with
 * the three machine preferences that already existed and ONE workspace field
 * setting with real behaviour today (`kinds.default`), which is enough to prove
 * the store -> HTTP -> UI path end to end without inventing a feature.
 */
import { StapleError, VOCABULARY_ID_PATTERN, DEFAULT_ISSUE_KIND } from "./types.js";
import { kindAppearanceMapProblem, type KindAppearanceMap } from "./kind-appearance.js";

export type SettingScope = "workspace" | "global";

/** Where a setting's effective value came from. `default` means nothing is stored. */
export type SettingValueSource = "default" | "workspace" | "config";

/**
 * `sensitive` values never leave the process on a read surface: the wire view
 * carries `redacted: true` and no `value`. Nothing registered today is
 * sensitive; the flag exists so a future connector token has a place to declare
 * itself before the first surface that would have printed it.
 */
export type SettingSensitivity = "normal" | "sensitive";

/**
 * The closed set of value shapes. A new shape is a new arm here, not a `unknown`.
 * `kindAppearance` (R5a, STA-181) is a map of kind id to appearance record,
 * validated by `core/kind-appearance.ts` — the one structured value so far.
 */
export type SettingSchema =
  | { type: "boolean" }
  | { type: "integer"; min?: number; max?: number }
  | { type: "string"; pattern?: RegExp; patternHint?: string }
  | { type: "enum"; values: readonly string[] }
  | { type: "kindAppearance" };

/** How the shell renders the setting. Metadata only — the shell decides the widget. */
export type SettingControl = "toggle" | "number" | "text" | "select" | "glyph";

export interface SettingUiMetadata {
  label: string;
  description: string;
  control: SettingControl;
  /** Position inside its category; ties break on key. */
  order: number;
}

/**
 * Which editor a category needs. `fields` categories are driven entirely by
 * their definitions; the two vocabulary editors are bespoke and pre-date the
 * registry, and the registry lists them so the shell can enumerate every
 * category from one place rather than hard-coding the tabs.
 */
export type SettingCategoryEditor = "fields" | "statuses" | "kinds";

export interface SettingCategory {
  id: string;
  label: string;
  description: string;
  scope: SettingScope;
  editor: SettingCategoryEditor;
  /** Navigation order in the shell. */
  order: number;
}

export interface SettingDefinition<T = unknown> {
  /** Namespaced `category.name`. Stable forever: it is the persistence key. */
  key: string;
  category: string;
  scope: SettingScope;
  schema: SettingSchema;
  default: T;
  /** Bump when the persisted value's MEANING changes; pair with `migrate`. */
  version: number;
  /**
   * Deterministic upgrade of a value persisted at `fromVersion` (< `version`).
   * Absent means "older values are not interpretable: use the default".
   */
  migrate?: (stored: unknown, fromVersion: number) => unknown;
  sensitivity: SettingSensitivity;
  ui: SettingUiMetadata;
  /** Global scope only: the top-level `config.json` field this setting is stored under. */
  configKey?: string;
}

// ---------------------------------------------------------------- the registry

export const SETTING_CATEGORIES: readonly SettingCategory[] = [
  {
    id: "statuses",
    label: "Statuses",
    description: "The status vocabulary and the category each status inherits its behaviour from.",
    scope: "workspace",
    editor: "statuses",
    order: 10,
  },
  {
    id: "kinds",
    label: "Kinds",
    description: "What a ticket can be, and which kind a new ticket gets by default.",
    scope: "workspace",
    editor: "kinds",
    order: 20,
  },
  {
    id: "machine",
    label: "This machine",
    description: "Preferences for staple on this computer. Stored in the home's config.json, not in any workspace.",
    scope: "global",
    editor: "fields",
    order: 90,
  },
];

export const BROWSER_PREFERENCES = ["auto", "always", "never"] as const;
export type BrowserPreference = (typeof BROWSER_PREFERENCES)[number];

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: "kinds.default",
    category: "kinds",
    scope: "workspace",
    schema: {
      type: "string",
      pattern: VOCABULARY_ID_PATTERN,
      patternHint: "a kind id: lowercase letters, digits and underscores, starting with a letter",
    },
    default: DEFAULT_ISSUE_KIND,
    version: 1,
    sensitivity: "normal",
    ui: {
      label: "Default kind",
      description:
        "The kind a ticket gets when none is given. Must name a configured kind; removing that kind resets this.",
      control: "select",
      order: 10,
    },
  },
  {
    key: "kinds.appearance",
    category: "kinds",
    scope: "workspace",
    schema: { type: "kindAppearance" },
    default: Object.freeze({}) as KindAppearanceMap,
    version: 1,
    sensitivity: "normal",
    ui: {
      label: "Kind glyphs",
      description:
        "The icon each kind wears, its accessible label, and the character the terminal prints instead. A kind with no entry uses staple's built-in mark.",
      control: "glyph",
      order: 20,
    },
  },
  {
    key: "machine.browser",
    category: "machine",
    scope: "global",
    schema: { type: "enum", values: BROWSER_PREFERENCES },
    default: "auto",
    version: 1,
    sensitivity: "normal",
    ui: {
      label: "Open the browser",
      description: "Whether `staple open` launches a browser: auto, always, or never.",
      control: "select",
      order: 10,
    },
    configKey: "browser",
  },
  {
    key: "machine.port",
    category: "machine",
    scope: "global",
    schema: { type: "integer", min: 1, max: 65_535 },
    default: 4400,
    version: 1,
    sensitivity: "normal",
    ui: {
      label: "Preferred port",
      description: "The port the local UI server asks for first.",
      control: "number",
      order: 20,
    },
    configKey: "port",
  },
  {
    key: "machine.setupComplete",
    category: "machine",
    scope: "global",
    schema: { type: "boolean" },
    default: false,
    version: 1,
    sensitivity: "normal",
    ui: {
      label: "Setup complete",
      description: "Set once the first-run setup has finished; clears the setup prompt.",
      control: "toggle",
      order: 30,
    },
    configKey: "setupComplete",
  },
];

/** Meta-row key prefix for workspace values. Stable: it is on disk. */
export const WORKSPACE_SETTING_META_PREFIX = "setting:";

export function settingMetaKey(key: string): string {
  return `${WORKSPACE_SETTING_META_PREFIX}${key}`;
}

/** The setting key inside a `setting:*` meta row, or null for any other row. */
export function settingKeyFromMetaKey(metaKey: string): string | null {
  return metaKey.startsWith(WORKSPACE_SETTING_META_PREFIX)
    ? metaKey.slice(WORKSPACE_SETTING_META_PREFIX.length)
    : null;
}

// ---------------------------------------------------------------- lookups

const byKey = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));
const categoryById = new Map(SETTING_CATEGORIES.map((category) => [category.id, category]));

export function settingDefinition(key: string): SettingDefinition | undefined {
  return byKey.get(key);
}

/** The definition, or a validation refusal naming every key in the requested scope. */
export function requireSettingDefinition(key: string, scope?: SettingScope): SettingDefinition {
  const definition = byKey.get(key);
  if (definition && (scope === undefined || definition.scope === scope)) return definition;
  const known = settingDefinitionsFor(scope).map((d) => d.key);
  const which = scope === undefined ? "setting" : `${scope} setting`;
  throw new StapleError(
    "validation",
    definition
      ? `"${key}" is a ${definition.scope} setting, not a ${scope} one. ${scopeHint(definition.scope)}`
      : `Unknown ${which} "${key}". Known: ${known.join(", ")}`,
  );
}

function scopeHint(scope: SettingScope): string {
  return scope === "global"
    ? "Global settings are edited with `staple config set`."
    : "Workspace settings are edited through the workspace, not `staple config`.";
}

export function settingDefinitionsFor(scope?: SettingScope): SettingDefinition[] {
  return SETTING_DEFINITIONS.filter((d) => scope === undefined || d.scope === scope);
}

export function settingCategoriesFor(scope?: SettingScope): SettingCategory[] {
  return SETTING_CATEGORIES.filter((c) => scope === undefined || c.scope === scope);
}

export function settingCategory(id: string): SettingCategory | undefined {
  return categoryById.get(id);
}

// ---------------------------------------------------------------- validation

/**
 * Validate a candidate value against a definition's schema. THE write-and-read
 * boundary check: the store, the config file and the CLI all refuse through
 * here, so the sentence for "port must be an integer between 1 and 65535" exists
 * once. `where` names the file or workspace so the sentence says where to look;
 * `field` is what the caller calls the setting (the config.json field for a
 * global, the key otherwise).
 */
export function validateSettingValue<T>(
  definition: SettingDefinition<T>,
  value: unknown,
  where: string,
  field: string = definition.key,
): T {
  const schema = definition.schema;
  const refuse = (expected: string): never => {
    throw new StapleError("validation", `${where}: "${field}" must be ${expected}, got ${JSON.stringify(value)}`);
  };
  switch (schema.type) {
    case "boolean":
      if (typeof value !== "boolean") refuse("true or false");
      return value as T;
    case "integer": {
      const min = schema.min ?? Number.MIN_SAFE_INTEGER;
      const max = schema.max ?? Number.MAX_SAFE_INTEGER;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        refuse(`an integer between ${min} and ${max}`);
      }
      return value as T;
    }
    case "string":
      if (typeof value !== "string" || (schema.pattern && !schema.pattern.test(value))) {
        refuse(schema.patternHint ?? "a string");
      }
      return value as T;
    case "enum":
      if (typeof value !== "string" || !schema.values.includes(value)) {
        refuse(`one of ${schema.values.join(", ")}`);
      }
      return value as T;
    case "kindAppearance": {
      const problem = kindAppearanceMapProblem(value);
      if (problem) refuse(problem);
      return value as T;
    }
    default:
      throw new StapleError("validation", `Unknown setting schema for "${definition.key}"`);
  }
}

/**
 * Turn a command-line word into the typed value the schema expects, then
 * validate it. Booleans accept the same spellings `config set setupComplete`
 * always did; an integer that does not parse is refused by name rather than
 * arriving as NaN.
 */
export function coerceSettingInput<T>(definition: SettingDefinition<T>, raw: string, where: string): T {
  const schema = definition.schema;
  const field = definition.configKey ?? definition.key;
  let candidate: unknown = raw;
  if (schema.type === "boolean") {
    const truthy = ["true", "yes", "1", "on"];
    const falsy = ["false", "no", "0", "off"];
    if (truthy.includes(raw)) candidate = true;
    else if (falsy.includes(raw)) candidate = false;
  } else if (schema.type === "integer") {
    candidate = Number(raw);
    if (!Number.isInteger(candidate)) {
      throw new StapleError("validation", `${field} must be an integer, got "${raw}"`);
    }
  }
  return validateSettingValue(definition, candidate, where, field);
}

// ---------------------------------------------------------------- persistence envelope

/** What a workspace value looks like on disk: the version it was written at, and the value. */
export interface StoredSetting {
  v: number;
  value: unknown;
}

export function encodeStoredSetting<T>(definition: SettingDefinition<T>, value: T): string {
  const envelope: StoredSetting = { v: definition.version, value };
  return JSON.stringify(envelope);
}

/**
 * Decode and validate one persisted workspace value. The READ boundary.
 *
 *  - malformed envelope -> refused, naming the key: the row was written through
 *    `encodeStoredSetting` or by hand, and a hand-edit deserves a sentence, not
 *    a silent default;
 *  - `v` newer than this binary -> refused, so an old build never reinterprets a
 *    value it cannot understand (and never overwrites it, since it cannot read it);
 *  - `v` older -> the definition's `migrate` hook, or the default without one;
 *    the migrated value is validated like any other.
 */
export function readStoredSetting<T>(
  definition: SettingDefinition<T>,
  text: string,
  where: string,
): { value: T; version: number; migrated: boolean } {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new StapleError("validation", `${where}: stored value for "${definition.key}" is not valid JSON`);
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new StapleError("validation", `${where}: stored value for "${definition.key}" is not a {v, value} envelope`);
  }
  const { v, value } = envelope as Partial<StoredSetting>;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new StapleError("validation", `${where}: stored value for "${definition.key}" has no valid version`);
  }
  if (v > definition.version) {
    throw new StapleError(
      "validation",
      `${where}: "${definition.key}" was written by a newer staple (version ${v}; this one understands ${definition.version}). Upgrade staple rather than letting it rewrite the value.`,
    );
  }
  if (v < definition.version) {
    const upgraded = definition.migrate ? definition.migrate(value, v) : definition.default;
    return { value: validateSettingValue(definition, upgraded, where), version: v, migrated: true };
  }
  return { value: validateSettingValue(definition, value, where), version: v, migrated: false };
}

// ---------------------------------------------------------------- wire views

/** A definition as served over HTTP: everything the shell renders from, minus the code. */
export interface SettingDefinitionView {
  key: string;
  category: string;
  scope: SettingScope;
  schema: SettingSchemaView;
  default: unknown;
  version: number;
  sensitivity: SettingSensitivity;
  ui: SettingUiMetadata;
}

/** `SettingSchema` with the RegExp turned into its source, so it survives JSON. */
export type SettingSchemaView =
  | { type: "boolean" }
  | { type: "integer"; min?: number; max?: number }
  | { type: "string"; pattern?: string; patternHint?: string }
  | { type: "enum"; values: string[] }
  | { type: "kindAppearance" };

export function settingDefinitionView(definition: SettingDefinition): SettingDefinitionView {
  const schema = definition.schema;
  const view: SettingSchemaView =
    schema.type === "string"
      ? {
          type: "string",
          ...(schema.pattern ? { pattern: schema.pattern.source } : {}),
          ...(schema.patternHint ? { patternHint: schema.patternHint } : {}),
        }
      : schema.type === "enum"
        ? { type: "enum", values: [...schema.values] }
        : schema.type === "integer"
          ? { type: "integer", ...(schema.min !== undefined ? { min: schema.min } : {}), ...(schema.max !== undefined ? { max: schema.max } : {}) }
          : schema.type === "kindAppearance"
            ? { type: "kindAppearance" }
            : { type: "boolean" };
  return {
    key: definition.key,
    category: definition.category,
    scope: definition.scope,
    schema: view,
    default: definition.sensitivity === "sensitive" ? null : definition.default,
    version: definition.version,
    sensitivity: definition.sensitivity,
    ui: { ...definition.ui },
  };
}

/** One effective value with its provenance, as every read surface reports it. */
export interface SettingValueView {
  key: string;
  scope: SettingScope;
  /** Absent when `redacted`. */
  value?: unknown;
  source: SettingValueSource;
  version: number;
  redacted?: true;
}

export function settingValueView(
  definition: SettingDefinition,
  value: unknown,
  source: SettingValueSource,
): SettingValueView {
  const base = { key: definition.key, scope: definition.scope, source, version: definition.version };
  return definition.sensitivity === "sensitive" ? { ...base, redacted: true } : { ...base, value };
}

/** The registry as served: categories and definitions, in shell order. */
export function settingRegistryView(): { categories: SettingCategory[]; definitions: SettingDefinitionView[] } {
  return {
    categories: [...SETTING_CATEGORIES].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    definitions: [...SETTING_DEFINITIONS]
      .sort((a, b) => a.ui.order - b.ui.order || a.key.localeCompare(b.key))
      .map(settingDefinitionView),
  };
}

// ---------------------------------------------------------------- self-check

/**
 * The registry's own invariants, checked once at load so a bad definition fails
 * the process at import rather than the first user who touches the setting:
 * keys are unique and namespaced by an existing category, scope agrees with the
 * category, a global setting names its config field, and every default passes
 * its own schema.
 */
export function assertSettingRegistryConsistent(
  categories: readonly SettingCategory[] = SETTING_CATEGORIES,
  definitions: readonly SettingDefinition[] = SETTING_DEFINITIONS,
): void {
  const seen = new Set<string>();
  const known = new Map(categories.map((c) => [c.id, c]));
  for (const definition of definitions) {
    const { key } = definition;
    if (seen.has(key)) throw new Error(`settings registry: duplicate key "${key}"`);
    seen.add(key);
    const category = known.get(definition.category);
    if (!category) throw new Error(`settings registry: "${key}" names unknown category "${definition.category}"`);
    if (!key.startsWith(`${category.id}.`) || key.length === category.id.length + 1) {
      throw new Error(`settings registry: "${key}" must be namespaced as "${category.id}.<name>"`);
    }
    if (category.scope !== definition.scope) {
      throw new Error(`settings registry: "${key}" is ${definition.scope} but category "${category.id}" is ${category.scope}`);
    }
    if (definition.scope === "global" && !definition.configKey) {
      throw new Error(`settings registry: global setting "${key}" needs a configKey`);
    }
    if (definition.scope === "workspace" && definition.configKey) {
      throw new Error(`settings registry: workspace setting "${key}" must not carry a configKey`);
    }
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      throw new Error(`settings registry: "${key}" needs a positive integer version`);
    }
    validateSettingValue(definition, definition.default, "settings registry");
  }
}

assertSettingRegistryConsistent();
