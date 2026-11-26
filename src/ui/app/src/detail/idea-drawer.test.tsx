/**
 * The idea drawer's Plan tab and header as a document: "Where it stands" first and by state, the
 * properties, the section chips, the sections read before they are edited, and the rare actions
 * last. Rendered to a string; the clicks (answer, defer, jump, open a row, open an unwritten
 * section, the Delivered form) run in a real browser in test/ui-idea-drawer.test.ts.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IdeaData, IdeaDetailData, OfferedAction } from "@/lib/plan-types";
import { SessionContext } from "@/lib/session";
import { fakeSession } from "@/views/fake-session";
import { detail, issue } from "./detail-fixture";
import { IdeaStatusLine } from "./PlanActions";
import { PlanTab } from "./tabs/PlanTab";
import { estimateHours } from "./tabs/plan-tab-model";

const noop = () => {};
const ID = "6f0c2d1e-7a3b-4c55-9e10-2b8d4f6a7c90";
const act = (id: string, extra: Partial<OfferedAction> = {}): OfferedAction => ({ id, label: id, who: "person", ...extra });
const EDITS = [act("edit"), act("ask"), act("decide")];

function idea(patch: Partial<IdeaData> = {}): IdeaData {
  return {
    id: ID,
    identifier: null,
    promoted: false,
    kind: "idea",
    title: "Coach shares a program",
    description: null,
    briefLine: null,
    maturity: "exploring",
    stage: "exploring",
    parentId: null,
    horizonId: null,
    planned: { start: null, target: null },
    baseline: null,
    rank: 1024,
    links: [],
    missingLinks: [],
    linkCount: 0,
    resolvedLinks: 0,
    units: { done: 0, open: 0, planned: 0, total: 0 },
    unsized: false,
    own: { done: 0, open: 0, planned: 0, total: 0 },
    umbrella: false,
    carriedBy: null,
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
    completeness: { starred: 3, starredTotal: 3, filled: 7, total: 10 },
    dependsOn: [],
    state: "exploring",
    actions: [...EDITS, act("shape", { disabledReason: "It needs 1 open question answered or deferred before it is shaped." })],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...patch,
  };
}

function record(view: IdeaData, patch: Partial<IdeaDetailData> = {}): IdeaDetailData {
  return {
    idea: view,
    parent: null,
    children: [],
    horizon: null,
    brief: "A coach shares a program with a client.",
    questions: [],
    decisions: [],
    linked: [],
    plan: {
      goal: "Ship the sharing link.",
      context: null,
      breakdown: [
        { key: "7.1", title: "Spike the link", estimate: "3h", dependsOn: [], acceptance: "Findings written", owner: "vp", notes: "Read the old share code first." },
        { key: "7.2", title: "Build the link", estimate: "1d", dependsOn: ["7.1"], acceptance: null, owner: null, notes: null },
      ],
      acceptance: ["A client opens the link"],
      dependencies: [],
      outOfScope: null,
      risks: null,
      sources: [],
    },
    completeness: { starred: 3, starredTotal: 3, filled: 7, total: 10 },
    missingForShaped: ["1 open question answered or deferred"],
    planWarnings: [],
    breakdownRevision: "r0",
    scaffold: null,
    today: "2026-11-25",
    ...patch,
  };
}

function tab(rec: IdeaDetailData): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession()}>
      <PlanTab detail={detail({ issue: issue({ id: ID, identifier: ID, draft: true, kind: "idea" }), planRecord: rec })} workspace="ws" onAuthError={noop} refresh={noop} />
    </SessionContext.Provider>,
  );
}

/** The text a person reads, tags dropped and whitespace folded. */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** The markup of the element that opens with `marker` (its outer tag), to the matching close. */
function block(html: string, marker: string): string {
  const start = html.lastIndexOf("<", html.indexOf(marker));
  if (start < 0 || html.indexOf(marker) < 0) return "";
  const tag = /^<([a-z0-9]+)/.exec(html.slice(start))![1]!;
  let depth = 0;
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  pattern.lastIndex = start;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, pattern.lastIndex);
  }
  return html.slice(start);
}
const standing = (html: string) => block(html, "data-plan-standing=");

