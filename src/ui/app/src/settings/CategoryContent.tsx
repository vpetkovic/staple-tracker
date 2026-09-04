/**
 * WHAT A CATEGORY SHOWS — R6b (STA-177). The shell's one extension point.
 *
 * The shell enumerates categories and never looks inside one; this is the file that
 * does. It switches on the registry's `editor` — the one field a category carries to
 * say what kind of surface it needs — so a new `fields` category registered in
 * src/core/settings-registry.ts renders here with no edit to the shell, and a future
 * bespoke editor is one more arm of this switch rather than a conditional in the nav.
 *
 * Statuses and Kinds are the existing `VocabularyList`, unchanged, on the same `applyTo`
 * write path they had before the shell existed. R6c (STA-178) moves them onto the shared
 * form primitives; nothing here anticipates that.
 *
 * `fields` categories are read-only in this pass: the definitions the registry serves,
 * each with its effective value and where that value came from. R6d (STA-179) replaces
 * the value column with controls. Showing the definitions now — rather than an empty
 * pane — is what proves "the shell hosts a category it was not written for".
 */
import type { SettingCategoryView } from "@/lib/settings";
import { settingDefinitions, settingValue } from "@/lib/settings";
import type { Refusal } from "@/lib/refusal";
import type { VocabularyOp, WorkspaceSettings } from "@/lib/types";
import { VocabularyList } from "./VocabularyList";
import { kindRows, statusRows } from "./settings-ops";

export interface CategoryContentProps {
  category: SettingCategoryView;
  settings: WorkspaceSettings;
  applyTo: (target: "statuses" | "kinds", ops: VocabularyOp[]) => Promise<boolean>;
  refusal: Refusal | null;
  busy: boolean;
}

export function CategoryContent({ category, settings, applyTo, refusal, busy }: CategoryContentProps) {
  switch (category.editor) {
    case "statuses":
      return (
        <VocabularyList
          target="statuses"
          rows={statusRows(settings.statuses)}
          usage={settings.usage.statuses}
          categories={settings.categories}
          requiredCategories={settings.requiredCategories}
          apply={(ops) => applyTo("statuses", ops)}
          refusal={refusal}
          busy={busy}
        />
      );
    case "kinds":
      return (
        <VocabularyList
          target="kinds"
          rows={kindRows(settings.kinds)}
          usage={settings.usage.kinds}
          apply={(ops) => applyTo("kinds", ops)}
          refusal={refusal}
          busy={busy}
        />
      );
    case "fields":
      return <FieldsPreview category={category.id} />;
  }
}

/** The effective value, printed. `redacted` values say so rather than printing nothing. */
function printValue(key: string): string {
  const view = settingValue(key);
  if (!view) return "—";
  if (view.redacted) return "(hidden)";
  return `${String(view.value)} · ${view.source}`;
}

function FieldsPreview({ category }: { category: string }) {
  const definitions = settingDefinitions(category);
  if (definitions.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing is registered in this category yet.</p>;
  }
  return (
    <dl data-settings-fields className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
      {definitions.map((definition) => (
        <div key={definition.key} className="contents">
          <dt className="min-w-0">
            <div className="font-medium">{definition.ui.label}</div>
            <div className="text-muted-foreground text-xs">{definition.ui.description}</div>
          </dt>
          <dd className="text-muted-foreground m-0 text-right font-mono text-xs whitespace-nowrap">
            {printValue(definition.key)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
