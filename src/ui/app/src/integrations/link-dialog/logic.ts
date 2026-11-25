/**
 * The link dialog's decisions, without a DOM: what the field sends, how answers merge and
 * group, what a row's tag says, how the scope and a failed source read, and where the
 * selection goes. The component only wires these to state and requests.
 */
import type { Issue } from "@/lib/types";
import type { ConnectionHealthSnapshot } from "../../../../../core/integrations/contracts";
import { connectionStatus, type ConnectionView } from "../connection-status";
import { containerLabel, providerName, savedAge } from "../link-state";
import { resourceKey, uniqueHits, type MappingTarget, type MixedResults, type SearchFailure, type SearchHit, type SearchScope, type SourceItem } from "../model";
import type { KindFilter } from "./last-kind";

export type ItemKind = "issue" | "pull_request";

/** A pasted https link is resolved; anything else, empty text included, is a search. */
export function queryKind(text: string): "preview" | "search" {
  return /^https:\/\//i.test(text.trim()) ? "preview" : "search";
}

/** The `mapping {allWorkspaces:true}` answer. */
export interface MappingAnswer {
  workspaces: Array<{ workspace: string; targets: MappingTarget[] }>;
  targets: MappingTarget[];
}

/** The scope a search will use, from the mapping alone: the label before the first answer arrives. */
export function scopeFromMapping(mapping: MappingAnswer, ws: string, allWorkspaces: boolean): SearchScope {
  const own = !allWorkspaces && ws ? mapping.workspaces.find((w) => w.workspace === ws)?.targets ?? [] : [];
  if (own.length) return { mode: "workspace", workspaces: [ws], targets: own };
  if (!mapping.targets.length) return { mode: "none", workspaces: [], targets: [] };
  return {
    mode: allWorkspaces || !ws ? "all" : "configured",
    workspaces: mapping.workspaces.filter((w) => w.targets.length).map((w) => w.workspace),
    targets: mapping.targets,
  };
}

/** The kinds to ask for. Linear has no pull requests, so a Linear source drops that request. */
export function searchKinds(filter: KindFilter, containerKey: string | null, targets: readonly MappingTarget[]): ItemKind[] {
  const kinds: ItemKind[] = filter === "all" ? ["issue", "pull_request"] : [filter];
  const narrowed = containerKey ? targets.find((t) => t.key === containerKey) : undefined;
  return narrowed && narrowed.providerId !== "github" ? kinds.filter((k) => k === "issue") : kinds;
}

/** Numbers requests so an answer for an older input can be dropped. */
export function createLatest() {
  let current = 0;
  return { next: () => ++current, isLatest: (n: number) => n === current };
}

export interface ResultGroup {
  key: string;
  label: string;
  providerId: string;
  hits: SearchHit[];
}

/**
 * One list from every answer (both kinds, every page): a saved copy and a live read of the
 * same item appear once, the live one winning. Live hits group under their target, saved-only
 * hits under the mapped target they belong to (after its live hits), else under their
 * repository or team key; each group keeps the server's order.
 */
export function groupResults(answers: ReadonlyArray<Pick<MixedResults, "cached" | "remote">>, targets: readonly MappingTarget[]): ResultGroup[] {
  const remote = answers.flatMap((a) => a.remote);
  const live = new Set(remote.map((h) => resourceKey(h.item)));
  const merged = uniqueHits(answers.flatMap((a) => a.cached), remote);
  const groups = new Map<string, ResultGroup>();
  const add = (key: string, label: string, providerId: string, hit: SearchHit) => {
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, label, providerId, hits: [] }));
    if (!group.hits.some((h) => resourceKey(h.item) === resourceKey(hit.item))) group.hits.push(hit);
  };
  for (const hit of remote) {
    const target = targets.find((t) => t.key === hit.targetKey);
    add(`target:${hit.targetKey}`, target?.name ?? containerLabel(hit.item), hit.item.ref.providerId, hit);
  }
  for (const hit of merged) {
    if (live.has(resourceKey(hit.item))) continue;
    const ref = hit.item.ref;
    const mapped = targets.find((t) => t.kind !== "project" && t.providerId === ref.providerId && t.host === ref.host
      && t.scopeId === ref.scopeId && t.containerId.toLowerCase() === ref.containerId.toLowerCase());
    if (mapped) {
      add(`target:${mapped.key}`, mapped.name ?? containerLabel(hit.item), ref.providerId, hit);
      continue;
    }
    const label = containerLabel(hit.item);
    add(`saved:${hit.item.ref.providerId}:${label}`, label, hit.item.ref.providerId, hit);
  }
  return [...groups.values()];
}

export type LinkTag = { kind: "here" } | { kind: "elsewhere"; label: string } | null;

