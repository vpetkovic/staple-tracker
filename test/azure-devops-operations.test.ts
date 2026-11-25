import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureDevOpsApiAdapter, discoverAzureDevOps, type AzureDevOpsApiConnection } from "../src/core/integrations/azure-devops-api.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { initWorkspace } from "../src/core/workspace.js";
import { CLI_ENTRY, startMcpClient, TSX_CLI, type McpHarness } from "./fixtures/contract-support.js";

const account = "11111111-1111-4111-8111-111111111111";
const acmeOrg = "22222222-2222-4222-8222-222222222222";
const contosoOrg = "66666666-6666-4666-8666-666666666666";
const web = { id: "33333333-3333-4333-8333-333333333333", name: "Fabrikam Web" };
const ops = { id: "44444444-4444-4444-8444-444444444444", name: "Ops" };
const PAT = "fixture-pat-never-stored";

const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
let harness: McpHarness | undefined;
afterEach(async () => {
  await harness?.close(); harness = undefined;
  for (const p of dirs) rmSync(p, { recursive: true, force: true });
  dirs.length = 0;
  if (previous === undefined) delete process.env.STAPLE_HOME; else process.env.STAPLE_HOME = previous;
});

/** Two fake organizations on dev.azure.com, each answering only for its own name. */
function azure() {
  const state = { title: "Checkout fails on Safari", project: web, revoked: false, calls: [] as string[] };
  const fetch = vi.fn(async (input: unknown, request: RequestInit | undefined) => {
    const url = new URL(String(input));
    const [, organization, ...rest] = url.pathname.split("/");
    const path = rest.join("/");
    state.calls.push(`${request?.method ?? "GET"} ${url.pathname}`);
    if (state.revoked) return new Response("revoked", { status: 401 });
    const instanceId = organization === "acme" ? acmeOrg : organization === "contoso" ? contosoOrg : null;
    if (!instanceId) return new Response(null, { status: 404 });
    if (path === "_apis/connectionData") return Response.json({ authenticatedUser: { id: account, providerDisplayName: "Ada Lovelace" }, instanceId });
    if (path === "_apis/projects") return Response.json({ value: [web, ops] });
    const named = /^_apis\/projects\/(.+)$/.exec(path);
    if (named) {
      const key = decodeURIComponent(named[1]!).toLowerCase();
      const found = [web, ops].find(p => p.id === key || p.name.toLowerCase() === key);
      return found ? Response.json(found) : new Response(null, { status: 404 });
    }
    if (path.endsWith("_apis/wit/wiql")) return Response.json({ workItems: [{ id: 12 }] });
    if (path === "_apis/wit/workitemsbatch") {
      const ids = JSON.parse(String(request!.body)).ids as number[];
      return Response.json({ value: ids.map(id => id === 12 || id === 13
        ? { id, fields: { "System.Title": id === 12 ? state.title : "Pager rotation", "System.State": "Active", "System.TeamProject": id === 12 ? state.project.name : ops.name, "System.Description": "<p>Private source body</p>" } }
        : null) });
    }
    return new Response(null, { status: 404 });
  });
  const dependencies = { fetch: fetch as typeof globalThis.fetch, credential: () => PAT, now: () => new Date("2026-11-25T12:00:00Z") };
  return { state, fetch, dependencies };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "staple-azure-ops-")); dirs.push(home); process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "azure-tests" });
  const task = ws.store.createIssue({ title: "Fix Safari checkout" });
  const fake = azure();
  const service = new IntegrationOperations(ws.store, {
    home,
    factories: new Map([["azure_devops:api", c => new AzureDevOpsApiAdapter(c as AzureDevOpsApiConnection, fake.dependencies)]]),
    discoverAzureDevOps: (organization, credentialEnv) => discoverAzureDevOps(organization, credentialEnv, fake.dependencies),
  });
  return { home, ws, task, service, ...fake };
}

