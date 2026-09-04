/**
 * R6e/R6f — THE REGISTRY-ONLY FIXTURE: a category and a definition no build has
 * ever had, added through the registry's own public registration surface.
 *
 * It lives in its own module because registration is PROCESS-LOCAL. The registry
 * has no persistence behind it, so a definition registered in the vitest process
 * is invisible to the child processes test/settings-verification.test.ts drives —
 * the real CLI (`runCli`) and the real MCP server (`startMcpClient`). Importing
 * this module registers the fixture, which makes the same file serve twice: as
 * the suite's fixture, and as those children's `--import` preload. That is
 * exactly what an entry in `SETTING_DEFINITIONS` does for every process that
 * starts — the registration simply happens at import, everywhere.
 */
import {
  registerSettingCategory,
  registerSettingDefinition,
  type SettingCategory,
  type SettingDefinition,
} from "../../src/core/settings-registry.js";

export const FIXTURE_CATEGORY: SettingCategory = {
  id: "verification",
  label: "Verification",
  description: "Registered by test/settings-verification.test.ts and by nothing else.",
  scope: "workspace",
  editor: "fields",
  order: 40,
};

export const FIXTURE_DEFINITION: SettingDefinition = {
  key: "verification.enabled",
  category: "verification",
  scope: "workspace",
  schema: { type: "boolean" },
  default: false,
  version: 1,
  sensitivity: "normal",
  ui: {
    label: "Fixture switch",
    description: "Exists only while this suite runs. No shell file has ever heard of it.",
    control: "toggle",
    order: 10,
  },
};

/**
 * `NODE_OPTIONS` for a child process that must know the fixture: register tsx's
 * loader first, then import this module for its side effect below. `cleanEnv`
 * passes `NODE_OPTIONS` through, so the CLI and the MCP server both accept it.
 * Both are absolute URLs because node resolves a bare `--import` specifier
 * against the child's cwd, and the MCP server is started outside the repo;
 * tsx's loader entry is spelled out the same way `contract-support.ts` spells
 * out its CLI entry.
 */
const TSX_LOADER = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url);

export const REGISTER_FIXTURE_NODE_OPTIONS = `--import ${TSX_LOADER.href} --import ${import.meta.url}`;

registerSettingCategory(FIXTURE_CATEGORY);
registerSettingDefinition(FIXTURE_DEFINITION);
