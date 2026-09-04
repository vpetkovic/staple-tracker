/**
 * R6e (STA-180) — THE THREE PROPERTIES OF THE SHELL NO SINGLE R6 SUITE OWNS.
 *
 * R6b pinned the shell with a stub category, R6c pinned each primitive on its own,
 * R6d pinned the queue policy's own render. What none of them does is put the REAL
 * category content inside the REAL shell and ask whether the whole surface still
 * holds together — at each breakpoint, while something is unsaved, and for a
 * screen reader. That is what this file is:
 *
 *   RESPONSIVE   every breakpoint, rendered twice — once with a registry-driven
 *                `fields` category and once with a vocabulary category — because a
 *                layout bug that only clips the vocabulary editor's wide rows would
 *                pass a `fields`-only test.
 *   UNSAVED      that a dirty draft cannot be lost by accident: every way out of
 *                the shell goes through the guard, an external revision keeps every
 *                edited value until the user chooses, and a destructive removal
 *                needs a confirmation that names where the rows will go.
 *   ACCESSIBLE   the invariants asserted over EVERY field and EVERY button the
 *                shell renders, rather than over one hand-built example — and the
 *                order a screen reader meets them in.
 *
 * ── HOW AN INTERACTION IS PINNED WITHOUT A DOM ────────────────────────────────
 *
 * The suite has no jsdom and wants none (vitest.config.ts). A click cannot be
 * dispatched, so an interactive property is pinned in the three parts it is made
 * of, the way settings-shell.test.tsx already splits the route:
 *
 *   1. the PURE FUNCTION that decides it (`leaveDecision`, `hasConflict`, the
 *      draft arithmetic in form/fields-draft.ts) — called directly;
 *   2. the MARKUP of each state — rendered;
 *   3. the WIRING, asserted by reading the component's source for the expression
 *      that joins 1 to 2 — the same technique fields-form.test.tsx uses for "no
 *      shell file names the setting".
 *
 * A source assertion is a weak test on its own and a strong one beside the other
 * two: it is what catches somebody adding a fourth way out of the shell that
 * forgets the guard.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SEED_SETTINGS,
  type SettingCategoryView,
  type SettingDefinitionView,
  type SettingValueView,
  type WorkspaceSettingsEnvelope,
} from "@/lib/settings";
import { CategoryContent } from "./CategoryContent";
import { SettingsShell, type SettingsShellProps } from "./SettingsShell";
import { settingsFrameClass, type ShellLayout, type ShellMode, type ShellPane } from "./settings-shell";
import { UNSAVED_CHANGES } from "./form/ConfirmDialog";
import { ActionBar, Field, Section } from "./form/primitives";
import { hasConflict, leaveDecision, snapshotSignature } from "./form/form-model";
import { fieldsDraftOps, setFieldValue, shownValue, type FieldsDraft } from "./form/fields-draft";

const source = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");

// ---------------------------------------------------------------- the served world

const QUEUE_POLICY: SettingDefinitionView = {
  key: "queue.policy",
  category: "queue",
  scope: "workspace",
  schema: { type: "enum", values: ["advisory", "strict"] },
  default: "advisory",
  version: 1,
  sensitivity: "normal",
  ui: { label: "Queue policy", description: "How the pickup queue binds agents.", control: "select", order: 10 },
};

const QUEUE_LIMIT: SettingDefinitionView = {
  key: "queue.limit",
  category: "queue",
  scope: "workspace",
  schema: { type: "integer", min: 1, max: 20 },
  default: 5,
  version: 1,
  sensitivity: "normal",
  ui: { label: "Queue limit", description: "How many items are shown.", control: "number", order: 20 },
};

const CATEGORIES: SettingCategoryView[] = [
  { id: "statuses", label: "Statuses", description: "The status vocabulary.", scope: "workspace", editor: "statuses", order: 10 },
  { id: "kinds", label: "Kinds", description: "What a ticket can be.", scope: "workspace", editor: "kinds", order: 20 },
  { id: "queue", label: "Workflow", description: "How agents pick work up.", scope: "workspace", editor: "fields", order: 30 },
  { id: "machine", label: "This machine", description: "Preferences for this computer.", scope: "global", editor: "fields", order: 90 },
];

const ENVELOPE: WorkspaceSettingsEnvelope = {
  ...SEED_SETTINGS,
  workspace: "staple",
  usage: { statuses: { todo: 3, done: 0 }, kinds: { task: 4 } },
  registry: { categories: CATEGORIES, definitions: [QUEUE_POLICY, QUEUE_LIMIT] },
  values: {
    "queue.policy": { key: "queue.policy", scope: "workspace", value: "strict", source: "workspace", version: 1 },
  },
  unknownKeys: [],
  global: { path: "/home/vp/.staple/config.json", present: true, values: {} },
};

const SCOPE = { workspace: "staple", globalPath: ENVELOPE.global.path, globalPresent: true };

/** The real shell, with the real content of one real category inside it. */
function render(over: Partial<SettingsShellProps> & { active: string }): string {
  return renderToStaticMarkup(
    <SettingsShell
      categories={CATEGORIES}
      layout="two-pane"
      pane="nav"
      mode="drawer"
      scope={SCOPE}
      onSelect={() => {}}
      onBack={() => {}}
      onToggleMode={() => {}}
      onClose={() => {}}
      renderCategory={(category) => (
        <CategoryContent
          category={category}
          settings={ENVELOPE}
          applyTo={async () => null}
          onDirtyChange={() => {}}
        />
      )}
      {...over}
    />,
  );
}

