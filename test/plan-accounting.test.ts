/**
 * What a horizon counts (design/plan.md, "Accounting"): done, open and planned work items, where
 * a planned item is a breakdown row of a scheduled idea with no tickets yet; an idea with nothing
 * to count is unsized, never zero work; leaf records are what the counts print; and a horizon is
 * never shipped while a scheduled, non-dropped record is not. One derivation, read by the plan
 * and by the milestone view of the same horizon.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { BreakdownRow } from "../src/core/plan-sections.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { unitPercent } from "../src/core/plan-accounting.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;

let store: WorkspaceStore;
let plan: PlanStore;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  plan = store.plan();
  plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
  plan.enable("vp", { person: { via: "settings" } });
});

function horizon(name: string): string {
  return plan.view().horizons.find((h) => h.name === name)!.id;
}

function rows(count: number): Array<Omit<BreakdownRow, "id">> {
  return Array.from({ length: count }, (_, at) => ({ key: String(at + 1), title: `Step ${at + 1}`, estimate: "2h", dependsOn: [], acceptance: "It works", owner: null, notes: null }));
}

function idea(title: string, extra: Parameters<PlanStore["capture"]>[0] extends infer I ? Partial<I> : never = {}): string {
  return plan.capture({ title, maturity: "shaped", plan: READY_PLAN, ...extra }, "vp", PERSON).id;
}

function finish(identifier: string): void {
  store.checkoutIssue(identifier, "agent");
  store.updateIssue(identifier, { status: "done" }, "agent");
}

const categoryOf = (id: string) => store.categoryOf(store.getIssue(id).status);
const horizonView = (name: string) => plan.view().horizons.find((h) => h.name === name)!;

/**
 * Now holds: a promoted epic with three tasks (two done), a task placed by hand (done), a shaped
 * idea with three rows and no tickets, and an umbrella idea whose sub-ideas are a shaped idea with
 * two rows and an exploring idea with nothing written yet.
 */
function mixedHorizon() {
  const now = horizon("Now");
  // Dated, so the Milestones list carries it too.
  plan.updateHorizon(now, { date: "2026-12-18" }, "vp", PERSON);
  const checkout = idea("Checkout API", { horizon: now });
  const epic = plan.promote(checkout, "vp", PERSON).identifier!;
  const tasks = ["Cart", "Payment", "Receipt"].map((title) => store.createIssue({ title, parent: epic }).identifier);
  finish(tasks[0]!);
  finish(tasks[1]!);
  const byHand = store.createIssue({ title: "Billing export" });
  store.milestones().addMember(now, byHand.identifier, {}, "vp");
  finish(byHand.identifier);
  const search = idea("Invoice search", { horizon: now, plan: { ...READY_PLAN, breakdown: rows(3) } });
  const reporting = plan.capture({ title: "Reporting", maturity: "exploring", horizon: now }, "vp", PERSON).id;
  const usage = idea("Usage report", { horizon: now, parent: reporting, plan: { ...READY_PLAN, breakdown: rows(2) } });
  const audit = plan.capture({ title: "Audit trail", maturity: "exploring", horizon: now, parent: reporting }, "vp", PERSON).id;
  return { now, checkout, epic, tasks, search, reporting, usage, audit };
}

