/**
 * What the lenses must agree on (design/plan.md, "Lenses"): a horizon's header reads the server
 * (hand-added members and exploring records included), each issue's horizon reaches the horizon
 * itself, a horizon's run setting is the person's and reaches every agent that picks its work up,
 * and a dependency is an explicit reference, never a word that happens to hold a digit.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { resolveInstructions } from "../src/core/instructions.js";
import { resolveDependencies } from "../src/core/plan-sections.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;

let store: WorkspaceStore;
let plan: PlanStore;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  plan = store.plan();
  plan.clock = () => new Date("2026-11-08T12:00:00.000Z");
  plan.enable("vp", { person: { via: "settings" } });
});

const horizon = (name: string) => plan.view().horizons.find((h) => h.name === name)!;
const finish = (identifier: string) => {
  store.checkoutIssue(identifier, "agent");
  store.updateIssue(identifier, { status: "done" }, "agent");
};
function refused(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

/** Now holds a landed record, a hand-added open task, and an exploring record whose planned start has passed. */
function nowWithOpenWork() {
  const now = horizon("Now");
  const landed = plan.capture({ title: "Landed", maturity: "shaped", plan: READY_PLAN, horizon: now.id }, "vp", PERSON).id;
  const work = store.createIssue({ title: "Landed work" }).identifier;
  plan.adopt(landed, work, "agent");
  finish(work);
  const open = store.createIssue({ title: "Hand-added open task" }).identifier;
  store.milestones().addMember(now.identifier, open, {}, "vp");
  const exploring = plan.capture({ title: "Exploring slot", maturity: "exploring", horizon: now.id, plannedStart: "2026-10-01", plannedTarget: "2026-10-20" }, "vp", PERSON).id;
  return { landed, open, exploring };
}

describe("a horizon's header reads the server", () => {
  it("counts the open work its cards do not show: a hand-added member and an exploring record past its start", () => {
    nowWithOpenWork();
    // The board folds and marks shipped from these alone (plan-model's horizonDone; lenses.test.tsx).
    expect(horizon("Now")).toMatchObject({ shipped: false, ideaCount: 2, memberCount: 2, shippedCount: 1, notStartedCount: 1, lateCount: 0, progress: 0.5 });
  });

  it("counts a late started record on the server", () => {
    const now = horizon("Now");
    const id = plan.capture({ title: "Late work", maturity: "shaped", plan: READY_PLAN, horizon: now.id, plannedTarget: "2026-10-01" }, "vp", PERSON).id;
    const task = store.createIssue({ title: "Still working" });
    plan.adopt(id, task.identifier, "agent");
    store.checkoutIssue(task.identifier, "agent");
    expect(horizon("Now")).toMatchObject({ lateCount: 1, memberCount: 1, ideaCount: 1, shippedCount: 0, progress: 0 });
  });

  it("reads every member landed as progress 1", () => {
    const now = horizon("Now");
    const landed = plan.capture({ title: "Landed", maturity: "shaped", plan: READY_PLAN, horizon: now.id }, "vp", PERSON).id;
    const work = store.createIssue({ title: "Landed work" }).identifier;
    plan.adopt(landed, work, "agent");
    finish(work);
    expect(horizon("Now").progress).toBe(1);
    expect(horizon("Next").progress).toBeNull();
  });
});

describe("a horizon is its own horizon, and the task list leaves it out", () => {
  it("maps a horizon to itself, so it never falls under No horizon", () => {
    const now = horizon("Now");
    expect(plan.horizonsOf([now.id]).get(now.id)).toMatchObject({ identifier: now.identifier, name: "Now" });
    expect(plan.horizonIds()).toEqual(new Set(plan.view().horizons.map((h) => h.id)));
  });
});

