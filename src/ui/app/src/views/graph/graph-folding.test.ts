/**
 * O4d (STA-136) — folding, as decisions.
 *
 * Three risks live in this file, and only the first is the obvious one.
 *
 * `foldOf` is easy to get backwards. "In the previous collapse set and not in the next"
 * means the epic OPENED, which reads inside-out the first time and would be a viewport
 * that zooms in when you close something and stays put when you open it — a bug you would
 * notice immediately and still have to think about for a minute.
 *
 * `foldFitZoom` is the one that would ship. Fitting to a node is the obvious call, it
 * looks right in the expand direction, and in the collapse direction it rockets the
 * viewport to maximum zoom on a 208x62 card, because that is genuinely the zoom at which
 * that card fills the frame. The rule is that A FOLD NEVER MAGNIFIES, and it needs a test
 * because the failure is only visible if you happen to be zoomed out when you collapse.
 *
 * `selectionTarget` is not really tested here at all — it is guaranteed by its signature,
 * which takes no collapse set and returns no fold. What the cases below pin is the mapping
 * and, more importantly, the SHAPE: if somebody ever adds a collapse argument to it, these
 * calls stop compiling, which is the alarm this file is really for.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so the
 * app's `@` alias does not exist at test time.
 */
import { describe, expect, it } from "vitest";
import {
  FOLD_FIT_MAX_ZOOM,
  foldFitZoom,
  foldOf,
  selectionTarget,
} from "./graph-folding";

const set = (...ids: string[]) => new Set(ids);

describe("foldOf", () => {
  it("reads an epic leaving the collapse set as OPENED", () => {
    // The direction that reads inside-out. Collapsed BEFORE and not collapsed AFTER is
    // the expand gesture, and getting it backwards inverts the whole viewport rule.
    expect(foldOf(set("STA-1", "STA-2"), set("STA-2"))).toEqual({
      epic: "STA-1",
      opened: true,
    });
  });

  it("reads an epic joining the collapse set as CLOSED", () => {
    expect(foldOf(set("STA-2"), set("STA-1", "STA-2"))).toEqual({
      epic: "STA-1",
      opened: false,
    });
  });

  it("says nothing happened when the sets agree", () => {
    // The common case by a wide margin: this runs on every shape change, and most shape
    // changes are a ticket arriving on the poll, not somebody pressing a chevron.
    expect(foldOf(set("STA-1"), set("STA-1"))).toBeNull();
    expect(foldOf(set(), set())).toBeNull();
  });

  it("refuses to pick a favourite when Expand all changed several", () => {
    // The deliberate half. A viewport that flew to whichever epic happened to sort first
    // would be choosing at random and presenting it as an answer. The board-wide gesture
    // that IS allowed to move everything is auto-arrange, and it does not come through
    // here at all.
    expect(foldOf(set("STA-1", "STA-2", "STA-3"), set())).toBeNull();
  });

  it("refuses when Collapse all folded several", () => {
    expect(foldOf(set(), set("STA-1", "STA-2"))).toBeNull();
  });

  it("refuses when one opened and another closed in the same step", () => {
    // Two gestures in one commit is not a fold of one epic, and there is no single epic
    // to look at. Silence beats guessing.
    expect(foldOf(set("STA-1"), set("STA-2"))).toBeNull();
  });

  it("still names the fold when the epic is the only thing either set holds", () => {
    expect(foldOf(set(), set("STA-9"))).toEqual({ epic: "STA-9", opened: false });
    expect(foldOf(set("STA-9"), set())).toEqual({ epic: "STA-9", opened: true });
  });
});

describe("foldFitZoom", () => {
  it("lets an OPEN close in, but no further than the canvas's own first-paint cap", () => {
    // Opening asks "show me what is inside", so the closest a fold can take you is a zoom
    // you have already seen this graph at.
    expect(foldFitZoom(true, 0.3)).toBe(FOLD_FIT_MAX_ZOOM);
  });

  it("does not let an OPEN exceed the cap even from a zoomed-in viewport", () => {
    expect(foldFitZoom(true, 1.8)).toBe(FOLD_FIT_MAX_ZOOM);
  });

  it("KEEPS THE CURRENT ZOOM ON A CLOSE, at any zoom", () => {
    // The assertion this file exists for. Fitting to the card a collapse leaves behind
    // would take the viewport to maximum zoom on a single 208x62 node — the exact
    // opposite of a gesture that asked to see LESS. The animation is spent on the pan.
    expect(foldFitZoom(false, 0.25)).toBe(0.25);
    expect(foldFitZoom(false, 1.7)).toBe(1.7);
  });

  it("never magnifies on a close, whatever the cap happens to be", () => {
    // Stated as the rule rather than as three numbers, so that changing FOLD_FIT_MAX_ZOOM
    // cannot quietly turn a close into a zoom-in.
    for (const zoom of [0.1, 0.5, 1, 1.5, 2]) {
      expect(foldFitZoom(false, zoom)).toBeLessThanOrEqual(zoom);
    }
  });
});

describe("selectionTarget", () => {
  const absorbed = new Map([["STA-50", "epic:STA-40"]]);
  const headers = new Map([["STA-41", "epic:STA-41"]]);

  it("lands a ticket inside a COLLAPSED epic on that epic's cluster", () => {
    // Without this, opening a ticket inside a collapsed epic would trace nothing and the
    // dimming would be total, which reads as a fault rather than as "it is in there".
    expect(selectionTarget("STA-50", absorbed, headers)).toBe("epic:STA-40");
  });

  it("lands an EXPANDED epic on its own box", () => {
    // An expanded epic's ticket is gone from the canvas — it became the box's header.
    expect(selectionTarget("STA-41", absorbed, headers)).toBe("epic:STA-41");
  });

  it("leaves a ticket that is drawn as itself alone", () => {
    expect(selectionTarget("STA-99", absorbed, headers)).toBe("STA-99");
  });

  it("has nothing to light when nothing is selected", () => {
    expect(selectionTarget(null, absorbed, headers)).toBeNull();
  });

  it("CANNOT FOLD ANYTHING, and that is the point of its signature", () => {
    /*
     * The acceptance criterion is "selecting a task outside the graph never changes
     * collapse state or the epic filter" — a tree row, the command palette, prev/next in
     * the detail panel. Every one of those reaches the canvas through this function and
     * nowhere else, and this function takes a selection and two id maps and returns an id.
     * There is no collapse set to change and no fold to return.
     *
     * So what is asserted here is that the answer depends on NOTHING but its arguments:
     * the same selection against the same maps gives the same id, twice, with no state
     * anywhere in between for a fold to have been recorded in.
     */
    const first = selectionTarget("STA-50", absorbed, headers);
    const second = selectionTarget("STA-50", absorbed, headers);
    expect(second).toBe(first);
    // And the maps it was handed are still exactly what they were — no epic was quietly
    // absorbed, released, or added to a filter on the way through.
    expect([...absorbed]).toEqual([["STA-50", "epic:STA-40"]]);
    expect([...headers]).toEqual([["STA-41", "epic:STA-41"]]);
  });

  it("prefers the collapsed reading when an id somehow appears in both maps", () => {
    // Cannot happen today — a container and a cluster share an id, so an epic resolves to
    // the same string either way and the order is unobservable for it. Pinned anyway,
    // because "the order does not matter" is a claim that stops being true silently.
    const both = new Map([["STA-7", "epic:STA-7"]]);
    expect(selectionTarget("STA-7", both, new Map([["STA-7", "epic:OTHER"]]))).toBe("epic:STA-7");
  });
});
