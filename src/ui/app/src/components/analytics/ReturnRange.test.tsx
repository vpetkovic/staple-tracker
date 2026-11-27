/** The return on spend as a range: the data contract in ReturnRange's header comment. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReturnRange } from "./ReturnRange";

const low = { value: 0.8, label: "measured agent time" };
const high = { value: 3.4, label: "planned effort" };
const render = (props: Partial<Parameters<typeof ReturnRange>[0]> = {}) => renderToStaticMarkup(<ReturnRange low={low} high={high} {...props} />);
const figures = (html: string) => [...html.matchAll(/<span class="absolute -translate-x-1\/2 whitespace-nowrap" style="left:([\d.]+)%">([^<]+)<\/span>/g)].map((match) => ({ left: Number(match[1]), text: match[2] }));

describe("ReturnRange", () => {
  it("draws nothing without either end", () => {
    expect(render({ low: null, high: null })).toBe("");
  });

  it("says both ends and break-even in its accessible name", () => {
    expect(render()).toContain('role="img" aria-label="0.8× measured agent time, 3.4× planned effort. Break-even is 1×."');
  });

  it("puts each end on a scale from 0 to 15% past the larger of the top end and break-even", () => {
    // max = 3.4 × 1.15 = 3.91: 0.8× sits at 20.5%, 3.4× at 87%.
    const printed = figures(render());
    expect(printed.map((figure) => figure.text)).toEqual(["0.8×", "3.4×"]);
    expect(printed[0]?.left).toBeCloseTo(20.46, 1);
    expect(printed[1]?.left).toBeCloseTo(86.96, 1);
  });

  it("orders the ends by value whichever way they arrive", () => {
    expect(figures(render({ low: high, high: low })).map((figure) => figure.text)).toEqual(["0.8×", "3.4×"]);
  });

  it("tints the zone left of break-even as where the work cost more than it returned", () => {
    const html = render();
    // break-even 1× of 3.91 is 25.6% of the bar.
    const width = Number(/style="width:([\d.]+)%" data-zone="below-break-even"/.exec(html)?.[1]);
    expect(width).toBeCloseTo(25.58, 1);
    expect(html).toContain("1× break-even");
    expect(html).toContain("Cost more than it returned");
  });

  it("draws the band between two ends, and one end alone without a band", () => {
    expect(render()).toContain("bg-[var(--viz-likely)]");
    const alone = render({ low: null });
    expect(alone).not.toContain("bg-[var(--viz-likely)]");
    expect(figures(alone).map((figure) => figure.text)).toEqual(["3.4×"]);
    expect(alone).toContain('aria-label="3.4× planned effort. Break-even is 1×."');
  });

  it("prints two ends too close to tell apart once, as a range over their midpoint", () => {
    const html = render({ low: { value: 2.1, label: "low" }, high: { value: 2.4, label: "high" } });
    const printed = figures(html);
    expect(printed.map((figure) => figure.text)).toEqual(["2.1× to 2.4×"]);
    // The midpoint 2.25 of max 2.76.
    expect(printed[0]?.left).toBeCloseTo(81.52, 1);
  });

  it("prints ends just far enough apart separately", () => {
    // 14% of max 2.76 is 0.386: 2.0× and 2.4× are 0.4 apart.
    expect(figures(render({ low: { value: 2, label: "low" }, high: { value: 2.4, label: "high" } }))).toHaveLength(2);
  });

  it("keeps break-even on the bar when both ends are far above it", () => {
    const html = render({ low: { value: 8, label: "low" }, high: { value: 12, label: "high" } });
    // 1 of 13.8 is under a fifth of the bar: no 0× label, and the break-even label starts at its tick.
    expect(html).not.toContain(">0×</span>");
    expect(html).toContain("-translate-x-1\" style=\"left:7.246");
    expect(render()).toContain(">0×</span>");
  });

  it("takes another break-even and scales to it when it is the larger", () => {
    const html = render({ high: null, breakEven: 2 });
    expect(html).toContain("Break-even is 2×.");
    expect(Number(/style="width:([\d.]+)%" data-zone/.exec(html)?.[1])).toBeCloseTo(86.96, 1);
  });

  it("compact draws the bar alone: no printed figures, no break-even label and no legend", () => {
    const html = render({ compact: true });
    expect(html).toContain('role="img" aria-label="0.8× measured agent time');
    expect(figures(html)).toHaveLength(0);
    expect(html).not.toContain("break-even</span>");
    expect(html).not.toContain("<ul");
    expect(html).toContain('data-zone="below-break-even"');
  });
});
