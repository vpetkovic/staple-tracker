/** Shared read boundary; adapters supply provider-specific parsing and IO. */
import { StapleError } from "../types.js";
import type {
  ContainerKind, ExternalItem, ExternalItemKind, ExternalItemRef, ExternalLocator, ExternalPage,
  ExternalSearch, IntegrationAdapter, ProviderReadOptions, ProviderScope, ResolvedExternalItem,
} from "./contracts.js";

function required(value: string): string {
  if (!value || value !== value.trim()) throw new StapleError("validation", "Provider identity fields must be non-empty and have no surrounding whitespace");
  return value;
}

function resourceHost(host: string): string {
  try {
    const url = new URL(`https://${required(host)}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.host;
  } catch {
    throw new StapleError("validation", "A provider host must be a hostname with an optional port");
  }
}

/** A collision-safe key independent of transport, display name and mutable URL. */
export function externalItemKey(ref: ExternalItemRef): string {
  if (ref.kind !== "issue" && ref.kind !== "pull_request") throw new StapleError("validation", "Unknown external resource kind");
  return JSON.stringify([
    required(ref.providerId), resourceHost(ref.host), required(ref.scopeId),
    required(ref.containerId), ref.kind, required(ref.id),
  ]);
}

function scopeKey(scope: ProviderScope): string {
  return JSON.stringify([required(scope.providerId), resourceHost(scope.host), required(scope.scopeId)]);
}

/** Only configured HTTPS resource URLs reach an adapter; never arbitrary URL fetches. */
function resourceUrl(input: string, host: string): string {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.host !== resourceHost(host)) throw new Error();
    // Providers interpret their own paths and query parameters. Some use a query
    // parameter to identify an item; the shared boundary must not erase it.
    return url.href;
  } catch {
    throw new StapleError("validation", "Use an HTTPS resource URL on the configured provider host, without credentials");
  }
}

export class IntegrationReader {
  constructor(private readonly adapter: IntegrationAdapter) {
    scopeKey(adapter.scope);
  }

  /** Derive capability availability from implementations so flags cannot drift. */
  get capabilities() {
    return {
      readPullRequests: this.adapter.pullRequests !== undefined,
      searchPullRequests: this.adapter.pullRequests?.search !== undefined,
    };
  }

  validate(options?: ProviderReadOptions) {
    return this.adapter.validate(options);
  }

  async listContainers(cursor?: string, options?: ProviderReadOptions) {
    const page = await this.adapter.listContainers(cursor, options);
    const items = page.items.map((container) => {
      required(container.id);
      return { ...container, url: resourceUrl(container.url, this.adapter.scope.host) };
    });
    return { ...page, items };
  }

  async listProjects(cursor?: string, options?: ProviderReadOptions) {
    if (!this.adapter.listProjects) throw new StapleError("protocol_unsupported", "This connection has no projects");
    const page = await this.adapter.listProjects(cursor, options);
    return { ...page, items: page.items.map(p => ({ ...p, url: resourceUrl(p.url, this.adapter.scope.host) })) };
  }

  async readContainer(id: string, kind: ContainerKind, options?: ProviderReadOptions) {
    const container = await this.adapter.readContainer(required(id), kind, options);
    return container && { ...container, url: resourceUrl(container.url, this.adapter.scope.host) };
  }

  async resolve(locator: ExternalLocator, options?: ProviderReadOptions): Promise<ResolvedExternalItem | null> {
    const input = "url" in locator
      ? { url: resourceUrl(locator.url, this.adapter.scope.host) }
      : { key: required(locator.key), containerId: required(locator.containerId) };
    const resolved = await this.adapter.resolve(input, options);
    if (resolved !== null) {
      const item = this.checkedItem(resolved);
      if ("containerId" in input && item.ref.containerId !== input.containerId) {
        throw new StapleError("validation", "Provider lookup returned an item in a different container");
      }
      return item;
    }
    return null;
  }

  async search(kind: ExternalItemKind, query: ExternalSearch, options?: ProviderReadOptions): Promise<ExternalPage<ExternalItem>> {
    let page: ExternalPage<ExternalItem>;
    if (kind === "issue") page = await this.adapter.searchIssues(query, options);
    else if (kind === "pull_request") {
      if (!this.adapter.pullRequests?.search) throw new StapleError("protocol_unsupported", "This connection does not support pull request search");
      page = await this.adapter.pullRequests.search(query, options);
    } else throw new StapleError("validation", "Unknown external resource kind");
    const items = page.items.map((raw) => {
      const item = this.checkedItem(raw);
      if (item.ref.kind !== kind || (query.containerId !== undefined && item.ref.containerId !== query.containerId)) {
        throw new StapleError("validation", "Provider search returned an item outside the requested resource scope");
      }
      return item;
    });
    return { ...page, items };
  }

  /** Refresh source context only. Nothing here updates a local execution ticket. */
  async read(ref: ExternalItemRef, options?: ProviderReadOptions): Promise<ExternalItem> {
    this.checkRef(ref);
    let item: ExternalItem;
    if (ref.kind === "issue") item = await this.adapter.readIssue(ref, options);
    else {
      if (!this.adapter.pullRequests) throw new StapleError("protocol_unsupported", "This connection does not support pull request metadata");
      item = await this.adapter.pullRequests.read(ref, options);
    }
    item = this.checkedItem(item);
    if (externalItemKey(item.ref) !== externalItemKey(ref)) throw new StapleError("validation", "Provider read returned a different resource");
    return item;
  }

  private checkRef(ref: ExternalItemRef): void {
    externalItemKey(ref);
    if (scopeKey(ref) !== scopeKey(this.adapter.scope)) throw new StapleError("validation", "External resource belongs to a different provider scope");
  }

  private checkedItem<T extends ResolvedExternalItem>(item: T): T {
    this.checkRef(item.ref);
    const url = resourceUrl(item.url, this.adapter.scope.host);
    return url === item.url ? item : { ...item, url };
  }
}
