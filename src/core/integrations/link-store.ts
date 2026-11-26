import { createHash } from "node:crypto";
import type { WorkspaceStore } from "../store.js";
import { StapleError, nowIso } from "../types.js";
import type { ExternalItem, ExternalItemRef, PullRequestChecks, PullRequestDetails, ResolvedExternalItem } from "./contracts.js";
import { externalItemKey } from "./provider.js";

/** The event an unlink records, so `integrations discover` never links the same pull request to the ticket again. */
export const EXTERNAL_UNLINKED_EVENT = "external_unlinked";

export interface ExternalResource extends ResolvedExternalItem {
  id: string;
  title: string | null;
  body: string | null;
  status: ExternalItem["status"];
  fetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contextShared: boolean;
  /** ClickUp: where the task sat when last read on this machine, so a saved copy groups under its mapped space or list. */
  spaceId?: string;
  listIds?: string[];
  /** A pull request read with its head on this machine: the branch, the commit and its checks. */
  pullRequest?: PullRequestDetails;
}

/** A linked pull request as a row and the attention list read it: one per link, from the saved copy. */
export interface LinkedPullRequest {
  resourceId: string;
  providerId: string;
  key: string;
  url: string;
  /** The provider's number, from the key (`owner/repo#12` is 12); null when the key names none. */
  number: number | null;
  /** `draft`, `open`, `merged` or `closed` for GitHub; null when no state was read here or shared. */
  state: string | null;
  title: string | null;
  checks: PullRequestChecks | null;
  fetchedAt: string | null;
  linkedAt: string;
}

