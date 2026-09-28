/**
 * The Dependencies dialog on a phone: inside the screen with a margin, and long titles wrap
 * then clamp inside the card. There is no layout engine under vitest (no jsdom, by rule), so
 * this pins the three declarations the fix rests on; the Playwright evidence at 360/390 is the
 * proof that they add up to a card that fits.
 *
 * Each one was the cause of what VP saw, not a style preference:
 *  - the card's own cap is unlayered and beats the dialog primitive's `calc(100% - 2rem)`, so a
 *    bare `34rem` left no margin at all on a phone;
 *  - the sections grid sized its one track to the longest title, pushing the lists past the
 *    card's right edge;
 *  - a one-line `nowrap` title cut "3.40 — Keep exhausted outbox rows out of the cla" at the
 *    screen edge.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./task-list/task-list.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration of every rule whose selector list includes `selector`, later rules winning. */
function declarations(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const line of match[2]!.split(";")) {
      const at = line.indexOf(":");
      if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  return out;
}

describe("the dependencies dialog fits a phone", () => {
  it("caps its width with the viewport margin, not instead of it", () => {
    const dialog = declarations(".staple-dep-dialog");
    expect(dialog["max-width"]).toBe("min(34rem, calc(100% - 2rem))");
  });

  it("scrolls a long list inside the card, which stops short of the notch and the home indicator", () => {
    const dialog = declarations(".staple-dep-dialog");
    expect(dialog["overflow-y"]).toBe("auto");
    expect(dialog["max-height"]).toBe("calc(100dvh - max(1rem, env(safe-area-inset-top)) - max(1rem, env(safe-area-inset-bottom)))");
  });

  it("keeps its title, subject and close control in view while the list scrolls", () => {
    const head = declarations(".staple-dep-head");
    expect(head["position"]).toBe("sticky");
    // The card's 24px padding: a sticky offset counts from inside it.
    expect(head["top"]).toBe("-24px");
    expect(head["background-color"]).toBe("inherit");
    // The close control lives in the sticky head, not in DialogContent's own slot, which
    // scrolls away with the card.
    const markup = readFileSync(new URL("./DependenciesDialog.tsx", import.meta.url), "utf8");
    expect(markup).toMatch(/<DialogContent className="staple-dep-dialog"[^>]*showCloseButton=\{false\}>/);
    const head0 = markup.indexOf('<div className="staple-dep-head"');
    const close = markup.indexOf("<DialogClose");
    expect(head0).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(head0);
    // Nothing closes the head between its opening and the close control.
    expect(markup.slice(head0, close)).not.toContain("</div>");
  });

  it.each([".staple-dep-entry-id", ".staple-dep-subject-id"])("caps %s so the title keeps most of the line", (selector) => {
    const id = declarations(selector);
    expect(id["max-width"]).toBe("30%");
    expect(id["overflow"]).toBe("hidden");
    expect(id["text-overflow"]).toBe("ellipsis");
    expect(id["white-space"]).toBe("nowrap");
  });

  it("lets its sections shrink below their longest title", () => {
    expect(declarations(".staple-dep-sections")["grid-template-columns"]).toBe("minmax(0, 1fr)");
    expect(declarations(".staple-dep-section")["min-width"]).toBe("0");
  });

  it.each([".staple-dep-entry-title", ".staple-dep-subject-title"])("wraps %s to two lines, then clamps it", (selector) => {
    const title = declarations(selector);
    expect(title["white-space"]).toBe("normal");
    expect(title["-webkit-line-clamp"]).toBe("2");
    expect(title["display"]).toBe("-webkit-box");
    expect(title["overflow"]).toBe("hidden");
    expect(title["min-width"]).toBe("0");
  });
});
