/**
 * "Statuses and Kinds retain every current operation" — R6c (STA-178), rendered.
 *
 * `react-dom/server`, as settings-shell.test.tsx: what this pins is that every control
 * the editors had before the migration is still in the markup — a drag handle, a label
 * field, a category select (statuses only), labelled move buttons, a Remove, the add
 * form with its id validation — now inside the shared Section, with the ActionBar
 * beneath it and no per-edit write. The draft arithmetic behind those controls is
 * form/vocabulary-draft.test.ts; the keyboard path is form/primitives.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VocabularyList } from "./VocabularyList";
import { kindRows, statusRows } from "./settings-ops";
import { SEED_SETTINGS } from "@/lib/settings";

const write = async () => null;

const statuses = renderToStaticMarkup(
  <VocabularyList
    target="statuses"
    rows={statusRows(SEED_SETTINGS.statuses)}
    usage={{ todo: 3, done: 0 }}
    categories={SEED_SETTINGS.categories}
    requiredCategories={SEED_SETTINGS.requiredCategories}
    write={write}
  />,
);

const kinds = renderToStaticMarkup(
  <VocabularyList target="kinds" rows={kindRows(SEED_SETTINGS.kinds)} usage={{}} write={write} />,
);

describe("the Statuses editor keeps every operation", () => {
  it("rename — a label field per row", () => {
    expect(statuses).toContain('aria-label="Label for todo"');
    expect(statuses).toContain('aria-label="Label for in_progress"');
  });

  it("category change — a select per row, and a category for the new status", () => {
    expect(statuses).toContain('aria-label="Category for todo"');
    expect(statuses).toContain('aria-label="Category for the new status"');
  });

  it("reorder — a drag handle and the two keyboard buttons per row", () => {
    expect(statuses).toContain('aria-label="Drag Todo to reorder"');
    expect(statuses).toContain('aria-label="Move Todo up"');
    expect(statuses).toContain('aria-label="Move Todo down"');
    expect(statuses).toContain('data-reorder-row="todo"');
  });

  it("remove — a Remove per row", () => {
    expect(statuses).toContain('aria-label="Remove Todo"');
    expect(statuses).toContain('aria-label="Remove Done"');
  });

  it("add — an id field, a label field and the submit, inside Fields", () => {
    expect(statuses).toContain('for="new-statuses-id"');
    expect(statuses).toContain('data-settings-field="new-statuses-id"');
    expect(statuses).toContain('for="new-statuses-label"');
    expect(statuses).toContain("Add status");
  });

  it("shows the usage count that decides whether a removal needs a migrate-to", () => {
    expect(statuses).toMatch(/data-reorder-row="todo"[\s\S]*?>3</);
  });

  it("sits in a Section with an ActionBar, and no edit is written until Save", () => {
    expect(statuses).toContain('data-settings-section="true"');
    expect(statuses).toContain('data-action-bar="true"');
    expect(statuses).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
    expect(statuses).not.toContain("data-conflict-banner");
    expect(statuses).not.toContain("data-section-error");
  });

  it("explains that behaviour follows the category and which categories are required", () => {
    expect(statuses).toContain("Behaviour follows the CATEGORY");
    expect(statuses).toContain("unstarted, ready, active, blocked, done, cancelled");
  });
});

describe("the Kinds editor is the same editor without the category column", () => {
  it("has rename, reorder, remove and add", () => {
    expect(kinds).toContain('aria-label="Label for epic"');
    expect(kinds).toContain('aria-label="Move Epic up"');
    expect(kinds).toContain('aria-label="Remove Epic"');
    expect(kinds).toContain("Add kind");
  });

  it("offers no category anywhere", () => {
    expect(kinds).not.toContain("Category for");
    expect(kinds).not.toContain("new-kinds-category");
  });

  it("with no usage known, the count column is blank rather than zero", () => {
    expect(kinds).not.toMatch(/data-reorder-row="epic"[\s\S]*?>0</);
  });
});
