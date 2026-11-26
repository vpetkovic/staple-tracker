/**
 * The Plan view's shared parts: a state is never colour alone, a flag says what it flags, and a
 * horizon's header prints the server's numbers with a date difference beside its date.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HorizonData, IdeaState } from "@/lib/plan-types";
import { Flag, HorizonSummary, StateGlyph } from "./plan-parts";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function horizon(extra: Partial<HorizonData> = {}): HorizonData {
  return {
    id: "mvp",
    identifier: "LAR-7",
    name: "MVP",
    date: "2027-02-27",
    rank: 1,
    status: "todo",
    shipped: false,
    memberCount: 89,
    ideaCount: 23,
    lateCount: 4,
    notStartedCount: 2,
    shippedCount: 5,
    units: { done: 149, open: 53, planned: 28, total: 230 },
    unsizedCount: 0,
    records: { leaves: 17, shipped: 5, started: 7, shaped: 4, exploring: 1, raw: 0, parentCount: 6 },
    progress: 0.64,
    percent: 64,
    complete: false,
    runMode: "epic",
    goal: [],
    awaitingApproval: false,
    late: true,
    state: "active",
    actions: [],
    planSteps: [],
    needsYou: 3,
    ...extra,
  };
}

describe("the state glyph", () => {
  const STATES: IdeaState[] = ["raw", "exploring", "shaped", "started", "shipped"];

  it("is a picture only, hidden from assistive technology, one per state", () => {
    const drawn = STATES.map((state) => renderToStaticMarkup(<StateGlyph state={state} percent={40} />));
    for (const html of drawn) {
      expect(html).toMatch(/^<span aria-hidden="true"/);
      expect(text(html)).toBe("");
    }
    expect(new Set(drawn).size).toBe(STATES.length);
  });

  it("names its state in words when asked to carry them", () => {
    expect(STATES.map((state) => text(renderToStaticMarkup(<StateGlyph state={state} percent={40} word />)))).toEqual(["Raw", "Exploring", "Shaped", "Started", "Shipped"]);
  });

  it("fills a started record's wedge by the server's percent, never empty and never whole", () => {
    const wedge = (percent: number | null) => /<path d="([^"]+)"/.exec(renderToStaticMarkup(<StateGlyph state="started" percent={percent} />))?.[1];
    expect(wedge(0)).toBe(wedge(null));
    expect(wedge(0)).not.toBe(wedge(40));
    // An arc that ends where it starts (7, 3.4) draws nothing: empty at 0, and gone again at 100.
    for (const percent of [0, 100]) expect(wedge(percent)).not.toMatch(/ 7\.00 3\.40 Z$/);
    expect(wedge(100)).toContain(" 1 1 ");
  });
});

describe("a flag", () => {
  it("says what it flags in words, by its tone, or in the words it is given", () => {
    expect(text(renderToStaticMarkup(<Flag tone="late" />))).toBe("late");
    expect(text(renderToStaticMarkup(<Flag tone="notStarted" />))).toBe("not started");
    expect(text(renderToStaticMarkup(<Flag tone="you" />))).toBe("needs you");
    expect(text(renderToStaticMarkup(<Flag tone="late">4 late</Flag>))).toBe("4 late");
  });
});

describe("a horizon's summary", () => {
  it("prints its name, its date and how far off it is, from the plan's day", () => {
    expect(text(renderToStaticMarkup(<HorizonSummary horizon={horizon()} today="2026-11-26" />))).toContain("MVP Feb 27, 2027 · in 93 days");
    expect(text(renderToStaticMarkup(<HorizonSummary horizon={horizon({ date: "2026-11-14" })} today="2026-11-26" />))).toContain("Nov 14, 2026 · 12 days ago");
    expect(text(renderToStaticMarkup(<HorizonSummary horizon={horizon({ date: "2026-11-27" })} today="2026-11-26" />))).toContain("· in 1 day");
    expect(text(renderToStaticMarkup(<HorizonSummary horizon={horizon({ date: "2026-11-26" })} today="2026-11-26" />))).toContain("Nov 26, 2026 · today");
    expect(text(renderToStaticMarkup(<HorizonSummary horizon={horizon()} />))).toContain("MVP Feb 27, 2027");
    expect(text(renderToStaticMarkup(<HorizonSummary horizon={horizon()} />))).not.toContain("days");
  });

  it("prints the server's percent, its flags and its counts with the units", () => {
    const words = text(renderToStaticMarkup(<HorizonSummary horizon={horizon({ awaitingApproval: true })} today="2026-11-26" />));
    expect(words).toContain("64% Waiting for your approval Needs you: 3 4 late 2 not started 5 shipped");
    expect(words).toContain("17 ideas (+6 parents) · 89 members · 5 shipped · 7 started · 4 shaped · 1 exploring · 149 done, 53 open, 28 planned");
  });

  it("marks a horizon the server reads as done shipped, without late or not started", () => {
    const words = text(renderToStaticMarkup(<HorizonSummary horizon={horizon({ shipped: true })} />));
    expect(words).toContain("Shipped");
    expect(words).not.toMatch(/late|not started/);
  });

  it("leaves the title to a surface that has its own, and its risk flags to one that prints them", () => {
    const words = text(renderToStaticMarkup(<HorizonSummary horizon={horizon()} heading={null} risk={false} />));
    expect(words).not.toContain("MVP");
    expect(words).toContain("Needs you: 3");
    expect(words).not.toMatch(/late|not started/);
  });
});
