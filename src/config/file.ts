/**
 * `<home>/config.json` — versioned, durable machine preferences.
 *
 * STA-24 plan §2: "`config.json` has a schema version and stores only durable
 * preferences such as browser behavior, preferred port, setup completion, and
 * connector receipts." And: "Do not store per-project state in machine config."
 *
 * Two properties are worth more than the rest:
 *
 *  - **Unknown fields survive.** A newer staple writes a key this binary has
 *    never heard of; this binary hands it back untouched on the next write.
 *    Without that, downgrading once silently deletes the user's settings.
 *  - **An unreadable config is refused, not replaced.** Falling back to defaults
 *    on a parse failure reads as robustness and behaves as data loss: the very
 *    next write would overwrite the file we could not understand, taking the
 *    connector receipts with it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StapleError } from "../core/types.js";
import {
  BROWSER_PREFERENCES,
  settingDefinitionsFor,
  validateSettingValue,
  type BrowserPreference,
  type SettingDefinition,
} from "../core/settings-registry.js";
import { writeFileAtomic } from "./atomic.js";

export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_FILENAME = "config.json";

/**
 * The browser preference's closed set lives on its registry definition
 * (`machine.browser`, R6a); re-exported so `config/index.ts` callers keep one import.
 */
export { BROWSER_PREFERENCES, type BrowserPreference };

/** What a connector (A8/B1-B4) records so it can be diagnosed and safely removed. */
export type ConnectorReceipt = Record<string, unknown>;

export interface StapleConfig {
  schemaVersion: number;
  browser: BrowserPreference;
  port: number;
  setupComplete: boolean;
  connectors: Record<string, ConnectorReceipt>;
}

/**
 * THE GLOBAL SETTINGS, as the registry defines them (R6a, STA-176). Each one
 * names the top-level `config.json` field it is stored under; this file owns no
 * key list, default or value check of its own — adding a machine preference is a
 * registry entry plus a field on `StapleConfig`, and nothing here changes.
 */
const GLOBAL_SETTINGS: ReadonlyArray<SettingDefinition & { configKey: string }> = settingDefinitionsFor(
  "global",
).map((definition) => {
  // `assertSettingRegistryConsistent` already refused a global without one.
  if (!definition.configKey) throw new Error(`global setting "${definition.key}" has no configKey`);
  return { ...definition, configKey: definition.configKey };
});

/** Keys a caller may report a source for. `schemaVersion` is not a preference. */
export const SETTING_KEYS = GLOBAL_SETTINGS.map((definition) => definition.configKey) as unknown as readonly [
  "browser",
  "port",
  "setupComplete",
];
export type SettingKey = (typeof SETTING_KEYS)[number];

const KNOWN_KEYS = new Set(["schemaVersion", "connectors", ...SETTING_KEYS]);

/** The plan's Quick setup defaults table — each default read off its registry definition. */
export const DEFAULT_CONFIG: StapleConfig = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  ...Object.fromEntries(GLOBAL_SETTINGS.map((definition) => [definition.configKey, definition.default])),
  connectors: {},
} as StapleConfig);

export interface LoadedConfig {
  config: StapleConfig;
  /** false when no config.json exists — `config` then holds the defaults. */
  present: boolean;
  path: string;
  /** Keys the file actually carried, so `config show` can say `config` vs `default`. */
  explicitKeys: string[];
  /** Keys this binary does not understand, preserved verbatim on the next write. */
  unknownKeys: string[];
  unknown: Record<string, unknown>;
}

export function configPath(home: string): string {
  return join(home, CONFIG_FILENAME);
}

function freshDefaults(): StapleConfig {
  return { ...DEFAULT_CONFIG, connectors: {} };
}

function assertConnectors(value: unknown, where: string): Record<string, ConnectorReceipt> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StapleError("validation", `${where}: "connectors" must be a JSON object`);
  }
  return value as Record<string, ConnectorReceipt>;
}

