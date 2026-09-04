/**
 * A3 (STA-33) — versioned `config.json`.
 *
 * STA-24 plan §2: "`config.json` has a schema version and stores only durable
 * preferences … Write configuration and the locator through a validated
 * temporary file in the same directory, then atomically rename it over the old
 * file."
 *
 * The two properties worth the most here are (a) unknown future fields survive a
 * rewrite by an older binary, and (b) an unreadable config is refused rather than
 * silently replaced by defaults — a rewrite over a file we could not parse is
 * exactly how a connector receipt gets destroyed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  SETTING_KEYS,
  configPath,
  readConfig,
  updateConfig,
} from "../src/config/file.js";
import { settingDefinitionsFor } from "../src/core/settings-registry.js";
import { writeFileAtomic } from "../src/config/atomic.js";
import { StapleError } from "../src/core/types.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";

let home: string;

beforeEach(() => {
  home = tempDir("cfg-file");
});

afterEach(() => {
  removeDir(home);
});

const raw = (): Record<string, unknown> =>
  JSON.parse(readFileSync(configPath(home), "utf8")) as Record<string, unknown>;

describe("reading", () => {
  it("configPath is <home>/config.json", () => {
    expect(configPath(home)).toBe(join(home, "config.json"));
  });

  it("an absent config reads as defaults and reports it", () => {
    const loaded = readConfig(home);
    expect(loaded.present).toBe(false);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.path).toBe(configPath(home));
  });

  it("an absent config does not create the file as a side effect", () => {
    readConfig(home);
    expect(readdirSync(home)).toEqual([]);
  });

  it("defaults match the plan's Quick setup row: browser on, port 4400, setup incomplete", () => {
    expect(DEFAULT_CONFIG).toEqual({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      browser: "auto",
      port: 4400,
      setupComplete: false,
      connectors: {},
    });
  });

  it("reads back what it wrote", () => {
    updateConfig(home, { browser: "never", port: 5000, setupComplete: true });
    const loaded = readConfig(home);
    expect(loaded.present).toBe(true);
    expect(loaded.config.browser).toBe("never");
    expect(loaded.config.port).toBe(5000);
    expect(loaded.config.setupComplete).toBe(true);
  });

  it("fills in keys a partial config omits", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath(home), JSON.stringify({ schemaVersion: 1, port: 4500 }));
    const loaded = readConfig(home);
    expect(loaded.config.port).toBe(4500);
    expect(loaded.config.browser).toBe(DEFAULT_CONFIG.browser);
    expect(loaded.config.connectors).toEqual({});
  });
});

describe("refusing what it cannot understand", () => {
  const plant = (body: string): void => {
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath(home), body);
  };

  it("refuses malformed JSON, naming the path, as a validation error", () => {
    plant("{ definitely not json");
    let caught: StapleError | null = null;
    try {
      readConfig(home);
    } catch (error) {
      caught = error as StapleError;
    }
    expect(caught).toBeInstanceOf(StapleError);
    expect(caught?.code).toBe("validation");
    expect(caught?.message).toContain(configPath(home));
  });

  it("refuses a newer schemaVersion rather than truncating it", () => {
    plant(JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION + 1, browser: "never" }));
    expect(() => readConfig(home)).toThrow(/schemaVersion/);
  });

  it("refuses a JSON array or scalar at the top level", () => {
    plant("[]");
    expect(() => readConfig(home)).toThrow(StapleError);
    plant("42");
    expect(() => readConfig(home)).toThrow(StapleError);
  });

  it("refuses a corrupt config on WRITE too, so a rewrite cannot eat it", () => {
    plant("{ corrupt");
    expect(() => updateConfig(home, { browser: "never" })).toThrow(StapleError);
    // …and the original bytes are still there, untouched.
    expect(readFileSync(configPath(home), "utf8")).toBe("{ corrupt");
  });

  it("rejects an out-of-range port", () => {
    expect(() => updateConfig(home, { port: 0 })).toThrow(StapleError);
    expect(() => updateConfig(home, { port: 70_000 })).toThrow(StapleError);
  });

  it("rejects an unknown browser preference", () => {
    expect(() => updateConfig(home, { browser: "sometimes" as never })).toThrow(StapleError);
  });
});

describe("preserving unknown future fields", () => {
  /**
   * The forward-compatibility promise: a newer staple writes a key this binary
   * has never heard of, and this binary must hand it back unharmed on the next
   * write instead of dropping it.
   */
  it("keeps unknown top-level keys across a rewrite", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      configPath(home),
      JSON.stringify({
        schemaVersion: CONFIG_SCHEMA_VERSION,
        browser: "auto",
        futureFeature: { enabled: true, nested: [1, 2, 3] },
        telemetryOptIn: false,
      }),
    );
    updateConfig(home, { port: 4444 });
    const after = raw();
    expect(after.futureFeature).toEqual({ enabled: true, nested: [1, 2, 3] });
    expect(after.telemetryOptIn).toBe(false);
    expect(after.port).toBe(4444);
  });

  it("surfaces the unknown keys to the caller so `config show` can mention them", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      configPath(home),
      JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, mystery: 1 }),
    );
    expect(readConfig(home).unknownKeys).toEqual(["mystery"]);
  });

  it("reports no unknown keys for a config this binary fully understands", () => {
    updateConfig(home, { browser: "always" });
    expect(readConfig(home).unknownKeys).toEqual([]);
  });

  /**
   * R6a (STA-176): the known keys, defaults and value checks come from the
   * registry's GLOBAL definitions, so a machine preference has one definition
   * and this file carries no list of its own. The refusal sentence names the
   * config.json field, not the registry key, because that is what the user sees.
   */
  it("derives its known keys and defaults from the registry's global definitions", () => {
    const globals = settingDefinitionsFor("global");
    expect([...SETTING_KEYS]).toEqual(globals.map((d) => d.configKey));
    for (const definition of globals) {
      expect((DEFAULT_CONFIG as unknown as Record<string, unknown>)[definition.configKey!]).toEqual(
        definition.default,
      );
    }
    expect(settingDefinitionsFor("workspace").every((d) => d.configKey === undefined)).toBe(true);
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath(home), JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, port: "4400" }));
    expect(() => readConfig(home)).toThrow(/"port" must be an integer between 1 and 65535, got "4400"/);
    expect(() => readConfig(home)).toThrow(configPath(home));
  });

  it("always stamps the current schemaVersion on write", () => {
    updateConfig(home, { browser: "always" });
    expect(raw().schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
  });
});

