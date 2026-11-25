import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { ClickUpApiAdapter, type ClickUpApiConnection } from "../src/core/integrations/clickup-api.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { RequestBudget } from "../src/core/integrations/rate-limit.js";
import { ProbeCache } from "../src/core/integrations/health.js";

const workspace = "9012345", spaceId = "90170001", otherSpace = "90170002", listId = "901700100";
const TOKEN = "pk_ops_fixture_token";
const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
afterEach(() => {
  for (const p of dirs) rmSync(p, { recursive: true, force: true });
  dirs.length = 0;
  if (previous === undefined) delete process.env.STAPLE_HOME; else process.env.STAPLE_HOME = previous;
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "staple-clickup-ops-")); dirs.push(home); process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "clickup-tests" });
  const local = ws.store.createIssue({ title: "Local importer work" });
  const state = { title: "Ship the importer", space: spaceId, denied: false };
  const task = () => ({ id: "86abc123", custom_id: "DEV-42", name: state.title, markdown_description: "Private source body",
    status: { status: "in review" }, team_id: workspace, list: { id: listId, name: "Sprint 12" }, space: { id: state.space },
    dependencies: [{ task_id: "86abc123", depends_on: "86wait01" }] });
  const api = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (state.denied) return Response.json({ err: "Token invalid", ECODE: "OAUTH_025" }, { status: 401 });
    if (url.pathname.endsWith("/folder")) return Response.json({ folders: [] });
    if (url.pathname.endsWith(`/space/${spaceId}/list`)) return Response.json({ lists: [{ id: listId, name: "Sprint 12" }] });
    if (url.pathname.endsWith("/space")) return Response.json({ spaces: [{ id: spaceId, name: "Engineering" }, { id: otherSpace, name: "Ops" }] });
    if (url.pathname.endsWith(`/team/${workspace}/task`)) return Response.json({ tasks: [task()], last_page: true });
    if (url.pathname.endsWith(`/list/${listId}`)) return Response.json({ id: listId, name: "Sprint 12", space: { id: state.space, name: "Engineering" }, statuses: [{ status: "to do" }, { status: "in review" }, { status: "done" }] });
    if (url.pathname.startsWith("/api/v2/task/")) return Response.json(task());
    return Response.json({ err: "Team not authorized", ECODE: "OAUTH_027" }, { status: 401 });
  });
  const service = new IntegrationOperations(ws.store, { home, caches: { health: new ProbeCache(), detection: new ProbeCache() },
    factories: new Map([["clickup:api", c => new ClickUpApiAdapter(c as ClickUpApiConnection, { fetch: api as unknown as typeof fetch, credential: () => TOKEN, budget: () => new RequestBudget("ClickUp", 100) })]]) });
  return { home, ws, local, service, api, state };
}