describe("a horizon's units", () => {
  it("counts its tickets' leaves done and open, and its ideas' breakdown rows as planned", () => {
    const { now } = mixedHorizon();
    const view = horizonView("Now");
    expect(view.units).toEqual({ done: 3, open: 1, planned: 5, total: 9 });
    expect(view.progress).toBeCloseTo(3 / 9);
    expect(store.milestones().get(now).progress).toMatchObject({ countable: 4, planned: 5, unsized: 1, percent: 33, complete: false });
  });

  it("reports an idea with neither work nor rows nor sub-ideas as unsized, never as zero work", () => {
    const { audit } = mixedHorizon();
    expect(horizonView("Now").unsizedCount).toBe(1);
    expect(plan.ideaView(audit)).toMatchObject({ unsized: true, units: { planned: 0, total: 0 } });
    // An umbrella over sub-ideas is not unsized: its sub-ideas carry its size.
    expect(plan.ideaView(plan.view().ideas.find((i) => i.title === "Reporting")!.id).unsized).toBe(false);
  });

  it("prints leaf records by state and counts the parent apart from its children", () => {
    mixedHorizon();
    const view = horizonView("Now");
    expect(view.records).toEqual({ leaves: 4, shipped: 0, started: 1, shaped: 2, exploring: 1, raw: 0, parentCount: 1 });
    // ideaCount keeps its meaning: every non-dropped record on the horizon, the parent included.
    expect(view.ideaCount).toBe(5);
  });

  it("reads the same percentage on the plan and on the milestone view", () => {
    const { now } = mixedHorizon();
    const fromPlan = horizonView("Now");
    const fromMilestone = store.milestones().get(now).progress;
    expect(Math.floor(fromPlan.progress! * 100)).toBe(fromMilestone.percent);
    const listed = store.milestones().list({ all: true }).find((row) => row.milestone.id === now)!;
    expect(listed.progress).toEqual(fromMilestone);
  });

  it("leaves a plain milestone's progress exactly as it was", () => {
    mixedHorizon();
    const plain = store.createIssue({ title: "Release train", kind: "milestone" });
    const task = store.createIssue({ title: "Ship notes" });
    store.milestones().addMember(plain.identifier, task.identifier, {}, "vp");
    expect(store.milestones().get(plain.identifier).progress).toEqual({
      total: 1,
      countable: 1,
      counts: expect.objectContaining({ done: 0 }),
      percent: 0,
      complete: false,
    });
    expect(Object.keys(store.milestones().get(plain.identifier).progress).sort()).toEqual(["complete", "countable", "counts", "percent", "total"]);
  });

  it("is absent with planning off: the milestone view counts ticket leaves only, as before", () => {
    const { now } = mixedHorizon();
    store.setSetting("features.planning", false, "vp", { via: "settings" });
    const progress = store.milestones().get(now).progress;
    expect(Object.keys(progress).sort()).toEqual(["complete", "countable", "counts", "percent", "total"]);
    expect(progress).toMatchObject({ countable: 4, percent: 75 });
  });
});

describe("a parent's rollup", () => {
  it("counts its sub-ideas' planned rows beside their tickets", () => {
    const payments = plan.capture({ title: "Payments", maturity: "exploring" }, "vp", PERSON).id;
    const vault = idea("Card vault", { parent: payments });
    const task = store.createIssue({ title: "Store tokens" });
    plan.adopt(vault, task.identifier, "agent");
    finish(task.identifier);
    idea("Refunds", { parent: payments, plan: { ...READY_PLAN, breakdown: rows(3) } });
    const parent = plan.ideaView(payments);
    expect(parent.units).toMatchObject({ done: 1, open: 0, planned: 3, total: 4 });
    expect(parent.progress).toBeCloseTo(0.25);
  });
});

describe("a parent whose breakdown names its sub-ideas", () => {
  it("counts its sub-ideas' rows once, not its own beside them, on the horizon and in its rollup", () => {
    const now = horizon("Now");
    const parent = idea("Payments", { horizon: now, plan: { ...READY_PLAN, breakdown: rows(2) } });
    idea("Card vault", { horizon: now, parent, plan: { ...READY_PLAN, breakdown: rows(3) } });
    idea("Refunds", { horizon: now, parent, plan: { ...READY_PLAN, breakdown: rows(4) } });
    expect(horizonView("Now")).toMatchObject({ units: { done: 0, open: 0, planned: 7, total: 7 }, unsizedCount: 0, records: { leaves: 2, shaped: 2, parentCount: 1 } });
    expect(plan.ideaView(parent)).toMatchObject({ unsized: false, units: { planned: 7, total: 7 } });
  });

  it("counts its own rows again once its sub-ideas are dropped", () => {
    const now = horizon("Now");
    const parent = idea("Payments", { horizon: now, plan: { ...READY_PLAN, breakdown: rows(2) } });
    const child = idea("Card vault", { horizon: now, parent, plan: { ...READY_PLAN, breakdown: rows(3) } });
    plan.update(child, { maturity: "dropped" }, "vp", PERSON);
    expect(horizonView("Now")).toMatchObject({ units: { planned: 2, total: 2 }, records: { leaves: 1, parentCount: 0 } });
  });
});

