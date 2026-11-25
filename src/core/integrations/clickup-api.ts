import { createHash } from "node:crypto";
import { z } from "zod";
import { StapleError } from "../types.js";
import { healthFromError } from "./health.js";
import { sharedBudget, type RequestBudget } from "./rate-limit.js";
import type { ConnectionHealth, ContainerKind, ExternalContainer, ExternalItem, ExternalItemRef, ExternalLocator, ExternalPage, ExternalSearch, IntegrationAdapter, ProviderReadOptions } from "./contracts.js";

const numericId = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const clickupConnectionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), providerId: z.literal("clickup"), mode: z.literal("api"),
  host: z.literal("app.clickup.com"), scopeId: numericId,
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
}).strict();
export type ClickUpApiConnection = z.infer<typeof clickupConnectionSchema>;

const API = "https://api.clickup.com/api/v2";
const HOST = "app.clickup.com";
/** ClickUp's published per-token floor (Free to Business); the server's X-RateLimit-Limit replaces it. */
const RATE_FLOOR = 100;
/** ClickUp's fixed page size for workspace task listings. */
const PAGE_SIZE = 100;
/** ClickUp v2 has no text search, so text is matched here over at most this many provider pages per page of results. */
const SEARCH_PAGES = 3;
const SEARCH_ENOUGH = 20;
const MAX_PAGE = 10_000;
const MAX_BYTES = 8_000_000;
const TIMEOUT_MS = 15_000;
const DESCRIPTION_BYTES = 200_000;
const CONTEXT_ITEMS = 50;
/** 401 codes meaning the token itself is missing, unknown or revoked. Any other 401 is something the token cannot see. */
const TOKEN_CODES = new Set(["OAUTH_017", "OAUTH_019", "OAUTH_021", "OAUTH_025", "OAUTH_077"]);
const TASK_ID = /^[0-9a-z]{3,32}$/;
const CUSTOM_ID = /^[A-Za-z][A-Za-z0-9]{0,19}-[0-9]{1,12}$/;

const idish = z.union([z.string().min(1).max(64), z.number().int().nonnegative()]).transform(String);
const name = z.string().max(8192);
const status = z.object({ id: z.string().max(256).optional(), status: z.string().min(1).max(512), type: z.string().max(64).optional() });
const subtask = z.object({ id: idish, custom_id: z.string().max(128).nullable().optional(), name, status: status.optional() });
const task = z.object({
  id: z.string().regex(TASK_ID), custom_id: z.string().max(128).nullable().optional(), name,
  markdown_description: z.string().nullable().optional(), description: z.string().nullable().optional(), text_content: z.string().nullable().optional(),
  status, team_id: idish,
  list: z.object({ id: idish, name: name.optional() }),
  folder: z.object({ id: idish, name: name.optional(), hidden: z.boolean().optional() }).nullable().optional(),
  space: z.object({ id: idish }),
  parent: idish.nullable().optional(),
  assignees: z.array(z.object({ username: z.string().max(256).nullable().optional() })).max(1000).optional(),
  dependencies: z.array(z.object({ task_id: idish, depends_on: idish })).max(5000).optional(),
  linked_tasks: z.array(z.object({ task_id: idish, link_id: idish })).max(5000).optional(),
  locations: z.array(z.object({ id: idish })).max(1000).optional(),
  subtasks: z.array(subtask).max(5000).optional(),
});
type Task = z.infer<typeof task>;
const space = z.object({ id: idish, name });
const list = z.object({ id: idish, name });
const listDetail = z.object({
  id: idish, name, folder: z.object({ id: idish, name: name.optional(), hidden: z.boolean().optional() }).nullable().optional(),
  space: z.object({ id: idish, name: name.optional() }), statuses: z.array(status).max(500).optional(),
});
type ListDetail = z.infer<typeof listDetail>;

