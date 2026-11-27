/**
 * The Horizons lens as an outline: "Not scheduled" first, by that one name everywhere it appears,
 * a parent's shipped leaves gathered into one line, groups folded on a compact tree, nothing
 * folded while a filter is on, drop targets marked only where the idea's state offers the move,
 * the date links only where the horizon offers a date, and the keys that walk the outline.
 * Rendered to strings, as the page's other tests are; the keys are pinned on the pure outline.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { HorizonData, IdeaData, PlanData } from "@/lib/plan-types";
import { DropRail, FoldAll, foldAll, HorizonsBoard, lensColumns, ReadySection } from "./HorizonsLens";
import { cardMenuItems } from "./plan-board";
import { horizonsColumns } from "./plan-model";
import { outlineEntries, outlineKey, shippedKey } from "./plan-outline";
import { planTree } from "./plan-tree";

const ZERO = { done: 0, open: 0, planned: 0, total: 0 };
const noop = () => {};

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
    carriedBy: extra.horizonId === undefined ? "now" : extra.horizonId,
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

function horizon(id: string, extra: Partial<HorizonData> = {}): HorizonData {
  return {
    id,
    identifier: `LAR-${id}`,
    name: id === "now" ? "Now" : "Later",
    date: "2026-12-31",
    rank: 1,
    status: "in_progress",
    shipped: false,
    memberCount: 4,
    ideaCount: 4,
    lateCount: 0,
    notStartedCount: 0,
    shippedCount: 0,
    units: ZERO,
    unsizedCount: 0,
    records: { leaves: 4, shipped: 0, started: 0, shaped: 4, exploring: 0, raw: 0, parentCount: 0 },
    progress: null,
    percent: null,
    complete: false,
    runMode: null,
    goal: [],
    awaitingApproval: false,
    late: false,
    state: "active",
    actions: [{ id: "rename", label: "Rename", who: "person" }],
    planSteps: [],
    needsYou: 0,
    ...extra,
  };
}

const shipped = (id: string, parentId: string) => idea(id, { parentId, state: "shipped", stage: "shipped", actual: { start: null, end: "2026-10-03", forecastEnd: null }, percent: 100 });
// A parent on Now: three shipped leaves and one started sub-idea.
const co = idea("co", { title: "Checkout", childIds: ["r0", "r1", "r2", "r3"] });
const r0 = shipped("r0", "co");
const r1 = shipped("r1", "co");
const r2 = shipped("r2", "co");
const r3 = idea("r3", { parentId: "co", state: "started", stage: "started", percent: 30, own: { done: 1, open: 2, planned: 0, total: 3 } });
const IDEAS = [co, r0, r1, r2, r3];

const plan = (ideas: IdeaData[] = IDEAS, horizons: HorizonData[] = [horizon("now"), horizon("later")]): PlanData => ({ enabled: true, today: "2026-11-13", horizons, ideas });
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const board = (over: { plan?: PlanData; filtering?: boolean; folded?: Record<string, boolean> } = {}) =>
  renderToStaticMarkup(<HorizonsBoard plan={over.plan ?? plan()} write={async () => true} onOpen={noop} selected={null} filtering={over.filtering} folded={over.folded} onFold={noop} />);
const drawn = (html: string) => [...html.matchAll(/data-plan-tree-row="([^"]+)"/g)].map((m) => m[1]);

/** Render as if the viewport were `width` px: what `matchMedia` would answer. */
function atWidth(width: number, draw: () => string): string {
  (globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      return { matches: min ? width >= Number(min[1]) : query.includes("pointer: fine") ? width >= 768 : false, addEventListener: noop, removeEventListener: noop };
    },
  };
  try {
    return draw();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("Not scheduled", () => {
  it("is one quiet line when no record lacks a horizon, still a drop target for unscheduling", () => {
    const html = board();
    expect(html).toMatch(/<section aria-label="Not scheduled" data-plan-column="h:"/);
    expect(text(html)).toContain("Not scheduled Nothing here. A shaped idea lands here until you give it a horizon.");
    expect(html).not.toContain("data-plan-ready");
    expect(text(html)).not.toMatch(/Unscheduled|Ready, not scheduled/);
  });

  it("is a section with its rows when records have no horizon, and says how many", () => {
    const waiting = [idea("a", { horizonId: null }), idea("b", { horizonId: null })];
    const html = board({ plan: plan([...IDEAS, ...waiting]) });
    const ready = html.slice(html.indexOf('data-plan-column="h:"'), html.indexOf('data-plan-column="h:now"'));
    expect(ready).toContain("data-plan-ready");
    expect(text(ready)).toContain("Not scheduled 2 ideas with no horizon");
    expect(drawn(ready)).toEqual(["a", "b"]);
    expect(text(ready)).not.toContain("Nothing here");
    const one = board({ plan: plan([...IDEAS, waiting[0]!]) });
    expect(text(one)).toContain("1 idea with no horizon");
  });

  it("is the same name on the drop rail and in a row's move menu", () => {
    const movable = idea("m", { actions: [{ id: "schedule", label: "Schedule", who: "person" }] });
    const data = plan([...IDEAS, movable]);
    const columns = lensColumns(data);
    const rail = renderToStaticMarkup(<DropRail lens={{ plan: data, columns, write: async () => true, dragging: movable, onDrag: noop }} />);
    expect(text(rail)).toContain("Move to Not scheduled Now Later");
    expect(cardMenuItems(movable, columns[1]!, columns).moves.map((move) => move.title)).toEqual(["Not scheduled", "Later"]);
  });
});

describe("a parent's shipped leaves", () => {
  it("gather into one line ahead of the rest, the leaves not drawn until it opens", () => {
    const html = board();
    expect(html).toContain('data-plan-shipped-fold="co"');
    expect(text(html)).toContain("3 shipped: Idea r0, Idea r1, Idea r2");
    expect(drawn(html)).toEqual(["co", "r3"]);
  });

  it("open on request, and stay gathered with fewer than two", () => {
    const rows = planTree({ horizonId: "now", ideas: IDEAS, horizons: [] });
    const keys = (shipOpen: Set<string>) => outlineEntries(rows, { isOpen: () => true, shipOpen, unfold: false }).map((entry) => entry.key);
    expect(keys(new Set())).toEqual(["co", shippedKey("co"), "r3"]);
    expect(keys(new Set(["co"]))).toEqual(["co", "r0", "r1", "r2", "r3"]);
    const one = planTree({ horizonId: "now", ideas: [co, r0, r3], horizons: [] });
    expect(outlineEntries(one, { isOpen: () => true, shipOpen: new Set(), unfold: false }).map((entry) => entry.key)).toEqual(["co", "r0", "r3"]);
  });
});

describe("a compact tree", () => {
  it("starts its groups folded, the folded parent saying how many sub-ideas it holds", () => {
    const html = atWidth(390, () => board());
    expect(drawn(html)).toEqual(["co"]);
    expect(html).toMatch(/aria-expanded="false" data-plan-tree-disclosure="co"/);
    expect(text(html)).toContain("4 sub-ideas");
    expect(drawn(atWidth(1280, () => board()))).toEqual(["co", "r3"]);
  });
});

describe("while a focus or filter is on", () => {
  it("folds nothing: compact groups open, shipped leaves apart and a done horizon open", () => {
    const done = horizon("now", { shipped: true, percent: 100, complete: true });
    const html = atWidth(390, () => board({ plan: plan(IDEAS, [done]), filtering: true }));
    expect(html).not.toContain("data-plan-shipped-fold");
    expect(drawn(html)).toEqual(["co", "r0", "r1", "r2", "r3"]);
    // Without the filter the same done horizon starts folded.
    expect(drawn(atWidth(390, () => board({ plan: plan(IDEAS, [done]) })))).toEqual([]);
  });

  it("draws no fold control, so nothing folds out of sight until the filter is cleared", () => {
    const done = horizon("later", { shipped: true, percent: 100, complete: true });
    const html = board({ plan: plan(IDEAS, [horizon("now"), done]), filtering: true });
    expect(html).not.toContain("data-plan-tree-disclosure");
    expect(html).not.toContain("data-plan-horizon-fold");
    expect(html).not.toContain("data-plan-done-toggle");
    expect(text(html)).toContain("All 4 members landed");
    expect(text(html)).not.toMatch(/landed · (show|hide)/);
    // The parent keeps the chevron's room, so its title does not shift.
    expect(html).toMatch(/data-plan-tree-row="co"[^]*?<span aria-hidden="true" class="size-\[18px\] shrink-0"><\/span>/);
    // Without the filter each is a control again.
    const plain = board({ plan: plan(IDEAS, [horizon("now"), done]) });
    expect(plain).toContain('data-plan-tree-disclosure="co"');
    expect(plain).toContain('data-plan-horizon-fold="LAR-now"');
    expect(plain).toContain('data-plan-done-toggle="LAR-later"');
  });

  it("moves focus with Left and Right and never folds", () => {
    const rows = planTree({ horizonId: "now", ideas: IDEAS, horizons: [] });
    const all = outlineEntries(rows, { isOpen: () => false, shipOpen: new Set(), unfold: true });
    expect(outlineKey(all, "co", "ArrowRight", false)).toEqual({ focus: "r0" });
    expect(outlineKey(all, "co", "ArrowLeft", false)).toBeNull();
    expect(outlineKey(all, "r3", "ArrowLeft", false)).toEqual({ focus: "co" });
    expect(outlineKey(all, "r3", "ArrowRight", false)).toBeNull();
  });
});

describe("folds the person chose", () => {
  // Now is open with its group; Later is done with one record; one record waits with no horizon.
  const done = horizon("later", { shipped: true, percent: 100, complete: true });
  const full = plan([...IDEAS, idea("l1", { horizonId: "later" }), idea("w1", { horizonId: null })], [horizon("now"), done]);
  const empty = plan([...IDEAS, idea("l1", { horizonId: "later" })], [horizon("now"), done]);
  const section = (html: string, key: string) => {
    const start = html.indexOf(`data-plan-column="h:${key}"`);
    const end = html.indexOf("data-plan-column=", start + 1);
    return html.slice(start, end === -1 ? undefined : end);
  };

  it("with no choice folds a done horizon and leaves the rest unfolded", () => {
    const html = board({ plan: full, folded: {} });
    expect(drawn(section(html, "later"))).toEqual([]);
    expect(text(section(html, "later"))).toContain("All 4 members landed · show");
    expect(drawn(section(html, "now"))).toEqual(["co", "r3"]);
    expect(drawn(section(html, ""))).toEqual(["w1"]);
  });

  it("applies a remembered fold to an open horizon and a remembered unfold to a done one", () => {
    const html = board({ plan: full, folded: { now: true, later: false } });
    expect(drawn(section(html, "now"))).toEqual([]);
    expect(section(html, "now")).toContain('aria-expanded="false" aria-label="Show Now"');
    expect(drawn(section(html, "later"))).toEqual(["l1"]);
    expect(text(section(html, "later"))).toContain("All 4 members landed · hide");
  });

  it("applies nothing it remembers while a focus or filter is on", () => {
    const html = board({ plan: full, folded: { now: true, later: true, none: true }, filtering: true });
    expect(drawn(section(html, "now"))).toEqual(["co", "r0", "r1", "r2", "r3"]);
    expect(drawn(section(html, "later"))).toEqual(["l1"]);
    expect(drawn(section(html, ""))).toEqual(["w1"]);
    expect(html).not.toContain("data-plan-ready-fold");
  });

  it("gives Not scheduled the horizon's chevron when it has rows, and folds it", () => {
    const open = section(board({ plan: full, folded: {} }), "");
    expect(open).toMatch(/<button type="button" aria-expanded="true" aria-label="Hide Not scheduled" data-plan-ready-fold="" class="[^"]*-ml-1 inline-flex size-5[^"]*before:-inset-1\.5/);
    // The header keeps the horizon header's padding, so the chevron and the title sit at a horizon's x.
    expect(open).toMatch(/<header class="[^"]*\bpx-4 py-3 [^"]*@max-\[760px\]\/plan:gap-x-2 @max-\[760px\]\/plan:px-3" data-plan-ready="true">/);
    const folded = section(board({ plan: full, folded: { none: true } }), "");
    expect(folded).toContain('aria-expanded="false" aria-label="Show Not scheduled"');
    expect(drawn(folded)).toEqual([]);
    expect(text(folded)).toContain("Not scheduled 1 idea with no horizon");
    // Its one quiet line has nothing to fold.
    expect(section(board({ plan: empty, folded: { none: false } }), "")).not.toContain("data-plan-ready-fold");
  });

  it("collapses every section while one that folds is open, and expands them once all are folded", () => {
    const every = (value: boolean) => ({ none: value, now: value, later: value });
    expect(foldAll(full, {})).toEqual({ collapse: true, changes: every(true) });
    expect(foldAll(full, { none: true, now: true })).toEqual({ collapse: false, changes: every(false) });
    expect(foldAll(full, { now: true, later: false, none: true })).toEqual({ collapse: true, changes: every(true) });
    // An empty Not scheduled cannot fold, so it does not hold the control at Collapse all.
    expect(foldAll(empty, { now: true })).toEqual({ collapse: false, changes: every(false) });
    expect(foldAll(empty, { now: true, none: false })?.collapse).toBe(false);
    // With nothing that folds there is nothing to do.
    expect(foldAll(plan([], []), {})).toBeNull();
  });

  it("names the control by what it will do and holds it while a focus or filter is on", () => {
    const control = (over: { folded?: Record<string, boolean>; filtering?: boolean; data?: PlanData }) =>
      renderToStaticMarkup(<FoldAll plan={over.data ?? full} folded={over.folded ?? {}} onFold={noop} filtering={over.filtering ?? false} />);
    expect(text(control({}))).toContain("Collapse all");
    expect(control({})).toContain("lucide-chevrons-down-up");
    expect(control({})).not.toContain(`disabled=""`);
    expect(text(control({ folded: { none: true, now: true } }))).toContain("Expand all");
    expect(control({ folded: { none: true, now: true } })).toContain("lucide-chevrons-up-down");
    const held = control({ filtering: true });
    expect(held).toMatch(/<button[^>]*disabled=""/);
    expect(held).toContain('title="Clear the focus and filter to fold sections"');
    expect(control({ data: plan([], []) })).toMatch(/<button[^>]*disabled=""/);
  });

  it("sits at the right end of the outline's first line, for the widths where the toolbar has no room", () => {
    const html = board({ plan: full, folded: {} });
    // In Not scheduled's line, before any horizon: the top of the outline, not its last row.
    const at = html.indexOf("data-plan-fold-all");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf("data-plan-horizon="));
    expect(html.match(/data-plan-fold-all/g)).toHaveLength(1);
    // A small text button, shown only under 900px of the Plan container; never a 44px box.
    expect(html).toMatch(/@max-\[900px\]\/plan:inline-flex[^>]*>\s*<button[^>]*\bh-7\b[^>]*data-plan-fold-all/);
    expect(html).not.toMatch(/<button[^>]*min-h-11[^>]*data-plan-fold-all/);
  });
});

describe("dragging to schedule", () => {
  // On Now, it may be scheduled elsewhere; dropping it on Now again changes nothing.
  const movable = idea("m", { actions: [{ id: "schedule", label: "Schedule", who: "person" }] });
  // Its state offers no scheduling at all.
  const held = idea("h");
  const lensFor = (dragging: IdeaData) => ({ plan: plan([...IDEAS, movable, held]), columns: horizonsColumns(plan([...IDEAS, movable, held])), write: async () => true, dragging, onDrag: noop });
  const marks = (html: string) => Object.fromEntries([...html.matchAll(/data-plan-drop-target="([^"]*)" data-plan-drop="(\w+)" class="([^"]*)"/g)].map((m) => [m[1], { state: m[2], ring: m[3]!.includes("border-ring") }]));

  it("marks on the drop rail only the sections the idea's state offers and that move it", () => {
    expect(marks(renderToStaticMarkup(<DropRail lens={lensFor(movable)} />))).toEqual({
      "h:": { state: "allowed", ring: true },
      "h:now": { state: "refused", ring: false },
      "h:later": { state: "allowed", ring: true },
    });
    expect(Object.values(marks(renderToStaticMarkup(<DropRail lens={lensFor(held)} />)))).toEqual([
      { state: "refused", ring: false },
      { state: "refused", ring: false },
      { state: "refused", ring: false },
    ]);
  });

  it("gives a section that would refuse the drop no highlight", () => {
    const ready = (dragging: IdeaData) => {
      const lens = { ...lensFor(dragging), onOpen: noop, selected: null, filtering: false, folded: {}, onFold: noop, visit: new Set<string>(), landed: null };
      return renderToStaticMarkup(<ReadySection lens={lens} column={lens.columns[0]!} />);
    };
    expect(ready(movable)).toMatch(/data-plan-drop="allowed" class="[^"]*shadow-\[inset_0_0_0_2px_var\(--color-ring\)\]/);
    expect(ready(held)).toContain('data-plan-drop="refused"');
    expect(ready(held)).not.toContain("--color-ring");
  });
});

