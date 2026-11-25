import { describe, expect, it, vi } from "vitest";
import { ClickUpApiAdapter, type ClickUpApiConnection } from "../src/core/integrations/clickup-api.js";
import { IntegrationReader } from "../src/core/integrations/provider.js";
import { RequestBudget } from "../src/core/integrations/rate-limit.js";

const workspace = "9012345";
const spaceId = "90170001";
const listId = "901700100";
const config: ClickUpApiConnection = { id: "clickup-work", providerId: "clickup", mode: "api", host: "app.clickup.com", scopeId: workspace, credentialEnv: "STAPLE_CLICKUP_TOKEN" };
const TOKEN = "pk_fixture_secret_token";
const task = {
  id: "86abc123", custom_id: "DEV-42", name: "Ship the importer", markdown_description: "Source **context**",
  status: { id: "sc901_review", status: "in review", type: "custom" }, team_id: workspace, url: "https://app.clickup.com/t/86abc123",
  list: { id: listId, name: "Sprint 12" }, folder: { id: "9017000", name: "Sprints", hidden: false }, space: { id: spaceId },
  parent: "86parent1", assignees: [{ id: 1, username: "ada", email: "ada@example.test" }],
  dependencies: [{ task_id: "86abc123", depends_on: "86wait01", type: 0 }, { task_id: "86block1", depends_on: "86abc123", type: 1 }],
  linked_tasks: [{ task_id: "86abc123", link_id: "86rel001" }],
  subtasks: [{ id: "86sub001", custom_id: "DEV-43", name: "Write tests", status: { status: "done" } }],
};
const listDetail = {
  id: listId, name: "Sprint 12", folder: { id: "9017000", name: "Sprints", hidden: false }, space: { id: spaceId, name: "Engineering" },
  statuses: ["to do", "in progress", "in review", "done", "closed"].map(status => ({ status })),
};

type Route = (url: URL) => Response | Promise<Response>;
function clock(start = 1_764_000_000_000) {
  const state = { now: start, slept: [] as number[] };
  return { state, clock: { now: () => state.now, sleep: async (ms: number) => { state.slept.push(ms); state.now += ms; } } };
}
function setup(route: Route, options: { token?: string | undefined; limit?: number } = {}) {
  const fetch = vi.fn(async (input: unknown, _request?: RequestInit) => route(new URL(String(input))));
  const time = clock();
  const budget = new RequestBudget("ClickUp", options.limit ?? 100, time.clock);
  const adapter = new ClickUpApiAdapter(config, { fetch: fetch as unknown as typeof globalThis.fetch, credential: () => ("token" in options ? options.token : TOKEN),
    now: () => new Date("2026-11-25T12:00:00Z"), budget: () => budget });
  return { adapter, fetch, reader: new IntegrationReader(adapter), time, budget };
}
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
const tasksRoute = (pages: Array<{ tasks: unknown[]; last_page?: boolean }>): Route => url => {
  if (url.pathname.endsWith(`/team/${workspace}/task`)) return json(pages[Number(url.searchParams.get("page"))] ?? { tasks: [], last_page: true });
  if (url.pathname.startsWith("/api/v2/task/")) return json({ err: "Team not authorized", ECODE: "OAUTH_027" }, { status: 401 });
  return json({}, { status: 500 });
};

