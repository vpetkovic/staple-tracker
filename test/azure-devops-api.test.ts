import { describe, expect, it, vi } from "vitest";
import { AzureDevOpsApiAdapter, discoverAzureDevOps, plainText, retryAfter, type AzureDevOpsApiConnection } from "../src/core/integrations/azure-devops-api.js";
import { IntegrationReader } from "../src/core/integrations/provider.js";

const account = "11111111-1111-4111-8111-111111111111";
const org = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const otherProject = "44444444-4444-4444-8444-444444444444";
const PAT = "fixture-pat-0123456789";
const config: AzureDevOpsApiConnection = { id: "ado-work", providerId: "azure_devops", mode: "api", host: "dev.azure.com", organization: "acme", account, scopeId: org, credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" };
const projects = { [projectId]: { id: projectId, name: "Fabrikam Web" }, [otherProject]: { id: otherProject, name: "Other" } };
const item = (id: number, project = "Fabrikam Web", extra: Record<string, unknown> = {}) => ({ id, rev: 3, fields: { "System.Id": id, "System.Title": `Work item ${id}`, "System.State": "Active", "System.TeamProject": project, "System.WorkItemType": "Bug", ...extra } });

interface Call { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null; headers: Record<string, string> }
type Route = (call: Call) => Response | undefined;
const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);

/** A fake dev.azure.com: identity and project lookups answer by default; `route` answers the rest. */
function setup(route: Route = () => undefined, options: { identity?: unknown } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: unknown, request: RequestInit | undefined) => {
    const url = new URL(String(input));
    const call: Call = { method: request?.method ?? "GET", path: url.pathname, query: url.searchParams, body: request?.body ? JSON.parse(String(request.body)) : null,
      headers: request?.headers as Record<string, string> };
    calls.push(call);
    const answered = route(call);
    if (answered) return answered;
    if (url.pathname === "/acme/_apis/connectionData") return json(options.identity ?? { authenticatedUser: { id: account, providerDisplayName: "Ada Lovelace" }, instanceId: org });
    const named = /^\/acme\/_apis\/projects\/(.+)$/.exec(url.pathname);
    if (named) {
      const key = decodeURIComponent(named[1]!);
      const found = Object.values(projects).find(p => p.id === key || p.name.toLowerCase() === key.toLowerCase());
      return found ? json(found) : json({ message: "TF200016: secret detail" }, { status: 404 });
    }
    throw new Error(`unrouted ${call.method} ${url.pathname}`);
  });
  const adapter = new AzureDevOpsApiAdapter(config, { fetch: fetch as typeof globalThis.fetch, credential: () => PAT, now: () => new Date("2026-11-25T12:00:00Z") });
  return { adapter, reader: new IntegrationReader(adapter), calls, fetch };
}

