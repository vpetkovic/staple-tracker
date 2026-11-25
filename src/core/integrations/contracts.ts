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
  /** Linear only, when the issue belongs to a project: the project, for project-mapped scopes. */
  projectId?: string;
  /** ClickUp only: the task's space, and its home list followed by any other lists it is in. */
  spaceId?: string;
  listIds?: string[];
}

export interface ExternalContainer {
  id: string;
  name: string;
  url: string;
}

/** What a container is to its provider: a GitHub repository, a Linear team or project, a ClickUp space or list. */
export type ContainerKind = "repository" | "team" | "project" | "space" | "list";

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
  /** Linear only: issues in this project, whatever their team. Exclusive with containerId. */
  projectId?: string;
  /** ClickUp only: tasks in this space or this list. Exclusive with each other and containerId. */
  spaceId?: string;
  listId?: string;
  cursor?: string;
}

/** A display key needs a container; a pasted URL must be resolved to immutable ids. */
export type ExternalLocator = { url: string } | { key: string; containerId: string };

/** The account a provider actually authenticated, when known. A display login, never a credential. */
export interface ConnectionIdentity {
  login: string;
  /** Linear: the organization the key belongs to; ClickUp: the workspace. For naming the connection. */
  organization?: string;
}

export type ConnectionFailureState =
  | "missing_cli" | "unsupported_version" | "unauthenticated" | "account_mismatch"
  | "forbidden" | "rate_limited" | "offline" | "unavailable";
/** `not_found` is never probed: it names a connection id that is not configured on this machine. */
export type ConnectionState = "ready" | ConnectionFailureState | "not_found";

/** Health is local to a connection and never carries raw stderr or authentication data. */
export type ConnectionHealth =
  | { state: "ready"; identity?: ConnectionIdentity | null }
  | { state: ConnectionFailureState; message: string; identity?: ConnectionIdentity; retryAfterSeconds?: number };

/**
 * The last known health of one machine-local connection, as Settings and agents read it.
 * `checkedAt` is when the provider was last really probed, or when a live read last failed.
 */
export interface ConnectionHealthSnapshot {
  connectionId: string;
  state: ConnectionState;
  /** One redacted sentence; null when ready. */
  message: string | null;
  /** What the person does next; null when nothing is needed. */
  action: string | null;
  identity: ConnectionIdentity | null;
  checkedAt: string;
  /** Set for rate_limited only. */
  retryAfterSeconds: number | null;
}

/** A provider account this machine is already signed in to, whether or not Staple has a connection for it. */
export interface DetectedConnection {
  providerId: "github";
  host: string;
  login: string;
  /** The existing connection for this host and account in this workspace, if any. */
  configuredConnectionId: string | null;
}

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
  /** One container by id, for its current name and URL; null when it is gone or inaccessible. */
  readContainer(id: string, kind: ContainerKind, options?: ProviderReadOptions): Promise<ExternalContainer | null>;
  /** Linear projects. Absent for providers without projects. */
  listProjects?(cursor?: string, options?: ProviderReadOptions): Promise<ExternalPage<ExternalContainer>>;
  /** ClickUp lists. Absent for providers without lists. */
  listLists?(cursor?: string, options?: ProviderReadOptions): Promise<ExternalPage<ExternalContainer>>;
  searchIssues(query: ExternalSearch, options?: ProviderReadOptions): Promise<ExternalPage<ExternalItem>>;
  /** Exact lookup for issue or PR references; null is an unknown/unavailable reference. */
  resolve(locator: ExternalLocator, options?: ProviderReadOptions): Promise<ResolvedExternalItem | null>;
  readIssue(ref: ExternalItemRef, options?: ProviderReadOptions): Promise<ExternalItem>;
  /** No placeholder write methods or mandatory PR support for issue-only providers. */
  readonly pullRequests?: PullRequestReader;
}
