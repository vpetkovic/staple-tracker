/**
 * One whole split into parts: the data contract in SegmentedBar's header comment, and that every
 * part's name, amount and share is reachable without hover (the accessible name and the legend).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SegmentedBar, type SegmentPart } from "./SegmentedBar";

const parts: SegmentPart[] = [
  { id: "done", label: "Done", value: 75 },
  { id: "failed", label: "Failed", value: 20 },
  { id: "dropped", label: "Dropped", value: 0 },
  { id: "stalled", label: "Stalled", value: 5 },
];
const render = (props: Partial<Parameters<typeof SegmentedBar>[0]> = {}) => renderToStaticMarkup(<SegmentedBar parts={parts} ariaLabel="Attempts by how they ended" {...props} />);
const blocks = (html: string) => [...html.matchAll(/<span data-mark="true" title="([^"]+)" class="([^"]+)" style="([^"]+)">([^<]*)<\/span>/g)].map((match) => ({ title: match[1], className: match[2], style: match[3], text: match[4] }));

describe("SegmentedBar", () => {
  it("names every part with its amount and share in the bar's accessible name", () => {
    expect(render()).toContain('role="img" aria-label="Attempts by how they ended: Done 75 (75%), Failed 20 (20%), Stalled 5 (5%)"');
  });

  it("names every part with its amount in the legend, in block order", () => {
    const legend = render().split("<ul")[1] ?? "";
    expect(legend).toContain("Done<span");
    expect(legend).toContain(">75</span>");
    expect(legend).toContain(">20</span>");
    expect(legend).toContain(">5</span>");
    expect(legend.indexOf("Done")).toBeLessThan(legend.indexOf("Failed"));
    expect(legend.indexOf("Failed")).toBeLessThan(legend.indexOf("Stalled"));
  });

  it("draws nothing for a part at zero, in the bar or the legend", () => {
    const html = render();
    expect(html).not.toContain("Dropped");
    expect(blocks(html)).toHaveLength(3);
  });

  it("sizes each block by its value and prints the share on it only where it fits (9% and up)", () => {
    const drawn = blocks(render());
    expect(drawn.map((block) => /flex-grow:(\d+)/.exec(block.style ?? "")?.[1])).toEqual(["75", "20", "5"]);
    expect(drawn.map((block) => block.text)).toEqual(["75%", "20%", ""]);
    expect(drawn[2]?.title).toBe("Stalled: 5 (5%)");
  });

  it("colours parts by the categorical slots in drawn order, and a part's own colour wins", () => {
    const drawn = blocks(render({ parts: [{ ...parts[0]!, color: "var(--plain-ok-fg)" }, parts[1]!, parts[3]!] }));
    expect(drawn.map((block) => /background:(.+)$/.exec(block.style ?? "")?.[1])).toEqual(["var(--plain-ok-fg)", "var(--viz-series-2)", "var(--viz-series-3)"]);
  });

  it("draws ordered parts dark to light in one hue, with ink labels on the two light steps", () => {
    const four = [1, 2, 3, 4].map((n): SegmentPart => ({ id: `p${n}`, label: `P${n}`, value: 25 }));
    const drawn = blocks(render({ parts: four, tone: "ordinal" }));
    expect(drawn.every((block) => block.style?.includes("var(--viz-accent)"))).toBe(true);
    expect(drawn.map((block) => block.className?.includes("text-foreground"))).toEqual([false, false, true, true]);
  });

  it("says amounts with the given format", () => {
    expect(render({ format: (value) => `${value} attempts` })).toContain("Done 75 attempts (75%)");
  });

  it("says there is nothing to show when every part is zero, instead of a dangling name", () => {
    const html = render({ parts: [{ id: "x", label: "X", value: 0 }] });
    expect(html).toContain('aria-label="Attempts by how they ended: nothing to show"');
    expect(blocks(html)).toHaveLength(0);
  });
});
