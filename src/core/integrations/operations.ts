import { z } from "zod";
import type { WorkspaceStore } from "../store.js";
import { StapleError } from "../types.js";
import type { ConnectionHealthSnapshot, DetectedConnection, ExternalItem, ResolvedExternalItem, IntegrationAdapter } from "./contracts.js";
import { createGhRunner, type GhRunner } from "./gh-process.js";
import { GitHubCliAdapter, parseGhAuthStatus } from "./github-cli.js";
import { HEALTH_POLL_INTERVAL_SECONDS, healthFromError, isConnectionFailure, missingSnapshot, processCaches, snapshot, type ProbeCache } from "./health.js";
import { IntegrationConnections, type ProviderConnection } from "./connections.js";
import { ExternalWork } from "./external-work.js";
import { LinearApiAdapter } from "./linear-api.js";
import { externalResourceId, type ExternalResource } from "./link-store.js";
import { IntegrationReader } from "./provider.js";

export const INTEGRATION_READ_ACTIONS = ["connections","health","containers","search","resolve","list","preview","counts"] as const;
export const INTEGRATION_WRITE_ACTIONS = ["link","create","unlink","refresh","stack","share"] as const;
export const INTEGRATION_CONFIG_ACTIONS = ["configure","remove"] as const;
export const integrationCommandSchema = z.object({
  action:z.enum([...INTEGRATION_READ_ACTIONS,...INTEGRATION_WRITE_ACTIONS,...INTEGRATION_CONFIG_ACTIONS]),
  providerId:z.enum(["github","linear"]).optional(),scopeId:z.string().uuid().optional(),credentialEnv:z.string().max(128).optional(),key:z.string().max(128).optional(),
  connectionId:z.string().max(80).optional(),host:z.string().max(255).optional(),account:z.string().max(80).optional(),
  url:z.string().max(8192).optional(),resourceId:z.string().max(128).optional(),ref:z.string().max(512).optional(),
  text:z.string().max(2048).optional(),kind:z.enum(["issue","pull_request"]).optional(),containerId:z.string().max(512).optional(),cursor:z.string().max(8192).optional(),
  confirmed:z.boolean().optional(),force:z.boolean().optional(),additionalWork:z.boolean().optional(),requestKey:z.string().max(512).optional(),title:z.string().max(8192).optional(),
  parentResourceId:z.string().max(128).nullable().optional(),position:z.number().int().nonnegative().safe().optional(),enabled:z.boolean().optional(),actor:z.string().max(512).optional(),
}).strict();
export type IntegrationCommand = z.infer<typeof integrationCommandSchema>;
export type AdapterFactory = (connection:ProviderConnection)=>IntegrationAdapter;
const DEFAULT_FACTORIES: ReadonlyMap<string,AdapterFactory> = new Map<string,AdapterFactory>([
  ["github:cli",c=> { if(c.providerId!=="github") throw new StapleError("validation","Expected a GitHub connection"); return new GitHubCliAdapter(c); }],
  ["linear:api",c=> { if(c.providerId!=="linear") throw new StapleError("validation","Expected a Linear connection"); return new LinearApiAdapter(c); }],
]);

const DETECTION_RUNNER=createGhRunner({timeoutMs:10_000});

