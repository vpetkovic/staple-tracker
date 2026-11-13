/**
 * The plan's lenses, one job each (design/plan.md, "Lenses"): Ideas is thinking, Horizons is
 * delivery, and shipped reads the same on the card, the horizon's header, the drawer and the
 * timeline. Rendered to strings, as the rest of the page's tests are.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HorizonData, IdeaData, PlanData } from "@/lib/plan-types";
import { Markdown } from "@/lib/markdown";
import { ShippedMark } from "@/detail/ShippedMark";
import { cardMenuItems, DeliveryChips, HorizonsBoard, IdeasBoard, ThinkingChips } from "./PlanBoards";
import { DependencyArrows, PlanTimeline } from "./PlanTimeline";
import { RunSettingForm, runSettingLabel } from "./RunSetting";
import { dependencyEdges, horizonDone, horizonsColumns, ideasColumns, inHorizonsLens, inIdeasLens } from "./plan-model";

function idea(id: string, extra: Partial<IdeaData> = {}): IdeaData {
  return {
    id,
    identifier: null,
    promoted: false,
    kind: "idea",
    title: `Idea ${id}`,
    description: null,
    maturity: "raw",
    stage: "raw",
    parentId: null,
    horizonId: null,
    planned: { start: null, target: null },
    baseline: null,
    rank: 0,
    links: [],
    missingLinks: [],
    linkCount: 0,
    resolvedLinks: 0,
    units: { done: 0, open: 0, planned: 0, total: 0 },
    unsized: false,
    progress: null,
    percent: null,
    actual: { start: null, end: null, forecastEnd: null },
    late: false,
    notStarted: false,
    childIds: [],
    openQuestions: 0,
    planIncomplete: [],
    completeness: { starred: 0, starredTotal: 3, filled: 0, total: 10 },
    dependsOn: [],
    state: "raw",
    actions: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

function horizon(id: string, extra: Partial<HorizonData> = {}): HorizonData {
  return {
    id,
    identifier: `LAR-${id}`,
    name: `H ${id}`,
    date: "2026-12-31",
    rank: 1,
    status: "todo",
    shipped: false,
    memberCount: 4,
    ideaCount: 0,
    lateCount: 0,
    notStartedCount: 0,
    shippedCount: 0,
    units: { done: 0, open: 0, planned: 0, total: 0 },
    unsizedCount: 0,
    records: { leaves: 0, shipped: 0, started: 0, shaped: 0, exploring: 0, raw: 0, parentCount: 0 },
    progress: 0.5,
    percent: 50,
    complete: false,
    runMode: null,
    goal: [],
    awaitingApproval: false,
    late: false,
    state: "active",
    actions: [
      { id: "queue", label: "Queue the horizon", who: "anyone" },
      { id: "run", label: "Set how agents run it", who: "person" },
    ],
    ...extra,
  };
}

const shaped = idea("shaped", { maturity: "shaped", stage: "scheduled", state: "shaped", horizonId: "now", completeness: { starred: 3, starredTotal: 3, filled: 7, total: 10 } });
const exploring = idea("exploring", { maturity: "exploring", stage: "exploring", state: "exploring", horizonId: "now", openQuestions: 2 });
const raw = idea("raw");
const started = idea("started", { maturity: "shaped", stage: "started", state: "started", horizonId: "now", promoted: true, identifier: "LAR-40", linkCount: 3, progress: 0.4, percent: 40, late: true });
const shipped = idea("shipped", {
  maturity: "shaped",
  stage: "shipped",
  state: "shipped",
  horizonId: "now",
  promoted: true,
  identifier: "LAR-41",
  linkCount: 2,
  progress: 1,
  percent: 100,
  actual: { start: "2026-10-01", end: "2026-10-03", forecastEnd: "2026-10-03" },
  planned: { start: "2026-09-28", target: "2026-10-05" },
});
const dropped = idea("dropped", { maturity: "dropped", stage: "dropped", state: "dropped" });
// An unstarted sub-idea under a started parent: still thinking, so still in Ideas.
const child = idea("child", { maturity: "exploring", stage: "exploring", state: "exploring", parentId: "started" });

function plan(ideas: IdeaData[], horizons: HorizonData[] = [horizon("now")]): PlanData {
  return { enabled: true, today: "2026-11-08", horizons, ideas };
}

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the Ideas lens is thinking only", () => {
  it("holds raw and exploring records, a sub-idea under started work included; shaping hands a record to Horizons", () => {
    const all = [raw, exploring, shaped, started, shipped, dropped, child];
    expect(all.filter((entry) => inIdeasLens(plan(all), entry)).map((entry) => entry.id)).toEqual(["raw", "exploring", "child"]);
    expect(ideasColumns(plan(all)).map((column) => [column.key, column.ideas.map((entry) => entry.id)])).toEqual([
      ["m:raw", ["raw"]],
      ["m:exploring", ["exploring", "child"]],
    ]);
  });

  it("never shows one record in both lenses", () => {
    const unscheduledShaped = idea("ready", { maturity: "shaped", stage: "shaped", state: "shaped" });
    const all = [raw, exploring, shaped, started, shipped, dropped, child, unscheduledShaped];
    const ideas = new Set(ideasColumns(plan(all)).flatMap((column) => column.ideas.map((entry) => entry.id)));
    const delivery = new Set(horizonsColumns(plan(all)).flatMap((column) => column.ideas.map((entry) => entry.id)));
    expect([...ideas].filter((id) => delivery.has(id))).toEqual([]);
    expect(horizonsColumns(plan(all))[0]).toMatchObject({ title: "Unscheduled", hint: "Ready, no horizon yet" });
    expect(horizonsColumns(plan(all))[0]!.ideas.map((entry) => entry.id)).toEqual(["ready"]);
  });

  it("shows how much of the plan is written and the horizon, and nothing about delivery", () => {
    const html = renderToStaticMarkup(<ThinkingChips idea={{ ...exploring, completeness: { starred: 3, starredTotal: 3, filled: 7, total: 10 }, linkCount: 2, late: true, notStarted: true }} horizonLabel="Now · Dec 31" />);
    expect(html).toContain('data-plan-card-completeness="3/3"');
    expect(text(html)).toContain("★ 3/3 · 7/10 written");
    expect(html).toContain("data-horizon-chip");
    expect(text(html)).toContain("◇ Now · Dec 31");
    expect(text(html)).not.toMatch(/linked|late|not started|shipped/);
  });

  it("renders no delivery card on the board", () => {
    const html = renderToStaticMarkup(<IdeasBoard plan={plan([raw, exploring, shaped, started, shipped])} write={async () => true} onOpen={() => {}} selected={null} />);
    expect(html).not.toContain('data-plan-card="started"');
    expect(html).not.toContain('data-plan-card="shipped"');
    expect(html).not.toContain('data-plan-card="shaped"');
    expect(html).toContain('data-plan-card="exploring"');
    expect(html).not.toContain("data-shipped-mark");
    expect(html).toContain('data-plan-card-completeness="0/3"');
    expect(text(html)).not.toMatch(/\bscheduled\b|% done/);
  });
});

describe("the Horizons lens is delivery", () => {
  it("holds shaped, started and shipped records, never one still being explored", () => {
    const all = [raw, exploring, shaped, started, shipped, dropped];
    expect(all.filter(inHorizonsLens).map((entry) => entry.id)).toEqual(["shaped", "started", "shipped"]);
    const now = horizonsColumns(plan(all)).find((column) => column.key === "h:now")!;
    expect(now.ideas.map((entry) => entry.id)).toEqual(["shaped", "started", "shipped"]);
  });

  it("marks a shipped card done, with its date, and no progress bar or late chip", () => {
    const html = renderToStaticMarkup(<DeliveryChips idea={shipped} />);
    expect(html).toContain("data-shipped-mark");
    expect(text(html)).toContain("Shipped Oct 3");
    expect(text(html)).not.toContain("late");
    const board = renderToStaticMarkup(<HorizonsBoard plan={plan([shipped, started])} write={async () => true} onOpen={() => {}} selected={null} />);
    expect(board).toMatch(/data-plan-card="shipped"[^>]*data-plan-card-shipped=""/);
    expect(board).not.toMatch(/data-plan-card="started"[^>]*data-plan-card-shipped/);
  });

  it("heads a horizon with its progress, ✓ n shipped, late and not started, all as the server counts them, and Queue and its run setting", () => {
    // The server counts work the cards do not show (a hand-added member, an exploring record): the header says what it says.
    const html = renderToStaticMarkup(
      <HorizonsBoard plan={plan([shipped, { ...started, late: false }], [horizon("now", { shippedCount: 1, lateCount: 3, notStartedCount: 2 })])} write={async () => true} onOpen={() => {}} selected={null} />,
    );
    expect(html).toContain('data-plan-horizon-queue="LAR-now"');
    expect(html).toContain('data-plan-horizon-run="LAR-now"');
    expect(text(html)).toContain("1 shipped");
    expect(text(html)).toContain("3 late");
    expect(text(html)).toContain("2 not started");
    expect(html).toContain('aria-label="50% done"');
    expect(text(html)).toContain("Agents: not set");
  });

  it("says a horizon waits for the person's approval", () => {
    const html = renderToStaticMarkup(<HorizonsBoard plan={plan([started], [horizon("now", { awaitingApproval: true, runMode: "goal" })])} write={async () => true} onOpen={() => {}} selected={null} />);
    expect(html).toContain('data-plan-horizon-awaiting="LAR-now"');
    expect(text(html)).toContain("Waiting for your approval");
    expect(text(html)).toContain("Agents: until its goal is met");
  });

  it("flags a shaped record whose plan is incomplete, Scaffold held back", () => {
    const incomplete = idea("incomplete", {
      maturity: "shaped",
      stage: "scheduled",
      state: "shaped",
      horizonId: "now",
      planIncomplete: ["a goal"],
      actions: [{ id: "scaffold", label: "Scaffold epic and tasks", who: "anyone", disabledReason: "It needs acceptance on task 1.2." }],
    });
    const html = renderToStaticMarkup(<DeliveryChips idea={incomplete} />);
    expect(html).toContain("data-plan-card-incomplete");
    expect(text(html)).toContain("plan incomplete");
    expect(renderToStaticMarkup(<DeliveryChips idea={shaped} />)).not.toContain("data-plan-card-incomplete");
  });

  it("shows a queued horizon's Queue held back, and offers neither button where the state does not", () => {
    const queued = renderToStaticMarkup(
      <HorizonsBoard
        plan={plan([started], [horizon("now", { actions: [{ id: "queue", label: "Queue the horizon", who: "anyone", disabledReason: "It is in the queue already." }, { id: "run", label: "Run to goal", who: "anyone" }] })])}
        write={async () => true}
        onOpen={() => {}}
        selected={null}
      />,
    );
    expect(queued).toMatch(/<button[^>]*disabled=""[^>]*data-plan-horizon-queue="LAR-now"|<button[^>]*data-plan-horizon-queue="LAR-now"[^>]*disabled=""/);
    expect(text(queued)).toContain("Queued");
    const planned = renderToStaticMarkup(<HorizonsBoard plan={plan([], [horizon("now", { state: "planned", actions: [{ id: "remove", label: "Remove", who: "person" }] })])} write={async () => true} onOpen={() => {}} selected={null} />);
    expect(planned).not.toContain("data-plan-horizon-queue");
    expect(planned).not.toContain("data-plan-horizon-run");
  });

  it("counts leaf ideas in the header, a parent apart from its children, as the server gives them", () => {
    const html = renderToStaticMarkup(
      <HorizonsBoard
        plan={plan([], [horizon("now", { ideaCount: 4, memberCount: 2, records: { leaves: 3, shipped: 1, started: 1, shaped: 1, exploring: 0, raw: 0, parentCount: 1 } })])}
        write={async () => true}
        onOpen={() => {}}
        selected={null}
      />,
    );
    expect(text(html)).toContain("3 ideas (+1 parent) · 2 members");
    expect(text(html)).not.toContain("4 ideas");
  });

  it("folds only a horizon the server reads as done, never one whose cards merely all shipped", () => {
    // Every card shipped, but the horizon still holds open work the cards do not show.
    expect(horizonDone(horizon("now", { progress: 0.5 }))).toBe(false);
    // Every counted unit landed is not shipped: a reopened member, an idea waiting for review or
    // work placed on another horizon leave its milestone open. Only the server's flag folds it.
    expect(horizonDone(horizon("now", { progress: 1, percent: 100, complete: false }))).toBe(false);
    expect(horizonDone(horizon("now", { shipped: true, progress: null }))).toBe(true);
    expect(horizonDone(horizon("now", { progress: 1, unsizedCount: 1 }))).toBe(false);
    expect(horizonDone(horizon("now", { progress: null }))).toBe(false);
    const open = renderToStaticMarkup(<HorizonsBoard plan={plan([shipped], [horizon("now", { shippedCount: 1, progress: 0.5 })])} write={async () => true} onOpen={() => {}} selected={null} />);
    expect(open).not.toContain("data-plan-horizon-done");
    expect(open).not.toMatch(/data-plan-horizon-risk[^>]*>[^]*?Shipped<\/span>/);
    const html = renderToStaticMarkup(<HorizonsBoard plan={plan([shipped], [horizon("now", { shippedCount: 1, progress: 1, percent: 100, complete: true, shipped: true })])} write={async () => true} onOpen={() => {}} selected={null} />);
    expect(html).toContain('data-plan-horizon-done=""');
    expect(html).toContain('data-plan-done-toggle="LAR-now"');
    expect(text(html)).toContain("All 4 members landed · show");
  });

  it("prints the server's percent, and says a whole 100 that is not complete is incomplete", () => {
    const board = (over: Partial<HorizonData>) => renderToStaticMarkup(<HorizonsBoard plan={plan([], [horizon("now", over)])} write={async () => true} onOpen={() => {}} selected={null} />);
    // Two of three units: the server's 66, never a rounded 67 of the page's own.
    expect(board({ progress: 2 / 3, percent: 66 })).toContain('aria-label="66% done"');
    // Every counted unit landed, an idea on it still unsized: not complete, and not folded.
    const held = board({ progress: 1, percent: 100, complete: false, unsizedCount: 1 });
    expect(text(held)).toContain("100% incomplete");
    expect(held).not.toContain("data-plan-horizon-done");
  });

  it("edits the horizon's run setting, how far agents take it and its goal, and starts nothing", () => {
    expect(runSettingLabel(null)).toBe("Agents: not set");
    expect(runSettingLabel("work")).toBe("Agents: until its work is done");
    const html = renderToStaticMarkup(<RunSettingForm horizon={horizon("now", { runMode: "epic", goal: ["Checkout works", "SDKs published"] })} busy={false} onSave={() => {}} onClose={() => {}} />);
    for (const mode of ["work", "goal", "epic"]) expect(html).toContain(`data-run-mode="${mode}"`);
    expect(html).toMatch(/data-run-mode="epic"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-run-mode="epic"/);
    expect(html).toContain("Checkout works\nSDKs published");
    expect(text(html)).not.toMatch(/staple run|run drive|Copy/);
  });
});

describe("shipped is one mark", () => {
  it("says it in words beside the check, with the date or a count", () => {
    expect(text(renderToStaticMarkup(<ShippedMark on="2026-10-03" />))).toContain("Shipped Oct 3");
    expect(text(renderToStaticMarkup(<ShippedMark on="2026-10-03" withYear />))).toContain("Shipped Oct 3, 2026");
    expect(text(renderToStaticMarkup(<ShippedMark count={4} />))).toContain("4 shipped");
  });

  it("caps a shipped bar on the timeline, and only a shipped one", () => {
    const html = renderToStaticMarkup(<PlanTimeline plan={plan([shipped, { ...started, actual: { start: "2026-10-10", end: null, forecastEnd: "2026-12-01" }, planned: { start: "2026-10-05", target: "2026-11-30" } }])} write={async () => true} onOpen={() => {}} selected={null} />);
    expect(html).toContain('data-plan-shipped-cap="shipped"');
    expect(html).not.toContain('data-plan-shipped-cap="started"');
    expect(html).toContain('aria-label="Idea shipped shipped"');
  });
});

describe("dependencies on the timeline", () => {
  const a = idea("a", { planned: { start: "2026-10-01", target: "2026-10-10" } });
  const b = idea("b", { planned: { start: "2026-10-12", target: "2026-10-20" }, dependsOn: ["a"] });
  const c = idea("c", { planned: { start: "2026-10-05", target: "2026-10-08" }, dependsOn: ["a", "gone"] });

  it("draws an edge only between two rows on the chart", () => {
    expect(dependencyEdges(plan([a, b, c]), new Set(["a", "b", "c"]))).toEqual([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ]);
    expect(dependencyEdges(plan([a, b, c]), new Set(["b", "c"]))).toEqual([]);
  });

  it("never draws an edge between a record and its own ancestor", () => {
    const parent = idea("p", { dependsOn: ["k"] });
    const wave = idea("w", { parentId: "p" });
    const child = idea("k", { parentId: "w", dependsOn: ["p", "a"] });
    expect(dependencyEdges(plan([a, parent, wave, child]), new Set(["a", "p", "w", "k"]))).toEqual([{ from: "a", to: "k" }]);
  });

  it("draws an arrow from the end of the one waited on to the start of the one waiting, red when it starts first", () => {
    const ideas = new Map([a, b, c].map((entry) => [entry.id, entry]));
    const html = renderToStaticMarkup(
      <svg>
        <DependencyArrows
          edges={[
            { from: "a", to: "b" },
            { from: "a", to: "c" },
          ]}
          ideas={ideas}
          rowTops={new Map([["a", 0], ["b", 40], ["c", 80]])}
          rowHeight={40}
          x={(day) => day}
          left={240}
          width={1000}
        />
      </svg>,
    );
    expect(html).toContain('data-plan-arrows="2"');
    expect(html).toMatch(/data-plan-arrow="a&gt;b"|data-plan-arrow="a>b"/);
    expect(html).toMatch(/class="stroke-destructive"[^>]*data-plan-arrow="a(&gt;|>)c"|data-plan-arrow="a(&gt;|>)c"[^>]*class="stroke-destructive"/);
    expect(html).toMatch(/class="stroke-text-secondary"[^>]*data-plan-arrow="a(&gt;|>)b"|data-plan-arrow="a(&gt;|>)b"[^>]*class="stroke-text-secondary"/);
  });

  it("draws nothing for a row not laid out", () => {
    const ideas = new Map([a, b].map((entry) => [entry.id, entry]));
    const html = renderToStaticMarkup(<DependencyArrows edges={[{ from: "a", to: "b" }]} ideas={ideas} rowTops={new Map([["a", 0]])} rowHeight={40} x={(day) => day} left={0} width={10} />);
    expect(html).toBe("");
  });
});

describe("plan text reads as formatted Markdown", () => {
  it("renders quotes, numbered lists, checklists, tables and emphasis", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={[
          "> Merchants integrate through the SDKs.",
          "",
          "1. First",
          "2. Second",
          "",
          "- [x] Done thing",
          "- [ ] Open thing",
          "- [~] Deferred thing",
          "",
          "| # | Task |",
          "|---|------|",
          "| 3.1 | Generate the *spec* |",
          "",
          "**Window**: soon",
        ].join("\n")}
      />,
    );
    expect(html).toContain("<blockquote");
    expect(html).toMatch(/<ol[^>]*><li[^>]*><span>First<\/span><\/li><li[^>]*><span>Second<\/span><\/li><\/ol>/);
    expect(html).toContain('data-md-check="done"');
    expect(html).toContain('data-md-check="open"');
    expect(html).toContain('data-md-check="deferred"');
    expect(html).toMatch(/<table[\s\S]*<th[^>]*>#<\/th>[\s\S]*<td[^>]*>3.1<\/td>[\s\S]*<em>spec<\/em>/);
    expect(html).toContain("<strong>Window</strong>");
    expect(html).not.toContain("**");
    expect(html).not.toContain("&gt; Merchants");
  });

  it("leaves a lone asterisk, and identifiers with underscores, alone", () => {
    const html = renderToStaticMarkup(<Markdown text="2 * 3 = 6 and snake_case_name, x*y*z" />);
    expect(text(html)).toContain("2 * 3 = 6 and snake_case_name, x*y*z");
    expect(html).not.toContain("<em>");
  });
});

describe("the counts agree everywhere", () => {
  it("heads a timeline group with its horizon's counts from the server, not the rows it draws", () => {
    const quiet = { ...started, late: false, notStarted: false, planned: { start: "2026-10-05", target: "2026-11-30" } };
    const html = renderToStaticMarkup(<PlanTimeline plan={plan([quiet], [horizon("now", { lateCount: 3, notStartedCount: 2 })])} write={async () => true} onOpen={() => {}} selected={null} />);
    expect(text(html)).toContain("3 late");
    expect(text(html)).toContain("2 not started");
  });
});

describe("a card's menu", () => {
  it("offers an exploring idea Mark shaped on the Ideas board, which has no shaped column to drop on", () => {
    const offered = idea("x", {
      maturity: "exploring",
      stage: "exploring",
      state: "exploring",
      actions: [
        { id: "shape", label: "Mark shaped", who: "person" },
        { id: "explore", label: "Start exploring", who: "person" },
        { id: "drop", label: "Drop", who: "person" },
      ],
    });
    const columns = ideasColumns(plan([offered]));
    const menu = cardMenuItems(offered, columns.find((column) => column.key === "m:exploring")!, columns);
    expect(menu.others.map((item) => item.id)).toEqual(["shape", "drop"]);
  });
});
