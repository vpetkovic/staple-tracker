/**
 * Switching detail tabs never moves the tab strip, and never leaves a task scrolling into
 * blank space it did not need. The rule is pure (tab-scroll.ts) and pinned here; the wiring is
 * pinned by a scan of the panel, because the fix is several things that must all stay: every
 * tab change going through the one handler that decides the scroll, the scroll applied before
 * paint, a reserve set only on a stuck switch, and a reserve that is released on scroll, on
 * resize and on a new task. The Playwright measurements in the ticket evidence are the proof
 * in a browser.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reserveFor, scrollAfterTabSwitch, shrinkReserve } from "./tab-scroll";

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

describe("the reserve for a stuck switch", () => {
  // The 390 phone sheet: a 719px scroller, the panels starting under a 51px strip that sticks
  // at 374, and the sheet's 24px bottom padding after them.
  const phone = { clientHeight: 719, panelsTop: 374 + 51, tail: 24 };

  it("is exactly what makes the stuck position reachable, whatever the new tab's height", () => {
    expect(reserveFor(374, phone)).toBe(719 - 51 - 24);
    // Content below the panels (a taller side rail on the page) already holds some of it.
    expect(reserveFor(374, { ...phone, tail: 400 })).toBe(719 - 51 - 400);
  });

  it("keeps a strip that was in view where it was: the reserve holds the current scroll", () => {
    // Scrolled 47px with the strip in view, switching to a tab too short to hold that.
    expect(reserveFor(47, phone)).toBe(47 + 719 - 425 - 24);
  });

  it("is none at the top, and never negative", () => {
    expect(reserveFor(0, phone)).toBe(0);
    expect(reserveFor(10, { clientHeight: 300, panelsTop: 900, tail: 24 })).toBe(0);
  });

  it("is released at the top of the task", () => {
    expect(shrinkReserve(644, reserveFor(0, phone), 186)).toBeNull();
  });

  it("gives back blank space as the reader scrolls up, never more than the scroll needs", () => {
    const held = reserveFor(374, phone);
    const needed = reserveFor(274, phone); // scrolled up 100px
    expect(shrinkReserve(held, needed, 186)).toBe(held - 100);
  });

  it("never grows back: a taller screen (a keyboard closing) does not add blank space", () => {
    expect(shrinkReserve(300, 620, 100)).toBe(300);
  });

  it("is released once the tab's own content covers it, and stays released", () => {
    expect(shrinkReserve(644, 900, 1200)).toBeNull();
    expect(shrinkReserve(644, 150, 186)).toBeNull();
    expect(shrinkReserve(null, 900, 0)).toBeNull();
  });
});

describe("the detail panel wires it", () => {
  const source = readFileSync(new URL("./IssueDetailPanel.tsx", import.meta.url), "utf8");

  it("sends every tab change through the handler that decides the scroll", () => {
    expect(source).toMatch(/<Tabs value=\{active\} onValueChange=\{selectTab\}/);
    expect(source).toMatch(/onOpenDetailTab\(selectTab\)/);
    expect(source).toMatch(/const target = [^;]*scrollAfterTabSwitch\(scroller\.scrollTop, stickOffset\(sentinel, scroller\)\)/);
  });

  it("applies the scroll before paint", () => {
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*const target = pendingScroll\.current;[\s\S]*?if \(target !== null && scroller\) scroller\.scrollTop = target;\s*\}, \[active\]\);/,
    );
  });

  it("holds a reserve only for a switch made while scrolled, sized for where the scroll will be", () => {
    expect(source).toMatch(/useState<number \| null>\(null\)/);
    expect(source).toMatch(/const keep = target \?\? scroller\?\.scrollTop \?\? 0;\s*if \(keep > 0 && scroller && panels\) setReserve\(reserveFor\(keep, panelGeometry\(scroller, panels\)\)\);/);
    expect(source).toMatch(/data-detail-tabpanels="" style=\{reserve !== null \? \{ minHeight: reserve \} : undefined\}/);
  });

  it("releases it on scroll, on a resize of the scroller, and on a new task", () => {
    expect(source).toMatch(/scroller\.addEventListener\("scroll", check, \{ passive: true \}\)/);
    expect(source).toMatch(/observer\?\.observe\(scroller\);/);
    expect(source).toMatch(/observer\?\.observe\(panels\);/);
    expect(source).toMatch(/setReserve\(\(current\) => shrinkReserve\(current, needed, natural\)\)/);
    expect(source).toMatch(/useEffect\(\(\) => setReserve\(null\), \[detail\.issue\.id\]\);/);
  });
});
