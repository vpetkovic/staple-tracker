/**
 * Machine configuration: where the Staple home is, and what durable preferences
 * live in it. STA-24 plan §2 is the specification; A3 (STA-33) is this module.
 *
 * Everything that used to compute `~/.staple` by hand — `core/workspace.ts`,
 * `core/hub.ts`, `cli.ts` — imports `stapleHome()` from here instead.
 */
export { writeFileAtomic, type AtomicWriteOptions } from "./atomic.js";
export {
  BROWSER_PREFERENCES,
  CONFIG_FILENAME,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  SETTING_KEYS,
  configPath,
  readConfig,
  updateConfig,
  type BrowserPreference,
  type ConfigPatch,
  type ConnectorReceipt,
  type LoadedConfig,
  type SettingKey,
  type StapleConfig,
} from "./file.js";
export {
  HOME_DIRNAME,
  clearHomeOverride,
  defaultHome,
  homeOverride,
  resolveHome,
  setHomeOverride,
  stapleHome,
  type HomeSource,
  type ResolvedHome,
} from "./home.js";
export {
  LOCATOR_SCHEMA_VERSION,
  assertUsableHome,
  bootstrapLocatorPath,
  readBootstrapLocator,
  writeBootstrapLocator,
  type BootstrapLocator,
  type LocatorContext,
} from "./locator.js";
export {
  effectiveConfig,
  type EffectiveConfig,
  type SettingSource,
  type SettingView,
} from "./effective.js";
export { homeHasData, moveHome, type HomeMoveResult } from "./move.js";