describe("Where it stands, for an idea being shaped", () => {
  it("lists what shaping still needs verbatim, and ticks the required sections that are written, each linking to its section", () => {
    const html = standing(tab(record(idea())));
    expect(html).toContain('data-plan-phases="thinking"');
    expect(text(html)).toContain("Thinking · exploring");
    expect(text(html)).toContain("To shape it 1 thing left");
    const missing = block(html, "data-plan-missing");
    expect(text(missing)).toContain("1 open question answered or deferred");
    expect(missing).toContain("data-plan-missing-item");
    // Written required sections: ticked, and each a way to its section.
    for (const id of ["goal", "breakdown", "acceptance"]) expect(html).toContain(`data-plan-jump="${id}"`);
    expect(text(html)).toContain("Task breakdown (2 tasks)");
  });

  it("prints each missing entry as the server wrote it, with a capital first letter, and leaves out a required section not yet written", () => {
    const rec = record(idea(), { missingForShaped: ["a goal", "acceptance criteria (how the whole is proven done)"] });
    rec.plan.goal = null;
    const html = standing(tab(rec));
    expect(text(html)).toContain("To shape it 2 things left");
    const items = [...html.matchAll(/data-plan-missing-item="">(.*?)<\/li>/g)].map((match) => text(match[1]!));
    expect(items).toEqual(["A goal", "Acceptance criteria (how the whole is proven done)"]);
    expect(html).not.toContain('data-plan-jump="goal"');
  });

  it("says the plan passes the gate when nothing is missing", () => {
    const html = standing(tab(record(idea({ actions: [...EDITS, act("shape")] }), { missingForShaped: [] })));
    expect(text(html)).toContain("Ready to mark shaped The plan passes the gate.");
    expect(html).not.toContain("data-plan-missing");
  });

  it("shows a raw idea's checklist too, and a dropped idea's track says Dropped", () => {
    expect(text(standing(tab(record(idea({ state: "raw", maturity: "raw", stage: "raw" })))))).toContain("To shape it");
    const dropped = standing(tab(record(idea({ state: "dropped", maturity: "dropped", stage: "dropped", actions: [act("restore")] }))));
    expect(text(dropped)).toContain("Dropped");
    expect(dropped).not.toContain("To shape it");
  });
});

describe("Where it stands, shaped", () => {
  const shaped = (patch: Partial<IdeaData> = {}) => idea({ state: "shaped", maturity: "shaped", stage: "shaped", actions: [...EDITS, act("scaffold"), act("schedule")], ...patch });
  const preview = {
    idea: { id: ID, title: "Coach shares a program" },
    epic: { identifier: null, kind: "epic", planDocument: "# x", acceptance: ["Works"], promoted: false },
    tasks: [
      { rowId: "r1", key: "7.1", title: "Spike the link", estimate: "3h", estimatedSeconds: 10800, estimateWarning: null, blockedBy: [], waitsOutside: [], acceptance: ["Findings written"], acceptanceInherited: false, context: "", existing: null },
      { rowId: "r2", key: "7.2", title: "Build the link", estimate: "1d", estimatedSeconds: 28800, estimateWarning: null, blockedBy: ["7.1"], waitsOutside: [], acceptance: [], acceptanceInherited: true, context: "", existing: null },
    ],
    children: [],
    problems: [],
    warnings: [],
    fingerprint: "f0",
  };

  it("is ready to scaffold, with the task count and the hours, and holds the scaffold preview", () => {
    const html = standing(tab(record(shaped(), { scaffold: preview, missingForShaped: [] })));
    expect(text(html)).toContain("Ready to scaffold 2 tasks · 11h become an epic with tickets");
    expect(html).toContain("data-plan-scaffold");
    expect(html).toContain("data-plan-scaffold-preview");
    expect(html).not.toContain("To shape it");
  });

  it("leaves the hours out when any estimate is not a plain number of hours or days", () => {
    const rec = record(shaped(), { scaffold: preview, missingForShaped: [] });
    rec.plan.breakdown[1]!.estimate = "2-3h";
    expect(text(standing(tab(rec)))).toContain("Ready to scaffold 2 tasks become an epic with tickets");
    expect(estimateHours([{ key: "1", title: "a", estimate: "90m", dependsOn: [], acceptance: null, owner: null, notes: null }])).toBeNull();
    expect(estimateHours([{ key: "1", title: "a", estimate: null, dependsOn: [], acceptance: null, owner: null, notes: null }])).toBeNull();
    expect(estimateHours([{ key: "1", title: "a", estimate: "1.5 days", dependsOn: [], acceptance: null, owner: null, notes: null }])).toBe("12h");
  });

  it("keeps the warning of a shaped plan that no longer passes, inside the panel", () => {
    const html = standing(tab(record(shaped({ planIncomplete: ["a goal"] }), { scaffold: { ...preview, problems: ["a goal"] } })));
    expect(html).toContain("data-plan-incomplete");
    expect(text(html)).toContain("Shaped · plan incomplete: a goal.");
    expect(html).toContain("data-plan-scaffold-held");
  });
});