describe("read-only Azure DevOps adapter", () => {
  it("validates the bound identity and sends the PAT only as Basic auth with redirects suppressed", async () => {
    const { reader, calls } = setup();
    expect(await reader.validate()).toEqual({ state: "ready", identity: { login: "Ada Lovelace", organization: "acme" } });
    expect(calls[0]!.path).toBe("/acme/_apis/connectionData");
    expect(calls[0]!.headers).toMatchObject({ authorization: `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`, "x-tfs-fedauthredirect": "Suppress" });
    expect(reader.capabilities).toEqual({ readPullRequests: false, searchPullRequests: false });
  });

  it("lists projects across continuation-token pages and refuses a cursor from another binding", async () => {
    const { reader, calls } = setup(call => {
      if (call.path !== "/acme/_apis/projects") return undefined;
      return call.query.get("continuationToken") === "100"
        ? json({ count: 1, value: [projects[otherProject]] })
        : json({ count: 1, value: [projects[projectId]] }, { headers: { "x-ms-continuationtoken": "100" } });
    });
    const first = await reader.listContainers();
    expect(first.items).toEqual([{ id: projectId, name: "Fabrikam Web", url: "https://dev.azure.com/acme/Fabrikam%20Web" }]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor).not.toContain("100");
    const second = await reader.listContainers(first.nextCursor!);
    expect(second).toEqual({ items: [{ id: otherProject, name: "Other", url: "https://dev.azure.com/acme/Other" }], nextCursor: null });
    const listing = calls.filter(c => c.path === "/acme/_apis/projects");
    expect(listing.map(c => [c.query.get("$top"), c.query.get("continuationToken"), c.query.get("api-version")])).toEqual([["100", null, "7.1"], ["100", "100", "7.1"]]);
    const elsewhere = new AzureDevOpsApiAdapter({ ...config, id: "ado-other" }, { fetch: vi.fn(), credential: () => PAT });
    await expect(elsewhere.listContainers(first.nextCursor!)).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(reader.search("issue", { text: "", containerId: projectId, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "cursor_invalid" });
  });

  it("refuses a continuation token that repeats, so a provider loop cannot page forever", async () => {
    const { reader } = setup(call => call.path === "/acme/_apis/projects"
      ? json({ value: [projects[projectId]] }, { headers: { "x-ms-continuationtoken": "100" } }) : undefined);
    const first = await reader.listContainers();
    await expect(reader.listContainers(first.nextCursor!)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("searches one project with WIQL, escapes text, and pages by keyset on the work item id", async () => {
    const pageOne = Array.from({ length: 51 }, (_, i) => 200 - i);
    const { reader, calls } = setup(call => {
      if (call.path.endsWith("/_apis/wit/wiql")) {
        const query = String(call.body!.query);
        return json({ workItems: (query.includes("[System.Id] < 151") ? [151 - 1, 7] : pageOne).map(id => ({ id, url: "ignored" })) });
      }
      if (call.path === "/acme/_apis/wit/workitemsbatch") {
        const ids = call.body!.ids as number[];
        // Out of order on purpose: the adapter keeps the WIQL order.
        return json({ count: ids.length, value: [...ids].reverse().map(id => item(id)) });
      }
      return undefined;
    });
    const first = await reader.search("issue", { text: "O'Brien login", containerId: projectId });
    const wiql = calls.find(c => c.path.endsWith("/_apis/wit/wiql"))!;
    expect(wiql.path).toBe(`/acme/${projectId}/_apis/wit/wiql`);
    expect(wiql.query.get("$top")).toBe("51");
    expect(wiql.body!.query).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] CONTAINS 'O''Brien login' ORDER BY [System.Id] DESC");
    const batch = calls.find(c => c.path === "/acme/_apis/wit/workitemsbatch")!;
    expect(batch.body).toMatchObject({ ids: pageOne.slice(0, 50), errorPolicy: "omit" });
    expect(first.items).toHaveLength(50);
    expect(first.items.map(i => i.ref.id)).toEqual(pageOne.slice(0, 50).map(String));
    expect(first.items[0]).toEqual({
      ref: { providerId: "azure_devops", host: "dev.azure.com", scopeId: org, containerId: projectId, id: "200", kind: "issue" },
      key: "Fabrikam Web#200", url: "https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/200",
      title: "Work item 200", body: null, status: { id: "Active", name: "Active" }, fetchedAt: "2026-11-25T12:00:00.000Z",
    });
    expect(first.nextCursor).not.toBeNull();
    const second = await reader.search("issue", { text: "O'Brien login", containerId: projectId, cursor: first.nextCursor! });
    expect(String(calls.filter(c => c.path.endsWith("/_apis/wit/wiql")).at(-1)!.body!.query)).toContain("AND [System.Id] < 151 ORDER BY");
    expect(second.items.map(i => i.ref.id)).toEqual(["150", "7"]);
    expect(second.nextCursor).toBeNull();
    // Identity is verified once per adapter, not once per request.
    expect(calls.filter(c => c.path.endsWith("/connectionData"))).toHaveLength(1);
    expect(calls.every(c => c.method === "GET" || c.path.endsWith("/wiql") || c.path.endsWith("/workitemsbatch"))).toBe(true);
  });

  it("matches a typed number by id as well as title, and browses newest first with no text", async () => {
    const { reader, calls } = setup(call => {
      if (call.path.endsWith("/_apis/wit/wiql")) return json({ workItems: [] });
      return undefined;
    });
    await reader.search("issue", { text: "#42", containerId: projectId });
    expect(calls.at(-1)!.body!.query).toContain("([System.Title] CONTAINS '#42' OR [System.Id] = 42)");
    await reader.search("issue", { text: "", containerId: projectId });
    expect(calls.at(-1)!.body!.query).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.Id] DESC");
    expect(calls.some(c => c.path.endsWith("/workitemsbatch"))).toBe(false);
    await expect(reader.search("issue", { text: "bad\u0000text", containerId: projectId })).rejects.toMatchObject({ code: "validation" });
    await expect(reader.search("issue", { text: "x", projectId })).rejects.toMatchObject({ code: "validation" });
  });

  it("refuses a search result in another project and out-of-order WIQL ids", async () => {
    const foreign = setup(call => call.path.endsWith("/wiql") ? json({ workItems: [{ id: 9 }] })
      : call.path.endsWith("/workitemsbatch") ? json({ value: [item(9, "Other")] }) : undefined);
    await expect(foreign.reader.search("issue", { text: "", containerId: projectId })).rejects.toMatchObject({ code: "unavailable" });
    const unordered = setup(call => call.path.endsWith("/wiql") ? json({ workItems: [{ id: 3 }, { id: 9 }] }) : undefined);
    await expect(unordered.reader.search("issue", { text: "", containerId: projectId })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("resolves exact URLs and scoped numbers to immutable GUID identity, and follows renames on read", async () => {
    let title = "Original", projectName = "Fabrikam Web";
    const { reader } = setup(call => {
      if (call.path === "/acme/_apis/wit/workitemsbatch") {
        const ids = call.body!.ids as number[];
        return json({ value: ids.map(id => (id === 12 ? item(12, projectName, { "System.Title": title, "System.Description": "<div>Steps<br>to <b>reproduce</b> &amp; fix</div><ul><li>one</li></ul>" }) : null)) });
      }
      if (call.path === "/acme/_apis/projects/Renamed%20Web") return json({ id: projectId, name: "Renamed Web" });
      return undefined;
    });
    const url = "https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/12?src=WorkItemMention";
    const resolved = await reader.resolve({ url });
    expect(resolved).toEqual({ ref: { providerId: "azure_devops", host: "dev.azure.com", scopeId: org, containerId: projectId, id: "12", kind: "issue" },
      key: "Fabrikam Web#12", url: "https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/12" });
    expect(await reader.resolve({ url: "https://dev.azure.com/ACME/_workitems/edit/12/" })).toEqual(resolved);
    expect(await reader.resolve({ key: "12", containerId: projectId })).toEqual(resolved);
    expect(await reader.resolve({ key: "Fabrikam Web#12", containerId: projectId })).toEqual(resolved);
    await expect(reader.resolve({ key: "12", containerId: otherProject })).rejects.toMatchObject({ code: "validation" });
    expect(await reader.resolve({ url: "https://dev.azure.com/acme/Fabrikam%20Web/_workitems/edit/13" })).toBeNull();
    await expect(reader.resolve({ url: "https://dev.azure.com/contoso/Web/_workitems/edit/12" })).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("different organization") });
    await expect(reader.resolve({ url: "https://dev.azure.com/acme/Web/_git/repo/pullrequest/12" })).rejects.toMatchObject({ code: "validation" });
    await expect(reader.resolve({ key: "ENG-12", containerId: projectId })).rejects.toMatchObject({ code: "validation" });
    const read = await reader.read(resolved!.ref);
    expect(read).toMatchObject({ title: "Original", body: "Steps\nto reproduce & fix\n\n- one", status: { name: "Active" } });
    title = "Renamed title"; projectName = "Renamed Web";
    expect(await reader.read(resolved!.ref)).toMatchObject({ ref: resolved!.ref, key: "Renamed Web#12", title: "Renamed title", url: "https://dev.azure.com/acme/Renamed%20Web/_workitems/edit/12" });
  });

  it("reports a work item moved to another project instead of rewriting its identity", async () => {
    const { reader } = setup(call => call.path.endsWith("/workitemsbatch") ? json({ value: [item(12, "Other")] }) : undefined);
    await expect(reader.read({ providerId: "azure_devops", host: "dev.azure.com", scopeId: org, containerId: projectId, id: "12", kind: "issue" }))
      .rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("moved") });
    await expect(reader.read({ providerId: "azure_devops", host: "dev.azure.com", scopeId: org, containerId: projectId, id: "abc", kind: "issue" }))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("reads and names projects as containers, and treats a missing project as gone", async () => {
    const { reader } = setup();
    expect(await reader.readContainer(projectId, "project")).toEqual({ id: projectId, name: "Fabrikam Web", url: "https://dev.azure.com/acme/Fabrikam%20Web" });
    expect(await reader.readContainer("55555555-5555-4555-8555-555555555555", "project")).toBeNull();
    await expect(reader.readContainer(projectId, "team")).rejects.toMatchObject({ code: "validation" });
  });

  it("binds to the configured user and organization", async () => {
    const stranger = setup(undefined, { identity: { authenticatedUser: { id: "99999999-9999-4999-8999-999999999999", providerDisplayName: "Grace" }, instanceId: org } });
    expect(await stranger.reader.validate()).toMatchObject({ state: "account_mismatch", identity: { login: "Grace" } });
    await expect(stranger.reader.listContainers()).rejects.toMatchObject({ code: "auth", detail: { reason: "account_mismatch" } });
    const elsewhere = setup(undefined, { identity: { authenticatedUser: { id: account }, instanceId: "99999999-9999-4999-8999-999999999999" } });
    expect(await elsewhere.reader.validate()).toMatchObject({ state: "forbidden" });
    expect(stranger.calls.filter(c => !c.path.endsWith("/connectionData"))).toHaveLength(0);
  });

  it.each([
    [401, {}, "auth", "unauthenticated"],
    [203, { "content-type": "text/html" }, "auth", "unauthenticated"],
    [302, { location: "https://login.example/" }, "auth", "unauthenticated"],
    [403, {}, "forbidden", "forbidden"],
    [500, {}, "unavailable", "unavailable"],
    [200, { "content-type": "text/html" }, "unavailable", "unavailable"],
  ])("classifies HTTP %i without exposing the body or the token", async (status, headers, code, state) => {
    const { reader, adapter } = setup(() => new Response(status === 302 ? null : `secret body ${PAT}`, { status, headers }));
    const failure = await adapter.listContainers().catch(e => e);
    expect(failure).toMatchObject({ code });
    expect(JSON.stringify({ message: failure.message, detail: failure.detail })).not.toMatch(/secret body|fixture-pat/);
    const health = await reader.validate();
    expect(health.state).toBe(state);
    expect(JSON.stringify(health)).not.toMatch(/secret body|fixture-pat/);
  });

  it("reports rate limits with Retry-After seconds or an HTTP date", async () => {
    const seconds = setup(() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    expect(await seconds.reader.validate()).toMatchObject({ state: "rate_limited", retryAfterSeconds: 30 });
    const dated = setup(() => new Response(null, { status: 429, headers: { "retry-after": "Wed, 25 Nov 2026 12:02:00 GMT" } }));
    await expect(dated.adapter.listContainers()).rejects.toMatchObject({ code: "rate_limited", detail: { retryAfterSeconds: 120 } });
    expect(retryAfter(null, new Date())).toBeNull();
    expect(retryAfter("nonsense", new Date())).toBeNull();
    expect(retryAfter("999999", new Date())).toBe(3600);
  });

  it("says which variable is missing, and maps network failure and timeouts to offline", async () => {
    const missing = new AzureDevOpsApiAdapter(config, { fetch: vi.fn(), credential: () => undefined });
    expect(await missing.validate()).toMatchObject({ state: "unauthenticated", message: expect.stringContaining("STAPLE_AZURE_DEVOPS_PAT") });
    const spaced = new AzureDevOpsApiAdapter(config, { fetch: vi.fn(), credential: () => "two words" });
    expect(await spaced.validate()).toMatchObject({ state: "unauthenticated" });
    const down = new AzureDevOpsApiAdapter(config, { fetch: vi.fn(async () => { throw new TypeError(`fetch failed ${PAT}`); }), credential: () => PAT });
    const health = await down.validate();
    expect(health).toMatchObject({ state: "offline" });
    expect(JSON.stringify(health)).not.toContain(PAT);
    const controller = new AbortController();
    const cancelled = new AzureDevOpsApiAdapter(config, { fetch: vi.fn(async () => { controller.abort(new Error("stop")); throw new Error("aborted"); }), credential: () => PAT });
    await expect(cancelled.listContainers(undefined, { signal: controller.signal })).rejects.toThrow("stop");
  });

  it("refuses oversized and malformed responses", async () => {
    const big = setup(call => call.path.endsWith("/connectionData") ? new Response("x".repeat(2_000_001), { headers: { "content-type": "application/json" } }) : undefined);
    expect(await big.reader.validate()).toMatchObject({ state: "unavailable", message: expect.stringContaining("too large") });
    const odd = setup(call => call.path.endsWith("/connectionData") ? json({ authenticatedUser: { id: "not-a-guid" }, instanceId: org }) : undefined);
    expect(await odd.reader.validate()).toMatchObject({ state: "unavailable" });
  });

  it("discovers the user and organization GUIDs a token belongs to, for binding a connection", async () => {
    const { fetch } = setup();
    expect(await discoverAzureDevOps("acme", "STAPLE_AZURE_DEVOPS_PAT", { fetch: fetch as typeof globalThis.fetch, credential: () => PAT }))
      .toEqual({ account, scopeId: org, login: "Ada Lovelace" });
    expect(() => discoverAzureDevOps("acme/evil", "STAPLE_AZURE_DEVOPS_PAT")).toThrow(/organization name/);
    expect(() => discoverAzureDevOps("acme", PAT)).toThrow(/environment variable/);
    expect(() => new AzureDevOpsApiAdapter({ ...config, organization: "-bad" })).toThrow();
  });

  it("turns HTML descriptions into text without decoding entities twice", () => {
    expect(plainText("<p>a &amp;lt;b&amp;gt; &#39;c&#x27; &nbsp;</p><p>d</p>")).toBe("a &lt;b&gt; 'c'\n\nd");
    expect(plainText("<h1>T</h1>\n\n\n\n<div>x</div>")).toBe("T\n\nx");
    // Azure DevOps nests lists and paragraphs inside text; each block starts on its own line.
    expect(plainText("<div>Steps:<ul><li>Open the page</li><li>Do it</li></ul></div><p>Expected: works</p>")).toBe("Steps:\n- Open the page\n- Do it\n\nExpected: works");
  });
});
