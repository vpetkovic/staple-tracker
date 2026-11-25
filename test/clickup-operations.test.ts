import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { ClickUpApiAdapter, ClickUpCatalogue, discoverClickUp, type ClickUpApiConnection } from "../src/core/integrations/clickup-api.js";
import type { ExternalItem, IntegrationAdapter } from "../src/core/integrations/contracts.js";
import { resourcePayload, type ResourceRow } from "../src/core/integrations/link-store.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { RequestBudget } from "../src/core/integrations/rate-limit.js";
import { ProbeCache } from "../src/core/integrations/health.js";

const workspace = "9012345", spaceId = "90170001", otherSpace = "90170002", listId = "901700100", ACCOUNT = "4401";
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
  const state = { title: "Ship the importer", space: spaceId, denied: false, user: ACCOUNT };
  const task = () => ({ id: "86abc123", custom_id: "DEV-42", name: state.title, markdown_description: "Private source body",
    status: { status: "in review" }, team_id: workspace, list: { id: listId, name: "Sprint 12" }, space: { id: state.space },
    dependencies: [{ task_id: "86abc123", depends_on: "86wait01" }] });
  const api = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (state.denied) return Response.json({ err: "Token invalid", ECODE: "OAUTH_025" }, { status: 401 });
    if (url.pathname === "/api/v2/user") return Response.json({ user: { id: state.user, username: state.user === ACCOUNT ? "ada" : "grace" } });
    if (url.pathname === "/api/v2/team") return Response.json({ teams: [{ id: workspace, name: "Acme" }, { id: "777", name: "Other Co" }] });
    if (url.pathname === "/api/v2/task/86other1") return Response.json({ id: "86other1", name: "Elsewhere", status: { status: "open" }, team_id: "777", list: { id: "7701" }, space: { id: "7702" } });
    if (url.pathname.endsWith("/folder")) return Response.json({ folders: [] });
    if (url.pathname.endsWith(`/space/${spaceId}/list`)) return Response.json({ lists: [{ id: listId, name: "Sprint 12" }] });
    if (url.pathname.endsWith("/space")) return Response.json({ spaces: [{ id: spaceId, name: "Engineering" }, { id: otherSpace, name: "Ops" }] });
    if (url.pathname.endsWith(`/team/${workspace}/task`)) return Response.json({ tasks: [task()], last_page: true });
    if (url.pathname.endsWith(`/list/${listId}`)) return Response.json({ id: listId, name: "Sprint 12", space: { id: state.space, name: "Engineering" }, statuses: [{ status: "to do" }, { status: "in review" }, { status: "done" }] });
    if (url.pathname.startsWith("/api/v2/task/")) return Response.json(task());
    return Response.json({ err: "Team not authorized", ECODE: "OAUTH_027" }, { status: 401 });
  });
  const deps = { fetch: api as unknown as typeof fetch, credential: () => TOKEN, budget: () => new RequestBudget("ClickUp", 100), catalogue: new ClickUpCatalogue() };
  const service = new IntegrationOperations(ws.store, { home, caches: { health: new ProbeCache(), detection: new ProbeCache() },
    discoverClickUp: (scopeId, credentialEnv) => discoverClickUp(scopeId, credentialEnv, deps),
    factories: new Map([["clickup:api", c => new ClickUpApiAdapter(c as ClickUpApiConnection, deps)]]) });
  return { home, ws, local, service, api, state };
}

