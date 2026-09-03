/**
 * O4a (STA-133) — the graph toolbar in the tree view's menu language.
 *
 * Rendered to a string with `react-dom/server`, like every other component test in this
 * repo: there is no jsdom here, and every claim below is about which elements exist and
 * what their labels and ARIA state say, which is exactly what a string can answer.
 *
 * The popover BODY is asserted through `ViewOptions` rather than by opening the popover.
 * Radix renders content through a portal and only while open, so a closed popover has no
 * markup to look at — and forcing one open in a server render would be testing Radix, not
 * this ticket. `ViewOptions` is the element that carries every property the ticket asks
 * for, so it is the element the test drives.
 *
 * What is worth a test here, in order of how quietly it would break:
 *
 *   1. THE TRIGGER SAYS WHAT IS TRUE. The whole point of replacing five toggles with one
 *      menu is that the state moved into a label. If that label ever stops naming both the
 *      mode and the done setting, the row is back to being a highlight you have to decode.
 *   2. PATH TO TARGET EXPLAINS ITSELF. A disabled control with no reason is a dead end,
 *      and this one is disabled in the state a first-time user arrives in.
 *   3. EXPORT AND COPY LINK ARE STILL BUTTONS. They are the two things that must NOT have
 *      been swallowed by the popover — they are actions, not view state.
 *   4. THE ROVING TAB STOP. Arrow movement itself needs a DOM, but the invariant that
 *      makes it work — exactly one tabbable row per group, and never a disabled one — is
 *      visible in the markup, and the arithmetic is a pure function tested directly.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphToolbar, ViewOptions, nextOptionIndex, viewTriggerLabel } from "./GraphToolbar";
import type { DoneMode, PlanningMode } from "./graph-planning";

const noop = () => {};

/** Matches the checked row of one group, whatever order React emits the attributes in. */
const checkedRow = (group: "mode" | "done", option: string) =>
  new RegExp(`aria-checked="true"[^>]*data-view-group="${group}" data-view-option="${option}"`);

function toolbar(input: {
  mode?: PlanningMode;
  doneMode?: DoneMode;
  hasTarget?: boolean;
  copied?: string | null;
}): string {
  return renderToStaticMarkup(
    <GraphToolbar
      mode={input.mode ?? "off"}
      onMode={noop}
      doneMode={input.doneMode ?? "show"}
      onDoneMode={noop}
      hasTarget={input.hasTarget ?? false}
      onExport={noop}
      onCopyLink={noop}
      copied={input.copied ?? null}
    />,
  );
}

function options(input: { mode?: PlanningMode; doneMode?: DoneMode; hasTarget?: boolean }): string {
  return renderToStaticMarkup(
    <ViewOptions
      mode={input.mode ?? "off"}
      onMode={noop}
      doneMode={input.doneMode ?? "show"}
      onDoneMode={noop}
      hasTarget={input.hasTarget ?? false}
    />,
  );
}

describe("the View trigger states the view", () => {
  // "Group" / "Group: Status" is the tree's rule, and this is the same rule with two
  // dimensions in it. The separator is the middle dot the rest of the app already uses.
  it.each([
    ["off", "show", "View"],
    ["frontier", "show", "View: Frontier"],
    ["path", "show", "View: Path to target"],
    ["off", "fade", "View: done faded"],
    ["off", "hide", "View: done hidden"],
    ["frontier", "fade", "View: Frontier · done faded"],
    ["path", "hide", "View: Path to target · done hidden"],
  ] as const)("reads %s + %s as %s", (mode, doneMode, expected) => {
    expect(viewTriggerLabel(mode, doneMode)).toBe(expected);
  });

  it("puts that label in the trigger, with the mode and done setting as data", () => {
    const markup = toolbar({ mode: "frontier", doneMode: "fade", hasTarget: true });
    expect(markup).toContain("View: Frontier · done faded");
    expect(markup).toContain('data-graph-mode="frontier"');
    expect(markup).toContain('data-graph-done="fade"');
  });

  it("leaves the label as the accessible name rather than covering it with aria-label", () => {
    // An aria-label on the trigger would overwrite the very words that carry the state,
    // which is the one thing this control exists to say out loud.
    const trigger = toolbar({ mode: "frontier" }).slice(0, toolbar({ mode: "frontier" }).indexOf("</button>"));
    expect(trigger).not.toContain("aria-label");
  });

  it("is muted at rest and foreground once the view is doing something", () => {
    expect(toolbar({})).toContain("text-muted-foreground");
    const lit = toolbar({ doneMode: "hide" });
    expect(lit).toContain("text-foreground");
    // tailwind-merge drops the muted colour when the active one is applied; if both
    // survived, the "is anything on?" signal the tree relies on would be dead.
    const triggerClass = lit.slice(lit.indexOf("data-graph-view"), lit.indexOf("</button>"));
    expect(triggerClass).not.toContain(" text-muted-foreground");
  });
});

