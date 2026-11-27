/**
 * Idea blockers and sub-idea readiness (design/plan.md, "Sub-ideas and blockers"): structured
 * edges between plan records; a shaped sub-idea schedules on any horizon but is not built from
 * until every idea above it is shaped and what it is blocked by has shipped; plan steps wait the
 * same way; and a parent that goes back or is dropped flags the tickets already scaffolded under
 * its sub-ideas, never cancels them. Every expectation is written out by hand.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { PlanStore } from "../src/core/plan-store.js";
import type { PlanPatch } from "../src/core/plan-sections.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;

let store: WorkspaceStore;
let plan: PlanStore;
let now: string;
let later: string;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  plan = store.plan();
  plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
  plan.enable("vp", { person: { via: "settings" } });
  const horizons = plan.view().horizons;
  now = horizons.find((h) => h.name === "Now")!.id;
  later = horizons.find((h) => h.name === "Next")!.id;
});

type Capture = Parameters<PlanStore["capture"]>[0];
const capture = (title: string, extra: Partial<Capture> = {}): string => plan.capture({ title, ...extra }, "vp", PERSON).id;
const view = (id: string) => plan.ideaView(id);
const scaffoldAction = (id: string) => view(id).actions.find((action) => action.id === "scaffold");
const promoteAction = (id: string) => view(id).actions.find((action) => action.id === "promote");
const scaffold = (id: string) => plan.scaffold(id, plan.scaffoldPreview(id).fingerprint, "agent");
const setMaturity = (id: string, maturity: string) => plan.update(id, { maturity }, "vp", PERSON);

/** An exploring parent (an umbrella still being shaped) with a shaped sub-idea. */
function sso() {
  const parent = capture("SSO", { maturity: "exploring", horizon: now });
  const child = capture("Passkeys", { maturity: "shaped", parent, plan: READY_PLAN });
  return { parent, child };
}

describe("structured edges between plan records", () => {
  it("block names the record it waits on, on the view, in dependsOn and on both details; unblock removes it", () => {
    const audit = capture("Audit log", { maturity: "exploring" });
    const export_ = capture("Export", { maturity: "shaped", plan: READY_PLAN });
    plan.block(export_, audit, "agent");
    expect(view(export_).blockedBy).toEqual([audit]);
    expect(view(export_).dependsOn).toEqual([audit]);
    const auditNumber = view(audit).number;
    expect(plan.detail(export_).blockedBy).toEqual([{ id: audit, number: auditNumber, identifier: null, title: "Audit log", state: "exploring", missing: false }]);
    expect(plan.detail(audit).blocks).toEqual([{ id: export_, number: view(export_).number, identifier: null, title: "Export", state: "shaped", missing: false }]);
    // Blocking again changes nothing.
    plan.block(export_, audit, "agent");
    expect(view(export_).blockedBy).toEqual([audit]);
    plan.unblock(export_, audit, "agent");
    expect(view(export_).blockedBy).toEqual([]);
    expect(view(export_).dependsOn).toEqual([]);
    expect(view(export_).heldBy).toBeNull();
  });

  it("resolves either record by its idea number", () => {
    const a = capture("A", { maturity: "exploring" });
    const b = capture("B", { maturity: "exploring" });
    plan.block(view(b).number!, view(a).number!, "agent");
    expect(view(b).blockedBy).toEqual([a]);
    plan.unblock(view(b).number!, view(a).number!, "agent");
    expect(view(b).blockedBy).toEqual([]);
  });

  it("refuses itself, a record above or beneath it, a loop, a record outside the plan, and an edge it does not hold", () => {
    const { parent, child } = sso();
    const other = capture("Other", { maturity: "exploring" });
    const ticket = store.createIssue({ title: "Plain task" });
    expect(() => plan.block(child, child, "agent")).toThrow(/cannot be blocked by itself/);
    expect(() => plan.block(child, parent, "agent")).toThrow(/one is above the other/);
    expect(() => plan.block(parent, child, "agent")).toThrow(/one is above the other/);
    plan.block(other, child, "agent");
    expect(() => plan.block(child, other, "agent")).toThrow(/already waits on it/);
    expect(() => plan.block(child, ticket.identifier, "agent")).toThrow(/is not part of the plan/);
    expect(() => plan.unblock(child, other, "agent")).toThrow(/is not blocked by/);
  });

  it("a longer loop is refused too", () => {
    const a = capture("A", { maturity: "exploring" });
    const b = capture("B", { maturity: "exploring" });
    const c = capture("C", { maturity: "exploring" });
    plan.block(b, a, "agent");
    plan.block(c, b, "agent");
    expect(() => plan.block(a, c, "agent")).toThrow(/already waits on it/);
  });

  it("a shipped or dropped record offers no edit, so takes no edge", () => {
    const a = capture("A", { maturity: "exploring" });
    const gone = capture("Gone", { maturity: "exploring" });
    setMaturity(gone, "dropped");
    expect(() => plan.block(gone, a, "agent")).toThrow(/dropped/);
  });

  it("text in the Dependencies section keeps naming records, beside the edges", () => {
    const c2 = capture("C2 Checkout API", { maturity: "exploring" });
    const audit = capture("Audit log", { maturity: "exploring" });
    const id = capture("Invoices", { maturity: "shaped", horizon: now, plan: { ...READY_PLAN, dependencies: ["C2 lands first"] } });
    expect(view(id).dependsOn).toEqual([c2]);
    plan.block(id, audit, "agent");
    expect(view(id).dependsOn).toEqual([audit, c2]);
    expect(view(id).blockedBy).toEqual([audit]);
    // Only the edge holds Scaffold back; the text makes the step wait, as before.
    expect(view(id).heldBy).toEqual({ parents: [], blockers: [{ id: audit, title: "Audit log", state: "exploring" }] });
    plan.unblock(id, audit, "agent");
    expect(view(id).heldBy).toBeNull();
    expect(view(id).nextStep).toMatchObject({ need: "wait", waitingOn: { records: [{ id: c2, title: "C2 Checkout API", state: "exploring" }] } });
  });
});