describe("ClickUp through the shared integration operations", () => {
  it("configures without a secret, maps a space, searches it, links by custom id and refreshes context without touching the ticket", async () => {
    const { home, ws, local, service, api, state } = setup();
    const configured = await service.execute({ action: "configure", providerId: "clickup", connectionId: "clickup", scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" });
    expect(configured).toEqual({ id: "clickup", providerId: "clickup", mode: "api", host: "app.clickup.com", scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" });
    const stored = readdirSync(join(home, "integrations", "machine")).filter(f => f.endsWith(".json")).map(f => readFileSync(join(home, "integrations", "machine", f), "utf8")).join("\n");
    expect(stored).not.toContain(TOKEN);
    await expect(service.execute({ action: "configure", providerId: "clickup", scopeId: "acme", credentialEnv: "STAPLE_CLICKUP_API_TOKEN" })).rejects.toMatchObject({ code: "validation" });

    expect(await service.execute({ action: "containers", connectionId: "clickup" })).toMatchObject({ items: [{ id: spaceId, kind: "space", key: `app.clickup.com/${workspace}/space/${spaceId}` }, { id: otherSpace }] });
    await expect(service.execute({ action: "containers", connectionId: "clickup", containerKind: "team" })).rejects.toMatchObject({ code: "validation" });
    const mapped = await service.execute({ action: "map", connectionId: "clickup", containerId: spaceId, actor: "ada" }) as { targets: Array<{ key: string; name: string; connectionId: string }> };
    expect(mapped.targets).toEqual([expect.objectContaining({ providerId: "clickup", kind: "space", containerId: spaceId, name: "Engineering", connectionId: "clickup" })]);

    const found = await service.execute({ action: "search", text: "importer" }) as { remote: Array<{ item: { key: string; spaceId: string } }>; scope: { mode: string } };
    expect(found.scope.mode).toBe("workspace");
    expect(found.remote.map(r => r.item.key)).toEqual(["DEV-42"]);
    const sent = new URL(String(api.mock.calls.find(([u]) => String(u).includes("/task?"))![0]));
    expect(sent.searchParams.getAll("space_ids[]")).toEqual([spaceId]);

    const original = ws.store.getIssue(local.id);
    await service.execute({ action: "link", connectionId: "clickup", key: "DEV-42", containerId: workspace, ref: local.id, confirmed: true, actor: "ada" });
    const resource = ws.store.externalLinks().list(local.id)[0]!.resource;
    expect(resource).toMatchObject({ ref: { providerId: "clickup", host: "app.clickup.com", scopeId: workspace, containerId: workspace, id: "86abc123", kind: "issue" },
      key: "DEV-42", url: "https://app.clickup.com/t/86abc123", status: { name: "in review" }, contextShared: false });
    expect(resource.body).toContain("- Status: in review (2 of 3 in this list: to do → in review → done)");
    expect(resource.body).toContain("- Waiting on: 86wait01");
    expect(ws.store.getIssue(local.id)).toEqual(original);

    // The same task by URL is the same resource; moving it to another space keeps the link.
    await service.execute({ action: "link", connectionId: "clickup", url: "https://app.clickup.com/t/86abc123", ref: local.id, confirmed: true, actor: "ada" });
    expect(ws.store.externalLinks().list(local.id)).toHaveLength(1);
    state.title = "Renamed in ClickUp"; state.space = otherSpace;
    await service.execute({ action: "refresh", resourceId: resource.id, actor: "ada" });
    expect(ws.store.externalLinks().resource(resource.id)).toMatchObject({ id: resource.id, title: "Renamed in ClickUp" });
    expect(ws.store.getIssue(local.id)).toEqual(original);

    // Now outside the mapped space: a live link is refused and offers the task's space by name.
    const second = ws.store.createIssue({ title: "Another" });
    const refused = await service.execute({ action: "link", connectionId: "clickup", url: "https://app.clickup.com/t/86abc123", ref: second.id, confirmed: true, actor: "ada" }).catch(e => e);
    expect(refused).toMatchObject({ code: "validation", detail: { reason: "outside_scope", target: { providerId: "clickup", kind: "space", containerId: otherSpace, name: "Ops" } } });
    expect(refused.message).toContain("Map Ops first");

    state.denied = true;
    await expect(service.execute({ action: "refresh", resourceId: resource.id, actor: "ada" })).rejects.toMatchObject({ code: "auth" });
    expect(await service.execute({ action: "health", connectionId: "clickup" })).toMatchObject({ health: [{ state: "unauthenticated", action: expect.stringContaining("STAPLE_CLICKUP_API_TOKEN") }] });
    expect(JSON.stringify(await service.execute({ action: "connections" }))).not.toContain(TOKEN);
  });

  it("maps a list and scopes search and linking to the lists a task is in", async () => {
    const { service, api } = setup();
    await service.execute({ action: "configure", providerId: "clickup", connectionId: "clickup", scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" });
    const lists = await service.execute({ action: "containers", connectionId: "clickup", containerKind: "list" }) as { items: Array<{ id: string; kind: string }>; nextCursor: string | null };
    expect(lists.items).toEqual([expect.objectContaining({ id: listId, kind: "list", name: "Engineering / Sprint 12", key: `app.clickup.com/${workspace}/list/${listId}` })]);
    expect(lists.nextCursor).not.toBeNull();
    await service.execute({ action: "map", connectionId: "clickup", containerId: listId, containerKind: "list", actor: "ada" });
    await service.execute({ action: "search", text: "" });
    const sent = new URL(String(api.mock.calls.find(([u]) => String(u).includes("/task?"))![0]));
    expect(sent.searchParams.getAll("list_ids[]")).toEqual([listId]);
    expect(sent.searchParams.has("space_ids[]")).toBe(false);
    expect(await service.execute({ action: "preview", connectionId: "clickup", url: "https://app.clickup.com/t/86abc123" })).toMatchObject({ item: { key: "DEV-42", listIds: [listId] } });
  });
});
