import type { ConnectionState, ExternalItem, ResolvedExternalItem } from "../../../../core/integrations/contracts";
import type { ExternalResource, ExternalLink } from "../../../../core/integrations/link-store";
import type { MappingTarget, SearchScope } from "../../../../core/integrations/mapping";
import type { Issue } from "@/lib/types";
import { containerLabel } from "./link-state";
export type { ExternalResource, ExternalLink, MappingTarget, SearchScope };
export type SourceItem = ResolvedExternalItem | ExternalItem | ExternalResource;
export interface SearchHit {
  item: SourceItem;
  associations: Issue[];
}
/** A live hit carries the mapped repository, team or project it came from. */
export type RemoteHit = SearchHit & { targetKey: string };
/** A source that could not be searched; the rest of the answer still stands. */
export interface SearchFailure {
  connectionId: string | null;
  targetKeys: string[];
  state: ConnectionState;
  message: string;
  /** What the person does next, in the same words Settings shows; absent from older servers. */
  action?: string | null;
}
/** The `search` answer. `local` (Staple's own tasks) is still sent; the link dialog ignores it. */
export interface MixedResults {
  local: Issue[];
  counts?: Record<string, { issues: number; pullRequests: number }>;
  cached: SearchHit[];
  remote: RemoteHit[];
  nextCursor: string | null;
  scope: SearchScope;
  failures: SearchFailure[];
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