describe("a shaped sub-idea under a parent still being shaped", () => {
  it("schedules on any horizon, its parent's or another", () => {
    const { child } = sso();
    plan.update(child, { horizon: later }, "vp", PERSON);
    expect(view(child).horizonId).toBe(later);
    expect(view(child).carriedBy).toBe(later);
    plan.update(child, { horizon: now }, "vp", PERSON);
    expect(view(child).horizonId).toBe(now);
  });

  it("reads shaped · waiting on parent, and holds Scaffold and Promote back saying why", () => {
    const { parent, child } = sso();
    expect(view(child).state).toBe("shaped");
    expect(view(child).heldBy).toEqual({ parents: [{ id: parent, title: "SSO", maturity: "exploring" }], blockers: [] });
    expect(scaffoldAction(child)!.disabledReason).toBe('Waiting on parent: parent "SSO" (exploring).');
    expect(promoteAction(child)!.disabledReason).toBe('Waiting on parent: parent "SSO" (exploring).');
    expect(plan.scaffoldPreview(child).problems).toEqual(['waiting on parent: parent "SSO" (exploring)']);
    const ref = view(child).number!;
    expect(() => scaffold(child)).toThrow(`the idea "Passkeys" (${ref}) cannot be scaffolded yet: it is shaped · waiting on parent, parent "SSO" (exploring). It waits until every idea above it is shaped and what it is blocked by has shipped.`);
    expect(() => plan.promote(child, "agent")).toThrow(/cannot be promoted yet: it is shaped · waiting on parent/);
    expect(store.getIssue(child).kind).toBe("idea");
  });

  it("every idea above it counts, not only its parent", () => {
    const top = capture("Identity", { maturity: "exploring" });
    const middle = capture("SSO", { maturity: "shaped", parent: top, plan: READY_PLAN });
    const leaf = capture("Passkeys", { maturity: "shaped", parent: middle, plan: READY_PLAN });
    expect(view(leaf).heldBy?.parents).toEqual([{ id: top, title: "Identity", maturity: "exploring" }]);
    plan.update(top, { plan: READY_PLAN }, "agent");
    setMaturity(top, "shaped");
    expect(view(leaf).heldBy).toBeNull();
  });

  it("is built once its parent is shaped", () => {
    const { parent, child } = sso();
    plan.update(parent, { plan: READY_PLAN }, "agent");
    setMaturity(parent, "shaped");
    expect(view(child).heldBy).toBeNull();
    expect(scaffoldAction(child)!.disabledReason).toBeUndefined();
    const made = scaffold(child);
    expect(made.tasks).toHaveLength(1);
    expect(store.getIssue(child).kind).not.toBe("idea");
  });

  it("a dropped parent holds it too, named as dropped", () => {
    const { parent, child } = sso();
    setMaturity(parent, "dropped");
    expect(view(child).heldBy?.parents).toEqual([{ id: parent, title: "SSO", maturity: "dropped" }]);
  });
});

