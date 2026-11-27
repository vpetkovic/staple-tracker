/**
 * The Plan page's frame: one toolbar whose "Show only" focus and filter narrow every lens alike,
 * keeping a match's ancestors, and a capture that lives where the lens needs it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs } from "@/components/ui/tabs";
import type { HorizonData, IdeaData, PlanData, PlanStepData } from "@/lib/plan-types";
import { PlanBar, PlanLens } from "./PlanView";
import type { Lens } from "./plan-model";
import type { PlanFocus } from "./plan-focus";

function idea(id: string, extra: Partial<IdeaData> = {}): IdeaData {
  return {
    id,
    identifier: null,
    number: null,
    promoted: false,
    kind: "idea",
    title: `Idea ${id}`,
    description: null,
    briefLine: null,
    maturity: "shaped",
    stage: "scheduled",
    parentId: null,
    horizonId: "now",
    planned: { start: "2026-11-01", target: "2026-12-15" },
    baseline: null,
    rank: 0,
    links: [],
    explorations: [],
    missingLinks: [],
    linkCount: 0,
    resolvedLinks: 0,
    units: { done: 0, open: 0, planned: 0, total: 0 },
    unsized: false,
    own: { done: 0, open: 0, planned: 0, total: 0 },
    umbrella: false,
    carriedBy: "now",
    nextStep: null,
    progress: null,
    percent: null,
    actual: { start: null, end: null, forecastEnd: null },
    late: false,
    notStarted: false,
    delivered: null,
    childIds: [],
    openQuestions: 0,
    planIncomplete: [],
    completeness: { starred: 0, starredTotal: 3, filled: 0, total: 10 },
    dependsOn: [],
    state: "shaped",
    actions: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

const now: HorizonData = {
  id: "now",
  identifier: "LAR-1",
  name: "Now",
  date: "2027-03-05",
  rank: 1,
  status: "todo",
  shipped: false,
  memberCount: 4,
  ideaCount: 4,
  lateCount: 1,
  notStartedCount: 0,
  shippedCount: 0,
  units: { done: 1, open: 1, planned: 1, total: 3 },
  unsizedCount: 0,
  records: { leaves: 3, shipped: 0, started: 1, shaped: 2, exploring: 0, raw: 0, parentCount: 1 },
  progress: 0.33,
  percent: 33,
  complete: false,
  runMode: null,
  goal: [],
  awaitingApproval: false,
  late: true,
  state: "active",
  actions: [],
  planSteps: [],
  needsYou: 1,
};

const asks: PlanStepData = { ideaId: "asks", title: "", parentId: "thinking", parentTitle: null, horizonId: "now", state: "exploring", need: "answer_questions", who: "person", instruction: "", questions: ["Which?"] };

// Delivery: a parent with a late started child, and a shaped sibling that is neither.
const parent = idea("parent", { title: "Checkout" });
const late = idea("late", { parentId: "parent", title: "Gift cards", state: "started", stage: "started", late: true, percent: 40 });
const calm = idea("calm", { title: "Calm" });
// Thinking: an exploring parent whose exploring child needs the person, and one that does not.
const thinking = idea("thinking", { title: "Mobile", maturity: "exploring", stage: "exploring", state: "exploring", carriedBy: null, horizonId: null, planned: { start: null, target: null } });
const needsYou = idea("asks", { title: "Dark mode", parentId: "thinking", maturity: "exploring", stage: "exploring", state: "exploring", carriedBy: null, horizonId: null, planned: { start: null, target: null }, nextStep: asks });
const quiet = idea("quiet", { title: "Quiet", maturity: "raw", stage: "raw", state: "raw", carriedBy: null, horizonId: null, planned: { start: null, target: null } });

const PLAN: PlanData = { enabled: true, today: "2026-11-25", horizons: [now], ideas: [parent, late, calm, thinking, needsYou, quiet] };

const lensHtml = (lens: Lens, focus: PlanFocus, text = "") =>
  renderToStaticMarkup(<PlanLens lens={lens} plan={PLAN} focus={focus} text={text} onClear={() => {}} write={async () => true} onOpen={() => {}} selected={null} capture={async () => true} />);
const marked = (html: string, attribute: string) => [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map((match) => match[1]);

describe("the focus narrows every lens", () => {
  it("keeps a late child with its parent on Horizons and the Timeline, and drops the rest", () => {
    expect(marked(lensHtml("horizons", "late"), "data-plan-tree-row")).toEqual(["parent", "late"]);
    expect(marked(lensHtml("horizons", "all"), "data-plan-tree-row")).toEqual(["parent", "late", "calm"]);
    expect(marked(lensHtml("timeline", "late"), "data-plan-timeline-row")).toEqual(["parent", "late"]);
    expect(marked(lensHtml("timeline", "all"), "data-plan-timeline-row")).toEqual(["parent", "late", "calm"]);
  });

  it("keeps an idea that needs the person under its parent's card on Ideas, shown without a click", () => {
    const html = lensHtml("ideas", "you");
    expect(marked(html, "data-plan-card")).toEqual(["thinking"]);
    expect(marked(html, "data-plan-child")).toEqual(["asks"]);
    expect(marked(lensHtml("ideas", "all"), "data-plan-card")).toEqual(["quiet", "thinking"]);
  });

  it("narrows by the filter text the same way", () => {
    expect(marked(lensHtml("horizons", "all", "gift"), "data-plan-tree-row")).toEqual(["parent", "late"]);
  });

  it("says nothing matches, with a way out, where the narrowed plan has nothing for the lens", () => {
    for (const lens of ["ideas", "horizons", "timeline"] as const) {
      const html = lensHtml(lens, "all", "no such idea");
      expect(html).toContain("Nothing here matches.");
      expect(html).toContain("data-plan-clear-filter");
    }
    // Late work is all delivery: Ideas has nothing for it, Horizons does.
    expect(lensHtml("ideas", "late")).toContain("Nothing here matches.");
    expect(lensHtml("horizons", "late")).not.toContain("Nothing here matches.");
  });

  it("keeps Raw's heading and capture field on Ideas when nothing matches, the way out below them", () => {
    const html = lensHtml("ideas", "late");
    expect(html).toContain('aria-label="Raw"');
    expect(html).toContain("data-plan-capture");
    expect(html.indexOf("data-plan-capture")).toBeLessThan(html.indexOf("Nothing here matches."));
    expect(html.indexOf("Nothing here matches.")).toBeLessThan(html.indexOf("data-plan-clear-filter"));
    expect(lensHtml("horizons", "all", "no such idea")).not.toContain("data-plan-capture");
  });
});

const barHtml = (lens: Lens, focus: PlanFocus = "all", ideas = PLAN.ideas) =>
  renderToStaticMarkup(
    <Tabs value={lens}>
      <PlanBar lens={lens} plan={{ ...PLAN, ideas }} focus={focus} onFocus={() => {}} text="" onText={() => {}} onCapture={async () => true} onViewIdeas={() => {}} tools={null} />
    </Tabs>,
  );

describe("the toolbar", () => {
  it("counts the records in Ideas and the horizons on their lens tabs", () => {
    const html = barHtml("horizons");
    expect(html).toContain('aria-label="Ideas, 3"');
    expect(html).toContain('aria-label="Horizons, 1"');
  });

  it("offers a labelled group of focus pills with the payload's counts, a pill with none left out", () => {
    const html = barHtml("horizons", "late");
    expect(html).toMatch(/role="group" aria-label="Show only"/);
    expect(marked(html, "data-plan-focus")).toEqual(["you", "late"]);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-plan-focus="late"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-plan-focus="you"/);
    expect(renderToStaticMarkup(<Tabs value="horizons"><PlanBar lens="horizons" plan={{ ...PLAN, ideas: [calm] }} focus="all" onFocus={() => {}} text="" onText={() => {}} onCapture={async () => true} onViewIdeas={() => {}} tools={null} /></Tabs>)).not.toContain('aria-label="Show only"');
  });

  it("keeps a pressed pill drawn when its count falls to none, so it can be turned off", () => {
    expect(marked(barHtml("horizons", "notStarted"), "data-plan-focus")).toEqual(["you", "late", "notStarted"]);
  });

  it("captures from a button on Horizons and the Timeline, and leaves Ideas to its Raw list", () => {
    for (const lens of ["horizons", "timeline"] as const) expect(barHtml(lens)).toContain("data-plan-capture-open");
    expect(barHtml("ideas")).not.toContain("data-plan-capture-open");
    expect(barHtml("ideas")).not.toContain("data-plan-capture");
    expect(lensHtml("ideas", "all")).toMatch(/data-plan-column="m:raw"[^]*data-plan-capture/);
  });
});