describe("a horizon is not shipped while a scheduled idea is not", () => {
  it("stays open when its last open ticket closes and an idea on it has no work yet", () => {
    const { now, tasks } = mixedHorizon();
    finish(tasks[2]!);
    expect(categoryOf(now)).not.toBe("done");
    expect(horizonView("Now")).toMatchObject({ shipped: false, units: { done: 4, open: 0, planned: 5, total: 9 } });
    expect(horizonView("Now").state).not.toBe("shipped");
    expect(store.milestones().list().map((row) => row.milestone.id)).toContain(now);
  });

  it("stays open over an unsized idea alone", () => {
    const now = horizon("Now");
    const epic = plan.promote(idea("Checkout API", { horizon: now }), "vp", PERSON).identifier!;
    plan.capture({ title: "Audit trail", maturity: "exploring", horizon: now }, "vp", PERSON);
    finish(epic);
    expect(categoryOf(now)).not.toBe("done");
    expect(horizonView("Now").shipped).toBe(false);
  });

  it("holds in both flag states: protection keys on what the records are", () => {
    const { now, tasks } = mixedHorizon();
    store.setSetting("features.planning", false, "vp", { via: "settings" });
    finish(tasks[2]!);
    expect(categoryOf(now)).not.toBe("done");
  });

  it("ships when the ideas still holding it are dropped or moved off it", () => {
    const { now, tasks, search, usage, audit, reporting } = mixedHorizon();
    finish(tasks[2]!);
    expect(categoryOf(now)).not.toBe("done");
    plan.update(search, { horizon: null }, "vp", PERSON);
    plan.update(usage, { maturity: "dropped" }, "vp", PERSON);
    plan.update(audit, { maturity: "dropped" }, "vp", PERSON);
    expect(categoryOf(now)).not.toBe("done");
    plan.update(reporting, { horizon: null }, "vp", PERSON);
    expect(categoryOf(now)).toBe("done");
    expect(horizonView("Now")).toMatchObject({ shipped: true, state: "shipped" });
  });

  it("reopens a shipped horizon when the person schedules an unshipped idea onto it", () => {
    const now = horizon("Now");
    const epic = plan.promote(idea("Checkout API", { horizon: now }), "vp", PERSON).identifier!;
    finish(epic);
    expect(categoryOf(now)).toBe("done");
    idea("Invoice search", { horizon: now });
    expect(categoryOf(now)).not.toBe("done");
    expect(horizonView("Now").shipped).toBe(false);
  });
});

describe("a horizon its plan releases", () => {
  it("closes on its landed work even when its derivation never wrote its status", () => {
    const now = horizon("Now");
    const ticket = store.createIssue({ title: "Billing export" });
    store.milestones().addMember(now, ticket.identifier, {}, "vp");
    const search = idea("Invoice search", { horizon: now, plan: { ...READY_PLAN, breakdown: rows(2) } });
    // Closed straight from backlog: the held horizon stays in the unstarted band, a status derivation never wrote.
    store.updateIssue(ticket.identifier, { status: "done" }, "vp");
    expect(store.db.prepare("SELECT status, derived_status FROM issues WHERE id = ?").get(now)).toEqual({ status: "backlog", derived_status: null });
    plan.update(search, { maturity: "dropped" }, "vp", PERSON);
    expect(categoryOf(now)).toBe("done");
    expect(horizonView("Now")).toMatchObject({ shipped: true, complete: true, percent: 100 });
  });
});

