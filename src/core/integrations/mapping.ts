import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../config/atomic.js";
import { Hub } from "../hub.js";
import type { WorkspaceStore } from "../store.js";
import type { ProviderConnection } from "./connections.js";
import { parseLegacyMapping, parseMapping, targetKey, type StoredTarget } from "./mapping-format.js";

export const MAPPING_SETTING = "integrations.mapping";
export const LEGACY_MAPPING_SETTING = "integrations.repositories";

export interface MappingTarget {
  key: string;
  providerId: StoredTarget["providerId"];
  host: string;
  scopeId: string;
  kind: StoredTarget["kind"];
  containerId: string;
  name: string | null;
  url: string | null;
  /** The machine connection that serves this target; null when none here can. */
  connectionId: string | null;
}
export type ScopeMode = "workspace" | "configured" | "all" | "none";
export interface SearchScope { mode: ScopeMode; workspaces: string[]; targets: MappingTarget[] }
export interface WorkspaceHandle { slug: string; store: WorkspaceStore }

/** Every available workspace this machine's hub knows, opened through the caller's own cache. */
export function hubWorkspaces(open: (slug: string) => WorkspaceStore): WorkspaceHandle[] {
  const hub = Hub.open();
  try { return hub.list().filter(entry => entry.available).map(entry => ({ slug: entry.slug, store: open(entry.slug) })); }
  finally { hub.close(); }
}

const cachedName = z.object({ name: z.string().min(1).max(512), url: z.string().url().max(2048).nullable() }).strict();

/**
 * Names last read for targets, on this machine. A name stored in the mapping wins; this fills
 * entries migrated from the legacy setting, which stored none.
 */
export class TargetNames {
  constructor(private readonly directory: string) {}
  private file(key: string) { return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`); }
  get(key: string): { name: string; url: string | null } | null {
    try { return cachedName.parse(JSON.parse(readFileSync(this.file(key), "utf8"))); } catch { return null; }
  }
  set(key: string, value: { name: string; url: string | null }) {
    writeFileAtomic(this.file(key), JSON.stringify(cachedName.parse(value)) + "\n", { mode: 0o600, dirMode: 0o700 });
  }
}

/** The workspace's stored targets: the synced mapping, or the legacy setting while nothing has been mapped since. */
export function storedMapping(store: WorkspaceStore, names?: TargetNames): StoredTarget[] {
  const raw = String(store.getSetting(MAPPING_SETTING) ?? "");
  if (raw.trim()) {
    try { return parseMapping(raw); } catch { return []; }
  }
  return parseLegacyMapping(String(store.getSetting(LEGACY_MAPPING_SETTING) ?? "")).map(target => {
    const cached = names?.get(targetKey(target));
    if (cached) return { ...target, ...cached };
    return { ...target, name: target.providerId === "github" ? repositoryNameFromLinks(store, target) : null };
  });
}

/** A repository's name, from any issue or PR already linked in it: "owner/repo#12" names "owner/repo". */
function repositoryNameFromLinks(store: WorkspaceStore, target: StoredTarget): string | null {
  const row = store.db.prepare("SELECT display_key FROM external_resources WHERE provider_id='github' AND host=? AND container_id=? ORDER BY updated_at DESC LIMIT 1")
    .get(target.host, target.containerId) as { display_key: string } | undefined;
  return row ? row.display_key.replace(/#[0-9]+$/, "") : null;
}

export function writeMapping(store: WorkspaceStore, targets: StoredTarget[], actor: string) {
  store.setSetting(MAPPING_SETTING, JSON.stringify(targets), actor);
  // The legacy list is retired once the workspace has a mapping of its own.
  if (String(store.getSetting(LEGACY_MAPPING_SETTING) ?? "")) store.resetSetting(LEGACY_MAPPING_SETTING, actor);
}

/** The connection on this machine that reads a target: same provider and host, and beyond GitHub the same organization. */
export function servingConnection(target: Pick<StoredTarget, "providerId" | "host" | "scopeId">, connections: ProviderConnection[]): ProviderConnection | null {
  return connections.find(c => c.providerId === target.providerId && c.host === target.host
    && (c.providerId === "github" || c.scopeId === target.scopeId)) ?? null;
}

export function present(target: StoredTarget, connections: ProviderConnection[]): MappingTarget {
  return { key: targetKey(target), ...target, connectionId: servingConnection(target, connections)?.id ?? null };
}

/**
 * The one scope rule for search and linking. A workspace with a mapping searches exactly that;
 * one without inherits every mapping on this machine; All workspaces is that same union; and with
 * nothing mapped anywhere there is no live search (an exact pasted URL still works).
 */
export function resolveScope(current: WorkspaceHandle | null, all: WorkspaceHandle[], allWorkspaces: boolean,
  connections: ProviderConnection[], names?: TargetNames): SearchScope {
  const own = current && !allWorkspaces ? storedMapping(current.store, names) : [];
  if (current && !allWorkspaces && own.length) {
    return { mode: "workspace", workspaces: [current.slug], targets: own.map(t => present(t, connections)) };
  }
  const byKey = new Map<string, MappingTarget>();
  const workspaces: string[] = [];
  for (const handle of all) {
    const mapped = storedMapping(handle.store, names);
    if (mapped.length) workspaces.push(handle.slug);
    for (const target of mapped) {
      const shown = present(target, connections);
      const seen = byKey.get(shown.key);
      if (!seen || (!seen.name && shown.name)) byKey.set(shown.key, shown);
    }
  }
  const targets = [...byKey.values()];
  if (!targets.length) return { mode: "none", workspaces: [], targets: [] };
  return { mode: allWorkspaces || !current ? "all" : "configured", workspaces, targets };
}
