/**
 * Columns over an ordered axis: the stack geometry, the legend rule, the table twin, the crowded
 * axis, and the keyboard model as a pure function. Pressing the keys on the real plot, and the
 * live region it updates, are checked in a real browser in `widgets-browser.test.tsx`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ColumnChart, columnChartTable, slotReadout, stepSlot, type ColumnPoint } from "./ColumnChart";
import type { ChartSeries } from "./chart-parts";

const series: ChartSeries[] = [
  { id: "a", label: "Staple", color: "var(--viz-series-1)" },
  { id: "b", label: "Docs", color: "var(--viz-series-2)" },
];
const points: ColumnPoint[] = [
  { key: "d1", label: "Nov 1", tick: "1", values: { a: 2, b: 0 } },
  { key: "d2", label: "Nov 2", values: { a: 1, b: 3 } },
  { key: "d3", label: "Nov 3", tick: "3", values: { a: 6, b: 2 } },
];
const render = (props: Partial<Parameters<typeof ColumnChart>[0]> = {}) => renderToStaticMarkup(<ColumnChart series={series} points={points} ariaLabel="Hours per day" {...props} />);
/** Each slot's markup, in order. */
const slots = (html: string) => html.split("data-slot-index=").slice(1);

describe("the columns", () => {
  it("stack heights are proportional to each slot's total against the top tick", () => {
    // Totals 2, 4 and 8; the ticks run 0–8, so the stacks stand at a quarter, a half and all of it.
    expect(slots(render()).map((slot) => /height:([\d.]+)%/.exec(slot)?.[1])).toEqual(["25", "50", "100"]);
  });

  it("each segment takes its share of the stack, bottom series first", () => {
    const third = slots(render())[2] ?? "";
    expect([...third.matchAll(/flex-grow:([\d.]+)/g)].map((match) => Number(match[1]))).toEqual([75, 25]);
    expect(third.indexOf("viz-series-1")).toBeLessThan(third.indexOf("viz-series-2"));
  });

  it("a stack of values under 1 still fills its whole height", () => {
    // Flex-grow factors that add up to less than 1 leave part of the box empty, so a quiet day
    // (0.3 h and 0.2 h) would draw shorter than its total. Shares always add up to 100.
    const quiet: ColumnPoint[] = [{ key: "d1", label: "Nov 1", values: { a: 0.3, b: 0.2 } }];
    const grows = [...(slots(render({ points: quiet }))[0] ?? "").matchAll(/flex-grow:([\d.]+)/g)].map((match) => Number(match[1]));
    expect(grows).toEqual([60, 40]);
    expect(grows.reduce((sum, grow) => sum + grow, 0)).toBe(100);
  });

  it("a series at zero draws no segment, and only the top segment is rounded", () => {
    const first = slots(render())[0] ?? "";
    expect(first).toContain("viz-series-1");
    expect(first).not.toContain("viz-series-2");
    const third = slots(render())[2] ?? "";
    expect(third.match(/rounded-t-\[4px\]/g)).toHaveLength(1);
    expect(third.lastIndexOf("rounded-t-[4px]")).toBeGreaterThan(third.indexOf("viz-series-1"));
  });

  it("every segment is a mark that keeps its colour under forced colours", () => {
    expect(render().match(/<span data-mark="true"/g)).toHaveLength(5);
  });

  it("draws gridlines on clean ticks with the baseline at 0", () => {
    const html = render();
    expect(html.match(/data-gridline/g)).toHaveLength(5);
    expect(html).toContain("bottom:0%;background:var(--viz-baseline)");
  });
});

describe("the legend", () => {
  it("is drawn for two or more series", () => {
    expect(render()).toContain("data-chart-legend");
  });
  it("is not drawn for one series, which the title names", () => {
    expect(render({ series: [series[0]!] })).not.toContain("data-chart-legend");
  });
  it("can be turned off", () => {
    expect(render({ legend: false })).not.toContain("data-chart-legend");
  });
});

describe("the plot for a keyboard and a screen reader", () => {
  it("is one named tab stop, described by how to use it, with an empty live readout and no tooltip until a slot is active", () => {
    const html = render();
    const plot = /<div role="img"[^>]*>/.exec(html)?.[0] ?? "";
    expect(plot).toContain('aria-label="Hours per day"');
    expect(plot).toContain('tabindex="0"');
    expect(plot).toContain("focus-ring-inset");
    const hint = /aria-describedby="([^"]+)"/.exec(plot)?.[1];
    expect(html).toContain(`id="${hint}" class="sr-only">Use the left and right arrow keys to read each column.`);
    expect(html).toContain('<p aria-live="polite" class="sr-only" data-chart-readout="true"></p>');
    expect(html).not.toContain("data-chart-tooltip");
    expect(html.match(/tabindex=/g)).toHaveLength(1);
  });
});

