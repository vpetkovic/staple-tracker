/**
 * Which workspaces on this computer are shared, and with whom: what the shared badge, the
 * switcher's marker and the locked automatic-sync toggle read.
 *
 * One local read (`/api/cloud/shared-workspaces`), the members list this machine already
 * holds for each workspace, and never a request to the sync service. Held in a module so the
 * top bar, the switcher and Settings agree without each asking. Refreshed when the shell
 * opens, when the page's change fingerprint moves (a sync or a member change rewrote a list)
 * and after anything here changes the members.
 *
 * A workspace is shared when its member list names more than one current member, the same
 * single definition the server uses (`isSharedWorkspace`). With no list, nothing is shared,
 * and every surface that reads this renders exactly what it did before.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getSharedWorkspaces } from "./api";
import type { CloudSharedWorkspace, CloudSurfaceReport } from "./types";

let shared: ReadonlyMap<string, CloudSharedWorkspace> = new Map();
let asked = false;
const listeners = new Set<() => void>();

function publish(next: ReadonlyMap<string, CloudSharedWorkspace>): void {
  shared = next;
  for (const listener of listeners) listener();
}

/** Ask again. Local, cheap, and safe to call after anything that may have changed members. */
export function refreshSharedWorkspaces(): Promise<void> {
  asked = true;
  return getSharedWorkspaces().then(
    (answer) => publish(new Map(answer.workspaces.map((row) => [row.slug, row]))),
    () => undefined,
  );
}

/** For tests and screenshots: set what the store holds. */
export function setSharedWorkspaces(rows: readonly CloudSharedWorkspace[]): void {
  publish(new Map(rows.map((row) => [row.slug, row])));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every workspace's sharing, asking once on first use. */
export function useSharedWorkspaces(): ReadonlyMap<string, CloudSharedWorkspace> {
  useEffect(() => {
    if (!asked) void refreshSharedWorkspaces();
  }, []);
  return useSyncExternalStore(subscribe, () => shared, () => shared);
}

/** One workspace's sharing, or null when it is not shared (or not known to be). */
export function sharedRow(rows: ReadonlyMap<string, CloudSharedWorkspace>, slug: string): CloudSharedWorkspace | null {
  const row = rows.get(slug);
  return row && row.shared ? row : null;
}

/** "Shared · 2 members". */
export function sharedBadgeText(row: CloudSharedWorkspace): string {
  const n = row.members.length;
  return `Shared · ${n} ${n === 1 ? "member" : "members"}`;
}

/** The chips to draw: up to `max` members, yourself last, and how many more there are. */
export function sharedChips(row: CloudSharedWorkspace, max = 3): { shown: CloudSharedWorkspace["members"]; more: number } {
  const ordered = [...row.members].sort((a, b) => Number(a.self) - Number(b.self) || Number(b.isOwner) - Number(a.isOwner));
  return { shown: ordered.slice(0, max), more: Math.max(0, ordered.length - max) };
}

/**
 * The sync dot: syncing (automatic and healthy), attention (offline: it will catch up), or
 * stopped (revoked, removed, credential missing). Manual is "idle", which a shared workspace
 * should never be for long, since sharing turns automatic sync on.
 */
export type SyncDot = "syncing" | "attention" | "stopped" | "idle";

export function syncDot(report: Pick<CloudSurfaceReport, "state" | "mode"> | null): SyncDot {
  if (report === null) return "idle";
  if (report.state === "offline") return "attention";
  if (report.state === "revoked" || report.state === "removed" || report.state === "auth_failed") return "stopped";
  return report.mode === "automatic" ? "syncing" : "idle";
}

export function syncDotLabel(dot: SyncDot): string {
  switch (dot) {
    case "syncing":
      return "Syncing automatically";
    case "attention":
      return "Offline: changes sync when the connection is back";
    case "stopped":
      return "Not syncing: see Cloud sync";
    case "idle":
      return "Not syncing automatically";
  }
}
