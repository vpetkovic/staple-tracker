import { createHash } from "node:crypto";
import { z } from "zod";
import { StapleError } from "../types.js";
import { healthFromError } from "./health.js";
import type { ConnectionHealth, ContainerKind, ExternalContainer, ExternalItem, ExternalItemRef, ExternalLocator, ExternalPage, ExternalSearch, IntegrationAdapter, ProviderReadOptions } from "./contracts.js";

const uuid = z.string().uuid().toLowerCase();
/** Azure DevOps organization names: letters, digits and hyphens, starting and ending with a letter or digit. */
const ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;
export const azureDevOpsConnectionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), providerId: z.literal("azure_devops"), mode: z.literal("api"),
  host: z.literal("dev.azure.com"), organization: z.string().regex(ORGANIZATION),
  /** The user and organization GUIDs the token was bound to; names are display context only. */
  account: uuid, scopeId: uuid,
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
}).strict();
export type AzureDevOpsApiConnection = z.infer<typeof azureDevOpsConnectionSchema>;

export interface AzureDevOpsDependencies { fetch?: typeof fetch; credential?: () => string | undefined; now?: () => Date }
export interface AzureDevOpsIdentity { account: string; scopeId: string; login: string | null }

const HOST = "dev.azure.com";
const API_VERSION = "7.1";
const PAGE_SIZE = 50;
const PROJECT_PAGE_SIZE = 100;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
const MAX_ID = 2_147_483_647;
const FIELDS = ["System.Id", "System.Title", "System.State", "System.TeamProject", "System.WorkItemType", "System.Description"];

const project = z.object({ id: uuid, name: z.string().min(1).max(256) });
const connectionData = z.object({ authenticatedUser: z.object({ id: uuid, descriptor: z.string().max(512).optional(), providerDisplayName: z.string().max(256).optional() }), instanceId: uuid });
/** The public-access user connectionData answers with, with status 200, when the token is wrong or absent. */
const ANONYMOUS_USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const workItem = z.object({
  id: z.number().int().positive().max(MAX_ID),
  fields: z.object({
    "System.Title": z.string().max(8192),
    "System.TeamProject": z.string().min(1).max(256),
    "System.State": z.string().max(256).optional(),
    "System.Description": z.string().max(1_000_000).optional(),
  }),
});
type WorkItem = z.infer<typeof workItem>;
type Project = z.infer<typeof project>;

/**
 * The HTTPS transport: one fixed origin per organization, the personal access token from the
 * server environment, bounded time and size, and every failure translated to the StapleError
 * taxonomy without the response body or the token. `fetch` is injectable; the origin is not.
 */
