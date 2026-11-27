/**
 * The Ideas lens: Raw as a list with its capture field and a one-click Explore, Exploring as
 * cards that say what shaping still needs. Every word comes from the payload: the offered
 * actions, the server's completeness counts, the brief's first line and the capture date.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IdeaData, PlanData } from "@/lib/plan-types";
import { planActionItems } from "@/detail/plain-actions";
import { IdeasBoard } from "./IdeasLens";
import { capturedAge, sectionMarks, shaping } from "./ideas-words";

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
    maturity: "raw",
    stage: "raw",
    parentId: null,
    horizonId: null,
    planned: { start: null, target: null },
    baseline: null,
    rank: 0,
    links: [],
    explorations: [],
    shapeProposal: null,
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
    completeness: { starred: 0, starredTotal: 3, filled: 0, total: 10 },
    dependsOn: [], blockedBy: [], heldBy: null,
    state: "raw",
    actions: [],
    createdAt: "2026-11-17T09:30:00.000Z",
    updatedAt: "2026-11-17T09:30:00.000Z",
    ...extra,
  };
}

const exploring = (id: string, extra: Partial<IdeaData> = {}) => idea(id, { maturity: "exploring", stage: "exploring", state: "exploring", ...extra });
const plan = (ideas: IdeaData[]): PlanData => ({ enabled: true, today: "2026-11-25", horizons: [], ideas });
const board = (ideas: IdeaData[]) => renderToStaticMarkup(<IdeasBoard plan={plan(ideas)} write={async () => true} onOpen={() => {}} selected={null} />);
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
/** The markup of one card, from its opening tag to the next card. */
const card = (html: string, id: string) => html.slice(html.indexOf(`data-plan-card="${id}"`)).split("data-plan-card=")[1] ?? "";

describe("a raw idea", () => {
  it("says how long ago it was captured, from its capture day and the plan's day", () => {
    expect(capturedAge("2026-11-25T23:00:00.000Z", "2026-11-25")).toBe("today");
    expect(capturedAge("2026-11-17T09:30:00.000Z", "2026-11-25")).toBe("8d ago");
    expect(capturedAge("2026-11-12T00:00:00.000Z", "2026-11-25")).toBe("13d ago");
    expect(capturedAge("2026-11-11T00:00:00.000Z", "2026-11-25")).toBe("2w ago");
    expect(capturedAge("2026-10-10T00:00:00.000Z", "2026-11-25")).toBe("6w ago");
    expect(text(card(board([idea("r")]), "r"))).toContain("captured 8d ago");
  });

  it("offers Explore only when its state offers explore, and it runs that action's own write", () => {
    const offered = idea("r", { actions: [{ id: "explore", label: "Start exploring", who: "person" }] });
    const html = board([offered, idea("bare")]);
    expect(card(html, "r")).toContain('data-plan-action="explore"');
    expect(card(html, "bare")).not.toContain('data-plan-action="explore"');
    expect(planActionItems("", offered).find((item) => item.id === "explore")?.call).toMatchObject({ verb: "update", body: { ref: "r", maturity: "exploring" } });
  });

  it("gives a raw idea an agent proposed shaped Accept shaped in place of Explore, held back with the gate's reason", () => {
    const proposal = { by: "agent-7", at: "2026-11-27T10:00:00.000Z", note: null };
    const ready = idea("ready", { shapeProposal: proposal, actions: [{ id: "explore", label: "Start exploring", who: "person" }, { id: "shape", label: "Mark shaped", who: "person" }] });
    const held = idea("held", { shapeProposal: proposal, actions: [{ id: "explore", label: "Start exploring", who: "person" }, { id: "shape", label: "Mark shaped", who: "person", disabledReason: "It needs a goal before it is shaped." }] });
    const html = board([ready, held]);
    expect(card(html, "ready")).toContain('data-plan-action="shape"');
    expect(card(html, "ready")).not.toContain('data-plan-action="explore"');
    expect(text(card(html, "ready"))).toContain("Accept shaped");
    expect(card(html, "held")).toMatch(/data-plan-action="shape"[^>]*>|disabled=""[^>]*data-plan-action="shape"/);
    expect(card(html, "held")).toContain('title="It needs a goal"');
  });

  it("says a raw import waits for an agent to classify it, as idea ls does, and nothing on any other raw idea", () => {
    const step = { ideaId: "imported", title: "Idea imported", parentId: null, parentTitle: null, horizonId: null, state: "raw" as const, need: "classify" as const, who: "agent" as const, instruction: "Read the imported file and classify it." };
    const html = board([idea("imported", { nextStep: step }), idea("plain")]);
    expect(card(html, "imported")).toContain("data-plan-to-classify");
    expect(text(card(html, "imported"))).toContain("to classify");
    expect(card(html, "plain")).not.toContain("data-plan-to-classify");
  });

  it("lists the newest capture first", () => {
    const html = board([idea("old", { createdAt: "2026-11-01T00:00:00.000Z" }), idea("new", { createdAt: "2026-11-24T00:00:00.000Z" })]);
    expect(html.indexOf('data-plan-card="new"')).toBeLessThan(html.indexOf('data-plan-card="old"'));
  });
});

