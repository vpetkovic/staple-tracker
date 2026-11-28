import { createHash } from "node:crypto";
import { z } from "zod";
import { StapleError } from "../types.js";
import { healthFromError } from "./health.js";
import { isExternalStatusCategory } from "./contracts.js";
import type { ConnectionHealth, ContainerKind, ExternalContainer, ExternalItem, ExternalItemRef, ExternalLocator, ExternalSearch, IntegrationAdapter, ProviderReadOptions } from "./contracts.js";

const uuid = z.string().uuid().toLowerCase();
export const linearConnectionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), providerId: z.literal("linear"), mode: z.literal("api"),
  host: z.literal("linear.app"), account: uuid, scopeId: uuid,
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
}).strict();
export type LinearApiConnection = z.infer<typeof linearConnectionSchema>;
/** Who a key answers for: the user and organization a connection binds to, and their names for display. */
export interface LinearIdentity { account: string; scopeId: string; login: string | null; organization: string | null }
type Transport = { fetch?: typeof fetch; credential?: () => string | undefined };
const slug = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const organization = z.object({ id: uuid, urlKey: slug, name: z.string().max(256).optional() });
const identity = { viewer: z.object({ id: uuid, name: z.string().max(256).optional() }), organization };
const team = z.object({ id: uuid, key: slug, name: z.string().max(8192), organization: z.object({ id: uuid }) });
const issue = z.object({ id: uuid, identifier: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/),
  title: z.string().max(8192), description: z.string().max(1_000_000).nullable(), url: z.string().max(8192),
  state: z.object({ id: uuid, name: z.string().max(8192), type: z.unknown().optional() }), team, project: z.object({ id: uuid }).nullable().optional() });
const project = z.object({ id: uuid, name: z.string().max(8192), url: z.string().max(8192) });
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).max(2048).nullable() });
const IDENTITY = "viewer { id name } organization { id urlKey name }";
const FIELDS = "id identifier title description url state { id name type } team { id key name organization { id } } project { id }";
const PAGE_SIZE = 50;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;

/** Whose key a variable holds, for configure to bind. One identity-only query; the key never leaves this process. */
export async function discoverLinear(credentialEnv: string, dependencies: Transport = {}): Promise<LinearIdentity> {
  if (!linearConnectionSchema.shape.credentialEnv.safeParse(credentialEnv).success) throw new StapleError("validation", "Name the Linear API key variable in capitals, like STAPLE_LINEAR_API_KEY");
  const { viewer, organization: org } = await linearQuery(credentialEnv, dependencies, "", {}, z.object({}));
  return { account: viewer.id, scopeId: org.id, login: viewer.name ?? null, organization: org.name ?? null };
}

/**
 * The one check that a key answers for the expected user and organization, made on every live
 * read and when configure is given ids, so both refuse with the same words. An omitted
 * expectation is not checked.
 */
export function checkLinearIdentity(found: { viewer: { id: string; name?: string }; organization: { id: string } }, expected: { account?: string; scopeId?: string }, credentialEnv: string) {
  if (expected.account !== undefined && found.viewer.id !== expected.account.toLowerCase()) {
    throw new StapleError("auth", `The API key in ${credentialEnv} belongs to ${found.viewer.name ?? "another user"}, not the Linear user this connection expects.`,
      { reason: "account_mismatch", ...(found.viewer.name ? { login: found.viewer.name } : {}) });
  }
  if (expected.scopeId !== undefined && found.organization.id !== expected.scopeId.toLowerCase()) throw new StapleError("forbidden", `The API key in ${credentialEnv} belongs to a different Linear organization.`);
}

