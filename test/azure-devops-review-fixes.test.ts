import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureDevOpsApiAdapter, discoverAzureDevOps, type AzureDevOpsApiConnection } from "../src/core/integrations/azure-devops-api.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { initWorkspace } from "../src/core/workspace.js";

const account = "11111111-1111-4111-8111-111111111111";
const other = "99999999-9999-4999-8999-999999999999";
const org = "22222222-2222-4222-8222-222222222222";
const web = { id: "33333333-3333-4333-8333-333333333333", name: "Fabrikam Web" };
const config: AzureDevOpsApiConnection = { id: "ado", providerId: "azure_devops", mode: "api", host: "dev.azure.com", organization: "acme", account, scopeId: org, credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" };

function fake() {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const p = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push(p);
    if (p === "/acme/_apis/connectionData") return Response.json({ authenticatedUser: { id: account, providerDisplayName: "Ada" }, instanceId: org });
    if (p.startsWith("/acme/_apis/projects/")) return Response.json(web);
    if (p.endsWith("/_apis/wit/wiql")) return Response.json({ workItems: [{ id: 7 }] });
    if (p === "/acme/_apis/wit/workitemsbatch") {
      // A Bug answers only the fields asked for, and its text lives in ReproSteps rather than Description.
      const fields: Record<string, unknown> = { "System.Title": "Crash on save", "System.State": "Active", "System.TeamProject": web.name, "System.WorkItemType": "Bug" };
      if ((body.fields as string[]).includes("Microsoft.VSTS.TCM.ReproSteps")) fields["Microsoft.VSTS.TCM.ReproSteps"] = "<p>Open, then save</p>";
      return Response.json({ value: [{ id: 7, fields }] });
    }
    return new Response(null, { status: 404 });
  });
  return { calls, deps: { fetch: fetch as typeof globalThis.fetch, credential: () => "pat", now: () => new Date("2026-11-25T12:00:00Z") } };
}

const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  if (previous === undefined) delete process.env.STAPLE_HOME; else process.env.STAPLE_HOME = previous;
});

describe("Azure DevOps reads and binding", () => {
  it("uses a Bug's repro steps as its body", async () => {
    const { deps } = fake();
    const item = await new AzureDevOpsApiAdapter(config, deps).readIssue({ providerId: "azure_devops", host: "dev.azure.com", scopeId: org, containerId: web.id, id: "7", kind: "issue" });
    expect(item.body).toBe("Open, then save");
  });

  it("refuses to bind a different user than the expected account given without a scope", async () => {
    const home = mkdtempSync(join(tmpdir(), "ado-binding-")); dirs.push(home); process.env.STAPLE_HOME = home;
    const ws = initWorkspace({ global: true, slug: "ado-binding" });
    const { deps } = fake();
    const service = new IntegrationOperations(ws.store, { home, discoverAzureDevOps: (o, e) => discoverAzureDevOps(o, e, deps) });
    try {
      await expect(service.execute({ action: "configure", providerId: "azure_devops", organization: "acme", account: other, credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" }))
        .rejects.toMatchObject({ code: "auth" });
    } finally { ws.store.db.close(); }
  });

  it("reads the selected project once per scoped search", async () => {
    const { deps, calls } = fake();
    await new AzureDevOpsApiAdapter(config, deps).searchIssues({ text: "", containerId: web.id });
    expect(calls.filter(p => p.startsWith("/acme/_apis/projects/"))).toEqual([`/acme/_apis/projects/${web.id}`]);
  });
});
