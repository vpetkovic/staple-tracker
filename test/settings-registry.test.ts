import { describe, expect, it } from "vitest";
import {
  SETTING_CATEGORIES,
  SETTING_DEFINITIONS,
  assertSettingRegistryConsistent,
  coerceSettingInput,
  encodeStoredSetting,
  readStoredSetting,
  requireSettingDefinition,
  settingCategoriesFor,
  settingDefinition,
  settingDefinitionView,
  settingDefinitionsFor,
  settingKeyFromMetaKey,
  settingMetaKey,
  settingRegistryView,
  settingValueView,
  validateSettingValue,
  type SettingDefinition,
} from "../src/core/settings-registry.js";
import { StapleError } from "../src/core/types.js";

/**
 * R6a (STA-176) — the settings registry, as a pure module.
 *
 * What is under test is the CONTRACT every persistence surface leans on:
 * one definition per key with an explicit scope, validation that refuses at
 * both boundaries with a sentence naming the key, versioned values whose
 * upgrade is deterministic, and wire views that carry everything a shell
 * renders from and nothing a shell must not see. The store and the config file
 * are exercised in their own suites; this one never touches a database or a
 * file, which is the property that makes the registry a registry.
 */

/** A definition built for a test, so the version/migrate path can be driven without a real one. */
function fake(over: Partial<SettingDefinition> = {}): SettingDefinition {
  return {
    key: "kinds.fixture",
    category: "kinds",
    scope: "workspace",
    schema: { type: "integer", min: 0, max: 10 },
    default: 3,
    version: 1,
    sensitivity: "normal",
    ui: { label: "Fixture", description: "", control: "number", order: 1 },
    ...over,
  };
}

describe("the registered set", () => {
  it("is internally consistent at load: unique namespaced keys, known categories, matching scopes", () => {
    expect(() => assertSettingRegistryConsistent()).not.toThrow();
    for (const definition of SETTING_DEFINITIONS) {
      expect(definition.key.startsWith(`${definition.category}.`)).toBe(true);
    }
  });

  it("registers the three machine preferences as global and one workspace field setting", () => {
    expect(settingDefinitionsFor("global").map((d) => [d.key, d.configKey])).toEqual([
      ["machine.browser", "browser"],
      ["machine.port", "port"],
      ["machine.setupComplete", "setupComplete"],
    ]);
    expect(settingDefinitionsFor("workspace").map((d) => d.key)).toEqual(["kinds.default"]);
  });

  it("lists statuses and kinds as workspace vocabulary categories the shell can enumerate", () => {
    expect(SETTING_CATEGORIES.map((c) => `${c.id}:${c.scope}:${c.editor}`)).toEqual([
      "statuses:workspace:statuses",
      "kinds:workspace:kinds",
      "machine:global:fields",
    ]);
    expect(settingCategoriesFor("global").map((c) => c.id)).toEqual(["machine"]);
  });

  it("refuses a registry whose definition breaks an invariant, naming the key", () => {
    const dup = [fake({ key: "kinds.a" }), fake({ key: "kinds.a" })];
    expect(() => assertSettingRegistryConsistent(SETTING_CATEGORIES, dup)).toThrow(/duplicate key "kinds.a"/);
    expect(() => assertSettingRegistryConsistent(SETTING_CATEGORIES, [fake({ key: "nope.a", category: "nope" })])).toThrow(
      /unknown category "nope"/,
    );
    expect(() => assertSettingRegistryConsistent(SETTING_CATEGORIES, [fake({ key: "machine.a" })])).toThrow(
      /must be namespaced as "kinds\.<name>"/,
    );
    expect(() =>
      assertSettingRegistryConsistent(SETTING_CATEGORIES, [fake({ key: "machine.a", category: "machine" })]),
    ).toThrow(/is workspace but category "machine" is global/);
    expect(() => assertSettingRegistryConsistent(SETTING_CATEGORIES, [fake({ default: 99 })])).toThrow(StapleError);
    expect(() => assertSettingRegistryConsistent(SETTING_CATEGORIES, [fake({ configKey: "x" })])).toThrow(
      /must not carry a configKey/,
    );
  });

  it("looks a definition up by key and refuses an unknown or wrong-scope key with the known keys", () => {
    expect(settingDefinition("kinds.default")?.scope).toBe("workspace");
    expect(settingDefinition("nothing")).toBeUndefined();
    expect(() => requireSettingDefinition("nothing", "workspace")).toThrow(
      /Unknown workspace setting "nothing"\. Known: kinds\.default/,
    );
    expect(() => requireSettingDefinition("machine.port", "workspace")).toThrow(
      /"machine\.port" is a global setting, not a workspace one\. Global settings are edited with `staple config set`/,
    );
  });

  it("maps a key to its meta row and back", () => {
    expect(settingMetaKey("kinds.default")).toBe("setting:kinds.default");
    expect(settingKeyFromMetaKey("setting:kinds.default")).toBe("kinds.default");
    expect(settingKeyFromMetaKey("settings_revision")).toBeNull();
  });
});