describe("an exploring card", () => {
  it("prints what shaping needs, without the server's wrapper when the reason has both ends of it", () => {
    const wrapped = exploring("w", { actions: [{ id: "shape", label: "Mark shaped", who: "person", disabledReason: "It needs a task breakdown and 1 open question answered or deferred before it is shaped." }] });
    const plain = exploring("p", { actions: [{ id: "shape", label: "Mark shaped", who: "person", disabledReason: "Answer the open questions first." }] });
    expect(shaping(wrapped)).toEqual({ ready: false, need: "a task breakdown and 1 open question answered or deferred" });
    expect(shaping(plain)).toEqual({ ready: false, need: "Answer the open questions first." });
    const html = board([wrapped, plain]);
    expect(text(card(html, "w"))).toContain("To shape: a task breakdown and 1 open question answered or deferred");
    expect(text(card(html, "w"))).not.toContain("It needs");
    expect(text(card(html, "p"))).toContain("To shape: Answer the open questions first.");
    expect(card(html, "w")).not.toContain('data-plan-action="shape"');
  });

  it("says it is ready and offers Mark shaped, which runs the shape action's own write", () => {
    const ready = exploring("ok", { actions: [{ id: "shape", label: "Mark shaped", who: "person" }] });
    const html = card(board([ready]), "ok");
    expect(text(html)).toContain("Ready to mark shaped. The plan passes the gate.");
    expect(html).toContain('data-plan-shaping="ready"');
    expect(html).toContain('data-plan-action="shape"');
    const result = shaping(ready);
    expect(result?.ready && result.item.call).toMatchObject({ verb: "update", body: { ref: "ok", maturity: "shaped" } });
    expect(card(board([exploring("none")]), "none")).not.toContain("data-plan-shaping");
  });

  it("flags a card an agent proposed shaped, and its Mark shaped reads Accept shaped, the same write", () => {
    const proposed = exploring("pr", { actions: [{ id: "shape", label: "Mark shaped", who: "person" }], shapeProposal: { by: "agent-7", at: "2026-11-27T10:00:00.000Z", note: null } });
    const html = card(board([proposed, exploring("plain", { actions: [{ id: "shape", label: "Mark shaped", who: "person" }] })]), "pr");
    expect(html).toContain('data-plan-card-flag="proposed"');
    expect(text(html)).toContain("proposed shaped");
    expect(text(html)).toContain("Accept shaped");
    expect(html).toContain('data-plan-action="shape"');
    const plain = card(board([exploring("plain", { actions: [{ id: "shape", label: "Mark shaped", who: "person" }] })]), "plain");
    expect(plain).not.toContain('data-plan-card-flag="proposed"');
    expect(text(plain)).toContain("Mark shaped");
  });

  it("shows the brief's first line when the payload has one", () => {
    const html = board([exploring("b", { briefLine: "Let a shopper save a cart for later." }), exploring("n")]);
    expect(card(html, "b")).toContain("data-plan-brief");
    expect(text(card(html, "b"))).toContain("Let a shopper save a cart for later.");
    expect(card(html, "n")).not.toContain("data-plan-brief");
  });

  it("draws the sections meter from the server's counts: required first and taller, then the rest", () => {
    const completeness = { starred: 2, starredTotal: 3, filled: 7, total: 10 };
    expect(sectionMarks(completeness)).toEqual(["required-filled", "required-filled", "required", "filled", "filled", "filled", "filled", "filled", "empty", "empty"]);
    const html = card(board([exploring("m", { completeness })]), "m");
    expect(html).toContain('title="2 of 3 required sections, 7 of 10 in all"');
    expect(html).toContain('data-plan-card-completeness="2/3"');
    expect([...html.matchAll(/data-plan-meter-mark="([a-z-]+)"/g)].map((match) => match[1])).toEqual(sectionMarks(completeness));
    expect(text(html)).toContain("7/10 written");
  });
});

describe("the lens", () => {
  it("draws Raw and Exploring together at every width, with no column switcher", () => {
    const html = board([idea("r"), exploring("e")]);
    expect(html).not.toContain("data-plan-column-switcher");
    expect(html).toMatch(/data-plan-column="m:raw"[^]*data-plan-card="r"[^]*data-plan-column="m:exploring"[^]*data-plan-card="e"/);
    expect(html.match(/data-plan-board/g)).toHaveLength(1);
  });

  it("says what belongs in an empty pane", () => {
    const html = text(board([]));
    expect(html).toContain("Nothing raw. Type above to capture one.");
    expect(html).toContain("Nothing being explored. Open a raw idea and start exploring it.");
  });
});