describe("Where it stands, started and shipped", () => {
  const started = (patch: Partial<IdeaData> = {}) =>
    idea({
      state: "started",
      maturity: "exploring",
      stage: "started",
      linkCount: 1,
      units: { done: 3, open: 2, planned: 1, total: 6 },
      percent: 50,
      progress: 0.5,
      planned: { start: "2026-11-01", target: "2027-01-09" },
      actual: { start: "2026-11-14", end: null, forecastEnd: "2026-12-06" },
      late: true,
      actions: [...EDITS, act("adopt"), act("unlink"), act("shape")],
      ...patch,
    });

  it("shows the work under way: units in words, the bar and percent, the dates and the late flag", () => {
    const html = standing(tab(record(started(), { missingForShaped: [] })));
    const read = text(html);
    expect(read).toContain("Work is under way 3 done · 2 open · 1 planned");
    expect(html).toContain('data-plan-tree-bar="3/2/1"');
    expect(read).toContain("50%");
    expect(read).toContain("Started Nov 14 · forecast Dec 6 · planned to Jan 9");
    expect(html).toContain('data-plan-flag="late"');
    expect(read).toContain("It started while still exploring. Its plan passes the gate, so you can mark it shaped.");
  });

  it("says what shaping needs when a started record still exploring cannot be marked shaped yet, and says nothing of shaping once it is shaped", () => {
    const held = started({ actions: [...EDITS, act("shape", { disabledReason: "It needs a goal before it is shaped." })] });
    const html = standing(tab(record(held, { missingForShaped: ["a goal"] })));
    expect(html).toContain("data-plan-missing");
    expect(text(html)).not.toContain("It started while still exploring");
    // Shaped already: no note, even were the action listed.
    const done = standing(tab(record(started({ maturity: "shaped", actions: [...EDITS, act("adopt"), act("shape")] }), { missingForShaped: [] })));
    expect(text(done)).not.toContain("mark it shaped");
    expect(done).not.toContain("data-plan-missing");
  });

  it("puts the delivered mark, its note and the person's clear in the panel", () => {
    const shipped = idea({
      state: "shipped",
      stage: "shipped",
      delivered: { on: "2026-10-12", note: "Shipped by the **platform** team." },
      actual: { start: null, end: "2026-10-12", forecastEnd: null },
      actions: [act("clear_delivered")],
    });
    const html = standing(tab(record(shipped, { missingForShaped: [] })));
    expect(html).toContain('data-delivered-mark="2026-10-12"');
    expect(html).toContain("<strong>platform</strong>");
    expect(html).toContain('data-plan-action="clear_delivered"');
    expect(html).toContain('data-plan-phases="shipped"');
  });
});

describe("open questions, in the panel", () => {
  const asked = (patch: Partial<IdeaData> = {}) =>
    record(idea({ openQuestions: 2, ...patch }), {
      questions: [
        { text: "Who owns the link?", resolved: true },
        { text: "Does it expire?", resolved: false },
        { text: "Can a client copy it?", resolved: false, deferred: true },
      ],
    });

  it("lists each open question with Answered and Defer at its own position, and folds the answered ones", () => {
    const html = standing(tab(asked()));
    expect(text(html)).toContain("Open questions 2 to answer");
    expect(html).toContain('data-plan-answer="2"');
    expect(html).toContain('data-plan-defer="2"');
    expect(html).toContain('data-plan-answer="3"');
    expect(text(block(html, 'data-plan-defer="3"'))).toBe("Undefer");
    expect(text(html)).toContain("Can a client copy it? (deferred)");
    // The answered one waits behind its count.
    expect(text(html)).toContain("1 answered");
    expect(html).not.toContain("Who owns the link?");
    expect(html).not.toContain('data-plan-answer="1"');
    expect(html).toContain('data-plan-add="question"');
  });

  it("offers no answer, defer or add where the state does not offer asking, and says none open when there are none", () => {
    const html = standing(tab(asked({ actions: [act("edit")] })));
    expect(html).toContain("Does it expire?");
    expect(html).not.toContain('data-plan-answer="');
    expect(html).not.toContain("data-plan-defer");
    expect(html).not.toContain('data-plan-add="question"');
    expect(text(standing(tab(record(idea()))))).toContain("Open questions none open");
  });
});

