import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import type { ExternalItem, ResolvedExternalItem } from "../src/core/integrations/contracts.js";

function setup() {
  const db = openDb(":memory:"); migrateWorkspace(db);
  const store = new WorkspaceStore(db, "test", "TST");
  const first = store.createIssue({ title: "Existing execution task" });
  const second = store.createIssue({ title: "Another task" });
  return { store, links: store.externalLinks(), first, second };
}
function source(id = "1", kind: "issue" | "pull_request" = "issue"): ExternalItem {
  return { ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id, kind },
    key: `team/repo#${id}`, url: `https://github.com/team/repo/${kind === "issue" ? "issues" : "pull"}/${id}`,
    title: `Remote ${id}`, body: "Remote context", status: { id: "open", name: "Open" }, fetchedAt: "2026-11-23T12:00:00Z" };
}

describe("external resource persistence", () => {
  it("keeps one permanent resource and unique many-to-many link pairs after rename and local close/reopen", () => {
    const { store, links, first, second } = setup();
    const a = links.link(first.id, source(), "ada");
    expect(links.link(first.id, source(), "ada").id).toBe(a.id);
    links.link(second.id, source(), "ada");
    links.link(first.id, source("2"), "ada");
    store.updateIssue(first.id, { status: "done" }, "ada");
    store.updateIssue(first.id, { status: "todo" }, "ada");
    links.remember({ ...source(), key: "renamed/repo#1", url: "https://github.com/renamed/repo/issues/1", title: "Renamed source", fetchedAt: "2026-11-23T13:00:00Z" });
    expect(links.list(first.id)).toHaveLength(2);
    expect(links.associations(a.resource.id).map(i => i.id).sort()).toEqual([first.id, second.id].sort());
    expect(links.list(second.id)[0]?.resource.title).toBe("Renamed source");
  });

  it("refreshes only source context, rejects stale cache and preserves context when linked by URL alone", () => {
    const { store, links, first } = setup();
    const before = store.getIssue(first.id);
    const linked = links.link(first.id, source(), "ada");
    const ref: ResolvedExternalItem = { ref: source().ref, key: "team/repo#1", url: source().url };
    links.remember(ref);
    links.remember({ ...source(), title: "Old", fetchedAt: "2026-11-22T12:00:00Z" });
    expect(links.resource(linked.resource.id).title).toBe("Remote 1");
    expect(store.getIssue(first.id)).toEqual(before);
    links.unlink(first.id, linked.resource.id, "ada");
    expect(links.list(first.id)).toEqual([]);
    expect(links.resource(linked.resource.id).body).toBe("Remote context");
  });

  it("keeps a status category through the saved copy and a refresh, and a GitHub status stays without one", () => {
    const { links, first } = setup();
    const linear = (category: string | undefined, fetchedAt: string): ExternalItem => ({ ...source(),
      ref: { providerId: "linear", host: "linear.app", scopeId: "org", containerId: "team", id: "issue-1", kind: "issue" },
      key: "ENG-1", url: "https://linear.app/acme/issue/ENG-1",
      status: { id: "state-1", name: "In review", ...(category ? { category } : {}) } as ExternalItem["status"], fetchedAt });
    const linked = links.link(first.id, linear("started", "2026-11-23T12:00:00Z"), "ada");
    expect(links.resource(linked.resource.id).status).toEqual({ id: "state-1", name: "In review", category: "started" });
    links.remember(linear("completed", "2026-11-23T13:00:00Z"));
    expect(links.list(first.id)[0]?.resource.status).toEqual({ id: "state-1", name: "In review", category: "completed" });
    expect(() => links.remember(linear("paused", "2026-11-23T14:00:00Z"))).toThrow(/invalid status/);
    const github = links.link(first.id, source(), "ada");
    expect(links.resource(github.resource.id).status).toEqual({ id: "open", name: "Open" });
  });

  it("does not persist transport, credentials or unknown adapter fields", () => {
    const { links, first, store } = setup();
    links.link(first.id, { ...source(), connection: { token: "synthetic-secret" } } as ExternalItem, "ada");
    const raw = JSON.stringify(store.db.prepare("SELECT * FROM external_resources").all());
    expect(raw).not.toContain("synthetic-secret");
    expect(() => links.remember({ ...source(), url: "https://user:secret@github.com/team/repo/issues/1" })).toThrow();
    expect(() => links.remember({ ...source(), url: `${source().url}?access_token=secret` })).toThrow();
  });

  it("rolls back resource creation if the target task does not exist", () => {
    const { links, store } = setup();
    expect(() => links.link("TST-999", source(), "ada")).toThrow();
    expect(store.db.prepare("SELECT * FROM external_resources").all()).toEqual([]);
  });

  it("represents explicit PR parents, missing members and multiple stacks without inferring order", () => {
    const { links, first } = setup();
    const parent = links.remember(source("10", "pull_request"));
    const child = links.link(first.id, source("3", "pull_request"), "ada");
    const other = links.link(first.id, source("2", "pull_request"), "ada");
    links.setStack(first.id, child.resource.id, { parentResourceId: parent.id, position: 2 }, "ada");
    expect(links.list(first.id).find(l => l.id === child.id)).toMatchObject({ parentResourceId: parent.id, parentMissing: true, position: 2 });
    links.link(first.id, source("10", "pull_request"), "ada");
    expect(links.list(first.id).find(l => l.id === child.id)?.parentMissing).toBe(false);
    expect(links.list(first.id).find(l => l.id === other.id)?.parentResourceId).toBeNull();
    expect(() => links.setStack(first.id, parent.id, { parentResourceId: child.resource.id, position: 1 }, "ada")).toThrow(/cycle/i);
    links.unlink(first.id, parent.id, "ada");
    expect(links.list(first.id).find(l => l.id === child.id)?.parentMissing).toBe(true);
  });

  it("rejects issue stacks, cross-repository parents, self parents and invalid order", () => {
    const { links, first } = setup();
    const issue = links.link(first.id, source(), "ada");
    const pr = links.link(first.id, source("2", "pull_request"), "ada");
    const other = links.remember({ ...source("3", "pull_request"), ref: { ...source("3", "pull_request").ref, containerId: "elsewhere" } });
    expect(() => links.setStack(first.id, issue.resource.id, { parentResourceId: pr.resource.id, position: 0 }, "ada")).toThrow();
    expect(() => links.setStack(first.id, pr.resource.id, { parentResourceId: other.id, position: 0 }, "ada")).toThrow();
    expect(() => links.setStack(first.id, pr.resource.id, { parentResourceId: pr.resource.id, position: 0 }, "ada")).toThrow();
    expect(() => links.setStack(first.id, pr.resource.id, { parentResourceId: null, position: -1 }, "ada")).toThrow();
  });
});