describe("a scheduled parent carries its sub-ideas scheduled on no horizon", () => {
  /** Payments on Now, 6 rows of its own; Card vault under it with 2 rows and no horizon; one ticket on Now, done. */
  function umbrella() {
    const now = horizon("Now");
    const ticket = store.createIssue({ title: "Ledger" });
    store.milestones().addMember(now, ticket.identifier, {}, "vp");
    const payments = idea("Payments", { horizon: now, plan: { ...READY_PLAN, breakdown: rows(6) } });
    const vault = idea("Card vault", { parent: payments, plan: { ...READY_PLAN, breakdown: rows(2) } });
    finish(ticket.identifier);
    return { now, payments, vault };
  }

  it("counts their planned rows and holds the horizon open for them", () => {
    const { now } = umbrella();
    expect(horizonView("Now")).toMatchObject({ units: { done: 1, open: 0, planned: 2, total: 3 }, records: { leaves: 1, shaped: 1, parentCount: 1 }, shipped: false, complete: false });
    expect(categoryOf(now)).not.toBe("done");
    expect(store.milestones().get(now).progress).toMatchObject({ countable: 1, planned: 2, percent: 33, complete: false });
  });

  it("leaves a sub-idea scheduled on another horizon, and what it carries, to that horizon alone", () => {
    const { now, vault } = umbrella();
    const next = horizon("Next");
    const tokens = plan.capture({ title: "Token rotation", maturity: "exploring", parent: vault }, "vp", PERSON).id;
    plan.update(vault, { horizon: next }, "vp", PERSON);
    // Payments is an umbrella: its sub-idea carries its size, on Next. Now holds only its landed ticket.
    expect(horizonView("Now")).toMatchObject({ units: { done: 1, open: 0, planned: 0, total: 1 }, unsizedCount: 0, records: { leaves: 0, parentCount: 1 } });
    expect(categoryOf(now)).toBe("done");
    // Card vault is now an umbrella over Token rotation, which Next carries though it is scheduled on none.
    expect(horizonView("Next")).toMatchObject({ units: { planned: 0 }, unsizedCount: 1, records: { leaves: 1, shaped: 0, exploring: 1, parentCount: 1 }, shipped: false });
    expect(plan.holdOf(next)).toBe(1);
    expect(plan.ideaView(tokens).horizonId).toBeNull();
  });
});

describe("the flag a horizon is shipped by", () => {
  it("is false while every counted unit landed but an idea on it is not shipped", () => {
    const now = horizon("Now");
    const next = horizon("Next");
    const landed = store.createIssue({ title: "Receipts" });
    store.milestones().addMember(now, landed.identifier, {}, "vp");
    finish(landed.identifier);
    // Its work sits on Next by hand, so Now counts none of it, yet the idea on Now is not shipped.
    const elsewhere = store.createIssue({ title: "Refund webhook" });
    store.milestones().addMember(next, elsewhere.identifier, {}, "vp");
    plan.adopt(idea("Refunds", { horizon: now }), elsewhere.identifier, "vp");
    expect(horizonView("Now")).toMatchObject({ units: { done: 1, open: 0, planned: 0, total: 1 }, percent: 100, complete: false, shipped: false });
    expect(store.milestones().get(now).progress).toMatchObject({ percent: 100, complete: false });
  });

  it("is false over a reopened epic whose tasks have all landed", () => {
    const now = horizon("Now");
    const epic = plan.promote(idea("Checkout API", { horizon: now }), "vp", PERSON).identifier!;
    for (const title of ["Cart", "Payment"]) finish(store.createIssue({ title, parent: epic }).identifier);
    store.updateIssue(epic, { status: "todo" }, "vp");
    expect(horizonView("Now")).toMatchObject({ units: { done: 2, open: 0, total: 2 }, progress: 1, complete: false, shipped: false });
  });

  it("is false over an idea with no size, and the 100 it reads is not complete", () => {
    const now = horizon("Now");
    const landed = store.createIssue({ title: "Receipts" });
    store.milestones().addMember(now, landed.identifier, {}, "vp");
    finish(landed.identifier);
    plan.capture({ title: "Audit trail", maturity: "exploring", horizon: now }, "vp", PERSON);
    expect(horizonView("Now")).toMatchObject({ percent: 100, complete: false, unsizedCount: 1, shipped: false });
    expect(store.milestones().get(now).progress).toMatchObject({ percent: 100, complete: false, unsized: 1 });
  });
});

describe("one percentage", () => {
  it("is the counts' whole percent rounded down, never a fraction's", () => {
    expect(unitPercent({ done: 29, total: 50 })).toBe(58);
    expect(Math.floor((29 / 50) * 100)).toBe(57);
    expect(unitPercent({ done: 2, total: 3 })).toBe(66);
    expect(unitPercent({ done: 0, total: 0 })).toBeNull();
  });

  it("reads the same on the plan, the milestone view and a record", () => {
    const now = horizon("Now");
    for (const title of ["Cart", "Payment"]) {
      const ticket = store.createIssue({ title });
      store.milestones().addMember(now, ticket.identifier, {}, "vp");
      finish(ticket.identifier);
    }
    idea("Invoice search", { horizon: now, plan: { ...READY_PLAN, breakdown: rows(1) } });
    expect(horizonView("Now").percent).toBe(66);
    expect(store.milestones().get(now).progress.percent).toBe(66);
  });
});