describe("the properties and the work", () => {
  it("draws the properties as a grid with no maturity row, and the work right under them for a started idea", () => {
    const started = idea({ state: "started", stage: "started", linkCount: 1, actions: [...EDITS, act("unlink")] });
    const rec = record(started, {
      linked: [{ missing: false, id: "i1", identifier: "LAR-12", title: "Build the link", kind: "task", status: "in_progress", resolved: false, leaves: 2, doneLeaves: 1, progress: 0.5, percent: 50, startedAt: null, completedAt: null, milestone: null }],
    });
    const html = tab(rec);
    expect(html).toContain("data-plan-fields");
    expect(html).not.toContain('data-plan-field="maturity"');
    const fields = html.indexOf("data-plan-fields");
    const work = html.indexOf('data-plan-section="work"');
    const nav = html.indexOf("data-plan-section-nav");
    expect(fields).toBeLessThan(work);
    expect(work).toBeLessThan(nav);
    expect(html).toContain('data-plan-unlink="LAR-12"');
  });

  it("keeps the work near the end for an idea being shaped, after the decisions", () => {
    const rec = record(idea({ actions: [...EDITS, act("adopt")] }));
    const html = tab(rec);
    expect(html.indexOf('data-plan-section="decisions"')).toBeLessThan(html.indexOf('data-plan-section="work"'));
    expect(html.indexOf("data-plan-section-nav")).toBeLessThan(html.indexOf('data-plan-section="work"'));
    expect(html).toContain('data-plan-add="adopt"');
  });
});

describe("the section chips", () => {
  it("are one named row of chips in plan order, filled where the section has content, starred where shaping requires it, with counts for lists", () => {
    const rec = record(idea(), { decisions: ["2026-11-14: Links never expire"] });
    rec.plan.sources = ["a", "b"];
    const html = tab(rec);
    const nav = block(html, "data-plan-section-nav");
    expect(nav).toContain('aria-label="Plan sections"');
    expect(nav).toContain('data-plan-completeness="3/3"');
    expect(text(nav)).toContain("3 of 3 required sections, 7 of 10 in all");
    const chips = [...nav.matchAll(/data-plan-chip="([a-z-]+)"/g)].map((match) => match[1]);
    expect(chips).toEqual(["brief", "goal", "context", "breakdown", "acceptance", "dependencies", "out-of-scope", "risks", "sources", "decisions"]);
    const filled = [...nav.matchAll(/data-plan-chip="([a-z-]+)"[^>]*data-filled=""/g)].map((match) => match[1]);
    expect(filled).toEqual(["brief", "goal", "breakdown", "acceptance", "sources", "decisions"]);
    const starred = [...nav.matchAll(/data-plan-chip="([a-z-]+)"[^>]*data-required=""/g)].map((match) => match[1]);
    expect(starred).toEqual(["goal", "breakdown", "acceptance"]);
    expect(text(block(nav, 'data-plan-chip="breakdown"'))).toContain("2");
    expect(text(block(nav, 'data-plan-chip="sources"'))).toContain("2");
  });

  it("goes nowhere for a section that is not drawn", () => {
    const shipped = record(idea({ state: "shipped", stage: "shipped", actions: [] }), { missingForShaped: [] });
    const nav = block(tab(shipped), "data-plan-section-nav");
    expect(block(nav, 'data-plan-chip="risks"')).toContain('disabled=""');
    expect(block(nav, 'data-plan-chip="goal"')).not.toContain('disabled=""');
  });
});

