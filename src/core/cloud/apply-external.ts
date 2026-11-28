import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { externalLinkId, externalResourceId, resourcePayload, type ResourceRow } from "../integrations/link-store.js";
import { EXTERNAL_STATUS_CATEGORIES } from "../integrations/contracts.js";
import { StapleError } from "../types.js";
import { ReferentMissing, type ApplyInput } from "./apply.js";

const text = z.string().min(1).max(512);
const timestamp = z.string().datetime({ offset: true });
const resourceSchema = z.object({
  providerId: text, host: text, scopeId: text, containerId: text, remoteId: text,
  kind: z.enum(["issue", "pull_request"]), key: text, url: z.string().max(8192).url(),
  context: z.object({ shared: z.boolean(), title: z.string().max(8192).nullable(), body: z.string().max(256 * 1024).nullable(),
  // A category this build does not know is dropped, not refused, so a newer peer cannot stall the apply.
  status: z.object({ id: z.string().max(512), name: z.string().max(512), category: z.enum(EXTERNAL_STATUS_CATEGORIES).optional().catch(undefined) }).nullable(), fetchedAt: timestamp.nullable() }),
  createdAt: timestamp, updatedAt: timestamp,
});
const linkSchema = z.object({ issueId: text, resourceId: text,
  createdBy: text, createdAt: timestamp, updatedAt: timestamp });

/** Applies only declared shared fields, never the private cache or a machine connection. */
export function applyExternal(db: DatabaseSync, input: ApplyInput): boolean {
  if (input.entity === "externalStack") {
    if (!db.prepare("SELECT 1 FROM issues WHERE id=?").get(input.entityId)) throw new ReferentMissing(`issue ${input.entityId}`);
    if (!("entries" in input.payload)) return false; // A withheld conflict field.
    const entries = z.array(z.object({ resourceId: text, parentResourceId: text.nullable(), position: z.number().int().nonnegative().safe() })).max(10000).parse(input.payload.entries);
    const parents = new Map(entries.map(e => [e.resourceId, e.parentResourceId]));
    if (parents.size !== entries.length) throw new StapleError("validation", "Duplicate PR stack member");
    for (const entry of entries) {
      const seen = new Set<string>([entry.resourceId]);
      let cursor = entry.parentResourceId;
      while (cursor !== null) {
        if (seen.has(cursor)) throw new StapleError("cycle", "PR stack choices would form a cycle");
        seen.add(cursor); cursor = parents.get(cursor) ?? null;
      }
      const resource = db.prepare("SELECT * FROM external_resources WHERE id=?").get(entry.resourceId) as ResourceRow | undefined;
      if (!resource) throw new ReferentMissing(`externalResource ${entry.resourceId}`);
      if (resource.kind !== "pull_request") throw new StapleError("validation", "Only PRs have stack choices");
      if (entry.parentResourceId !== null) {
        const parent = db.prepare("SELECT * FROM external_resources WHERE id=?").get(entry.parentResourceId) as ResourceRow | undefined;
        if (!parent) throw new ReferentMissing(`externalResource ${entry.parentResourceId}`);
        if (parent.kind !== "pull_request" || ["provider_id", "host", "scope_id", "container_id"].some(k => parent[k as keyof ResourceRow] !== resource[k as keyof ResourceRow]))
          throw new StapleError("validation", "Invalid PR stack parent");
      }
    }
    db.prepare("UPDATE external_links SET parent_resource_id=NULL,position=0 WHERE issue_id=?").run(input.entityId);
    for (const e of entries) db.prepare("UPDATE external_links SET parent_resource_id=?,position=?,updated_at=? WHERE issue_id=? AND resource_id=?")
      .run(e.parentResourceId,e.position,input.at,input.entityId,e.resourceId);
    return true;
  }
  if (input.entity === "externalResource") {
    if (input.verb === "delete") throw new StapleError("validation", "External identities are permanent; unlink their associations instead");
    const prior = db.prepare("SELECT * FROM external_resources WHERE id=?").get(input.entityId) as ResourceRow | undefined;
    if (!prior && input.verb !== "create") throw new ReferentMissing(`externalResource ${input.entityId}`);
    const p = resourceSchema.parse({ ...(prior ? resourcePayload(prior) : {}), ...input.payload });
    const ref = { providerId: p.providerId, host: p.host, scopeId: p.scopeId, containerId: p.containerId, id: p.remoteId, kind: p.kind };
    const url = new URL(p.url);
    if (externalResourceId(ref) !== input.entityId || url.protocol !== "https:" || url.host !== p.host || url.username || url.password
      || [...url.searchParams.keys()].some(k => /^(?:access_token|token|authorization|password|client_secret|api_key)$/i.test(k))) {
      throw new StapleError("validation", "External resource identity or URL is invalid");
    }
    if (p.context.shared && (p.context.title === null || p.context.fetchedAt === null)) throw new StapleError("validation", "Shared context needs a title and read timestamp");
    db.prepare(`INSERT INTO external_resources
      (id,provider_id,host,scope_id,container_id,remote_id,kind,display_key,url,context_shared,title,body,status_json,fetched_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_key=excluded.display_key,url=excluded.url,
      context_shared=excluded.context_shared,title=excluded.title,body=excluded.body,status_json=excluded.status_json,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at`)
      .run(input.entityId,p.providerId,p.host,p.scopeId,p.containerId,p.remoteId,p.kind,p.key,p.url,p.context.shared ? 1 : 0,
        p.context.shared ? p.context.title : null,p.context.shared ? p.context.body : null,p.context.shared && p.context.status ? JSON.stringify(p.context.status) : null,
        p.context.shared ? p.context.fetchedAt : null,p.createdAt,p.updatedAt);
    return true;
  }
  if (input.verb === "delete") {
    db.prepare(`INSERT INTO sync_tombstones (entity,entity_id,deleted_at,device_id,op_id) VALUES (?,?,?,?,?)
      ON CONFLICT(entity,entity_id) DO NOTHING`).run(input.entity,input.entityId,input.at,input.deviceId,input.opId);
    db.prepare("DELETE FROM external_links WHERE id=?").run(input.entityId);
    return true;
  }
  if (input.verb !== "create") throw new StapleError("validation", "Associations are created or deleted; stack choices are separate");
  const p = linkSchema.parse(input.payload);
  if (externalLinkId(p.issueId,p.resourceId) !== input.entityId) throw new StapleError("validation", "External association identity is invalid");
  if (!db.prepare("SELECT 1 FROM issues WHERE id=?").get(p.issueId)) throw new ReferentMissing(`issue ${p.issueId}`);
  const resource = db.prepare("SELECT * FROM external_resources WHERE id=?").get(p.resourceId) as ResourceRow | undefined;
  if (!resource) throw new ReferentMissing(`externalResource ${p.resourceId}`);
  db.prepare(`INSERT INTO external_links (id,issue_id,resource_id,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .run(input.entityId,p.issueId,p.resourceId,p.createdBy,p.createdAt,p.updatedAt);
  return true;
}