/** Personal API token stays in the server environment. IO is injectable, never a configurable remote URL. */
export class ClickUpApiAdapter implements IntegrationAdapter {
  readonly scope;
  readonly connection;
  readonly label = "ClickUp";
  private readonly config: ClickUpApiConnection;
  private readonly fetch: typeof fetch;
  private readonly credential: () => string | undefined;
  private readonly now: () => Date;
  private readonly budgetFor: (token: string) => RequestBudget;
  constructor(config: ClickUpApiConnection, dependencies: {
    fetch?: typeof fetch; credential?: () => string | undefined; now?: () => Date; budget?: (token: string) => RequestBudget;
  } = {}) {
    const parsed = clickupConnectionSchema.safeParse(config);
    if (!parsed.success) throw new StapleError("validation", "Configure a ClickUp workspace id and the name of the environment variable holding the API token");
    this.config = parsed.data;
    this.scope = { providerId: "clickup", host: HOST, scopeId: this.config.scopeId };
    this.connection = { id: this.config.id, mode: "api" };
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.credential = dependencies.credential ?? (() => process.env[this.config.credentialEnv]);
    this.now = dependencies.now ?? (() => new Date());
    this.budgetFor = dependencies.budget
      ?? (token => sharedBudget(createHash("sha256").update(`clickup\0${token}`).digest("hex"), "ClickUp", RATE_FLOOR));
  }

  async validate(options?: ProviderReadOptions): Promise<ConnectionHealth> {
    try {
      const { user } = await this.get("/user", null, z.object({ user: z.object({ username: z.string().max(256).nullable().optional() }) }), options);
      const workspace = await this.workspace(options);
      return { state: "ready", identity: user.username ? { login: user.username, organization: workspace.name } : { login: workspace.name } };
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason;
      if (!(error instanceof StapleError)) throw error;
      return healthFromError(error);
    }
  }

  /** Spaces, the containers a workspace is usually mapped by. ClickUp does not page them. */
  async listContainers(cursor?: string, options?: ProviderReadOptions): Promise<ExternalPage<ExternalContainer>> {
    if (cursor !== undefined) throw new StapleError("cursor_invalid", "ClickUp spaces have no further pages; start again");
    return { items: (await this.spaces(options)).map(s => ({ id: s.id, name: s.name, url: this.spaceUrl(s.id) })), nextCursor: null };
  }

  /** Lists, one space per page: its folderless lists, then each folder's. */
  async listLists(cursor?: string, options?: ProviderReadOptions): Promise<ExternalPage<ExternalContainer>> {
    const index = cursor === undefined ? 0 : this.after(cursor, "lists");
    const spaces = await this.spaces(options);
    const at = spaces[index];
    if (!at) return { items: [], nextCursor: null };
    const archived = new URLSearchParams({ archived: "false" });
    const folders = await this.get(`/space/${at.id}/folder`, archived, z.object({ folders: z.array(z.object({ id: idish, name, hidden: z.boolean().optional(), lists: z.array(list).max(1000).optional() })).max(1000) }), options);
    const loose = await this.get(`/space/${at.id}/list`, archived, z.object({ lists: z.array(list).max(1000) }), options);
    const items = [
      ...loose.lists.map(l => ({ id: l.id, name: `${at.name} / ${l.name}`, url: this.listUrl(l.id) })),
      ...folders.folders.flatMap(f => (f.lists ?? []).map(l => ({ id: l.id, name: [at.name, f.hidden ? null : f.name, l.name].filter(Boolean).join(" / "), url: this.listUrl(l.id) }))),
    ];
    return { items, nextCursor: index + 1 < spaces.length ? this.cursor("lists", index + 1) : null };
  }

