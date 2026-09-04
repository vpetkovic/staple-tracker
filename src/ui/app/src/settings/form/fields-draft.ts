/**
 * A FIELDS DRAFT — R6c (STA-178). What a registry-driven category holds while it is
 * being edited, as pure functions.
 *
 * A `fields` category is nothing but its definitions, served by the registry. The draft
 * is the set of keys the user has touched, each as the op Save will post for it: `set`
 * with a typed value, or `reset` (drop the stored row, so the value goes back to the
 * default AND its source says so — which a `set` to the default value would not). The
 * form shows, for every definition, the draft's answer if it has one and the served
 * effective value otherwise. R6d's queue policy is one more definition; nothing here
 * knows its name.
 */
import type { SettingDefinitionView, SettingOp, SettingValueView } from "../../lib/settings";
import { sameValue, validateFieldValue } from "./form-model";

export type FieldsDraft = Record<string, SettingOp>;

export function emptyFieldsDraft(): FieldsDraft {
  return {};
}

export function isFieldsDraftDirty(draft: FieldsDraft): boolean {
  return Object.keys(draft).length > 0;
}

/** The ops Save posts, in definition order so a refusal is about the first bad key on screen. */
export function fieldsDraftOps(draft: FieldsDraft, definitions: readonly SettingDefinitionView[]): SettingOp[] {
  return definitions.map((d) => draft[d.key]).filter((op): op is SettingOp => op !== undefined);
}

/** The value a field shows: the draft's, else the served effective value. */
export function shownValue(
  draft: FieldsDraft,
  definition: SettingDefinitionView,
  served: SettingValueView | undefined,
): unknown {
  const op = draft[definition.key];
  if (op?.op === "set") return op.value;
  if (op?.op === "reset") return definition.default;
  return served?.value ?? definition.default;
}

/**
 * Record a typed value. A value equal to what is served is not an edit — touching a
 * select and putting it back must leave the form clean — unless the served value's
 * source is not the default and the user is asking for exactly the default, in which
 * case it stays a `set`: only the Reset control produces a `reset`.
 */
export function setFieldValue(
  draft: FieldsDraft,
  definition: SettingDefinitionView,
  served: SettingValueView | undefined,
  value: unknown,
): FieldsDraft {
  const next = { ...draft };
  if (sameValue(value, served?.value ?? definition.default)) delete next[definition.key];
  else next[definition.key] = { op: "set", key: definition.key, value };
  return next;
}

/** Ask for the default. A field already at its default by source has nothing to reset. */
export function resetField(
  draft: FieldsDraft,
  definition: SettingDefinitionView,
  served: SettingValueView | undefined,
): FieldsDraft {
  const next = { ...draft };
  if (!served || served.source === "default") delete next[definition.key];
  else next[definition.key] = { op: "reset", key: definition.key };
  return next;
}

/** Is there anything to reset: a stored value, or a draft edit away from the default. */
export function isResettable(
  draft: FieldsDraft,
  definition: SettingDefinitionView,
  served: SettingValueView | undefined,
): boolean {
  const op = draft[definition.key];
  if (op?.op === "set") return !sameValue(op.value, definition.default);
  if (op?.op === "reset") return false;
  return served !== undefined && served.source !== "default";
}

/** Client-side errors for every `set` in the draft, keyed by setting key. */
export function fieldsDraftErrors(
  draft: FieldsDraft,
  definitions: readonly SettingDefinitionView[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const definition of definitions) {
    const op = draft[definition.key];
    if (op?.op !== "set") continue;
    const error = validateFieldValue(definition.schema, op.value);
    if (error) errors[definition.key] = error;
  }
  return errors;
}

/** The words a refusal could use for each definition, for `attributeRefusal`. */
export function fieldsRefusalTargets(definitions: readonly SettingDefinitionView[]): { id: string; terms: string[] }[] {
  return definitions.map((d) => ({ id: d.key, terms: [`"${d.key}"`, d.key, `"${d.ui.label}"`] }));
}
