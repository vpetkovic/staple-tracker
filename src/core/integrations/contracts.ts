/**
 * Read-only tracker integrations. An adapter is bound to one provider scope and a
 * machine-local connection. CLI and API implementations return the same records.
 * Linking, local ticket creation, persistence and publication are not adapter work.
 */
export interface ProviderScope {
  providerId: string;
  /** Resource host, including an optional port; never an API path or a credential. */
  host: string;
  /** Stable remote tenant/organization scope, not the authenticated user's login. */
  scopeId: string;
}

export type ExternalItemKind = "issue" | "pull_request";

/** Immutable provider identity. Names, URLs, display keys and transport are excluded. */
export interface ExternalItemRef extends ProviderScope {
  containerId: string;
  id: string;
  kind: ExternalItemKind;
}

/** A resolved reference can be linked even when metadata reads are unsupported. */
export interface ResolvedExternalItem {
  ref: ExternalItemRef;
  key: string;
  /** Canonical provider URL; the adapter excludes tracking or authentication data. */
  url: string;
}

export interface ExternalItem extends ResolvedExternalItem {
  title: string;
  body: string | null;
  /** Native state; do not coerce a provider's workflow into GitHub open/closed. */
  status: { id: string; name: string } | null;
  /** When the source was actually read, not when the local ticket was modified. */
  fetchedAt: string;
}

export interface ExternalContainer {
  id: string;
  name: string;
  url: string;
}

export interface ExternalPage<T> {
  items: T[];
  /** Opaque to callers. Null means the provider has no next page. */
  nextCursor: string | null;
}

export interface ProviderReadOptions {
  signal?: AbortSignal;
}

export interface ExternalSearch {
  text: string;
  containerId?: string;
  cursor?: string;
}

/** A display key needs a container; a pasted URL must be resolved to immutable ids. */
export type ExternalLocator = { url: string } | { key: string; containerId: string };

/** Health is local to a connection and never carries raw stderr or authentication data. */
export type ConnectionHealth =
  | { state: "ready" }
  | { state: "missing_cli" | "unsupported_version" | "unauthenticated" | "forbidden" | "unavailable"; message: string };

export interface PullRequestReader {
  read(ref: ExternalItemRef, options?: ProviderReadOptions): Promise<ExternalItem>;
  /** Some providers allow exact PR references/reads without searchable PRs. */
  search?(query: ExternalSearch, options?: ProviderReadOptions): Promise<ExternalPage<ExternalItem>>;
}

/**
 * Methods reject with the existing StapleError taxonomy for actionable failures
 * (auth, forbidden, rate_limited, offline, cursor_invalid, unavailable, etc.). A
 * not-found resource is not proof of deletion. Cancellation propagates unchanged.
 * Implementations redact provider failures before exposing them to callers.
 */
export interface IntegrationAdapter {
  readonly scope: ProviderScope;
  readonly label: string;
  /** Machine-local binding. Neither id nor mode participates in remote identity. */
  readonly connection: { id: string; mode: string };
  validate(options?: ProviderReadOptions): Promise<ConnectionHealth>;
  listContainers(cursor?: string, options?: ProviderReadOptions): Promise<ExternalPage<ExternalContainer>>;
  searchIssues(query: ExternalSearch, options?: ProviderReadOptions): Promise<ExternalPage<ExternalItem>>;
  /** Exact lookup for issue or PR references; null is an unknown/unavailable reference. */
  resolve(locator: ExternalLocator, options?: ProviderReadOptions): Promise<ResolvedExternalItem | null>;
  readIssue(ref: ExternalItemRef, options?: ProviderReadOptions): Promise<ExternalItem>;
  /** No placeholder write methods or mandatory PR support for issue-only providers. */
  readonly pullRequests?: PullRequestReader;
}