/** What the end of a row says: linked to the target task, to others, or nothing. */
export function linkTag(associations: readonly Issue[], targetId: string | null, linkedHere: boolean): LinkTag {
  if (linkedHere) return { kind: "here" };
  const others = associations.filter((a) => a.id !== targetId);
  if (others.length === 0) return null;
  return { kind: "elsewhere", label: others.length === 1 ? `Linked to ${others[0]!.identifier}` : `Linked to ${others.length} tasks` };
}

const sources = (n: number) => `${n} source${n === 1 ? "" : "s"}`;

/** The scope control's label: the scope the server says it used. */
export function scopeLabel(scope: Pick<SearchScope, "mode" | "targets">, workspace: string): string {
  switch (scope.mode) {
    case "workspace": return `${workspace} · ${sources(scope.targets.length)}`;
    case "configured": return `Everything mapped · ${sources(scope.targets.length)}`;
    case "all": return `All workspaces · ${sources(scope.targets.length)}`;
    case "none": return "Nothing to search";
  }
}

/** Why an unmapped workspace searches everything: the first line of the scope menu. */
export function scopeNote(scope: Pick<SearchScope, "mode">, workspace: string): string | null {
  return scope.mode === "configured" ? `${workspace} has no sources of its own, so it searches everything mapped.` : null;
}

/** One line per failed source, in the words Settings uses for the connection's state. */
export function failureLine(failure: SearchFailure, targets: readonly MappingTarget[]): string {
  const named = failure.targetKeys.map((key) => targets.find((t) => t.key === key));
  const provider = named.find(Boolean)?.providerId;
  const status = connectionStatus({ connectionId: failure.connectionId ?? "", state: failure.state, message: failure.message,
    action: null, identity: null, checkedAt: new Date().toISOString(), retryAfterSeconds: null } satisfies ConnectionHealthSnapshot);
  const names = named.map((t) => (t ? sourceName(t) : "a source no longer chosen")).join(", ");
  return `${provider ? providerName(provider) : "A connection"} ${status.label.toLowerCase()} on this computer. Showing saved copies for ${names}.`;
}

/** Next or previous key, wrapping at both ends. */
export function moveSelection(keys: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at < 0) return keys[delta === 1 ? 0 : keys.length - 1]!;
  return keys[(at + delta + keys.length) % keys.length]!;
}

/** After a new list arrives: the same item when it is still there, else the first. */
export function keepSelection(keys: readonly string[], previous: string | null): string | null {
  if (previous !== null && keys.includes(previous)) return previous;
  return keys[0] ?? null;
}

/** The preview's freshness: read within the minute, the saved copy's age, or never read. */
export function freshnessLine(item: SourceItem, now = Date.now()): { text: string; stale: boolean } {
  const age = savedAge(item, now);
  if (!age) return { text: "Linked by URL, not read yet", stale: false };
  return { text: age.short === "now" ? "Read just now" : age.sentence, stale: age.stale };
}

/** The target an `outside_scope` refusal offers to map, when it resolved one. */
export function outsideScopeTarget(error: unknown): MappingTarget | null {
  if (typeof error !== "object" || error === null) return null;
  const detail = (error as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const { reason, target } = detail as { reason?: unknown; target?: unknown };
  return reason === "outside_scope" && typeof target === "object" && target !== null ? (target as MappingTarget) : null;
}

/** A source's name for the screen. One mapped before names were stored is named by its kind, never by its key. */
export function sourceName(target: Pick<MappingTarget, "name" | "kind">): string {
  return target.name ?? `Unnamed ${target.kind}`;
}

/**
 * What a list of results is the answer to. The list on screen may be linked from only while
 * it still answers what the field, the filter and the source menu say now.
 */
export function answerFor(text: string, kind: KindFilter, containerKey: string | null): string {
  return JSON.stringify([text.trim(), kind, containerKey]);
}

/**
 * The connection to read an item through, so the server never has to choose between two
 * accounts on one host: the one serving the source a live result came from; for a pasted
 * link, a ready connection on its host, preferring one that serves a source in scope.
 */
export function connectionFor(
  where: { providerId?: string; host: string },
  targetKey: string | undefined,
  targets: readonly MappingTarget[],
  connections: ReadonlyArray<Pick<ConnectionView, "id" | "providerId" | "host" | "health">>,
): string | undefined {
  const served = targets.find((t) => t.key === targetKey)?.connectionId;
  if (served) return served;
  const ready = connections.filter((c) => (!where.providerId || c.providerId === where.providerId) && c.host === where.host && c.health?.state === "ready");
  const inScope = new Set(targets.map((t) => t.connectionId));
  return (ready.find((c) => inScope.has(c.id)) ?? ready[0])?.id;
}
