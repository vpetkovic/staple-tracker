/**
 * The "effective settings and their source" view behind `staple config`.
 *
 * STA-24 plan command table, row `staple config`: "Show effective settings and
 * their source". A value without its provenance is the thing that makes
 * configuration bugs take an afternoon — the same `4400` means something very
 * different depending on whether it came from the file or the defaults.
 */
import type { ConnectorReceipt, SettingKey, StapleConfig } from "./file.js";
import { readConfig } from "./file.js";
import { type HomeSource, resolveHome } from "./home.js";
import { bootstrapLocatorPath, readBootstrapLocator } from "./locator.js";

export type SettingSource = "default" | "config";

export interface SettingView<T> {
  value: T;
  source: SettingSource;
}

export interface EffectiveConfig {
  home: { value: string; source: HomeSource };
  configPath: string;
  configPresent: boolean;
  locator: { path: string; present: boolean; home: string | null };
  settings: {
    browser: SettingView<StapleConfig["browser"]>;
    port: SettingView<number>;
    setupComplete: SettingView<boolean>;
  };
  connectors: Record<string, ConnectorReceipt>;
  /** Keys written by a newer staple that this binary preserves but cannot interpret. */
  unknownKeys: string[];
}

export function effectiveConfig(): EffectiveConfig {
  const home = resolveHome();
  const loaded = readConfig(home.path);
  const explicit = new Set(loaded.explicitKeys);
  const sourceOf = (key: SettingKey): SettingSource => (explicit.has(key) ? "config" : "default");

  const locatorPath = bootstrapLocatorPath();
  const locator = readBootstrapLocator(locatorPath);

  return {
    home: { value: home.path, source: home.source },
    configPath: loaded.path,
    configPresent: loaded.present,
    locator: { path: locatorPath, present: locator !== null, home: locator?.home ?? null },
    settings: {
      browser: { value: loaded.config.browser, source: sourceOf("browser") },
      port: { value: loaded.config.port, source: sourceOf("port") },
      setupComplete: { value: loaded.config.setupComplete, source: sourceOf("setupComplete") },
    },
    connectors: loaded.config.connectors,
    unknownKeys: loaded.unknownKeys,
  };
}
