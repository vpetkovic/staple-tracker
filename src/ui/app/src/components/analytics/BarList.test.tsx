/** Ranked horizontal bars: the data contract in BarList's header comment. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarList, type BarListItem } from "./BarList";

const items: BarListItem[] = [
  { id: "a", label: "Staple", value: 490, text: "490 h", detail: "62%" },
  { id: "b", label: "Docs", value: 245, text: "245 h", color: "var(--viz-series-2)" },
  { id: "c", label: "Tiny", value: 1, text: "1 h" },
  { id: "d", label: "No model logged", value: 98, text: "98 h", muted: true },
  { id: "e", label: "Nothing", value: 0, text: "0 h" },
];
const render = (props: Partial<Parameters<typeof BarList>[0]> = {}) => renderToStaticMarkup(<BarList items={items} ariaLabel="Agent time by workspace" {...props} />);
const widths = (html: string) => [...html.matchAll(/data-mark="true" class="block h-full rounded-full" style="width:([^;"]+)/g)].map((match) => match[1]);

describe("BarList", () => {
  it("is a named list with one row per item, in the order given", () => {
    const html = render();
    expect(html).toMatch(/^<ul aria-label="Agent time by workspace"/);
    expect(html.match(/<li /g)).toHaveLength(5);
    expect(html.indexOf("Staple")).toBeLessThan(html.indexOf("Docs"));
  });

  it("scales bars to the largest value, with a visible floor for a small one and nothing for zero", () => {
    expect(widths(render())).toEqual(["100%", "50%", "1.5%", "20%", "0%"]);
  });

  it("scales to a given max instead", () => {
    expect(widths(render({ items: [items[1]!], max: 980 }))).toEqual(["25%"]);
  });

  it("draws nothing for a list of zeros, never a NaN width", () => {
    expect(widths(render({ items: [items[4]!] }))).toEqual(["0"]);
  });

  it("paints the accent by default, a row's own colour when given, and the neutral for a caveat row", () => {
    const html = render();
    const fills = [...html.matchAll(/data-mark="true"[^>]*background:([^"]+)"/g)].map((match) => match[1]);
    expect(fills).toEqual(["var(--viz-accent)", "var(--viz-series-2)", "var(--viz-accent)", "var(--viz-series-other)", "var(--viz-accent)"]);
    expect(html).toContain('<span class="min-w-0 truncate text-body text-muted-foreground italic">No model logged</span>');
  });

  it("says each value in words beside its bar, with the quiet detail after it", () => {
    const html = render();
    expect(html).toContain('<span class="font-medium">490 h</span><span class="ml-2 text-label text-muted-foreground">62%</span>');
  });

  it("draws every track as a track, outlined under forced colours", () => {
    expect(render().match(/data-track="true"/g)).toHaveLength(5);
  });
});
