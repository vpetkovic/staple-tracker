/**
 * WHAT A CATEGORY SHOWS — R6b (STA-177). The shell's one extension point.
 *
 * The shell enumerates categories and never looks inside one; this is the file that
 * does. It switches on the registry's `editor` — the one field a category carries to
 * say what kind of surface it needs — so a new `fields` category registered in
 * src/core/settings-registry.ts renders here with no edit to the shell, and a future
 * bespoke editor is one more arm of this switch rather than a conditional in the nav.
 *
 * Every arm is a form built from the primitives in ./form (R6c, STA-178): Statuses and
 * Kinds are `VocabularyList` on a draft; a `fields` category is `FieldsForm`, which
 * renders a control per definition from the registry's value schema. All three write
 * through the dialog's `applyTo` and report their dirty state up through
 * `onDirtyChange`, which is what lets the shell refuse to close over unsaved edits.
 */
import type { SettingCategoryView, SettingOp, WorkspaceSettingsEnvelope } from "@/lib/settings";
import type { Refusal } from "@/lib/refusal";
import type { VocabularyOp } from "@/lib/types";
import { FieldsForm } from "./FieldsForm";
import { VocabularyList } from "./VocabularyList";
import { kindRows, statusRows } from "./settings-ops";

export interface ApplyTo {
  (target: "statuses" | "kinds", ops: VocabularyOp[]): Promise<Refusal | null>;
  (target: "settings", ops: SettingOp[]): Promise<Refusal | null>;
}

export interface CategoryContentProps {
  category: SettingCategoryView;
  settings: WorkspaceSettingsEnvelope;
  applyTo: ApplyTo;
  onDirtyChange: (dirty: boolean) => void;
}

export function CategoryContent({ category, settings, applyTo, onDirtyChange }: CategoryContentProps) {
  switch (category.editor) {
    case "statuses":
      return (
        <VocabularyList
          target="statuses"
          rows={statusRows(settings.statuses)}
          usage={settings.usage.statuses}
          categories={settings.categories}
          requiredCategories={settings.requiredCategories}
          write={(ops) => applyTo("statuses", ops)}
          onDirtyChange={onDirtyChange}
        />
      );
    case "kinds":
      return (
        <VocabularyList
          target="kinds"
          rows={kindRows(settings.kinds)}
          usage={settings.usage.kinds}
          write={(ops) => applyTo("kinds", ops)}
          onDirtyChange={onDirtyChange}
        />
      );
    case "fields":
      return (
        <FieldsForm
          definitions={settings.registry.definitions.filter((d) => d.category === category.id)}
          settings={settings}
          write={(ops) => applyTo("settings", ops)}
          onDirtyChange={onDirtyChange}
        />
      );
  }
}