describe("ClickUp through the shared integration operations", () => {
  it("configures without a secret, maps a space, searches it, links by custom id and refreshes context without touching the ticket", async () => {
    const { home, ws, local, service, api, state } = setup();
    const configured = await service.execute({ action: "configure", providerId: "clickup", connectionId: "clickup", scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" });
    // The user is read from the token and bound; nobody typed it.
    expect(configured).toEqual({ id: "clickup", providerId: "clickup", mode: "api", host: "app.clickup.com", account: ACCOUNT, scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" });
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
    const refused = (await service.execute({ action: "link", connectionId: "clickup", url: "https://app.clickup.com/t/86abc123", ref: second.id, confirmed: true, actor: "ada" }).catch((e: unknown) => e)) as Error;
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

  it("a pasted task URL from another workspace leaves the connection healthy", async () => {
    const { ws, service, api } = setup();
    await service.execute({ action: "configure", providerId: "clickup", connectionId: "cu", scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" });
    api.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v2/user") return Response.json({ user: { id: ACCOUNT, username: "ada" } });
      if (url.pathname === "/api/v2/task/86other1") return Response.json({ id: "86other1", name: "Elsewhere", status: { status: "open" }, team_id: "777", list: { id: "1" }, space: { id: "2" } });
      return Response.json({ err: "unexpected" }, { status: 500 });
    });
    await expect(service.execute({ action: "preview", connectionId: "cu", url: "https://app.clickup.com/t/86other1" })).rejects.toMatchObject({ code: "validation", detail: { reason: "other_workspace" } });
    const { connections } = await service.execute({ action: "connections" }) as { connections: Array<{ health?: { state: string } | null }> };
    expect(connections[0]!.health?.state).not.toBe("forbidden");
    ws.store.db.close();
  });

  it("refuses a configure whose token belongs to someone other than the expected user, and a token that changed user later", async () => {
    const { service, state, ws } = setup();
    await expect(service.execute({ action: "configure", providerId: "clickup", connectionId: "cu", account: "999", scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" }))
      .rejects.toMatchObject({ code: "auth", detail: { reason: "account_mismatch", login: "ada" } });
    expect((await service.execute({ action: "connections" }) as { connections: unknown[] }).connections).toEqual([]);
    await expect(service.execute({ action: "configure", providerId: "clickup", scopeId: "1234", credentialEnv: "STAPLE_CLICKUP_API_TOKEN" })).rejects.toMatchObject({ code: "forbidden" });
    await service.execute({ action: "configure", providerId: "clickup", connectionId: "cu", account: ACCOUNT, scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" });
    state.user = "999";
    expect(await service.execute({ action: "health", connectionId: "cu", force: true })).toMatchObject({ health: [{ state: "account_mismatch", identity: { login: "grace" },
      action: "Set STAPLE_CLICKUP_API_TOKEN to the token of the ClickUp user this connection was made with, or connect ClickUp again as grace." }] });
    ws.store.db.close();
  });

  it("reads a pasted task URL through whichever connected workspace holds it", async () => {
    const { service, ws, local } = setup();
    await service.execute({ action: "configure", providerId: "clickup", connectionId: "acme", scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" });
    await service.execute({ action: "configure", providerId: "clickup", connectionId: "other", scopeId: "777", credentialEnv: "STAPLE_CLICKUP_OTHER_TOKEN" });
    // The dialog named the Acme connection; the task is in the other workspace.
    const preview = await service.execute({ action: "preview", connectionId: "acme", url: "https://app.clickup.com/t/86other1" }) as { item: ExternalItem };
    expect(preview.item.ref).toMatchObject({ scopeId: "777", containerId: "777", id: "86other1" });
    await service.execute({ action: "link", url: "https://app.clickup.com/t/86abc123", ref: local.id, confirmed: true, actor: "ada" });
    expect(ws.store.externalLinks().list(local.id)[0]!.resource.ref.scopeId).toBe(workspace);
    ws.store.db.close();
  });

  it("keeps where a task sat with its saved copy on this machine, never on the wire", async () => {
    const { service, ws, local } = setup();
    await service.execute({ action: "configure", providerId: "clickup", connectionId: "cu", scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" });
    await service.execute({ action: "link", connectionId: "cu", url: "https://app.clickup.com/t/86abc123", ref: local.id, confirmed: true, actor: "ada" });
    const id = ws.store.externalLinks().list(local.id)[0]!.resource.id;
    expect(ws.store.externalLinks().resource(id)).toMatchObject({ spaceId, listIds: [listId], status: { id: "in review", name: "in review" } });
    const shared = ws.store.externalLinks().shareContext(id, true, "ada");
    expect(shared).toMatchObject({ contextShared: true, spaceId, listIds: [listId] });
    const payload = resourcePayload(ws.store.db.prepare("SELECT * FROM external_resources WHERE id=?").get(id) as unknown as ResourceRow);
    expect(payload).toMatchObject({ context: { shared: true, status: { id: "in review", name: "in review" } } });
    expect(JSON.stringify(payload)).not.toContain(spaceId);
    ws.store.db.close();
  });

  it("offers no target to map when a live read does not say which space a task is in", async () => {
    const home = mkdtempSync(join(tmpdir(), "staple-clickup-ops-")); dirs.push(home); process.env.STAPLE_HOME = home;
    const ws = initWorkspace({ global: true, slug: "clickup-nospace" });
    const local = ws.store.createIssue({ title: "Local" });
    const item: ExternalItem = { ref: { providerId: "clickup", host: "app.clickup.com", scopeId: workspace, containerId: workspace, id: "86abc123", kind: "issue" },
      key: "86abc123", url: "https://app.clickup.com/t/86abc123", title: "No space", body: null, status: { id: "open", name: "open" }, fetchedAt: "2026-11-25T12:00:00Z" };
    const adapter: IntegrationAdapter = { scope: { providerId: "clickup", host: "app.clickup.com", scopeId: workspace }, label: "ClickUp", connection: { id: "cu", mode: "api" },
      validate: async () => ({ state: "ready" }), listContainers: async () => ({ items: [], nextCursor: null }),
      readContainer: async (id: string) => ({ id, name: "Engineering", url: `https://app.clickup.com/${workspace}/v/s/${id}` }),
      searchIssues: async () => ({ items: [], nextCursor: null }), resolve: async () => item, readIssue: async () => item };
    const service = new IntegrationOperations(ws.store, { home, caches: { health: new ProbeCache(), detection: new ProbeCache() },
      discoverClickUp: async () => ({ account: ACCOUNT, login: "ada", organization: "Acme" }), factories: new Map([["clickup:api", () => adapter]]) });
    await service.execute({ action: "configure", providerId: "clickup", connectionId: "cu", scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_API_TOKEN" });
    await service.execute({ action: "map", connectionId: "cu", containerId: spaceId, actor: "ada" });
    await expect(service.execute({ action: "link", connectionId: "cu", url: item.url, ref: local.id, confirmed: true, actor: "ada" }))
      .rejects.toMatchObject({ code: "unavailable", message: "ClickUp did not say which space this task is in; refresh it and try again" });
    ws.store.db.close();
  });
});