describe("a horizon's date", () => {
  it("offers add a date and clear only where the horizon offers its date", () => {
    const html = (h: HorizonData) => board({ plan: plan([], [h]) });
    expect(html(horizon("now", { date: null }))).not.toContain("data-plan-horizon-date");
    expect(html(horizon("now"))).not.toContain("data-plan-horizon-clear-date");
    const dated = [{ id: "date", label: "Change date", who: "person" as const }];
    expect(html(horizon("now", { date: null, actions: dated }))).toContain('data-plan-horizon-date="LAR-now"');
    expect(html(horizon("now", { actions: dated }))).toContain('data-plan-horizon-clear-date="LAR-now"');
  });
});

describe("the keys on a focused row", () => {
  const rows = planTree({ horizonId: "now", ideas: IDEAS, horizons: [] });
  const entries = (open: boolean, shipOpen = new Set<string>()) => outlineEntries(rows, { isOpen: () => open, shipOpen, unfold: false });

  it("move up and down the visible lines and stop at the ends", () => {
    expect(outlineKey(entries(true), "co", "ArrowDown")).toEqual({ focus: shippedKey("co") });
    expect(outlineKey(entries(true), "r3", "ArrowUp")).toEqual({ focus: shippedKey("co") });
    expect(outlineKey(entries(true), "r3", "ArrowDown")).toBeNull();
    expect(outlineKey(entries(true), "co", "ArrowUp")).toBeNull();
  });

  it("open a folded group with Right, then step into it; fold it with Left, or go to the parent", () => {
    expect(outlineKey(entries(false), "co", "ArrowRight")).toEqual({ toggle: "co" });
    expect(outlineKey(entries(true), "co", "ArrowRight")).toEqual({ focus: shippedKey("co") });
    expect(outlineKey(entries(true), "co", "ArrowLeft")).toEqual({ toggle: "co" });
    expect(outlineKey(entries(true), "r3", "ArrowLeft")).toEqual({ focus: "co" });
    expect(outlineKey(entries(true, new Set(["co"])), "r1", "ArrowLeft")).toEqual({ focus: "co" });
  });

  it("open the idea with Enter or Space, and the shipped line's leaves from that line", () => {
    expect(outlineKey(entries(true), "r3", "Enter")).toEqual({ activate: "r3" });
    expect(outlineKey(entries(true), "co", " ")).toEqual({ activate: "co" });
    expect(outlineKey(entries(true), shippedKey("co"), "Enter")).toEqual({ shipOpen: "co" });
    expect(outlineKey(entries(true), shippedKey("co"), "ArrowRight")).toEqual({ shipOpen: "co" });
  });
});
