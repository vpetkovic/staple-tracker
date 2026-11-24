import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { ExternalWork } from "../src/core/integrations/external-work.js";
import { externalItemKey } from "../src/core/integrations/provider.js";
import type { ExternalItem } from "../src/core/integrations/contracts.js";
const stores: WorkspaceStore[] = [];
afterEach(() => { for (const s of stores) s.db.close(); stores.length = 0; });
function setup() {
  const db = openDb(":memory:"); migrateWorkspace(db); const store = new WorkspaceStore(db,"test","TST"); stores.push(store);
  return { store, work: new ExternalWork(store) };
}
const source = (): ExternalItem => ({ ref: { providerId:"github",host:"github.com",scopeId:"host",containerId:"42",id:"1",kind:"issue" },
  key:"team/repo#1",url:"https://github.com/team/repo/issues/1",title:"Fix search",body:"Remote specification",status:{id:"open",name:"Open"},fetchedAt:"2026-11-23T12:00:00Z" });

describe("external work adoption", () => {
  it("previews exact source URLs and scoped origins across completed tickets, without title merging or prefix matches", () => {
    const { store, work }=setup();
    const a=store.createIssue({title:"Migrated task",description:`Source: [issue](${source().url}#comment-4)`,status:"done"});
    const b=store.createIssue({title:"Another migration",originKind:"github",originId:externalItemKey(source().ref)});
    store.createIssue({title:source().title});
    store.createIssue({title:"Wrong resource",description:source().url+"0"});
    store.createIssue({title:"Bare unscoped ID",originKind:"github",originId:"1"});
    const d=store.createIssue({title:"Source URL in origin",originKind:"github",originId:source().url});
    const c=store.createIssue({title:"Source in document"});
    store.putDocument(c.id,"migration",source().url,{author:"ada"});
    const before=store.db.prepare("SELECT * FROM external_resources").all();
    expect(work.preview(source()).candidates.map(x=>x.issue.id).sort()).toEqual([a.id,b.id,c.id,d.id].sort());
    expect(store.db.prepare("SELECT * FROM external_resources").all()).toEqual(before);
  });

  it("requires explicit adoption and leaves all local fields and queue alone", () => {
    const { store,work }=setup(); const task=store.createIssue({title:"My migrated work",description:source().url,status:"done"});
    expect(()=>work.adopt(task.id,source(),false,"ada")).toThrow(/confirm/i);
    work.adopt(task.id,source(),true,"ada");
    expect(store.getIssue(task.id)).toEqual(task);
    expect(store.externalLinks().list(task.id)).toHaveLength(1);
    expect(work.preview(source()).associations.map(x=>x.id)).toEqual([task.id]);
    expect(store.db.prepare("SELECT * FROM queue_entries").all()).toEqual([]);
  });

  it("creates local work and its link once, replays after completion or unlink, and rejects a request key used for another source", () => {
    const {store,work}=setup(); const result=work.create(source(),{requestKey:"create-1",actor:"ada"});
    expect(result.replayed).toBe(false); expect(result.link).not.toBeNull();
    expect(result.issue.description).toBe(source().body); expect(result.issue.status).toBe("backlog");
    store.updateIssue(result.issue.id,{status:"done"},"ada");
    store.externalLinks().unlink(result.issue.id,result.link!.resource.id,"ada");
    const replay=work.create({...source(),title:"Changed remote title"},{requestKey:"create-1",actor:"ada"});
    expect(replay.replayed).toBe(true); expect(replay.issue.id).toBe(result.issue.id); expect(replay.issue.title).toBe("Fix search"); expect(replay.link).toBeNull();
    expect(()=>work.create({...source(),ref:{...source().ref,id:"2"},url:"https://github.com/team/repo/issues/2"},{requestKey:"create-1",actor:"ada"})).toThrow(/another source/i);
    expect(store.db.prepare("SELECT * FROM queue_entries").all()).toEqual([]);
  });

  it("shows existing associations and migration candidates before deliberate additional work", () => {
    const {store,work}=setup(); const migrated=store.createIssue({title:"Existing migration",description:source().url});
    expect(()=>work.create(source(),{requestKey:"one",actor:"ada"})).toThrow(/existing/i);
    work.adopt(migrated.id,source(),true,"ada");
    const extra=work.create(source(),{requestKey:"two",actor:"ada",additionalWork:true,title:"Implement a separate part"});
    expect(extra.issue.id).not.toBe(migrated.id);
    expect(work.preview(source()).associations).toHaveLength(2);
  });

  it("rolls back local creation and issue numbering when the association fails", () => {
    const {store,work}=setup(); const before=store.db.prepare("SELECT * FROM meta WHERE key='next_issue_number'").get();
    expect(()=>work.create({...source(),fetchedAt:"not-a-timestamp"},{requestKey:"bad",actor:"ada"})).toThrow();
    expect(store.db.prepare("SELECT * FROM issues").all()).toEqual([]);
    expect(store.db.prepare("SELECT * FROM external_resources").all()).toEqual([]);
    expect(store.db.prepare("SELECT * FROM meta WHERE key='next_issue_number'").get()).toEqual(before);
  });

  it("never creates an execution task from a PR reference", () => {
    const {work}=setup();
    expect(()=>work.create({...source(),ref:{...source().ref,kind:"pull_request"},url:"https://github.com/team/repo/pull/1"},{requestKey:"pr",actor:"ada"})).toThrow(/reference/i);
  });
});
