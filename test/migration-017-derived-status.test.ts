/**
 * Migration 017 backfills `derived_status` from the rule it replaces: the newest status-moving
 * event is a derived `status_changed` that landed on the row's status.
 *
 * The database is a real one: a store at the latest version makes the history (a derived epic,
 * one a person moved afterwards, one a checkout claimed, a derived milestone), and then loses
 * migration 017's column and trigger and its stamp, which is the shape a version-16 file has
 * with that history in it. Walking it forward must give back exactly the ownership the store
 * had recorded, and owe the service what it found.
 */
import { describe, expect, it } from "vitest";
import { applyToDatabase } from "../src/core/cloud/apply.js";
import { openDb } from "../src/core/db.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { describeSchema } from "../src/core/migrations/runner.js";
import { WORKSPACE_TARGET, migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";

describe("workspace migration 017", () => {
  it("backfills derivation's ownership from the event log, and owes the service what it found", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    const store = new WorkspaceStore(db, "legacy", "LEG");
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const start = (id: string): void => {
      store.updateIssue(id, { assignee: "w" }, "w");
      store.updateIssue(id, { status: "in_progress" }, "w");
    };
    const derived = store.createIssue({ title: "derived", kind: "epic" });
    start(store.createIssue({ title: "d child", parent: derived.id }).id);
    const moved = store.createIssue({ title: "moved by hand", kind: "epic" });
    start(store.createIssue({ title: "m child", parent: moved.id }).id);
    store.updateIssue(moved.id, { status: "in_review" }, "vp");
    // Moved away and back by hand: an older derived event names this status, the newest does not.
    const back = store.createIssue({ title: "moved back by hand", kind: "epic" });
    start(store.createIssue({ title: "b child", parent: back.id }).id);
    store.updateIssue(back.id, { status: "in_review" }, "vp");
    store.updateIssue(back.id, { assignee: "vp" }, "vp");
    store.updateIssue(back.id, { status: "in_progress" }, "vp");
    const claimed = store.createIssue({ title: "claimed", kind: "epic" });
    store.createIssue({ title: "c child", parent: claimed.id });
    store.checkoutIssue(claimed.id, "agent");
    const milestone = store.createIssue({ title: "cut", kind: MILESTONE_KIND });
    const member = store.createIssue({ title: "member" });
    store.milestones().addMember(milestone.id, member.id, {}, "vp");
    start(member.id);
    const owned = (): unknown => db.prepare("SELECT identifier, status, derived_status FROM issues WHERE derived_status IS NOT NULL ORDER BY identifier").all();
    const recorded = owned();
    expect(recorded).toEqual([
      { identifier: derived.identifier, status: "in_progress", derived_status: "in_progress" },
      { identifier: milestone.identifier, status: "in_progress", derived_status: "in_progress" },
    ]);

    // The same history on a version-16 file.
    db.exec("DROP TRIGGER issues_derived_status_cleared");
    db.exec("DROP TRIGGER issues_derived_status_created");
    db.exec("ALTER TABLE issues DROP COLUMN derived_status");
    db.prepare("UPDATE meta SET value = '16' WHERE key = 'schema_version'").run();
    expect(describeSchema(db, WORKSPACE_TARGET).pending).toEqual([17]);

    migrateWorkspace(db);
    expect(describeSchema(db, WORKSPACE_TARGET)).toMatchObject({ current: 17, pending: [] });
    expect(owned()).toEqual(recorded);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'derived_status_publish_owed'").get()).toEqual({ value: "1" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual([
      { name: "issues_derived_status_cleared" },
      { name: "issues_derived_status_created" },
    ]);
  });

  it("owes nothing when the log says derivation owns nothing", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    const store = new WorkspaceStore(db, "legacy", "LEG");
    store.createIssue({ title: "a leaf" });
    db.exec("DROP TRIGGER issues_derived_status_cleared");
    db.exec("DROP TRIGGER issues_derived_status_created");
    db.exec("ALTER TABLE issues DROP COLUMN derived_status");
    db.prepare("UPDATE meta SET value = '16' WHERE key = 'schema_version'").run();
    migrateWorkspace(db);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'derived_status_publish_owed'").get()).toBeUndefined();
  });
});

describe("the layers that hold derived_status to the status", () => {
  function epicWithChild(): { store: WorkspaceStore; epic: string; child: string } {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    const store = new WorkspaceStore(db, "layers", "LAY");
    const epic = store.createIssue({ title: "E", kind: "epic" }).id;
    const child = store.createIssue({ title: "C", parent: epic }).id;
    store.updateIssue(child, { assignee: "w" }, "w");
    return { store, epic, child };
  }
  const row = (store: WorkspaceStore, id: string): unknown => store.db.prepare("SELECT status, derived_status FROM issues WHERE id = ?").get(id);

  it("the applier drops a derivedStatus that is not the status the row ends up holding", () => {
    const { store, epic } = epicWithChild();
    // With the triggers out of the way, what the applier itself writes is what shows.
    const triggers = store.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string; sql: string }>;
    for (const { name } of triggers) store.db.exec(`DROP TRIGGER ${name}`);
    applyToDatabase(store.db, { entity: "issue", entityId: epic, verb: "update", payload: { derivedStatus: "done" }, actor: null, deviceId: "other", at: "2026-09-28T00:00:00.000Z", opId: null });
    expect(row(store, epic)).toEqual({ status: "backlog", derived_status: null });
    applyToDatabase(store.db, { entity: "issue", entityId: epic, verb: "update", payload: { status: "done", derivedStatus: "done" }, actor: null, deviceId: "other", at: "2026-09-28T00:00:00.000Z", opId: null });
    expect(row(store, epic)).toEqual({ status: "done", derived_status: "done" });
  });

  it("the trigger keeps derivation's own write over a stale value, and clears one that names another status", () => {
    const { store, epic, child } = epicWithChild();
    // A stale row, as a build that held no invariant could leave one: {todo, done}.
    const cleared = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'issues_derived_status_cleared'").get() as { sql: string };
    store.db.exec("DROP TRIGGER issues_derived_status_cleared");
    store.db.prepare("UPDATE issues SET status = 'todo', derived_status = 'done' WHERE id = ?").run(epic);
    store.db.exec(cleared.sql);
    // Derivation closes it: the column already says `done`, and the write is still derivation's.
    store.updateIssue(child, { status: "in_progress" }, "w");
    expect(row(store, epic)).toEqual({ status: "in_progress", derived_status: "in_progress" });
    store.db.exec("DROP TRIGGER issues_derived_status_cleared");
    store.db.prepare("UPDATE issues SET status = 'todo', derived_status = 'done' WHERE id = ?").run(epic);
    store.db.exec(cleared.sql);
    store.updateIssue(child, { status: "done" }, "w");
    expect(row(store, epic)).toEqual({ status: "done", derived_status: "done" });
    // Any write that leaves the column naming another status clears it.
    store.db.prepare("UPDATE issues SET derived_status = 'in_review' WHERE id = ?").run(epic);
    expect(row(store, epic)).toEqual({ status: "done", derived_status: null });
  });
});
