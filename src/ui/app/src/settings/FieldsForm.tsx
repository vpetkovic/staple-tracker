/**
 * A REGISTRY-DRIVEN CATEGORY, EDITABLE — R6c (STA-178).
 *
 * R6b showed a `fields` category as a read-only list of its definitions. This renders
 * the same definitions as CONTROLS, chosen by each definition's value schema — a
 * checkbox for a boolean, a number field for an integer with its min and max, a text
 * field for a string with its pattern hint, a select for an enum — inside the shared
 * Field primitive, so every one carries its label, its description, its scope tag with
 * the value's source, its inline error and its own Reset. Nothing here names a setting:
 * R6d (STA-179) registers the queue policy and it renders through this file untouched,
 * and so does the fixture toggle after it.
 *
 * Global-scope definitions render disabled, with the sentence the store would refuse
 * with: their write path is `staple config set`, and a control that looks editable and
 * then is refused is worse than one that says so up front.
 */
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Refusal } from "@/lib/refusal";
import {
  settingValueIn,
  type SettingDefinitionView,
  type SettingOp,
  type SettingValueView,
  type WorkspaceSettingsEnvelope,
} from "@/lib/settings";
import {
  fieldsDraftErrors,
  fieldsDraftOps,
  fieldsRefusalTargets,
  isFieldsDraftDirty,
  isResettable,
  resetField,
  setFieldValue,
  shownValue,
  type FieldsDraft,
} from "./form/fields-draft";
import { actionBarState, attributeRefusal, parseFieldInput, snapshotSignature } from "./form/form-model";
import { ActionBar, ConflictBanner, Field, Section, type FieldAria } from "./form/primitives";
import { useDraft } from "./form/useDraft";

export interface FieldsFormProps {
  definitions: readonly SettingDefinitionView[];
  settings: WorkspaceSettingsEnvelope;
  write: (ops: SettingOp[]) => Promise<Refusal | null>;
  onDirtyChange?: (dirty: boolean) => void;
}

const GLOBAL_NOTE = "Global settings are edited with `staple config set`.";

/** The control for one definition, from its schema. */
function Control({
  definition,
  value,
  aria,
  disabled,
  onChange,
}: {
  definition: SettingDefinitionView;
  value: unknown;
  aria: FieldAria;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const schema = definition.schema;
  switch (schema.type) {
    case "boolean":
      return (
        <label className="flex h-7 items-center gap-2 text-[13px]">
          <input
            {...aria}
            type="checkbox"
            role="switch"
            aria-checked={value === true}
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
            className="accent-primary size-4"
          />
          <span>{value === true ? "On" : "Off"}</span>
        </label>
      );
    case "integer":
      return (
        <Input
          {...aria}
          type="number"
          inputMode="numeric"
          min={schema.min}
          max={schema.max}
          step={1}
          value={typeof value === "number" || typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(parseFieldInput(schema, event.target.value))}
          className="h-7 w-40 font-mono text-[12px]"
        />
      );
    case "string":
      return (
        <Input
          {...aria}
          type="text"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-7 text-[13px]"
        />
      );
    case "enum":
      return (
        <Select value={typeof value === "string" ? value : ""} disabled={disabled} onValueChange={onChange}>
          <SelectTrigger
            id={aria.id}
            aria-describedby={aria["aria-describedby"]}
            aria-invalid={aria["aria-invalid"]}
            size="sm"
            className="w-full text-[12px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {schema.values.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
  }
}

export function FieldsForm({ definitions, settings, write, onDirtyChange }: FieldsFormProps) {
  const served = useMemo(
    () => Object.fromEntries(definitions.map((d) => [d.key, settingValueIn(settings, d.key)])),
    [definitions, settings],
  ) as Record<string, SettingValueView | undefined>;
  const empty = useMemo<FieldsDraft>(() => ({}), []);
  const draft = useDraft<FieldsDraft>({
    served: empty,
    signature: snapshotSignature(definitions.map((d) => served[d.key] ?? null)),
    isDirty: isFieldsDraftDirty,
    write: (next) => write(fieldsDraftOps(next, definitions)),
    onDirtyChange,
  });
  const { value, dirty, status, refusal, conflict } = draft;
  const disabled = status === "pending";

  const errors = fieldsDraftErrors(value, definitions);
  const refusedKey = refusal ? attributeRefusal(refusal.message, fieldsRefusalTargets(definitions)) : null;
  if (refusal && refusedKey) errors[refusedKey] = refusal.message;
  const sectionError = refusal && !refusedKey ? refusal.message : null;

  const resettable = definitions.some((d) => d.scope === "workspace" && isResettable(value, d, served[d.key]));
  const bar = actionBarState({
    dirty,
    status,
    blocked: conflict || Object.keys(fieldsDraftErrors(value, definitions)).length > 0,
    resettable,
  });

  if (definitions.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing is registered in this category yet.</p>;
  }

  return (
    <Section error={sectionError}>
      {conflict ? <ConflictBanner what="settings" onReload={draft.cancel} onKeep={draft.keep} /> : null}

      <div data-settings-fields className="space-y-4">
        {definitions.map((definition) => {
          const current = served[definition.key];
          const editable = definition.scope === "workspace";
          const shown = shownValue(value, definition, current);
          const description = definition.schema.type === "string" && definition.schema.patternHint
            ? `${definition.ui.description} ${definition.schema.patternHint}`
            : definition.ui.description;
          return (
            <Field
              key={definition.key}
              id={`setting-${definition.key}`}
              label={definition.ui.label}
              description={editable ? description : `${description} ${GLOBAL_NOTE}`}
              scope={definition.scope}
              source={current?.source ?? "default"}
              error={errors[definition.key] ?? null}
              dirty={definition.key in value}
              trailing={
                editable ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={`Reset ${definition.ui.label} to default`}
                    disabled={disabled || !isResettable(value, definition, current)}
                    onClick={() => draft.set(resetField(value, definition, current))}
                  >
                    Reset
                  </Button>
                ) : undefined
              }
            >
              {(aria) => (
                <Control
                  definition={definition}
                  value={current?.redacted ? "" : shown}
                  aria={aria}
                  disabled={disabled || !editable}
                  onChange={(next) => draft.set(setFieldValue(value, definition, current, next))}
                />
              )}
            </Field>
          );
        })}
      </div>

      <ActionBar
        state={bar}
        onSave={() => void draft.save()}
        onCancel={draft.cancel}
        onReset={() => {
          let next = value;
          for (const d of definitions) if (d.scope === "workspace") next = resetField(next, d, served[d.key]);
          draft.set(next);
        }}
        summary={dirty ? `${Object.keys(value).length} unsaved ${Object.keys(value).length === 1 ? "change" : "changes"}` : undefined}
      />
    </Section>
  );
}