describe("stepSlot: what a key does to the active slot", () => {
  it("Right and Left start from the near end and stop at the edges", () => {
    expect(stepSlot(null, "ArrowRight", 3)).toBe(0);
    expect(stepSlot(null, "ArrowLeft", 3)).toBe(2);
    expect(stepSlot(0, "ArrowRight", 3)).toBe(1);
    expect(stepSlot(2, "ArrowRight", 3)).toBe(2);
    expect(stepSlot(1, "ArrowLeft", 3)).toBe(0);
    expect(stepSlot(0, "ArrowLeft", 3)).toBe(0);
  });
  it("Home and End jump to the ends", () => {
    expect(stepSlot(1, "Home", 3)).toBe(0);
    expect(stepSlot(null, "Home", 3)).toBe(0);
    expect(stepSlot(0, "End", 3)).toBe(2);
    expect(stepSlot(null, "End", 3)).toBe(2);
  });
  it("Escape clears an active slot, and is left alone when nothing is active", () => {
    expect(stepSlot(1, "Escape", 3)).toBeNull();
    expect(stepSlot(null, "Escape", 3)).toBeUndefined();
  });
  it("any other key, and any key on an empty chart, is not the chart's", () => {
    expect(stepSlot(1, "Tab", 3)).toBeUndefined();
    expect(stepSlot(1, "ArrowUp", 3)).toBeUndefined();
    expect(stepSlot(null, "ArrowRight", 0)).toBeUndefined();
    expect(stepSlot(null, "End", 0)).toBeUndefined();
  });
});

describe("slotReadout: the sentence the live region says", () => {
  it("lists every series value first, then the total", () => {
    expect(slotReadout({ title: "Nov 3", rows: [{ label: "Staple", value: "6 h" }, { label: "Docs", value: "2 h" }], total: { label: "Total", value: "8 h" } })).toBe("Nov 3: 6 h Staple, 2 h Docs; 8 h Total");
  });
  it("says a lone series by its value, as the title already names it", () => {
    expect(slotReadout({ title: "Nov 3", rows: [{ label: "Agents at once", value: "3 agents" }] })).toBe("Nov 3: 3 agents");
  });
});

describe("the axis", () => {
  const ticked = (count: number) => Array.from({ length: count }, (_, index): ColumnPoint => ({ key: `p${index}`, label: `P${index}`, tick: index % 2 === 0 ? `t${index}` : undefined, values: { a: 1 } }));
  const ticks = (html: string) => [...html.matchAll(/<span class="([^"]*)" style="left:[^"]*">(t\d+)<\/span>/g)].map((match) => ({ tick: match[2], hides: match[1]!.includes("@max-[440px]/chart:hidden") }));

  it("draws a tick only where a point names one, centred on its slot", () => {
    const html = render();
    expect(html).toContain('style="left:16.666666666666664%">1</span>');
    expect(html).toContain('style="left:83.33333333333334%">3</span>');
  });

  it("a crowded axis (more than six ticks) marks every second tick to hide when the chart is narrow", () => {
    const marks = ticks(render({ series: [series[0]!], points: ticked(14) }));
    expect(marks).toHaveLength(7);
    expect(marks.map((mark) => mark.hides)).toEqual([false, true, false, true, false, true, false]);
  });

  it("an axis of six ticks or fewer hides none", () => {
    expect(ticks(render({ series: [series[0]!], points: ticked(12) })).some((mark) => mark.hides)).toBe(false);
  });
});

describe("columnChartTable", () => {
  it("has a row per point, a column per series and a total for two or more series", () => {
    expect(columnChartTable("Day", series, points, "All workspaces")).toEqual({
      columns: ["Day", "Staple", "Docs", "All workspaces"],
      rows: [
        ["Nov 1", 2, 0, 2],
        ["Nov 2", 1, 3, 4],
        ["Nov 3", 6, 2, 8],
      ],
    });
  });
  it("has no total column for one series, and counts a missing value as 0", () => {
    expect(columnChartTable("Day", [series[1]!], [{ key: "x", label: "Nov 9", values: {} }])).toEqual({ columns: ["Day", "Docs"], rows: [["Nov 9", 0]] });
  });
});
