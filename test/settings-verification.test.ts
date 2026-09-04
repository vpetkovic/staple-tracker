/**
 * R6e (STA-180) — THE TWO PROPERTIES THE SETTINGS SYSTEM CANNOT BE TESTED FOR
 * INSIDE ONE WORKSPACE.
 *
 * Everything R6a–R6d shipped is already covered by a green suite: the registry's
 * own invariants (test/settings-registry.test.ts), one workspace's values through
 * the store (test/store-settings.test.ts), one workspace through all four surfaces
 * (test/contract-settings-surfaces.test.ts), and the route's envelope
 * (test/ui-settings.test.ts). This file adds only what none of them can see,
 * because each of them holds exactly one workspace and never looks at config.json:
 *
 *  1. SCOPE IS PHYSICAL. `settings-registry.ts` opens with the claim that a
 *     workspace value and a machine preference "never share a store". That is a
 *     claim about three files at once — two workspace databases and one
 *     config.json — so it takes three to falsify it. A write in workspace A is
 *     asserted to leave workspace B and config.json byte-identical, on the store,
 *     over real HTTP and through the real CLI; a `staple config set` is asserted
 *     to leave both workspaces' values alone.
 *
 *  2. A SETTING IS ADDED BY REGISTERING IT. The registry's promise is that a new
 *     definition reaches the page without a client change. `fields-form.test.tsx`
 *     proves the render half with an invented definition in an existing category;
 *     this proves the whole path — a definition AND a category no build has ever
 *     had, appended in-process through the module's own consistency check, served
 *     by the REAL http server, and rendered by the REAL shell from that envelope.
 *
 * ── WHY THE UI MODULES ARE IMPORTED THROUGH VARIABLES ─────────────────────────
 *
 * The same reason test/contract-settings-surfaces.test.ts does it: `src/ui/app` is
 * a separate compilation (DOM lib, jsx) and the root tsconfig excludes it. A
 * static import here would drag React and the browser modules into the Node-side
 * `tsc` program. Vitest resolves the specifier at runtime, which is all this needs.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configPath } from "../src/config/index.js";
import {
  SETTING_DEFINITIONS,
  requireSettingDefinition,
  settingCategory,
  settingDefinition,
} from "../src/core/settings-registry.js";
import { openWorkspace } from "../src/core/open.js";
import type { WorkspaceStore } from "../src/core/store.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { runCli, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";
import {
  FIXTURE_CATEGORY,
  FIXTURE_DEFINITION,
  REGISTER_FIXTURE_NODE_OPTIONS,
} from "./fixtures/verification-setting.js";

const ALPHA = "verifyalpha";
const BETA = "verifybeta";
const POLICY = "queue.policy";
const KIND_DEFAULT = "kinds.default";

interface SettingView {
  key: string;
  scope: string;
  value?: unknown;
  source: string;
  version: number;
}

interface Envelope {
  workspace: string;
  registry: {
    categories: { id: string; label: string; description: string; scope: string; editor: string; order: number }[];
    definitions: {
      key: string;
      category: string;
      scope: string;
      schema: Record<string, unknown>;
      default: unknown;
      version: number;
      sensitivity: string;
      ui: { label: string; description: string; control: string; order: number };
    }[];
  };
  values: Record<string, SettingView>;
  unknownKeys: string[];
  global: { path: string; present: boolean; values: Record<string, SettingView> };
}

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let alpha: WorkspaceStore;
let beta: WorkspaceStore;
let mcp: McpHarness;

function cli(...args: string[]) {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: "r6e-verify" });
}

/**
 * The same real CLI, in a child process that has registered the registry-only
 * fixture — the child's equivalent of the `SETTING_DEFINITIONS` entry a shipped
 * setting would have. Opt-in, so every other call above still runs a stock CLI.
 */
function cliWithFixture(...args: string[]) {
  return runCli(args, {
    STAPLE_HOME: home,
    STAPLE_AGENT: "r6e-verify",
    NODE_OPTIONS: REGISTER_FIXTURE_NODE_OPTIONS,
  });
}