describe("the sections as a document", () => {
  it("folds a long brief and context behind Show all, and leaves short ones whole", () => {
    const rec = record(idea());
    rec.brief = "word ".repeat(200);
    rec.plan.context = "Short context.";
    const html = tab(rec);
    expect(html).toContain('data-plan-fold="brief"');
    expect(text(block(html, 'data-plan-fold="brief"'))).toBe("Show all");
    expect(html).not.toContain('data-plan-fold="context"');
  });

  it("shows three sources and Show all past four, and every one up to four", () => {
    const rec = record(idea());
    rec.plan.sources = ["s1", "s2", "s3", "s4", "s5"];
    const html = block(tab(rec), 'data-plan-section="sources"');
    expect(text(html)).toContain("s3");
    expect(text(html)).not.toContain("s4");
    expect(text(html)).toContain("Show all 5");
    rec.plan.sources = ["s1", "s2", "s3", "s4"];
    const four = block(tab(rec), 'data-plan-section="sources"');
    expect(text(four)).toContain("s4");
    expect(text(four)).not.toContain("Show all");
  });

  it("shows the three latest decisions with their dates, then Show all", () => {
    const rec = record(idea(), { decisions: ["2026-11-01: One", "2026-11-02: Two", "Three, undated", "2026-11-14: Four", "2026-11-15: Five"] });
    const html = block(tab(rec), 'data-plan-section="decisions"');
    expect(text(html)).toContain("Nov 15 Five");
    expect(text(html)).toContain("Nov 14 Four");
    expect(text(html)).toContain("Three, undated");
    expect(text(html)).not.toContain("One");
    expect(text(html)).toContain("Show all 5");
    expect(html).toContain('data-plan-add="decision"');
  });

  it("reads the breakdown as a table with no inputs, its total, and the rows with no done-when of their own", () => {
    const html = block(tab(record(idea())), 'data-plan-section="breakdown"');
    expect(text(html)).toContain("Task breakdown");
    expect(text(html)).toContain("2 tasks · 11h");
    expect(html).toContain('data-plan-breakdown="read"');
    expect(html).not.toContain("<input");
    for (const header of ["#", "Task", "Est.", "After"]) expect(html).toContain(`>${header}</th>`);
    expect(html).toMatch(/data-plan-row="7\.2" data-plan-row-inherits=""/);
    expect(text(block(html, 'data-plan-row="7.2"'))).toContain("done when: inherits the plan's acceptance");
    expect(html).toContain('data-plan-row-open="7.1"');
    expect(html).toContain("data-plan-add-row");
  });

  it("collapses the unwritten sections into one line of chips where edits are offered, and draws none of them where they are not", () => {
    const html = tab(record(idea()));
    const line = block(html, "data-plan-unwritten");
    expect(text(line)).toContain("Not written yet");
    for (const id of ["context", "dependencies", "out-of-scope", "risks", "sources"]) {
      expect(line).toContain(`data-plan-section-empty="${id}"`);
      expect(html).not.toContain(`data-plan-section="${id}"`);
    }
    expect(text(block(line, 'data-plan-section-empty="out-of-scope"'))).toBe("+ Out of scope");
    const read = tab(record(idea({ state: "shipped", stage: "shipped", actions: [] }), { missingForShaped: [] }));
    expect(read).not.toContain("data-plan-unwritten");
    expect(read).not.toContain('data-plan-section="risks"');
    expect(read).not.toContain("data-plan-section-edit");
  });

  it("draws sub-ideas with the state glyph and flags, not chips", () => {
    const child = idea({ id: "c1", title: "Child plan", state: "started", stage: "started", late: true, percent: 20 });
    const html = block(tab(record(idea(), { children: [child] })), 'data-plan-section="children"');
    expect(html).toContain('data-plan-glyph="started"');
    expect(html).toContain('data-plan-flag="late"');
    expect(text(html)).toContain("Started");
  });
});

describe("the rare actions", () => {
  it("puts Delivered outside the tracker at the end of the tab, its form closed, only where the state offers the mark", () => {
    const offered = record(idea({ actions: [...EDITS, act("mark_delivered")] }));
    const html = tab(offered);
    expect(html).toContain("data-plan-delivered-open");
    expect(html).not.toContain("data-plan-delivered-on");
    expect(html.indexOf("data-plan-delivered-open")).toBeGreaterThan(html.indexOf('data-plan-section="decisions"'));
    expect(text(block(html, "data-plan-delivered-open"))).toBe("Delivered outside the tracker…");
    expect(tab(record(idea()))).not.toContain("data-plan-delivered-open");
  });
});

describe("the header line", () => {
  const line = (rec: IdeaDetailData) => renderToStaticMarkup(<IdeaStatusLine record={rec} />);

  it("is one line: the glyph, the state, where it is aimed, the planned window and the flags", () => {
    const rec = record(idea({ horizonId: "h1", notStarted: true, planned: { start: "2026-08-12", target: "2027-04-24" } }));
    rec.horizon = { id: "h1", name: "Post-MVP", date: null } as IdeaDetailData["horizon"];
    const html = line(rec);
    expect(html).toContain('data-plan-glyph="exploring"');
    expect(text(html)).toContain("Exploring · aimed at ◇ Post-MVP · planned Aug 12 – Apr 24, 2027");
    expect(html).toContain('data-plan-flag="notStarted"');
    expect(text(html)).not.toContain("Idea ·");
  });

  it("says the percent once started, and on rather than aimed at", () => {
    const rec = record(idea({ state: "started", stage: "started", percent: 56, horizonId: "h1" }));
    rec.horizon = { id: "h1", name: "MVP", date: "2027-02-27" } as IdeaDetailData["horizon"];
    expect(text(line(rec))).toContain("Started · 56% done · on ◇ MVP (Feb 27)");
  });
});
