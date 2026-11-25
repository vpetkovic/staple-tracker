import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStore } from "../store.js";
import { StapleError } from "../types.js";
import type { ConnectionHealthSnapshot, ConnectionState, ContainerKind, DetectedConnection, ExternalContainer, ExternalItem, ExternalPage, ResolvedExternalItem, IntegrationAdapter } from "./contracts.js";
import { AzureDevOpsApiAdapter, discoverAzureDevOps, listAzureDevOpsOrganizations, type AzureDevOpsIdentity, type AzureDevOpsOrganization } from "./azure-devops-api.js";
import { canonicalAzureDevOpsUrl, isServices, isWorkItemUrl, placeNameOf, placeProblem, servesUrl, SERVICES_HOST } from "./azure-devops-url.js";
import { createGhRunner, type GhRunner } from "./gh-process.js";
import { GitHubCliAdapter, parseGhAuthStatus } from "./github-cli.js";
import { HEALTH_POLL_INTERVAL_SECONDS, healthFromError, isConnectionFailure, missingSnapshot, processCaches, snapshot, type ProbeCache } from "./health.js";
import { IntegrationConnections, type ProviderConnection } from "./connections.js";
import { present, resolveScope, storedMapping, TargetNames, writeMapping, type MappingTarget, type SearchScope, type WorkspaceHandle } from "./mapping.js";
import { MAPPING_LIMIT, targetKey, type StoredTarget } from "./mapping-format.js";
import { ExternalWork } from "./external-work.js";
import { LinearApiAdapter } from "./linear-api.js";
import { externalResourceId, type ExternalResource } from "./link-store.js";
import { IntegrationReader } from "./provider.js";

export const INTEGRATION_READ_ACTIONS = ["connections","health","containers","search","resolve","list","preview","counts","mapping","organizations"] as const;
export const INTEGRATION_WRITE_ACTIONS = ["link","create","unlink","refresh","stack","share","map","unmap"] as const;
export const INTEGRATION_CONFIG_ACTIONS = ["configure","remove"] as const;
export const integrationCommandSchema = z.object({
  action:z.enum([...INTEGRATION_READ_ACTIONS,...INTEGRATION_WRITE_ACTIONS,...INTEGRATION_CONFIG_ACTIONS]),
  providerId:z.enum(["github","linear","azure_devops"]).optional(),organization:z.string().max(64).optional(),scopeId:z.string().uuid().optional(),credentialEnv:z.string().max(128).optional(),key:z.string().max(128).optional(),
  connectionId:z.string().max(80).optional(),host:z.string().max(255).optional(),account:z.string().max(80).optional(),
  url:z.string().max(8192).optional(),resourceId:z.string().max(128).optional(),ref:z.string().max(512).optional(),
  text:z.string().max(2048).optional(),kind:z.enum(["issue","pull_request"]).optional(),containerId:z.string().max(512).optional(),cursor:z.string().max(8192).optional(),
  confirmed:z.boolean().optional(),force:z.boolean().optional(),allWorkspaces:z.boolean().optional(),containerKind:z.enum(["repository","team","project"]).optional(),
  targetKey:z.string().max(300).optional(),containerKey:z.string().max(300).optional(),additionalWork:z.boolean().optional(),requestKey:z.string().max(512).optional(),title:z.string().max(8192).optional(),
  parentResourceId:z.string().max(128).nullable().optional(),position:z.number().int().nonnegative().safe().optional(),enabled:z.boolean().optional(),actor:z.string().max(512).optional(),
}).strict();
export type IntegrationCommand = z.infer<typeof integrationCommandSchema>;
export type AdapterFactory = (connection:ProviderConnection)=>IntegrationAdapter;
const DEFAULT_FACTORIES: ReadonlyMap<string,AdapterFactory> = new Map<string,AdapterFactory>([
  ["github:cli",c=> { if(c.providerId!=="github") throw new StapleError("validation","Expected a GitHub connection"); return new GitHubCliAdapter(c); }],
  ["linear:api",c=> { if(c.providerId!=="linear") throw new StapleError("validation","Expected a Linear connection"); return new LinearApiAdapter(c); }],
  ["azure_devops:api",c=> { if(c.providerId!=="azure_devops") throw new StapleError("validation","Expected an Azure DevOps connection"); return new AzureDevOpsApiAdapter(c); }],
]);
/** The one kind of container each provider maps by default; Linear can also map projects. */
const CONTAINER_KIND:Record<ProviderConnection["providerId"],ContainerKind>={github:"repository",linear:"team",azure_devops:"project"};