class AzureDevOpsClient {
  private readonly fetch: typeof fetch;
  private readonly credential: () => string | undefined;
  readonly now: () => Date;
  constructor(readonly organization: string, private readonly credentialEnv: string, dependencies: AzureDevOpsDependencies = {}) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.credential = dependencies.credential ?? (() => process.env[credentialEnv]);
    this.now = dependencies.now ?? (() => new Date());
  }

  async identity(options?: ProviderReadOptions): Promise<AzureDevOpsIdentity> {
    // connectionData is unversioned; it names the token's user and the organization's GUID.
    const { data } = await this.request("_apis/connectionData", connectionData, { versioned: false }, options);
    // Never bind to, or read as, the anonymous user: a rejected token is a sign-in problem.
    if (data.authenticatedUser.id === ANONYMOUS_USER || data.authenticatedUser.descriptor?.startsWith("System:PublicAccess")) {
      throw new StapleError("auth", `Azure DevOps rejected the personal access token in ${this.credentialEnv}.`);
    }
    return { account: data.authenticatedUser.id, scopeId: data.instanceId, login: data.authenticatedUser.providerDisplayName?.trim() || null };
  }

  async request<T>(path: string, schema: z.ZodType<T>, init: { body?: unknown; query?: Record<string, string>; versioned?: boolean }, options?: ProviderReadOptions) {
    options?.signal?.throwIfAborted();
    const key = this.credential();
    if (!key || key.length > 4096 || /\s/.test(key)) throw new StapleError("auth", `${this.credentialEnv} isn't set where Staple runs.`);
    const url = new URL(`https://${HOST}/${encodeURIComponent(this.organization)}/${path}`);
    for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
    if (init.versioned !== false) url.searchParams.set("api-version", API_VERSION);
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const response = await this.fetch(url.href, {
        method: init.body === undefined ? "GET" : "POST", redirect: "manual", signal,
        headers: {
          accept: "application/json", authorization: `Basic ${Buffer.from(`:${key}`).toString("base64")}`,
          // Without this an unauthenticated call answers with a sign-in page instead of 401.
          "x-tfs-fedauthredirect": "Suppress",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const status = response.status;
      if (status === 401 || status === 203 || (status >= 300 && status < 400)) {
        await response.body?.cancel();
        throw new StapleError("auth", `Azure DevOps rejected the personal access token in ${this.credentialEnv}.`);
      }
      if (status === 403) { await response.body?.cancel(); throw new StapleError("forbidden", "Azure DevOps denied access to this resource"); }
      if (status === 404) { await response.body?.cancel(); throw new StapleError("not_found", "Azure DevOps resource was not found or is inaccessible"); }
      if (status === 429) {
        const retry = retryAfter(response.headers.get("retry-after"), this.now());
        await response.body?.cancel();
        throw new StapleError("rate_limited", "Azure DevOps's rate limit is reached.", retry ? { retryAfterSeconds: retry } : undefined);
      }
      if (!response.ok) { await response.body?.cancel(); throw new StapleError("unavailable", "Azure DevOps is unavailable or could not complete the request; try again later"); }
      if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel();
        throw new StapleError("unavailable", "Azure DevOps returned an unsupported response");
      }
      const parsed = schema.safeParse(await readJson(response));
      if (!parsed.success) throw new StapleError("unavailable", "Azure DevOps returned an unsupported response");
      return { data: parsed.data, headers: response.headers };
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason;
      if (error instanceof StapleError) throw error;
      throw new StapleError("offline", timeout.aborted ? "Azure DevOps request timed out; try again later" : "Cannot reach Azure DevOps; check this machine's network connection");
    }
  }
}

/** The organization and user a token belongs to, for binding a new connection. Reads nothing else. */
export function discoverAzureDevOps(organization: string, credentialEnv: string, dependencies: AzureDevOpsDependencies = {}): Promise<AzureDevOpsIdentity> {
  if (!ORGANIZATION.test(organization)) throw new StapleError("validation", "Use the Azure DevOps organization name from dev.azure.com/<organization>");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(credentialEnv)) throw new StapleError("validation", "Name the environment variable that holds the personal access token, such as STAPLE_AZURE_DEVOPS_PAT");
  return new AzureDevOpsClient(organization, credentialEnv, dependencies).identity();
}

/**
 * Read-only Azure DevOps Services adapter. Identity is the organization GUID, the project GUID and
 * the numeric work item id; organization and project names only build URLs and display keys.
 * Every command verifies the token's user and organization once before reading anything.
 */
export class AzureDevOpsApiAdapter implements IntegrationAdapter {
  readonly scope;
  readonly connection;
  readonly label = "Azure DevOps";
  private readonly client: AzureDevOpsClient;
  private bound: Promise<AzureDevOpsIdentity> | null = null;
  private readonly projects = new Map<string, Promise<Project>>();
  constructor(private readonly config: AzureDevOpsApiConnection, dependencies: AzureDevOpsDependencies = {}) {
    const parsed = azureDevOpsConnectionSchema.safeParse(config);
    if (!parsed.success) throw new StapleError("validation", "Configure an Azure DevOps organization, its GUID, your user GUID and a credential environment variable");
    this.config = parsed.data;
    this.scope = { providerId: "azure_devops", host: HOST, scopeId: this.config.scopeId };
    this.connection = { id: config.id, mode: "api" };
    this.client = new AzureDevOpsClient(this.config.organization, this.config.credentialEnv, dependencies);
  }

  async validate(options?: ProviderReadOptions): Promise<ConnectionHealth> {
    try {
      const who = await this.verify(options);
      return { state: "ready", identity: who.login ? { login: who.login, organization: this.config.organization } : null };
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason;
      if (!(error instanceof StapleError)) throw error;
      return healthFromError(error);
    }
  }

