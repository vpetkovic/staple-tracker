import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureDevOpsApiAdapter, discoverAzureDevOps, listAzureDevOpsOrganizations, type AzureDevOpsApiConnection } from "../src/core/integrations/azure-devops-api.js";
import { canonicalAzureDevOpsUrl, placeNameOf, placeProblem, servesUrl } from "../src/core/integrations/azure-devops-url.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { IntegrationReader } from "../src/core/integrations/provider.js";
import { initWorkspace } from "../src/core/workspace.js";

const account = "11111111-1111-4111-8111-111111111111";
const acmeOrg = "22222222-2222-4222-8222-222222222222";
const collectionId = "77777777-7777-4777-8777-777777777777";
const web = { id: "33333333-3333-4333-8333-333333333333", name: "Fabrikam Web" };
const PAT = "fixture-pat-places";
const SERVER = "tfs.example.com:8443";

interface Call { method: string; origin: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null; auth: string | null; redirect: RequestRedirect | undefined }

/**
 * dev.azure.com/acme, the Services profile directory, and an Azure DevOps Server at
 * https://tfs.example.com:8443/tfs/DefaultCollection. Each place answers for itself only.
 */
function fakeAzure(options: { profile?: number } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = { method: init?.method ?? "GET", origin: url.origin, path: url.pathname, query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect };
    calls.push(call);
    if (url.origin === "https://app.vssps.visualstudio.com") {
      if (options.profile) return new Response(null, { status: options.profile });
      if (url.pathname === "/_apis/profile/profiles/me") return Response.json({ id: account, displayName: "Ada" });
      if (url.pathname === "/_apis/accounts" && url.searchParams.get("memberId") === account) {
        return Response.json({ count: 3, value: [{ accountId: acmeOrg, accountName: "zeta" }, { accountId: "44444444-4444-4444-8444-444444444444", accountName: "acme" }, { accountId: "55555555-5555-4555-8555-555555555555", accountName: "bad/name" }] });
      }
    }
    const prefix = url.origin === "https://dev.azure.com" ? "/acme" : url.origin === `https://${SERVER}` ? "/tfs/DefaultCollection" : null;
    if (url.origin === `https://${SERVER}` && url.pathname === "/_apis/projectCollections") return Response.json({ value: [{ id: collectionId, name: "DefaultCollection" }] });
    if (!prefix || !url.pathname.startsWith(`${prefix}/`)) return new Response(null, { status: 404 });
    const path = url.pathname.slice(prefix.length + 1);
    if (path === "_apis/connectionData") return Response.json({ authenticatedUser: { id: account, providerDisplayName: "Ada" }, instanceId: prefix === "/acme" ? acmeOrg : collectionId });
    if (path === "_apis/projects") return Response.json({ value: [web] });
    if (path.startsWith("_apis/projects/")) return Response.json(web);
    if (path.endsWith("_apis/wit/wiql")) return Response.json({ workItems: [{ id: 12 }] });
    if (path === "_apis/wit/workitemsbatch") {
      return Response.json({ value: (call.body!.ids as number[]).map(id => (id === 12 ? { id, fields: { "System.Title": "Checkout", "System.State": "Active", "System.TeamProject": web.name } } : null)) });
    }
    return new Response(null, { status: 404 });
  });
  return { calls, deps: { fetch: fetch as typeof globalThis.fetch, credential: () => PAT, now: () => new Date("2026-11-25T12:00:00Z") } };
}