describe("validation", () => {
  it("accepts a value that fits the schema and refuses one that does not, naming where and what", () => {
    expect(validateSettingValue(fake(), 7, "workspace t")).toBe(7);
    expect(() => validateSettingValue(fake(), 11, "workspace t")).toThrow(
      '"kinds.fixture" must be an integer between 0 and 10, got 11',
    );
    expect(() => validateSettingValue(fake(), "7", "workspace t")).toThrow(/workspace t: /);
    expect(() => validateSettingValue(fake({ schema: { type: "boolean" } }), "yes", "f")).toThrow(/must be true or false/);
    expect(() =>
      validateSettingValue(fake({ schema: { type: "enum", values: ["a", "b"] } }), "c", "f"),
    ).toThrow(/must be one of a, b, got "c"/);
    expect(() =>
      validateSettingValue(fake({ schema: { type: "string", pattern: /^[a-z]+$/, patternHint: "letters" } }), "A1", "f"),
    ).toThrow(/must be letters/);
  });

  it("reports a global setting under its config.json field name", () => {
    expect(() => validateSettingValue(requireSettingDefinition("machine.port"), 0, "cfg", "port")).toThrow(
      'cfg: "port" must be an integer between 1 and 65535, got 0',
    );
  });

  it("coerces a command-line word by schema and refuses a non-integer by name", () => {
    expect(coerceSettingInput(requireSettingDefinition("machine.port"), "4500", "set")).toBe(4500);
    expect(coerceSettingInput(requireSettingDefinition("machine.setupComplete"), "yes", "set")).toBe(true);
    expect(coerceSettingInput(requireSettingDefinition("machine.setupComplete"), "off", "set")).toBe(false);
    expect(() => coerceSettingInput(requireSettingDefinition("machine.setupComplete"), "maybe", "set")).toThrow(
      /"setupComplete" must be true or false/,
    );
    expect(() => coerceSettingInput(requireSettingDefinition("machine.port"), "abc", "set")).toThrow(
      'port must be an integer, got "abc"',
    );
    expect(() => coerceSettingInput(requireSettingDefinition("machine.browser"), "sometimes", "set")).toThrow(
      /"browser" must be one of auto, always, never/,
    );
  });
});

describe("versioned persistence", () => {
  it("round-trips a value through the {v, value} envelope at the definition's version", () => {
    const text = encodeStoredSetting(fake(), 5);
    expect(JSON.parse(text)).toEqual({ v: 1, value: 5 });
    expect(readStoredSetting(fake(), text, "w")).toEqual({ value: 5, version: 1, migrated: false });
  });

  it("validates at the READ boundary: a stored value that no longer fits is refused, not returned", () => {
    expect(() => readStoredSetting(fake(), JSON.stringify({ v: 1, value: 42 }), "w")).toThrow(
      /"kinds\.fixture" must be an integer between 0 and 10/,
    );
    expect(() => readStoredSetting(fake(), "not json", "w")).toThrow(/not valid JSON/);
    expect(() => readStoredSetting(fake(), "[1]", "w")).toThrow(/not a \{v, value\} envelope/);
    expect(() => readStoredSetting(fake(), JSON.stringify({ value: 1 }), "w")).toThrow(/no valid version/);
  });

  it("migrates an OLDER value deterministically through the hook, and defaults without one", () => {
    const stored = JSON.stringify({ v: 1, value: 4 });
    const doubled = fake({ version: 2, migrate: (value, from) => (from === 1 ? (value as number) * 2 : value) });
    expect(readStoredSetting(doubled, stored, "w")).toEqual({ value: 8, version: 1, migrated: true });
    expect(readStoredSetting(doubled, stored, "w")).toEqual(readStoredSetting(doubled, stored, "w"));
    expect(readStoredSetting(fake({ version: 2 }), stored, "w")).toEqual({ value: 3, version: 1, migrated: true });
  });

  it("validates a migrated value like any other, so a bad hook cannot smuggle a shape in", () => {
    const bad = fake({ version: 2, migrate: () => "eight" });
    expect(() => readStoredSetting(bad, JSON.stringify({ v: 1, value: 4 }), "w")).toThrow(StapleError);
  });

  it("refuses a NEWER value rather than reinterpreting it", () => {
    expect(() => readStoredSetting(fake(), JSON.stringify({ v: 2, value: 4 }), "w")).toThrow(
      /"kinds\.fixture" was written by a newer staple \(version 2; this one understands 1\)/,
    );
  });
});

describe("wire views", () => {
  it("serves a definition without its code and with the RegExp as source text", () => {
    const view = settingDefinitionView(requireSettingDefinition("kinds.default"));
    expect(view).toEqual({
      key: "kinds.default",
      category: "kinds",
      scope: "workspace",
      schema: {
        type: "string",
        pattern: "^[a-z][a-z0-9_]{0,31}$",
        patternHint: "a kind id: lowercase letters, digits and underscores, starting with a letter",
      },
      default: "task",
      version: 1,
      sensitivity: "normal",
      ui: expect.objectContaining({ label: "Default kind", control: "select" }),
    });
    expect("migrate" in view).toBe(false);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("carries a value with its scope and provenance", () => {
    expect(settingValueView(requireSettingDefinition("machine.port"), 4500, "config")).toEqual({
      key: "machine.port",
      scope: "global",
      value: 4500,
      source: "config",
      version: 1,
    });
  });

  it("redacts a sensitive value and its default on every read surface", () => {
    const secret = fake({ schema: { type: "string" }, default: "s3", sensitivity: "sensitive" });
    expect(settingValueView(secret, "hunter2", "workspace")).toEqual({
      key: "kinds.fixture",
      scope: "workspace",
      source: "workspace",
      version: 1,
      redacted: true,
    });
    expect(settingDefinitionView(secret).default).toBeNull();
  });

  it("serves the whole registry in shell order", () => {
    const view = settingRegistryView();
    expect(view.categories.map((c) => c.id)).toEqual(["statuses", "kinds", "machine"]);
    expect(view.definitions.map((d) => d.key)).toEqual([
      "kinds.default",
      "machine.browser",
      "machine.port",
      "machine.setupComplete",
    ]);
  });
});