export interface ExternalLink {
  id: string;
  issueId: string;
  resource: ExternalResource;
  parentResourceId: string | null;
  parentMissing: boolean;
  position: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalLinkPreview {
  id: string; providerId: string; host: string; containerId: string;
  key: string; url: string; title: string | null;
  /** Native state from the same context as the title; null when none was read on this machine or shared. */
  status: ExternalItem["status"];
}
export interface ExternalRowSummary {
  issues: { count: number; items: ExternalLinkPreview[] };
  pullRequests: { count: number; items: ExternalLinkPreview[] };
}

export interface ResourceRow {
  id: string; provider_id: string; host: string; scope_id: string; container_id: string;
  remote_id: string; kind: ExternalItemRef["kind"]; display_key: string; url: string;
  title: string | null; body: string | null; status_json: string | null; fetched_at: string | null;
  created_at: string; updated_at: string; context_shared: number;
}
export interface LinkRow {
  id: string; issue_id: string; resource_id: string; parent_resource_id: string | null; position: number;
  created_by: string; created_at: string; updated_at: string;
}

export function externalResourceId(ref: ExternalItemRef): string { return hash(externalItemKey(ref)); }
export function externalLinkId(issueId: string, resourceId: string): string { return hash(JSON.stringify([issueId, resourceId])); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

export function resourceFromRow(row: ResourceRow): ExternalResource {
  return { id: row.id, ref: { providerId: row.provider_id, host: row.host, scopeId: row.scope_id, containerId: row.container_id, id: row.remote_id, kind: row.kind },
    key: row.display_key, url: row.url, title: row.title, body: row.body,
    status: readStatus(row.status_json), ...readExtras(row.status_json), fetchedAt: row.fetched_at, createdAt: row.created_at, updatedAt: row.updated_at, contextShared: row.context_shared === 1 };
}

/**
 * `status_json` holds the native state and, for a ClickUp task, the space and lists it sat in when
 * read, and for a pull request read with its head, the head branch, commit and checks. Both stay
 * with the saved copy on this machine: the wire carries only the state.
 */
function statusJson(item: Pick<ExternalItem, "status" | "spaceId" | "listIds" | "pullRequest">): string | null {
  if (!item.status) return null;
  return JSON.stringify({ id: item.status.id, name: item.status.name,
    ...(item.spaceId ? { spaceId: item.spaceId } : {}), ...(item.listIds?.length ? { listIds: item.listIds } : {}),
    ...(item.pullRequest ? { pullRequest: item.pullRequest } : {}) });
}
function readStatus(json: string | null): ExternalItem["status"] {
  if (json === null) return null;
  const { id, name } = JSON.parse(json) as { id: string; name: string };
  return { id, name };
}
function readExtras(json: string | null): Pick<ExternalResource, "spaceId" | "listIds" | "pullRequest"> {
  if (json === null) return {};
  const { spaceId, listIds, pullRequest } = JSON.parse(json) as { spaceId?: unknown; listIds?: unknown; pullRequest?: unknown };
  return { ...(typeof spaceId === "string" ? { spaceId } : {}),
    ...(Array.isArray(listIds) && listIds.every(l => typeof l === "string") ? { listIds: listIds as string[] } : {}),
    ...(pullRequestDetails(pullRequest) ? { pullRequest: pullRequest as PullRequestDetails } : {}) };
}
const CHECK_STATES = new Set(["passing", "failing", "pending"]);
/** Whether a value is well-formed pull request details, within their size limits. */
function pullRequestDetails(value: unknown): value is PullRequestDetails {
  if (!value || typeof value !== "object") return false;
  const { headBranch, headSha, checks, createdAt } = value as Record<string, unknown>;
  if (typeof headBranch !== "string" || !headBranch || headBranch.length > 255 || typeof headSha !== "string" || !/^[0-9a-f]{7,64}$/.test(headSha)) return false;
  if (createdAt !== undefined && createdAt !== null && (typeof createdAt !== "string" || createdAt.length > 64)) return false;
  if (checks === null) return true;
  if (!checks || typeof checks !== "object") return false;
  const { state, failing, completedAt } = checks as Record<string, unknown>;
  return typeof state === "string" && CHECK_STATES.has(state) && Array.isArray(failing) && failing.length <= 10
    && failing.every(name => typeof name === "string" && name.length <= 512)
    && (completedAt === null || (typeof completedAt === "string" && completedAt.length <= 64));
}

/** Owns source context and association choices; never changes local execution fields. */
export class ExternalLinkStore {
  constructor(private readonly store: WorkspaceStore) {}
  private get db() { return this.store.db; }

  resource(id: string): ExternalResource {
    const row = this.db.prepare("SELECT * FROM external_resources WHERE id = ?").get(id) as ResourceRow | undefined;
    if (!row) throw new StapleError("not_found", "External resource was not found");
    const privateCache = this.db.prepare("SELECT title, body, status_json, fetched_at FROM external_private_cache WHERE resource_id = ?").get(id) as Pick<ResourceRow, "title" | "body" | "status_json" | "fetched_at"> | undefined;
    return resourceFromRow(privateCache && (!row.fetched_at || privateCache.fetched_at! >= row.fetched_at) ? { ...row, ...privateCache } : row);
  }

  find(ref: ExternalItemRef): ExternalResource | null {
    const row = this.db.prepare("SELECT * FROM external_resources WHERE id = ?").get(externalResourceId(ref)) as ResourceRow | undefined;
    return row ? this.resource(row.id) : null;
  }

  /** URL-only resolution cannot erase cached context, and an older read cannot replace a newer read. */
  remember(input: ResolvedExternalItem | ExternalItem, actor: string | null = null): ExternalResource {
    const id = externalResourceId(input.ref);
    if (Object.values(input.ref).some(value => typeof value !== "string" || value.length > 512) || input.url.length > 8192) {
      throw new StapleError("validation", "External identity and URL exceed their size limits");
    }
    const host = new URL(`https://${input.ref.host}`).host;
    let url: URL;
    try {
      url = new URL(input.url);
      if (url.protocol !== "https:" || url.host !== host || url.username || url.password
        || [...url.searchParams.keys()].some(k => /^(?:access_token|token|authorization|password|client_secret|api_key)$/i.test(k))) throw new Error();
    } catch { throw new StapleError("validation", "An external resource needs an HTTPS URL on its provider host without credentials"); }
    if (!input.key.trim() || input.key.length > 512) throw new StapleError("validation", "External display key needs 1-512 characters");
    const full = "fetchedAt" in input;
    const fetchedAt = full ? new Date(input.fetchedAt) : null;
    if (full && (!Number.isFinite(fetchedAt!.valueOf()) || typeof input.title !== "string" || (input.body !== null && typeof input.body !== "string"))) {
      throw new StapleError("validation", "External context needs a title, optional body and valid read timestamp");
    }
    if (full && (input.title.length > 8192 || Buffer.byteLength(input.body ?? "") > 256 * 1024
      || (input.status !== null && (!input.status || typeof input.status !== "object" || typeof input.status.id !== "string" || typeof input.status.name !== "string" || input.status.id.length > 512 || input.status.name.length > 512)))) {
      throw new StapleError("validation", "External context exceeds its size limits or has an invalid status");
    }
    if (full && ((input.spaceId !== undefined && (typeof input.spaceId !== "string" || input.spaceId.length > 64))
      || (input.listIds !== undefined && (!Array.isArray(input.listIds) || input.listIds.length > 1000 || input.listIds.some(l => typeof l !== "string" || l.length > 64))))) {
      throw new StapleError("validation", "External placement exceeds its size limits");
    }
    if (full && input.pullRequest !== undefined && (input.ref.kind !== "pull_request" || !pullRequestDetails(input.pullRequest))) {
      throw new StapleError("validation", "Pull request details are malformed or exceed their size limits");
    }
    return this.store.journaled(() => {
      const prior = this.find(input.ref);
      if (prior?.fetchedAt && (!full || prior.fetchedAt > fetchedAt!.toISOString())) return prior;
      const before = prior ? resourcePayload(this.db.prepare("SELECT * FROM external_resources WHERE id=?").get(id) as unknown as ResourceRow) : null;
      const timestamp = nowIso();
      const shared = prior?.contextShared === true;
      this.db.prepare(`INSERT INTO external_resources
        (id, provider_id, host, scope_id, container_id, remote_id, kind, display_key, url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET display_key=excluded.display_key, url=excluded.url, updated_at=excluded.updated_at`)
        .run(id, input.ref.providerId, host, input.ref.scopeId, input.ref.containerId, input.ref.id, input.ref.kind,
          input.key, url.href, prior?.createdAt ?? timestamp, timestamp);
      if (full) {
        const status = statusJson(input);
        this.db.prepare(`INSERT INTO external_private_cache (resource_id,title,body,status_json,fetched_at) VALUES (?,?,?,?,?)
          ON CONFLICT(resource_id) DO UPDATE SET title=excluded.title,body=excluded.body,status_json=excluded.status_json,fetched_at=excluded.fetched_at`)
          .run(id,input.title,input.body,status,fetchedAt!.toISOString());
        // A read that changed nothing others see leaves the shared copy as it was: a poll re-reading
        // an unchanged pull request must not send a sync operation every time.
        const sharedRow = shared ? this.db.prepare("SELECT title, body, status_json FROM external_resources WHERE id=?").get(id) as Pick<ResourceRow,"title"|"body"|"status_json"> : null;
        const unchanged = sharedRow !== null && sharedRow.title === input.title && sharedRow.body === input.body
          && JSON.stringify(readStatus(sharedRow.status_json)) === JSON.stringify(readStatus(status));
        if (shared && !unchanged) this.db.prepare("UPDATE external_resources SET title=?,body=?,status_json=?,fetched_at=? WHERE id=?")
          .run(input.title,input.body,status,fetchedAt!.toISOString(),id);
      }
      const after = resourcePayload(this.db.prepare("SELECT * FROM external_resources WHERE id=?").get(id) as unknown as ResourceRow);
      if (before && JSON.stringify({ ...before, updatedAt: null }) === JSON.stringify({ ...after, updatedAt: null })) {
        this.db.prepare("UPDATE external_resources SET updated_at=? WHERE id=?").run(prior!.updatedAt, id);
      } else this.recordResource(id, prior ? "update" : "create", actor);
      return this.resource(id);
    });
  }

  /** Sharing changes the current replicated copy. Earlier cloud history/backups are retained. */
  shareContext(resourceId: string, enabled: boolean, actor: string): ExternalResource {
    if (!actor.trim()) throw new StapleError("validation", "Context sharing needs an actor");
    return this.store.journaled(() => {
      const current = this.resource(resourceId);
      if (enabled && current.fetchedAt === null) throw new StapleError("validation", "Read source context before sharing it");
      this.db.prepare("UPDATE external_resources SET context_shared=?, title=?, body=?, status_json=?, fetched_at=?, updated_at=? WHERE id=?")
        .run(enabled ? 1 : 0, enabled ? current.title : null, enabled ? current.body : null,
          enabled ? statusJson(current) : null, enabled ? current.fetchedAt : null, nowIso(), resourceId);
      this.recordResource(resourceId, "update", actor);
      return this.resource(resourceId);
    });
  }

  private recordStack(issueId: string, actor: string) {
    this.store.journal.record({ entity: "externalStack", entityId: issueId, verb: "update", payload: { entries: stackPayload(this.db, issueId) }, actor });
  }
  private recordResource(id: string, verb: "create" | "update", actor: string | null) {
    const row = this.db.prepare("SELECT * FROM external_resources WHERE id=?").get(id) as unknown as ResourceRow;
    this.store.journal.record({ entity: "externalResource", entityId: id, verb, payload: resourcePayload(row), actor });
  }
  private recordLink(id: string, verb: "create" | "update", actor: string) {
    const row = this.db.prepare("SELECT * FROM external_links WHERE id=?").get(id) as unknown as LinkRow;
    this.store.journal.record({ entity: "externalLink", entityId: id, verb, payload: linkPayload(row), actor });
  }

  link(ref: string, input: ResolvedExternalItem | ExternalItem, actor: string): ExternalLink {
    if (!actor.trim()) throw new StapleError("validation", "An external link needs an actor");
    return this.store.journaled(() => {
      const issue = this.store.getIssue(ref);
      const resource = this.remember(input, actor);
      const timestamp = nowIso();
      const id = externalLinkId(issue.id, resource.id);
      const inserted = this.db.prepare(`INSERT INTO external_links (id, issue_id, resource_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(issue_id, resource_id) DO NOTHING`).run(id, issue.id, resource.id, actor, timestamp, timestamp);
      if (Number(inserted.changes) > 0) {
        this.recordLink(id, "create", actor);
        this.recordStack(issue.id, actor);
      }
      return this.list(issue.id).find(l => l.id === id)!;
    });
  }

  /**
   * Remove the association. `remember` records that a person did (an `external_unlinked` event),
   * so discovery never links the same pull request to this ticket again by itself; `insertEvent`
   * comes in from the caller because this module sits below the event log in the import graph.
   */
  unlink(ref: string, resourceId: string, actor: string, remember?: (issueId: string) => void): void {
    if (!actor.trim()) throw new StapleError("validation", "Unlinking needs an actor");
    this.store.journaled(() => {
      const issue = this.store.getIssue(ref);
      const id = externalLinkId(issue.id, resourceId);
      const removed = this.db.prepare("DELETE FROM external_links WHERE id = ?").run(id);
      if (Number(removed.changes) > 0) {
        this.store.journal.record({ entity: "externalLink", entityId: id, verb: "delete", actor });
        this.recordStack(issue.id, actor);
        remember?.(issue.id);
      }
    });
  }

  /** Whether a person unlinked this resource from this ticket: discovery then leaves it unlinked. */
  wasUnlinked(issueId: string, resourceId: string): boolean {
    return this.db.prepare(`SELECT 1 AS hit FROM events WHERE kind = ? AND issue_id = ? AND json_extract(payload, '$.resourceId') = ? LIMIT 1`)
      .get(EXTERNAL_UNLINKED_EVENT, issueId, resourceId) !== undefined;
  }

  /** Two bounded local queries for the entire list; never read provider context per row. */
  summaries(): Record<string, ExternalRowSummary> {
    const result: Record<string, ExternalRowSummary> = {};
    const counts = this.db.prepare(`SELECT l.issue_id,r.kind,COUNT(*) AS n FROM external_links l
      JOIN external_resources r ON r.id=l.resource_id GROUP BY l.issue_id,r.kind`).all() as Array<{issue_id:string;kind:string;n:number}>;
    for(const row of counts) {
      const summary=result[row.issue_id] ??= {issues:{count:0,items:[]},pullRequests:{count:0,items:[]}};
      summary[row.kind === "issue" ? "issues" : "pullRequests"].count=row.n;
    }
    const rows = this.db.prepare(`SELECT * FROM (
      SELECT l.issue_id,r.id,r.provider_id,r.host,r.container_id,r.kind,r.display_key,r.url,
        CASE WHEN p.fetched_at IS NOT NULL AND (r.fetched_at IS NULL OR p.fetched_at>=r.fetched_at) THEN p.title ELSE r.title END AS title,
        CASE WHEN p.fetched_at IS NOT NULL AND (r.fetched_at IS NULL OR p.fetched_at>=r.fetched_at) THEN p.status_json ELSE r.status_json END AS status_json,
        ROW_NUMBER() OVER (PARTITION BY l.issue_id,r.kind ORDER BY r.provider_id,r.host,r.container_id,l.position,l.created_at,l.rowid,l.id) AS ordinal
      FROM external_links l JOIN external_resources r ON r.id=l.resource_id
      LEFT JOIN external_private_cache p ON p.resource_id=r.id
    ) WHERE ordinal<=5`).all() as Array<{issue_id:string;id:string;provider_id:string;host:string;container_id:string;kind:string;display_key:string;url:string;title:string|null;status_json:string|null}>;
    for(const row of rows) result[row.issue_id]![row.kind === "issue" ? "issues" : "pullRequests"].items.push({
      id:row.id,providerId:row.provider_id,host:row.host,containerId:row.container_id,key:row.display_key,url:row.url,title:row.title,
      status:readStatus(row.status_json),
    });
    return result;
  }

  /**
   * Every linked pull request per issue, from the saved copy this machine reads (its own, or a
   * newer shared one). One query for the whole workspace, newest link last; `issueIds` keeps
   * it to those tickets (a parent's subtree, `subtree-pull-requests.ts`), still one query.
   */
  pullRequests(issueIds?: readonly string[]): Map<string, LinkedPullRequest[]> {
    const rows = this.db.prepare(`SELECT l.issue_id,l.created_at AS linked_at,r.id,r.provider_id,r.display_key,r.url,
        CASE WHEN p.fetched_at IS NOT NULL AND (r.fetched_at IS NULL OR p.fetched_at>=r.fetched_at) THEN p.title ELSE r.title END AS title,
        CASE WHEN p.fetched_at IS NOT NULL AND (r.fetched_at IS NULL OR p.fetched_at>=r.fetched_at) THEN p.status_json ELSE r.status_json END AS status_json,
        CASE WHEN p.fetched_at IS NOT NULL AND (r.fetched_at IS NULL OR p.fetched_at>=r.fetched_at) THEN p.fetched_at ELSE r.fetched_at END AS fetched_at
      FROM external_links l JOIN external_resources r ON r.id=l.resource_id LEFT JOIN external_private_cache p ON p.resource_id=r.id
      WHERE r.kind='pull_request' AND (? IS NULL OR l.issue_id IN (SELECT value FROM json_each(?)))
      ORDER BY l.issue_id,l.position,l.created_at,l.rowid`).all(...Array(2).fill(issueIds === undefined ? null : JSON.stringify(issueIds))) as Array<{issue_id:string;linked_at:string;id:string;provider_id:string;display_key:string;url:string;title:string|null;status_json:string|null;fetched_at:string|null}>;
    const result = new Map<string, LinkedPullRequest[]>();
    for (const row of rows) {
      const number = Number(/#([1-9][0-9]*)$/.exec(row.display_key)?.[1]);
      const list = result.get(row.issue_id) ?? [];
      list.push({ resourceId: row.id, providerId: row.provider_id, key: row.display_key, url: row.url,
        number: Number.isSafeInteger(number) ? number : null, state: readStatus(row.status_json)?.id ?? null, title: row.title,
        checks: readExtras(row.status_json).pullRequest?.checks ?? null, fetchedAt: row.fetched_at, linkedAt: row.linked_at });
      result.set(row.issue_id, list);
    }
    return result;
  }

  list(ref: string): ExternalLink[] {
    const issue = this.store.getIssue(ref);
    const rows = this.db.prepare("SELECT * FROM external_links WHERE issue_id = ? ORDER BY position, created_at, rowid, id").all(issue.id) as unknown as LinkRow[];
    const present = new Set(rows.map(l => l.resource_id));
    return rows.map(row => ({ id: row.id, issueId: row.issue_id, resource: this.resource(row.resource_id), parentResourceId: row.parent_resource_id,
      parentMissing: row.parent_resource_id !== null && !present.has(row.parent_resource_id), position: row.position,
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  associations(resourceId: string) {
    return (this.db.prepare("SELECT issue_id FROM external_links WHERE resource_id = ? ORDER BY created_at, issue_id").all(resourceId) as Array<{ issue_id: string }>)
      .map(row => this.store.getIssue(row.issue_id));
  }

  setStack(ref: string, resourceId: string, input: { parentResourceId: string | null; position: number }, actor: string): ExternalLink {
    if (!actor.trim()) throw new StapleError("validation", "PR stack choices need an actor");
    if (!Number.isSafeInteger(input.position) || input.position < 0) throw new StapleError("validation", "PR order must be a non-negative integer");
    return this.store.journaled(() => {
      const issue = this.store.getIssue(ref);
      const links = this.list(issue.id);
      const link = links.find(l => l.resource.id === resourceId);
      if (!link) throw new StapleError("not_found", "Link this pull request to the ticket first");
      if (link.resource.ref.kind !== "pull_request") throw new StapleError("validation", "Only pull requests have a stack parent and order");
      if (input.parentResourceId !== null) {
        const parent = this.resource(input.parentResourceId);
        const a = parent.ref, b = link.resource.ref;
        if (a.kind !== "pull_request" || a.providerId !== b.providerId || a.host !== b.host || a.scopeId !== b.scopeId || a.containerId !== b.containerId) {
          throw new StapleError("validation", "PR stack parents must belong to the same provider and repository");
        }
        let cursor: string | null = input.parentResourceId;
        const visited = new Set([resourceId]);
        while (cursor !== null) {
          if (visited.has(cursor)) throw new StapleError("cycle", "This PR parent would create a cycle");
          visited.add(cursor);
          cursor = links.find(l => l.resource.id === cursor)?.parentResourceId ?? null;
        }
      }
      this.db.prepare("UPDATE external_links SET parent_resource_id = ?, position = ?, updated_at = ? WHERE id = ?")
        .run(input.parentResourceId, input.position, nowIso(), link.id);
      this.recordStack(issue.id, actor);
      return this.list(issue.id).find(l => l.id === link.id)!;
    });
  }
}

/** Explicit wire allowlists. Private caches and machine connection records are never read here. */
export function resourcePayload(row: ResourceRow): Record<string, unknown> {
  return { providerId: row.provider_id, host: row.host, scopeId: row.scope_id, containerId: row.container_id,
    remoteId: row.remote_id, kind: row.kind, key: row.display_key, url: row.url, context: { shared: row.context_shared === 1,
    title: row.context_shared ? row.title : null, body: row.context_shared ? row.body : null,
    status: row.context_shared ? readStatus(row.status_json) : null,
    fetchedAt: row.context_shared ? row.fetched_at : null }, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function linkPayload(row: LinkRow): Record<string, unknown> {
  return { issueId: row.issue_id, resourceId: row.resource_id, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** A ticket's explicit stack is one conflict unit, preventing concurrent edits from forming cycles. */
export function stackPayload(db: import("node:sqlite").DatabaseSync, issueId: string) {
  return (db.prepare(`SELECT l.resource_id,l.parent_resource_id,l.position FROM external_links l
    JOIN external_resources r ON r.id=l.resource_id WHERE l.issue_id=? AND r.kind='pull_request' AND (l.parent_resource_id IS NOT NULL OR l.position<>0) ORDER BY l.resource_id`).all(issueId) as Array<{ resource_id: string; parent_resource_id: string | null; position: number }>).map(r => ({ resourceId: r.resource_id, parentResourceId: r.parent_resource_id, position: r.position }));
}