const services: AzureDevOpsApiConnection = { id: "acme", providerId: "azure_devops", mode: "api", host: "dev.azure.com", organization: "acme", account, scopeId: acmeOrg, credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" };
const server: AzureDevOpsApiConnection = { ...services, id: "tfs", host: SERVER, organization: "tfs/DefaultCollection", scopeId: collectionId };

describe("Azure DevOps addresses", () => {
  it("rewrites legacy visualstudio.com addresses to dev.azure.com, with or without DefaultCollection", () => {
    expect(canonicalAzureDevOpsUrl("https://Acme.visualstudio.com/Fabrikam%20Web/_workitems/edit/12?src=x")).toBe("https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/12?src=x");
    expect(canonicalAzureDevOpsUrl("https://acme.visualstudio.com/DefaultCollection/Web/_workitems/edit/12")).toBe("https://dev.azure.com/acme/Web/_workitems/edit/12");
    expect(canonicalAzureDevOpsUrl("http://acme.visualstudio.com/Web/_workitems/edit/12")).toBeNull();
    expect(canonicalAzureDevOpsUrl("https://dev.azure.com/acme/Web/_workitems/edit/12")).toBeNull();
    expect(canonicalAzureDevOpsUrl("https://evil.visualstudio.com.example/x")).toBeNull();
  });

  it("knows which organization or collection an address belongs to", () => {
    expect(servesUrl(services, "https://dev.azure.com/ACME/Web/_workitems/edit/1")).toBe(true);
    expect(servesUrl(services, "https://acme.visualstudio.com/Web/_workitems/edit/1")).toBe(true);
    expect(servesUrl(services, "https://dev.azure.com/acme-two/Web/_workitems/edit/1")).toBe(false);
    expect(servesUrl(server, `https://${SERVER}/tfs/DefaultCollection/Web/_workitems/edit/1`)).toBe(true);
    expect(servesUrl(server, `https://${SERVER}/tfs/Other/Web/_workitems/edit/1`)).toBe(false);
    expect(servesUrl(server, "https://tfs.example.com/tfs/DefaultCollection/Web/_workitems/edit/1")).toBe(false);
    expect(placeNameOf("https://acme.visualstudio.com/Web/_workitems/edit/1")).toBe("acme");
    expect(placeNameOf(`https://${SERVER}/tfs/DefaultCollection/x`)).toBe(`${SERVER}/tfs`);
  });

  it("accepts Server hosts and collection paths, and refuses schemes, paths, legacy hosts and deep paths", () => {
    expect(placeProblem({ host: "dev.azure.com", organization: "acme" })).toBeNull();
    expect(placeProblem({ host: SERVER, organization: "tfs/DefaultCollection" })).toBeNull();
    expect(placeProblem({ host: "dev.azure.com", organization: "tfs/DefaultCollection" })).not.toBeNull();
    expect(placeProblem({ host: "https://tfs.example.com", organization: "DefaultCollection" })).not.toBeNull();
    expect(placeProblem({ host: "tfs.example.com/tfs", organization: "DefaultCollection" })).not.toBeNull();
    expect(placeProblem({ host: "acme.visualstudio.com", organization: "DefaultCollection" })).not.toBeNull();
    expect(placeProblem({ host: SERVER, organization: "a/b/c" })).not.toBeNull();
    expect(() => new AzureDevOpsApiAdapter({ ...server, organization: "a/b/c" })).toThrow();
  });
});

describe("Azure DevOps Server and legacy addresses through the adapter", () => {
  it("reads a Server collection on its own origin with a Server api-version, and builds its addresses", async () => {
    const { calls, deps } = fakeAzure();
    const reader = new IntegrationReader(new AzureDevOpsApiAdapter(server, deps));
    expect(await reader.validate()).toMatchObject({ state: "ready" });
    expect((await reader.listContainers()).items).toEqual([{ id: web.id, name: web.name, url: `https://${SERVER}/tfs/DefaultCollection/Fabrikam%20Web` }]);
    const found = await reader.search("issue", { text: "", containerId: web.id });
    expect(found.items[0]).toMatchObject({ ref: { host: SERVER, scopeId: collectionId, containerId: web.id, id: "12" }, url: `https://${SERVER}/tfs/DefaultCollection/Fabrikam%20Web/_workitems/edit/12` });
    expect(await reader.resolve({ url: `https://${SERVER}/tfs/DefaultCollection/Fabrikam%20Web/_workitems/edit/12` })).toMatchObject({ ref: { id: "12", host: SERVER } });
    await expect(reader.resolve({ url: `https://${SERVER}/tfs/Other/Fabrikam%20Web/_workitems/edit/12` })).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("different collection") });
    expect(calls.every(c => c.origin === `https://${SERVER}`)).toBe(true);
    expect(calls.filter(c => c.query.has("api-version")).every(c => c.query.get("api-version") === "5.0")).toBe(true);
    expect(calls.every(c => c.auth === `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`)).toBe(true);
    // The token only goes to the configured origin: a redirect elsewhere is refused, never followed.
    expect(calls.every(c => c.redirect === "manual")).toBe(true);
  });

  it("resolves a legacy visualstudio.com work item address to the same reference as its dev.azure.com one", async () => {
    const { deps } = fakeAzure();
    const adapter = new AzureDevOpsApiAdapter(services, deps);
    const current = await adapter.resolve({ url: "https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/12" });
    expect(await adapter.resolve({ url: "https://acme.visualstudio.com/Fabrikam%20Web/_workitems/edit/12" })).toEqual(current);
    expect(await adapter.resolve({ url: "https://acme.visualstudio.com/DefaultCollection/Fabrikam%20Web/_workitems/edit/12" })).toEqual(current);
    expect(current!.url).toBe("https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/12");
  });

  it("searches titles, tags and the number with one text", async () => {
    const { calls, deps } = fakeAzure();
    const adapter = new AzureDevOpsApiAdapter(services, deps);
    await adapter.searchIssues({ text: "billing", containerId: web.id });
    expect(calls.find(c => c.path.endsWith("/wiql"))!.body!.query).toContain("([System.Title] CONTAINS 'billing' OR [System.Tags] CONTAINS 'billing')");
    await adapter.searchIssues({ text: "#12", containerId: web.id });
    expect(calls.filter(c => c.path.endsWith("/wiql")).at(-1)!.body!.query).toContain("([System.Title] CONTAINS '#12' OR [System.Tags] CONTAINS '#12' OR [System.Id] = 12)");
  });

  it("names a missing or renamed organization or collection instead of a bare not found", async () => {
    const { deps } = fakeAzure();
    expect(await new AzureDevOpsApiAdapter({ ...services, organization: "acme-old" }, deps).validate())
      .toMatchObject({ state: "unavailable", message: "Azure DevOps has no organization named acme-old, or it was renamed. Add the connection again with its current name." });
    await expect(discoverAzureDevOps("Gone", "STAPLE_AZURE_DEVOPS_PAT", deps, SERVER))
      .rejects.toMatchObject({ code: "not_found", message: `Azure DevOps has no collection named Gone on ${SERVER}, or it was renamed. Add the connection again with its current name.` });
  });
});