/** Personal API key stays in the server environment. IO is injectable, never a configurable remote URL. */
export class LinearApiAdapter implements IntegrationAdapter {
  readonly scope;
  readonly connection;
  readonly label = "Linear";
  private readonly transport: Transport;
  private readonly now: () => Date;
  constructor(private readonly config: LinearApiConnection, dependencies: {
    fetch?: typeof fetch; credential?: () => string | undefined; now?: () => Date;
  } = {}) {
    const parsed = linearConnectionSchema.safeParse(config);
    if (!parsed.success) throw new StapleError("validation", "Configure a Linear user UUID, organization UUID and credential environment variable");
    this.config = parsed.data;
    this.scope = { providerId: "linear", host: "linear.app", scopeId: this.config.scopeId };
    this.connection = { id: config.id, mode: "api" };
    this.transport = { fetch: dependencies.fetch, credential: dependencies.credential };
    this.now = dependencies.now ?? (() => new Date());
  }
  async validate(options?: ProviderReadOptions): Promise<ConnectionHealth> {
    try {
      const { viewer, organization: org } = await this.query("", {}, z.object({}), options);
      return { state: "ready", identity: viewer.name ? { login: viewer.name, ...(org.name ? { organization: org.name } : {}) } : null };
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason;
      if (!(error instanceof StapleError)) throw error;
      return healthFromError(error);
    }
  }
  async listContainers(cursor?: string, options?: ProviderReadOptions) {
    const binding = "teams";
    const after = this.after(cursor, binding);
    const data = await this.query("teams(first: 50, after: $after) { nodes { id key name organization { id } } pageInfo { hasNextPage endCursor } }",
      { after }, z.object({ teams: z.object({ nodes: z.array(team).max(PAGE_SIZE), pageInfo }) }), options, "$after: String");
    return { items: data.teams.nodes.map(t => {
      this.checkTeam(t);
      return { id: t.id, name: `${t.name} (${t.key})`, url: `https://linear.app/${data.organization.urlKey}/team/${t.key}/all` };
    }), nextCursor: this.next(data.teams.pageInfo, binding, after) };
  }
  async listProjects(cursor?: string, options?: ProviderReadOptions) {
    const binding = "projects";
    const after = this.after(cursor, binding);
    const data = await this.query("projects(first: 50, after: $after) { nodes { id name url } pageInfo { hasNextPage endCursor } }",
      { after }, z.object({ projects: z.object({ nodes: z.array(project).max(PAGE_SIZE), pageInfo }) }), options, "$after: String");
    return { items: data.projects.nodes.map(p => ({ id: p.id, name: p.name, url: this.projectUrl(p.url) })), nextCursor: this.next(data.projects.pageInfo, binding, after) };
  }
  async readContainer(id: string, kind: ContainerKind, options?: ProviderReadOptions): Promise<ExternalContainer | null> {
    this.checkUuid(id);
    try {
      if (kind === "project") {
        const data = await this.query("project(id: $id) { id name url }", { id }, z.object({ project }), options, "$id: String!");
        return data.project.id === id.toLowerCase() ? { id: data.project.id, name: data.project.name, url: this.projectUrl(data.project.url) } : null;
      }
      if (kind !== "team") throw new StapleError("validation", "Linear containers are teams or projects");
      const data = await this.query("team(id: $id) { id key name organization { id } }", { id }, z.object({ team }), options, "$id: String!");
      this.checkTeam(data.team);
      return { id: data.team.id, name: `${data.team.name} (${data.team.key})`, url: `https://linear.app/${data.organization.urlKey}/team/${data.team.key}/all` };
    } catch (error) {
      if (error instanceof StapleError && error.code === "not_found") return null;
      throw error;
    }
  }
  async searchIssues(search: ExternalSearch, options?: ProviderReadOptions) {
    if (search.text.length > 256 || /[\x00-\x1f]/.test(search.text)) throw new StapleError("validation", "Use at most 256 characters of search text");
    if (search.containerId !== undefined) this.checkUuid(search.containerId);
    if (search.projectId !== undefined) this.checkUuid(search.projectId);
    if (search.containerId !== undefined && search.projectId !== undefined) throw new StapleError("validation", "Search a Linear team or a project, not both");
    const binding = JSON.stringify(["issues", search.text, search.containerId ?? null, search.projectId ?? null]);
    const after = this.after(search.cursor, binding);
    const text = search.text.trim();
    // Linear's search requires non-empty text; the issues connection supports browsing a team.
    const field = text ? "searchIssues" : "issues";
    const byProject = search.projectId ? { project: { id: { eq: search.projectId } } } : null;
    const selection = text
      ? `searchIssues(term: $text, teamId: $team${byProject ? ", filter: $filter" : ""}, first: 50, after: $after) { nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } }`
      : `issues(filter: $filter, orderBy: updatedAt, first: 50, after: $after) { nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } }`;
    const variables = text ? { text, team: search.containerId ?? null, ...(byProject ? { filter: byProject } : {}), after }
      : { filter: byProject ?? (search.containerId ? { team: { id: { eq: search.containerId } } } : {}), after };
    const data = await this.query(selection, variables, z.object({ [field]: z.object({ nodes: z.array(issue).max(PAGE_SIZE), pageInfo }) }), options,
      text ? `$text: String!, $team: String${byProject ? ", $filter: IssueFilter" : ""}, $after: String` : "$filter: IssueFilter, $after: String");
    const page = data[field]!;
    if (search.projectId && page.nodes.some(n => n.project?.id !== search.projectId)) throw new StapleError("unavailable", "Linear returned an issue outside the selected project");
    const items = page.nodes.map(i => this.item(i, data.organization));
    if (search.containerId && items.some(i => i.ref.containerId !== search.containerId)) throw new StapleError("unavailable", "Linear returned an issue outside the selected team");
    return { items, nextCursor: this.next(page.pageInfo, binding, after) };
  }
  async resolve(locator: ExternalLocator, options?: ProviderReadOptions) {
    let key: string, workspace: string | undefined;
    if ("url" in locator) {
      try {
        const u = new URL(locator.url);
        const match = /^\/([A-Za-z0-9_-]+)\/issue\/([A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*)(?:\/[A-Za-z0-9_-]+)?\/?$/.exec(u.pathname);
        if (u.protocol !== "https:" || u.host !== "linear.app" || u.username || u.password || !match
          || [...u.searchParams.keys()].some(k => !k.startsWith("utm_"))) throw new Error();
        workspace = match[1]!; key = match[2]!;
      } catch { throw new StapleError("validation", "Paste an exact https://linear.app/workspace/issue/TEAM-123 URL"); }
    } else {
      this.checkUuid(locator.containerId);
      if (!/^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/.test(locator.key)) throw new StapleError("validation", "Use a Linear issue identifier such as ENG-123 and select its team");
      key = locator.key;
    }
    try {
      const data = await this.getIssue(key, options);
      if (workspace && workspace !== data.organization.urlKey) throw new StapleError("validation", "The Linear URL belongs to a different workspace; use its current URL and connection");
      const item = this.item(data.issue, data.organization);
      if ("containerId" in locator && item.ref.containerId !== locator.containerId) throw new StapleError("validation", "Linear issue does not belong to the selected team");
      return { ref: item.ref, key: item.key, url: item.url };
    } catch (error) {
      if (error instanceof StapleError && error.code === "not_found") return null;
      throw error;
    }
  }
  async readIssue(ref: ExternalItemRef, options?: ProviderReadOptions): Promise<ExternalItem> {
    if (ref.providerId !== "linear" || ref.host !== "linear.app" || ref.scopeId !== this.scope.scopeId || ref.kind !== "issue") throw new StapleError("validation", "Reference belongs to a different Linear scope");
    this.checkUuid(ref.containerId); this.checkUuid(ref.id);
    const data = await this.getIssue(ref.id, options);
    const item = this.item(data.issue, data.organization);
    if (item.ref.id !== ref.id || item.ref.containerId !== ref.containerId) throw new StapleError("unavailable", "Linear issue moved teams or returned a different identity; resolve its current URL again");
    return item;
  }
  private getIssue(id: string, options?: ProviderReadOptions) {
    return this.query(`issue(id: $id) { ${FIELDS} }`, { id }, z.object({ issue }), options, "$id: String!");
  }
  private item(source: z.infer<typeof issue>, org: z.infer<typeof organization>): ExternalItem {
    this.checkTeam(source.team);
    let url: URL;
    try {
      url = new URL(source.url);
      const prefix = `/${org.urlKey}/issue/${source.identifier}`;
      if (url.protocol !== "https:" || url.host !== "linear.app" || url.username || url.password || url.search || url.hash
        || !(url.pathname === prefix || new RegExp(`^${prefix}/[A-Za-z0-9_-]+/?$`).test(url.pathname))) throw new Error();
    } catch { throw new StapleError("unavailable", "Linear returned an unexpected issue URL"); }
    return { ref: { ...this.scope, containerId: source.team.id, id: source.id, kind: "issue" }, key: source.identifier,
      url: url.href, title: source.title, body: source.description,
      // A state type Linear adds later reads as a state without a category, not a failed read.
      status: { id: source.state.id, name: source.state.name, ...(isExternalStatusCategory(source.state.type) ? { category: source.state.type } : {}) },
      fetchedAt: this.now().toISOString(),
      ...(source.project ? { projectId: source.project.id } : {}) };
  }
  private projectUrl(input: string): string {
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || url.host !== "linear.app" || url.username || url.password) throw new Error();
      return url.href;
    } catch { throw new StapleError("unavailable", "Linear returned an unexpected project URL"); }
  }
  private checkTeam(t: z.infer<typeof team>) {
    if (t.organization.id !== this.scope.scopeId) throw new StapleError("forbidden", "Linear returned a team in a different organization");
  }
  private checkUuid(id: string) { if (!uuid.safeParse(id).success) throw new StapleError("validation", "Linear resource identifiers must be UUIDs"); }
  private binding(binding: string) {
    return createHash("sha256").update(JSON.stringify([this.config.id, this.config.account, this.scope.scopeId, binding])).digest("hex");
  }
  private after(cursor: string | undefined, binding: string): string | null {
    if (cursor === undefined) return null;
    try {
      if (cursor.length > 4096) throw new Error();
      const parsed = z.tuple([z.string(), z.string().min(1).max(2048)]).parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (parsed[0] !== this.binding(binding)) throw new Error();
      return parsed[1];
    } catch { throw new StapleError("cursor_invalid", "Linear search or connection changed; start again"); }
  }
  private next(page: z.infer<typeof pageInfo>, binding: string, previous: string | null) {
    if (!page.hasNextPage) return null;
    if (!page.endCursor || page.endCursor === previous) throw new StapleError("unavailable", "Linear returned an invalid pagination cursor");
    return Buffer.from(JSON.stringify([this.binding(binding), page.endCursor])).toString("base64url");
  }
  private async query<T extends z.ZodRawShape>(selection: string, variables: object, shape: z.ZodObject<T>, options?: ProviderReadOptions, declarations = "") {
    const data = await linearQuery(this.config.credentialEnv, this.transport, selection, variables, shape, options, declarations);
    checkLinearIdentity(data, this.config, this.config.credentialEnv);
    return data;
  }
}

