import { z } from "zod";
import { StapleError } from "../types.js";
import type {
  ConnectionHealth, ExternalItem, ExternalItemKind, ExternalItemRef, ExternalLocator,
  ExternalPage, ExternalSearch, IntegrationAdapter, ProviderReadOptions,
} from "./contracts.js";
import { createGhRunner, type GhRunner } from "./gh-process.js";

const identifier = z.number().int().positive().safe();
const repository = z.object({ id: identifier, full_name: z.string().regex(/^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/), html_url: z.string() });
const sourceIssue = z.object({
  number: identifier, title: z.string(), body: z.string().nullable(), state: z.enum(["open", "closed"]),
  html_url: z.string(), pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(), repository_url: z.string().optional(),
});
type Repository = z.infer<typeof repository>;
type SourceIssue = z.infer<typeof sourceIssue>;
const PAGE_SIZE = 50;

export interface GitHubCliConnection {
  id: string;
  host: string;
  /** Expected effective gh account. Changing accounts requires an explicit settings change. */
  account: string;
}

/** GitHub is a host-wide tenant. Repository ids survive owner/name changes. */
export class GitHubCliAdapter implements IntegrationAdapter {
  readonly scope;
  readonly label = "GitHub";
  readonly connection;
  readonly pullRequests;
  private readonly run: GhRunner;
  private readonly now: () => Date;

