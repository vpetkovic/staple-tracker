/**
 * The graph on a phone (review B-polish): the first frame is readable — node text at 11px,
 * never the 2–3px a whole-graph fit gives on a 360px canvas — and starts at the graph's left.
 */
import { describe, expect, it } from "vitest";
import { DESKTOP_FIT, initialFit, PHONE_MIN_ZOOM, TABLET_MIN_ZOOM } from "./phone-fit";

/** Node labels are 10px (TaskNode, ClusterNode); what a reader sees is 10px × zoom. */
const LABEL_PX = 10;

const columns = (count: number, gap = 320) =>
  Array.from({ length: count * 3 }, (_, i) => ({ id: `n${i}`, position: { x: Math.floor(i / 3) * gap + 40, y: (i % 3) * 90 } }));

describe("initialFit", () => {
  it("fits the whole graph on a desktop, unchanged", () => {
    expect(initialFit(columns(5), 1440, 1400)).toEqual(DESKTOP_FIT);
  });

  it("never draws node text below 11px on a phone", () => {
    for (const width of [360, 390]) {
      const fit = initialFit(columns(5), width, width - 32);
      expect(fit.minZoom! * LABEL_PX, `${width}`).toBeGreaterThanOrEqual(11);
      expect(fit.maxZoom).toBe(PHONE_MIN_ZOOM);
    }
    expect(initialFit(columns(5), 768, 736).minZoom! * LABEL_PX).toBeGreaterThanOrEqual(10);
    expect(initialFit(columns(5), 768, 736).minZoom).toBe(TABLET_MIN_ZOOM);
  });

  it("frames the left of the graph — the first column — not its middle", () => {
    const fit = initialFit(columns(5), 390, 358);
    const framed = new Set(fit.nodes!.map((node) => node.id));
    expect(framed).toEqual(new Set(["n0", "n1", "n2"]));
  });

  it("frames by top-level boxes only (a child's position is relative to its parent)", () => {
    const nodes = [
      { id: "epic", position: { x: 500, y: 0 } },
      { id: "child", position: { x: 0, y: 0 }, parentId: "epic" },
      { id: "far", position: { x: 5000, y: 0 } },
    ];
    expect(initialFit(nodes, 390, 358).nodes).toEqual([{ id: "epic" }]);
  });

  it("still fixes a readable zoom before there is anything to frame", () => {
    const fit = initialFit([], 390, 358);
    expect(fit.minZoom).toBe(PHONE_MIN_ZOOM);
    expect(fit.nodes).toBeUndefined();
  });
});
