/**
 * A registry-driven category renders real controls — R6c (STA-178), for R6d to use.
 *
 * The fixture registers one definition per value schema in a category this build has
 * never heard of, and none of them are named anywhere in FieldsForm: a boolean is a
 * switch, an integer a number field with its bounds, a string a text field, an enum a
 * select with the registry's values. Each sits in a Field with its label, description,
 * scope tag and source. A global definition renders disabled with the sentence that
 * names its real write path. Rendered with `react-dom/server`, as the neighbours are.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SEED_SETTINGS,
  type SettingCategoryView,
  type SettingDefinitionView,
  type WorkspaceSettingsEnvelope,
} from "@/lib/settings";
import { CategoryContent } from "./CategoryContent";
import { FieldsForm } from "./FieldsForm";

/** The first button whose opening tag contains `marker` (an attribute, or the text right after the tag). */
function buttonTag(html: string, marker: string): string {
  const match = html.match(new RegExp(`<button[^>]*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^>]*>`));
  if (!match) throw new Error(`no button for ${marker}`);
  return match[0];
}
const isDisabled = (tag: string) => tag.includes(' disabled=""');

const definition = (key: string, over: Partial<SettingDefinitionView>): SettingDefinitionView => ({
  key,
  category: "workflow",
  scope: "workspace",
  schema: { type: "boolean" },
  default: false,
  version: 1,
  sensitivity: "normal",
  ui: { label: key, description: `About ${key}.`, control: "toggle", order: 0 },
  ...over,
});

const DEFINITIONS: SettingDefinitionView[] = [
  definition("queue.policy", {
    schema: { type: "enum", values: ["advisory", "strict"] },
    default: "advisory",
    ui: { label: "Queue policy", description: "How pickup order is enforced.", control: "select", order: 0 },
  }),
  definition("workflow.fixture", {
    ui: { label: "Fixture toggle", description: "A second control, to prove there is no conditional.", control: "toggle", order: 1 },
  }),
  definition("workflow.limit", {
    schema: { type: "integer", min: 1, max: 10 },
    default: 3,
    ui: { label: "Limit", description: "How many.", control: "number", order: 2 },
  }),
  definition("workflow.prefix", {
    schema: { type: "string", pattern: "^[a-z]+$", patternHint: "Lowercase letters only." },
    default: "sta",
    ui: { label: "Prefix", description: "The identifier prefix.", control: "text", order: 3 },
  }),
  definition("machine.browser", {
    scope: "global",
    schema: { type: "string" },
    default: "",
    ui: { label: "Browser", description: "What opens the UI.", control: "text", order: 4 },
  }),
];

const envelope: WorkspaceSettingsEnvelope = {
  ...SEED_SETTINGS,
  registry: { categories: [], definitions: DEFINITIONS },
  values: {
    "queue.policy": { key: "queue.policy", scope: "workspace", value: "strict", source: "workspace", version: 1 },
  },
  unknownKeys: [],
  global: {
    path: "/home/vp/.staple/config.json",
    present: true,
    values: { "machine.browser": { key: "machine.browser", scope: "global", value: "firefox", source: "config", version: 1 } },
  },
};

const html = renderToStaticMarkup(<FieldsForm definitions={DEFINITIONS} settings={envelope} write={async () => null} />);

describe("controls come from the value schema", () => {
  it("an enum is a select (the value it shows is `shownValue`, pinned in fields-draft.test.ts)", () => {
    // Radix renders the selected item's text only once mounted, so a static render
    // proves the control and its wiring, not the text inside it.
    expect(html).toMatch(/<button[^>]*role="combobox"[^>]*id="setting-queue\.policy"[^>]*aria-describedby="setting-queue\.policy-description"/);
  });

  it("a boolean is a switch", () => {
    expect(html).toMatch(/<input[^>]*id="setting-workflow\.fixture"[^>]*type="checkbox"[^>]*role="switch"/);
    expect(html).toContain(">Off<");
  });

  it("an integer is a number field with the schema's bounds and the default", () => {
    expect(html).toMatch(/<input type="number"[^>]*id="setting-workflow\.limit"[^>]*min="1"[^>]*max="10"[^>]*value="3"/);
  });

  it("a string is a text field whose description carries the pattern hint", () => {
    expect(html).toMatch(/<input type="text"[^>]*id="setting-workflow\.prefix"[^>]*value="sta"/);
    expect(html).toContain("The identifier prefix. Lowercase letters only.");
  });
});