  constructor(private readonly config: GitHubCliConnection, dependencies: { run?: GhRunner; now?: () => Date } = {}) {
    if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/i.test(config.host) || !/^[A-Za-z0-9-]+$/.test(config.account) || !config.id.trim()) {
      throw new StapleError("validation", "Configure a GitHub resource host, account and connection id");
    }
    this.scope = { providerId: "github", host: new URL(`https://${config.host}`).host, scopeId: "host" };
    this.connection = { id: config.id, mode: "cli" };
    this.run = dependencies.run ?? createGhRunner();
    this.now = dependencies.now ?? (() => new Date());
    this.pullRequests = {
      read: (ref: ExternalItemRef, options?: ProviderReadOptions) => this.read(ref, "pull_request", options),
      search: (query: ExternalSearch, options?: ProviderReadOptions) => this.search("pull_request", query, options),
    };
  }

  async validate(options?: ProviderReadOptions): Promise<ConnectionHealth> {
    try {
      await this.checkConnection(options);
      return { state: "ready" };
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason;
      if (!(error instanceof StapleError)) throw error;
      const state = error.detail?.reason === "missing_cli" ? "missing_cli"
        : error.detail?.reason === "unsupported_version" ? "unsupported_version"
        : error.code === "auth" ? "unauthenticated" : error.code === "forbidden" ? "forbidden" : "unavailable";
      return { state, message: error.message };
    }
  }

  async listContainers(cursor?: string, options?: ProviderReadOptions) {
    const page = this.page(cursor, "containers");
    await this.checkConnection(options);
    const repos = await this.get(`user/repos?per_page=${PAGE_SIZE}&page=${page}&sort=full_name`, z.array(repository), options);
    return {
      items: repos.map(repo => ({ id: String(repo.id), name: repo.full_name, url: this.repoUrl(repo) })),
      nextCursor: repos.length === PAGE_SIZE ? this.cursor(page + 1, "containers") : null,
    };
  }

  searchIssues(query: ExternalSearch, options?: ProviderReadOptions) { return this.search("issue", query, options); }
  readIssue(ref: ExternalItemRef, options?: ProviderReadOptions) { return this.read(ref, "issue", options); }

  async resolve(locator: ExternalLocator, options?: ProviderReadOptions) {
    const parsed = "url" in locator ? this.locateUrl(locator.url) : this.locateKey(locator.key);
    if ("containerId" in locator) this.numeric(locator.containerId);
    await this.checkConnection(options);
    try {
      const repo = "url" in locator
        ? await this.get(`repos/${parsed.fullName!}`, repository, options)
        : await this.get(`repositories/${locator.containerId}`, repository, options);
      if ("containerId" in locator && String(repo.id) !== locator.containerId) throw new StapleError("unavailable", "GitHub returned a different repository");
      if (parsed.fullName && repo.full_name.toLowerCase() !== parsed.fullName.toLowerCase() && "containerId" in locator) {
        throw new StapleError("validation", "Display key does not belong to the selected repository");
      }
      const item = await this.get(`repos/${repo.full_name}/issues/${parsed.number}`, sourceIssue, options);
      const result = this.item(repo, item);
      if (result.ref.id !== parsed.number || (parsed.kind && result.ref.kind !== parsed.kind)) return null;
      return { ref: result.ref, key: result.key, url: result.url };
    } catch (error) {
      if (error instanceof StapleError && error.code === "not_found") return null;
      throw error;
    }
  }

  private async read(ref: ExternalItemRef, kind: ExternalItemKind, options?: ProviderReadOptions): Promise<ExternalItem> {
    if (ref.providerId !== "github" || ref.host !== this.scope.host || ref.scopeId !== "host" || ref.kind !== kind) {
      throw new StapleError("validation", "Reference belongs to a different GitHub resource scope");
    }
    this.numeric(ref.containerId); this.numeric(ref.id);
    await this.checkConnection(options);
    const repo = await this.get(`repositories/${ref.containerId}`, repository, options);
    if (String(repo.id) !== ref.containerId) throw new StapleError("unavailable", "GitHub returned a different repository");
    const result = this.item(repo, await this.get(`repos/${repo.full_name}/issues/${ref.id}`, sourceIssue, options));
    if (result.ref.kind !== kind || result.ref.id !== ref.id) throw new StapleError("unavailable", "GitHub returned a different issue or pull request");
    return result;
  }

  private async search(kind: ExternalItemKind, query: ExternalSearch, options?: ProviderReadOptions): Promise<ExternalPage<ExternalItem>> {
    if (query.text.length > 256 || /[\x00-\x1f]/.test(query.text)) throw new StapleError("validation", "Use at most 256 characters of search text");
    if (query.containerId !== undefined) this.numeric(query.containerId);
    const binding = JSON.stringify([kind, query.text, query.containerId ?? null]);
    const page = this.page(query.cursor, binding);
    await this.checkConnection(options);
    const selected = query.containerId === undefined ? null : await this.get(`repositories/${query.containerId}`, repository, options);
    if (selected && String(selected.id) !== query.containerId) throw new StapleError("unavailable", "GitHub returned a different repository");
    const q = [query.text.trim() ? JSON.stringify(query.text.trim()) : "", kind === "issue" ? "is:issue" : "is:pr", selected ? `repo:${selected.full_name}` : ""].filter(Boolean).join(" ");
    const params = new URLSearchParams({ q, per_page: String(PAGE_SIZE), page: String(page), sort: "created", order: "asc" });
    const result = await this.get(`search/issues?${params}`, z.object({ total_count: z.number().int().nonnegative(), incomplete_results: z.boolean(), items: z.array(sourceIssue) }), options);
    if (result.incomplete_results) throw new StapleError("unavailable", "GitHub search was incomplete; narrow the search and try again");
    if (result.total_count > 1000) throw new StapleError("validation", "GitHub search has over 1000 results; select a repository or narrow the search");
    const repos = new Map<string, Repository>();
    if (selected) repos.set(selected.full_name.toLowerCase(), selected);
    const items: ExternalItem[] = [];
    for (const source of result.items) {
      if ((source.pull_request ? "pull_request" : "issue") !== kind) continue;
      const fullName = this.searchRepo(source.repository_url);
      let repo = repos.get(fullName.toLowerCase());
      if (!repo) {
        repo = await this.get(`repos/${fullName}`, repository, options);
        repos.set(fullName.toLowerCase(), repo);
      }
      if (selected && repo.id !== selected.id) throw new StapleError("unavailable", "GitHub search returned a different repository");
      items.push(this.item(repo, source));
    }
    return { items, nextCursor: page * PAGE_SIZE < result.total_count ? this.cursor(page + 1, binding) : null };
  }

  private async checkConnection(options?: ProviderReadOptions) {
    const version = await this.run({ kind: "version" }, options);
    const match = /^gh version (\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 20)) {
      throw new StapleError("unavailable", "GitHub CLI 2.20 or newer is required", { reason: "unsupported_version" });
    }
    const user = await this.get("user", z.object({ login: z.string() }), options);
    if (user.login.toLowerCase() !== this.config.account.toLowerCase()) {
      throw new StapleError("auth", "GitHub CLI is using a different account; select that account in Settings or change gh authentication yourself");
    }
  }

  private async get<T>(endpoint: string, schema: z.ZodType<T>, options?: ProviderReadOptions): Promise<T> {
    const raw = await this.run({ kind: "get", host: this.scope.host, endpoint }, options);
    try {
      const match = /^HTTP\/\S+ 2\d\d[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(raw);
      if (!match) throw new Error();
      return schema.parse(JSON.parse(match[1]!));
    } catch {
      throw new StapleError("unavailable", "GitHub returned an unsupported response; try again or update GitHub CLI");
    }
  }

  private item(repo: Repository, source: SourceIssue): ExternalItem {
    const kind = source.pull_request ? "pull_request" : "issue";
    const url = `${this.repoUrl(repo)}/${kind === "issue" ? "issues" : "pull"}/${source.number}`;
    if (source.html_url !== url) throw new StapleError("unavailable", "GitHub resource moved or returned an unexpected URL; resolve its current URL again");
    return {
      ref: { ...this.scope, containerId: String(repo.id), id: String(source.number), kind },
      key: `${repo.full_name}#${source.number}`, url, title: source.title, body: source.body,
      status: { id: source.pull_request?.merged_at ? "merged" : source.state, name: source.pull_request?.merged_at ? "merged" : source.state }, fetchedAt: this.now().toISOString(),
    };
  }

  private repoUrl(repo: Repository) {
    const url = `https://${this.scope.host}/${repo.full_name}`;
    if (repo.html_url !== url) throw new StapleError("unavailable", "GitHub returned an unexpected repository URL");
    return url;
  }

  private locateUrl(input: string): { fullName: string; number: string; kind: ExternalItemKind } {
    try {
      const url = new URL(input);
      const match = /^\/([A-Za-z0-9-]+\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
      if (url.protocol !== "https:" || url.host !== this.scope.host || url.username || url.password || !match
        || [...url.searchParams.keys()].some(key => !key.startsWith("utm_"))) throw new Error();
      this.numeric(match[3]!);
      return { fullName: match[1]!, number: match[3]!, kind: match[2] === "issues" ? "issue" : "pull_request" };
    } catch { throw new StapleError("validation", "Paste an issue or pull request URL on the configured GitHub host without credentials or custom query parameters"); }
  }

  private locateKey(key: string): { fullName?: string; number: string; kind?: ExternalItemKind } {
    const match = /^(?:([A-Za-z0-9-]+\/(?!\.{1,2}#)[A-Za-z0-9_.-]+)#|#?)([1-9][0-9]*)$/.exec(key);
    if (!match) throw new StapleError("validation", "Use an issue number or owner/repository#number");
    this.numeric(match[2]!);
    return { fullName: match[1], number: match[2]! };
  }

  private searchRepo(input: string | undefined): string {
    try {
      const url = new URL(input!);
      const apiHost = this.scope.host === "github.com" ? "api.github.com" : this.scope.host;
      const prefix = this.scope.host === "github.com" ? "/repos/" : "/api/v3/repos/";
      const name = url.pathname.slice(prefix.length);
      if (url.protocol !== "https:" || url.host !== apiHost || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)
        || !repository.shape.full_name.safeParse(name).success) throw new Error();
      return name;
    } catch { throw new StapleError("unavailable", "GitHub search returned an unexpected repository reference"); }
  }

  private numeric(id: string) {
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new StapleError("validation", "GitHub identifiers must be positive safe integers");
  }

  private cursor(page: number, binding: string) { return Buffer.from(JSON.stringify([this.scope.host, binding, page])).toString("base64url"); }
  private page(cursor: string | undefined, binding: string): number {
    if (cursor === undefined) return 1;
    try {
      if (cursor.length > 2048) throw new Error();
      const [host, query, page] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (host !== this.scope.host || query !== binding || !Number.isSafeInteger(page) || page < 2 || page > 10_000) throw new Error();
      return page;
    } catch { throw new StapleError("cursor_invalid", "Search changed or its GitHub cursor is invalid; start again"); }
  }
}
