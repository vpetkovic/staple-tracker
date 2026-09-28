/**
 * Switching detail tabs never moves the tab strip. The rule is pure (tab-scroll.ts) and
 * pinned here; the wiring is pinned by a scan of the panel, because the fix is two things
 * that must both stay: the reserved height under the strip, and every tab change (a click,
 * the keyboard, another tab's "Show all") going through the one handler that decides the
 * scroll. The Playwright measurements in the ticket evidence are the proof in a browser.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scrollAfterTabSwitch, tabPanelReserve } from "./tab-scroll";

describe("the scroll after a tab switch", () => {
  it("keeps a stuck strip stuck, with the new tab starting right under it", () => {
    // Deep in a long Activity feed: the next tab starts at its top, under the strip.
    expect(scrollAfterTabSwitch(2400, 480)).toBe(480);
    // Exactly at the point where the strip sticks, and within half a pixel of it.
    expect(scrollAfterTabSwitch(480, 480)).toBe(480);
    expect(scrollAfterTabSwitch(479.6, 480)).toBe(480);
  });

  it("leaves the scroll alone while the strip is still in view below the top", () => {
    expect(scrollAfterTabSwitch(0, 480)).toBeNull();
    expect(scrollAfterTabSwitch(330, 480)).toBeNull();
  });

  it("never asks for a negative scroll", () => {
    expect(scrollAfterTabSwitch(0, -3)).toBe(0);
  });
});

describe("the reserve under the strip", () => {
  it("is the scroller's height less the strip's, so no tab can clamp the scroll", () => {
    expect(tabPanelReserve(719, 51)).toBe(668);
    expect(tabPanelReserve(852.4, 33)).toBe(819);
  });

  it("is never negative", () => {
    expect(tabPanelReserve(20, 51)).toBe(0);
  });
});

describe("the detail panel wires it", () => {
  const source = readFileSync(new URL("./IssueDetailPanel.tsx", import.meta.url), "utf8");

  it("reserves the height on the tab panels", () => {
    expect(source).toMatch(/data-detail-tabpanels=""\s+style=\{reserve > 0 \? \{ minHeight: reserve \} : undefined\}/);
    expect(source).toMatch(/setReserve\(tabPanelReserve\(scroller\.clientHeight, bar\.offsetHeight\)\)/);
  });

  it("sends every tab change through the handler that decides the scroll", () => {
    expect(source).toMatch(/<Tabs value=\{active\} onValueChange=\{selectTab\}/);
    expect(source).toMatch(/onOpenDetailTab\(selectTab\)/);
    expect(source).toMatch(/pendingScroll\.current = [^;]*scrollAfterTabSwitch\(scroller\.scrollTop, stickOffset\(sentinel, scroller\)\)/);
    expect(source).toMatch(/if \(target !== null && scroller\) scroller\.scrollTop = target;/);
  });
});
