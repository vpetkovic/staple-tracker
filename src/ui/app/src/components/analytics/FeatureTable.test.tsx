/**
 * What got built: the data contract in FeatureTable's header comment (limit and "Show all",
 * hideTitles, onOpen, the span and the closed share). Pressing "Show all" is checked in a real
 * browser in `widgets-browser.test.tsx`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FeatureTable, type FeatureRow } from "./FeatureTable";

const row = (n: number, extra: Partial<FeatureRow> = {}): FeatureRow => ({ ref: `STA-${n}`, title: `Feature ${n}`, closed: 3, children: 4, shipped: false, agentHours: 12.4, spanDays: 5, ...extra });
const rows = Array.from({ length: 10 }, (_, index) => row(index + 1));
const render = (props: Partial<Parameters<typeof FeatureTable>[0]> = {}) => renderToStaticMarkup(<FeatureTable rows={rows} {...props} />);
const items = (html: string) => html.match(/<li /g)?.length ?? 0;

describe("FeatureTable", () => {
  it("shows the first eight rows and a Show all button naming the count", () => {
    const html = render();
    expect(items(html)).toBe(8);
    expect(html).toContain("Feature 8");
    expect(html).not.toContain("Feature 9");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show all 10 features");
  });

  it("takes another limit, and shows no button when every row fits", () => {
    expect(items(render({ limit: 3 }))).toBe(3);
    const all = render({ limit: 10 });
    expect(items(all)).toBe(10);
    expect(all).not.toContain("Show all");
  });

  it("Show all keeps its desk size on touch and grows a 32px tap area", () => {
    const button = /<button[^>]*aria-expanded[^>]*>/.exec(render())?.[0] ?? "";
    expect(button).toContain("focus-ring");
    // 16px of text-label and 8px of invisible area above and below: 32px.
    expect(button).toContain("min-h-0");
    expect(button).toContain("before:-inset-y-2");
  });

  it("makes the title a button that opens the ref when onOpen is given, with a 32px tap area", () => {
    const html = render({ rows: [row(1)], onOpen: () => {} });
    const button = /<button type="button" class="([^"]+)">Feature 1<\/button>/.exec(html)?.[1] ?? "";
    expect(button).toContain("focus-ring");
    expect(button).toContain("min-h-0");
    // 20px of text-body and 6px above and below.
    expect(button).toContain("before:-inset-y-1.5");
    expect(render({ rows: [row(1)] })).not.toContain("<button");
  });

  it("hideTitles replaces every title with its reference and does not repeat it", () => {
    const html = render({ rows: [row(7, { workspace: { label: "Staple", color: "red" } })], hideTitles: true, onOpen: () => {} });
    expect(html).not.toContain("Feature 7");
    expect(html).toContain(">STA-7</button>");
    expect(html.match(/STA-7/g)).toHaveLength(1);
    expect(html).toContain("Staple");
  });

  it("shows the reference under the title when titles are shown", () => {
    expect(render({ rows: [row(7)] }).match(/STA-7/g)).toHaveLength(1);
    expect(render({ rows: [row(7)] })).toContain("Feature 7");
  });

  it("says closed of children in text and in the bar's name, with the bar at the closed share", () => {
    const html = render({ rows: [row(1)] });
    expect(html).toContain('role="img" aria-label="3 of 4 tickets closed"');
    expect(html).toContain('style="width:75%"');
    expect(render({ rows: [row(1, { closed: 0, children: 0 })] })).toContain('style="width:0%"');
  });

  it("marks a shipped feature with a named check and leaves others unmarked", () => {
    const shipped = /<svg[^>]*aria-label="Shipped in this period"[^>]*>/.exec(render({ rows: [row(1, { shipped: true })] }))?.[0] ?? "";
    expect(shipped).not.toBe("");
    expect(shipped).not.toContain("aria-hidden");
    expect(render({ rows: [row(1)] })).not.toContain("Shipped in this period");
  });

  it("says how long it ran: a dash for nothing closed, one day, or days", () => {
    expect(render({ rows: [row(1, { spanDays: null })] })).toContain(">—</span>");
    expect(render({ rows: [row(1, { spanDays: 1 })] })).toContain(">1 day</span>");
    expect(render({ rows: [row(1, { spanDays: 5 })] })).toContain(">5 days</span>");
  });

  it("says the agent time in effort hours and draws the workspace dot only when given", () => {
    expect(render({ rows: [row(1)] })).toContain(">12 h</span>");
    expect(render({ rows: [row(1, { agentHours: 9.54 })] })).toContain(">9.5 h</span>");
    expect(render({ rows: [row(1)] })).not.toContain("rounded-full\" style=\"background");
    expect(render({ rows: [row(1, { workspace: { label: "Docs", color: "var(--viz-series-2)" } })] })).toContain('data-mark="true" class="size-2 shrink-0 rounded-full" style="background:var(--viz-series-2)"');
  });
});