describe("row integration summaries",()=>{
  it("keeps the order links were made when they share a timestamp, in row previews and the ticket's list",()=>{
    const {store,links,first}=setup();
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    try { for(let n=1;n<=8;n++) links.link(first.id,source(String(n)),"ada"); } finally { vi.useRealTimers(); }
    expect(links.summaries()[first.id]?.issues.items.map(i=>i.title)).toEqual(["Remote 1","Remote 2","Remote 3","Remote 4","Remote 5"]);
    expect(links.list(first.id).map(l=>l.resource.title)).toEqual(Array.from({length:8},(_,i)=>`Remote ${i+1}`));
    store.db.close();
  });
  it("counts every association while bounding context-free previews per kind and omitting unlinked rows",()=>{
    const {store,links,first,second}=setup();
    for(let n=1;n<=8;n++) links.link(first.id,source(String(n)),"ada");
    const pr=links.link(first.id,{...source("9","pull_request"),status:{id:"merged",name:"merged"}},"ada");
    let summaries=links.summaries();
    expect(summaries[first.id]?.issues.items[0]?.status).toEqual({id:"open",name:"Open"});
    expect(summaries[first.id]?.pullRequests.items[0]?.status).toEqual({id:"merged",name:"merged"});
    expect(summaries[first.id]?.issues.count).toBe(8);
    expect(summaries[first.id]?.issues.items).toHaveLength(5);
    expect(summaries[first.id]?.issues.items[0]?.title).toBe("Remote 1");
    expect(summaries[first.id]?.pullRequests).toMatchObject({count:1,items:[{id:pr.resource.id}]});
    expect(JSON.stringify(summaries)).not.toContain("Remote context");
    expect(summaries[second.id]).toBeUndefined();
    links.unlink(first.id,pr.resource.id,"ada");
    summaries=links.summaries();expect(summaries[first.id]?.pullRequests).toEqual({count:0,items:[]});
    store.db.close();
  });
});