describe("a record blocked by another", () => {
  it("is held until the blocker ships, and released by a dropped blocker", () => {
    const audit = capture("Audit log", { maturity: "exploring" });
    const id = capture("Export", { maturity: "shaped", plan: READY_PLAN });
    plan.block(id, audit, "agent");
    expect(view(id).heldBy).toEqual({ parents: [], blockers: [{ id: audit, title: "Audit log", state: "exploring" }] });
    expect(scaffoldAction(id)!.disabledReason).toBe('Waiting on blocker: blocker "Audit log" (exploring).');
    expect(() => scaffold(id)).toThrow(/cannot be scaffolded yet: it is shaped · waiting on blocker, blocker "Audit log" \(exploring\)/);
    setMaturity(audit, "dropped");
    expect(view(id).heldBy).toBeNull();
    expect(scaffold(id).tasks).toHaveLength(1);
  });

  it("is released once the blocker shipped", () => {
    const audit = capture("Audit log", { maturity: "shaped", plan: READY_PLAN });
    const id = capture("Export", { maturity: "shaped", plan: READY_PLAN });
    plan.block(id, audit, "agent");
    const made = scaffold(audit);
    expect(view(id).heldBy?.blockers).toEqual([{ id: audit, title: "Audit log", state: "started" }]);
    for (const task of made.tasks) store.updateIssue(task.existing!, { status: "done" }, "agent");
    expect(view(audit).state).toBe("shipped");
    expect(view(id).heldBy).toBeNull();
  });

  it("a sub-idea waits on what an idea above it is blocked by", () => {
    const audit = capture("Audit log", { maturity: "exploring" });
    const parent = capture("SSO", { maturity: "shaped", plan: READY_PLAN });
    const child = capture("Passkeys", { maturity: "shaped", parent, plan: READY_PLAN });
    plan.block(parent, audit, "agent");
    expect(view(child).heldBy).toEqual({ parents: [], blockers: [{ id: audit, title: "Audit log", state: "exploring" }] });
  });
});

describe("plan steps wait accordingly", () => {
  it("a shaped sub-idea on a horizon waits on its parent, with the parent named", () => {
    const { parent, child } = sso();
    plan.update(child, { horizon: later }, "vp", PERSON);
    const step = view(child).nextStep!;
    expect(step).toMatchObject({ need: "wait", who: "nobody", waitingOn: { parents: [{ id: parent, title: "SSO", maturity: "exploring" }] } });
    expect(step.waitingOn).not.toHaveProperty("records");
    expect(step.instruction).toBe(
      'Nothing to do yet: "Passkeys" waits for its parent "SSO" to be shaped (it is exploring). Never scaffold it before then; Scaffold is refused until every idea above it is shaped and what it is blocked by has shipped.',
    );
  });

  it("a blocked record waits on its blocker", () => {
    const audit = capture("Audit log", { maturity: "exploring" });
    const id = capture("Export", { maturity: "shaped", horizon: now, plan: READY_PLAN });
    expect(view(id).nextStep?.need).toBe("scaffold");
    plan.block(id, audit, "agent");
    expect(view(id).nextStep).toMatchObject({ need: "wait", waitingOn: { records: [{ id: audit, title: "Audit log", state: "exploring" }] } });
  });

  it("a parent's Scaffold leaves a held sub-idea for its own turn, and its step does not wait on it", () => {
    const audit = capture("Audit log", { maturity: "exploring" });
    const parent = capture("SSO", { maturity: "shaped", horizon: now, plan: READY_PLAN });
    const held = capture("Passkeys", { maturity: "shaped", parent, plan: READY_PLAN });
    const ready = capture("SAML", { maturity: "shaped", parent, plan: READY_PLAN });
    plan.block(held, audit, "agent");
    expect(plan.scaffoldPreview(parent).children.map((child) => child.idea.title)).toEqual(["SAML"]);
    expect(view(parent).nextStep?.need).toBe("scaffold");
    scaffold(parent);
    expect(store.getIssue(ready).kind).not.toBe("idea");
    expect(store.getIssue(held).kind).toBe("idea");
    expect(view(held).heldBy?.blockers.map((b) => b.id)).toEqual([audit]);
  });
});