describe("writing sparsely", () => {
  /**
   * Only chosen keys are persisted. Materializing every default would freeze
   * today's defaults into every machine that ran `config set` once — a later
   * change to a default could then never reach them — and would destroy the
   * distinction `config show` reports between a chosen and an inherited value.
   */
  it("persists only the keys that were set", () => {
    updateConfig(home, { port: 4999 });
    expect(Object.keys(raw()).sort()).toEqual(["port", "schemaVersion"]);
  });

  it("accumulates keys as they are chosen, without back-filling the rest", () => {
    updateConfig(home, { port: 4999 });
    updateConfig(home, { browser: "never" });
    expect(Object.keys(raw()).sort()).toEqual(["browser", "port", "schemaVersion"]);
    expect(readConfig(home).explicitKeys.sort()).toEqual(["browser", "port"]);
    // The unchosen keys still read as their live defaults.
    expect(readConfig(home).config.setupComplete).toBe(DEFAULT_CONFIG.setupComplete);
  });

  it("a value equal to the default is still recorded once chosen", () => {
    updateConfig(home, { port: DEFAULT_CONFIG.port });
    expect(readConfig(home).explicitKeys).toEqual(["port"]);
  });
});

describe("atomic writes", () => {
  it("creates the home directory on first write", () => {
    const fresh = join(home, "deep", "nested");
    updateConfig(fresh, { port: 4401 });
    expect(readConfig(fresh).config.port).toBe(4401);
  });

  it("leaves no temporary file behind", () => {
    updateConfig(home, { port: 4402 });
    updateConfig(home, { port: 4403 });
    expect(readdirSync(home)).toEqual(["config.json"]);
  });

  it("writes the config 0600 and keeps it that way", () => {
    if (process.platform === "win32") return;
    updateConfig(home, { port: 4404 });
    expect((statSync(configPath(home)).mode & 0o777).toString(8)).toBe("600");
    chmodSync(configPath(home), 0o644);
    updateConfig(home, { port: 4405 });
    expect((statSync(configPath(home)).mode & 0o777).toString(8)).toBe("600");
  });

  it("writeFileAtomic replaces content wholesale and cleans up on failure", () => {
    const target = join(home, "thing.json");
    writeFileAtomic(target, "one", { mode: 0o600 });
    expect(readFileSync(target, "utf8")).toBe("one");
    writeFileAtomic(target, "two", { mode: 0o600 });
    expect(readFileSync(target, "utf8")).toBe("two");
    expect(readdirSync(home)).toEqual(["thing.json"]);
  });

  it("writeFileAtomic keeps the previous file when the write throws", () => {
    const target = join(home, "keep.json");
    writeFileAtomic(target, "original", { mode: 0o600 });
    expect(() =>
      writeFileAtomic(target, "replacement", {
        mode: 0o600,
        // A validator that refuses runs BEFORE the rename, per plan §2's
        // "validated temporary file … then atomically rename".
        validate: () => {
          throw new StapleError("validation", "nope");
        },
      }),
    ).toThrow(StapleError);
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(readdirSync(home)).toEqual(["keep.json"]);
  });

  it("writeFileAtomic never leaves a partial file at the target path", () => {
    const target = join(home, "partial.json");
    writeFileAtomic(target, JSON.stringify({ a: 1 }), { mode: 0o600 });
    for (let i = 0; i < 25; i += 1) {
      writeFileAtomic(target, JSON.stringify({ a: i, pad: "x".repeat(4096) }), { mode: 0o600 });
      // Every observation is a complete, parseable document.
      expect(() => JSON.parse(readFileSync(target, "utf8")) as unknown).not.toThrow();
    }
    expect(readdirSync(home)).toEqual(["partial.json"]);
  });
});

describe("connector receipts", () => {
  it("stores and merges receipts without clobbering siblings", () => {
    updateConfig(home, { connectors: { claude: { target: "/tmp/claude.json", version: "1" } } });
    updateConfig(home, { connectors: { codex: { target: "/tmp/codex.toml", version: "2" } } });
    const { config } = readConfig(home);
    expect(Object.keys(config.connectors).sort()).toEqual(["claude", "codex"]);
    expect(config.connectors.claude).toEqual({ target: "/tmp/claude.json", version: "1" });
  });
});
