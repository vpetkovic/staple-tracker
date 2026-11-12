import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { buildBrief } from "../src/core/run-brief.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { via: "cli" };
const OFF = /Planning is off in this workspace/;
function workspace() {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "larkspur", "LAR");
}

describe("experimental planning workspace flag", () => {
  it("defaults off, is readable, and only a person can change or reset it", () => {
    const store = workspace();
    expect(store.settingValue("features.planning")).toMatchObject({ value: false, source: "default" });
    expect(() => store.setSetting("features.planning", true, "agent")).toThrow(/person/);
    expect(() => store.resetSetting("features.planning", "agent")).toThrow(/person/);
    expect(() => store.plan().enable("agent")).toThrow(/person/);
    store.setSetting("features.planning", true, "Larkspur owner", PERSON);
    expect(store.planningOn()).toBe(true);
    store.resetSetting("features.planning", "Larkspur owner", PERSON);
    expect(store.planningOn()).toBe(false);
    store.db.close();
  });

  it("refuses plan writes off and keeps ideas out of tasks, numbers, checkout and pickup in both states", () => {
    const store = workspace();
    expect(() => store.plan().capture({ title: "Hidden" }, "agent")).toThrow(OFF);
    store.setSetting("features.planning", true, "owner", PERSON);
    const idea = store.plan().capture({ title: "Larkspur idea" }, "agent");
    store.setSetting("features.planning", false, "owner", PERSON);
    expect(() => store.plan().capture({ title: "Hidden" }, "agent")).toThrow(OFF);
    expect(store.listIssues({ includeResolved: true }).map(i => i.id)).not.toContain(idea.id);
    expect(store.listIssues({ kind: ["idea"], includeResolved: true })).toEqual([]);
    expect(store.tree().some(row => row.issue.id === idea.id)).toBe(false);
    expect(() => store.checkoutIssue(idea.id, "agent")).toThrow();
    expect(() => store.queue().enqueue(idea.id, {}, "agent")).toThrow();
    expect(() => store.updateIssue(idea.id, { kind: "task" }, "agent")).toThrow();
    expect(() => store.createIssue({ title: "Bypass", kind: "idea", createdBy: "agent" })).toThrow(OFF);
    expect(store.getIssue(idea.id).identifier).toMatch(/^~/);
    expect(store.queue().effectiveQueue().rows.some(row => row.issueId === idea.id)).toBe(false);
    store.db.close();
  });

  it("restores every stored idea, horizon, section, link and run setting byte for byte", () => {
    const store = workspace();
    store.setSetting("features.planning", true, "owner", PERSON);
    const horizon = store.plan().view().horizons[0]!;
    const idea = store.plan().capture({ title: "Larkspur launch", maturity: "shaped", plan: READY_PLAN, horizon: horizon.id }, "owner", { person: PERSON });
    const task = store.createIssue({ title: "Larkspur work", createdBy: "agent" });
    store.plan().adopt(idea.id, task.id, "agent");
    store.plan().setHorizonRun(horizon.id, { mode: "epic" }, "owner", { person: PERSON });
    const bytes = () => JSON.stringify(["issues", "documents", "plan_links", "plan_rows", "plan_members", "milestone_members"].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const before = bytes();
    const view = store.plan().view();
    store.setSetting("features.planning", false, "owner", PERSON);
    expect(store.planningOn()).toBe(false);
    expect(store.listIssues({ includeResolved: true }).find(i => i.id === horizon.id)?.kind).toBe("milestone");
    store.setSetting("features.planning", true, "owner", PERSON);
    expect(bytes()).toBe(before);
    expect(store.plan().view()).toEqual(view);
    store.db.close();
  });
});


it("horizon-run instructions are absent from next, detail, continue and run briefs while OFF", () => {
  const store = workspace();
  store.setSetting("features.planning", true, "owner", PERSON);
  const horizon = store.plan().view().horizons[0]!;
  const idea = store.plan().capture({ title: "Larkspur release", maturity: "shaped", plan: READY_PLAN, horizon: horizon.id }, "owner", { person: PERSON });
  const epic = store.plan().promote(idea.id, "owner", { person: PERSON });
  const task = store.createIssue({ title: "Larkspur task", parent: epic.id });
  store.plan().setHorizonRun(horizon.id, { mode: "epic", goal: ["Larkspur ships"] }, "owner", { person: PERSON });
  for (const enabled of [true, false, true]) {
    store.setSetting("features.planning", enabled, "owner", PERSON);
    const instructions = store.instructions(task.id);
    expect(instructions.some(i => i.key === "horizon-run")).toBe(enabled);
    const context = store.context(task.id);
    expect(context.instructions.some(i => i.key === "horizon-run")).toBe(enabled);
    const brief = buildBrief({ ref: task.identifier, title: task.title, workspace: "/tmp/larkspur", db: "/tmp/larkspur.db", runId: "larkspur", actor: "worker", finish: "in_review", instructions: null, ticketInstructions: instructions });
    expect(brief.includes("Stop for review after each epic")).toBe(enabled);
  }
  store.db.close();
});

it("continue_run omits horizon instructions while OFF", () => {
  const store = workspace();
  store.setSetting("features.planning", true, "owner", PERSON);
  const horizon = store.plan().view().horizons[0]!;
  const idea = store.plan().capture({ title: "Larkspur goal", maturity: "shaped", plan: READY_PLAN, horizon: horizon.id }, "owner", { person: PERSON });
  const epic = store.plan().promote(idea.id, "owner", { person: PERSON });
  const task = store.createIssue({ title: "Larkspur pickup", parent: epic.id });
  store.plan().setHorizonRun(horizon.id, { mode: "epic", goal: ["Larkspur ships"] }, "owner", { person: PERSON });
  store.setSetting("features.planning", false, "owner", PERSON);
  store.runs().start({ actor: "worker", scope: epic.id });
  const answer = store.runs().continue({ actor: "worker" });
  expect(answer.action).toBe("take");
  if (answer.action === "take") {
    expect(answer.issueId).toBe(task.id);
    expect(answer.instructions.some(i => i.key === "horizon-run")).toBe(false);
  }
  store.db.close();
});
