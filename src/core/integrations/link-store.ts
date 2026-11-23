import { createHash } from "node:crypto";
import type { WorkspaceStore } from "../store.js";
import { StapleError, nowIso } from "../types.js";
import type { ExternalItem, ExternalItemRef, ResolvedExternalItem } from "./contracts.js";
import { externalItemKey } from "./provider.js";

export interface ExternalResource extends ResolvedExternalItem {
  id: string;
  title: string | null;
  body: string | null;
  status: ExternalItem["status"];
  fetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

interface ResourceRow {
  id: string; provider_id: string; host: string; scope_id: string; container_id: string;
  remote_id: string; kind: ExternalItemRef["kind"]; display_key: string; url: string;
  title: string | null; body: string | null; status_json: string | null; fetched_at: string | null;
  created_at: string; updated_at: string;
}
interface LinkRow {
  id: string; issue_id: string; resource_id: string; parent_resource_id: string | null; position: number;
  created_by: string; created_at: string; updated_at: string;
}

export function externalResourceId(ref: ExternalItemRef): string { return hash(externalItemKey(ref)); }
export function externalLinkId(issueId: string, resourceId: string): string { return hash(JSON.stringify([issueId, resourceId])); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

function fromRow(row: ResourceRow): ExternalResource {
  return { id: row.id, ref: { providerId: row.provider_id, host: row.host, scopeId: row.scope_id, containerId: row.container_id, id: row.remote_id, kind: row.kind },
    key: row.display_key, url: row.url, title: row.title, body: row.body,
    status: row.status_json === null ? null : JSON.parse(row.status_json), fetchedAt: row.fetched_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Owns source context and association choices; never changes local execution fields. */
export class ExternalLinkStore {
  constructor(private readonly store: WorkspaceStore) {}
  private get db() { return this.store.db; }

  resource(id: string): ExternalResource {
    const row = this.db.prepare("SELECT * FROM external_resources WHERE id = ?").get(id) as ResourceRow | undefined;
    if (!row) throw new StapleError("not_found", "External resource was not found");
    return fromRow(row);
  }

  find(ref: ExternalItemRef): ExternalResource | null {
    const row = this.db.prepare("SELECT * FROM external_resources WHERE id = ?").get(externalResourceId(ref)) as ResourceRow | undefined;
    return row ? fromRow(row) : null;
  }

  /** URL-only resolution cannot erase cached context, and an older read cannot replace a newer read. */
  remember(input: ResolvedExternalItem | ExternalItem): ExternalResource {
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
    return this.store.journaled(() => {
      const prior = this.find(input.ref);
      if (prior?.fetchedAt && (!full || prior.fetchedAt > fetchedAt!.toISOString())) return prior;
      const timestamp = nowIso();
      this.db.prepare(`INSERT INTO external_resources
        (id, provider_id, host, scope_id, container_id, remote_id, kind, display_key, url, title, body, status_json, fetched_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET display_key=excluded.display_key, url=excluded.url, title=excluded.title,
          body=excluded.body, status_json=excluded.status_json, fetched_at=excluded.fetched_at, updated_at=excluded.updated_at`)
        .run(id, input.ref.providerId, host, input.ref.scopeId, input.ref.containerId, input.ref.id, input.ref.kind,
          input.key, url.href, full ? input.title : null, full ? input.body : null,
          full && input.status ? JSON.stringify({ id: input.status.id, name: input.status.name }) : null,
          fetchedAt?.toISOString() ?? null, prior?.createdAt ?? timestamp, timestamp);
      return this.resource(id);
    });
  }

  link(ref: string, input: ResolvedExternalItem | ExternalItem, actor: string): ExternalLink {
    if (!actor.trim()) throw new StapleError("validation", "An external link needs an actor");
    return this.store.journaled(() => {
      const issue = this.store.getIssue(ref);
      const resource = this.remember(input);
      const timestamp = nowIso();
      const id = externalLinkId(issue.id, resource.id);
      this.db.prepare(`INSERT INTO external_links (id, issue_id, resource_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(issue_id, resource_id) DO NOTHING`).run(id, issue.id, resource.id, actor, timestamp, timestamp);
      return this.list(issue.id).find(l => l.id === id)!;
    });
  }

  unlink(ref: string, resourceId: string, _actor: string): void {
    this.store.journaled(() => {
      const issue = this.store.getIssue(ref);
      this.db.prepare("DELETE FROM external_links WHERE issue_id = ? AND resource_id = ?").run(issue.id, resourceId);
    });
  }

  list(ref: string): ExternalLink[] {
    const issue = this.store.getIssue(ref);
    const rows = this.db.prepare("SELECT * FROM external_links WHERE issue_id = ? ORDER BY position, created_at, id").all(issue.id) as unknown as LinkRow[];
    const present = new Set(rows.map(l => l.resource_id));
    return rows.map(row => ({ id: row.id, issueId: row.issue_id, resource: this.resource(row.resource_id), parentResourceId: row.parent_resource_id,
      parentMissing: row.parent_resource_id !== null && !present.has(row.parent_resource_id), position: row.position,
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  associations(resourceId: string) {
    return (this.db.prepare("SELECT issue_id FROM external_links WHERE resource_id = ? ORDER BY created_at, issue_id").all(resourceId) as Array<{ issue_id: string }>)
      .map(row => this.store.getIssue(row.issue_id));
  }

  setStack(ref: string, resourceId: string, input: { parentResourceId: string | null; position: number }, _actor: string): ExternalLink {
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
      return this.list(issue.id).find(l => l.id === link.id)!;
    });
  }
}
