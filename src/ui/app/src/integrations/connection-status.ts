/**
 * What a connection's health reads as: one short phrase and one tone per state, plus the
 * merge that folds fresh snapshots into the connections list. Pure.
 */
import type { ProviderConnection } from "../../../../core/integrations/connections";
import type { ConnectionHealthSnapshot, ConnectionState } from "../../../../core/integrations/contracts";

export type ConnectionView = ProviderConnection & { health: ConnectionHealthSnapshot | null };

/** ok = working, warn = will recover or needs a small step, bad = needs the person, idle = not known yet. */
export type StatusTone = "ok" | "warn" | "bad" | "idle";

const WORDS: Record<ConnectionState, { label: string; tone: StatusTone }> = {
  ready: { label: "Connected", tone: "ok" },
  unauthenticated: { label: "Sign-in needed", tone: "bad" },
  account_mismatch: { label: "Wrong account", tone: "bad" },
  forbidden: { label: "No access", tone: "bad" },
  missing_cli: { label: "CLI missing", tone: "bad" },
  unsupported_version: { label: "Update CLI", tone: "warn" },
  rate_limited: { label: "Rate limited", tone: "warn" },
  offline: { label: "Offline", tone: "warn" },
  unavailable: { label: "Unavailable", tone: "warn" },
  not_found: { label: "Removed", tone: "idle" },
};

export interface ConnectionStatus {
  label: string;
  tone: StatusTone;
}

/** A null snapshot is a connection nobody has probed since the server started. */
export function connectionStatus(health: ConnectionHealthSnapshot | null, now = Date.now()): ConnectionStatus {
  if (!health) return { label: "Not checked yet", tone: "idle" };
  const words = WORDS[health.state] ?? { label: "Unavailable", tone: "warn" as const };
  if (health.state === "rate_limited" && health.retryAfterSeconds) {
    const left = Date.parse(health.checkedAt) + health.retryAfterSeconds * 1000 - now;
    if (left > 0) return { label: `Rate limited · ${Math.ceil(left / 60_000)} min`, tone: words.tone };
  }
  return words;
}

/** True when live reads through this connection are expected to work. */
export const isReady = (connection: ConnectionView): boolean => connection.health?.state === "ready";

/** Fold probe results into the list; a connection without a new snapshot keeps the one it had. */
export function mergeHealth(connections: readonly ConnectionView[], snapshots: readonly ConnectionHealthSnapshot[]): ConnectionView[] {
  const byId = new Map(snapshots.map((s) => [s.connectionId, s]));
  return connections.map((c) => (byId.has(c.id) ? { ...c, health: byId.get(c.id)! } : c));
}

/** The oldest probe among the connections: what "Checked 40 s ago" for the whole list means. */
export function oldestCheck(connections: readonly ConnectionView[]): string | null {
  const times = connections.map((c) => c.health?.checkedAt).filter((t): t is string => !!t).sort();
  return times.length === connections.length && times.length > 0 ? times[0]! : null;
}

/** "just now", "40 s ago", "3 min ago": short enough to sit beside a refresh button. */
export function checkedAgo(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const age = now - Date.parse(iso);
  if (Number.isNaN(age)) return null;
  if (age < 10_000) return "just now";
  if (age < 60_000) return `${Math.floor(age / 1000)} s ago`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} min ago`;
  return `${Math.floor(age / 3_600_000)} hr ago`;
}
