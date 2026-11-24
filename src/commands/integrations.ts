import { parseArgs } from "node:util";
import { acknowledgeRenumbers } from "../core/identifier-moves.js";
import { resolveWorkspace } from "../core/workspace.js";
import { IntegrationOperations } from "../core/integrations/operations.js";
import { hubWorkspaces } from "../core/integrations/mapping.js";
import type { WorkspaceStore } from "../core/store.js";

/** Human and script entry point. Workspace resolution is the same as every other command. */
export async function runIntegrationsCommand(args:string[]):Promise<void> {
  if(!args[0] || args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--")).some(arg => arg === "--help" || arg === "-h")) {
    console.log("staple integrations <connections|configure|remove|health|containers|mapping|map|unmap|search|resolve|preview|list|counts|link|create|unlink|refresh|stack|share> --ws <workspace> [--provider github|linear] [--scope <organization-uuid>] [--account <user>] [--credential-env <variable-name>] [--connection <id>] [--key <ENG-123> --container <team-uuid>] [--url <url>] [--ref <ticket>] [--resource <id>] [--all-workspaces] [--container-kind repository|team|project] [--target-key <key>] [--container-key <key>] [--force] [--confirmed] [--request-key <key>] [--additional-work] [--enabled true|false]");
    return;
  }
  const {values,positionals}=parseArgs({args,allowPositionals:true,options:{
    "ack-renumber":{type:"boolean"},ws:{type:"string"},db:{type:"string"},json:{type:"boolean"},actor:{type:"string"},provider:{type:"string"},scope:{type:"string"},"credential-env":{type:"string"},key:{type:"string"},connection:{type:"string"},host:{type:"string"},account:{type:"string"},
    url:{type:"string"},resource:{type:"string"},ref:{type:"string"},text:{type:"string"},kind:{type:"string"},container:{type:"string"},cursor:{type:"string"},
    force:{type:"boolean"},"all-workspaces":{type:"boolean"},"container-kind":{type:"string"},"target-key":{type:"string"},"container-key":{type:"string"},confirmed:{type:"boolean"},"additional-work":{type:"boolean"},"request-key":{type:"string"},title:{type:"string"},parent:{type:"string"},position:{type:"string"},enabled:{type:"string"},
  }});
  const command={action:positionals[0],providerId:values.provider,scopeId:values.scope,credentialEnv:values["credential-env"],key:values.key,connectionId:values.connection,host:values.host,account:values.account,url:values.url,resourceId:values.resource,ref:values.ref,
    text:values.text,kind:values.kind,containerId:values.container,cursor:values.cursor,force:values.force,allWorkspaces:values["all-workspaces"],containerKind:values["container-kind"],targetKey:values["target-key"],containerKey:values["container-key"],confirmed:values.confirmed,additionalWork:values["additional-work"],
    requestKey:values["request-key"],title:values.title,parentResourceId:values.parent==="none" ? null:values.parent,position:values.position===undefined ? undefined:Number(values.position),
    enabled:values.enabled===undefined ? undefined:values.enabled==="true" ? true:values.enabled==="false" ? false:values.enabled,actor:values.actor ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user"};
  if(values["ack-renumber"]) acknowledgeRenumbers();
  // Connections belong to this computer: those operations run without a workspace when none is named or found.
  const machineLevel=["connections","configure","remove","health","containers"].includes(String(command.action))
    || (command.action==="mapping" && command.allWorkspaces===true);
  let store:WorkspaceStore|null;
  try { store=resolveWorkspace({ws:values.ws,db:values.db}).store; }
  catch (error) { if (!machineLevel || values.ws || values.db) throw error; store=null; }
  const opened=new Map<string,WorkspaceStore>();
  const workspaces=()=>{
    try { return hubWorkspaces(slug=>opened.get(slug) ?? opened.set(slug,slug===store?.slug ? store:resolveWorkspace({ws:slug}).store).get(slug)!); }
    catch { return store ? [{slug:store.slug,store}] : []; } // no hub on this machine: this workspace is all there is
  };
  console.log(JSON.stringify(await new IntegrationOperations(store,{workspaces}).execute(command),null,values.json ? undefined:2));
}