  async listContainers(cursor?: string, options?: ProviderReadOptions): Promise<ExternalPage<ExternalContainer>> {
    const binding = "projects";
    const token = this.after(cursor, binding);
    await this.verify(options);
    const { data, headers } = await this.get("_apis/projects", z.object({ value: z.array(project).max(PROJECT_PAGE_SIZE) }),
      { $top: String(PROJECT_PAGE_SIZE), ...(token ? { continuationToken: token } : {}) }, options);
    for (const p of data.value) this.projects.set(p.name.toLowerCase(), Promise.resolve(p));
    const next = headers.get("x-ms-continuationtoken")?.trim() || null;
    if (next !== null && (next === token || next.length > 2048)) throw new StapleError("unavailable", "Azure DevOps returned an invalid pagination token");
    return { items: data.value.map(p => this.container(p)), nextCursor: next && data.value.length ? this.encode(binding, next) : null };
  }

  async readContainer(id: string, kind: ContainerKind, options?: ProviderReadOptions): Promise<ExternalContainer | null> {
    if (kind !== "project") throw new StapleError("validation", "Azure DevOps containers are projects");
    this.checkUuid(id);
    await this.verify(options);
    try {
      const { data } = await this.get(`_apis/projects/${id}`, project, {}, options);
      return data.id === id.toLowerCase() ? this.container(data) : null;
    } catch (error) {
      if (error instanceof StapleError && error.code === "not_found") return null;
      throw error;
    }
  }

  /**
   * WIQL over one project, newest work item first. WIQL has no cursor, so pages are keyset on the
   * immutable id: the cursor carries the last id shown and the next query asks for smaller ones.
   */
  async searchIssues(search: ExternalSearch, options?: ProviderReadOptions): Promise<ExternalPage<ExternalItem>> {
    const text = search.text.trim();
    if (text.length > 256 || /[\x00-\x1f\x7f]/.test(text)) throw new StapleError("validation", "Use at most 256 characters of search text");
    if (search.projectId !== undefined) throw new StapleError("validation", "Azure DevOps searches a project container");
    if (search.containerId !== undefined) this.checkUuid(search.containerId);
    const binding = JSON.stringify(["work-items", text, search.containerId ?? null]);
    const before = this.after(search.cursor, binding);
    if (before !== null && !/^[1-9][0-9]{0,9}$/.test(before)) throw new StapleError("cursor_invalid", "Azure DevOps search changed; start again");
    await this.verify(options);
    const scoped = search.containerId ? await this.project(search.containerId, options) : null;
    const conditions = [scoped ? "[System.TeamProject] = @project" : null, textCondition(text), before ? `[System.Id] < ${before}` : null].filter(Boolean);
    const query = `SELECT [System.Id] FROM WorkItems WHERE ${conditions.length ? conditions.join(" AND ") : "[System.Id] > 0"} ORDER BY [System.Id] DESC`;
    const { data } = await this.post(`${scoped ? `${scoped.id}/` : ""}_apis/wit/wiql`, { query },
      z.object({ workItems: z.array(z.object({ id: z.number().int().positive().max(MAX_ID) })).max(PAGE_SIZE + 1) }), { $top: String(PAGE_SIZE + 1) }, options);
    const ids = data.workItems.map(w => w.id);
    if (ids.some((id, i) => (i > 0 && id >= ids[i - 1]!) || (before !== null && id >= Number(before)))) {
      throw new StapleError("unavailable", "Azure DevOps returned results out of order; start the search again");
    }
    const shown = ids.slice(0, PAGE_SIZE);
    const items: ExternalItem[] = [];
    for (const source of await this.batch(shown, options)) {
      const owner = await this.projectNamed(source.fields["System.TeamProject"], options);
      if (scoped && owner.id !== scoped.id) throw new StapleError("unavailable", "Azure DevOps returned a work item outside the selected project");
      items.push(this.item(source, owner));
    }
    return { items, nextCursor: ids.length > PAGE_SIZE ? this.encode(binding, String(shown.at(-1))) : null };
  }

