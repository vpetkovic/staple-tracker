/**
 * One tree on three surfaces (design/plan.md, "Presentation"): the Horizons lens column, the
 * horizon drawer and the Milestones view draw the same rows, header and bar from one payload;
 * a reserved row is never a card and never dragged; below the desk breakpoint a group folds
 * behind a disclosure and nothing is dragged. Rendered to strings, as the page's tests are.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { detail, issue } from "@/detail/detail-fixture";
import { useIssueActions } from "@/detail/IssueActions";
import { HorizonSection } from "@/detail/PlanActions";
import type { HorizonData, IdeaData, PlanData, PlanStepData } from "@/lib/plan-types";
import { SessionContext } from "@/lib/session";
import type { IssueDetail } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { progress, view } from "@/views/milestones/fixtures";
import { memberListRows } from "@/views/milestones/milestones-model";
import { MilestoneDetailPane } from "@/views/milestones/MilestonesView";
import { HorizonsBoard, IdeasBoard } from "./PlanBoards";

const ZERO = { done: 0, open: 0, planned: 0, total: 0 };
const noop = () => {};

function idea(id: string, title: string, extra: Partial<IdeaData> = {}): IdeaData {
  return {
    id,
    identifier: null,
    promoted: false,
    kind: "idea",
    title,
    description: null,
    maturity: "shaped",
    stage: "scheduled",
    parentId: null,
    horizonId: null,
    planned: { start: null, target: null },
    baseline: null,
    rank: 0,
    links: [],
    missingLinks: [],
    linkCount: 0,
    resolvedLinks: 0,
    units: ZERO,
    unsized: false,
    own: ZERO,
    umbrella: false,
    carriedBy: null,
    progress: null,
    percent: null,
    actual: { start: null, end: null, forecastEnd: null },
    late: false,
    notStarted: false,
    delivered: null,
    childIds: [],
    openQuestions: 0,
    planIncomplete: [],
    completeness: { starred: 3, starredTotal: 3, filled: 5, total: 10 },
    dependsOn: [],
    state: "shaped",
    actions: [],
    nextStep: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

function step(ideaId: string, need: PlanStepData["need"], who: PlanStepData["who"], extra: Partial<PlanStepData> = {}): PlanStepData {
  return { ideaId, title: ideaId, parentId: null, parentTitle: null, horizonId: "now", state: "shaped", need, who, instruction: "", ...extra };
}

function horizon(id: string, name: string, extra: Partial<HorizonData> = {}): HorizonData {
  return {
    id,
    identifier: `LAR-${id}`,
    name,
    date: "2026-12-31",
    rank: 1,
    status: "in_progress",
    shipped: false,
    memberCount: 2,
    ideaCount: 6,
    lateCount: 0,
    notStartedCount: 0,
    shippedCount: 1,
    units: { done: 3, open: 1, planned: 2, total: 6 },
    unsizedCount: 0,
    records: { leaves: 5, shipped: 1, started: 1, shaped: 2, exploring: 1, raw: 0, parentCount: 1 },
    progress: 0.5,
    percent: 50,
    complete: false,
    runMode: null,
    goal: [],
    awaitingApproval: false,
    late: false,
    state: "active",
    actions: [],
    planSteps: [],
    needsYou: 1,
    ...extra,
  };
}

// Checkout API on Now: an umbrella over a sub-idea underway and one on Later. Billing export is
// still being explored on Now; Audit trail waits on a date; Report search's turn has come;
// Invoice search was delivered outside the tracker.
const checkout = idea("checkout", "Checkout API", { horizonId: "now", carriedBy: "now", umbrella: true, units: { done: 2, open: 1, planned: 2, total: 5 }, percent: 40, progress: 0.4, state: "started", stage: "started", linkCount: 1, childIds: ["cards", "refunds"] });
const cards = idea("cards", "Card payments", { parentId: "checkout", carriedBy: "now", own: { done: 2, open: 1, planned: 0, total: 3 }, units: { done: 2, open: 1, planned: 0, total: 3 }, state: "started", stage: "started", percent: 66, linkCount: 1 });
const refunds = idea("refunds", "Refunds", { parentId: "checkout", horizonId: "later", carriedBy: "later", own: { done: 0, open: 0, planned: 3, total: 3 }, units: { done: 0, open: 0, planned: 3, total: 3 } });
const billing = idea("billing", "Billing export", { horizonId: "now", carriedBy: "now", maturity: "exploring", stage: "exploring", state: "exploring", openQuestions: 2, nextStep: step("billing", "answer_questions", "person", { questions: ["Which format?", "Who reads it?"] }) });
const audit = idea("audit", "Audit trail", { horizonId: "now", carriedBy: "now", own: { done: 0, open: 0, planned: 2, total: 2 }, units: { done: 0, open: 0, planned: 2, total: 2 }, nextStep: step("audit", "wait", "nobody", { waitingOn: { start: "2026-12-01" } }) });
const reports = idea("reports", "Reports", { horizonId: "later", carriedBy: "later", childIds: ["search"] });
const search = idea("search", "Report search", { parentId: "reports", horizonId: "now", carriedBy: "now", nextStep: step("search", "scaffold", "agent") });
const invoices = idea("invoices", "Invoice search", { horizonId: "now", carriedBy: "now", state: "shipped", stage: "shipped", delivered: { on: "2026-10-03", note: null }, actual: { start: null, end: "2026-10-03", forecastEnd: null }, own: { done: 1, open: 0, planned: 0, total: 1 }, units: { done: 1, open: 0, planned: 0, total: 1 }, percent: 100 });
const ledger = idea("ledger", "Ledger", { horizonId: "later", carriedBy: "later" });

const NOW_H = horizon("now", "Now");
const LATER_H = horizon("later", "Later", { needsYou: 0, records: { leaves: 2, shipped: 0, started: 0, shaped: 2, exploring: 0, raw: 0, parentCount: 0 } });
const ALL = [checkout, cards, refunds, billing, audit, reports, search, invoices, ledger];
// What the server's horizon detail sends for Now: the records its tree draws (`horizonTreeRecords`).
const DETAIL_IDEAS = [checkout, cards, refunds, billing, audit, reports, search, invoices];
const NAMES = [
  { id: "now", name: "Now" },
  { id: "later", name: "Later" },
];

const plan = (horizons: HorizonData[] = [NOW_H, LATER_H]): PlanData => ({ enabled: true, today: "2026-11-13", horizons, ideas: ALL });
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

/** Now's column of the lens: its markup only. */
function lensColumn(html: string, key = "h:now"): string {
  const start = html.indexOf(`data-plan-column="${key}"`);
  const next = html.indexOf("data-plan-column=", start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

/** The tree's rows in the order drawn: id, depth, reserved, where, step. */
function rows(html: string): string[] {
  return [...html.matchAll(/<div data-plan-tree-row="([^"]+)" data-plan-tree-depth="(\d)"( data-plan-tree-reserved="")?( data-plan-tree-where="([^"]+)")?/g)].map(
    (m) => `${m[1]}@${m[2]}${m[3] ? " reserved" : ""}${m[5] ? ` (${m[5]})` : ""}`,
  );
}

function Drawer({ horizonView }: { horizonView: HorizonData }) {
  const controller = useIssueActions(noop);
  return <HorizonSection detail={detail()} horizon={horizonView} ideas={DETAIL_IDEAS} horizons={NAMES} controller={controller} />;
}

function Milestones({ horizonView, desk = true }: { horizonView: HorizonData; desk?: boolean }) {
  const controller = useIssueActions(noop);
  const data = view({ milestone: { id: "now", identifier: "LAR-now", title: "Now" }, progress: progress({ counts: { done: 3, ready: 1 } }) });
  const withPlan: IssueDetail = detail({ issue: issue({ id: "now", identifier: "LAR-now", kind: "milestone", title: "Now" }), horizonPlan: { horizon: horizonView, ideas: DETAIL_IDEAS, horizons: NAMES } });
  return (
    <MilestoneDetailPane
      view={data}
      members={memberListRows(data, [], "staple")}
      now={new Date("2026-11-13T12:00:00.000Z")}
      busy={false}
      failure={null}
      fullScreen={false}
      onToggleFullScreen={noop}
      onOpen={noop}
      onMove={noop}
      onRemove={noop}
      onAdd={noop}
      onReload={noop}
      onDismissFailure={noop}
      decision={{ detail: withPlan, controller }}
      desk={desk}
    />
  );
}

const inSession = (node: React.ReactNode) => renderToStaticMarkup(<SessionContext.Provider value={fakeSession({ ws: "staple" })}>{node}</SessionContext.Provider>);
// Now's column is the current one, so a phone, which shows one column, shows it too.
const lens = (horizons?: HorizonData[]) => lensColumn(renderToStaticMarkup(<HorizonsBoard plan={plan(horizons)} write={async () => true} onOpen={noop} selected={null} currentColumn="h:now" />));
const drawer = (h = NOW_H) => inSession(<Drawer horizonView={h} />);
const milestones = (h = NOW_H) => inSession(<Milestones horizonView={h} />);

/** Render as if the viewport were `width` px: what the browser's `matchMedia` would answer. */
function atWidth(width: number, draw: () => string): string {
  const globals = globalThis as { window?: unknown };
  const previous = globals.window;
  globals.window = {
    matchMedia: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const max = /max-width:\s*(\d+)px/.exec(query);
      return { matches: min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false, addEventListener: noop, removeEventListener: noop };
    },
  };
  try {
    return draw();
  } finally {
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const TREE = ["checkout@0", "cards@1", "refunds@1 (on Later)", "billing@0 reserved", "audit@0", "search@0", "invoices@0"];

describe("one tree on three surfaces", () => {
  it("draws the same rows in the lens column, the horizon drawer and the Milestones view", () => {
    expect(rows(lens())).toEqual(TREE);
    expect(rows(drawer())).toEqual(TREE);
    expect(rows(milestones())).toEqual(TREE);
  });

  it("heads each with leaf records apart from the parent, the states, the server's percent and what needs the person", () => {
    for (const html of [lens(), drawer(), milestones()]) {
      const words = text(html);
      expect(words).toContain("5 ideas (+1 parent) · 2 members");
      expect(words).toContain("1 shipped · 1 started · 2 shaped · 1 exploring");
      expect(words).toContain("Needs you: 1");
      expect(html).toContain('aria-label="50% done"');
      expect(html).toContain('data-plan-tree-bar="3/1/2"');
    }
  });

  it("gives each row its own state, its bar, its questions and its step", () => {
    for (const html of [lens(), drawer(), milestones()]) {
      const words = text(html);
      expect(html).toContain('data-plan-tree-bar="2/1/2"'); // the group's rollup
      expect(html).toContain('data-plan-tree-bar="2/1/0"'); // its sub-idea's own
      expect(words).toContain("2 open questions");
      expect(words).toContain("needs you: 2 questions");
      expect(words).toContain("starts Dec 1");
      expect(words).toContain("ready to scaffold");
      expect(words).toContain("on Later");
      expect(words).toContain("↳ Reports");
      expect(words).toContain("Shipped Oct 3 outside the tracker");
      // A dimmed sub-idea draws no bar of its own on this horizon.
      expect(html).not.toContain('data-plan-tree-bar="0/0/3"');
    }
  });

  it("links each row to its own drawer in Plan from the drawer and Milestones, and opens it in place on the lens", () => {
    for (const html of [drawer(), milestones()]) expect(html).toContain('data-open-plan-idea="cards"');
    expect(lens()).toContain('data-plan-child="cards"');
  });

  it("keeps a horizon at 100% that is not complete open, never folded, and says it is incomplete", () => {
    const held = horizon("now", "Now", { percent: 100, progress: 1, complete: false, units: { done: 6, open: 0, planned: 0, total: 6 } });
    const column = lens([held, LATER_H]);
    expect(column).not.toContain("data-plan-horizon-done");
    expect(column).not.toContain("data-plan-done-toggle");
    for (const html of [column, drawer(held), milestones(held)]) {
      expect(text(html)).toContain("100% incomplete");
      expect(rows(html)).toEqual(TREE);
    }
  });
});

describe("a reserved row", () => {
  it("shows a record being explored on its horizon, still a card in the Ideas lens, and is never a card or dragged in Horizons", () => {
    const column = lens();
    expect(column).toMatch(/data-plan-tree-row="billing"[^>]*data-plan-tree-reserved=""/);
    expect(column).not.toContain('data-plan-card="billing"');
    expect(column).not.toMatch(/data-plan-tree-row="billing"[^>]*draggable/);
    expect(renderToStaticMarkup(<IdeasBoard plan={plan()} write={async () => true} onOpen={noop} selected={null} />)).toContain('data-plan-card="billing"');
  });
});

describe("on the desk and on a phone", () => {
  it("shows sub-ideas without a click and drags delivery rows on the desk, never a reserved or dimmed one", () => {
    const column = atWidth(1280, () => lens());
    expect(column).toContain('data-plan-tree-row="cards"');
    expect(column).not.toContain("data-plan-tree-disclosure");
    expect(column).toMatch(/data-plan-tree-row="checkout"[^>]*draggable="true"/);
    expect(column).toMatch(/data-plan-tree-row="cards"[^>]*draggable="true"/);
    expect(column).not.toMatch(/data-plan-tree-row="refunds"[^>]*draggable/);
    expect(column).not.toMatch(/data-plan-tree-row="billing"[^>]*draggable/);
  });

  it("folds a parent's sub-ideas behind a disclosure below 768px and drags nothing, its chips and bars kept", () => {
    for (const html of [atWidth(390, () => lens()), atWidth(390, () => drawer())]) {
      expect(html).toMatch(/data-plan-tree-disclosure="checkout"[^>]*>|aria-expanded="false"[^>]*data-plan-tree-disclosure="checkout"/);
      expect(text(html)).toContain("Show sub-ideas");
      expect(html).not.toContain('data-plan-tree-row="cards"');
      expect(html).not.toContain("draggable");
      expect(html).toContain('data-plan-tree-bar="2/1/2"');
      expect(text(html)).toContain("needs you: 2 questions");
    }
  });
});
