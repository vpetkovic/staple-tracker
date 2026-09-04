/**
 * The settings form primitives, rendered to a string — R6c (STA-178).
 *
 * Follows settings-shell.test.tsx: `react-dom/server`, no jsdom, assertions on which
 * elements exist, what their accessible names say and which attributes tie them
 * together. What is pinned: a Field carries its label, description, scope tag, inline
 * error and the `aria-describedby` that joins them; the ActionBar reads its enabled
 * state from `actionBarState` and shows the pending state; a section-level error is
 * `role="alert"`; the conflict banner offers exactly reload and keep; the destructive
 * confirmation's confirm button is disabled until the action's requirement is met; and
 * a ReorderList gives every row labelled move buttons, disabled at the ends, addressed
 * by the same data attributes `reorderFocusTarget` is queried with.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { actionBarState } from "./form-model";
import { UNSAVED_CHANGES } from "./ConfirmDialog";
import { ActionBar, ConflictBanner, DestructiveConfirm, Field, Section } from "./primitives";
import { ReorderList } from "./ReorderList";

/** The first button whose opening tag contains `marker` (an attribute, or the text right after the tag). */
function buttonTag(html: string, marker: string): string {
  const match = html.match(new RegExp(`<button[^>]*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^>]*>`));
  if (!match) throw new Error(`no button for ${marker}`);
  return match[0];
}
const isDisabled = (tag: string) => tag.includes(' disabled=""');

describe("Field", () => {
  it("labels its control, describes it, tags its scope and source", () => {
    const html = renderToStaticMarkup(
      <Field id="setting-x" label="Queue policy" description="How pickup is enforced." scope="workspace" source="default">
        {(aria) => <input {...aria} />}
      </Field>,
    );
    expect(html).toContain('for="setting-x"');
    expect(html).toContain("Queue policy");
    expect(html).toContain('id="setting-x-description"');
    expect(html).toContain('data-scope-tag="workspace"');
    expect(html).toContain("Workspace");
    expect(html).toContain("default");
    expect(html).toMatch(/<input[^>]*id="setting-x"[^>]*aria-describedby="setting-x-description"/);
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain('data-inline-error="true"');
  });

  it("renders an inline error as an alert the control is described by, and marks the field", () => {
    const html = renderToStaticMarkup(
      <Field id="f" label="Port" error="Must be at most 65535." dirty>
        {(aria) => <input {...aria} />}
      </Field>,
    );
    expect(html).toContain('data-settings-field="f" data-dirty="" data-invalid=""');
    expect(html).toMatch(/<p id="f-error" role="alert" data-inline-error="true"[^>]*>Must be at most 65535\.<\/p>/);
    expect(html).toMatch(/<input[^>]*aria-describedby="f-error"[^>]*aria-invalid="true"/);
    expect(html).toContain('data-dirty-marker="true"');
  });

  it("a global field says so beside its label", () => {
    const html = renderToStaticMarkup(
      <Field id="g" label="Browser" scope="global" source="config">
        <input id="g" />
      </Field>,
    );
    expect(html).toContain('data-scope-tag="global"');
    expect(html).toContain("Global");
    expect(html).toContain("config");
  });
});

describe("Section", () => {
  it("shows a section-level error above its content, as an alert", () => {
    const html = renderToStaticMarkup(
      <Section title="Statuses" error="the store was not reached">
        <p>content</p>
      </Section>,
    );
    expect(html).toContain('data-section-error="true"');
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf("content"));
    expect(html).toContain("the store was not reached");
  });
});

