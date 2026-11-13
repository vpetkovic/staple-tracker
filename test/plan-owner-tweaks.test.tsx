import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { DetailTabStrip } from "../src/ui/app/src/detail/tabs/DetailTabStrip.js";
import { Tabs } from "../src/ui/app/src/components/ui/tabs.js";
import { planCounts } from "../src/ui/app/src/views/plan/plan-counts.js";
import { PlannedIdeaLinks, ideaPlanHref } from "../src/ui/app/src/detail/PlannedIdeaLinks.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;
function fixture() {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  const store = new WorkspaceStore(db, "larkspur", "LAR");
  store.plan().enable("Mira", { person: { via: "settings" } });
  return { db, store, plan: store.plan() };
}
describe("the owner's plan tweaks", () => {
  it("enables Now and Next, with Unscheduled instead of a default Later", () => {
    const { db, plan } = fixture();
    try { expect(plan.view().horizons.map(h => h.name)).toEqual(["Now", "Next"]); }
    finally { db.close(); }
  });
  it("migrates undated Later through journaled fields, retaining hand membership and queue on a plain milestone", () => {
    const { db, store, plan } = fixture();
    try {
      const later = plan.createHorizon({ name: "Later" }, "Mira", PERSON);
      const dated = plan.createHorizon({ name: "Later", date: "2027-02-01" }, "Mira", PERSON);
      const raw = plan.capture({ title: "Undecided", maturity: "exploring", horizon: later.id }, "Mira", PERSON);
      const idea = plan.capture({ title: "Merchant checkout", maturity: "shaped", plan: READY_PLAN, horizon: later.id }, "Mira", PERSON);
      const task = store.createIssue({ title: "Take a payment" });
      plan.adopt(idea.id, task.id, "worker");
      const hand = store.createIssue({ title: "Hand placed" });
      store.milestones().addMember(later.id, hand.id, {}, "Mira");
      store.queue().enqueue(later.id, {}, "Mira");
      const recorded = vi.spyOn(store.journal, "record");
      plan.migrateLegacyLater();
      expect(plan.view().horizons.map(h => h.id)).not.toContain(later.id);
      expect(plan.view().horizons.map(h => h.id)).toContain(dated.id);
      expect(plan.detail(raw.id).idea.horizonId).toBeNull();
      expect(plan.detail(idea.id).idea.horizonId).toBeNull();
      expect(store.milestones().get(later.id).members.map(m => m.issueId)).toEqual([hand.id]);
      expect(store.queue().view().entries.some(e => e.issueId === later.id)).toBe(true);
      expect(store.getIssue(later.id).status).not.toBe("cancelled");
      expect(db.prepare("SELECT plan_rank FROM issues WHERE id = ?").get(later.id)).toMatchObject({ plan_rank: null });
      // The journal itself must carry the three changed issue fields for sync.
      const operations = recorded.mock.calls;
      expect(JSON.stringify(operations)).toContain("planHorizonId");
      expect(JSON.stringify(operations)).toContain("planRank");
      const before = recorded.mock.calls.length;
      plan.migrateLegacyLater();
      expect(recorded.mock.calls.length).toBe(before);
    } finally { db.close(); }
  });
  it("lists dated horizons and plain milestones, and keeps optional undated horizons in Plan only", () => {
    const { db, store, plan } = fixture();
    try {
      const undated = plan.createHorizon({ name: "Research" }, "Mira", PERSON);
      const dated = plan.createHorizon({ name: "Launch", date: "2027-02-01" }, "Mira", PERSON);
      const plain = store.milestones().create({ title: "Plain milestone" }, "Mira");
      expect(plan.view().horizons.some(h => h.id === undated.id)).toBe(true);
      expect(store.milestones().list({ all: true }).map(m => m.milestone.id).sort()).toEqual([dated.id, plain.milestone.id].sort());
      plan.updateHorizon(dated.id, { date: null }, "Mira", PERSON);
      expect(store.milestones().list().map(m => m.milestone.id)).toEqual([plain.milestone.id]);
    } finally { db.close(); }
  });
  it("defers a connected workspace's upgrade until its device can journal it", () => {
    const { db, store, plan } = fixture();
    try {
      const later = plan.createHorizon({ name: "Later" }, "Mira", PERSON);
      db.prepare("INSERT INTO sync_state (id, epoch) VALUES (1, 1)").run();
      const identity = vi.spyOn(store.journal, "deviceIdentity").mockReturnValue(null);
      plan.migrateLegacyLater();
      expect(plan.view().horizons.some(h => h.id === later.id)).toBe(true);
      identity.mockRestore();
    } finally { db.close(); }
  });
  it.each([false, true])("shares the drawer's strip and Radix accessibility, sheet=%s", sheet => {
    const html = renderToStaticMarkup(<Tabs value="ideas"><DetailTabStrip sheet={sheet} label="Plan lens" items={[{ id: "ideas", label: "Ideas" }, { id: "horizons", label: "Horizons" }]} /></Tabs>);
    expect(html).toContain('aria-label="Plan lens"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain("staple-detail-tabstrip");
    expect(html.includes("staple-detail-segments")).toBe(sheet);
    expect(html).toContain(`data-variant="${sheet ? "default" : "line"}"`);
  });
  it("links every planned idea to its own Plan drawer, promoted records included", () => {
    const ideas = [{ id: "a", identifier: null, title: "Checkout" }, { id: "b", identifier: "LAR-9", title: "Promoted checkout" }];
    const html = renderToStaticMarkup(<PlannedIdeaLinks workspace="larkspur" ideas={ideas} />);
    for (const idea of ideas) {
      const url = new URL(ideaPlanHref("larkspur", idea.id), "https://example.test/");
      expect(url.searchParams.get("view")).toBe("plan");
      expect(url.searchParams.get("issue")).toBe(idea.id);
      expect(url.searchParams.get("ws")).toBe("larkspur");
      expect(html).toContain(idea.title);
    }
    expect(html).not.toContain("LAR-9");
  });
  it("uses singular and plural idea/member counts", () => {
    const counts = (leaves: number, memberCount: number, parentCount = 0) => planCounts({ memberCount, records: { leaves, shipped: 0, started: 0, shaped: leaves, exploring: 0, parentCount } });
    expect(counts(1, 1)).toBe("1 idea · 1 member");
    expect(counts(0, 2)).toBe("0 ideas · 2 members");
    expect(counts(2, 0)).toBe("2 ideas · 0 members");
    expect(counts(2, 0, 1)).toBe("2 ideas (+1 parent) · 0 members");
  });
});