/** One Linear GraphQL read with the identity every read carries. It checks no binding: callers do. */
async function linearQuery<T extends z.ZodRawShape>(credentialEnv: string, transport: Transport, selection: string, variables: object, shape: z.ZodObject<T>, options?: ProviderReadOptions, declarations = "") {
  options?.signal?.throwIfAborted();
  const key = (transport.credential ?? (() => process.env[credentialEnv]))();
  if (!key || key.length > 4096 || /\s/.test(key)) throw new StapleError("auth", `${credentialEnv} isn't set where Staple runs.`);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const response = await (transport.fetch ?? globalThis.fetch)("https://api.linear.app/graphql", { method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query: `query StapleRead${declarations ? `(${declarations})` : ""} { ${IDENTITY} ${selection} }`, variables }) });
    if (response.status === 401) { await response.body?.cancel(); throw new StapleError("auth", `Linear rejected the API key in ${credentialEnv}.`); }
    if (response.status === 403) { await response.body?.cancel(); throw new StapleError("forbidden", "Linear denied access to this resource"); }
    if (response.status === 429) { await response.body?.cancel(); throw new StapleError("rate_limited", "Linear's rate limit is reached."); }
    if (!response.ok) { await response.body?.cancel(); throw new StapleError("unavailable", "Linear API is unavailable; try again later"); }
    const reader = response.body?.getReader();
    if (!reader) throw new StapleError("unavailable", "Linear returned an empty response");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw new StapleError("unavailable", "Linear response is too large; narrow the search");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new StapleError("unavailable", "Linear returned an unsupported response"); }
    const envelope = z.object({ errors: z.array(z.object({ extensions: z.object({ code: z.string().optional(), type: z.string().optional() }).passthrough().optional() }).passthrough()).optional(), data: z.unknown().optional() }).safeParse(payload);
    if (!envelope.success) throw new StapleError("unavailable", "Linear returned an unsupported response");
    if (envelope.data.errors?.length) {
      const codes = envelope.data.errors.map(e => `${e.extensions?.code ?? ""} ${e.extensions?.type ?? ""}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_"));
      if (codes.some(c => /RATELIMIT|RATE_LIMIT|USAGE_LIMIT_EXCEEDED/.test(c))) throw new StapleError("rate_limited", "Linear's rate limit is reached.");
      if (codes.some(c => /UNAUTHENTICATED|AUTHENTICATION_ERROR/.test(c))) throw new StapleError("auth", `Linear rejected the API key in ${credentialEnv}.`);
      if (codes.some(c => /FORBIDDEN|AUTHORIZATION_ERROR|FEATURE_NOT_ACCESSIBLE/.test(c))) throw new StapleError("forbidden", "Linear denied access to this resource");
      if (codes.some(c => /ENTITY_NOT_FOUND|NOT_FOUND/.test(c))) throw new StapleError("not_found", "Linear issue was not found or is inaccessible");
      throw new StapleError("unavailable", "Linear could not complete the query; try again later");
    }
    const data = z.object(identity).safeParse(envelope.data.data);
    const fields = shape.safeParse(envelope.data.data);
    if (!data.success || !fields.success) throw new StapleError("unavailable", "Linear returned an unsupported response");
    return { ...fields.data, viewer: data.data.viewer, organization: data.data.organization };
  } catch (error) {
    if (options?.signal?.aborted) throw options.signal.reason;
    if (error instanceof StapleError) throw error;
    throw new StapleError("offline", timeout.aborted ? "Linear request timed out; try again later" : "Cannot reach Linear; check this machine's network connection");
  }
}
