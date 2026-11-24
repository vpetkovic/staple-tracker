import { describe, expect, it, vi } from "vitest";
import { LinearApiAdapter, type LinearApiConnection } from "../src/core/integrations/linear-api.js";
import { IntegrationReader } from "../src/core/integrations/provider.js";
const account = "11111111-1111-4111-8111-111111111111";
const org = "22222222-2222-4222-8222-222222222222";
const teamId = "33333333-3333-4333-8333-333333333333";
const issueId = "44444444-4444-4444-8444-444444444444";
const other = "55555555-5555-4555-8555-555555555555";
const config: LinearApiConnection = { id:"linear-work", providerId:"linear", mode:"api", host:"linear.app", account, scopeId:org, credentialEnv:"STAPLE_LINEAR_API_KEY" };
const identity = { viewer:{id:account,name:"Ada Lovelace"},organization:{id:org,urlKey:"acme",name:"Acme"} };
const team = { id:teamId,key:"ENG",name:"Engineering",organization:{id:org} };
const issue = { id:issueId,identifier:"ENG-12",title:"Issue title",description:"Source context",url:"https://linear.app/acme/issue/ENG-12/issue-title",state:{id:other,name:"In review"},team };
const pageInfo = {hasNextPage:false,endCursor:null};
function setup(respond: (body: {query:string;variables:Record<string,unknown>}) => Record<string, unknown> = () => ({issue})) {
  const fetch = vi.fn(async (_url: unknown, request: RequestInit | undefined) => {
    const body = JSON.parse(request!.body as string);
    return Response.json({data:{...identity,...respond(body)}});
  });
  const adapter = new LinearApiAdapter(config,{fetch:fetch as typeof globalThis.fetch,credential:()=>"fixture-key",now:()=>new Date("2026-11-23T12:00:00Z")});
  return {adapter,fetch,reader:new IntegrationReader(adapter)};
}
describe("read-only Linear API adapter",()=>{
  it("discovers teams, searches with variables, and uses immutable scoped UUIDs and native states",async()=>{
    const {reader,fetch}=setup(body=>body.query.includes("teams(") ? {teams:{nodes:[team],pageInfo}}
      : {searchIssues:{nodes:[issue],pageInfo}});
    expect(await reader.validate()).toEqual({state:"ready",identity:{login:"Ada Lovelace",organization:"Acme"}});
    expect(await reader.listContainers()).toMatchObject({items:[{id:teamId,name:"Engineering (ENG)"}]});
    const result=await reader.search("issue",{text:'title "quoted"',containerId:teamId});
    expect(result.items[0]).toMatchObject({ref:{providerId:"linear",host:"linear.app",scopeId:org,containerId:teamId,id:issueId,kind:"issue"},status:{name:"In review"},body:"Source context"});
    const [url,request]=fetch.mock.calls.at(-1)!;
    expect(url).toBe("https://api.linear.app/graphql");
    expect(request).toMatchObject({method:"POST",redirect:"error",headers:{authorization:"fixture-key"}});
    const body=JSON.parse(request!.body as string);
    expect(body.variables).toMatchObject({text:'title "quoted"',team:teamId});
    expect(body.query).not.toContain("quoted");
    expect(fetch.mock.calls.every(([,r])=>!String(r?.body).includes("mutation"))).toBe(true);
    expect(reader.capabilities).toEqual({readPullRequests:false,searchPullRequests:false});
    await expect(reader.search("pull_request",{text:""})).rejects.toMatchObject({code:"protocol_unsupported"});
  });
  it("normalizes equivalent uppercase configured and returned UUIDs",async()=>{
    const account="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",scopeId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fetch=vi.fn(async()=>Response.json({data:{viewer:{id:account},organization:{id:scopeId.toUpperCase(),urlKey:"acme"}}}));
    const adapter=new LinearApiAdapter({...config,account:account.toUpperCase(),scopeId:scopeId.toUpperCase()},{fetch,credential:()=>"fixture"});
    expect(adapter.scope.scopeId).toBe(scopeId);
    expect(await adapter.validate()).toMatchObject({state:"ready"});
  });
  it("browses issues with an empty search and team filter",async()=>{
    const {reader,fetch}=setup(()=>({issues:{nodes:[issue],pageInfo}}));
    expect((await reader.search("issue",{text:"",containerId:teamId})).items).toHaveLength(1);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).variables.filter).toEqual({team:{id:{eq:teamId}}});
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).query).toContain("orderBy: updatedAt");
  });
  it("lists and reads projects and teams, and scopes search to a project whatever the issue's team",async()=>{
    const projectId="66666666-6666-4666-8666-666666666666";
    const proj={id:projectId,name:"Launch",url:"https://linear.app/acme/project/launch-abc"};
    const {reader,fetch}=setup(body=>body.query.includes("projects(") ? {projects:{nodes:[proj],pageInfo}}
      : body.query.includes("project(id:") ? {project:proj} : body.query.includes("team(id:") ? {team}
      : body.query.includes("searchIssues(") ? {searchIssues:{nodes:[{...issue,project:{id:projectId}}],pageInfo}} : {issues:{nodes:[{...issue,project:{id:projectId}}],pageInfo}});
    expect(await reader.listProjects()).toEqual({items:[{id:projectId,name:"Launch",url:proj.url}],nextCursor:null});
    expect(await reader.readContainer(projectId,"project")).toEqual({id:projectId,name:"Launch",url:proj.url});
    expect(await reader.readContainer(teamId,"team")).toMatchObject({id:teamId,name:"Engineering (ENG)"});
    expect((await reader.search("issue",{text:"title",projectId})).items).toHaveLength(1);
    const typed=JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string);
    expect(typed.query).toContain("filter: $filter");
    expect(typed.variables.filter).toEqual({project:{id:{eq:projectId}}});
    await reader.search("issue",{text:"",projectId});
    expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string).variables.filter).toEqual({project:{id:{eq:projectId}}});
    const elsewhere=setup(()=>({searchIssues:{nodes:[{...issue,project:null}],pageInfo}}));
    await expect(elsewhere.reader.search("issue",{text:"title",projectId})).rejects.toMatchObject({code:"unavailable"});
  });
  it("resolves exact URLs and scoped identifiers, retaining UUID identity after display changes",async()=>{
    let current=issue;
    const {reader,fetch}=setup(()=>({issue:current}));
    const resolved=await reader.resolve({url:issue.url+"?utm_source=fixture#details"});
    expect(resolved!.ref.id).toBe(issueId);
    expect(await reader.resolve({key:"ENG-12",containerId:teamId})).toEqual(resolved);
    current={...issue,identifier:"ENG-99",url:"https://linear.app/acme/issue/ENG-99/renamed",title:"Renamed"};
    expect(await reader.read(resolved!.ref)).toMatchObject({ref:resolved!.ref,key:"ENG-99",title:"Renamed"});
    expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string).variables.id).toBe(issueId);
    await expect(reader.resolve({key:"ENG-99",containerId:other})).rejects.toMatchObject({code:"validation"});
    await expect(reader.resolve({url:"https://linear.app/other/issue/ENG-99/renamed"})).rejects.toMatchObject({code:"validation"});
  });
  it("refuses foreign users, organizations, teams, IDs and unexpected provider URLs",async()=>{
    const wrongUser=setup(()=>({viewer:{id:other,name:"Grace Hopper"},issue}));
    expect(await wrongUser.adapter.validate()).toEqual({state:"account_mismatch",identity:{login:"Grace Hopper"},
      message:"The API key in STAPLE_LINEAR_API_KEY belongs to Grace Hopper, not the Linear user this connection expects."});
    await expect(wrongUser.reader.read({...config,providerId:"linear",containerId:teamId,id:issueId,kind:"issue",scopeId:org})).rejects.toMatchObject({code:"auth"});
    const wrongOrg=setup(()=>({organization:{id:other,urlKey:"other"},issue}));
    await expect(wrongOrg.reader.resolve({url:issue.url})).rejects.toMatchObject({code:"forbidden"});
    const wrongTeam=setup(()=>({issue:{...issue,team:{...team,organization:{id:other}}}}));
    await expect(wrongTeam.reader.resolve({url:issue.url})).rejects.toMatchObject({code:"forbidden"});
    const moved=setup(()=>({issue:{...issue,team:{...team,id:other}}}));
    await expect(moved.reader.read({providerId:"linear",host:"linear.app",scopeId:org,containerId:teamId,id:issueId,kind:"issue"})).rejects.toMatchObject({code:"unavailable"});
    const badUrl=setup(()=>({issue:{...issue,url:"https://evil.test/acme/issue/ENG-12"}}));
    await expect(badUrl.reader.resolve({url:issue.url})).rejects.toMatchObject({code:"unavailable"});
    const {reader,fetch}=setup();
    for(const url of ["https://evil.test/acme/issue/ENG-12","https://user:secret@linear.app/acme/issue/ENG-12",issue.url+"?token=secret"]) await expect(reader.resolve({url})).rejects.toMatchObject({code:"validation"});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("binds cursors to query, team, connection, user and organization and rejects stalled pages",async()=>{
    const {reader,fetch}=setup(()=>({searchIssues:{nodes:[issue],pageInfo:{hasNextPage:true,endCursor:"opaque"}}}));
    const first=await reader.search("issue",{text:"title",containerId:teamId});
    await expect(reader.search("issue",{text:"changed",containerId:teamId,cursor:first.nextCursor!})).rejects.toMatchObject({code:"cursor_invalid"});
    await expect(reader.search("issue",{text:"title",containerId:other,cursor:first.nextCursor!})).rejects.toMatchObject({code:"cursor_invalid"});
    const different=new LinearApiAdapter({...config,id:"other"},{fetch:fetch as typeof globalThis.fetch,credential:()=>"fixture"});
    await expect(different.searchIssues({text:"title",containerId:teamId,cursor:first.nextCursor!})).rejects.toMatchObject({code:"cursor_invalid"});
    await expect(reader.search("issue",{text:"title",containerId:teamId,cursor:first.nextCursor!})).rejects.toThrow("pagination");
    expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string).variables.after).toBe("opaque");
  });
  it.each([[401,"auth"],[403,"forbidden"],[429,"rate_limited"],[500,"unavailable"]])("redacts HTTP %s failures",async(status,code)=>{
    const adapter=new LinearApiAdapter(config,{credential:()=>"fixture-key",fetch:vi.fn(async()=>new Response("fixture-key private provider details",{status}))});
    await expect(adapter.listContainers()).rejects.toMatchObject({code});
    try { await adapter.listContainers(); } catch(e) { expect(String(e)).not.toMatch(/fixture-key|private provider/); }
  });
  it.each([["UNAUTHENTICATED","auth"],["FORBIDDEN","forbidden"],["RATELIMITED","rate_limited"],["ENTITY_NOT_FOUND","not_found"],["INTERNAL_SERVER_ERROR","unavailable"]])("redacts GraphQL %s failures and refuses partial results",async(providerCode,code)=>{
    const adapter=new LinearApiAdapter(config,{credential:()=>"fixture-key",fetch:vi.fn(async()=>Response.json({data:{...identity,issue},errors:[{message:"fixture-key private details",extensions:{code:providerCode}}]}))});
    await expect(adapter.readIssue({providerId:"linear",host:"linear.app",scopeId:org,containerId:teamId,id:issueId,kind:"issue"})).rejects.toMatchObject({code});
    if(code==="not_found") expect(await adapter.resolve({url:issue.url})).toBeNull();
  });
  it.each([["authentication error","auth"],["forbidden","forbidden"],["ratelimited","rate_limited"],["entity not found","not_found"]])("handles Linear SDK GraphQL type %s without a code",async(type,code)=>{
    const adapter=new LinearApiAdapter(config,{credential:()=>"fixture-key",fetch:vi.fn(async()=>Response.json({errors:[{message:"fixture-key private details",extensions:{type}}]}))});
    await expect(adapter.listContainers()).rejects.toMatchObject({code});
    if(code==="auth") expect(await adapter.validate()).toMatchObject({state:"unauthenticated"});
  });
  it("aborts a stalled request at its deadline without exposing transport details",async()=>{
    const timeout=AbortSignal.timeout;
    const spy=vi.spyOn(AbortSignal,"timeout").mockImplementation(()=>timeout(5));
    const fetch: typeof globalThis.fetch=async(_url,request)=>new Promise((_resolve,reject)=>{
      request!.signal!.addEventListener("abort",()=>reject(new Error("fixture-key transport details")),{once:true});
    });
    try {
      const adapter=new LinearApiAdapter(config,{credential:()=>"fixture-key",fetch});
      await expect(adapter.listContainers()).rejects.toMatchObject({code:"offline",message:"Linear request timed out; try again later"});
      expect(spy).toHaveBeenCalledWith(15_000);
    } finally { spy.mockRestore(); }
  });
  it("does not send requests without credentials, redacts network errors, bounds bytes and honors cancellation",async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>();
    const missing=new LinearApiAdapter(config,{credential:()=>undefined,fetch});
    // The message states the problem and names the variable; what to do is the health snapshot's action.
    expect(await missing.validate()).toEqual({state:"unauthenticated",message:"STAPLE_LINEAR_API_KEY isn't set where Staple runs."});expect(fetch).not.toHaveBeenCalled();
    fetch.mockRejectedValue(new Error("fixture-key network details"));
    const adapter=new LinearApiAdapter(config,{credential:()=>"fixture-key",fetch});
    await expect(adapter.listContainers()).rejects.toMatchObject({code:"offline",message:"Cannot reach Linear; check this machine's network connection"});
    fetch.mockResolvedValue(new Response("x".repeat(2_000_001)));
    await expect(adapter.listContainers()).rejects.toThrow("too large");
    fetch.mockResolvedValue(Response.json({data:{...identity,teams:{nodes:[],pageInfo:{hasNextPage:true,endCursor:null}}}}));
    await expect(adapter.listContainers()).rejects.toThrow("pagination");
    const signal=AbortSignal.abort(new Error("cancelled"));
    await expect(adapter.listContainers(undefined,{signal})).rejects.toThrow("cancelled");
  });
});