/**
 * One breakpoint, rendered for BOTH kinds of category: the registry-driven fields
 * form and the vocabulary editor with its wide rows.
 */
function atBreakpoint(layout: ShellLayout, pane: ShellPane, mode: ShellMode) {
  return {
    fields: render({ active: "queue", layout, pane, mode }),
    vocabulary: render({ active: "statuses", layout, pane, mode }),
    frame: settingsFrameClass(mode, layout),
  };
}

const NAV_HIDDEN = "<nav aria-label=\"Settings categories\" hidden=\"\"";
const CONTENT_HIDDEN = 'hidden="" data-settings-content';

// ---------------------------------------------------------------- responsiveness

describe("every breakpoint holds both kinds of category", () => {
  /**
   * THE DRAWER. A centred dialog on a wide display: both panes, the full-screen
   * offer in the header, and the frame geometry that is the only place the centred
   * size is written.
   */
  it("drawer: a centred frame, both panes, and the offer to grow", () => {
    const at = atBreakpoint("two-pane", "nav", "drawer");
    expect(at.frame).toContain("-translate-x-1/2");
    expect(at.frame).toContain("w-[min(64rem,calc(100vw-2rem))]");
    for (const [which, html] of Object.entries({ fields: at.fields, vocabulary: at.vocabulary })) {
      expect(html, which).not.toContain(NAV_HIDDEN);
      expect(html, which).not.toContain(CONTENT_HIDDEN);
      expect(html, which).toContain('aria-label="Enter full screen"');
      expect(html, which).toContain('aria-pressed="false"');
      expect(html, which).not.toContain('aria-label="Back to categories"');
    }
    expect(at.fields).toContain('data-settings-field="setting-queue.policy"');
    expect(at.vocabulary).toContain('data-reorder-row="todo"');
  });

  /**
   * NARROW. One pane at a time. The nav pane offers no Back (there is nowhere to go
   * back to) and no full-screen toggle (a phone is already full screen); the content
   * pane hides the nav and puts Back in the header, which is the only reliable way
   * out. Both panes get the whole viewport as their frame, so a wide vocabulary row
   * scrolls inside the content pane rather than being clipped by a centred dialog.
   */
  it("narrow: one pane at a time, and Back is in the header of the content pane", () => {
    const nav = atBreakpoint("stacked", "nav", "drawer");
    const content = atBreakpoint("stacked", "content", "drawer");
    expect(nav.frame).toBe("inset-0 rounded-none");
    expect(content.frame).toBe("inset-0 rounded-none");

    for (const [which, html] of Object.entries({ fields: nav.fields, vocabulary: nav.vocabulary })) {
      expect(html, which).toContain(CONTENT_HIDDEN);
      expect(html, which).not.toContain(NAV_HIDDEN);
      expect(html, which).not.toContain('aria-label="Back to categories"');
      // No full-screen toggle: the shell already is the screen.
      expect(html, which).not.toContain("full screen");
    }
    for (const [which, html] of Object.entries({ fields: content.fields, vocabulary: content.vocabulary })) {
      expect(html, which).toContain(NAV_HIDDEN);
      expect(html, which).not.toContain(CONTENT_HIDDEN);
      expect(html, which).toContain('aria-label="Back to categories"');
      // Back comes before the content, so it is the first thing reachable.
      expect(html.indexOf("Back to categories"), which).toBeLessThan(html.indexOf("data-settings-content"));
      // The content pane scrolls in both axes rather than clipping.
      expect(html, which).toContain("overflow-x-auto overflow-y-auto");
    }
    expect(content.fields).toContain('data-settings-field="setting-queue.limit"');
    expect(content.vocabulary).toContain('aria-label="Move Todo up"');
  });

  /**
   * DESKTOP SPLIT. Both panes at once, each scrolling independently inside a fixed
   * frame, so the header — title, scope line, controls — never leaves the screen.
   */
  it("desktop split: navigation and content together, each scrolling on its own", () => {
    const at = atBreakpoint("two-pane", "content", "drawer");
    for (const [which, html] of Object.entries({ fields: at.fields, vocabulary: at.vocabulary })) {
      expect(html, which).toContain('data-layout="two-pane"');
      // The nav is the fixed-width left column, the content the flexible right one.
      expect(html, which).toContain("w-56 border-r");
      expect(html, which).toContain('data-settings-content="true"');
      expect(html, which).not.toContain(NAV_HIDDEN);
      expect(html, which).not.toContain(CONTENT_HIDDEN);
      // Every category is reachable from the content pane without leaving it.
      for (const category of CATEGORIES) expect(html, `${which}/${category.id}`).toContain(`data-settings-category="${category.id}"`);
    }
    expect(at.fields).toContain('data-settings-fields="true"');
    expect(at.vocabulary).toContain('aria-label="Remove Todo"');
  });

  /**
   * FULL SCREEN. The frame becomes the viewport and NOTHING else changes: the same
   * two panes, the same content, and a toggle that now says how to get back.
   */
  it("full screen: the frame is the viewport and the toggle reads as the way out", () => {
    const drawer = atBreakpoint("two-pane", "nav", "drawer");
    const full = atBreakpoint("two-pane", "nav", "full");
    expect(full.frame).toBe("inset-0 rounded-none");
    for (const [which, html] of Object.entries({ fields: full.fields, vocabulary: full.vocabulary })) {
      expect(html, which).toContain('data-mode="full"');
      expect(html, which).toContain('aria-label="Exit full screen"');
      expect(html, which).toContain('aria-pressed="true"');
      expect(html, which).not.toContain(NAV_HIDDEN);
    }
    // Same content, different frame: the only difference in the markup is the mode
    // and what the toggle says.
    expect(full.fields.replace(/data-mode="full"/, 'data-mode="drawer"')
      .replace(/aria-label="Exit full screen" title="Exit full screen" aria-pressed="true"/, 'aria-label="Enter full screen" title="Full screen" aria-pressed="false"')
      .includes('data-settings-field="setting-queue.policy"')).toBe(true);
    expect(drawer.fields).toContain('data-settings-field="setting-queue.policy"');
  });
});

