import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import type { ExternalItem, IntegrationAdapter } from "../src/core/integrations/contracts.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { asForeignPage } from "./fixtures/foreign-page.js";
import { startMcpClient, TSX_CLI, CLI_ENTRY, type McpHarness } from "./fixtures/contract-support.js";
const item:ExternalItem={ref:{providerId:"github",host:"github.com",scopeId:"host",containerId:"42",id:"1",kind:"issue"},
  key:"team/repo#1",url:"https://github.com/team/repo/issues/1",title:"Remote search",body:"Source body",status:{id:"open",name:"Open"},fetchedAt:"2026-11-23T12:00:00Z"};
let ui:UiHandle|undefined, harness:McpHarness|undefined;
const dirs:string[]=[];
const previous=process.env.STAPLE_HOME;
afterEach(async()=>{await harness?.close();harness=undefined;ui?.close();ui=undefined;for(const p of dirs)rmSync(p,{recursive:true,force:true});dirs.length=0;if(previous===undefined)delete process.env.STAPLE_HOME;else process.env.STAPLE_HOME=previous;});
function setup() {
  const home=mkdtempSync(join(tmpdir(),"staple-integration-ops-"));dirs.push(home);process.env.STAPLE_HOME=home;
  const ws=initWorkspace({global:true,slug:"integration-tests"});
  const task=ws.store.createIssue({title:"Local search"});
  const adapter:IntegrationAdapter={scope:{providerId:"github",host:"github.com",scopeId:"host"},label:"GitHub",connection:{id:"work",mode:"cli"},
    validate:vi.fn(async()=>({state:"ready" as const})),listContainers:vi.fn(async()=>({items:[],nextCursor:null})),
    searchIssues:vi.fn(async()=>({items:[item],nextCursor:null})),resolve:vi.fn(async()=>item),readIssue:vi.fn(async()=>item)};
  const service=new IntegrationOperations(ws.store,{home,factories:new Map([["github:cli",()=>adapter]])});
  return {home,ws,task,service,adapter};
}

describe("shared integration operations",()=>{
  it("keeps connection bindings local and searches without importing or caching provider work",async()=>{
    const {ws,service,adapter,task}=setup();
    await service.execute({action:"configure",connectionId:"work",host:"github.com",account:"ada"});
    expect(await service.execute({action:"health",connectionId:"work"})).toMatchObject({state:"ready" as const});
    const result=await service.execute({action:"search",connectionId:"work",text:"search"}) as {local:unknown[];remote:unknown[]};
    expect(result.local).toHaveLength(1);expect(result.remote).toHaveLength(1);
    expect(ws.store.db.prepare("SELECT * FROM external_resources").all()).toEqual([]);
    expect(ws.store.listIssues({includeResolved:true}).map(i=>i.id)).toEqual([task.id]);
    expect(JSON.stringify(ws.store.db.prepare("SELECT * FROM meta").all())).not.toContain('"account"');
    await expect(service.execute({action:"configure",host:"github.com",account:"ada",token:"must-not-persist"})).rejects.toThrow();
    await expect(service.execute({action:"resolve",connectionId:"work",url:"https://untrusted.example/issues/1"})).rejects.toThrow();
    expect(adapter.resolve).not.toHaveBeenCalled();ws.store.db.close();
  });
  it("links through the same matching service, serves private cache locally, and retains context after a failed refresh",async()=>{
    const {ws,service,adapter,task,home}=setup();
    await service.execute({action:"configure",connectionId:"work",host:"github.com",account:"ada"});
    await service.execute({action:"link",connectionId:"work",url:item.url,ref:task.id,confirmed:true,actor:"ada"});
    const resource=ws.store.externalLinks().list(task.id)[0]!.resource;
    expect(service.counts()[task.id]).toEqual({issues:1,pullRequests:0});
    vi.mocked(adapter.readIssue).mockRejectedValue(new Error("offline"));
    await expect(service.execute({action:"refresh",connectionId:"work",resourceId:resource.id,actor:"ada"})).rejects.toThrow("offline");
    expect(ws.store.externalLinks().resource(resource.id).body).toBe(item.body);
    const offline=new IntegrationOperations(ws.store,{home,liveReadsAvailable:false});
    expect(await offline.execute({action:"resolve",url:item.url})).toMatchObject({id:resource.id,title:item.title});
    expect(await offline.execute({action:"search",text:"Remote"})).toMatchObject({cached:[{item:{id:resource.id}}],execution:"cached_only"});
    expect(adapter.readIssue).toHaveBeenCalledTimes(2);ws.store.db.close();
  });
  it("exposes the same cached links over HTTP, CLI and MCP and enforces HTTP method/action/origin boundaries",async()=>{
    const {ws,home,task}=setup();
    const resource=ws.store.externalLinks().remember(item);const dbPath=ws.dbPath;ws.store.db.close();
    ui=startUiServer({port:0,hub:false,db:dbPath});await once(ui.server,"listening");
    const origin=`http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
    const call=async(path:string,body:unknown,foreign=false)=>fetch(origin+path,{method:"POST",headers:asForeignPage({"content-type":"application/json","x-staple-token":ui!.token,origin:foreign ? "https://foreign.test":origin},origin),body:JSON.stringify(body)});
    expect((await fetch(origin+"/api/integrations/write",{headers:{"x-staple-token":ui.token}})).status).toBe(405);
    expect((await call("/api/integrations/read",{action:"link",resourceId:resource.id,ref:task.id,confirmed:true})).status).toBe(409);
    expect((await call("/api/integrations/write",{action:"link",resourceId:resource.id,ref:task.id,confirmed:true},true)).status).toBe(403);
    expect((await call("/api/integrations/configure",{action:"configure",host:"github.com",account:"invalid account"})).status).toBe(409);
    const beforePoll=await fetch(origin+"/api/poll",{headers:{"x-staple-token":ui.token}}).then(r=>r.json());
    const linked=await call("/api/integrations/write",{action:"link",resourceId:resource.id,ref:task.id,confirmed:true});expect(linked.status).toBe(200);
    const afterPoll=await fetch(origin+"/api/poll",{headers:{"x-staple-token":ui.token}}).then(r=>r.json());
    expect(afterPoll.fingerprint).not.toBe(beforePoll.fingerprint);
    const cli=spawnSync(process.execPath,[TSX_CLI,CLI_ENTRY,"integrations","list","--ref",task.id,"--db",dbPath,"--json"],{env:{...process.env,STAPLE_HOME:home,NODE_NO_WARNINGS:"1"},encoding:"utf8"});
    expect(cli.status,cli.stderr).toBe(0);expect(JSON.parse(cli.stdout)[0].resource.id).toBe(resource.id);
    harness=await startMcpClient({home,cwd:home,agent:"integration-test",env:{STAPLE_DB:dbPath}});
    const result=await harness.call("integration_read",{action:"list",ref:task.id});
    expect(result.isError).not.toBe(true);expect(result.structuredContent).toMatchObject({result:[{resource:{id:resource.id}}]});
    const wrongWorkspace=await harness.call("integration_read",{action:"counts",ws:"not-registered"});expect(wrongWorkspace.isError).toBe(true);
  },30_000);
});