describe("Azure DevOps through the shared integration operations", () => {
  it("binds a connection to the token's GUIDs without storing the token, then maps a project and searches it", async () => {
    const { home, service } = setup();
    const saved = await service.execute({ action: "configure", providerId: "azure_devops", connectionId: "acme", organization: "acme", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" });
    expect(saved).toEqual({ id: "acme", providerId: "azure_devops", mode: "api", host: "dev.azure.com", organization: "acme", account, scopeId: acmeOrg, credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" });
    const files = readdirSync(join(home, "integrations", "machine")).filter(f => f.endsWith(".json"));
    expect(files.map(f => readFileSync(join(home, "integrations", "machine", f), "utf8")).join("")).not.toContain(PAT);
    expect(await service.execute({ action: "health", connectionId: "acme" })).toMatchObject({ health: [{ connectionId: "acme", state: "ready", identity: { login: "Ada Lovelace", organization: "acme" } }] });
    const containers = await service.execute({ action: "containers", connectionId: "acme" }) as { items: Array<{ id: string; key: string; kind: string }> };
    expect(containers.items.map(i => [i.id, i.kind, i.key])).toEqual([[web.id, "project", `dev.azure.com/${acmeOrg}/project/${web.id}`], [ops.id, "project", `dev.azure.com/${acmeOrg}/project/${ops.id}`]]);
    await expect(service.execute({ action: "containers", connectionId: "acme", containerKind: "team" })).rejects.toMatchObject({ code: "validation" });
    const mapped = await service.execute({ action: "map", connectionId: "acme", containerId: web.id, actor: "ada" });
    expect(mapped).toMatchObject({ targets: [{ providerId: "azure_devops", kind: "project", containerId: web.id, name: "Fabrikam Web", url: "https://dev.azure.com/acme/Fabrikam%20Web", connectionId: "acme" }] });
    const found = await service.execute({ action: "search", text: "Safari" }) as { remote: Array<{ item: { key: string; ref: { containerId: string } }; targetKey: string }>; failures: unknown[] };
    expect(found.failures).toEqual([]);
    expect(found.remote.map(r => [r.item.key, r.item.ref.containerId])).toEqual([["Fabrikam Web#12", web.id]]);
    // Search reads never persist provider work.
    expect(service.counts()).toEqual({});
  });

  it("links by URL and number, many-to-many, without touching the ticket; refreshes, creates once and keeps context private", async () => {
    const { ws, task, service, state } = setup();
    await service.execute({ action: "configure", providerId: "azure_devops", connectionId: "contoso", organization: "contoso", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" });
    await service.execute({ action: "configure", providerId: "azure_devops", connectionId: "acme", organization: "acme", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" });
    const original = ws.store.getIssue(task.id);
    // Two Azure DevOps connections share dev.azure.com; the organization in the URL picks one.
    await service.execute({ action: "link", url: "https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/12", ref: task.id, confirmed: true, actor: "ada" });
    const resource = ws.store.externalLinks().list(task.id)[0]!.resource;
    expect(resource).toMatchObject({ ref: { providerId: "azure_devops", host: "dev.azure.com", scopeId: acmeOrg, containerId: web.id, id: "12", kind: "issue" },
      key: "Fabrikam Web#12", title: "Checkout fails on Safari", body: "Private source body", contextShared: false });
    expect(ws.store.getIssue(task.id)).toEqual(original);
    const second = ws.store.createIssue({ title: "Second local task" });
    await service.execute({ action: "link", connectionId: "acme", key: "12", containerId: web.id, ref: second.id, confirmed: true, actor: "ada" });
    expect(ws.store.externalLinks().associations(resource.id)).toHaveLength(2);
    await expect(service.execute({ action: "link", url: "https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/12", ref: task.id, actor: "ada" })).rejects.toMatchObject({ code: "validation" });
    await expect(service.execute({ action: "create", resourceId: resource.id, requestKey: "retry", actor: "ada" })).rejects.toMatchObject({ code: "duplicate" });
    const created = await service.execute({ action: "create", resourceId: resource.id, requestKey: "retry", additionalWork: true, actor: "ada" });
    expect(await service.execute({ action: "create", resourceId: resource.id, requestKey: "retry", additionalWork: true, actor: "ada" })).toEqual({ ...created as object, replayed: true });
    state.title = "Checkout fails on Safari 18";
    await service.execute({ action: "refresh", resourceId: resource.id, actor: "ada" });
    expect(ws.store.externalLinks().resource(resource.id)).toMatchObject({ id: resource.id, title: "Checkout fails on Safari 18" });
    expect(ws.store.getIssue(task.id)).toEqual(original);
    expect(JSON.stringify(ws.store.db.prepare("SELECT * FROM external_resources").all())).not.toContain("Private source body");
    // A revoked token fails the refresh, keeps the saved copy, and the connection's health says so.
    state.revoked = true;
    await expect(service.execute({ action: "refresh", resourceId: resource.id, actor: "ada" })).rejects.toMatchObject({ code: "auth" });
    expect(ws.store.externalLinks().resource(resource.id)).toMatchObject({ title: "Checkout fails on Safari 18" });
    const connections = await service.execute({ action: "connections" }) as { connections: Array<{ id: string; health: { state: string; action: string } | null }> };
    expect(connections.connections.find(c => c.id === "acme")!.health).toMatchObject({ state: "unauthenticated", action: expect.stringContaining("STAPLE_AZURE_DEVOPS_PAT") });
    expect(JSON.stringify(connections)).not.toContain(PAT);
    ws.store.db.close();
  });

  it("refuses a pasted work item outside the workspace's mapped projects and names the project to map", async () => {
    const { task, service } = setup();
    await service.execute({ action: "configure", providerId: "azure_devops", connectionId: "acme", organization: "acme", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" });
    await service.execute({ action: "map", connectionId: "acme", containerId: ops.id, actor: "ada" });
    await expect(service.execute({ action: "link", url: "https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/12", ref: task.id, confirmed: true, actor: "ada" }))
      .rejects.toMatchObject({ code: "validation", detail: { reason: "outside_scope", target: { providerId: "azure_devops", kind: "project", containerId: web.id, name: "Fabrikam Web", url: "https://dev.azure.com/acme/Fabrikam%20Web", connectionId: "acme" } } });
    await service.execute({ action: "link", url: "https://dev.azure.com/acme/Ops/_workitems/edit/13", ref: task.id, confirmed: true, actor: "ada" });
    expect(service.counts()[task.id]).toEqual({ issues: 1, pullRequests: 0 });
  });

  it("accepts explicit GUIDs without a token, so a CLI without the variable can still configure", async () => {
    const { service, fetch } = setup();
    const saved = await service.execute({ action: "configure", providerId: "azure_devops", organization: "acme", account, scopeId: acmeOrg, credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" });
    expect(saved).toMatchObject({ account, scopeId: acmeOrg });
    expect(fetch).not.toHaveBeenCalled();
    await expect(service.execute({ action: "configure", providerId: "azure_devops", organization: "acme/../x", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" })).rejects.toMatchObject({ code: "validation" });
    await expect(service.execute({ action: "configure", providerId: "azure_devops", organization: "acme" })).rejects.toMatchObject({ code: "validation" });
  });

  it("configures through the CLI and MCP with explicit GUIDs, and reports a missing token by its variable name", async () => {
    const { ws, home, task } = setup();
    ws.store.externalLinks().link(task.id, { ref: { providerId: "azure_devops", host: "dev.azure.com", scopeId: acmeOrg, containerId: web.id, id: "12", kind: "issue" },
      key: "Fabrikam Web#12", url: "https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/12", title: "Saved title", body: null, status: { id: "Active", name: "Active" }, fetchedAt: "2026-11-25T12:00:00Z" }, "ada");
    const dbPath = ws.dbPath; ws.store.db.close();
    const env = { ...process.env, STAPLE_HOME: home, NODE_NO_WARNINGS: "1", STAPLE_ABSENT_ADO_PAT: "" };
    const cli = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "integrations", "configure", "--provider", "azure_devops", "--organization", "acme", "--account", account, "--scope", acmeOrg,
      "--credential-env", "STAPLE_ABSENT_ADO_PAT", "--connection", "ado-cli", "--db", dbPath, "--json"], { env, encoding: "utf8" });
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual({ id: "ado-cli", providerId: "azure_devops", mode: "api", host: "dev.azure.com", organization: "acme", account, scopeId: acmeOrg, credentialEnv: "STAPLE_ABSENT_ADO_PAT" });
    // Without explicit GUIDs the CLI has to read them with the token, and says which variable is missing.
    const unbound = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "integrations", "configure", "--provider", "azure_devops", "--organization", "acme",
      "--credential-env", "STAPLE_ABSENT_ADO_PAT", "--db", dbPath, "--json"], { env, encoding: "utf8" });
    expect(unbound.status).not.toBe(0);
    expect(unbound.stdout + unbound.stderr).toContain("STAPLE_ABSENT_ADO_PAT");
    harness = await startMcpClient({ home, cwd: home, agent: "integration-test", env: { STAPLE_DB: dbPath, STAPLE_ABSENT_ADO_PAT: "" } });
    const configured = await harness.call("configure_integration", { action: "configure", providerId: "azure_devops", organization: "acme", account, scopeId: acmeOrg, credentialEnv: "STAPLE_ABSENT_ADO_PAT", connectionId: "ado-mcp" });
    expect(configured.isError).not.toBe(true);
    expect(configured.structuredContent).toMatchObject({ result: { providerId: "azure_devops", organization: "acme", scopeId: acmeOrg } });
    const health = await harness.call("integration_read", { action: "health", connectionId: "ado-mcp" });
    expect(health.structuredContent).toMatchObject({ result: { health: [{ connectionId: "ado-mcp", state: "unauthenticated", action: expect.stringContaining("STAPLE_ABSENT_ADO_PAT") }] } });
    const cached = await harness.call("integration_read", { action: "list", ref: task.id });
    expect(cached.structuredContent).toMatchObject({ result: [{ resource: { key: "Fabrikam Web#12", ref: { providerId: "azure_devops" } } }] });
  }, 30_000);
});