/** Read `<home>/config.json`. Absence is not an error; unreadability is. */
export function readConfig(home: string): LoadedConfig {
  const path = configPath(home);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        config: freshDefaults(),
        present: false,
        path,
        explicitKeys: [],
        unknownKeys: [],
        unknown: {},
      };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StapleError(
      "validation",
      `${path} is not valid JSON. Fix it, or delete it to fall back to the defaults.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StapleError("validation", `${path} must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const version = record.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new StapleError(
      "validation",
      `${path}: "schemaVersion" must be a positive integer, got ${JSON.stringify(version)}`,
    );
  }
  if (version > CONFIG_SCHEMA_VERSION) {
    throw new StapleError(
      "validation",
      `${path}: "schemaVersion" ${version} was written by a newer staple (this one understands ${CONFIG_SCHEMA_VERSION}). Upgrade staple rather than letting it rewrite the file.`,
    );
  }

  const config = freshDefaults();
  const explicitKeys: string[] = [];
  // Validated at the READ boundary, through the registry: a field this binary
  // owns but cannot interpret is refused here, before anything could rewrite it.
  for (const definition of GLOBAL_SETTINGS) {
    const raw = record[definition.configKey];
    if (raw === undefined) continue;
    (config as unknown as Record<string, unknown>)[definition.configKey] = validateSettingValue(
      definition,
      raw,
      path,
      definition.configKey,
    );
    explicitKeys.push(definition.configKey);
  }
  if (record.connectors !== undefined) {
    config.connectors = assertConnectors(record.connectors, path);
    explicitKeys.push("connectors");
  }

  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!KNOWN_KEYS.has(key)) unknown[key] = value;
  }

  return {
    config,
    present: true,
    path,
    explicitKeys,
    unknownKeys: Object.keys(unknown),
    unknown,
  };
}

export interface ConfigPatch {
  browser?: BrowserPreference;
  port?: number;
  setupComplete?: boolean;
  /** Merged key-by-key into the existing receipts rather than replacing them. */
  connectors?: Record<string, ConnectorReceipt>;
}

/**
 * Read, merge, and atomically rewrite. Two deliberate properties:
 *
 *  - **Reads first.** A corrupt config raises here, BEFORE anything is written,
 *    so a bad file is never overwritten by a well-meaning `config set`.
 *  - **Writes sparsely.** Only keys the user has actually chosen are persisted.
 *    Materializing every default into the file would freeze today's defaults
 *    into every machine that ever ran `config set` once, so a later change to a
 *    default could never reach them — and `config show` could no longer tell a
 *    chosen value from an inherited one.
 */
export function updateConfig(home: string, patch: ConfigPatch): StapleConfig {
  const loaded = readConfig(home);
  const where = loaded.path;
  const next: StapleConfig = { ...loaded.config, connectors: { ...loaded.config.connectors } };
  const chosen = new Set(loaded.explicitKeys);

  // The WRITE boundary, through the same registry check the read used.
  for (const definition of GLOBAL_SETTINGS) {
    const raw = (patch as Record<string, unknown>)[definition.configKey];
    if (raw === undefined) continue;
    (next as unknown as Record<string, unknown>)[definition.configKey] = validateSettingValue(
      definition,
      raw,
      where,
      definition.configKey,
    );
    chosen.add(definition.configKey);
  }
  if (patch.connectors !== undefined) {
    next.connectors = { ...next.connectors, ...assertConnectors(patch.connectors, where) };
    chosen.add("connectors");
  }
  next.schemaVersion = CONFIG_SCHEMA_VERSION;

  // Unknown keys first so a future field cannot shadow one this binary owns.
  const body: Record<string, unknown> = { ...loaded.unknown, schemaVersion: CONFIG_SCHEMA_VERSION };
  for (const key of [...SETTING_KEYS, "connectors"] as const) {
    if (chosen.has(key)) body[key] = next[key];
  }
  writeFileAtomic(where, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
  return next;
}
