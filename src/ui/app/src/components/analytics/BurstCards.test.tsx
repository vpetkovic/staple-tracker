/** Work in bursts: the data contract in BurstCards' header comment. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BurstCards, type Burst } from "./BurstCards";

const burst = (extra: Partial<Burst> = {}): Burst => ({
  from: "2026-11-02",
  to: "2026-11-06",
  days: 5,
  ticketsDone: 1284,
  agentHours: 96.4,
  bestDay: { day: "2026-11-04", count: 41 },
  features: [
    { title: "Analytics page", closed: 6, children: 8 },
    { title: "Inbox", closed: 3, children: 3 },
  ],
  ...extra,
});

describe("BurstCards", () => {
  it("draws one numbered card per burst, oldest first, as an ordered list", () => {
    const html = renderToStaticMarkup(<BurstCards bursts={[burst(), burst({ from: "2026-11-20", to: "2026-11-21", days: 2 })]} />);
    expect(html).toMatch(/^<ol /);
    expect(html.indexOf("Burst 1")).toBeLessThan(html.indexOf("Burst 2"));
    expect(html).toContain("Nov 20 – Nov 21 · 2 days");
  });

  it("says when it was, how much closed, the agent time and the best day", () => {
    const html = renderToStaticMarkup(<BurstCards bursts={[burst()]} />);
    expect(html).toContain("Nov 2 – Nov 6 · 5 days");
    expect(html).toContain("1,284 tickets");
    expect(html).toContain("96 h of agent time · best day 41 on Nov 4");
  });

  it("names the year of each end when a burst crosses one", () => {
    expect(renderToStaticMarkup(<BurstCards bursts={[burst({ from: "2025-12-30", to: "2026-01-02", days: 4 })]} />)).toContain("Dec 30, 2025 – Jan 2, 2026");
  });

  it("lists the features that landed with closed of children", () => {
    const html = renderToStaticMarkup(<BurstCards bursts={[burst()]} />);
    expect(html).toContain("Analytics page");
    expect(html).toContain("6 of 8");
    expect(html).toContain("3 of 3");
  });

  it("drops the feature list for hideTitles, and draws none for a burst without features", () => {
    const hidden = renderToStaticMarkup(<BurstCards bursts={[burst()]} hideTitles />);
    expect(hidden).not.toContain("Analytics page");
    expect(hidden).not.toContain("<ul");
    expect(hidden).toContain("1,284 tickets");
    expect(renderToStaticMarkup(<BurstCards bursts={[burst({ features: [] })]} />)).not.toContain("<ul");
  });

  it("draws an empty list for no bursts (the widget frame owns the empty words)", () => {
    expect(renderToStaticMarkup(<BurstCards bursts={[]} />)).not.toContain("<li");
  });
});