/** One boundary for terminal, agents and browser. Search reads never create work or persist source bodies. */
export class IntegrationOperations {
  readonly connections: IntegrationConnections;
  private readonly work: ExternalWork;
  private readonly caches: { health: ProbeCache<ConnectionHealthSnapshot>; detection: ProbeCache<Array<{host:string;login:string}>> };
  /** The connection a live read in the current command used, so its failure can update health. */
  private used: ProviderConnection | null = null;
  constructor(private readonly store:WorkspaceStore, private readonly options:{home?:string;factories?:ReadonlyMap<string,AdapterFactory>;liveReadsAvailable?:boolean;
    gh?:GhRunner;caches?:{health:ProbeCache<ConnectionHealthSnapshot>;detection:ProbeCache<Array<{host:string;login:string}>>}}={}) {
    this.connections = new IntegrationConnections(store,options.home);
    this.work = new ExternalWork(store);
    this.caches = options.caches ?? processCaches;
  }
  private reader(connectionId:string):IntegrationReader {
    const config=this.connections.list().find(c=>c.id===connectionId);
    if (!config) throw new StapleError("not_found","Configure this provider connection on the machine running Staple");
    this.used=config;
    return this.readerFor(config);
  }
  private readerFor(config:ProviderConnection):IntegrationReader {
    if (this.options.liveReadsAvailable===false) throw new StapleError("unavailable","Cached-only session. Live provider reads require a connection on the machine running Staple.");
    const factory=(this.options.factories ?? DEFAULT_FACTORIES).get(`${config.providerId}:${config.mode}`);
    if (!factory) throw new StapleError("unavailable","This provider connection mode is not installed");
    return new IntegrationReader(factory(config));
  }
  /** One binding: the workspace's connection directory and the exact connection settings. */
  private healthKey(config:ProviderConnection):string { return JSON.stringify([this.connections.directory,config]); }
  private async probe(config:ProviderConnection):Promise<ConnectionHealthSnapshot> {
    try { return snapshot(config,await this.readerFor(config).validate(),new Date()); }
    catch (error) { if (error instanceof StapleError) return snapshot(config,healthFromError(error),new Date()); throw error; }
  }
  private async health(connectionId:string|undefined,force:boolean):Promise<ConnectionHealthSnapshot[]> {
    const all=this.connections.list();
    if (connectionId!==undefined && !all.some(c=>c.id===connectionId)) return [missingSnapshot(connectionId,new Date())];
    return Promise.all(all.filter(c=>connectionId===undefined || c.id===connectionId)
      .map(c=>this.caches.health.check(this.healthKey(c),()=>this.probe(c),force)));
  }
  /** Accounts gh is already signed in to on this machine. A missing or failing gh detects nothing. */
  private async detect(connections:ProviderConnection[]):Promise<DetectedConnection[]> {
    if (this.options.liveReadsAvailable===false) return [];
    const run=this.options.gh ?? DETECTION_RUNNER;
    const accounts=await this.caches.detection.check("gh",async()=> {
      try { return parseGhAuthStatus(await run({kind:"auth-status"})); }
      catch (error) { if (error instanceof StapleError) return []; throw error; }
    });
    return accounts.map(a=>({providerId:"github" as const,host:a.host,login:a.login,
      configuredConnectionId:connections.find(c=>c.providerId==="github" && c.host===a.host && c.account.toLowerCase()===a.login.toLowerCase())?.id ?? null}));
  }
  private select(c:IntegrationCommand, host:string,providerId?:string,scopeId?:string):string {
    if (c.connectionId) return c.connectionId;
    const choices=this.connections.list().filter(x=>x.host===host && (!providerId || x.providerId===providerId) && (x.providerId!=="linear" || !scopeId || x.scopeId===scopeId));
    if (choices.length!==1) throw new StapleError("unavailable",choices.length ? "Choose which provider connection to use" : "Cached-only session. Configure a connection for live reads in Settings > Integrations.");
    return choices[0]!.id;
  }
  private async source(c:IntegrationCommand):Promise<ExternalResource|ExternalItem|ResolvedExternalItem> {
    if (c.resourceId) return storedSource(this.store.externalLinks().resource(c.resourceId));
    if (c.key) {
      const reader=this.reader(need(c.connectionId,"connection"));
      const resolved=await reader.resolve({key:c.key,containerId:need(c.containerId,"container")});
      if(!resolved) throw new StapleError("not_found","No accessible issue was found for this identifier");
      return reader.read(resolved.ref);
    }
    const url=need(c.url,"source URL");
    let parsed:URL;
    try { parsed=new URL(url); } catch { throw new StapleError("validation","Use an exact HTTPS issue or PR URL"); }
    if (parsed.protocol!=="https:" || parsed.username || parsed.password) throw new StapleError("validation","Use an HTTPS source URL without credentials");
    parsed.hash="";
    const cached=this.store.db.prepare("SELECT id FROM external_resources WHERE url=? LIMIT 2").all(parsed.href) as Array<{id:string}>;
    // A pasted cached URL remains usable without a machine connection.
    if(cached.length>1 && !c.connectionId) throw new StapleError("conflict","Several scoped resources use this URL. Choose a resource or connection explicitly.");
    if (cached.length===1 && !c.connectionId) return storedSource(this.store.externalLinks().resource(cached[0]!.id));
    const reader=this.reader(this.select(c,parsed.host));
    const resolved=await reader.resolve({url:parsed.href});
    if (!resolved) throw new StapleError("not_found","No accessible issue or PR was found at this URL");
    return resolved.ref.kind==="pull_request" && !reader.capabilities.readPullRequests ? resolved:reader.read(resolved.ref);
  }
  counts():Record<string,{issues:number;pullRequests:number}> {
    const rows=this.store.db.prepare(`SELECT l.issue_id,r.kind,COUNT(*) AS n FROM external_links l
      JOIN external_resources r ON r.id=l.resource_id GROUP BY l.issue_id,r.kind`).all() as Array<{issue_id:string;kind:string;n:number}>;
    const result:Record<string,{issues:number;pullRequests:number}>={};
    for(const row of rows) {
      const entry=result[row.issue_id] ??= {issues:0,pullRequests:0};
      if(row.kind==="issue") entry.issues=row.n; else entry.pullRequests=row.n;
    }
    return result;
  }
  async execute(raw:unknown):Promise<unknown> {
    this.used=null;
    try {
      const result=await this.run(raw);
      // A live read through the connection succeeded, so a cached failure is out of date.
      if (this.used && this.caches.health.peek(this.healthKey(this.used))?.state!=="ready") this.caches.health.delete(this.healthKey(this.used));
      return result;
    } catch (error) {
      if (this.used && isConnectionFailure(error)) this.caches.health.record(this.healthKey(this.used),snapshot(this.used,healthFromError(error),new Date()));
      throw error;
    }
  }
  private async run(raw:unknown):Promise<unknown> {
    const parsed=integrationCommandSchema.safeParse(raw);
    if(!parsed.success) throw new StapleError("validation", "Invalid integration command: " + parsed.error.issues.map(i=>`${i.path.join(".") || "command"}: ${i.message}`).join("; "));
    const c=parsed.data;
    const actor=()=>need(c.actor,"actor");
    switch(c.action) {
      case "connections": {
        const connections=this.connections.list();
        return {connections:connections.map(connection=>({...connection,health:this.caches.health.peek(this.healthKey(connection))})),
          detected:await this.detect(connections),pollIntervalSeconds:HEALTH_POLL_INTERVAL_SECONDS,
          execution:this.options.liveReadsAvailable===false ? "cached_only":"local",counts:this.counts()};
      }
      case "configure":
        if(c.providerId === "linear") return this.connections.save({id:c.connectionId,providerId:"linear",mode:"api",host:"linear.app",
          account:need(c.account,"expected Linear user UUID"),scopeId:need(c.scopeId,"Linear organization UUID"),credentialEnv:need(c.credentialEnv,"credential environment variable name")});
        return this.connections.save({id:c.connectionId,providerId:"github",mode:"cli",host:need(c.host,"GitHub host").toLowerCase(),account:need(c.account,"expected gh account")});
      case "remove": this.connections.remove(need(c.connectionId,"connection")); return {removed:true};
      case "health": return {health:await this.health(c.connectionId,c.force===true),pollIntervalSeconds:HEALTH_POLL_INTERVAL_SECONDS};
      case "containers": return this.reader(need(c.connectionId,"connection")).listContainers(c.cursor);
      case "counts": return this.counts();
      case "list": return this.store.externalLinks().list(need(c.ref,"local ticket"));
      case "resolve": return this.source(c);
      case "preview": { const item=await this.source(c); return {item,...this.work.preview(item)}; }
      case "search": {
        const text=c.text?.trim() ?? "";
        const local=this.store.listIssues({includeResolved:true}).filter(i=>`${i.identifier} ${i.title}`.toLowerCase().includes(text.toLowerCase())).slice(0,50);
        const rows=this.store.db.prepare(`SELECT r.id FROM external_resources r LEFT JOIN external_private_cache p ON p.resource_id=r.id WHERE r.kind=? AND
          (instr(lower(COALESCE(CASE WHEN p.fetched_at IS NOT NULL AND (r.fetched_at IS NULL OR p.fetched_at>=r.fetched_at) THEN p.title ELSE r.title END,'')),lower(?))>0 OR instr(lower(r.display_key),lower(?))>0) LIMIT 50`).all(c.kind ?? "issue",text,text) as Array<{id:string}>;
        const cached=rows.map(r=>this.decorate(this.store.externalLinks().resource(r.id)));
        if (!c.connectionId) return {local,counts:this.counts(),cached,remote:[],nextCursor:null,execution:"cached_only"};
        const page=await this.reader(c.connectionId).search(c.kind ?? "issue",{text,containerId:c.containerId,cursor:c.cursor});
        return {local,counts:this.counts(),cached,remote:page.items.map(item=>this.decorate(item)),nextCursor:page.nextCursor,execution:"local"};
      }
      case "link": return this.work.adopt(need(c.ref,"local ticket"),await this.source(c),c.confirmed===true,actor());
      case "create": {
        const item=await this.source(c);
        if (!("title" in item) || item.title===null || item.fetchedAt===null) throw new StapleError("unavailable","Read source context before creating local work");
        return this.work.create(item as ExternalItem,{requestKey:need(c.requestKey,"retry request key"),actor:actor(),additionalWork:c.additionalWork,title:c.title});
      }
      case "unlink": this.store.externalLinks().unlink(need(c.ref,"local ticket"),need(c.resourceId,"resource"),actor()); return {unlinked:true};
      case "refresh": {
        const held=this.store.externalLinks().resource(need(c.resourceId,"resource"));
        const item=await this.reader(this.select(c,held.ref.host,held.ref.providerId,held.ref.scopeId)).read(held.ref);
        return this.store.externalLinks().remember(item,actor());
      }
      case "share": {
        if(c.enabled===undefined) throw new StapleError("validation","Choose whether to share source context");
        return this.store.externalLinks().shareContext(need(c.resourceId,"resource"),c.enabled,actor());
      }
      case "stack": {
        if(c.parentResourceId===undefined || c.position===undefined) throw new StapleError("validation","Choose a PR parent or null and an order");
        return this.store.externalLinks().setStack(need(c.ref,"local ticket"),need(c.resourceId,"resource"),{parentResourceId:c.parentResourceId,position:c.position},actor());
      }
    }
  }
  private decorate(item:ExternalItem|ExternalResource) {
    return {item,associations:this.store.externalLinks().associations(externalResourceId(item.ref))};
  }
}
function need(value:string|undefined,label:string):string {
  if(!value?.trim()) throw new StapleError("validation",`This integration operation needs a ${label}`);
  return value;
}

/** Replicated references may have no consented context on this machine. */
function storedSource(resource: ExternalResource): ExternalResource | (ResolvedExternalItem & Pick<ExternalResource, "id">) {
  return resource.fetchedAt === null || resource.title === null
    ? { id: resource.id, ref: resource.ref, key: resource.key, url: resource.url }
    : resource;
}