describe("Export and Copy link stay buttons at the end of the row", () => {
  it("renders both, capitalised like the rest of the chrome", () => {
    const markup = toolbar({});
    expect(markup).toContain("Copy link");
    expect(markup).toContain("Export");
    // The old dialect, gone: lowercase labels and the cycling done button.
    expect(markup).not.toContain("copy view link");
    expect(markup).not.toContain("done: shown");
    expect(markup).not.toContain("path to target");
  });

  it("lets the copy result take over the Copy link label", () => {
    // The confirmation belongs where the click was; this app has no toast to borrow.
    const markup = toolbar({ copied: "link copied" });
    expect(markup).toContain("link copied");
    expect(markup).not.toContain("Copy link");
  });
});

describe("the popover offers two radiogroups with hints", () => {
  it("names both groups and marks the option that is true", () => {
    const markup = options({ mode: "frontier", doneMode: "hide", hasTarget: true });

    expect(markup).toContain('role="radiogroup" aria-label="Planning mode"');
    expect(markup).toContain('role="radiogroup" aria-label="Finished work"');
    expect(markup.match(/role="radio"/g)).toHaveLength(6);

    expect(markup).toMatch(checkedRow("mode", "frontier"));
    expect(markup).toMatch(checkedRow("done", "hide"));
    // Exactly one per group, or the menu is asserting two contradictory facts.
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(2);
  });

  it("gives Off a name of its own instead of hiding it in a second press", () => {
    // The old control made "off" the act of pressing the lit button again — a state with
    // no label and no way to discover it.
    const markup = options({});
    expect(markup).toContain('data-view-option="off"');
    expect(markup).toContain("Every ticket at full strength");
    expect(markup).toMatch(checkedRow("mode", "off"));
  });

  it("carries a hint under every option, the way GroupByMenu does", () => {
    const markup = options({ hasTarget: true });
    for (const hint of [
      "Every ticket at full strength",
      "Only what could be picked up right now",
      "Only the unfinished work between today and the selected ticket",
      "Finished work stays on the canvas",
      "Finished work dims into the background",
      "Finished work leaves and its edges bridge across it",
    ]) {
      expect(markup).toContain(hint);
    }
  });
});

describe("Path to target without a target", () => {
  it("is disabled and says why", () => {
    const markup = options({ hasTarget: false });
    expect(markup).toMatch(/disabled=""[^>]*data-view-option="path"/);
    expect(markup).toContain("Select a ticket on the canvas first — this mode needs a target");
    // Disabled, not hidden: a control that appears when you happen to click a node is a
    // control nobody discovers.
    expect(markup.slice(markup.indexOf('data-view-option="path"'))).toContain("Path to target");
    // And the generic hint is gone rather than doubled up.
    expect(markup).not.toContain("Only the unfinished work between today and the selected ticket");
  });

  it("becomes selectable, with its own hint, once a ticket is selected", () => {
    const markup = options({ hasTarget: true });
    expect(markup).not.toContain("Select a ticket on the canvas first");
    expect(markup).toContain("Only the unfinished work between today and the selected ticket");
  });
});

describe("keyboard", () => {
  it("leaves exactly one tab stop per group, and never a disabled one", () => {
    const markup = options({ mode: "off", doneMode: "show", hasTarget: false });
    expect(markup.match(/tabindex="0"/g)).toHaveLength(2);
  });

  it("does not make a disabled Path to target the tab stop even when it is the mode", () => {
    // A link can arrive with mode=path and no target. The row is still unreachable, so it
    // must not be the thing Tab lands on.
    const markup = options({ mode: "path", hasTarget: false });
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it("moves down, up and to the ends, wrapping", () => {
    expect(nextOptionIndex(6, 0, "ArrowDown")).toBe(1);
    expect(nextOptionIndex(6, 5, "ArrowDown")).toBe(0);
    expect(nextOptionIndex(6, 0, "ArrowUp")).toBe(5);
    expect(nextOptionIndex(6, 3, "ArrowRight")).toBe(4);
    expect(nextOptionIndex(6, 3, "ArrowLeft")).toBe(2);
    expect(nextOptionIndex(6, 3, "Home")).toBe(0);
    expect(nextOptionIndex(6, 3, "End")).toBe(5);
  });

  it("keeps its hands off every other key", () => {
    // Enter, Space and Escape have to reach the button and Radix untouched, or the menu
    // stops behaving like the Group menu next door.
    for (const key of ["Enter", " ", "Escape", "Tab", "a"]) {
      expect(nextOptionIndex(6, 2, key)).toBeNull();
    }
    // Nothing focused inside the list yet — Radix has focus on the content itself.
    expect(nextOptionIndex(6, -1, "ArrowDown")).toBeNull();
    expect(nextOptionIndex(0, 0, "ArrowDown")).toBeNull();
  });
});
