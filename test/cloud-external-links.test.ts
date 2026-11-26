import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";
import type { ExternalItem } from "../src/core/integrations/contracts.js";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";
import { localInventory } from "../src/core/cloud/seed.js";
import { subtreePullRequests } from "../src/core/subtree-pull-requests.js";

const REPO = "a77a0000-0000-4000-8000-000000000501";
const item = (id = "1", kind: "issue" | "pull_request" = "issue"): ExternalItem => ({
  ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id, kind },
  key: `team/repo#${id}`, url: `https://github.com/team/repo/${kind === "issue" ? "issues" : "pull"}/${id}`,
  title: "Private source title", body: "Private source body", status: { id: "open", name: "Open" }, fetchedAt: "2026-11-23T12:00:00.000Z",
});
let fleet: Fleet | undefined;
afterEach(() => { fleet?.close(); fleet = undefined; });

describe("external links across devices", () => {
  it("shares identities and associations by default, and context only after explicit consent", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("writer"), b = fleet.machine("reader");
    await a.sync(); await b.sync(); a.use();
    const issue = a.store.createIssue({ title: "Local task" });
    const link = a.store.externalLinks().link(issue.id, item(), "writer");
    const payloads = JSON.stringify(localInventory(a.db, "2026-11-23T12:00:00Z"));
    expect(payloads).not.toContain("Private source");
    await a.sync(); await b.sync();
    expect(b.store.externalLinks().list(issue.id)[0]?.resource).toMatchObject({ id: link.resource.id, title: null, contextShared: false });
    expect(a.store.externalLinks().resource(link.resource.id).body).toBe("Private source body");
    a.use();
    const outboxBefore = a.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get();
    a.store.externalLinks().remember({ ...item(), fetchedAt: "2026-11-23T13:00:00.000Z" });
    expect(a.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get()).toEqual(outboxBefore);
    a.store.externalLinks().shareContext(link.resource.id, true, "writer");
    await a.sync(); await b.sync();
    expect(b.store.externalLinks().resource(link.resource.id)).toMatchObject({ title: "Private source title", body: "Private source body", contextShared: true });
    expect(b.db.prepare("SELECT * FROM external_private_cache").all()).toEqual([]);
    a.use(); a.store.externalLinks().shareContext(link.resource.id, false, "writer");
    await a.sync(); await b.sync();
    expect(b.store.externalLinks().resource(link.resource.id).body).toBeNull();
    expect(a.store.externalLinks().resource(link.resource.id).body).toBe("Private source body");
    const newcomer = fleet.machine("newcomer"); await newcomer.sync();
    expect(newcomer.store.externalLinks().resource(link.resource.id).body).toBeNull();
  }, 60_000);

  it("hydrates explicit stacks and permits unlink/relink without duplicate pairs", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("writer"); await a.sync(); a.use();
    const issue = a.store.createIssue({ title: "Delivery" });
    const parent = a.store.externalLinks().remember(item("10", "pull_request"));
    const child = a.store.externalLinks().link(issue.id, item("3", "pull_request"), "writer");
    a.store.externalLinks().setStack(issue.id, child.resource.id, { parentResourceId: parent.id, position: 2 }, "writer");
    await a.sync();
    const b = fleet.machine("reader"); await b.sync();
    expect(b.store.externalLinks().list(issue.id)[0]).toMatchObject({ parentResourceId: parent.id, parentMissing: true, position: 2 });
    a.use(); a.store.externalLinks().unlink(issue.id, child.resource.id, "writer"); await a.sync(); await b.sync();
    expect(b.store.externalLinks().list(issue.id)).toEqual([]);
    a.use(); a.store.externalLinks().link(issue.id, item("3", "pull_request"), "writer"); await a.sync(); await b.sync();
    expect(b.store.externalLinks().list(issue.id)).toHaveLength(1);
    expect(b.store.externalLinks().list(issue.id)[0]?.parentResourceId).toBeNull();
    const fresh = fleet.machine("fresh"); await fresh.sync();
    expect(fresh.store.externalLinks().list(issue.id)[0]?.parentResourceId).toBeNull();
  }, 60_000);
  it("preserves competing whole-stack choices instead of combining them into a cycle", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a"); await a.sync(); a.use();
    const issue = a.store.createIssue({ title: "Concurrent stacks" });
    const one = a.store.externalLinks().link(issue.id, item("1", "pull_request"), "a");
    const two = a.store.externalLinks().link(issue.id, item("2", "pull_request"), "a");
    await a.sync(); const b = fleet.machine("b"); await b.sync();
    a.use(); a.store.externalLinks().setStack(issue.id, one.resource.id, { parentResourceId: two.resource.id, position: 1 }, "a");
    b.use(); b.store.externalLinks().setStack(issue.id, two.resource.id, { parentResourceId: one.resource.id, position: 1 }, "b");
    await a.sync(); await b.sync(); await a.sync();
    const conflict = listConflicts(a.db).find(c => c.entity === "externalStack");
    expect(conflict?.field).toBe("entries");
    expect(a.store.externalLinks().list(issue.id).filter(l => l.parentResourceId !== null)).toHaveLength(1);
    expect(b.store.externalLinks().list(issue.id).filter(l => l.parentResourceId !== null)).toHaveLength(1);
    a.use(); resolveConflict(a.db, { id: conflict!.id, choice: "local", actor: "a" });
    await a.sync(); await b.sync(); await a.sync();
    expect(b.store.externalLinks().list(issue.id).map(l => [l.resource.id,l.parentResourceId,l.position]))
      .toEqual(a.store.externalLinks().list(issue.id).map(l => [l.resource.id,l.parentResourceId,l.position]));
  }, 60_000);

  it("restores shared context and links, removes later associations, and excludes the private cache from backups", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a"); await a.sync(); a.use();
    const issue = a.store.createIssue({ title: "Backed up links" });
    const kept = a.store.externalLinks().link(issue.id, item("1", "pull_request"), "a");
    const root = a.store.externalLinks().link(issue.id, item("3", "pull_request"), "a");
    a.store.externalLinks().shareContext(kept.resource.id,true,"a");
    await a.sync(); const b = fleet.machine("b"); await b.sync(); a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    a.store.externalLinks().setStack(issue.id,kept.resource.id,{parentResourceId:root.resource.id,position:1},"a");
    a.store.externalLinks().link(issue.id,item("2"),"a"); await a.sync(); await b.sync();
    await restoreFromBackup(a.db,a.home,REPO,backup.backupId,{ fetchImpl: server.fetch });
    await a.sync(); await b.sync(); await a.sync();
    const fresh = fleet.machine("fresh"); await fresh.sync();
    for (const machine of [a,b,fresh]) {
      expect(machine.store.externalLinks().list(issue.id).map(l => l.resource.id).sort()).toEqual([kept.resource.id,root.resource.id].sort());
      expect(machine.store.externalLinks().list(issue.id).every(l => l.parentResourceId === null && l.position === 0)).toBe(true);
      expect(machine.store.externalLinks().resource(kept.resource.id).body).toBe("Private source body");
    }
    expect(fresh.db.prepare("SELECT * FROM external_private_cache").all()).toEqual([]);
    expect(differences("fresh",stateOf(b.db),stateOf(fresh.db))).toEqual([]);
  }, 60_000);


  it("gives a parent the same pull requests on a second device and on a freshly hydrated one", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("writer"), b = fleet.machine("reader");
    await a.sync(); await b.sync(); a.use();
    const epic = a.store.createIssue({ title: "Epic", kind: "epic" });
    const one = a.store.createIssue({ title: "One", parent: epic.id });
    const two = a.store.createIssue({ title: "Two", parent: epic.id });
    const deep = a.store.createIssue({ title: "Deep", parent: one.id });
    const elsewhere = a.store.createIssue({ title: "Elsewhere" });
    const moved = a.store.createIssue({ title: "Moved", parent: elsewhere.id });
    const links = a.store.externalLinks();
    links.link(epic.id, item("1", "pull_request"), "writer");
    links.link(deep.id, item("2", "pull_request"), "writer");
    links.link(two.id, item("2", "pull_request"), "writer");
    links.link(two.id, item("3", "pull_request"), "writer");
    links.link(moved.id, item("4", "pull_request"), "writer");
    const gone = links.link(one.id, item("5", "pull_request"), "writer");
    links.unlink(one.id, gone.resource.id, "writer");
    a.store.updateIssue(moved.identifier, { parent: epic.identifier }, "writer");
    a.store.updateIssue(two.identifier, { status: "cancelled" }, "writer");
    links.shareContext(links.find(item("3", "pull_request").ref)!.id, true, "writer");
    const shape = (machine: typeof a) => subtreePullRequests(machine.store, epic.id)!.map((p) => [p.key, p.own, p.tickets.map((t) => t.identifier)]);
    const written = shape(a);
    expect(written).toEqual([
      ["team/repo#1", true, [epic.identifier]],
      ["team/repo#2", false, [deep.identifier, two.identifier]],
      ["team/repo#3", false, [two.identifier]],
      ["team/repo#4", false, [moved.identifier]],
    ]);
    await a.sync(); await b.sync();
    const fresh = fleet.machine("fresh"); await fresh.sync();
    for (const machine of [b, fresh]) {
      machine.use();
      expect(shape(machine)).toEqual(written);
      // The state is the writer's private read unless shared: unknown here, the shared one read.
      expect(subtreePullRequests(machine.store, epic.id)!.map((p) => p.state)).toEqual([null, null, "open", null]);
    }
  }, 60_000);
});