describe("listing the organizations a token reaches", () => {
  it("lists Services organizations through the profile directory, sorted, offering only names a connection can use", async () => {
    const { calls, deps } = fakeAzure();
    expect(await listAzureDevOpsOrganizations("STAPLE_AZURE_DEVOPS_PAT", deps)).toEqual([
      { name: "acme", id: "44444444-4444-4444-8444-444444444444" }, { name: "zeta", id: acmeOrg }]);
    expect(calls.map(c => `${c.origin}${c.path}`)).toEqual(["https://app.vssps.visualstudio.com/_apis/profile/profiles/me", "https://app.vssps.visualstudio.com/_apis/accounts"]);
  });

  it("lists Server collections on the Server itself", async () => {
    const { calls, deps } = fakeAzure();
    expect(await listAzureDevOpsOrganizations("STAPLE_AZURE_DEVOPS_PAT", deps, SERVER)).toEqual([{ name: "DefaultCollection", id: collectionId }]);
    expect(calls.map(c => c.origin)).toEqual([`https://${SERVER}`]);
  });

  it("is refused for an organization-scoped token, and never asks a host that is not a Server", async () => {
    const { deps } = fakeAzure({ profile: 401 });
    await expect(listAzureDevOpsOrganizations("STAPLE_AZURE_DEVOPS_PAT", deps)).rejects.toMatchObject({ code: "auth" });
    await expect(listAzureDevOpsOrganizations("STAPLE_AZURE_DEVOPS_PAT", deps, "evil.example/x")).rejects.toMatchObject({ code: "validation" });
  });
});

const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  if (previous === undefined) delete process.env.STAPLE_HOME; else process.env.STAPLE_HOME = previous;
});

