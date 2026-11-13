/**
 * An idea delivered outside the tracker (design/plan.md, "Delivered outside the tracker"): the
 * person marks it with the day it was delivered and a note, and it reads shipped with no ticket.
 * Expectations are written out, not read from the table, so a drifted rule fails here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { deriveStage, isLate, isNotStarted } from "../src/core/plan.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;
const TODAY = "2026-11-07";

let store: WorkspaceStore;
let plan: PlanStore;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  plan = store.plan();
  plan.clock = () => new Date(`${TODAY}T12:00:00.000Z`);
  plan.enable("vp", { person: { via: "settings" } });
});

function refused(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

const now = () => plan.view().horizons.find((h) => h.name === "Now")!;
const idea = (title: string, maturity = "shaped", extra: Record<string, unknown> = {}) => plan.capture({ title, maturity, plan: READY_PLAN, ...extra }, "vp", PERSON).id;
const mark = (id: string, on: string, note?: string) => plan.update(id, { delivered: { on, note } }, "vp", PERSON);
const actionsOf = (id: string) => plan.ideaView(id).actions.map((action) => action.id);
const finish = (identifier: string) => {
  store.checkoutIssue(identifier, "agent");
  store.updateIssue(identifier, { status: "done" }, "agent");
};

const SHIPPED_MARKED = ["adopt", "edit", "ask", "decide", "clear_delivered"];

describe("the derivation, one function per fact", () => {
  it("reads a marked record shipped with nothing linked, and started again while work linked since is open", () => {
    const base = { maturity: "shaped" as const, scheduled: true, links: 0, resolvedLinks: 0 };
    expect(deriveStage({ ...base, deliveredOn: "2026-10-01" })).toBe("shipped");
    expect(deriveStage({ ...base, deliveredOn: null })).toBe("scheduled");
    expect(deriveStage({ ...base, links: 1, resolvedLinks: 0, deliveredOn: "2026-10-01" })).toBe("started");
    expect(deriveStage({ ...base, links: 1, resolvedLinks: 1, deliveredOn: "2026-10-01" })).toBe("shipped");
    // A link whose issue is gone judges nothing: the mark stands.
    expect(deriveStage({ ...base, links: 1, resolvedLinks: 0, missingLinks: 1, deliveredOn: "2026-10-01" })).toBe("shipped");
  });

  it("is late only when delivered after the earlier of its planned target and its horizon's date, and never not started", () => {
    const actual = { start: null, end: "2026-10-10", forecastEnd: null };
    const late = (deliveredOn: string, plannedTarget: string | null, horizonDate: string | null = null) =>
      isLate({ plannedTarget, horizonDate, actual, links: 0, open: false, today: TODAY, deliveredOn });
    expect(late("2026-10-10", "2026-10-10")).toBe(false);
    expect(late("2026-10-09", "2026-10-10")).toBe(false);
    expect(late("2026-10-11", "2026-10-10")).toBe(true);
    expect(late("2026-10-11", "2026-12-01", "2026-10-10")).toBe(true);
    expect(late("2026-10-11", null)).toBe(false);
    expect(isNotStarted({ plannedStart: "2026-09-01", links: 0, dropped: false, today: TODAY, deliveredOn: "2026-10-01" })).toBe(false);
    expect(isNotStarted({ plannedStart: "2026-09-01", links: 0, dropped: false, today: TODAY, deliveredOn: null })).toBe(true);
  });
});

describe("the person marks an idea delivered outside the tracker", () => {
  it("reads shipped with no ticket, its date its actual end, never late or not started when on time", () => {
    const id = idea("Billing export", "shaped", { horizon: now().id, plannedStart: "2026-09-01", plannedTarget: "2026-10-15" });
    expect(plan.ideaView(id)).toMatchObject({ state: "shaped", notStarted: true });
    const view = mark(id, "2026-10-12", "Shipped by hand before the tracker existed.");
    expect(view).toMatchObject({
      state: "shipped",
      stage: "shipped",
      identifier: null,
      promoted: false,
      maturity: "shaped",
      delivered: { on: "2026-10-12", note: "Shipped by hand before the tracker existed." },
      late: false,
      notStarted: false,
      actual: { end: "2026-10-12", forecastEnd: null },
    });
    expect(plan.view().horizons.find((h) => h.name === "Now")!.shippedCount).toBe(1);
    expect(store.listDocuments(id).map((doc) => doc.key)).toContain("delivered-note");
  });

  it("reads late when delivered after its planned target", () => {
    const id = idea("Checkout API", "shaped", { plannedTarget: "2026-10-01" });
    expect(mark(id, "2026-10-05")).toMatchObject({ state: "shipped", late: true });
  });

  it("consumes no ticket number and never enters the tracker: no member, no queue, no checkout, no listing", () => {
    const before = store.createIssue({ title: "Before" }).identifier;
    const id = idea("Exploring work", "exploring", { horizon: now().id });
    mark(id, "2026-11-01");
    const after = store.createIssue({ title: "After" }).identifier;
    expect([before, after]).toEqual(["TST-3", "TST-4"]);
    expect(store.getIssue(id).identifier).toMatch(/^~/);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM plan_members WHERE issue_id = ?").get(id)).toEqual({ n: 0 });
    expect(store.milestones().get(now().identifier).members.some((member) => member.issueId === id)).toBe(false);
    expect(() => store.queue().enqueue(id, {}, "agent")).toThrow(/is an idea/);
    expect(() => store.checkoutIssue(id, "agent")).toThrow(/is an idea/);
    expect(store.listIssues({ includeResolved: true }).some((issue) => issue.id === id)).toBe(false);
    expect(store.queue().effectiveQueue().rows.some((row) => row.issueId === id)).toBe(false);
  });

  it("is offered in exploring and shaped only, and refused naming the state elsewhere", () => {
    expect(actionsOf(idea("Exploring", "exploring"))).toContain("mark_delivered");
    expect(actionsOf(idea("Shaped", "shaped"))).toContain("mark_delivered");
    const raw = idea("Raw", "raw");
    expect(actionsOf(raw)).not.toContain("mark_delivered");
    expect(refused(() => mark(raw, "2026-11-01")).message).toContain("is raw; it cannot be marked delivered outside the tracker");
    const started = idea("Started", "shaped");
    plan.adopt(started, store.createIssue({ title: "Its work" }).identifier, "agent");
    expect(refused(() => mark(started, "2026-11-01")).message).toContain("is started; it cannot be marked delivered outside the tracker");
    const promoted = idea("Promoted", "shaped");
    plan.promote(promoted, "agent");
    expect(refused(() => mark(promoted, "2026-11-01")).message).toContain("is started; it cannot be marked delivered outside the tracker");
    const dropped = idea("Dropped", "dropped");
    expect(refused(() => mark(dropped, "2026-11-01")).message).toContain("is dropped; it cannot be marked delivered outside the tracker");
  });

  it("needs a day that is a calendar day and not after today", () => {
    const id = idea("Dated");
    expect(refused(() => plan.update(id, { delivered: { on: "" } }, "vp", PERSON)).message).toContain("needs the day it was delivered");
    expect(refused(() => mark(id, "2026-13-01")).message).toContain("calendar days");
    expect(refused(() => mark(id, "2026-11-08")).message).toContain("is after today");
    expect(plan.ideaView(id).delivered).toBeNull();
  });

  it("refuses an agent, saying what it may do instead, and writes nothing", () => {
    const id = idea("Agent tries");
    const error = refused(() => plan.update(id, { delivered: { on: "2026-11-01" } }, "agent"));
    expect(error.code).toBe("validation");
    expect(error.message).toContain("the person's call");
    expect(error.message).toContain("adopt its ticket onto the idea");
    expect(plan.ideaView(id)).toMatchObject({ state: "shaped", delivered: null });
    mark(id, "2026-11-01");
    expect(refused(() => plan.update(id, { delivered: null }, "agent")).message).toContain("the person's call");
    expect(plan.ideaView(id).delivered).not.toBeNull();
  });
});

describe("a marked record", () => {
  it("still offers edit, ask and decide to anyone, and clearing to the person", () => {
    const id = idea("Marked");
    mark(id, "2026-11-01", "Old note");
    expect(actionsOf(id)).toEqual(SHIPPED_MARKED);
    expect(plan.ideaView(id).actions.find((action) => action.id === "clear_delivered")).toMatchObject({ who: "person" });
    plan.update(id, { title: "Marked, renamed", brief: "Edited after delivery." }, "agent");
    plan.addQuestion(id, "Who owns it now?", "agent");
    plan.addDecision(id, "Keep the old exporter.", "agent");
    store.putDocument(id, "notes", "An agent's notes.", { author: "agent" });
    expect(plan.ideaView(id)).toMatchObject({ title: "Marked, renamed", state: "shipped", openQuestions: 1 });
    // Its state offers no schedule, dates or maturity moves while marked.
    expect(refused(() => plan.update(id, { horizon: now().id }, "vp", PERSON)).message).toContain("is shipped; it cannot be scheduled");
  });

  it("keeps its note to the mark: a raw document write is refused, a clear empties it", () => {
    const id = idea("Noted");
    mark(id, "2026-11-01", "Delivered by the platform team.");
    expect(refused(() => store.putDocument(id, "delivered-note", "An agent's note.", { author: "agent" })).message).toContain("written with the mark");
    const cleared = plan.update(id, { delivered: null }, "vp", PERSON);
    expect(cleared).toMatchObject({ state: "shaped", stage: "shaped", delivered: null });
    expect(store.getDocument(id, "delivered-note")?.body).toBe("");
    expect(actionsOf(id)).toContain("mark_delivered");
    // Marked again without a note, it has none.
    expect(mark(id, "2026-11-02").delivered).toEqual({ on: "2026-11-02", note: null });
  });

  it("clears as no change when it carries no mark", () => {
    const id = idea("Unmarked");
    expect(plan.update(id, { delivered: null }, "vp", PERSON)).toMatchObject({ state: "shaped", delivered: null });
  });

  it("reads started while work linked to it since is open, and shipped again once it lands", () => {
    const id = idea("Reopened");
    mark(id, "2026-11-01");
    const work = store.createIssue({ title: "Follow-up" }).identifier;
    plan.adopt(id, work, "agent");
    expect(plan.ideaView(id)).toMatchObject({ state: "started", delivered: { on: "2026-11-01" } });
    expect(actionsOf(id)).toContain("clear_delivered");
    finish(work);
    expect(plan.ideaView(id)).toMatchObject({ state: "shipped" });
  });

  it("follows its linked work's window once reopened: never inverted, open while the work is, late when that work runs past its line", () => {
    const id = idea("Reopened late", "shaped", { horizon: now().id, plannedTarget: "2026-11-03" });
    mark(id, "2026-11-01");
    expect(plan.ideaView(id)).toMatchObject({ late: false, actual: { start: null, end: "2026-11-01", forecastEnd: null } });
    const work = store.createIssue({ title: "Follow-up" }).identifier;
    plan.adopt(id, work, "agent");
    store.checkoutIssue(work, "agent");
    const open = plan.ideaView(id);
    expect(open.state).toBe("started");
    expect(open.actual.start).not.toBeNull();
    expect(open.actual.end).toBeNull();
    // The target has passed while the work is open: late, as for any started record.
    expect(open.late).toBe(true);
    store.updateIssue(work, { status: "done" }, "agent");
    const landed = plan.ideaView(id);
    expect(landed.state).toBe("shipped");
    expect(landed.actual.end).not.toBeNull();
    expect(landed.actual.end! >= landed.actual.start!).toBe(true);
    expect(landed.actual.end! >= "2026-11-01").toBe(true);
  });
});

describe("with planning off", () => {
  it("refuses the mark, keeps the field, and shows it again when planning is back on", () => {
    const id = idea("Hidden while off");
    mark(id, "2026-11-01", "A note.");
    store.setSetting("features.planning", false, "vp", { via: "cli" });
    expect(() => plan.update(id, { delivered: null }, "vp", PERSON)).toThrow(/Planning is off/);
    expect(() => plan.detail(id)).toThrow(/Planning is off/);
    expect(JSON.stringify(store.getIssue(id))).not.toMatch(/delivered/i);
    expect(store.listIssues({ includeResolved: true }).some((issue) => issue.id === id)).toBe(false);
    store.setSetting("features.planning", true, "vp", { via: "cli" });
    expect(plan.detail(id).idea.delivered).toEqual({ on: "2026-11-01", note: "A note." });
  });
});
