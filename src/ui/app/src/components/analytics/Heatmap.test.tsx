/**
 * A week by the hour: the data contract in Heatmap's header comment, the readout, and the keyboard
 * model as a pure function. Pressing the keys on the real grid is checked in a real browser in
 * `widgets-browser.test.tsx`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Heatmap, heatmapTable, stepCell } from "./Heatmap";

const cells = [
  [0, 1, 5],
  [20, 3, 0],
];
const render = (grid: number[][] = cells) =>
  renderToStaticMarkup(<Heatmap cells={grid} rows={["Mon", "Tue"]} columns={["12a", "", "2a"]} columnNames={["12 am", "1 am", "2 am"]} format={(value) => `${value} tickets`} ariaLabel="Tickets closed by weekday and hour" />);
const levels = (html: string) => [...html.matchAll(/data-mark="true" class="h-4 [^"]*viz-heat-(\d)/g)].map((match) => Number(match[1]));

describe("Heatmap", () => {
  it("colours each cell in five steps of the busiest, with zero as the empty step", () => {
    // Up to the next step, so any count above zero shows: 1/20 → 1, 5/20 → 2, 20/20 → 5, 3/20 → 1.
    expect(levels(render())).toEqual([0, 1, 2, 5, 1, 0]);
  });

  it("draws every cell empty when nothing happened", () => {
    expect(levels(render([[0, 0, 0], [0, 0, 0]]))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("names its rows, ticks its columns where asked and draws the six-step scale", () => {
    const html = render();
    expect(html).toContain(">Mon</span>");
    expect(html).toContain(">12a</span>");
    expect(html).toContain("Fewer");
    expect(html).toContain("More");
    expect(html.match(/data-mark="true" class="size-3 rounded-\[3px\] viz-heat-\d"/g)).toHaveLength(6);
  });

  it("is one named tab stop described by how to use it, with a live readout of the busiest hour", () => {
    const html = render();
    const grid = /<div role="img"[^>]*>/.exec(html)?.[0] ?? "";
    expect(grid).toContain('aria-label="Tickets closed by weekday and hour"');
    expect(grid).toContain('tabindex="0"');
    expect(grid).toContain("focus-ring-inset");
    const hint = /aria-describedby="([^"]+)"/.exec(grid)?.[1];
    expect(html).toContain(`id="${hint}" class="sr-only">Use the arrow keys to read each hour.`);
    expect(html.match(/tabindex=/g)).toHaveLength(1);
    expect(html).toContain('<span aria-live="polite" class="tabular-nums">Busiest hour: 20 tickets</span>');
    expect(html).not.toContain("data-active");
  });

  it("heatmapTable gives the same grid as numbers, one row per weekday", () => {
    expect(heatmapTable(cells, ["Mon", "Tue"], ["12 am", "1 am", "2 am"])).toEqual({
      columns: ["", "12 am", "1 am", "2 am"],
      rows: [
        ["Mon", 0, 1, 5],
        ["Tue", 20, 3, 0],
      ],
    });
  });
});

describe("stepCell: what a key does to the active cell", () => {
  const at = (row: number, column: number) => ({ row, column });
  it("the first arrow lands on the top left cell", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"]) expect(stepCell(null, key, 7, 24), key).toEqual(at(0, 0));
  });
  it("arrows move one cell and stop at the edges", () => {
    expect(stepCell(at(2, 5), "ArrowRight", 7, 24)).toEqual(at(2, 6));
    expect(stepCell(at(2, 5), "ArrowLeft", 7, 24)).toEqual(at(2, 4));
    expect(stepCell(at(2, 5), "ArrowDown", 7, 24)).toEqual(at(3, 5));
    expect(stepCell(at(2, 5), "ArrowUp", 7, 24)).toEqual(at(1, 5));
    expect(stepCell(at(0, 0), "ArrowUp", 7, 24)).toEqual(at(0, 0));
    expect(stepCell(at(0, 0), "ArrowLeft", 7, 24)).toEqual(at(0, 0));
    expect(stepCell(at(6, 23), "ArrowDown", 7, 24)).toEqual(at(6, 23));
    expect(stepCell(at(6, 23), "ArrowRight", 7, 24)).toEqual(at(6, 23));
  });
  it("Home and End go to the ends of the row", () => {
    expect(stepCell(at(3, 9), "Home", 7, 24)).toEqual(at(3, 0));
    expect(stepCell(at(3, 9), "End", 7, 24)).toEqual(at(3, 23));
    expect(stepCell(null, "End", 7, 24)).toEqual(at(0, 23));
  });
  it("Escape clears an active cell, and is left alone when nothing is active", () => {
    expect(stepCell(at(1, 1), "Escape", 7, 24)).toBeNull();
    expect(stepCell(null, "Escape", 7, 24)).toBeUndefined();
  });
  it("any other key, and any key on an empty grid, is not the grid's", () => {
    expect(stepCell(at(1, 1), "Enter", 7, 24)).toBeUndefined();
    expect(stepCell(null, "a", 7, 24)).toBeUndefined();
    expect(stepCell(null, "ArrowRight", 0, 0)).toBeUndefined();
  });
});