describe("a horizon held with planning off", () => {
  it("names its hold where a write to it is refused, and on its milestone view", () => {
    const { now, tasks } = mixedHorizon();
    finish(tasks[2]!);
    store.setSetting("features.planning", false, "vp", { via: "settings" });
    expect(() => store.updateIssue(now, { status: "done" }, "vp")).toThrow(/Planning is off in this workspace.* is held by 3 scheduled ideas that have not shipped; turn planning on to see them\./);
    expect(store.milestones().get(now).heldByPlan).toBe(3);
    // A plain milestone, and a horizon nothing holds, read exactly as before.
    const plain = store.createIssue({ title: "Release train", kind: "milestone" });
    expect(store.milestones().get(plain.identifier)).not.toHaveProperty("heldByPlan");
    expect(store.milestones().get(horizon2(store, "Next"))).not.toHaveProperty("heldByPlan");
    expect(() => store.updateIssue(horizon2(store, "Next"), { title: "Soon" }, "vp")).toThrow(/^Planning is off in this workspace; a person turns it on in Settings → Experimental or with `staple settings set features.planning true --person`\.$/);
  });
});

describe("the stage a hold reads", () => {
  it("is the record's own view's: a link this device lacks counts as neither landed nor open", () => {
    const now = horizon("Now");
    const search = idea("Invoice search", { horizon: now });
    const [landed, gone] = ["Search index", "Search ranking"].map((title) => store.createIssue({ title }).identifier);
    plan.adopt(search, landed!, "vp");
    plan.adopt(search, gone!, "vp");
    finish(landed!);
    // The other linked issue is gone on this device (a rewind, say): the link stays.
    store.db.exec(`PRAGMA foreign_keys = OFF; DELETE FROM issues WHERE id = '${store.getIssue(gone!).id}'; PRAGMA foreign_keys = ON;`);
    expect(plan.ideaView(search)).toMatchObject({ stage: "shipped", missingLinks: [expect.any(String)] });
    expect(plan.holdOf(now)).toBe(0);
    expect(horizonView("Now")).toMatchObject({ records: { shipped: 1 }, complete: true });
  });

  it("holds a record whose only link this device lacks: started, never shipped", () => {
    const now = horizon("Now");
    const search = idea("Invoice search", { horizon: now, plan: { ...READY_PLAN, breakdown: rows(2) } });
    const ticket = store.createIssue({ title: "Search index" });
    plan.adopt(search, ticket.identifier, "vp");
    store.db.exec(`PRAGMA foreign_keys = OFF; DELETE FROM issues WHERE id = '${store.getIssue(ticket.identifier).id}'; PRAGMA foreign_keys = ON;`);
    expect(plan.ideaView(search)).toMatchObject({ stage: "started", missingLinks: [expect.any(String)] });
    expect(plan.holdOf(now)).toBe(1);
    expect(horizonView("Now")).toMatchObject({ units: { planned: 2 }, records: { started: 1 }, complete: false });
  });
});

describe("a horizon with no members left", () => {
  it("reopens when the person schedules an unshipped idea onto it", () => {
    const now = horizon("Now");
    const ticket = store.createIssue({ title: "Ledger" }).identifier;
    store.milestones().addMember(now, ticket, {}, "vp");
    finish(ticket);
    store.milestones().removeMember(now, ticket, {}, "vp");
    expect(categoryOf(now)).toBe("done");
    idea("Invoice search", { horizon: now });
    expect(categoryOf(now)).not.toBe("done");
  });
});

describe("a horizon's goal pace", () => {
  it("names the planned work beside the leaves it counts", () => {
    const { now } = mixedHorizon();
    expect(store.milestones().get(now).goal.pace.message).toMatch(/^3\/4 leaves done, 5 planned in ideas with no tickets yet, 1 idea not sized;/);
  });
});

function horizon2(target: WorkspaceStore, name: string): string {
  return target.plan().view().horizons.find((h) => h.name === name)?.id ?? (target.db.prepare("SELECT id FROM issues WHERE title = ? AND plan_rank IS NOT NULL").get(name) as { id: string }).id;
}