describe("ActionBar", () => {
  const noop = () => {};

  it("is fully disabled on a clean form and shows no summary", () => {
    const html = renderToStaticMarkup(
      <ActionBar state={actionBarState({ dirty: false, status: "idle" })} onSave={noop} onCancel={noop} />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
    expect(html).not.toContain("Reset to defaults");
    expect(html).not.toContain('data-dirty-summary="true"');
  });

  it("enables Save and Cancel on a dirty form and counts the changes", () => {
    const html = renderToStaticMarkup(
      <ActionBar
        state={actionBarState({ dirty: true, status: "idle" })}
        onSave={noop}
        onCancel={noop}
        summary="2 unsaved changes"
      />,
    );
    expect(isDisabled(buttonTag(html, ">Save changes<"))).toBe(false);
    expect(isDisabled(buttonTag(html, ">Cancel<"))).toBe(false);
    expect(html).toContain('data-dirty-summary="true" aria-live="polite"');
    expect(html).toContain("2 unsaved changes");
  });

  it("shows the pending state and disables everything while saving", () => {
    const html = renderToStaticMarkup(
      <ActionBar state={actionBarState({ dirty: true, status: "pending" })} onSave={noop} onCancel={noop} />,
    );
    expect(html).toContain('data-action-bar="true" data-saving=""');
    expect(html).toContain("Saving…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/);
  });

  it("offers Reset to defaults only when a form has defaults to go back to", () => {
    const html = renderToStaticMarkup(
      <ActionBar
        state={actionBarState({ dirty: false, status: "idle", resettable: true })}
        onSave={noop}
        onCancel={noop}
        onReset={noop}
      />,
    );
    expect(isDisabled(buttonTag(html, ">Reset to defaults<"))).toBe(false);
  });

  it("renders a failed save's sentence when it belongs to no field", () => {
    const html = renderToStaticMarkup(
      <ActionBar
        state={actionBarState({ dirty: true, status: "failed" })}
        error="the store was not reached"
        onSave={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("the store was not reached");
    expect(html).toContain('role="alert"');
  });
});

describe("ConflictBanner", () => {
  it("is an alert that names what changed and offers reload or keep — nothing silent", () => {
    const html = renderToStaticMarkup(<ConflictBanner what="status list" onReload={() => {}} onKeep={() => {}} />);
    expect(html).toContain('role="alert" data-conflict-banner="true"');
    expect(html).toContain("The status list changed elsewhere");
    expect(html).toContain(">Reload</button>");
    expect(html).toContain(">Keep my changes</button>");
  });
});

describe("DestructiveConfirm", () => {
  it("holds the confirm button until the action's requirement is met", () => {
    const blocked = renderToStaticMarkup(
      <DestructiveConfirm message='3 issues still carry "Todo". Move them to:' confirmLabel="Remove" confirmDisabled onConfirm={() => {}} onCancel={() => {}}>
        <select aria-label="Migrate todo to" />
      </DestructiveConfirm>,
    );
    expect(blocked).toContain('role="group" data-destructive-confirm="true"');
    expect(blocked).toContain("3 issues still carry &quot;Todo&quot;. Move them to:");
    expect(blocked).toContain('aria-label="Migrate todo to"');
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>Remove<\/button>/);
    const ready = renderToStaticMarkup(
      <DestructiveConfirm message='Remove "Todo"?' confirmLabel="Remove" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(isDisabled(buttonTag(ready, ">Remove<"))).toBe(false);
    expect(ready).toContain(">Cancel</button>");
  });
});

describe("the unsaved-changes dialog's copy", () => {
  it("names both ways out as what they do, never OK", () => {
    expect(UNSAVED_CHANGES.confirmLabel).toBe("Discard changes");
    expect(UNSAVED_CHANGES.cancelLabel).toBe("Keep editing");
    expect(UNSAVED_CHANGES.title).toBe("Discard unsaved changes?");
  });
});

describe("ReorderList", () => {
  const items = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
    { id: "c", label: "Gamma" },
  ];
  const html = renderToStaticMarkup(
    <ReorderList
      items={items}
      getId={(i) => i.id}
      getLabel={(i) => i.label}
      onMove={() => {}}
      renderItem={(i) => <span>{i.label}</span>}
      rowState={(i) => ({ invalid: i.id === "b" })}
    />,
  );

  it("gives every row a drag handle and two labelled move buttons, always visible", () => {
    expect(html).toContain('role="list" data-reorder-list="true"');
    for (const item of items) {
      expect(html).toContain(`data-reorder-row="${item.id}"`);
      expect(html).toContain(`aria-label="Drag ${item.label} to reorder"`);
      expect(html).toContain(`aria-label="Move ${item.label} up"`);
      expect(html).toContain(`aria-label="Move ${item.label} down"`);
    }
  });

  it("disables the move that would leave the list, and only that one", () => {
    const tag = (label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))![0];
    expect(isDisabled(tag("Move Alpha up"))).toBe(true);
    expect(tag("Move Alpha up")).toContain('data-reorder-control="up"');
    expect(isDisabled(tag("Move Alpha down"))).toBe(false);
    expect(isDisabled(tag("Move Beta up"))).toBe(false);
    expect(isDisabled(tag("Move Beta down"))).toBe(false);
    expect(isDisabled(tag("Move Gamma down"))).toBe(true);
  });

  it("addresses each row by id and each control by direction, which is what focus recovery queries", () => {
    expect(html).toMatch(/data-reorder-row="c"[\s\S]*data-reorder-control="up"[\s\S]*data-reorder-control="down"/);
  });

  it("marks the row a refusal named", () => {
    expect(html).toMatch(/<div[^>]*data-reorder-row="b"[^>]*data-invalid=""/);
    expect(html).not.toMatch(/<div[^>]*data-reorder-row="a"[^>]*data-invalid=""/);
  });
});
