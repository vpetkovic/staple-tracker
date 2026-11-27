/** The pieces every chart shares: the colour slots, the legend, the tooltip box and its anchor. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChartLegend, ChartTooltip, seriesColor, SERIES_SLOTS, tooltipAnchor } from "./chart-parts";

describe("seriesColor", () => {
  it("gives the six fixed slots in order and folds anything else into Other", () => {
    expect(SERIES_SLOTS).toBe(6);
    expect(seriesColor(1)).toBe("var(--viz-series-1)");
    expect(seriesColor(6)).toBe("var(--viz-series-6)");
    expect(seriesColor(7)).toBe("var(--viz-series-other)");
    expect(seriesColor(0)).toBe("var(--viz-series-other)");
  });
});

describe("ChartLegend", () => {
  it("names every series for two or more, beside a mark that keeps its colour under forced colours", () => {
    const html = renderToStaticMarkup(<ChartLegend series={[{ id: "a", label: "Staple", color: "red" }, { id: "b", label: "Docs", color: "blue" }]} />);
    expect(html).toContain("Staple");
    expect(html).toContain("Docs");
    expect(html.match(/data-mark="true"/g)).toHaveLength(2);
  });
  it("draws nothing for one series", () => {
    expect(renderToStaticMarkup(<ChartLegend series={[{ id: "a", label: "Staple", color: "red" }]} />)).toBe("");
  });
});

describe("ChartTooltip", () => {
  it("is hidden from a screen reader, which hears the chart's live region instead", () => {
    const html = renderToStaticMarkup(<ChartTooltip title="Nov 3" rows={[{ key: "a", label: "Staple", value: "6 h", color: "red" }]} total={{ label: "Total", value: "8 h" }} />);
    expect(html).toMatch(/^<div aria-hidden="true"/);
    expect(html).not.toContain('role="status"');
    expect(html).toContain("Nov 3");
    expect(html).toContain("6 h");
    expect(html).toContain("8 h");
  });
});

describe("tooltipAnchor", () => {
  it("centres over a middle slot and hugs the edge near either end", () => {
    expect(tooltipAnchor(1, 4)).toEqual({ left: "37.5%", transform: "translateX(-50%)" });
    expect(tooltipAnchor(0, 10)).toEqual({ left: "5%", transform: "translateX(-12px)" });
    expect(tooltipAnchor(9, 10)).toEqual({ right: "5%", transform: "translateX(12px)" });
  });
});
