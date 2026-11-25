import { parseArgs } from "node:util";
import { acknowledgeRenumbers } from "../core/identifier-moves.js";
import { resolveWorkspace } from "../core/workspace.js";
import { IntegrationOperations } from "../core/integrations/operations.js";

/** Human and script entry point. Workspace resolution is the same as every other command. */
export async function runIntegrationsCommand(args:string[]):Promise<void> {
  if(!args[0] || args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--")).some(arg => arg === "--help" || arg === "-h")) {
    console.log("staple integrations <connections|configure|remove|health|containers|search|resolve|preview|list|counts|link|create|unlink|refresh|stack|share> --ws <workspace> [--provider github|linear] [--scope <organization-uuid>] [--account <user>] [--credential-env <variable-name>] [--connection <id>] [--key <ENG-123> --container <team-uuid>] [--url <url>] [--ref <ticket>] [--resource <id>] [--force] [--confirmed] [--request-key <key>] [--additional-work] [--enabled true|false]");
    return;
  }
  const {values,positionals}=parseArgs({args,allowPositionals:true,options:{
    "ack-renumber":{type:"boolean"},ws:{type:"string"},db:{type:"string"},json:{type:"boolean"},actor:{type:"string"},provider:{type:"string"},scope:{type:"string"},"credential-env":{type:"string"},key:{type:"string"},connection:{type:"string"},host:{type:"string"},account:{type:"string"},
    url:{type:"string"},resource:{type:"string"},ref:{type:"string"},text:{type:"string"},kind:{type:"string"},container:{type:"string"},cursor:{type:"string"},
    force:{type:"boolean"},confirmed:{type:"boolean"},"additional-work":{type:"boolean"},"request-key":{type:"string"},title:{type:"string"},parent:{type:"string"},position:{type:"string"},enabled:{type:"string"},
  }});
  const command={action:positionals[0],providerId:values.provider,scopeId:values.scope,credentialEnv:values["credential-env"],key:values.key,connectionId:values.connection,host:values.host,account:values.account,url:values.url,resourceId:values.resource,ref:values.ref,
    text:values.text,kind:values.kind,containerId:values.container,cursor:values.cursor,force:values.force,confirmed:values.confirmed,additionalWork:values["additional-work"],
    requestKey:values["request-key"],title:values.title,parentResourceId:values.parent==="none" ? null:values.parent,position:values.position===undefined ? undefined:Number(values.position),
    enabled:values.enabled===undefined ? undefined:values.enabled==="true" ? true:values.enabled==="false" ? false:values.enabled,actor:values.actor ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user"};
  if(values["ack-renumber"]) acknowledgeRenumbers();
  const store=resolveWorkspace({ws:values.ws,db:values.db}).store;
  console.log(JSON.stringify(await new IntegrationOperations(store).execute(command),null,values.json ? undefined:2));
}
