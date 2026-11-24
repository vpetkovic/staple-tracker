import { createHash } from "node:crypto";
import type { WorkspaceStore } from "../store.js";
import { StapleError, type Issue } from "../types.js";
import type { ExternalItem, ResolvedExternalItem } from "./contracts.js";
import { externalResourceId, type ExternalLink } from "./link-store.js";
import { externalItemKey } from "./provider.js";

export interface MigrationCandidate {
  issue: Issue;
  reasons: Array<"scoped-origin" | "source-url" | "already-linked">;
}
export interface ExternalMatchPreview {
  associations: Issue[];
  candidates: MigrationCandidate[];
  truncated: boolean;
}
export interface CreateExternalWorkInput {
  requestKey: string;
  actor: string;
  additionalWork?: boolean;
  title?: string;
}
export interface CreatedExternalWork {
  issue: Issue;
  link: ExternalLink | null;
  replayed: boolean;
}

/** Shared local workflow. Provider adapters never create, merge or update execution work. */
export class ExternalWork {
  constructor(private readonly store: WorkspaceStore) {}

  preview(item: ResolvedExternalItem): ExternalMatchPreview {
    const identity = externalItemKey(item.ref);
    const resourceId = externalResourceId(item.ref);
    const url = canonicalUrl(item.url);
    if (new URL(url).host !== new URL(`https://${item.ref.host}`).host) throw new StapleError("validation", "Source URL is outside its provider host");
    const associations = this.store.externalLinks().associations(resourceId);
    const candidates = new Map<string, MigrationCandidate>(associations.map(issue => [issue.id,{issue,reasons:["already-linked"]}]));
    const rows = this.store.db.prepare(`SELECT id, 'scoped-origin' AS reason, NULL AS body FROM issues
        WHERE (origin_kind=? AND origin_id=?) OR (origin_kind='integration' AND substr(origin_id,1,65)=?)
      UNION ALL SELECT id, 'source-url', origin_id FROM issues WHERE origin_kind=? AND instr(lower(origin_id),lower(?))>0
      UNION ALL SELECT id, 'source-url', description FROM issues WHERE instr(lower(description),lower(?))>0
      UNION ALL SELECT r.issue_id, 'source-url', r.body FROM document_revisions r JOIN documents d
        ON d.issue_id=r.issue_id AND d.key=r.key AND d.current_revision=r.revision WHERE instr(lower(r.body),lower(?))>0
      UNION ALL SELECT issue_id, 'source-url', body FROM comments WHERE deleted_at IS NULL AND instr(lower(body),lower(?))>0
      LIMIT 501`).all(item.ref.providerId, identity, `${resourceId}/`, item.ref.providerId, url, url, url, url) as Array<{id:string;reason:"scoped-origin"|"source-url";body:string|null}>;
    for (const row of rows.slice(0,500)) {
      if (row.reason === "source-url" && !containsSourceUrl(row.body ?? "",url)) continue;
      const candidate = candidates.get(row.id) ?? {issue:this.store.getIssue(row.id),reasons:[]};
      if (!candidate.reasons.includes(row.reason)) candidate.reasons.push(row.reason);
      candidates.set(row.id,candidate);
    }
    return {associations,candidates:[...candidates.values()],truncated:rows.length>500};
  }

  adopt(ref: string, item: ResolvedExternalItem, confirmed: boolean, actor: string): ExternalLink {
    if (confirmed !== true) throw new StapleError("validation", "Confirm the selected local ticket before linking migrated work");
    return this.store.externalLinks().link(ref,item,actor);
  }

  create(item: ExternalItem, input: CreateExternalWorkInput): CreatedExternalWork {
    if (item.ref.kind !== "issue") throw new StapleError("validation", "Pull requests are references only; link them to an existing local ticket");
    if (!input.actor.trim() || !input.requestKey.trim() || input.requestKey.length>512) throw new StapleError("validation", "Creating linked work needs an actor and a request key of 1-512 characters");
    const resourceId = externalResourceId(item.ref);
    const request = createHash("sha256").update(input.requestKey).digest("hex");
    const idempotencyKey = `integration-create:${request}`;
    const originId = `${resourceId}/${request}`;
    return this.store.journaled(() => {
      const held = this.store.db.prepare("SELECT id FROM issues WHERE idempotency_key=?").get(idempotencyKey) as {id:string}|undefined;
      if (held) {
        const issue = this.store.getIssue(held.id);
        if (issue.originKind !== "integration" || issue.originId !== originId) throw new StapleError("conflict", "This request key already created work from another source");
        // A later unlink is authoritative. Retrying creation never undoes it or refreshes local fields.
        return { issue, link:this.store.externalLinks().list(issue.id).find(l=>l.resource.id===resourceId) ?? null, replayed:true };
      }
      const preview = this.preview(item);
      if ((preview.candidates.length>0 || preview.truncated) && input.additionalWork !== true) {
        throw new StapleError("duplicate", "Review existing links and migration matches before deliberately creating additional work", { preview });
      }
      const issue = this.store.createIssue({title:input.title ?? item.title,description:item.body,createdBy:input.actor,
        originKind:"integration",originId,idempotencyKey,allowDuplicate:input.additionalWork === true});
      const link = this.store.externalLinks().link(issue.id,item,input.actor);
      return {issue,link,replayed:false};
    });
  }
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol!=="https:" || url.username || url.password) throw new Error();
    url.hash="";
    return url.href;
  } catch { throw new StapleError("validation", "Use an HTTPS source URL without credentials"); }
}

function containsSourceUrl(body: string, source: string): boolean {
  // Complete URL tokens prevent issue #1 from matching #10. Fragments name context within the same issue.
  const tokens = body.match(/https:\/\/[^\s<>"'()[\]]+/gi) ?? [];
  return tokens.some(token => {
    try { return canonicalUrl(token.replace(/[.,;]+$/,"")) === source; }
    catch { return false; }
  });
}