const DETECTION_RUNNER=createGhRunner({timeoutMs:10_000});

/** One boundary for terminal, agents and browser. Search reads never create work or persist source bodies. */
export class IntegrationOperations {
  readonly connections: IntegrationConnections;
  private readonly caches: { health: ProbeCache<ConnectionHealthSnapshot>; detection: ProbeCache<Array<{host:string;login:string}>> };
  /** The connection a live read in the current command used, so its failure can update health. */
  private used: ProviderConnection | null = null;
  private readonly names: TargetNames;
  constructor(private readonly workspaceStore:WorkspaceStore|null, private readonly options:{home?:string;factories?:ReadonlyMap<string,AdapterFactory>;liveReadsAvailable?:boolean;
    gh?:GhRunner;caches?:{health:ProbeCache<ConnectionHealthSnapshot>;detection:ProbeCache<Array<{host:string;login:string}>>};
    /** Reads which user and organization an Azure DevOps token belongs to, when configure is not told. */
    discoverAzureDevOps?:(organization:string,credentialEnv:string,host:string)=>Promise<AzureDevOpsIdentity>;
    /** Lists the Azure DevOps organizations (or Server collections) a token can reach, for the connection form. */
    listAzureDevOpsOrganizations?:(credentialEnv:string,host:string)=>Promise<AzureDevOpsOrganization[]>;
    /** Every workspace on this machine, for All workspaces and for unmapped workspaces. Defaults to this one. */
    workspaces?:()=>WorkspaceHandle[]}={}) {
    this.connections = new IntegrationConnections(options.home);
    this.names = new TargetNames(`${this.connections.directory}/names`);
    this.caches = options.caches ?? processCaches;
  }
  /** Connections, health and containers belong to the computer; everything else needs a workspace. */
  private get store():WorkspaceStore {
    if (!this.workspaceStore) throw new StapleError("validation","This integration operation needs a workspace; pass --ws or run it inside one");
    return this.workspaceStore;
  }
  private workspaces():WorkspaceHandle[] {
    return this.options.workspaces?.() ?? [{slug:this.store.slug,store:this.store}];
  }
  private scope(c:IntegrationCommand):SearchScope {
    return resolveScope({slug:this.store.slug,store:this.store},this.workspaces(),c.allWorkspaces===true,this.connections.list(),this.names);
  }
  private reader(connectionId:string):IntegrationReader {
    const config=this.connections.resolve(connectionId);
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
  /** One binding: the exact connection settings, shared by every workspace on this machine. */
  private healthKey(config:ProviderConnection):string { return JSON.stringify(config); }
  private async probe(config:ProviderConnection):Promise<ConnectionHealthSnapshot> {
    try { return snapshot(config,await this.readerFor(config).validate(),new Date()); }
    catch (error) { if (error instanceof StapleError) return snapshot(config,healthFromError(error),new Date()); throw error; }
  }
  private async health(connectionId:string|undefined,force:boolean):Promise<ConnectionHealthSnapshot[]> {
    const all=this.connections.list();
    const one=connectionId===undefined ? null : this.connections.resolve(connectionId);
    if (connectionId!==undefined && !one) return [missingSnapshot(connectionId,new Date())];
    return Promise.all(all.filter(c=>one===null || c.id===one.id)
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
  private select(c:IntegrationCommand, host:string,providerId?:string,scopeId?:string,href?:string):string {
    if (c.connectionId) return c.connectionId;
    // Several Azure DevOps organizations share one host; a pasted address names its own.
    const choices=this.connections.list().filter(x=>x.host===host && (!providerId || x.providerId===providerId) && (x.providerId==="github" || !scopeId || x.scopeId===scopeId)
      && (x.providerId!=="azure_devops" || !href || servesUrl(x,href)));
    if (!choices.length && href && (isServices(host) || isWorkItemUrl(href))) {
      const place=placeNameOf(href) ?? host;
      throw new StapleError("unavailable",`No Azure DevOps connection on this computer reads ${place}. Add a connection for ${place} in Settings > Integrations.`);
    }
    if (choices.length!==1) throw new StapleError("unavailable",choices.length ? "Choose which provider connection to use" : "Cached-only session. Configure a connection for live reads in Settings > Integrations.");
    return choices[0]!.id;
  }
  /** A live-resolved source must lie inside the request's scope; cached resources never are refused. */
  private async source(c:IntegrationCommand):Promise<ExternalResource|ExternalItem|ResolvedExternalItem> {
    const item=await this.resolveSource(c);
    if ("id" in item) return item;
    const scope=this.scope(c);
    if (scope.mode==="none" || scope.targets.some(t=>contains(t,item))) return item;
    const target=outsideTarget(item,this.connections.list());
    const names=scope.targets.map(t=>t.name ?? t.key).join(", ");
    throw new StapleError("validation",`${item.key} is outside ${scope.mode==="workspace" ? `this workspace's mapping` : "the mapped repositories and projects"} (${names}). Map ${target.name ?? target.key} first.`,
      {reason:"outside_scope",target});
  }
  private async resolveSource(c:IntegrationCommand):Promise<ExternalResource|ExternalItem|ResolvedExternalItem> {
    if (c.resourceId) return storedSource(this.store.externalLinks().resource(c.resourceId));
    if (c.key) {
      const reader=this.reader(need(c.connectionId,"connection"));
      const resolved=await reader.resolve({key:c.key,containerId:need(c.containerId,"container")});
      if(!resolved) throw new StapleError("not_found","No accessible issue was found for this identifier");
      return reader.read(resolved.ref);
    }
    const url=need(c.url,"source URL");
    let parsed:URL;
    // An older <organization>.visualstudio.com address is read, cached and linked as its dev.azure.com one.
    try { parsed=new URL(canonicalAzureDevOpsUrl(url) ?? url); } catch { throw new StapleError("validation","Use an exact HTTPS issue or PR URL"); }
    if (parsed.protocol!=="https:" || parsed.username || parsed.password) throw new StapleError("validation","Use an HTTPS source URL without credentials");
    parsed.hash="";
    const cached=this.store.db.prepare("SELECT id FROM external_resources WHERE url=? LIMIT 2").all(parsed.href) as Array<{id:string}>;
    // A pasted cached URL remains usable without a machine connection.
    if(cached.length>1 && !c.connectionId) throw new StapleError("conflict","Several scoped resources use this URL. Choose a resource or connection explicitly.");
    if (cached.length===1 && !c.connectionId) return storedSource(this.store.externalLinks().resource(cached[0]!.id));
    const reader=this.reader(this.select(c,parsed.host,undefined,undefined,parsed.href));
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
          execution:this.options.liveReadsAvailable===false ? "cached_only":"local",counts:this.workspaceStore ? this.counts():{}};
      }
      case "configure":
        if(c.providerId === "azure_devops") {
          const credentialEnv=need(c.credentialEnv,"credential environment variable name");
          // Services by default; an Azure DevOps Server host otherwise. An older <organization>.visualstudio.com host is that Services organization.
          const legacy=/^([a-z0-9-]+)\.visualstudio\.com$/.exec(c.host?.trim().toLowerCase() ?? "");
          const host=legacy ? SERVICES_HOST : c.host?.trim().toLowerCase() || SERVICES_HOST;
          const organization=c.organization?.trim() || legacy?.[1] || need(undefined,isServices(host) ? "Azure DevOps organization name" : "Azure DevOps Server collection");
          const problem=placeProblem({host,organization});
          if (problem) throw new StapleError("validation",problem);
          if (this.options.liveReadsAvailable===false && !(c.account && c.scopeId)) throw new StapleError("unavailable","Cached-only session. Connect Azure DevOps on the machine running Staple.");
          // Binding by GUID needs one read with the token, unless the caller already knows both ids.
          const bound=c.account && c.scopeId ? {account:c.account,scopeId:c.scopeId}
            : await (this.options.discoverAzureDevOps ?? ((o,e,h)=>discoverAzureDevOps(o,e,{},h)))(organization,credentialEnv,host);
          // An id the caller expects is a check, never a hint to drop: refuse a token that answers for someone else.
          if (c.scopeId && c.scopeId.toLowerCase()!==bound.scopeId.toLowerCase()) throw new StapleError("forbidden",`The token in ${credentialEnv} answers for a different Azure DevOps organization than ${organization}.`);
          if (c.account && c.account.toLowerCase()!==bound.account.toLowerCase()) throw new StapleError("auth",`The token in ${credentialEnv} belongs to a different Azure DevOps user than the one expected.`,{reason:"account_mismatch"});
          return this.connections.save({id:c.connectionId,providerId:"azure_devops",mode:"api",host,organization,account:bound.account,scopeId:bound.scopeId,credentialEnv});
        }
        if(c.providerId === "linear") return this.connections.save({id:c.connectionId,providerId:"linear",mode:"api",host:"linear.app",
          account:need(c.account,"expected Linear user UUID"),scopeId:need(c.scopeId,"Linear organization UUID"),credentialEnv:need(c.credentialEnv,"credential environment variable name")});
        return this.connections.save({id:c.connectionId,providerId:"github",mode:"cli",host:need(c.host,"GitHub host").toLowerCase(),account:need(c.account,"expected gh account")});
      case "remove": this.connections.remove(need(c.connectionId,"connection")); return {removed:true};
      case "organizations": {
        if (c.providerId!=="azure_devops") throw new StapleError("validation","Only Azure DevOps lists organizations");
        if (this.options.liveReadsAvailable===false) throw new StapleError("unavailable","Cached-only session. Connect Azure DevOps on the machine running Staple.");
        const host=c.host?.trim().toLowerCase() || SERVICES_HOST;
        const list=this.options.listAzureDevOpsOrganizations ?? ((e,h)=>listAzureDevOpsOrganizations(e,{},h));
        return {host,organizations:await list(need(c.credentialEnv,"credential environment variable name"),host)};
      }
      case "health": return {health:await this.health(c.connectionId,c.force===true),pollIntervalSeconds:HEALTH_POLL_INTERVAL_SECONDS};
      case "containers": return this.containers(c);
      case "mapping": {
        const connections=this.connections.list();
        if (c.allWorkspaces) {
          const listed=this.workspaces().map(w=>({workspace:w.slug,targets:storedMapping(w.store,this.names).map(t=>present(t,connections))}));
          // Each target is named once, however many workspaces map it.
          const union=new Map<string,MappingTarget>();
          for (const t of listed.flatMap(w=>w.targets)) if (!union.get(t.key)?.name) union.set(t.key,t);
          const named=new Map((await this.named([...union.values()])).map(t=>[t.key,t]));
          const workspaces=listed.map(w=>({workspace:w.workspace,targets:w.targets.map(t=>t.name ? t : {...t,name:named.get(t.key)!.name,url:named.get(t.key)!.url})}));
          return {workspaces,targets:[...named.values()]};
        }
        return {workspace:this.store.slug,targets:await this.named(storedMapping(this.store,this.names).map(t=>present(t,connections)))};
      }
      case "map": {
        const connection=this.connections.resolve(need(c.connectionId,"connection"));
        if (!connection) throw new StapleError("not_found","Configure this provider connection on the machine running Staple");
        const kind:ContainerKind=c.containerKind ?? CONTAINER_KIND[connection.providerId];
        const container=await this.reader(connection.id).readContainer(need(c.containerId,"container"),kind);
        if (!container) throw new StapleError("not_found","That repository, team or project is not accessible through this connection");
        const target=storedTarget(connection,kind,container);
        const current=storedMapping(this.store,this.names).filter(t=>targetKey(t)!==targetKey(target));
        if (current.length>=MAPPING_LIMIT) throw new StapleError("validation",`A workspace maps at most ${MAPPING_LIMIT} repositories, teams or projects`);
        writeMapping(this.store,[...current,target],actor());
        this.names.set(targetKey(target),{name:container.name,url:container.url});
        return {workspace:this.store.slug,targets:storedMapping(this.store,this.names).map(t=>present(t,this.connections.list()))};
      }
      case "unmap": {
        const key=need(c.targetKey,"mapped target key");
        const current=storedMapping(this.store,this.names);
        if (!current.some(t=>targetKey(t)===key)) throw new StapleError("not_found","This workspace does not map that target");
        writeMapping(this.store,current.filter(t=>targetKey(t)!==key),actor());
        return {workspace:this.store.slug,targets:storedMapping(this.store,this.names).map(t=>present(t,this.connections.list()))};
      }
      case "counts": return this.counts();
      case "list": return this.store.externalLinks().list(need(c.ref,"local ticket"));
      case "resolve": return this.source(c);
      case "preview": { const item=await this.source(c); return {item,...new ExternalWork(this.store).preview(item)}; }
      case "search": {
        const text=c.text?.trim() ?? "";
        const kind=c.kind ?? "issue";
        const local=this.store.listIssues({includeResolved:true}).filter(i=>`${i.identifier} ${i.title}`.toLowerCase().includes(text.toLowerCase())).slice(0,50);
        const rows=this.store.db.prepare(`SELECT r.id FROM external_resources r LEFT JOIN external_private_cache p ON p.resource_id=r.id WHERE r.kind=? AND
          (instr(lower(COALESCE(CASE WHEN p.fetched_at IS NOT NULL AND (r.fetched_at IS NULL OR p.fetched_at>=r.fetched_at) THEN p.title ELSE r.title END,'')),lower(?))>0 OR instr(lower(r.display_key),lower(?))>0) LIMIT 50`).all(kind,text,text) as Array<{id:string}>;
        const cached=rows.map(r=>this.decorate(this.store.externalLinks().resource(r.id)));
        const scope=this.scope(c);
        const live=this.options.liveReadsAvailable!==false;
        const result=live ? await this.searchTargets(c,scope,kind,text) : {remote:[],nextCursor:null,failures:[]};
        return {local,counts:this.counts(),cached,...result,scope,execution:live ? "local":"cached_only"};
      }
      case "link": return new ExternalWork(this.store).adopt(need(c.ref,"local ticket"),await this.source(c),c.confirmed===true,actor());
      case "create": {
        const item=await this.source(c);
        if (!("title" in item) || item.title===null || item.fetchedAt===null) throw new StapleError("unavailable","Read source context before creating local work");
        return new ExternalWork(this.store).create(item as ExternalItem,{requestKey:need(c.requestKey,"retry request key"),actor:actor(),additionalWork:c.additionalWork,title:c.title});
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
  /** One page across every target in scope, each through the connection that serves it. A failed source is data. */
  private async searchTargets(c:IntegrationCommand,scope:SearchScope,kind:"issue"|"pull_request",text:string) {
    const narrowed=scope.targets.filter(t=>(kind==="issue" || t.providerId==="github")
      && (!c.containerKey || t.key===c.containerKey) && (!c.containerId || t.containerId===c.containerId)
      && (!c.connectionId || t.connectionId===this.connections.resolve(c.connectionId)?.id));
    if ((c.containerKey || c.containerId) && !narrowed.length) throw new StapleError("validation","That repository, team or project is not in this search's scope");
    const binding=JSON.stringify([kind,text,narrowed.map(t=>t.key)]);
    const parts=decodeCursor(c.cursor,binding);
    const pending=narrowed.filter(t=>!parts || parts[t.key]);
    const remote:Array<ReturnType<IntegrationOperations["decorate"]>&{targetKey:string}>=[];
    const next:Record<string,string>={};
    const failures:Array<{connectionId:string|null;targetKeys:string[];state:ConnectionState;message:string;action:string|null}>=[];
    const fail=(connectionId:string|null,key:string,state:ConnectionState,message:string,action:string|null)=>{
      const seen=failures.find(f=>f.connectionId===connectionId && f.state===state);
      if (seen) seen.targetKeys.push(key); else failures.push({connectionId,targetKeys:[key],state,message,action});
    };
    const readers=new Map<string,IntegrationReader>();
    const pages=await mapBounded(pending,4,async target=>{
      const connection=target.connectionId ? this.connections.resolve(target.connectionId) : null;
      if (!connection) { fail(null,target.key,"not_found",`No connection on this computer reads ${target.host}.`,"Add a connection for it in Settings > Integrations."); return null; }
      try {
        const reader=readers.get(connection.id) ?? this.readerFor(connection);
        readers.set(connection.id,reader);
        const page:ExternalPage<ExternalItem>=await reader.search(kind,{text,cursor:parts?.[target.key],
          ...(linearProject(target) ? {projectId:target.containerId} : {containerId:target.containerId})});
        if (this.caches.health.peek(this.healthKey(connection))?.state!=="ready") this.caches.health.delete(this.healthKey(connection));
        return {target,page};
      } catch (error) {
        if (!(error instanceof StapleError)) throw error;
        const health=snapshot(connection,healthFromError(error),new Date());
        if (isConnectionFailure(error)) this.caches.health.record(this.healthKey(connection),health);
        fail(connection.id,target.key,health.state,health.message ?? error.message,health.action);
        return null;
      }
    });
    for (const result of pages) {
      if (!result) continue;
      for (const item of result.page.items) remote.push({...this.decorate(item),targetKey:result.target.key});
      if (result.page.nextCursor) next[result.target.key]=result.page.nextCursor;
    }
    return {remote,nextCursor:Object.keys(next).length ? encodeCursor(binding,next) : null,failures};
  }
  /** Containers to map: repositories or teams, or Linear projects; `text` filters by name across pages. */
  private async containers(c:IntegrationCommand) {
    const connection=this.connections.resolve(need(c.connectionId,"connection"));
    if (!connection) throw new StapleError("not_found","Configure this provider connection on the machine running Staple");
    const reader=this.reader(connection.id);
    const kind:ContainerKind=c.containerKind ?? CONTAINER_KIND[connection.providerId];
    const projects=linearProject({providerId:connection.providerId,kind});
    if (!projects && kind!==CONTAINER_KIND[connection.providerId]) throw new StapleError("validation",`This connection lists ${CONTAINER_KIND[connection.providerId]==="repository" ? "repositories" : `${CONTAINER_KIND[connection.providerId]}s`}, not that`);
    const page=(cursor?:string)=>projects ? reader.listProjects(cursor) : reader.listContainers(cursor);
    const needle=c.text?.trim().toLowerCase() ?? "";
    let cursor=c.cursor, items:ExternalContainer[]=[], scanned=0;
    do {
      const read=await page(cursor);
      items=items.concat(needle ? read.items.filter(i=>i.name.toLowerCase().includes(needle)) : read.items);
      cursor=read.nextCursor ?? undefined;
      scanned++;
    } while (needle && cursor && items.length<50 && scanned<10);
    return {items:items.map(container=>{
      const target=storedTarget(connection,kind,container);
      return {...container,kind,scopeId:target.scopeId,key:targetKey(target)};
    }),nextCursor:cursor ?? null};
  }
  /** Fill names the stored mapping lacks (legacy entries) on the first read a connection can serve; remember them on this machine. */
  private async named(targets:MappingTarget[]):Promise<MappingTarget[]> {
    if (this.options.liveReadsAvailable===false) return targets;
    return mapBounded(targets,4,async target=>{
      if (target.name || !target.connectionId) return target;
      try {
        const container=await this.reader(target.connectionId).readContainer(target.containerId,target.kind);
        if (!container) return target;
        this.names.set(target.key,{name:container.name,url:container.url});
        return {...target,name:container.name,url:container.url};
      } catch { return target; }
    });
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

function storedTarget(connection:ProviderConnection,kind:ContainerKind,container:ExternalContainer):StoredTarget {
  if (connection.providerId==="azure_devops") return {providerId:"azure_devops",host:connection.host,scopeId:connection.scopeId,kind:"project",containerId:container.id.toLowerCase(),name:container.name,url:container.url};
  return connection.providerId==="github"
    ? {providerId:"github",host:connection.host,scopeId:"host",kind:"repository",containerId:container.id,name:container.name,url:container.url}
    : {providerId:"linear",host:"linear.app",scopeId:connection.scopeId,kind:kind==="project" ? "project":"team",containerId:container.id.toLowerCase(),name:container.name,url:container.url};
}

/** A Linear project narrows search by project across teams; every other target is the item's own container. */
function linearProject(target:{providerId:string;kind:ContainerKind}):boolean {
  return target.providerId==="linear" && target.kind==="project";
}

/** Whether an item lies in a mapped target: its repository, team or Azure DevOps project, or for a Linear project its project. */
function contains(target:MappingTarget,item:ResolvedExternalItem):boolean {
  const ref=item.ref;
  if (ref.providerId!==target.providerId || ref.host!==target.host || ref.scopeId!==target.scopeId) return false;
  return linearProject(target) ? (item as ExternalItem).projectId===target.containerId : ref.containerId===target.containerId;
}

/** What to offer mapping when an item is outside scope: its repository or team. */
function outsideTarget(item:ResolvedExternalItem,connections:ProviderConnection[]):MappingTarget {
  const r=item.ref;
  const stored:StoredTarget=r.providerId==="github"
    ? {providerId:"github",host:r.host,scopeId:"host",kind:"repository",containerId:r.containerId,name:item.key.replace(/#[0-9]+$/,""),url:item.url.replace(/\/(issues|pull)\/[0-9]+$/,"")}
    : r.providerId==="azure_devops"
    ? {providerId:"azure_devops",host:r.host,scopeId:r.scopeId,kind:"project",containerId:r.containerId,name:item.key.replace(/#[0-9]+$/,""),url:item.url.replace(/\/_workitems\/edit\/[0-9]+$/,"")}
    : {providerId:"linear",host:"linear.app",scopeId:r.scopeId,kind:"team",containerId:r.containerId,name:item.key.replace(/-[0-9]+$/,""),url:null};
  return present(stored,connections);
}

function encodeCursor(binding:string,parts:Record<string,string>):string {
  return Buffer.from(JSON.stringify([createHash("sha256").update(binding).digest("hex"),parts])).toString("base64url");
}
function decodeCursor(cursor:string|undefined,binding:string):Record<string,string>|null {
  if (cursor===undefined) return null;
  try {
    const [hash,parts]=z.tuple([z.string(),z.record(z.string().max(4096))]).parse(JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")));
    if (hash!==createHash("sha256").update(binding).digest("hex") || !Object.keys(parts).length) throw new Error();
    return parts;
  } catch { throw new StapleError("cursor_invalid","The search or its scope changed; start again"); }
}

async function mapBounded<T,R>(items:T[],limit:number,fn:(item:T)=>Promise<R>):Promise<R[]> {
  const results:R[]=new Array(items.length);
  let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while (next<items.length) { const i=next++; results[i]=await fn(items[i]!); }
  }));
  return results;
}