describe("every field says where its value lives", () => {
  it("a stored workspace value is tagged Workspace · workspace; an untouched one Workspace · default", () => {
    expect(html).toMatch(/data-settings-field="setting-queue\.policy"[\s\S]*?data-scope-tag="workspace"[^>]*>Workspace<span[^>]*> · workspace<\/span>/);
    expect(html).toMatch(/data-settings-field="setting-workflow\.limit"[\s\S]*?data-scope-tag="workspace"[^>]*>Workspace<span[^>]*> · default<\/span>/);
  });

  it("a global definition is tagged Global, disabled, and names staple config set", () => {
    expect(html).toMatch(/data-settings-field="setting-machine\.browser"[\s\S]*?data-scope-tag="global"/);
    expect(html).toMatch(/<input[^>]*id="setting-machine\.browser"[^>]*disabled=""/);
    expect(html).toContain("Global settings are edited with `staple config set`.");
    expect(html).not.toContain('aria-label="Reset Browser to default"');
  });

  it("offers a per-field Reset only where there is something to reset", () => {
    expect(isDisabled(buttonTag(html, 'aria-label="Reset Queue policy to default"'))).toBe(false);
    expect(isDisabled(buttonTag(html, 'aria-label="Reset Limit to default"'))).toBe(true);
  });
});

describe("the form is a Section with an ActionBar", () => {
  it("is clean on first render, with Reset to defaults available because a value is stored", () => {
    expect(html).toContain('data-settings-section="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
    expect(isDisabled(buttonTag(html, ">Reset to defaults<"))).toBe(false);
  });

  it("says so when a category has nothing registered", () => {
    const empty = renderToStaticMarkup(<FieldsForm definitions={[]} settings={envelope} write={async () => null} />);
    expect(empty).toContain("Nothing is registered in this category yet.");
  });
});

/**
 * R6d (STA-179) — the Workflow category, through the shell's one extension point.
 *
 * `CategoryContent` is handed the category the registry served and the envelope, and
 * picks the editor from the category's `editor` alone. The definitions below mirror the
 * REGISTERED `queue.policy` (test/settings-registry.test.ts pins the registry side; this
 * pins the render side) plus one fixture toggle in the same category that no build has
 * ever registered — the ticket's "adding a second toggle requires no shell conditional",
 * proved twice: both controls render, and none of the shell's files names either key.
 */
describe("the Workflow category renders from registry metadata alone", () => {
  const QUEUE_POLICY: SettingDefinitionView = definition("queue.policy", {
    category: "queue",
    schema: { type: "enum", values: ["advisory", "strict"] },
    default: "advisory",
    ui: {
      label: "Queue policy",
      description:
        "How the pickup queue binds agents. advisory: the queue orders and explains, and a checkout is never refused for order. " +
        "strict: an agent's checkout of a later item is refused (out_of_order, exit 10) while an earlier eligible item exists, and the refusal names what to take instead.",
      control: "select",
      order: 10,
    },
  });
  const FIXTURE_TOGGLE: SettingDefinitionView = definition("queue.fixtureToggle", {
    category: "queue",
    ui: { label: "Fixture toggle", description: "Registered by this test only.", control: "toggle", order: 20 },
  });
  const workflow: SettingCategoryView = {
    id: "queue",
    label: "Workflow",
    description: "How agents pick work up from this workspace's queue.",
    scope: "workspace",
    editor: "fields",
    order: 30,
  };
  const served: WorkspaceSettingsEnvelope = {
    ...SEED_SETTINGS,
    registry: { categories: [workflow], definitions: [QUEUE_POLICY, FIXTURE_TOGGLE] },
    values: {},
    unknownKeys: [],
    global: { path: "/home/vp/.staple/config.json", present: false, values: {} },
  };
  const page = renderToStaticMarkup(
    <CategoryContent category={workflow} settings={served} applyTo={async () => null} onDirtyChange={() => {}} />,
  );

  it("renders the queue policy as a select with its side effect stated before Save, and the scope beside it", () => {
    expect(page).toMatch(/<button[^>]*role="combobox"[^>]*id="setting-queue\.policy"/);
    expect(page).toContain("strict: an agent&#x27;s checkout of a later item is refused (out_of_order, exit 10)");
    expect(page).toMatch(/data-settings-field="setting-queue\.policy"[\s\S]*?data-scope-tag="workspace"[^>]*>Workspace<span[^>]*> · default<\/span>/);
    // The description precedes the action bar in the document, so a reader meets it before Save.
    expect(page.indexOf("strict: an agent")).toBeLessThan(page.indexOf(">Save changes<"));
  });

  it("renders a second fixture toggle in the same category with no shell change", () => {
    expect(page).toMatch(/<input[^>]*id="setting-queue\.fixtureToggle"[^>]*type="checkbox"[^>]*role="switch"/);
    expect(page).toContain("Registered by this test only.");
  });

  it("none of the shell's files names the setting or its category", () => {
    for (const file of ["SettingsShell.tsx", "CategoryContent.tsx", "FieldsForm.tsx", "SettingsDialog.tsx", "SettingsMount.tsx"]) {
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
      // The prose may cite the ticket; the code may not branch on the key or the category id.
      expect(source, file).not.toMatch(/["'`]queue(\.policy)?["'`]/);
      expect(source, file).not.toMatch(/advisory|strict/);
    }
  });
});