describe("a parent going back to exploring or dropped flags what was scaffolded beneath it", () => {
  const PLAN: PlanPatch = {
    goal: "G",
    breakdown: [{ key: "R1", title: "First", estimate: "3h", dependsOn: [], acceptance: "a", owner: null, notes: null }],
    acceptance: ["x"],
  };
  function scaffoldedUnderShapedParent() {
    const parent = capture("SSO", { maturity: "shaped", plan: READY_PLAN });
    const child = capture("Passkeys", { maturity: "shaped", parent, plan: PLAN });
    const made = scaffold(child);
    const task = store.getIssue(made.tasks[0]!.existing!);
    return { parent, child, task };
  }

  it("back to exploring: the sub-idea's epic and its tickets are flagged, and nothing is cancelled", () => {
    const { parent, child, task } = scaffoldedUnderShapedParent();
    expect(store.context(task.identifier).scaffoldedFrom?.parentUnsettled).toBeNull();
    expect(view(child).heldBy).toBeNull();
    setMaturity(parent, "exploring");
    expect(store.context(task.identifier).scaffoldedFrom?.parentUnsettled).toEqual({
      ideaId: parent,
      ideaNumber: view(parent).number,
      identifier: null,
      title: "SSO",
      maturity: "exploring",
    });
    expect(view(child).state).toBe("started");
    expect(view(child).heldBy?.parents).toEqual([{ id: parent, title: "SSO", maturity: "exploring" }]);
    expect(store.getIssue(task.identifier).status).toBe(task.status);
    // Shaped again, the flag is gone.
    setMaturity(parent, "shaped");
    expect(store.context(task.identifier).scaffoldedFrom?.parentUnsettled).toBeNull();
  });

  it("dropped: flagged as dropped", () => {
    const { parent, task } = scaffoldedUnderShapedParent();
    setMaturity(parent, "dropped");
    expect(store.context(task.identifier).scaffoldedFrom?.parentUnsettled?.maturity).toBe("dropped");
    expect(store.getIssue(task.identifier).status).toBe(task.status);
  });

  it("a resolved ticket carries no flag", () => {
    const { parent, task } = scaffoldedUnderShapedParent();
    store.updateIssue(task.identifier, { status: "done" }, "agent");
    setMaturity(parent, "exploring");
    expect(store.context(task.identifier).scaffoldedFrom?.parentUnsettled).toBeNull();
  });

  it("planning off hides the flag with the rest of the provenance, and keeps the edges", () => {
    const { parent, child, task } = scaffoldedUnderShapedParent();
    const other = capture("Other", { maturity: "exploring" });
    plan.block(child, other, "agent");
    setMaturity(parent, "exploring");
    store.setSetting("features.planning", false, "vp", { via: "settings" });
    expect(store.context(task.identifier).scaffoldedFrom).toBeNull();
    store.setSetting("features.planning", true, "vp", { via: "settings" });
    expect(view(child).blockedBy).toEqual([other]);
  });
});