  async resolve(locator: ExternalLocator, options?: ProviderReadOptions) {
    let id: number;
    if ("url" in locator) {
      try {
        const u = new URL(locator.url);
        const match = /^\/([^/]+)\/(?:[^/]+\/)?_workitems\/edit\/([1-9][0-9]{0,9})\/?$/.exec(u.pathname);
        if (u.protocol !== "https:" || u.host !== HOST || u.username || u.password || !match) throw new Error();
        if (decodeURIComponent(match[1]!).toLowerCase() !== this.config.organization.toLowerCase()) {
          throw new StapleError("validation", "The Azure DevOps URL belongs to a different organization; use a connection for that organization");
        }
        id = Number(match[2]);
      } catch (error) {
        if (error instanceof StapleError) throw error;
        throw new StapleError("validation", "Paste an exact https://dev.azure.com/organization/project/_workitems/edit/123 URL");
      }
    } else {
      this.checkUuid(locator.containerId);
      const match = /^(?:[^#]*#)?([1-9][0-9]{0,9})$/.exec(locator.key.trim());
      if (!match) throw new StapleError("validation", "Use an Azure DevOps work item number such as 123 and select its project");
      id = Number(match[1]);
    }
    if (id > MAX_ID) throw new StapleError("validation", "Azure DevOps work item numbers are at most 2147483647");
    try {
      const item = await this.readById(id, options);
      if ("containerId" in locator && item.ref.containerId !== locator.containerId.toLowerCase()) throw new StapleError("validation", "Azure DevOps work item does not belong to the selected project");
      return { ref: item.ref, key: item.key, url: item.url };
    } catch (error) {
      if (error instanceof StapleError && error.code === "not_found") return null;
      throw error;
    }
  }

  async readIssue(ref: ExternalItemRef, options?: ProviderReadOptions): Promise<ExternalItem> {
    if (ref.providerId !== "azure_devops" || ref.host !== HOST || ref.scopeId !== this.scope.scopeId || ref.kind !== "issue") throw new StapleError("validation", "Reference belongs to a different Azure DevOps scope");
    this.checkUuid(ref.containerId);
    if (!/^[1-9][0-9]{0,9}$/.test(ref.id) || Number(ref.id) > MAX_ID) throw new StapleError("validation", "Azure DevOps work item ids are numbers");
    const item = await this.readById(Number(ref.id), options);
    if (item.ref.containerId !== ref.containerId) throw new StapleError("unavailable", "Azure DevOps work item moved to another project; resolve its current URL again");
    return item;
  }

  private async readById(id: number, options?: ProviderReadOptions): Promise<ExternalItem> {
    await this.verify(options);
    const [source] = await this.batch([id], options);
    if (!source) throw new StapleError("not_found", "Azure DevOps work item was not found or is inaccessible");
    return this.item(source, await this.projectNamed(source.fields["System.TeamProject"], options));
  }

  /** At most 200 ids per call; missing or inaccessible items are omitted, and the order is the ids' order. */
  private async batch(ids: number[], options?: ProviderReadOptions): Promise<WorkItem[]> {
    if (!ids.length) return [];
    const { data } = await this.post("_apis/wit/workitemsbatch", { ids, fields: FIELDS, errorPolicy: "omit" },
      z.object({ value: z.array(workItem.nullable()).max(ids.length) }), {}, options);
    const byId = new Map(data.value.flatMap(w => (w ? [[w.id, w] as const] : [])));
    return ids.flatMap(id => byId.get(id) ?? []);
  }

  private project(id: string, options?: ProviderReadOptions): Promise<Project> {
    return this.cachedProject(id.toLowerCase(), `_apis/projects/${id.toLowerCase()}`, options);
  }

  /** A work item names its project; the project GUID is the container identity. */
  private projectNamed(name: string, options?: ProviderReadOptions): Promise<Project> {
    return this.cachedProject(name.toLowerCase(), `_apis/projects/${encodeURIComponent(name)}`, options);
  }

  private cachedProject(key: string, path: string, options?: ProviderReadOptions): Promise<Project> {
    let held = this.projects.get(key);
    if (!held) {
      held = this.get(path, project, {}, options).then(r => r.data);
      held.catch(() => this.projects.delete(key));
      this.projects.set(key, held);
    }
    return held;
  }

  private item(source: WorkItem, owner: Project): ExternalItem {
    const state = source.fields["System.State"]?.trim();
    const body = source.fields["System.Description"] ? plainText(source.fields["System.Description"]) : "";
    return {
      ref: { ...this.scope, containerId: owner.id, id: String(source.id), kind: "issue" },
      key: `${owner.name}#${source.id}`,
      url: `https://${HOST}/${this.config.organization}/${encodeURIComponent(owner.name)}/_workitems/edit/${source.id}`,
      title: source.fields["System.Title"], body: body || null,
      status: state ? { id: state, name: state } : null, fetchedAt: this.client.now().toISOString(),
    };
  }

  private container(p: Project): ExternalContainer {
    return { id: p.id, name: p.name, url: `https://${HOST}/${this.config.organization}/${encodeURIComponent(p.name)}` };
  }

  /** The token must still belong to the bound user and organization. Checked once per adapter. */
  private verify(options?: ProviderReadOptions): Promise<AzureDevOpsIdentity> {
    this.bound ??= this.client.identity(options).then(who => {
      if (who.scopeId !== this.scope.scopeId) throw new StapleError("forbidden", `The token in ${this.config.credentialEnv} answers for a different Azure DevOps organization than ${this.config.organization}.`);
      if (who.account !== this.config.account) {
        throw new StapleError("auth", `The token in ${this.config.credentialEnv} belongs to ${who.login ?? "another user"}, not the Azure DevOps user this connection expects.`,
          { reason: "account_mismatch", ...(who.login ? { login: who.login } : {}) });
      }
      return who;
    });
    const bound = this.bound;
    bound.catch(() => { if (this.bound === bound) this.bound = null; });
    return bound;
  }

  private get<T>(path: string, schema: z.ZodType<T>, query: Record<string, string>, options?: ProviderReadOptions) {
    return this.client.request(path, schema, { query }, options);
  }
  private post<T>(path: string, body: unknown, schema: z.ZodType<T>, query: Record<string, string>, options?: ProviderReadOptions) {
    return this.client.request(path, schema, { body, query }, options);
  }

  private checkUuid(id: string) { if (!uuid.safeParse(id).success) throw new StapleError("validation", "Azure DevOps project identifiers must be GUIDs"); }
  private binding(binding: string) {
    return createHash("sha256").update(JSON.stringify([this.config.id, this.config.account, this.scope.scopeId, this.config.organization, binding])).digest("hex");
  }
  private after(cursor: string | undefined, binding: string): string | null {
    if (cursor === undefined) return null;
    try {
      if (cursor.length > 4096) throw new Error();
      const parsed = z.tuple([z.string(), z.string().min(1).max(2048)]).parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (parsed[0] !== this.binding(binding)) throw new Error();
      return parsed[1];
    } catch { throw new StapleError("cursor_invalid", "Azure DevOps search or connection changed; start again"); }
  }
  private encode(binding: string, position: string) {
    return Buffer.from(JSON.stringify([this.binding(binding), position])).toString("base64url");
  }
}

/** Title text, and the number itself when the text is one (`123` or `#123`). WIQL strings double their quotes. */
function textCondition(text: string): string | null {
  if (!text) return null;
  const title = `[System.Title] CONTAINS '${text.replace(/'/g, "''")}'`;
  const number = /^#?([1-9][0-9]{0,9})$/.exec(text);
  return number && Number(number[1]) <= MAX_ID ? `(${title} OR [System.Id] = ${number[1]})` : title;
}

/** Retry-After as seconds or an HTTP date, bounded to an hour; null when absent or unreadable. */
export function retryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const seconds = /^\s*\d+\s*$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now.getTime()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : null;
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new StapleError("unavailable", "Azure DevOps returned an empty response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw new StapleError("unavailable", "Azure DevOps response is too large; narrow the search");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new StapleError("unavailable", "Azure DevOps returned an unsupported response"); }
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
/**
 * Work item descriptions are HTML; saved context is markdown text, rendered without HTML. Keep the
 * words, a line per block and a "- " per list item. Entities decode last, so `&lt;b&gt;` stays text.
 */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/?(p|div|h[1-6]|tr|pre|blockquote|table)\b[^>]*>|<\/(ul|ol)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      const lower = name.toLowerCase();
      return lower === "amp" ? "&" : ENTITIES[lower] ?? whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