describe("read-only ClickUp API adapter", () => {
  it("checks the token sees the workspace and names the connection, sending the personal token without Bearer", async () => {
    const { reader, fetch } = setup(url => url.pathname === "/api/v2/user" ? json({ user: { id: 7, username: "ada", email: "ada@example.test" } })
      : json({ teams: [{ id: workspace, name: "Acme" }, { id: "1", name: "Other" }] }));
    expect(await reader.validate()).toEqual({ state: "ready", identity: { login: "ada", organization: "Acme" } });
    const [url, request] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.clickup.com/api/v2/user");
    expect(request).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: TOKEN } });
    expect(fetch.mock.calls.every(([, r]) => r?.method === "GET")).toBe(true);
    const elsewhere = setup(url => url.pathname === "/api/v2/user" ? json({ user: { username: "ada" } }) : json({ teams: [{ id: "1", name: "Other" }] }));
    expect(await elsewhere.adapter.validate()).toEqual({ state: "forbidden", message: "The API token in STAPLE_CLICKUP_TOKEN cannot see ClickUp workspace 9012345." });
  });

  it("lists spaces, then lists one space per page with folder paths, and reads containers only inside the workspace", async () => {
    const spaces = { spaces: [{ id: spaceId, name: "Engineering" }, { id: "90170002", name: "Ops" }] };
    const { reader } = setup(url => {
      if (url.pathname.endsWith("/space")) return json(spaces);
      if (url.pathname.endsWith(`/space/${spaceId}/folder`)) return json({ folders: [{ id: "9017000", name: "Sprints", lists: [{ id: listId, name: "Sprint 12" }] }, { id: "9017009", name: "hidden", hidden: true, lists: [{ id: "901700999", name: "Inbox" }] }] });
      if (url.pathname.endsWith(`/space/${spaceId}/list`)) return json({ lists: [{ id: "901700200", name: "Backlog" }] });
      if (url.pathname.endsWith("/space/90170002/folder")) return json({ folders: [] });
      if (url.pathname.endsWith("/space/90170002/list")) return json({ lists: [{ id: "901700300", name: "Runbooks" }] });
      if (url.pathname.endsWith(`/list/${listId}`)) return json(listDetail);
      if (url.pathname.endsWith("/list/901700777")) return json({ ...listDetail, id: "901700777", space: { id: "666", name: "Foreign" } });
      return json({ err: "Team not authorized", ECODE: "OAUTH_027" }, { status: 401 });
    });
    expect(await reader.listContainers()).toEqual({ items: [
      { id: spaceId, name: "Engineering", url: `https://app.clickup.com/${workspace}/v/s/${spaceId}` },
      { id: "90170002", name: "Ops", url: `https://app.clickup.com/${workspace}/v/s/90170002` }], nextCursor: null });
    const first = await reader.listLists();
    expect(first.items.map(i => i.name)).toEqual(["Engineering / Backlog", "Engineering / Sprints / Sprint 12", "Engineering / Inbox"]);
    expect(first.items[1]!.url).toBe(`https://app.clickup.com/${workspace}/v/li/${listId}`);
    const second = await reader.listLists(first.nextCursor!);
    expect(second).toMatchObject({ items: [{ id: "901700300", name: "Ops / Runbooks" }], nextCursor: null });
    expect(await reader.readContainer(spaceId, "space")).toMatchObject({ name: "Engineering" });
    expect(await reader.readContainer("123", "space")).toBeNull();
    expect(await reader.readContainer(listId, "list")).toMatchObject({ name: "Engineering / Sprints / Sprint 12" });
    expect(await reader.readContainer("901700777", "list")).toBeNull();
    expect(await reader.readContainer("901700888", "list")).toBeNull();
    await expect(reader.readContainer("abc", "list")).rejects.toMatchObject({ code: "validation" });
    await expect(reader.readContainer(listId, "team")).rejects.toMatchObject({ code: "validation" });
  });

  it("pages workspace tasks by page number and last_page, with cursors bound to the query and connection", async () => {
    const { reader, adapter, fetch } = setup(tasksRoute([{ tasks: [task], last_page: false }, { tasks: [{ ...task, id: "86def456", custom_id: null }], last_page: true }]));
    const first = await reader.search("issue", { text: "", spaceId });
    expect(first.items[0]).toMatchObject({ ref: { providerId: "clickup", host: "app.clickup.com", scopeId: workspace, containerId: workspace, id: "86abc123", kind: "issue" },
      key: "DEV-42", url: "https://app.clickup.com/t/86abc123", title: "Ship the importer", status: { id: "sc901_review", name: "in review" }, spaceId, listIds: [listId] });
    const sent = new URL(String(fetch.mock.calls[0]![0]));
    expect(Object.fromEntries(sent.searchParams)).toMatchObject({ page: "0", order_by: "updated", include_closed: "true", subtasks: "true", "space_ids[]": spaceId });
    expect(first.nextCursor).not.toBeNull();
    const second = await reader.search("issue", { text: "", spaceId, cursor: first.nextCursor! });
    expect(second).toMatchObject({ items: [{ key: "86def456" }], nextCursor: null });
    expect(new URL(String(fetch.mock.calls.at(-1)![0])).searchParams.get("page")).toBe("1");
    await expect(reader.search("issue", { text: "x", spaceId, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(reader.search("issue", { text: "", listId, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "cursor_invalid" });
    const other = new ClickUpApiAdapter({ ...config, id: "other" }, { fetch: fetch as unknown as typeof globalThis.fetch, credential: () => TOKEN });
    await expect(other.searchIssues({ text: "", spaceId, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(adapter.searchIssues({ text: "", cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "cursor_invalid" });
  });

  it("ends pagination on a short page when last_page is absent", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...task, id: `86p${String(i).padStart(4, "0")}`, custom_id: null }));
    const { reader } = setup(tasksRoute([{ tasks: full }, { tasks: [task] }]));
    const first = await reader.search("issue", { text: "" });
    expect(first.items).toHaveLength(100);
    expect((await reader.search("issue", { text: "", cursor: first.nextCursor! })).nextCursor).toBeNull();
  });

  it("matches text on name, custom id and id over at most three provider pages, and finds an exact id anywhere", async () => {
    const page = (n: number) => ({ tasks: [{ ...task, id: `86pg${n}000`, custom_id: null, name: n === 2 ? "Importer retry" : "Other work" }], last_page: false });
    const { reader, fetch } = setup(url => {
      if (url.pathname.endsWith(`/team/${workspace}/task`)) return json(page(Number(url.searchParams.get("page"))));
      if (url.pathname === "/api/v2/task/DEV-7") {
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ custom_task_ids: "true", team_id: workspace });
        return json({ ...task, id: "86old007", custom_id: "DEV-7", name: "Old task" });
      }
      return json({ err: "Team not authorized", ECODE: "OAUTH_027" }, { status: 401 });
    });
    const found = await reader.search("issue", { text: "importer" });
    expect(found.items.map(i => i.ref.id)).toEqual(["86pg2000"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(found.nextCursor).not.toBeNull();
    const exact = await reader.search("issue", { text: "#DEV-7" });
    expect(exact.items[0]).toMatchObject({ key: "DEV-7", title: "Old task" });
    // An id-like word that is no task is simply not found; the connection is not blamed.
    expect((await reader.search("issue", { text: "86zzz999" })).items).toEqual([]);
  });

  it("shows only tasks that lie in the requested space or one of the task's lists", async () => {
    const { reader } = setup(tasksRoute([{ tasks: [{ ...task, space: { id: "123" } }, task], last_page: true }]));
    expect((await reader.search("issue", { text: "", spaceId })).items.map(i => i.spaceId)).toEqual([spaceId]);
    const lists = setup(tasksRoute([{ tasks: [{ ...task, locations: [{ id: "901700555" }] }], last_page: true }]));
    expect((await lists.reader.search("issue", { text: "", listId: "901700555" })).items).toHaveLength(1);
    expect((await lists.reader.search("issue", { text: "", listId: "901700556" })).items).toEqual([]);
    await expect(reader.search("issue", { text: "", spaceId, listId })).rejects.toMatchObject({ code: "validation" });
    await expect(reader.search("issue", { text: "", containerId: "1" })).rejects.toMatchObject({ code: "validation" });
  });

  it("resolves task URLs, workspace custom-id URLs and keys to the immutable task id", async () => {
    const { reader, fetch } = setup(url => url.pathname.startsWith("/api/v2/task/") ? json(task) : json({}, { status: 500 }));
    const byUrl = await reader.resolve({ url: "https://app.clickup.com/t/86abc123?comment=1" });
    expect(byUrl).toEqual({ ref: { providerId: "clickup", host: "app.clickup.com", scopeId: workspace, containerId: workspace, id: "86abc123", kind: "issue" }, key: "DEV-42", url: "https://app.clickup.com/t/86abc123" });
    expect(await reader.resolve({ url: `https://app.clickup.com/t/${workspace}/DEV-42` })).toEqual(byUrl);
    expect(new URL(String(fetch.mock.calls.at(-1)![0])).pathname).toBe("/api/v2/task/DEV-42");
    expect(await reader.resolve({ key: "DEV-42", containerId: workspace })).toEqual(byUrl);
    expect(await reader.resolve({ key: "86abc123", containerId: workspace })).toEqual(byUrl);
    const calls = fetch.mock.calls.length;
    for (const url of ["https://app.clickup.com/t/1234/DEV-42", "https://evil.test/t/86abc123", "https://user:pw@app.clickup.com/t/86abc123", "https://app.clickup.com/9012345/v/li/1", "https://app.clickup.com/t/86ABC!"]) {
      await expect(reader.resolve({ url })).rejects.toMatchObject({ code: "validation" });
    }
    await expect(reader.resolve({ key: "DEV-42", containerId: "1" })).rejects.toMatchObject({ code: "validation" });
    await expect(reader.resolve({ key: "not a key", containerId: workspace })).rejects.toMatchObject({ code: "validation" });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("reads a task with its list's statuses, native dependencies, subtasks and parent as context", async () => {
    const { reader } = setup(url => url.pathname.endsWith(`/list/${listId}`) ? json(listDetail) : json(task));
    const ref = { providerId: "clickup", host: "app.clickup.com", scopeId: workspace, containerId: workspace, id: "86abc123", kind: "issue" as const };
    const item = await reader.read(ref);
    expect(item.body).toBe([
      "Source **context**", "", "---", "", "**ClickUp**", "",
      "- List: Engineering / Sprints / Sprint 12",
      "- Status: in review (3 of 5 in this list: to do → in progress → in review → done → closed)",
      "- Assignees: ada",
      "- Parent: 86parent1",
      "- Subtasks: DEV-43 Write tests (done)",
      "- Waiting on: 86wait01",
      "- Blocking: 86block1",
      "- Linked: 86rel001",
    ].join("\n"));
    expect(item.body).not.toContain("example.test");
    // A list the token cannot read leaves the rest of the context.
    const hidden = setup(url => url.pathname.endsWith(`/list/${listId}`) ? json({ err: "Team not authorized", ECODE: "OAUTH_027" }, { status: 401 }) : json({ ...task, markdown_description: null, name: "*[x](y)*" }));
    const bare = await hidden.reader.read(ref);
    expect(bare.body).toMatch(/^\*\*ClickUp\*\*\n\n- List: Sprint 12\n- Status: in review\n/);
    await expect(reader.read({ ...ref, containerId: spaceId })).rejects.toMatchObject({ code: "validation" });
    const foreign = setup(() => json({ ...task, team_id: "1" }));
    await expect(foreign.reader.read(ref)).rejects.toMatchObject({ code: "forbidden" });
  });

  it.each([
    [401, { err: "Token invalid", ECODE: "OAUTH_025" }, "auth"],
    [401, { err: "Oauth token not found", ECODE: "OAUTH_019" }, "auth"],
    [401, { err: "Team not authorized", ECODE: "OAUTH_027" }, "not_found"],
    [403, {}, "forbidden"], [404, {}, "not_found"], [400, {}, "validation"], [500, {}, "unavailable"], [503, {}, "unavailable"],
  ])("classifies HTTP %s %j without exposing the body or token", async (status, body, code) => {
    const { adapter } = setup(() => json({ ...body, detail: `${TOKEN} private provider details` }, { status }));
    const error = await adapter.listContainers().catch(e => e);
    expect(error).toMatchObject({ code });
    expect(`${error.message} ${JSON.stringify(error.detail ?? {})}`).not.toMatch(/pk_fixture|private provider/);
  });

  it("treats an unknown task as not found, not as a broken connection", async () => {
    const { adapter } = setup(() => json({ err: "Team not authorized", ECODE: "OAUTH_027" }, { status: 401 }));
    expect(await adapter.resolve({ url: "https://app.clickup.com/t/86nothere" })).toBeNull();
    const revoked = setup(() => json({ err: "Token invalid", ECODE: "OAUTH_025" }, { status: 401 }));
    expect(await revoked.adapter.validate()).toEqual({ state: "unauthenticated", message: "ClickUp rejected the API token in STAPLE_CLICKUP_TOKEN." });
  });

  it("retries one 429 after a short Retry-After, and otherwise reports rate_limited with the provider's wait", async () => {
    let calls = 0;
    const { adapter, time } = setup(() => ++calls === 1 ? json({}, { status: 429, headers: { "retry-after": "2" } }) : json({ spaces: [] }));
    expect(await adapter.listContainers()).toEqual({ items: [], nextCursor: null });
    expect(time.state.slept).toEqual([2_000]);
    const long = setup(() => json({ err: "Rate limit" }, { status: 429, headers: { "x-ratelimit-reset": String(Math.floor(1_764_000_000_000 / 1000) + 40) } }));
    await expect(long.adapter.listContainers()).rejects.toMatchObject({ code: "rate_limited", detail: { retryAfterSeconds: 40 } });
    expect(long.fetch).toHaveBeenCalledTimes(1);
    // The budget remembers: the next read is refused without a request.
    await expect(long.adapter.listContainers()).rejects.toMatchObject({ code: "rate_limited" });
    expect(long.fetch).toHaveBeenCalledTimes(1);
    expect(await long.adapter.validate()).toMatchObject({ state: "rate_limited", retryAfterSeconds: 40 });
    const twice = setup(() => json({}, { status: 429, headers: { "retry-after": "1" } }));
    await expect(twice.adapter.listContainers()).rejects.toMatchObject({ code: "rate_limited", detail: { retryAfterSeconds: 1 } });
    expect(twice.fetch).toHaveBeenCalledTimes(2);
  });

  it("fails a multi-page search whole when the budget runs out midway, never returning a truncated page", async () => {
    const { reader, fetch } = setup(tasksRoute([{ tasks: [task], last_page: false }, { tasks: [task], last_page: false }, { tasks: [task], last_page: false }]), { limit: 2 });
    await expect(reader.search("issue", { text: "nothing matches this" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("makes no request without a token and redacts network failures, oversize bodies, timeouts and cancellation", async () => {
    const missing = setup(() => json({}), { token: undefined });
    expect(await missing.adapter.validate()).toEqual({ state: "unauthenticated", message: "STAPLE_CLICKUP_TOKEN isn't set where Staple runs." });
    expect(missing.fetch).not.toHaveBeenCalled();
    const spaced = setup(() => json({}), { token: "pk_ bad" });
    await expect(spaced.adapter.listContainers()).rejects.toMatchObject({ code: "auth" });
    const down = setup(() => { throw new Error(`${TOKEN} network details`); });
    const offline = await down.adapter.listContainers().catch(e => e);
    expect(offline).toMatchObject({ code: "offline", message: "Cannot reach ClickUp; check this machine's network connection" });
    const huge = setup(() => new Response("x".repeat(8_000_001)));
    await expect(huge.adapter.listContainers()).rejects.toThrow("too large");
    const odd = setup(() => json({ spaces: "nope" }));
    await expect(odd.adapter.listContainers()).rejects.toMatchObject({ code: "unavailable", message: "ClickUp returned an unsupported response" });
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(down.adapter.listContainers(undefined, { signal })).rejects.toThrow("cancelled");
    const timeout = AbortSignal.timeout;
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(5));
    try {
      const stalled = new ClickUpApiAdapter(config, { credential: () => TOKEN, budget: () => new RequestBudget("ClickUp", 100),
        fetch: async (_url, request) => new Promise((_resolve, reject) => request!.signal!.addEventListener("abort", () => reject(new Error(TOKEN)), { once: true })) });
      await expect(stalled.listContainers()).rejects.toMatchObject({ code: "offline", message: "ClickUp request timed out; try again later" });
      expect(spy).toHaveBeenCalledWith(15_000);
    } finally { spy.mockRestore(); }
  });

  it("refuses an invalid connection and has no pull requests", () => {
    expect(() => new ClickUpApiAdapter({ ...config, scopeId: "acme" })).toThrow();
    expect(() => new ClickUpApiAdapter({ ...config, credentialEnv: "pk_secret" })).toThrow();
    expect(new IntegrationReader(new ClickUpApiAdapter(config)).capabilities).toEqual({ readPullRequests: false, searchPullRequests: false });
  });
});
