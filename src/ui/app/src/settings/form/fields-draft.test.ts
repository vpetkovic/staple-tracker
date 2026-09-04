/**
 * The fields draft — R6c (STA-178). What a registry-driven category queues for Save:
 * a `set` per changed key, a `reset` for a stored value the user sent back to its
 * default, and nothing for a value that was touched and put back.
 */
import { describe, expect, it } from "vitest";
import type { SettingDefinitionView, SettingValueView } from "../../lib/settings";
import {
  emptyFieldsDraft,
  fieldsDraftErrors,
  fieldsDraftOps,
  fieldsRefusalTargets,
  isFieldsDraftDirty,
  isResettable,
  resetField,
  setFieldValue,
  shownValue,
} from "./fields-draft";

const definition = (key: string, over: Partial<SettingDefinitionView> = {}): SettingDefinitionView => ({
  key,
  category: "workflow",
  scope: "workspace",
  schema: { type: "enum", values: ["advisory", "strict"] },
  default: "advisory",
  version: 1,
  sensitivity: "normal",
  ui: { label: key, description: `About ${key}.`, control: "select", order: 0 },
  ...over,
});

const stored = (key: string, value: unknown): SettingValueView => ({
  key,
  scope: "workspace",
  value,
  source: "workspace",
  version: 1,
});

const POLICY = definition("queue.policy", { ui: { label: "Queue policy", description: "x", control: "select", order: 0 } });
const PORT = definition("machine.port", { schema: { type: "integer", min: 1, max: 65535 }, default: 4400 });

describe("set", () => {
  it("queues a set for a new value and shows it", () => {
    const draft = setFieldValue(emptyFieldsDraft(), POLICY, undefined, "strict");
    expect(draft).toEqual({ "queue.policy": { op: "set", key: "queue.policy", value: "strict" } });
    expect(isFieldsDraftDirty(draft)).toBe(true);
    expect(shownValue(draft, POLICY, undefined)).toBe("strict");
    expect(fieldsDraftOps(draft, [POLICY])).toEqual([{ op: "set", key: "queue.policy", value: "strict" }]);
  });

  it("putting the served value back leaves the form clean", () => {
    let draft = setFieldValue(emptyFieldsDraft(), POLICY, undefined, "strict");
    draft = setFieldValue(draft, POLICY, undefined, "advisory");
    expect(draft).toEqual({});
    expect(isFieldsDraftDirty(draft)).toBe(false);
  });

  it("shows the served value when the draft has nothing, and the default when nothing is served", () => {
    expect(shownValue({}, POLICY, stored("queue.policy", "strict"))).toBe("strict");
    expect(shownValue({}, POLICY, undefined)).toBe("advisory");
  });
});

describe("reset", () => {
  it("queues a reset for a stored value and shows the default", () => {
    const served = stored("queue.policy", "strict");
    const draft = resetField(emptyFieldsDraft(), POLICY, served);
    expect(draft).toEqual({ "queue.policy": { op: "reset", key: "queue.policy" } });
    expect(shownValue(draft, POLICY, served)).toBe("advisory");
    expect(isResettable(draft, POLICY, served)).toBe(false);
  });

  it("on a value already at its default by source, reset just drops the draft edit", () => {
    const draft = setFieldValue(emptyFieldsDraft(), POLICY, undefined, "strict");
    expect(resetField(draft, POLICY, undefined)).toEqual({});
  });

  it("isResettable — a stored value, or a draft edit away from the default", () => {
    expect(isResettable({}, POLICY, stored("queue.policy", "strict"))).toBe(true);
    expect(isResettable({}, POLICY, undefined)).toBe(false);
    expect(isResettable(setFieldValue({}, POLICY, undefined, "strict"), POLICY, undefined)).toBe(true);
  });
});

describe("errors and ops", () => {
  it("validates every set against its schema, keyed by setting", () => {
    let draft = setFieldValue(emptyFieldsDraft(), PORT, undefined, 70000);
    draft = setFieldValue(draft, POLICY, undefined, "strict");
    expect(fieldsDraftErrors(draft, [POLICY, PORT])).toEqual({ "machine.port": "Must be at most 65535." });
  });

  it("posts ops in definition order regardless of edit order", () => {
    let draft = setFieldValue(emptyFieldsDraft(), PORT, undefined, 8080);
    draft = setFieldValue(draft, POLICY, undefined, "strict");
    expect(fieldsDraftOps(draft, [POLICY, PORT]).map((op) => op.key)).toEqual(["queue.policy", "machine.port"]);
  });

  it("offers the key and the label as what a refusal might name", () => {
    expect(fieldsRefusalTargets([POLICY])).toEqual([
      { id: "queue.policy", terms: ['"queue.policy"', "queue.policy", '"Queue policy"'] },
    ]);
  });
});
