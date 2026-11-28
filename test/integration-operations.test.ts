import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { discoverLinear, LinearApiAdapter, type LinearApiConnection } from "../src/core/integrations/linear-api.js";
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
    validate:vi.fn(async()=>({state:"ready" as const})),listContainers:vi.fn(async()=>({items:[],nextCursor:null})),readContainer:vi.fn(async(id:string)=>({id,name:"team/repo",url:"https://github.com/team/repo"})),
    searchIssues:vi.fn(async()=>({items:[item],nextCursor:null})),resolve:vi.fn(async()=>item),readIssue:vi.fn(async()=>item)};
  const service=new IntegrationOperations(ws.store,{home,factories:new Map([["github:cli",()=>adapter]])});
  return {home,ws,task,service,adapter};
}

describe("shared integration operations",()=>{
  it("uses Linear UUID identity for shared linking, refresh, duplicate confirmation, local creation and private cache",async()=>{
    const {ws,home,task}=setup();
    const account="11111111-1111-4111-8111-111111111111",org="22222222-2222-4222-8222-222222222222",team="33333333-3333-4333-8333-333333333333",id="44444444-4444-4444-8444-444444444444";
    let title="Remote Linear title",identifier="ENG-12",denied=false;
    const api=vi.fn(async()=>Response.json(denied ? {errors:[{extensions:{code:"UNAUTHENTICATED"},message:"never exposed"}]} : {data:{viewer:{id:account},organization:{id:org,urlKey:"acme"},issue:{id,identifier,title,description:"Private source body",url:`https://linear.app/acme/issue/${identifier}/title`,state:{id:account,name:"Review"},team:{id:team,key:"ENG",name:"Engineering",organization:{id:org}}}}}));
    const service=new IntegrationOperations(ws.store,{home,discoverLinear:e=>discoverLinear(e,{fetch:api,credential:()=>"fixture-key"}),
      factories:new Map([["linear:api",c=>new LinearApiAdapter(c as LinearApiConnection,{fetch:api,credential:()=>"fixture-key"})]])});
    await service.execute({action:"configure",providerId:"linear",connectionId:"linear",account,scopeId:org,credentialEnv:"STAPLE_LINEAR_API_KEY"});
    const original=ws.store.getIssue(task.id);
    await service.execute({action:"link",connectionId:"linear",key:"ENG-12",containerId:team,ref:task.id,confirmed:true,actor:"ada"});
    const resource=ws.store.externalLinks().list(task.id)[0]!.resource;
    expect(resource).toMatchObject({ref:{providerId:"linear",scopeId:org,containerId:team,id},contextShared:false,body:"Private source body"});
    expect(ws.store.getIssue(task.id)).toEqual(original);
    const github=ws.store.externalLinks().remember({...item,ref:{...item.ref,kind:"pull_request"}});
    await service.execute({action:"link",resourceId:github.id,ref:task.id,confirmed:true,actor:"ada"});
    expect(service.counts()[task.id]).toEqual({issues:1,pullRequests:1});
    const second=ws.store.createIssue({title:"Second local task"});
    await service.execute({action:"link",resourceId:resource.id,ref:second.id,confirmed:true,actor:"ada"});
    expect(ws.store.externalLinks().associations(resource.id)).toHaveLength(2);
    await expect(service.execute({action:"create",resourceId:resource.id,requestKey:"retry",actor:"ada"})).rejects.toMatchObject({code:"duplicate"});
    const created=await service.execute({action:"create",resourceId:resource.id,requestKey:"retry",additionalWork:true,actor:"ada"});
    expect(await service.execute({action:"create",resourceId:resource.id,requestKey:"retry",additionalWork:true,actor:"ada"})).toEqual({...created as object,replayed:true});
    title="Renamed remote title";identifier="ENG-99";
    await service.execute({action:"refresh",connectionId:"linear",resourceId:resource.id,actor:"ada"});
    expect(ws.store.externalLinks().resource(resource.id)).toMatchObject({id:resource.id,title,key:"ENG-99"});
    expect(ws.store.getIssue(task.id)).toEqual(original);
    denied=true;
    await expect(service.execute({action:"refresh",connectionId:"linear",resourceId:resource.id,actor:"ada"})).rejects.toMatchObject({code:"auth"});
    await service.execute({action:"remove",connectionId:"linear"});
    // No connection and nothing mapped: cached context still answers, and nothing is searched live.
    expect(await service.execute({action:"search",text:"Renamed"})).toMatchObject({cached:[{item:{id:resource.id,title}}],remote:[],scope:{mode:"none"}});
    expect(JSON.stringify(service.connections.list())).not.toContain("fixture-key");
    expect(JSON.stringify(ws.store.db.prepare("SELECT * FROM external_resources").all())).not.toContain("Private source body");
    ws.store.db.close();
  });
  it("keeps connection bindings local and searches without importing or caching provider work",async()=>{
    const {ws,service,adapter,task}=setup();
    await service.execute({action:"configure",connectionId:"work",host:"github.com",account:"ada"});
    expect(await service.execute({action:"health",connectionId:"work"})).toMatchObject({health:[{connectionId:"work",state:"ready"}]});
    await service.execute({action:"map",connectionId:"work",containerId:"42",actor:"ada"});
    const result=await service.execute({action:"search",text:"search"}) as {local:unknown[];remote:unknown[]};
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
  it("links replicated URL-only references by id and cached URL without a local connection", async () => {
    const {ws,task,service}=setup();
    const reference={ref:{...item.ref,kind:"pull_request" as const},key:item.key,url:item.url.replace("issues/","pull/")};
    const resource=ws.store.externalLinks().remember(reference);
    await service.execute({action:"link",resourceId:resource.id,ref:task.id,confirmed:true,actor:"ada"});
    const other=ws.store.createIssue({title:"Another local ticket"});
    await service.execute({action:"link",url:reference.url,ref:other.id,confirmed:true,actor:"ada"});
    expect(ws.store.externalLinks().list(task.id)[0]!.resource).toMatchObject({id:resource.id,title:null,fetchedAt:null});
    expect(ws.store.externalLinks().associations(resource.id)).toHaveLength(2);
    expect(service.connections.list()).toEqual([]);
    ws.store.externalLinks().remember({...reference,ref:{...reference.ref,scopeId:"another-scope"}});
    expect(await service.execute({action:"preview",resourceId:resource.id})).toMatchObject({item:{id:resource.id}});
    await expect(service.execute({action:"preview",url:reference.url})).rejects.toThrow("Several scoped resources");
    ws.store.db.close();
  });
  it("searches the newest effective context after another device shares a newer title", async () => {
    const {ws,service}=setup();
    const resource=ws.store.externalLinks().remember({...item,title:"Old private title",fetchedAt:"2026-11-23T10:00:00Z"});
    // Simulate the shared snapshot applied from another device; retain older private cache.
    ws.store.db.prepare("UPDATE external_resources SET title=?,fetched_at=?,context_shared=1 WHERE id=?")
      .run("New shared title","2026-11-23T12:00:00Z",resource.id);
    expect(ws.store.externalLinks().resource(resource.id).title).toBe("New shared title");
    expect(await service.execute({action:"search",text:"New shared title"})).toMatchObject({cached:[{item:{id:resource.id,title:"New shared title"}}]});
    expect(await service.execute({action:"search",text:"Old private title"})).toMatchObject({cached:[]});
    ws.store.db.close();
  });
  it("refuses a Linear configure without its key on CLI and MCP, and reads cached links without one",async()=>{
    const {ws,home,task}=setup();
    const org="22222222-2222-4222-8222-222222222222",account="11111111-1111-4111-8111-111111111111";
    const source={...item,ref:{providerId:"linear",host:"linear.app",scopeId:org,containerId:"33333333-3333-4333-8333-333333333333",id:"44444444-4444-4444-8444-444444444444",kind:"issue" as const},key:"ENG-12",url:"https://linear.app/acme/issue/ENG-12/example"};
    ws.store.externalLinks().link(task.id,source,"ada");
    const dbPath=ws.dbPath;ws.store.db.close();
    // Configure reads the key, so an absent one is refused on every surface with the action health gives.
    const unset="Set STAPLE_ABSENT_TEST_KEY to a valid Linear personal API key in the environment of the Staple process, then restart it.";
    const env:NodeJS.ProcessEnv={...process.env,STAPLE_HOME:home,NODE_NO_WARNINGS:"1"};delete env.STAPLE_ABSENT_TEST_KEY;
    const cli=spawnSync(process.execPath,[TSX_CLI,CLI_ENTRY,"integrations","configure","--provider","linear","--credential-env","STAPLE_ABSENT_TEST_KEY","--connection","linear-cli","--db",dbPath,"--json"],{env,encoding:"utf8"});
    expect(cli.status).not.toBe(0);expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain("STAPLE_ABSENT_TEST_KEY isn't set where Staple runs.");expect(cli.stderr).toContain(unset);
    harness=await startMcpClient({home,cwd:home,agent:"integration-test",env:{STAPLE_DB:dbPath}});
    const refused=await harness.call("configure_integration",{action:"configure",providerId:"linear",account,scopeId:org,credentialEnv:"STAPLE_ABSENT_TEST_KEY",connectionId:"linear-mcp"});
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(unset);
    // Bindings made while the key was set stay usable for cache reads once it is gone.
    const keyed=new IntegrationOperations(null,{home,discoverLinear:async()=>({account,scopeId:org,login:"Ada",organization:"Acme"})});
    for (const connectionId of ["linear-cli","linear-mcp"]) await keyed.execute({action:"configure",providerId:"linear",credentialEnv:"STAPLE_ABSENT_TEST_KEY",connectionId});
    const health=await harness.call("integration_read",{action:"health",connectionId:"linear-mcp"});
    expect(health.structuredContent).toMatchObject({result:{health:[{connectionId:"linear-mcp",state:"unauthenticated",action:expect.stringContaining("STAPLE_ABSENT_TEST_KEY")}]}});
    const cached=await harness.call("integration_read",{action:"list",ref:task.id});
    expect(cached.structuredContent).toMatchObject({result:[{resource:{key:"ENG-12",ref:{providerId:"linear"}}}]});
    // The mapping is the same data on every surface.
    const mapping=await harness.call("integration_read",{action:"mapping",allWorkspaces:true});
    expect(mapping.structuredContent).toMatchObject({result:{workspaces:[{workspace:"integration-tests",targets:[]}],targets:[]}});
    const unmap=await harness.call("integration_write",{action:"unmap",targetKey:`linear.app/${org}/33333333-3333-4333-8333-333333333333`});
    expect(unmap.isError).toBe(true);
    const listed=spawnSync(process.execPath,[TSX_CLI,CLI_ENTRY,"integrations","mapping","--db",dbPath,"--json"],{env:{...process.env,STAPLE_HOME:home,NODE_NO_WARNINGS:"1"},encoding:"utf8"});
    expect(listed.status,listed.stderr).toBe(0);expect(JSON.parse(listed.stdout)).toEqual({workspace:"integration-tests",targets:[]});
    // Connections belong to the computer: listing them needs no workspace, even outside one.
    const outside=spawnSync(process.execPath,[TSX_CLI,CLI_ENTRY,"integrations","connections","--json"],{cwd:tmpdir(),env:{...process.env,STAPLE_HOME:home,NODE_NO_WARNINGS:"1"},encoding:"utf8"});
    expect(outside.status,outside.stderr).toBe(0);
    expect(JSON.parse(outside.stdout).connections.map((c:{id:string})=>c.id).sort()).toEqual(["linear-cli","linear-mcp"]);
    const every=spawnSync(process.execPath,[TSX_CLI,CLI_ENTRY,"integrations","mapping","--all-workspaces","--json"],{cwd:tmpdir(),env:{...process.env,STAPLE_HOME:home,NODE_NO_WARNINGS:"1"},encoding:"utf8"});
    expect(every.status,every.stderr).toBe(0);expect(JSON.parse(every.stdout).workspaces).toEqual([{workspace:"integration-tests",targets:[]}]);
    const needsOne=spawnSync(process.execPath,[TSX_CLI,CLI_ENTRY,"integrations","mapping","--json"],{cwd:tmpdir(),env:{...process.env,STAPLE_HOME:home,NODE_NO_WARNINGS:"1"},encoding:"utf8"});
    expect(needsOne.status).not.toBe(0);
  },30_000);
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