async function envelopeOf(ws: string): Promise<Envelope> {
  const res = await fetch(`${origin}/api/settings?ws=${ws}`, { headers: { "x-staple-token": token } });
  expect(res.status).toBe(200);
  return (await res.json()) as Envelope;
}

async function post(body: Record<string, unknown>): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`${origin}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-staple-token": token, origin },
    body: JSON.stringify({ actor: "ui", ...body }),
  });
  return { status: res.status, body: (await res.json()) as Envelope };
}

/** config.json exactly as it is on disk right now: absent, or its bytes. */
function configFile(): string | null {
  const path = configPath(home);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The `{value, source}` pair as the CLI answers it, so the CLI is asserted and not assumed. */
function cliValue(key: string, ws: string): SettingView {
  const result = cli("settings", "get", key, "--ws", ws, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as SettingView;
}

/** The same pair from a store opened on the database itself — no server, no CLI. */
function storeValue(store: WorkspaceStore, key: string): SettingView {
  return store.settingValue(key) as unknown as SettingView;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-r6e-home-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  // Two GLOBAL workspaces so both are in the hub and one server can serve both.
  expect(cli("init", "--global", ALPHA).status).toBe(0);
  expect(cli("init", "--global", BETA).status).toBe(0);

  alpha = openWorkspace(join(home, "workspaces", `${ALPHA}.db`)).store;
  beta = openWorkspace(join(home, "workspaces", `${BETA}.db`)).store;

  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;

  // `startMcpClient` builds the child's env from this process's, so the fixture
  // preload is staged for exactly as long as the spawn takes and then removed.
  const outerNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = REGISTER_FIXTURE_NODE_OPTIONS;
  try {
    mcp = await startMcpClient({ home, cwd: home, agent: "r6e-verify" });
  } finally {
    if (outerNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = outerNodeOptions;
  }
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  alpha?.db.close();
  beta?.db.close();
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 1. scope is physical

describe("two workspaces and one machine config never share a value", () => {
  /**
   * The workspace half. Two different keys are written, one into each workspace,
   * so the assertion is not "the other workspace happens to still be at its
   * default for the key I touched" but "neither write is visible in the other
   * database at all" — and config.json, which the whole write went nowhere near,
   * is compared as BYTES before and after.
   */
  it("a workspace write reaches that workspace on every surface and no other store", async () => {
    const configBefore = configFile();

    const written = await post({ ws: ALPHA, target: "settings", ops: [{ op: "set", key: POLICY, value: "strict" }] });
    expect(written.status).toBe(200);
    expect(written.body.workspace).toBe(ALPHA);

    const setBeta = cli("settings", "set", KIND_DEFAULT, "bug", "--ws", BETA, "--json");
    expect(setBeta.status, setBeta.stderr).toBe(0);

    // ALPHA carries the policy and nothing else; BETA carries the kind and nothing else.
    for (const [label, view] of Object.entries({
      http: (await envelopeOf(ALPHA)).values[POLICY]!,
      cli: cliValue(POLICY, ALPHA),
      store: storeValue(alpha, POLICY),
    })) {
      expect(view, `${label} alpha ${POLICY}`).toEqual({ key: POLICY, scope: "workspace", value: "strict", source: "workspace", version: 1 });
    }
    for (const [label, view] of Object.entries({
      http: (await envelopeOf(BETA)).values[POLICY]!,
      cli: cliValue(POLICY, BETA),
      store: storeValue(beta, POLICY),
    })) {
      expect(view, `${label} beta ${POLICY}`).toEqual({ key: POLICY, scope: "workspace", value: "advisory", source: "default", version: 1 });
    }
    expect(storeValue(beta, KIND_DEFAULT).value).toBe("bug");
    expect(storeValue(alpha, KIND_DEFAULT)).toEqual({ key: KIND_DEFAULT, scope: "workspace", value: "task", source: "default", version: 1 });
    expect(cliValue(KIND_DEFAULT, ALPHA).source).toBe("default");

    // Neither workspace has grown a row for the other's key, or for a global one.
    expect(alpha.unknownSettingKeys()).toEqual([]);
    expect(beta.unknownSettingKeys()).toEqual([]);

    // And the machine's config.json is untouched — the same bytes, or still absent.
    expect(configFile()).toBe(configBefore);
  });

  /**
   * The global half, and the direction that would be easiest to get wrong: a
   * machine preference is one file shared by every workspace, so `staple config
   * set` MUST change what both envelopes report under `global` and MUST NOT
   * change a single workspace value in either database.
   */
  it("a global write reaches config.json and neither workspace's values", async () => {
    const before = { alpha: (await envelopeOf(ALPHA)).values, beta: (await envelopeOf(BETA)).values };

    const set = cli("config", "set", "port", "4411");
    expect(set.status, set.stderr).toBe(0);

    const after = { alpha: await envelopeOf(ALPHA), beta: await envelopeOf(BETA) };
    expect(after.alpha.values).toEqual(before.alpha);
    expect(after.beta.values).toEqual(before.beta);

    // Both workspaces report the SAME machine preference, from the config file.
    for (const envelope of [after.alpha, after.beta]) {
      expect(envelope.global.present).toBe(true);
      expect(envelope.global.path).toBe(configPath(home));
      expect(envelope.global.values["machine.port"]).toEqual({
        key: "machine.port",
        scope: "global",
        value: 4411,
        source: "config",
        version: 1,
      });
    }
    // The value is in config.json, not in either database.
    expect(JSON.parse(configFile() ?? "{}")).toMatchObject({ port: 4411 });
    expect(alpha.unknownSettingKeys()).toEqual([]);
    expect(beta.unknownSettingKeys()).toEqual([]);
  });

  /**
   * The refusal that keeps the two stores apart, at the CLI — the surface an agent
   * uses. The store-level refusal is pinned in test/store-settings.test.ts; what is
   * new here is that `staple settings set` on a workspace names the OTHER command.
   */
  it("the workspace surface refuses a global key by pointing at the command that owns it", () => {
    const refused = cli("settings", "set", "machine.port", "4500", "--ws", ALPHA, "--json");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("staple config set");
    expect(JSON.parse(configFile() ?? "{}")).toMatchObject({ port: 4411 });
  });
});

// ---------------------------------------------------------------- 2. registry-only extension

/**
 * The category and the definition this build has never had live in
 * `./fixtures/verification-setting.ts`, which registers them through
 * `registerSettingCategory` / `registerSettingDefinition` — the registry's own
 * surface, which validates the new member with the same consistency check it
 * runs at import and would refuse a key, scope or default that did not fit its
 * category. They are in their own module so the CLI and MCP child processes can
 * preload it and register the same fixture (see `REGISTER_FIXTURE_NODE_OPTIONS`).
 */
const FIXTURE_KEY = FIXTURE_DEFINITION.key;

/**
 * The browser modules, as specifiers rather than literals, so `tsc` does not resolve
 * them into the Node-side program (see the header). Same device as
 * test/contract-settings-surfaces.test.ts.
 */
const REACT_MODULE = "react";
const REACT_SERVER_MODULE = "react-dom/server";
const SHELL_MODULE = "../src/ui/app/src/settings/SettingsShell.js";
const CATEGORY_CONTENT_MODULE = "../src/ui/app/src/settings/CategoryContent.js";

/** The shell files that would have to change if the shell knew about any category. */
const SHELL_FILES = [
  "SettingsShell.tsx",
  "CategoryContent.tsx",
  "FieldsForm.tsx",
  "VocabularyList.tsx",
  "SettingsDialog.tsx",
  "SettingsMount.tsx",
  "settings-shell.ts",
] as const;

describe("a category nothing was written for reaches the page by being registered", () => {
  let served: Envelope;
  let markup: string;

  beforeAll(async () => {
    served = await envelopeOf(ALPHA);

    // The REAL shell, over the REAL envelope. Loaded through variables so the
    // browser compilation stays out of the Node-side tsc program (see the header).
    const { createElement } = (await import(REACT_MODULE)) as { createElement: (...args: never[]) => unknown };
    const { renderToStaticMarkup } = (await import(REACT_SERVER_MODULE)) as {
      renderToStaticMarkup: (element: unknown) => string;
    };
    const { SettingsShell } = (await import(SHELL_MODULE)) as Record<string, unknown>;
    const { CategoryContent } = (await import(CATEGORY_CONTENT_MODULE)) as Record<string, unknown>;

    const element = (createElement as (t: unknown, p: unknown) => unknown)(SettingsShell, {
      categories: served.registry.categories,
      active: FIXTURE_CATEGORY.id,
      layout: "two-pane",
      pane: "nav",
      mode: "drawer",
      scope: { workspace: served.workspace, globalPath: served.global.path, globalPresent: served.global.present },
      onSelect: () => {},
      onBack: () => {},
      onToggleMode: () => {},
      onClose: () => {},
      renderCategory: (category: unknown) =>
        (createElement as (t: unknown, p: unknown) => unknown)(CategoryContent, {
          category,
          settings: served,
          applyTo: async () => null,
          onDirtyChange: () => {},
        }),
    });
    markup = renderToStaticMarkup(element);
  });

  it("the real HTTP envelope carries the new category and its typed definition", () => {
    expect(served.registry.categories.map((c) => c.id)).toContain(FIXTURE_CATEGORY.id);
    // In shell order, between the Workflow category (30) and This machine (90).
    expect(served.registry.categories.map((c) => c.id)).toEqual(["statuses", "kinds", "queue", "verification", "machine"]);
    expect(served.registry.categories.find((c) => c.id === "verification")).toEqual({
      id: "verification",
      label: "Verification",
      description: FIXTURE_CATEGORY.description,
      scope: "workspace",
      editor: "fields",
      order: 40,
    });
    expect(served.registry.definitions.find((d) => d.key === "verification.enabled")).toEqual({
      key: "verification.enabled",
      category: "verification",
      scope: "workspace",
      schema: { type: "boolean" },
      default: false,
      version: 1,
      sensitivity: "normal",
      ui: FIXTURE_DEFINITION.ui,
    });
    // And its effective value, with provenance, beside the two that were there before.
    expect(served.values["verification.enabled"]).toEqual({
      key: "verification.enabled",
      scope: "workspace",
      value: false,
      source: "default",
      version: 1,
    });
  });

  it("the real shell renders it from that envelope with no shell file naming it", () => {
    // It is in the navigation, under the scope its category declared…
    expect(markup).toContain('data-settings-category="verification"');
    expect(markup).toContain("Verification");
    expect(markup.indexOf("Verification")).toBeLessThan(markup.indexOf(">Global<"));
    // …selected, with its scope line…
    expect(markup).toContain('data-settings-category="verification" aria-current="page"');
    expect(markup).toContain(">Workspace scope</span>");
    // …and its control, chosen from the value schema alone.
    expect(markup).toMatch(/<input[^>]*id="setting-verification\.enabled"[^>]*type="checkbox"[^>]*role="switch"/);
    expect(markup).toContain("Fixture switch");
    expect(markup).toContain("Exists only while this suite runs.");

    for (const file of SHELL_FILES) {
      const source = readFileSync(fileURLToPath(new URL(`../src/ui/app/src/settings/${file}`, import.meta.url)), "utf8");
      expect(source, file).not.toContain("verification");
    }
  });

  /**
   * R6f (STA-243) — THE HALF THAT USED TO BE MISSING.
   *
   * The registry kept its single-key lookups in maps built once at module load,
   * so a definition registered afterwards was enumerated (and therefore served
   * and rendered, as the two tests above show) but invisible to
   * `requireSettingDefinition` — the WRITE boundary behind `store.setSetting`,
   * `staple settings set` and MCP `set_setting`. The fixture appeared on the page
   * and then refused its own Save with `Unknown workspace setting`. Registration
   * now appends and indexes in one step, so this asserts the whole loop instead:
   * the same fixture key is read and written on all four surfaces, and the value
   * a child process wrote is the value this process reads back.
   */
  it("resolves the fixture at the write boundary, not only in the enumerations", () => {
    expect(SETTING_DEFINITIONS.some((d) => d.key === FIXTURE_KEY)).toBe(true);
    expect(settingDefinition(FIXTURE_KEY)).toBe(FIXTURE_DEFINITION);
    expect(requireSettingDefinition(FIXTURE_KEY, "workspace")).toBe(FIXTURE_DEFINITION);
    expect(settingCategory(FIXTURE_CATEGORY.id)).toBe(FIXTURE_CATEGORY);
  });

  /**
   * One value, followed through every surface that can write it, each write read
   * back somewhere else. HTTP writes and the store reads; the CLI writes and MCP
   * reads; MCP writes and the store reads — so no surface is ever asserted only
   * against itself. BETA stays at the default throughout: registering a setting
   * does not give it a value.
   */
  it("saves a registry-only fixture value round-trip on the store, HTTP, the CLI and MCP", async () => {
    const stored = (value: boolean) => ({
      key: FIXTURE_KEY,
      scope: "workspace",
      value,
      source: "workspace",
      version: 1,
    });

    // 1. The shell's Save, over the real server: 200, not the 409 this used to be.
    const saved = await post({ ws: ALPHA, target: "settings", ops: [{ op: "set", key: FIXTURE_KEY, value: true }] });
    expect(saved.status).toBe(200);
    expect(saved.body.values[FIXTURE_KEY]).toEqual(stored(true));

    // …read back from the database itself, with no server in the way.
    expect(storeValue(alpha, FIXTURE_KEY)).toEqual(stored(true));
    // The row is a KNOWN setting now, not an unreadable one preserved for a newer build.
    expect(alpha.unknownSettingKeys()).toEqual([]);
    expect(storeValue(beta, FIXTURE_KEY)).toEqual({
      key: FIXTURE_KEY,
      scope: "workspace",
      value: false,
      source: "default",
      version: 1,
    });

    // 2. The CLI — a separate process, which registers the same fixture at import.
    expect(JSON.parse(cliWithFixture("settings", "get", FIXTURE_KEY, "--ws", ALPHA, "--json").stdout)).toEqual(
      stored(true),
    );
    const cliSet = cliWithFixture("settings", "set", FIXTURE_KEY, "false", "--ws", ALPHA, "--json");
    expect(cliSet.status, cliSet.stderr).toBe(0);
    expect(storeValue(alpha, FIXTURE_KEY)).toEqual(stored(false));

    // 3. MCP — another separate process. It reads what the CLI wrote…
    expect(toolPayload(await mcp.call("get_setting", { key: FIXTURE_KEY, ws: ALPHA }))).toEqual(stored(false));
    // …and its own write comes back on the store and over HTTP.
    expect(toolPayload(await mcp.call("set_setting", { key: FIXTURE_KEY, value: true, ws: ALPHA }))).toEqual(
      stored(true),
    );
    expect(storeValue(alpha, FIXTURE_KEY)).toEqual(stored(true));
    expect((await envelopeOf(ALPHA)).values[FIXTURE_KEY]).toEqual(stored(true));

    // 4. And back to the default, on the surface the shell uses to reset.
    const reset = await post({ ws: ALPHA, target: "settings", ops: [{ op: "reset", key: FIXTURE_KEY }] });
    expect(reset.status).toBe(200);
    expect(reset.body.values[FIXTURE_KEY]).toEqual({
      key: FIXTURE_KEY,
      scope: "workspace",
      value: false,
      source: "default",
      version: 1,
    });
  });
});