describe("a horizon's run setting", () => {
  it("is the person's: a goal and how far agents take it, refused to an agent on every path", () => {
    const now = horizon("Now");
    expect(now).toMatchObject({ runMode: null, goal: [] });
    plan.setHorizonRun(now.id, { mode: "goal", goal: ["Checkout works end to end", "  ", "SDKs published"] }, "vp", PERSON);
    expect(horizon("Now")).toMatchObject({ runMode: "goal", goal: ["Checkout works end to end", "SDKs published"] });
    expect(refused(() => plan.setHorizonRun(now.id, { mode: "work" }, "agent")).message).toContain("person");
    expect(refused(() => plan.setHorizonRun(now.id, { mode: "until-forever" as never }, "vp", PERSON)).message).toContain("until its work is done");
    // The milestone's own routes cannot reach around it.
    expect(refused(() => store.milestones().update(now.identifier, { acceptanceCriteria: ["Agent's own goal"] }, "agent")).message).toContain("person");
    expect(refused(() => store.updateIssue(now.identifier, { acceptanceCriteria: ["Agent's own goal"] }, "agent")).message).toContain("person");
    expect(horizon("Now").goal).toEqual(["Checkout works end to end", "SDKs published"]);
  });

  it("reaches every ticket under the horizon as an instruction, the goal and how far to go", () => {
    const now = horizon("Now");
    const record = plan.capture({ title: "Epic on Now", maturity: "shaped", plan: READY_PLAN, horizon: now.id }, "vp", PERSON).id;
    const epic = plan.promote(record, "vp", PERSON).identifier!;
    const task = store.createIssue({ title: "A task under it", parent: epic });
    expect(resolveInstructions(store.db, task.id, { planning: store.planningOn() }).find((entry) => entry.key === "horizon-run")).toBeUndefined();
    plan.setHorizonRun(now.id, { mode: "epic", goal: ["Checkout works end to end"] }, "vp", PERSON);
    const instruction = resolveInstructions(store.db, task.id, { planning: store.planningOn() }).find((entry) => entry.key === "horizon-run")!;
    expect(instruction).toMatchObject({ source: { kind: "milestone", ref: now.identifier }, effective: true });
    expect(instruction.body).toContain("Stop for review after each epic");
    expect(instruction.body).toContain("Checkout works end to end");
    // The horizon's own For agents view carries it too.
    expect(resolveInstructions(store.db, now.id, { planning: store.planningOn() }).find((entry) => entry.key === "horizon-run")?.source.kind).toBe("self");
  });

  it("allows a goal run only on a horizon set to run until its goal is met", () => {
    const now = horizon("Now");
    const record = plan.capture({ title: "Work", maturity: "shaped", plan: READY_PLAN, horizon: now.id }, "vp", PERSON).id;
    plan.adopt(record, store.createIssue({ title: "Some work" }).identifier, "agent");
    plan.setHorizonRun(now.id, { mode: "work" }, "vp", PERSON);
    expect(refused(() => store.runs().start({ actor: "agent", scope: now.identifier })).message).toContain("until its work is done");
    plan.setHorizonRun(now.id, { mode: "goal", goal: ["Done"] }, "vp", PERSON);
    expect(store.runs().start({ actor: "agent", scope: now.identifier }).goal).not.toBeNull();
    expect(horizon("Now").awaitingApproval).toBe(true);
  });
});

describe("a dependency is an explicit reference", () => {
  const records = [
    { id: "oauth", identifier: null, title: "OAuth2 login", rowKeys: [] },
    { id: "s3", identifier: null, title: "S3 export", rowKeys: [] },
    { id: "c2", identifier: null, title: "C2 Checkout API", rowKeys: ["2.1", "2.2"] },
    { id: "epic40", identifier: "TST-40", title: "R2 · EPIC-40 — Exercise API", rowKeys: ["40.1"] },
    { id: "epic49", identifier: "TST-49", title: "R2 · EPIC-49 — Reference APIs", rowKeys: [] },
    { id: "me", identifier: null, title: "Billing page", rowKeys: ["1.1"] },
  ];
  const deps = (dependencies: string[], dependsOn: string[] = []) =>
    resolveDependencies("me", { dependencies, breakdown: [{ id: "row-1", key: "1.1", title: "x", estimate: null, dependsOn, acceptance: "y", owner: null, notes: null }] }, records);

  it("never reads prose words with digits as references", () => {
    expect(deps(["Stripe's API uses OAuth2 under the hood; nothing to wait on", "Not blocked by S3 at all"])).toEqual([]);
    // Even leading a line, a mixed-case word is not a key; capitals with a number are.
    expect(deps(["OAuth2 is used throughout"])).toEqual([]);
    expect(deps(["S3 must be configured first"])).toEqual(["s3"]);
  });

  it("reads a line that leads with a record's key or ticket number, a title's own leading keys, and another plan's row key", () => {
    expect(deps(["C2 must land first"])).toEqual(["c2"]);
    expect(deps(["TST-40 (the productization)"])).toEqual(["epic40"]);
    expect(deps(["EPIC-49 for the reference shapes"])).toEqual(["epic49"]);
    expect(deps([], ["1.1", "40.1", "2.2"])).toEqual(["epic40", "c2"]);
    // A key two records share (R2) names neither.
    expect(deps(["R2 ships first"])).toEqual([]);
  });
});
