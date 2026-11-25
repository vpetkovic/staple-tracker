/**
 * Azure DevOps across the integration surfaces that decide by provider: Add connection, the
 * connection form and row, the source picker, the External links tab and the link dialog.
 * Rendered to strings from injected data, like the GitHub and Linear tests beside these.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionHealthSnapshot } from "../../../../core/integrations/contracts";
import type { ConnectionView } from "./connection-status";
import type { Connections } from "./useConnections";
import { connectionFor, groupResults, pastedPlace, searchKinds } from "./link-dialog/logic";
import { containerLabel, providerName, shortKey } from "./link-state";
import { openLabel, refreshConnection } from "./links-view";
import type { ExternalLink, MappingTarget, SearchHit } from "./model";
import { ConnectionForm, ConnectionsSection } from "../settings/integrations/ConnectionsSection";
import { azureOrganizationHint, azureOrganizationProblem, CONNECTION_CHOICES, connectionMeta, containerKinds, pickerSections } from "../settings/integrations/integrations-model";

const ACME = "22222222-2222-4222-8222-222222222222";
const CONTOSO = "66666666-6666-4666-8666-666666666666";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const health = (state: ConnectionHealthSnapshot["state"], over: Partial<ConnectionHealthSnapshot> = {}): ConnectionHealthSnapshot => ({
  connectionId: "ado-acme", state, message: state === "ready" ? null : "Azure DevOps rejected the personal access token in STAPLE_AZURE_DEVOPS_PAT.",
  action: null, identity: null, checkedAt: "2026-11-25T12:00:00Z", retryAfterSeconds: null, ...over,
});
const azure = (id: string, organization: string, scopeId: string, h: ConnectionHealthSnapshot | null = health("ready")): Extract<ConnectionView, { providerId: "azure_devops" }> => ({
  id, providerId: "azure_devops", mode: "api", host: "dev.azure.com", organization, account: "11111111-1111-4111-8111-111111111111",
  scopeId, credentialEnv: "STAPLE_AZURE_DEVOPS_PAT", health: h,
});
const project: MappingTarget = {
  key: `dev.azure.com/${ACME}/project/${PROJECT}`, providerId: "azure_devops", host: "dev.azure.com", scopeId: ACME, kind: "project",
  containerId: PROJECT, name: "Fabrikam Web", url: "https://dev.azure.com/acme/Fabrikam%20Web", connectionId: "ado-acme",
};
const workItem = (id: number, scopeId = ACME): SearchHit["item"] => ({
  ref: { providerId: "azure_devops", host: "dev.azure.com", scopeId, containerId: PROJECT, id: String(id), kind: "issue" },
  key: `Fabrikam Web#${id}`, url: `https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/${id}`,
});
const noop = async () => {};

describe("Azure DevOps in Settings → Integrations", () => {
  it("is a working choice in Add connection, no longer marked Soon", () => {
    expect(CONNECTION_CHOICES.find((c) => c.providerId === "azure_devops")).toEqual({ providerId: "azure_devops", label: "Azure DevOps organization", available: true });
  });

  it("asks for the token variable first, then an optional Server and the organization, never a token or a GUID", () => {
    const html = renderToStaticMarkup(<ConnectionForm provider="azure_devops" onCancel={() => {}} onSaved={noop} onDirtyChange={() => {}} />);
    expect(html).toContain(">Connect Azure DevOps<");
    // The same order as ClickUp's form: the credential variable leads.
    expect(html.indexOf(">Token variable<")).toBeLessThan(html.indexOf(">Server (optional)<"));
    expect(html.indexOf(">Server (optional)<")).toBeLessThan(html.indexOf(">Organization<"));
    expect(html).toContain('placeholder="dev.azure.com"');
    expect(html).toContain('placeholder="The name in dev.azure.com/&lt;organization&gt;"');
    expect(html).toContain('value="STAPLE_AZURE_DEVOPS_PAT"');
    expect(html).toContain("Work Items (Read) and Project and Team (Read)");
    expect(html).not.toMatch(/UUID|GUID|User ID/i);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Save/);
  });

  it("checks the organization, or a Server host and collection, before asking the server", () => {
    expect(azureOrganizationProblem("")).toBeNull();
    expect(azureOrganizationProblem(" fabrikam-web ")).toBeNull();
    expect(azureOrganizationProblem("https://dev.azure.com/acme")).toMatch(/organization name/);
    expect(azureOrganizationProblem("-acme")).not.toBeNull();
    expect(azureOrganizationProblem("tfs/DefaultCollection", "tfs.example.com")).toBeNull();
    expect(azureOrganizationProblem("", "https://tfs.example.com")).toMatch(/without https:\/\//);
    expect(azureOrganizationProblem("a/b/c", "tfs.example.com")).toMatch(/collection/);
  });

  it("offers the organizations a token lists, and says how to go on when it lists none", () => {
    expect(azureOrganizationHint(null, true, "")).toBe("Looking for the organizations this token reaches…");
    expect(azureOrganizationHint([{ name: "acme" }, { name: "zeta" }], false, "")).toMatch(/^Choose one of the organizations this token reaches/);
    expect(azureOrganizationHint([{ name: "acme" }], false, "")).toBe("This token reaches acme.");
    expect(azureOrganizationHint([], false, "")).toBe("Type the organization name. This token doesn't list organizations, usually because it was made for one organization.");
    expect(azureOrganizationHint([], false, "tfs.example.com")).toMatch(/^Type the collection name/);
  });

  it("names a connection by its login and organization, and lists its projects as one section", () => {
    expect(connectionMeta(azure("ado-acme", "acme", ACME, null))).toBe("Azure DevOps account · acme · token in STAPLE_AZURE_DEVOPS_PAT");
    expect(connectionMeta(azure("ado-acme", "acme", ACME, health("ready", { identity: { login: "Ada Lovelace", organization: "acme" } }))))
      .toBe("Ada Lovelace · acme · token in STAPLE_AZURE_DEVOPS_PAT");
    expect(connectionMeta({ ...azure("ado-tfs", "tfs/DefaultCollection", ACME, null), host: "tfs.example.com" })).toBe("Azure DevOps account · tfs.example.com/tfs/DefaultCollection · token in STAPLE_AZURE_DEVOPS_PAT");
    expect(containerKinds("azure_devops")).toEqual(["project"]);
    const item = { id: PROJECT, name: "Fabrikam Web", url: project.url!, kind: "project" as const, scopeId: ACME, key: project.key };
    expect(pickerSections("azure_devops", { project: { items: [item], nextCursor: "next" } }, [project]))
      .toEqual([{ kind: "project", label: null, items: [{ ...item, mapped: true }], nextCursor: "next" }]);
  });

  it("renders a connection row with its status and without the token variable's value", () => {
    const state: Connections = {
      connections: [azure("ado-acme", "acme", ACME, health("unauthenticated"))], detected: [], loaded: true, checking: null, cachedOnly: false, error: null,
      refresh: noop, reload: noop, check: noop,
    } as unknown as Connections;
    const html = renderToStaticMarkup(<ConnectionsSection state={state} onDirtyChange={() => {}} now={Date.parse("2026-11-25T12:00:30Z")} />);
    expect(html).toContain("Azure DevOps");
    expect(html).toContain("acme · token in STAPLE_AZURE_DEVOPS_PAT");
    expect(html).toContain('data-provider="azure_devops"');
    expect(html).not.toContain(ACME);
  });
});

describe("Azure DevOps links and the link dialog", () => {
  it("speaks of Azure DevOps by name and keeps the project as the short key's container", () => {
    expect(providerName("azure_devops")).toBe("Azure DevOps");
    expect(openLabel("azure_devops")).toBe("Open in Azure DevOps");
    expect(openLabel("github")).toBe("Open on GitHub");
    expect(openLabel("linear")).toBe("Open in Linear");
    expect(containerLabel(workItem(12))).toBe("Fabrikam Web");
    expect(shortKey(workItem(12), [workItem(13)])).toBe("#12");
  });

  it("refreshes a link only through a ready connection for its own organization", () => {
    const link = { resource: { ...workItem(12), id: "r1", title: "t", body: null, status: null, fetchedAt: null } } as unknown as ExternalLink;
    expect(refreshConnection(link, [azure("ado-contoso", "contoso", CONTOSO), azure("ado-acme", "acme", ACME)])).toBe("ado-acme");
    expect(refreshConnection(link, [azure("ado-contoso", "contoso", CONTOSO)])).toBeNull();
  });

  it("searches issues only for an Azure DevOps source, and groups saved work items under their mapped project", () => {
    expect(searchKinds("all", project.key, [project])).toEqual(["issue"]);
    const groups = groupResults([{ cached: [{ item: workItem(7), associations: [] }], remote: [{ item: workItem(12), associations: [], targetKey: project.key }] }], [project]);
    expect(groups.map((g) => [g.key, g.label, g.hits.map((h) => h.item.key)])).toEqual([[`target:${project.key}`, "Fabrikam Web", ["Fabrikam Web#12", "Fabrikam Web#7"]]]);
  });

  it("reads a pasted or saved work item through its own organization's connection", () => {
    const connections = [azure("ado-contoso", "contoso", CONTOSO), azure("ado-acme", "acme", ACME)];
    expect(connectionFor(pastedPlace("https://dev.azure.com/ACME/Web/_workitems/edit/1"), undefined, [], connections)).toBe("ado-acme");
    expect(connectionFor(pastedPlace("https://dev.azure.com/fabrikam/Web/_workitems/edit/1"), undefined, [], connections)).toBeUndefined();
    // An older visualstudio.com address is the same organization.
    expect(pastedPlace("https://contoso.visualstudio.com/DefaultCollection/Web/_workitems/edit/1")).toEqual({ host: "dev.azure.com", url: "https://dev.azure.com/contoso/Web/_workitems/edit/1" });
    expect(connectionFor(pastedPlace("https://contoso.visualstudio.com/Web/_workitems/edit/1"), undefined, [], connections)).toBe("ado-contoso");
    // A Server is chosen by its host and collection path.
    const server = { ...azure("ado-tfs", "tfs/DefaultCollection", "77777777-7777-4777-8777-777777777777"), host: "tfs.example.com" };
    expect(connectionFor(pastedPlace("https://tfs.example.com/tfs/DefaultCollection/Web/_workitems/edit/1"), undefined, [], [...connections, server])).toBe("ado-tfs");
    expect(connectionFor(pastedPlace("https://tfs.example.com/tfs/Other/Web/_workitems/edit/1"), undefined, [], [...connections, server])).toBeUndefined();
    expect(connectionFor(workItem(12).ref, undefined, [], connections)).toBe("ado-acme");
    expect(connectionFor(workItem(12, CONTOSO).ref, undefined, [], connections)).toBe("ado-contoso");
  });
});
