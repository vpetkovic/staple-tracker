import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";
const PERSON = { via: "settings" };
function setup() {
  const db = openDb(":memory:"); migrateWorkspace(db);
  const s = new WorkspaceStore(db, "larkspur", "LAR");
  s.setSetting("features.planning", true, "Mira", PERSON);
  const [now, next] = s.plan().view().horizons;
  const idea = s.plan().capture({ title: "Larkspur launch", maturity: "shaped", plan: READY_PLAN, horizon: now!.id }, "Mira", { person: PERSON });
  const task = s.createIssue({ title: "Larkspur checkout" });
  const other = s.createIssue({ title: "Larkspur theme" });
  const ordinary = s.createIssue({ title: "Larkspur ordinary milestone", kind: "milestone" });
  s.plan().adopt(idea.id, task.id, "worker");
  s.milestones().addMember(now!.id, other.id, {}, "Mira");
  s.plan().setHorizonRun(now!.id, { mode: "goal", goal: ["A merchant accepts an order"] }, "Mira", { person: PERSON });
  return { s, now: now!, next: next!, idea, task, other, ordinary };
}
type World = ReturnType<typeof setup>;
const attempts: Record<string, (w: World) => unknown> = {
  rename: ({ s, now }) => s.updateIssue(now.id, { title: "Agent rename" }, "worker"),
  cancel: ({ s, now }) => s.updateIssue(now.id, { status: "cancelled" }, "worker"),
  rekind: ({ s, next }) => s.updateIssue(next.id, { kind: "task" }, "worker"),
  date: ({ s, now }) => s.milestones().update(now.id, { targetDate: "2027-01-01" }, "worker"),
  goal: ({ s, now }) => s.milestones().update(now.id, { acceptanceCriteria: ["Agent goal"] }, "worker"),
  "empty queue": ({ s, next }) => s.queue().enqueue(next.id, {}, "worker"),
  "active queue": ({ s, now }) => s.queue().enqueue(now.id, {}, "worker"),
  "goal run": ({ s, now }) => s.runs().start({ actor: "worker", scope: now.id }),
  "member add": ({ s, next, task }) => s.milestones().addMember(next.id, task.id, {}, "worker"),
  "member remove": ({ s, now, other }) => s.milestones().removeMember(now.id, other.id, {}, "worker"),
  "member move": ({ s, next, other }) => s.milestones().moveMember(other.id, { to: next.id }, "worker"),
  "member move out": ({ s, other, ordinary }) => {
    return s.milestones().moveMember(other.id, { to: ordinary.id }, "worker");
  },
  "kind removal": ({ s }) => s.removeKind("milestone", { migrateTo: "task" }, "worker"),
  "member reorder": ({ s, now, other }) => s.milestones().reorderMembers(now.id, [other.id], {}, "worker"),
  "horizon dependencies": ({ s, now, task }) => s.setBlockedBy(now.id, [task.id], "worker"),
  "horizon as blocker": ({ s, now, task }) => s.setBlockedBy(task.id, [now.id], "worker"),
};
describe("record identity protects hidden planning data", () => {
  for (const [name, attempt] of Object.entries(attempts)) it(`OFF refuses horizon ${name}`, () => {
    const w = setup();
    try { w.s.setSetting("features.planning", false, "Mira", PERSON); expect(() => attempt(w)).toThrow(); }
    finally { w.s.db.close(); }
  });
  it("ON OFF agent attempts ON preserves horizons, goals, settings and all plan bytes", () => {
    const w = setup(); const { s } = w;
    try {
      const tables = ["issues", "documents", "plan_links", "plan_rows", "plan_members", "milestone_members", "milestone_meta"];
      const bytes = () => JSON.stringify(tables.map(t => s.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
      const before = bytes(), view = s.plan().view();
      s.setSetting("features.planning", false, "Mira", PERSON);
      const accepted: string[] = [];
      for (const [name, attempt] of Object.entries(attempts)) { try { attempt(w); accepted.push(name); } catch { /* expected refusal */ } }
      s.setSetting("features.planning", true, "Mira", PERSON);
      expect(accepted).toEqual([]); expect(bytes()).toBe(before); expect(s.plan().view()).toEqual(view);
    } finally { s.db.close(); }
  });
  for (const enabled of [true, false]) {
    it(`reserved kinds survive removal attempts with planning ${enabled}`, () => {
      const w = setup();
      try {
        w.s.db.prepare("DELETE FROM milestone_members").run();
        w.s.setSetting("features.planning", enabled, "Mira", PERSON);
        for (const kind of ["milestone", "idea"]) {
          expect(() => w.s.removeKind(kind, { migrateTo: "task" }, "worker")).toThrow(/Now|Next|Larkspur launch/);
        }
        expect(w.s.isHorizon(w.next.id)).toBe(true); expect(w.s.getIssue(w.idea.id).kind).toBe("idea");
      } finally { w.s.db.close(); }
    });
    it(`update_task refuses reparenting work under an idea with planning ${enabled}`, () => {
      const w = setup();
      try { w.s.setSetting("features.planning", enabled, "Mira", PERSON); expect(() => w.s.updateIssue(w.task.id, { parent: w.idea.id } as never, "worker")).toThrow(/idea/); expect(w.s.getIssue(w.task.id).parentId).toBeNull(); }
      finally { w.s.db.close(); }
    });
  }
  it("OFF generic idea detail refuses rather than exposing a hidden idea as a task", () => {
    const w = setup();
    try { w.s.setSetting("features.planning", false, "Mira", PERSON); expect(() => w.s.context(w.idea.id)).toThrow(/Planning is off/); }
    finally { w.s.db.close(); }
  });
});
