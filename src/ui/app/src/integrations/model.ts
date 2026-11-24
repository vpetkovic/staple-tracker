import type { ExternalItem, ResolvedExternalItem } from "../../../../core/integrations/contracts";
import type { ExternalResource, ExternalLink } from "../../../../core/integrations/link-store";
import type { Issue } from "@/lib/types";
import { containerLabel } from "./link-state";
export type { ExternalResource, ExternalLink };
export type SourceItem = ResolvedExternalItem | ExternalItem | ExternalResource;
export interface SearchHit {
  item: SourceItem;
  associations: Issue[];
}
export interface MixedResults {
  local: Issue[];
  counts?: Record<string, { issues: number; pullRequests: number }>;
  cached: SearchHit[];
  remote: SearchHit[];
  nextCursor: string | null;
  execution: "local" | "cached_only";
}
export interface MatchPreview {
  item: SourceItem;
  associations: Issue[];
  candidates: Array<{ issue: Issue; reasons: string[] }>;
  truncated: boolean;
}
export function resourceKey(item: SourceItem): string {
  const r = item.ref;
  return JSON.stringify([r.providerId, r.host, r.scopeId, r.containerId, r.kind, r.id]);
}
export function uniqueHits(cached: SearchHit[], live: SearchHit[]): SearchHit[] {
  const hits = new Map(cached.map((hit) => [resourceKey(hit.item), hit]));
  for (const hit of live) hits.set(resourceKey(hit.item), hit);
  return [...hits.values()];
}
export function sourceInput(item: SourceItem, connectionId?: string): Record<string, unknown> {
  return "id" in item
    ? { resourceId: item.id }
    : { url: item.url, connectionId: connectionId || undefined };
}
export function freshness(item: SourceItem, now = Date.now()): string {
  if (!("fetchedAt" in item) || !item.fetchedAt) return "URL reference · context not fetched";
  const age = now - Date.parse(item.fetchedAt);
  return `${age > 24 * 60 * 60 * 1000 ? "Stale cache" : "Cached context"} · ${new Date(item.fetchedAt).toLocaleString()}`;
}

export function groupLinks(
  links: ExternalLink[],
): Array<{ key: string; label: string; links: ExternalLink[] }> {
  const groups = new Map<string, { key: string; label: string; links: ExternalLink[] }>();
  for (const link of links) {
    const r = link.resource;
    const key = JSON.stringify([r.ref.providerId, r.ref.host, r.ref.scopeId, r.ref.containerId]);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: containerLabel(r), links: [] };
      groups.set(key, group);
    }
    group.links.push(link);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