function operations() {
  const home = mkdtempSync(join(tmpdir(), "ado-places-")); dirs.push(home); process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "ado-places" });
  const fake = fakeAzure();
  const service = new IntegrationOperations(ws.store, {
    home,
    factories: new Map([["azure_devops:api", c => new AzureDevOpsApiAdapter(c as AzureDevOpsApiConnection, fake.deps)]]),
    discoverAzureDevOps: (o, e, h) => discoverAzureDevOps(o, e, fake.deps, h),
    listAzureDevOpsOrganizations: (e, h) => listAzureDevOpsOrganizations(e, fake.deps, h),
  });
  return { ws, service, task: ws.store.createIssue({ title: "Local" }), ...fake };
}

describe("Azure DevOps places through the shared operations", () => {
  it("configures a Server collection and a legacy visualstudio.com host, and lists organizations for the form", async () => {
    const { service, ws } = operations();
    try {
      expect(await service.execute({ action: "configure", providerId: "azure_devops", connectionId: "tfs", host: SERVER.toUpperCase(), organization: "tfs/DefaultCollection", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" }))
        .toMatchObject({ host: SERVER, organization: "tfs/DefaultCollection", scopeId: collectionId, account });
      expect(await service.execute({ action: "configure", providerId: "azure_devops", connectionId: "acme", host: "acme.visualstudio.com", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" }))
        .toMatchObject({ host: "dev.azure.com", organization: "acme", scopeId: acmeOrg });
      await expect(service.execute({ action: "configure", providerId: "azure_devops", host: "https://tfs.example.com", organization: "DefaultCollection", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" }))
        .rejects.toMatchObject({ code: "validation", message: expect.stringContaining("without https://") });
      expect(await service.execute({ action: "organizations", providerId: "azure_devops", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" }))
        .toEqual({ host: "dev.azure.com", organizations: [{ name: "acme", id: "44444444-4444-4444-8444-444444444444" }, { name: "zeta", id: acmeOrg }] });
      expect(await service.execute({ action: "organizations", providerId: "azure_devops", host: SERVER, credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" }))
        .toEqual({ host: SERVER, organizations: [{ name: "DefaultCollection", id: collectionId }] });
    } finally { ws.store.db.close(); }
  });

  it("links a pasted legacy or Server address through the connection for its own place, and says which connection is missing", async () => {
    const { service, ws, task } = operations();
    try {
      await service.execute({ action: "configure", providerId: "azure_devops", connectionId: "acme", organization: "acme", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" });
      await service.execute({ action: "configure", providerId: "azure_devops", connectionId: "tfs", host: SERVER, organization: "tfs/DefaultCollection", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" });
      await service.execute({ action: "link", url: "https://acme.visualstudio.com/DefaultCollection/Fabrikam%20Web/_workitems/edit/12", ref: task.id, confirmed: true, actor: "ada" });
      await service.execute({ action: "link", url: `https://${SERVER}/tfs/DefaultCollection/Fabrikam%20Web/_workitems/edit/12`, ref: task.id, confirmed: true, actor: "ada" });
      const links = ws.store.externalLinks().list(task.id).map(l => [l.resource.ref.host, l.resource.ref.scopeId, l.resource.url]);
      expect(links.sort()).toEqual([
        ["dev.azure.com", acmeOrg, "https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/12"],
        [SERVER, collectionId, `https://${SERVER}/tfs/DefaultCollection/Fabrikam%20Web/_workitems/edit/12`],
      ]);
      // The saved copy answers its legacy address too, without asking a connection.
      expect(await service.execute({ action: "resolve", url: "https://acme.visualstudio.com/Fabrikam%20Web/_workitems/edit/12" })).toMatchObject({ ref: { scopeId: acmeOrg, id: "12" } });
      await expect(service.execute({ action: "resolve", url: "https://contoso.visualstudio.com/Web/_workitems/edit/3" }))
        .rejects.toMatchObject({ code: "unavailable", message: "No Azure DevOps connection on this computer reads contoso. Add a connection for contoso in Settings > Integrations." });
      await expect(service.execute({ action: "resolve", url: "https://ado.internal.example/Main/Web/_workitems/edit/3" }))
        .rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("Add a connection for ado.internal.example/Main") });
    } finally { ws.store.db.close(); }
  });
});
