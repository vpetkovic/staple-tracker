import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { SessionContext } from "../src/ui/app/src/lib/session.js";
import type { HorizonData, PlanData } from "../src/ui/app/src/lib/plan-types.js";
import { fakeSession } from "../src/ui/app/src/views/fake-session.js";
import { detail } from "../src/ui/app/src/detail/detail-fixture.js";
import { HorizonSection } from "../src/ui/app/src/detail/PlanActions.js";
import { useIssueActions } from "../src/ui/app/src/detail/IssueActions.js";
import { DeliveryChips, HorizonsBoard, cardMenuItems } from "../src/ui/app/src/views/plan/PlanBoards.js";
import { PlanTimeline } from "../src/ui/app/src/views/plan/PlanTimeline.js";
import { ideasColumns } from "../src/ui/app/src/views/plan/plan-model.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;
let store: WorkspaceStore;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "LAR");
  store.plan().enable("person", { person: { via: "settings" } });
});
afterEach(() => store.db.close());
const plain = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

function Drawer({ horizon }: { horizon: HorizonData }) {
  const controller = useIssueActions(() => {});
  // A stale milestone payload must not override the horizon's authoritative progress.
  return <HorizonSection detail={detail()} horizon={horizon} ideas={[]} controller={controller} />;
}

function displays(plan: PlanData) {
  const horizon = plan.horizons.find((h) => h.name === "Now")!;
  return {
    board: renderToStaticMarkup(<HorizonsBoard plan={plan} write={async () => true} onOpen={() => {}} selected={null} />),
    drawer: renderToStaticMarkup(<SessionContext.Provider value={fakeSession()}><Drawer horizon={horizon} /></SessionContext.Provider>),
    timeline: renderToStaticMarkup(<PlanTimeline plan={plan} write={async () => true} onOpen={() => {}} selected={null} />),
  };
}

it("uses singular counts on the horizon header, drawer and timeline", () => {
  const plan = store.plan().view();
  const horizon = plan.horizons[0]!;
  Object.assign(horizon, { ideaCount: 1, records: { leaves: 1, shipped: 0, started: 0, shaped: 1, exploring: 0, parentCount: 0 }, memberCount: 1 });
  // Keep an otherwise empty timeline group visible, as a hand-placed member does.
  for (const html of Object.values(displays(plan))) {
    expect(plain(html)).toContain("1 idea · 1 member");
    expect(plain(html)).not.toContain("1 ideas");
  }
});

describe("D review integration", () => {
  it("uses the server's complete horizon counts and progress on board, drawer and timeline", () => {
    const plan = store.plan();
    const now = plan.view().horizons.find((h) => h.name === "Now")!;
    plan.capture({ title: "Still exploring", maturity: "exploring", horizon: now.id }, "person", PERSON);
    plan.capture({ title: "Ready", maturity: "shaped", plan: READY_PLAN, horizon: now.id }, "person", PERSON);
    const view = plan.view();
    // Deliberately unlike the visible delivery cards, as with manually added open members.
    const horizon = view.horizons.find((h) => h.id === now.id)!;
    Object.assign(horizon, { ideaCount: 7, records: { leaves: 7, shipped: 0, started: 0, shaped: 7, exploring: 0, parentCount: 0 }, memberCount: 9, shippedCount: 3, lateCount: 4, notStartedCount: 2, progress: 0.25 });
    for (const [name, html] of Object.entries(displays(view))) {
      const words = plain(html);
      for (const expected of ["7 ideas", "9 members", "3 shipped", "4 late", "2 not started"]) expect(words, name).toContain(expected);
      expect(html, name).toContain('aria-label="25% done"');
    }
  });

  it("uses the same completed and approval-pending horizon state in all three views", () => {
    const view = store.plan().view();
    const now = view.horizons.find((h) => h.name === "Now")!;
    Object.assign(now, { progress: 1, memberCount: 2, shippedCount: 1, ideaCount: 5, records: { leaves: 5, shipped: 0, started: 0, shaped: 5, exploring: 0, parentCount: 0 } });
    for (const [name, html] of Object.entries(displays(view))) expect(plain(html), name).toContain("Shipped");
    expect(plain(displays(view).board)).toContain("All 2 members landed");
    now.awaitingApproval = true;
    for (const [name, html] of Object.entries(displays(view))) {
      expect(plain(html), name).toContain("Waiting for your approval");
      expect(html, name).not.toContain(">Shipped</span>");
    }
  });

  it("reads incomplete-plan reasons directly from C's payload, without inferring them from an action", () => {
    const id = store.plan().capture({ title: "Ready then hollowed", maturity: "shaped", plan: READY_PLAN }, "person", PERSON).id;
    store.plan().update(id, { plan: { goal: null } }, "agent");
    const idea = store.plan().ideaView(id);
    expect(idea.planIncomplete).toEqual(["a goal"]);
    const html = renderToStaticMarkup(<DeliveryChips idea={{ ...idea, actions: [] }} />);
    expect(plain(html)).toContain("shaped");
    expect(html).toContain("data-plan-card-incomplete");
  });

  it("offers shaping from an exploring card without a redundant Start exploring action", () => {
    const id = store.plan().capture({ title: "Exploring", maturity: "exploring", plan: READY_PLAN }, "person", PERSON).id;
    const view = store.plan().view();
    const idea = view.ideas.find((i) => i.id === id)!;
    const columns = ideasColumns(view);
    const menu = cardMenuItems(idea, columns.find((c) => c.key === "m:exploring")!, columns);
    expect(menu.others.map((item) => item.id)).toEqual(["shape", "drop"]);
  });

  it("requires an explicit goal setting before a horizon can start a goal run", () => {
    const now = store.plan().view().horizons.find((h) => h.name === "Now")!;
    expect(() => store.runs().start({ actor: "agent", scope: now.identifier })).toThrow(/not set/);
  });

  it("retains a goal run's approval gate after stopping, while work mode finishes without a goal gate", () => {
    const plan = store.plan();
    const [now, next] = plan.view().horizons;
    plan.setHorizonRun(now.id, { mode: "goal", goal: ["A merchant can check out"] }, "person", PERSON);
    const run = store.runs().start({ actor: "agent", scope: now.identifier });
    store.runs().stop(run.id, "person");
    expect(plan.view().horizons.find((h) => h.id === now.id)?.awaitingApproval).toBe(true);
    plan.setHorizonRun(next.id, { mode: "work" }, "person", PERSON);
    const record = plan.capture({ title: "Work to land", maturity: "shaped", plan: READY_PLAN, horizon: next.id }, "person", PERSON).id;
    const task = store.createIssue({ title: "Queue me" });
    plan.adopt(record, task.identifier, "agent");
    store.queue().enqueue(next.id, {}, "person");
    const picked = store.queue().effectiveQueue({ actor: "agent" }).next;
    expect(picked?.identifier).toBe(task.identifier);
    store.checkoutIssue(task.identifier, "agent");
    store.updateIssue(task.identifier, { status: "done" }, "agent");
    const finished = plan.view().horizons.find((h) => h.id === next.id)!;
    expect(finished.awaitingApproval).toBe(false);
    expect(finished.progress).toBe(1);
  });
});
