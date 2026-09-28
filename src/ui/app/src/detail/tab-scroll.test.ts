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
import { anchorAfterScroll, anchorTarget, reserveFor, restoreAfterResize, scrollAfterTabSwitch, shrinkReserve } from "./tab-scroll";

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

  it("never grows on a scroll: only a resize the browser clamped can grow it (below)", () => {
    expect(shrinkReserve(300, 620, 100)).toBe(300);
  });

  it("is released once the tab's own content covers it, and stays released", () => {
    expect(shrinkReserve(644, 900, 1200)).toBeNull();
    expect(shrinkReserve(644, 150, 186)).toBeNull();
    expect(shrinkReserve(null, 900, 0)).toBeNull();
  });
});

describe("after the screen gets taller again", () => {
  it("puts back a scroll the browser clamped, to the stuck point if the strip was stuck", () => {
    // Keyboard closed: the scroll was pulled back to the new maximum, 50, short of 374.
    expect(restoreAfterResize(50, 50, anchorTarget({ kind: "stuck" }, 374))).toBe(374);
  });

  it("or to where the reader last scrolled", () => {
    expect(restoreAfterResize(20, 20, anchorTarget({ kind: "at", scrollTop: 180 }, 374))).toBe(180);
  });

  it("never undoes a scroll the browser did not clamp, or one already at the target", () => {
    expect(restoreAfterResize(120, 400, 374)).toBeNull(); // not at the maximum: the reader's
    expect(restoreAfterResize(374, 374, 374)).toBeNull();
    expect(restoreAfterResize(500, 500, 374)).toBeNull();
  });

  it("keeps the anchor stuck while the reader stays stuck, and follows them once they scroll above", () => {
    expect(anchorAfterScroll({ kind: "stuck" }, 374, 374)).toEqual({ kind: "stuck" });
    expect(anchorAfterScroll({ kind: "stuck" }, 373.7, 374)).toEqual({ kind: "stuck" });
    expect(anchorAfterScroll({ kind: "stuck" }, 250, 374)).toEqual({ kind: "at", scrollTop: 250 });
    expect(anchorAfterScroll({ kind: "at", scrollTop: 250 }, 90, 374)).toEqual({ kind: "at", scrollTop: 90 });
    // The stuck point is read in the current layout, so a reflow cannot strand it.
    expect(anchorTarget({ kind: "stuck" }, 505)).toBe(505);
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
    expect(source).toMatch(/const keep = target \?\? scroller\?\.scrollTop \?\? 0;\s*anchorRef\.current = [^;]*;\s*if \(keep > 0 && scroller && panels\) setReserve\(reserveFor\(keep, panelGeometry\(scroller, panels\)\)\);/);
    expect(source).toMatch(/data-detail-tabpanels="" style=\{reserve !== null \? \{ minHeight: reserve \} : undefined\}/);
  });

  it("releases it on scroll, on a resize of the scroller, and on a new task", () => {
    expect(source).toMatch(/scroller\.addEventListener\("scroll", sync, \{ passive: true \}\)/);
    expect(source).toMatch(/new ResizeObserver\(sync\)/);
    expect(source).toMatch(/observer\?\.observe\(scroller\);/);
    expect(source).toMatch(/observer\?\.observe\(panels\);/);
    expect(source).toMatch(/setReserve\(\(current\) => shrinkReserve\(current, needed, covered\)\)/);
    expect(source).toMatch(/useEffect\(\(\) => setReserve\(null\), \[detail\.issue\.id\]\);/);
  });

  it("anchors the reserve at the switch: the stuck point, or where the reader was", () => {
    expect(source).toMatch(/anchorRef\.current = target !== null \? \{ kind: "stuck" \} : \{ kind: "at", scrollTop: keep \};/);
  });

  it("on a height-only resize, grows the reserve before paint and puts a clamped scroll back", () => {
    expect(source).toMatch(/const heightOnly = Math\.abs\(now\.width - size\.width\) <= 0\.5 && Math\.abs\(now\.height - size\.height\) > 0\.5;/);
    expect(source).toMatch(
      /const restore = restoreAfterResize\(top, scroller\.scrollHeight - now\.height, anchorTarget\(anchorRef\.current, stickAt\)\);[\s\S]*?flushSync\(\(\) => setReserve\(grown\)\);\s*scroller\.scrollTop = restore;/,
    );
    // Any other scroll or resize is the reader's (or a reflow): the anchor follows it.
    expect(source).toMatch(/\} else \{[^}]*anchorRef\.current = anchorAfterScroll\(anchorRef\.current, top, stickAt\);/);
  });

  it("measures what follows the panels from the content's own box, not scrollHeight", () => {
    // scrollHeight never reports less than the scroller's height, which made a restored
    // scroll land short by the difference when the content was shorter than the screen.
    expect(source).toMatch(/const content = panels\.closest<HTMLElement>\("\[data-detail-layout\]"\);/);
    expect(source).toMatch(/const tail = content \? content\.getBoundingClientRect\(\)\.bottom - box\.bottom :/);
  });
});