  async readContainer(id: string, kind: ContainerKind, options?: ProviderReadOptions): Promise<ExternalContainer | null> {
    if (!numericId.safeParse(id).success) throw new StapleError("validation", "ClickUp space and list ids are numbers");
    if (kind === "space") {
      const found = (await this.spaces(options)).find(s => s.id === id);
      return found ? { id: found.id, name: found.name, url: this.spaceUrl(found.id) } : null;
    }
    if (kind !== "list") throw new StapleError("validation", "ClickUp containers are spaces or lists");
    const detail = await this.list(id, options);
    if (!detail || !(await this.spaces(options)).some(s => s.id === detail.space.id)) return null;
    return { id: detail.id, name: listPath(detail), url: this.listUrl(detail.id) };
  }

  async searchIssues(search: ExternalSearch, options?: ProviderReadOptions): Promise<ExternalPage<ExternalItem>> {
    if (search.text.length > 256 || /[\x00-\x1f]/.test(search.text)) throw new StapleError("validation", "Use at most 256 characters of search text");
    if (search.containerId !== undefined && search.containerId !== this.scope.scopeId) throw new StapleError("validation", "Search the connected ClickUp workspace");
    for (const id of [search.spaceId, search.listId]) if (id !== undefined && !numericId.safeParse(id).success) throw new StapleError("validation", "ClickUp space and list ids are numbers");
    if (search.spaceId !== undefined && search.listId !== undefined) throw new StapleError("validation", "Search a ClickUp space or a list, not both");
    if (search.projectId !== undefined) throw new StapleError("validation", "ClickUp has no projects");
    const typed = search.text.trim().replace(/^#/, "");
    const needle = typed.toLowerCase();
    const binding = JSON.stringify(["tasks", needle, search.spaceId ?? null, search.listId ?? null]);
    let page = search.cursor === undefined ? 0 : this.after(search.cursor, binding);
    const inScope = (item: ExternalItem) => (!search.spaceId || item.spaceId === search.spaceId) && (!search.listId || !!item.listIds?.includes(search.listId));
    const items: ExternalItem[] = [];
    let last = false;
    for (let scanned = 0; !last && scanned < (needle ? SEARCH_PAGES : 1) && items.length < SEARCH_ENOUGH; scanned++) {
      if (page > MAX_PAGE) throw new StapleError("unavailable", "ClickUp search ran past its last page; narrow the search");
      const params = new URLSearchParams({ page: String(page), order_by: "updated", include_closed: "true", subtasks: "true", include_markdown_description: "true" });
      if (search.spaceId) params.append("space_ids[]", search.spaceId);
      if (search.listId) params.append("list_ids[]", search.listId);
      const data = await this.get(`/team/${this.scope.scopeId}/task`, params, z.object({ tasks: z.array(task).max(PAGE_SIZE), last_page: z.boolean().optional() }), options);
      for (const t of data.tasks) {
        if (needle && ![t.name, t.custom_id ?? "", t.id].some(v => v.toLowerCase().includes(needle))) continue;
        const item = this.item(t);
        // A task in several lists can match a filter through a list that is not its home; it is
        // shown only where Staple can also link it, so the scope check at link time agrees.
        if (inScope(item)) items.push(item);
      }
      last = data.last_page ?? data.tasks.length < PAGE_SIZE;
      page++;
    }
    // A pasted id is found wherever it was last updated: one exact read on the first page.
    if (search.cursor === undefined && (TASK_ID.test(typed) && /[0-9]/.test(typed) || CUSTOM_ID.test(typed))) {
      try {
        const exact = this.item(await this.task(typed, CUSTOM_ID.test(typed), options));
        if (inScope(exact) && !items.some(i => i.ref.id === exact.ref.id)) items.unshift(exact);
      } catch (error) {
        if (!(error instanceof StapleError) || (error.code !== "not_found" && error.code !== "validation")) throw error;
      }
    }
    return { items, nextCursor: last ? null : this.cursor(binding, page) };
  }

  async resolve(locator: ExternalLocator, options?: ProviderReadOptions) {
    let key: string;
    if ("url" in locator) {
      let match: RegExpExecArray | null = null;
      try {
        const u = new URL(locator.url);
        match = /^\/t\/(?:([0-9]+)\/)?([A-Za-z0-9-]+)\/?$/.exec(u.pathname);
        if (u.protocol !== "https:" || u.host !== HOST || u.username || u.password || !match) throw new Error();
      } catch { throw new StapleError("validation", "Paste an exact https://app.clickup.com/t/… task URL"); }
      if (match[1] && match[1] !== this.scope.scopeId) throw new StapleError("validation", "The ClickUp URL belongs to a different workspace; use a connection for that workspace");
      key = match[2]!;
    } else {
      if (locator.containerId !== this.scope.scopeId) throw new StapleError("validation", "Select the connected ClickUp workspace for this task id");
      key = locator.key.trim().replace(/^#/, "");
    }
    const custom = CUSTOM_ID.test(key);
    if (!custom && !TASK_ID.test(key)) throw new StapleError("validation", "Use a ClickUp task id such as 86abc123 or a custom id such as DEV-42");
    try {
      const item = this.item(await this.task(key, custom, options));
      return { ref: item.ref, key: item.key, url: item.url };
    } catch (error) {
      if (error instanceof StapleError && error.code === "not_found") return null;
      throw error;
    }
  }

  async readIssue(ref: ExternalItemRef, options?: ProviderReadOptions): Promise<ExternalItem> {
    if (ref.providerId !== "clickup" || ref.host !== HOST || ref.scopeId !== this.scope.scopeId || ref.containerId !== this.scope.scopeId || ref.kind !== "issue") {
      throw new StapleError("validation", "Reference belongs to a different ClickUp workspace");
    }
    if (!TASK_ID.test(ref.id)) throw new StapleError("validation", "ClickUp task ids are lowercase letters and digits");
    const source = await this.task(ref.id, false, options);
    let where: ListDetail | null = null;
    try { where = await this.list(source.list.id, options); }
    catch (error) { if (!(error instanceof StapleError) || (error.code !== "forbidden" && error.code !== "validation")) throw error; }
    const item = this.item(source, where);
    if (item.ref.id !== ref.id) throw new StapleError("unavailable", "ClickUp returned a different task; resolve its current URL again");
    return item;
  }

  private task(id: string, custom: boolean, options?: ProviderReadOptions): Promise<Task> {
    const params = new URLSearchParams({ include_subtasks: "true", include_markdown_description: "true" });
    if (custom) { params.set("custom_task_ids", "true"); params.set("team_id", this.scope.scopeId); }
    return this.get(`/task/${encodeURIComponent(id)}`, params, task, options);
  }

  /** A list's place and its ordered statuses; null when it is gone or invisible to the token. */
  private async list(id: string, options?: ProviderReadOptions): Promise<ListDetail | null> {
    try { return await this.get(`/list/${id}`, null, listDetail, options); }
    catch (error) { if (error instanceof StapleError && error.code === "not_found") return null; throw error; }
  }

  private async workspace(options?: ProviderReadOptions) {
    const { teams } = await this.get("/team", null, z.object({ teams: z.array(z.object({ id: idish, name })).max(1000) }), options);
    const found = teams.find(t => t.id === this.scope.scopeId);
    if (!found) throw new StapleError("forbidden", `The API token in ${this.config.credentialEnv} cannot see ClickUp workspace ${this.scope.scopeId}.`);
    return found;
  }

  private async spaces(options?: ProviderReadOptions) {
    return (await this.get(`/team/${this.scope.scopeId}/space`, new URLSearchParams({ archived: "false" }), z.object({ spaces: z.array(space).max(1000) }), options)).spaces;
  }

  private item(source: Task, where: ListDetail | null = null): ExternalItem {
    if (source.team_id !== this.scope.scopeId) throw new StapleError("forbidden", "ClickUp returned a task in a different workspace");
    const listIds = [...new Set([source.list.id, ...(source.locations ?? []).map(l => l.id)])];
    return {
      ref: { ...this.scope, containerId: this.scope.scopeId, id: source.id, kind: "issue" },
      key: source.custom_id || source.id, url: `https://${HOST}/t/${source.id}`,
      title: source.name, body: taskBody(source, where),
      status: { id: source.status.id || source.status.status, name: source.status.status },
      fetchedAt: this.now().toISOString(), spaceId: source.space.id, listIds,
    };
  }

  private spaceUrl(id: string) { return `https://${HOST}/${this.scope.scopeId}/v/s/${id}`; }
  private listUrl(id: string) { return `https://${HOST}/${this.scope.scopeId}/v/li/${id}`; }

  private binding(binding: string) {
    return createHash("sha256").update(JSON.stringify([this.config.id, this.scope.scopeId, this.config.credentialEnv, binding])).digest("hex");
  }
  private cursor(binding: string, position: number) {
    return Buffer.from(JSON.stringify([this.binding(binding), position])).toString("base64url");
  }
  private after(cursor: string, binding: string): number {
    try {
      if (cursor.length > 512) throw new Error();
      const [hash, position] = z.tuple([z.string(), z.number().int().nonnegative().max(MAX_PAGE)]).parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (hash !== this.binding(binding)) throw new Error();
      return position;
    } catch { throw new StapleError("cursor_invalid", "ClickUp search or connection changed; start again"); }
  }

  private async get<S extends z.ZodTypeAny>(path: string, params: URLSearchParams | null, shape: S, options?: ProviderReadOptions): Promise<z.infer<S>> {
    options?.signal?.throwIfAborted();
    const token = this.credential();
    if (!token || token.length > 4096 || /\s/.test(token)) throw new StapleError("auth", `${this.config.credentialEnv} isn't set where Staple runs.`);
    const budget = this.budgetFor(token);
    const url = `${API}${path}${params?.size ? `?${params}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      // Waits briefly, or throws rate_limited with the provider's own retry time.
      await budget.take(options?.signal);
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      try {
        const response = await this.fetch(url, { method: "GET", redirect: "error", signal, headers: { authorization: token, accept: "application/json" } });
        const wait = budget.observe(response.headers, response.status);
        if (response.status === 429) {
          await response.body?.cancel();
          // One retry, and only when the provider's own reset is close; otherwise the next take refuses.
          if (attempt === 0) continue;
          throw new StapleError("rate_limited", "ClickUp's rate limit is reached.", { retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) });
        }
        if (response.status === 401) {
          const code = errorCode(await readBounded(response, 65_536).catch(() => null));
          if (code !== null && TOKEN_CODES.has(code)) throw new StapleError("auth", `ClickUp rejected the API token in ${this.config.credentialEnv}.`);
          throw new StapleError("not_found", "ClickUp could not find this item, or the token cannot see it");
        }
        if (response.status === 403) { await response.body?.cancel(); throw new StapleError("forbidden", "ClickUp denied access to this resource"); }
        if (response.status === 404) { await response.body?.cancel(); throw new StapleError("not_found", "ClickUp could not find this item, or the token cannot see it"); }
        if (response.status === 400) { await response.body?.cancel(); throw new StapleError("validation", "ClickUp refused this request"); }
        if (!response.ok) { await response.body?.cancel(); throw new StapleError("unavailable", "ClickUp API is unavailable; try again later"); }
        let payload: unknown;
        try { payload = JSON.parse(await readBounded(response, MAX_BYTES)); }
        catch (error) { if (error instanceof StapleError) throw error; throw new StapleError("unavailable", "ClickUp returned an unsupported response"); }
        const parsed = shape.safeParse(payload);
        if (!parsed.success) throw new StapleError("unavailable", "ClickUp returned an unsupported response");
        return parsed.data;
      } catch (error) {
        if (options?.signal?.aborted) throw options.signal.reason;
        if (error instanceof StapleError) throw error;
        throw new StapleError("offline", timeout.aborted ? "ClickUp request timed out; try again later" : "Cannot reach ClickUp; check this machine's network connection");
      }
    }
  }
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new StapleError("unavailable", "ClickUp returned an empty response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new StapleError("unavailable", "ClickUp response is too large; narrow the search");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

function errorCode(text: string | null): string | null {
  try { const code = (JSON.parse(text ?? "") as { ECODE?: unknown }).ECODE; return typeof code === "string" ? code : null; }
  catch { return null; }
}

function listPath(detail: ListDetail): string {
  return [detail.space.name, detail.folder && !detail.folder.hidden ? detail.folder.name : null, detail.name].filter(Boolean).join(" / ");
}

/** Markdown-inert text for one context line: provider names never become links, emphasis or headings. */
function plain(text: string, max = 200): string {
  const short = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return short.replace(/\s+/g, " ").replace(/([\\`*_[\]<>#|~!])/g, "\\$1");
}

function capped(values: string[]): string {
  const shown = values.slice(0, CONTEXT_ITEMS).join(", ");
  return values.length > CONTEXT_ITEMS ? `${shown} and ${values.length - CONTEXT_ITEMS} more` : shown;
}

/**
 * The description, then what ClickUp knows around the task: where it lives, its status
 * among its list's own statuses, who has it, and its native parent, subtasks and dependencies.
 * Context only: none of it changes a Staple ticket.
 */
function taskBody(source: Task, where: ListDetail | null): string {
  let description = (source.markdown_description ?? source.description ?? source.text_content ?? "").trim();
  if (Buffer.byteLength(description) > DESCRIPTION_BYTES) {
    description = `${Buffer.from(description).subarray(0, DESCRIPTION_BYTES).toString("utf8").replace(/�+$/, "")}\n\n…`;
  }
  const lines: string[] = [];
  const place = where ? listPath(where) : source.list.name;
  if (place) lines.push(`- List: ${plain(place)}`);
  const states = where?.statuses?.map(s => s.status) ?? [];
  const step = states.findIndex(s => s.toLowerCase() === source.status.status.toLowerCase());
  lines.push(step >= 0
    ? `- Status: ${plain(source.status.status)} (${step + 1} of ${states.length} in this list: ${states.map(s => plain(s, 60)).join(" → ")})`
    : `- Status: ${plain(source.status.status)}`);
  const assignees = (source.assignees ?? []).map(a => a.username).filter((u): u is string => !!u);
  if (assignees.length) lines.push(`- Assignees: ${capped(assignees.map(a => plain(a, 80)))}`);
  if (source.parent) lines.push(`- Parent: ${plain(source.parent)}`);
  const subtasks = source.subtasks ?? [];
  if (subtasks.length) lines.push(`- Subtasks: ${capped(subtasks.map(s => `${plain(s.custom_id || s.id)} ${plain(s.name, 120)}${s.status ? ` (${plain(s.status.status, 60)})` : ""}`))}`);
  const dependencies = source.dependencies ?? [];
  const waiting = dependencies.filter(d => d.task_id === source.id).map(d => plain(d.depends_on));
  const blocking = dependencies.filter(d => d.depends_on === source.id).map(d => plain(d.task_id));
  if (waiting.length) lines.push(`- Waiting on: ${capped(waiting)}`);
  if (blocking.length) lines.push(`- Blocking: ${capped(blocking)}`);
  const linked = (source.linked_tasks ?? []).map(l => plain(l.task_id === source.id ? l.link_id : l.task_id));
  if (linked.length) lines.push(`- Linked: ${capped(linked)}`);
  const context = `**ClickUp**\n\n${lines.join("\n")}`;
  return description ? `${description}\n\n---\n\n${context}` : context;
}
