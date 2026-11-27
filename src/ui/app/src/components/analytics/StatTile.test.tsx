/**
 * One headline number: its states (loading, nothing to measure), the delta's tone by which
 * direction is good news, and the sparkline. Clicking a tile in button mode is checked in a real
 * browser in `widgets-browser.test.tsx`; here is what each case draws.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeltaMark, Sparkline, StatTile, type StatDelta } from "./StatTile";

const delta = (ratio: number | null, goodWhen?: StatDelta["goodWhen"]) => renderToStaticMarkup(<DeltaMark delta={{ ratio, against: "vs the 30 days before", goodWhen }} />);
const OK = "text-[var(--plain-ok-fg)]";
const RISK = "text-[var(--plain-risk-fg)]";

describe("the tile's states", () => {
  it("loading draws its own skeleton and says what is loading, without a figure", () => {
    const html = renderToStaticMarkup(<StatTile label="Agent time" value="633 h" loading />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading Agent time");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).not.toContain("data-figure");
    expect(html).not.toContain("633 h");
  });

  it("value null says the empty words and never a 0", () => {
    const html = renderToStaticMarkup(<StatTile label="Return" value={null} delta={{ ratio: 0.1, against: "vs before" }} />);
    expect(html).toContain("Nothing to measure yet");
    expect(html).not.toContain("data-figure");
    expect(html).not.toMatch(/>0</);
    expect(html).not.toContain("data-delta");
    expect(renderToStaticMarkup(<StatTile label="Return" value={null} emptyText="No spend logged" />)).toContain("No spend logged");
  });

  it("a value of 0 is a figure, not the empty words", () => {
    const html = renderToStaticMarkup(<StatTile label="Failures" value={0} />);
    expect(html).toContain("data-figure");
    expect(html).not.toContain("Nothing to measure yet");
  });

  it("ready draws the figure, its unit, the sentence, the delta, the note and the sparkline", () => {
    const html = renderToStaticMarkup(<StatTile label="Agent time" value="633" unit="h" sentence="About 1.5 engineers." delta={{ ratio: 0.32, against: "vs before" }} note="Partial" trend={[1, 2, 3]} />);
    expect(html).toContain("633<span");
    expect(html).toContain(">h</span>");
    expect(html).toContain("About 1.5 engineers.");
    expect(html).toContain('data-delta="up"');
    expect(html).toContain("Partial");
    expect(html).toContain("data-sparkline");
  });

  it("draws no sparkline for a single point", () => {
    expect(renderToStaticMarkup(<StatTile label="x" value="1" trend={[4]} />)).not.toContain("data-sparkline");
  });

  it("is a named region without onOpen, and a named button with it", () => {
    const plain = renderToStaticMarkup(<StatTile label="Agent time" value="633 h" />);
    expect(plain).toMatch(/^<section aria-label="Agent time"/);
    expect(plain).not.toContain("<button");
    const open = renderToStaticMarkup(<StatTile label="Return" value="2.4×" onOpen={() => {}} openLabel="Open the Return lens" />);
    expect(open).toMatch(/^<button type="button" aria-label="Open the Return lens"/);
    expect(open).toContain("focus-ring");
    // The nudge on hover is motion, so it only plays when the reader has not asked for less.
    expect(open).toContain("motion-safe:group-hover/tile:translate-x-0.5");
    expect(renderToStaticMarkup(<StatTile label="Return" value="2.4×" onOpen={() => {}} />)).toContain('aria-label="Return"');
  });
});

describe("the delta's tone", () => {
  it("is good when it moved the way goodWhen says", () => {
    expect(delta(0.32, "up")).toContain(OK);
    expect(delta(-0.08, "down")).toContain(OK);
  });
  it("is a risk when it moved the other way", () => {
    expect(delta(-0.08, "up")).toContain(RISK);
    expect(delta(0.32, "down")).toContain(RISK);
  });
  it("has no tone when neutral or unset", () => {
    for (const html of [delta(0.32, "neutral"), delta(-0.08, "neutral"), delta(0.32)]) {
      expect(html).not.toContain(OK);
      expect(html).not.toContain(RISK);
      expect(html).toContain("text-foreground");
    }
  });
  it("prints a signed share with a true minus", () => {
    expect(delta(0.32, "up")).toContain("+32%");
    expect(delta(-0.08, "up")).toContain("−8%");
    expect(delta(0.32, "up")).toContain('data-delta="up"');
    expect(delta(-0.08, "up")).toContain('data-delta="down"');
  });
  it("says No change, without tone, for a change under half a percent", () => {
    const html = delta(0.004, "up");
    expect(html).toContain("No change");
    expect(html).toContain('data-delta="flat"');
    expect(html).not.toContain(OK);
    expect(delta(-0.004, "down")).toContain("No change");
    expect(delta(0.006, "up")).toContain("+1%");
  });
  it("caps a huge change at 999%", () => {
    expect(delta(42, "up")).toContain("+999%");
  });
  it("says there is no earlier period when there is no base", () => {
    const html = delta(null, "up");
    expect(html).toContain("No earlier period to compare");
    expect(html).not.toContain("data-delta");
  });
});

describe("the sparkline", () => {
  const heights = (values: number[]) => [...renderToStaticMarkup(<Sparkline values={values} />).matchAll(/height:([\d.]+)%/g)].map((match) => Number(match[1]));
  it("scales to the largest value, with a floor so a small bucket and a zero still show", () => {
    expect(heights([0, 1, 50, 100])).toEqual([3, 8, 50, 100]);
  });
  it("draws every bucket at the floor when all are zero", () => {
    expect(heights([0, 0])).toEqual([3, 3]);
  });
  it("paints the last bucket in the accent and hides itself from a screen reader", () => {
    const html = renderToStaticMarkup(<Sparkline values={[1, 2]} />);
    expect(html).toMatch(/^<span aria-hidden="true"/);
    expect(html.lastIndexOf("var(--viz-accent)")).toBeGreaterThan(html.lastIndexOf("var(--viz-muted-mark)"));
  });
});