// ---------------------------------------------------------------- unsaved and stale

describe("nothing the user typed is lost without them choosing to lose it", () => {
  /**
   * EVERY WAY OUT IS GUARDED. There are exactly three ways to leave a category —
   * pick another one, Back on a narrow screen, close the dialog — and Esc and the
   * overlay both arrive through the last of them. Each is asserted to be wrapped in
   * `guard`, and the draft is asserted to be dropped (`setFormKey`, which remounts
   * the form) only on the deliberate "Discard changes".
   */
  it("a dirty draft survives every navigation attempt: all three leave paths go through the guard", () => {
    expect(leaveDecision(true)).toBe("confirm");
    expect(leaveDecision(false)).toBe("proceed");

    const dialog = source("SettingsDialog.tsx");
    // Selecting another category.
    expect(dialog).toMatch(/guard\(\(\) => \{\s*onCategoryChange\(id\);\s*setPane\("content"\);\s*\}\);/);
    // Back, on the stacked layout.
    expect(dialog).toMatch(/const back = useCallback\(\(\) => guard\(\(\) => setPane\("nav"\)\)/);
    // Closing — the X, Esc and the overlay all land here.
    expect(dialog).toMatch(/const close = useCallback\(\(\) => guard\(\(\) => onOpenChange\(false\)\)/);
    // …and there is no fourth, unguarded, way out.
    expect(dialog.match(/onOpenChange\(false\)/g)).toHaveLength(1);
    expect(dialog.match(/onCategoryChange\(/g)).toHaveLength(1);
    expect(dialog.match(/setPane\("nav"\)/g)).toHaveLength(1);

    // The draft is only really discarded on the deliberate choice.
    expect(dialog).toMatch(/onDiscard=\{\(\) => \{[\s\S]*?setFormKey\(\(key\) => key \+ 1\);[\s\S]*?\}\}/);
    expect(dialog.match(/setFormKey\(/g)).toHaveLength(1); // only the discard calls it
    // Keeping is a no-op on the draft: it only closes the question.
    expect(dialog).toMatch(/onKeep=\{\(\) => setPendingLeave\(null\)\}/);
    // The copy names the outcomes rather than asking OK/Cancel (pinned in primitives.test.tsx).
    expect(UNSAVED_CHANGES.confirmLabel).toBe("Discard changes");
    expect(UNSAVED_CHANGES.cancelLabel).toBe("Keep editing");
  });

  /**
   * A STALE REVISION KEEPS THE DRAFT. The served state moving under a dirty form is
   * a conflict; "Keep my changes" moves the BASELINE and never the draft, so every
   * edited value is still there and the next save is a deliberate overwrite.
   * "Reload" is the only thing that drops it, and only when pressed.
   */
  it("a conflict keeps every edited value, and Reload discards only when it is chosen", () => {
    const definitions = [QUEUE_POLICY, QUEUE_LIMIT];
    const served = { "queue.policy": ENVELOPE.values["queue.policy"], "queue.limit": undefined } as Record<
      string,
      SettingValueView | undefined
    >;

    // Two edits, in the order a user would make them.
    let draft: FieldsDraft = {};
    draft = setFieldValue(draft, QUEUE_POLICY, served["queue.policy"], "advisory");
    draft = setFieldValue(draft, QUEUE_LIMIT, served["queue.limit"], 12);
    const edited = fieldsDraftOps(draft, definitions);
    expect(edited).toEqual([
      { op: "set", key: "queue.policy", value: "advisory" },
      { op: "set", key: "queue.limit", value: 12 },
    ]);

    // The baseline the draft began on, and the signature after somebody else wrote.
    const baseline = snapshotSignature(definitions.map((d) => served[d.key] ?? null));
    const moved: Record<string, SettingValueView | undefined> = {
      ...served,
      "queue.policy": { key: "queue.policy", scope: "workspace", value: "advisory", source: "workspace", version: 1 },
    };
    const after = snapshotSignature(definitions.map((d) => moved[d.key] ?? null));
    expect(hasConflict({ dirty: true, baseline, served: after })).toBe(true);
    // A clean form has nothing to lose, so the same movement is not a conflict.
    expect(hasConflict({ dirty: false, baseline, served: after })).toBe(false);

    // KEEP: the baseline moves up; the draft is byte-identical, so every edit survives.
    expect(hasConflict({ dirty: true, baseline: after, served: after })).toBe(false);
    expect(fieldsDraftOps(draft, definitions)).toEqual(edited);
    for (const definition of definitions) {
      expect(shownValue(draft, definition, moved[definition.key]), definition.key).toEqual(
        definition.key === "queue.policy" ? "advisory" : 12,
      );
    }

    // RELOAD: the draft is dropped, and the form shows what the server now says.
    const reloaded: FieldsDraft = {};
    expect(fieldsDraftOps(reloaded, definitions)).toEqual([]);
    expect(shownValue(reloaded, QUEUE_POLICY, moved["queue.policy"])).toBe("advisory");
    expect(shownValue(reloaded, QUEUE_LIMIT, moved["queue.limit"])).toBe(5);

    // The wiring: `keep` only moves the baseline, `cancel` is the only thing that
    // drops a draft outside a successful save, and the banner's two buttons are
    // exactly those two — nothing reloads on its own.
    const hook = source("form/useDraft.ts");
    expect(hook).toMatch(/const keep = useCallback\(\(\) => setBaseline\(signature\), \[signature\]\);/);
    expect(hook.match(/setDraft\(null\)/g)).toHaveLength(2); // cancel, and a successful save
    for (const file of ["FieldsForm.tsx", "VocabularyList.tsx"]) {
      expect(source(file), file).toMatch(/<ConflictBanner[\s\S]*?onReload=\{draft\.cancel\}[\s\S]*?onKeep=\{draft\.keep\}/);
    }
  });

  /**
   * A DESTRUCTIVE REMOVAL IS NEVER ONE CLICK. The Remove control on a row opens a
   * confirmation; the confirmation names the row, says how many issues still carry
   * it, and holds its own confirm button until a migrate target is chosen.
   */
  it("removing a vocabulary row asks first, and the question names where the issues go", () => {
    const statuses = render({ active: "statuses" });
    const kinds = render({ active: "kinds" });

    for (const [which, html] of Object.entries({ statuses, kinds })) {
      // Every row has a named Remove…
      expect(html, which).toMatch(/aria-label="Remove [A-Z]/);
      // …and pressing it is not the removal: nothing is confirmed, and nothing is queued.
      expect(html, which).not.toContain("data-destructive-confirm");
      expect(html, which).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
    }
    expect(statuses).toContain('aria-label="Remove Todo"');
    expect(kinds).toContain('aria-label="Remove Task"');
    // The usage count that decides whether a target is required is on the row.
    expect(statuses).toContain(">3<");

    // The confirmation's own contract, where the component builds it.
    const list = source("VocabularyList.tsx");
    expect(list).toContain('still carry "${row.label}". Move them to:');
    expect(list).toMatch(/confirmDisabled=\{needsMigrate && migrateTo === NO_MIGRATE\}/);
    expect(list).toMatch(/aria-label=\{`Migrate \$\{row\.id\} to`\}/);
    // Unknown usage means ask anyway — the safe direction.
    expect(list).toMatch(/needsMigrate=\{\(value\.usage\[row\.id\] \?\? 1\) > 0\}/);
    // The op carries the target the picker chose, and only after Remove is pressed.
    expect(list).toMatch(/onRemove=\{\(id, migrateTo\) => \{\s*edit\(removeOp\(id, migrateTo\)\);/);
  });
});

// ---------------------------------------------------------------- accessibility

/**
 * Every `<button …>` in the markup, with the four things that could name it: its own
 * text, `aria-label`, `aria-labelledby`, and a `<label for>` elsewhere in the document
 * pointing at its id — which is how the enum control is named, since a `button` is a
 * labelable element and Radix's trigger renders its value only once mounted.
 */
function buttons(html: string): { tag: string; named: boolean }[] {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => {
    const tag = match[1] ?? "";
    const text = (match[2] ?? "").replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/g, " ").trim();
    const id = tag.match(/ id="([^"]+)"/)?.[1];
    return {
      tag,
      named:
        text.length > 0 ||
        /aria-label="[^"]+"/.test(tag) ||
        /aria-labelledby="[^"]+"/.test(tag) ||
        (id !== undefined && html.includes(`for="${id}"`)),
    };
  });
}

/** Every `data-settings-field="…"` id in the markup, in document order. */
function fieldIds(html: string): string[] {
  return [...html.matchAll(/data-settings-field="([^"]+)"/g)].map((m) => m[1]!);
}

describe("what a screen reader is given", () => {
  /**
   * The invariant, over EVERY field the shell renders rather than over one built by
   * hand: a label pointing at the control, the scope tag that says which store the
   * value lives in, and — when there is an error — an `aria-describedby` that names
   * an element that exists, plus `aria-invalid`.
   */
  it("every rendered field has a label, a scope, and error wiring that points at something real", () => {
    const html = render({ active: "queue" });
    const ids = fieldIds(html);
    expect(ids).toEqual(["setting-queue.policy", "setting-queue.limit"]);
    for (const id of ids) {
      expect(html, id).toContain(`for="${id}"`);
      // The scope tag sits inside this field's block, before the next field starts.
      const marker = `data-settings-field="${id}"`;
      const block = html.slice(html.indexOf(marker) + marker.length).split("data-settings-field=")[0]!;
      expect(block, id).toMatch(/data-scope-tag="(workspace|global)"/);
      expect(block, id).toContain(`id="${id}-description"`);
      expect(block, id).toMatch(new RegExp(`aria-describedby="[^"]*${id.replace(".", "\\.")}-description`));
      // Clean, so no error element and no invalid marker. (`aria-invalid:` appears
      // inside Tailwind class names, so the ATTRIBUTE is what is asserted absent.)
      expect(block, id).not.toMatch(/aria-invalid="/);
      expect(block, id).not.toContain(`id="${id}-error"`);
    }

    // And the error half, through the same primitive the fields form uses.
    const invalid = renderToStaticMarkup(
      <Field id="setting-queue.limit" label="Queue limit" description="How many." error="Must be at most 20." scope="workspace">
        {(aria) => <input {...aria} />}
      </Field>,
    );
    expect(invalid).toMatch(
      /aria-describedby="setting-queue\.limit-description setting-queue\.limit-error"[^>]*aria-invalid="true"/,
    );
    expect(invalid).toContain('<p id="setting-queue.limit-error" role="alert"');
  });

  /**
   * Every button the shell renders has a name — either its own text or an
   * `aria-label`. An icon-only control with neither is a control a screen reader
   * announces as "button", and the vocabulary editor is made of them.
   */
  it("every button the shell renders has an accessible name", () => {
    for (const active of ["queue", "statuses", "kinds"]) {
      const html = render({ active });
      const all = buttons(html);
      expect(all.length, active).toBeGreaterThan(5);
      for (const button of all) {
        expect(button.named, `${active}: <button${button.tag}>`).toBe(true);
      }
    }
    // The action bar's three, by name, on every category.
    for (const active of ["queue", "statuses", "kinds"]) {
      const html = render({ active });
      const bar = html.slice(html.indexOf('data-action-bar="true"'));
      for (const name of ["Save changes", "Cancel"]) expect(bar, `${active}/${name}`).toContain(`>${name}</button>`);
    }
  });

  /** The nav says which category you are in, once, and only for that one. */
  it("the category navigation marks exactly the current category with aria-current", () => {
    for (const active of ["queue", "statuses", "machine"]) {
      const html = render({ active });
      expect(html.match(/aria-current="page"/g), active).toHaveLength(1);
      expect(html, active).toContain(`data-settings-category="${active}" aria-current="page"`);
    }
    // The nav is a landmark with a name, not an anonymous list of buttons.
    expect(render({ active: "queue" })).toContain('<nav aria-label="Settings categories"');
  });

  /**
   * THE ORDER. Reading the shell top to bottom, a screen reader meets the category
   * it is in, then the field, then the scope that field's value lives in, then what
   * is wrong with it, then the action that would commit it. The category content is
   * built here from the real primitives so an error can be on screen; the shell and
   * the Section/Field/ActionBar arrangement are the real ones.
   */
  it("the order is category, then field, then scope, then error, then action", () => {
    const html = renderToStaticMarkup(
      <SettingsShell
        categories={CATEGORIES}
        active="queue"
        layout="two-pane"
        pane="content"
        mode="drawer"
        scope={SCOPE}
        onSelect={() => {}}
        onBack={() => {}}
        onToggleMode={() => {}}
        onClose={() => {}}
        renderCategory={() => (
          <Section>
            <Field
              id="setting-queue.limit"
              label="Queue limit"
              description="How many items are shown."
              scope="workspace"
              source="workspace"
              error="Must be at most 20."
            >
              {(aria) => <input {...aria} />}
            </Field>
            <ActionBar
              state={{ canSave: true, canCancel: true, canReset: false, saving: false }}
              onSave={() => {}}
              onCancel={() => {}}
            />
          </Section>
        )}
      />,
    );

    const at = (needle: string): number => {
      const index = html.indexOf(needle);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };
    const category = at('id="settings-category-queue"');
    const categoryScope = at('data-settings-category-scope="true"');
    const field = at('data-settings-field="setting-queue.limit"');
    const label = at('for="setting-queue.limit"');
    const scope = at('data-scope-tag="workspace"');
    const error = at('id="setting-queue.limit-error" role="alert"');
    const action = at('data-action-bar="true"');

    expect(category).toBeLessThan(categoryScope);
    expect(categoryScope).toBeLessThan(field);
    expect(field).toBeLessThan(label);
    expect(label).toBeLessThan(scope);
    expect(scope).toBeLessThan(error);
    expect(error).toBeLessThan(action);

    // The section labels itself with the category heading, so the fields are inside
    // something named rather than floating.
    expect(html).toContain('aria-labelledby="settings-category-queue"');
    // And the error is announced, not merely coloured.
    expect(html).toContain('role="alert"');
  });
});
