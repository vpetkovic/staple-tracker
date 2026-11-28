import { StapleError } from "../types.js";
import type { ConnectionHealth, ConnectionHealthSnapshot, ConnectionState } from "./contracts.js";
import type { ProviderConnection } from "./connections.js";

/** Server-owned polling cadence. One GitHub probe is `gh --version` plus one GET /user. */
export const HEALTH_POLL_INTERVAL_SECONDS = 120;
/** A forced probe younger than this is answered from the cache instead of probing again. */
export const HEALTH_FORCE_FLOOR_MS = 5_000;

/** Codes a live read can fail with that describe the connection rather than the resource read. */
const CONNECTION_FAILURES = new Set(["auth", "forbidden", "offline", "rate_limited"]);
const CONNECTION_REASONS = new Set(["missing_cli", "unsupported_version", "account_mismatch"]);

export function isConnectionFailure(error: unknown): error is StapleError {
  return error instanceof StapleError
    && (CONNECTION_FAILURES.has(error.code) || CONNECTION_REASONS.has(String(error.detail?.reason)));
}

/** One mapping from the adapter error taxonomy to a health state, shared by probes and live reads. */
export function healthFromError(error: StapleError): Exclude<ConnectionHealth, { state: "ready" }> {
  const reason = error.detail?.reason;
  const state = reason === "missing_cli" || reason === "unsupported_version" || reason === "account_mismatch" ? reason
    : error.code === "auth" ? "unauthenticated"
    : error.code === "forbidden" || error.code === "rate_limited" || error.code === "offline" ? error.code
    : "unavailable";
  const login = typeof error.detail?.login === "string" ? error.detail.login : undefined;
  const retry = Number(error.detail?.retryAfterSeconds);
  return {
    state, message: error.message,
    ...(login ? { identity: { login } } : {}),
    ...(state === "rate_limited" && retry > 0 ? { retryAfterSeconds: retry } : {}),
  };
}

function action(connection: ProviderConnection, state: ConnectionState, health: ConnectionHealth): string | null {
  const login = "identity" in health ? health.identity?.login : undefined;
  if (connection.providerId === "github") {
    const host = connection.host;
    switch (state) {
      case "ready": return null;
      case "missing_cli": return "Install GitHub CLI (gh) on the computer running Staple and make sure it is on that process's PATH, then restart Staple.";
      case "unsupported_version": return "Update GitHub CLI to version 2.20 or newer on the computer running Staple.";
      case "unauthenticated": return `Run gh auth login --hostname ${host} on the computer running Staple.`;
      case "account_mismatch": return `Run gh auth switch --hostname ${host} --user ${connection.account}${login ? `, or reconnect Staple as ${login}` : ""}.`;
      case "forbidden": return "Check this account's repository access and organization SSO authorization.";
      case "rate_limited": return "Wait for the GitHub rate limit to reset, then check again.";
      case "offline": return `Check that the computer running Staple can reach ${host}.`;
      default: return "Check the connection again; update GitHub CLI if this keeps happening.";
    }
  }
  if (connection.providerId === "azure_devops") {
    switch (state) {
      case "ready": return null;
      case "unauthenticated": return `Set ${connection.credentialEnv} to a valid Azure DevOps personal access token with Work Items (Read) and Project and Team (Read) scopes in the environment of the Staple process, then restart it.`;
      case "account_mismatch": return `Use a token for the configured Azure DevOps user, or reconnect Staple${login ? ` as ${login}` : ""}.`;
      case "forbidden": return `Check that the token belongs to ${connection.host === "dev.azure.com" ? `the ${connection.organization} organization` : `the ${connection.organization} collection on ${connection.host}`} and can read its projects and work items.`;
      case "rate_limited": return "Wait for the Azure DevOps rate limit to reset, then check again.";
      case "offline": return `Check that the computer running Staple can reach ${connection.host}.`;
      default: return "Check the connection again later.";
    }
  }
  if (connection.providerId === "clickup") {
    switch (state) {
      case "ready": return null;
      case "unauthenticated": return `Set ${connection.credentialEnv} to a valid ClickUp personal API token in the environment of the Staple process, then restart it.`;
      case "account_mismatch": return `Set ${connection.credentialEnv} to the token of the ClickUp user this connection was made with, or connect ClickUp again${login ? ` as ${login}` : ""}.`;
      case "forbidden": return `Use a token for a ClickUp user who belongs to workspace ${connection.scopeId}.`;
      case "rate_limited": return "Wait for the ClickUp rate limit to reset, then check again.";
      case "offline": return "Check that the computer running Staple can reach api.clickup.com.";
      default: return "Check the connection again later.";
    }
  }
  switch (state) {
    case "ready": return null;
    case "unauthenticated": return `Set ${connection.credentialEnv} to a valid Linear personal API key in the environment of the Staple process, then restart it.`;
    case "account_mismatch": return `Use an API key for the configured Linear user, or reconnect Staple${login ? ` as ${login}` : ""}.`;
    case "forbidden": return "Check that the API key belongs to the configured Linear organization and can read its teams.";
    case "rate_limited": return "Wait for the Linear rate limit to reset, then check again.";
    case "offline": return "Check that the computer running Staple can reach linear.app.";
    default: return "Check the connection again later.";
  }
}

export function snapshot(connection: ProviderConnection, health: ConnectionHealth, checkedAt: Date): ConnectionHealthSnapshot {
  return {
    connectionId: connection.id,
    state: health.state,
    message: health.state === "ready" ? null : health.message,
    action: action(connection, health.state, health),
    identity: health.identity ?? null,
    checkedAt: checkedAt.toISOString(),
    retryAfterSeconds: health.state === "rate_limited" ? health.retryAfterSeconds ?? null : null,
  };
}

export function missingSnapshot(connectionId: string, checkedAt: Date): ConnectionHealthSnapshot {
  return {
    connectionId, state: "not_found", message: "This connection is not configured on this machine.",
    action: "Add the connection again in Settings > Integrations.", identity: null, checkedAt: checkedAt.toISOString(), retryAfterSeconds: null,
  };
}

interface Entry<T> { value: T | null; probedAt: number; inflight: Promise<T> | null }

/**
 * Last known results of an expensive provider probe, kept in memory by the process that serves
 * them. A key names one connection binding, so editing a connection starts it afresh. Probes
 * are coalesced per key, so concurrent readers and pollers never stack provider calls.
 */
export class ProbeCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  constructor(private readonly now: () => number = Date.now) {}

  peek(key: string): T | null { return this.entries.get(key)?.value ?? null; }

  /** Unforced reads reuse a result younger than the poll interval; forced ones probe unless one just ran. */
  check(key: string, probe: () => Promise<T>, force = false): Promise<T> {
    const entry = this.entry(key);
    if (entry.inflight) return entry.inflight;
    const age = this.now() - entry.probedAt;
    if (entry.value !== null && age < (force ? HEALTH_FORCE_FLOOR_MS : HEALTH_POLL_INTERVAL_SECONDS * 1000)) return Promise.resolve(entry.value);
    const inflight = probe().then(value => {
      entry.value = value; entry.probedAt = this.now();
      return value;
    }).finally(() => { entry.inflight = null; });
    entry.inflight = inflight;
    return inflight;
  }

  /** Evidence from outside a probe, such as a failed live read. */
  record(key: string, value: T) {
    const entry = this.entry(key);
    entry.value = value; entry.probedAt = this.now();
  }

  delete(key: string) { this.entries.delete(key); }

  /** The next unforced check probes again; one already running is still the one answered. */
  expire(key: string) { const entry = this.entries.get(key); if (entry) entry.probedAt = -Infinity; }

  private entry(key: string): Entry<T> {
    let entry = this.entries.get(key);
    if (!entry) this.entries.set(key, entry = { value: null, probedAt: -Infinity, inflight: null });
    return entry;
  }
}

/** One cache per process, shared by every request and workspace the process serves. */
export const processCaches = {
  health: new ProbeCache<ConnectionHealthSnapshot>(),
  detection: new ProbeCache<Array<{ host: string; login: string }>>(),
};
