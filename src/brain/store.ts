/**
 * Brain records, stored where the existing sync already carries them.
 *
 * ## Why a record is a workspace setting
 *
 * Every record is one `meta` row, `setting:brain.<id>`, holding the setting envelope
 * `{ v: 1, value: <record> }`, and every change is journaled as the `setting` entity with
 * `entityId` `brain.<id>`. That entity has been in the sync vocabulary since protocol 1:
 *
 *   - the Worker validates the envelope's shape and stores the payload verbatim
 *     (`worker/src/envelope.ts`), and its fold is per entity, so it never needs to know
 *     what a brain record is;
 *   - a receiver applies an unknown setting key by writing the same meta row
 *     (`cloud/apply.ts`, `applySetting`), which is what this store reads;
 *   - seeding, the join comparison, conflict records and rewind already enumerate
 *     `setting:*` rows generically (`cloud/seed.ts`, `cloud/conflicts.ts`, `cloud/rewind.ts`).
 *
 * So a brain workspace synchronizes with no new entity, no protocol bump, no migration and
 * no Worker deploy. `repository.prefix` rides a setting key for the same reason
 * (`cloud/repository-prefix.ts`). The cost is that a record replicates as ONE value: two
 * devices editing the same record concurrently produce a `setting` conflict on `value`,
 * resolved whole, not merged field by field.
 *
 * The search index is never stored here. `recall.ts` derives it from these rows.
 */
import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceStore } from "../core/store.js";
import { WORKSPACE_SETTING_META_PREFIX } from "../core/settings-registry.js";
import { StapleError, nowIso } from "../core/types.js";
import { GLOBAL_SCOPE, isBrainKind, type BrainKind, type BrainRecord } from "./types.js";
import { isExpired, readConfig, syncsScope, type BrainConfig } from "./config.js";

export const BRAIN_SETTING_PREFIX = "brain.";

export function isBrainSettingKey(key: string): boolean {
  return key.startsWith(BRAIN_SETTING_PREFIX);
}

const META_PREFIX = `${WORKSPACE_SETTING_META_PREFIX}${BRAIN_SETTING_PREFIX}`;

/** What the wire carries: the record without its id, which is the entity id. */
type StoredRecord = Omit<BrainRecord, "id">;

export interface RememberInput {
  kind: BrainKind;
  body: string;
  name?: string | null;
  description?: string | null;
  why?: string | null;
  scope?: string;
  tags?: string[];
  source?: string | null;
  provisional?: boolean;
  /** Stable id for an idempotent write (imports); a fresh UUID otherwise. */
  id?: string;
  /** Replaces the record this one supersedes: that record gets `supersededBy` set. */
  supersedes?: string | null;
  createdAt?: string;
  verifiedAt?: string | null;
}

/** A deterministic UUID-shaped id from a stable source string (an import path). */
export function stableId(source: string): string {
  const h = createHash("sha256").update(source).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function decode(id: string, text: string): BrainRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const value = (parsed as { value?: unknown } | null)?.value as Partial<StoredRecord> | undefined;
  if (!value || typeof value !== "object" || !isBrainKind(value.kind) || typeof value.body !== "string") return null;
  return {
    id,
    kind: value.kind,
    name: value.name ?? null,
    description: value.description ?? null,
    body: value.body,
    why: value.why ?? null,
    scope: typeof value.scope === "string" ? value.scope : GLOBAL_SCOPE,
    tags: Array.isArray(value.tags) ? value.tags.filter((t): t is string => typeof t === "string") : [],
    source: value.source ?? null,
    createdAt: value.createdAt ?? "",
    updatedAt: value.updatedAt ?? value.createdAt ?? "",
    verifiedAt: value.verifiedAt ?? null,
    supersededBy: value.supersededBy ?? null,
    provisional: value.provisional === true,
  };
}

export class BrainStore {
  constructor(readonly workspace: WorkspaceStore) {}

  get db() {
    return this.workspace.db;
  }

  /** Every record, superseded ones included, oldest first. */
  all(): BrainRecord[] {
    const rows = this.db
      .prepare("SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key")
      .all(`${META_PREFIX}%`) as Array<{ key: string; value: string }>;
    const out: BrainRecord[] = [];
    for (const row of rows) {
      const record = decode(row.key.slice(META_PREFIX.length), row.value);
      if (record) out.push(record);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** Records an agent should still read: not superseded, and not a provisional one past its expiry. */
  live(): BrainRecord[] {
    const config = this.config();
    const now = Date.now();
    return this.all().filter((r) => r.supersededBy === null && !isExpired(config, r, now));
  }

  /** The synced policy (`config.ts`). */
  config(): BrainConfig {
    return readConfig(this.workspace);
  }

  /** Whether a change to a record in this scope is journaled for the sync service. */
  private leaves(scope: string): boolean {
    return syncsScope(this.config(), scope);
  }

  get(idOrPrefix: string): BrainRecord {
    const exact = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`${META_PREFIX}${idOrPrefix}`) as
      | { value: string }
      | undefined;
    if (exact) {
      const record = decode(idOrPrefix, exact.value);
      if (record) return record;
    }
    const matches = this.all().filter((r) => r.id.startsWith(idOrPrefix) || r.name === idOrPrefix);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new StapleError("validation", `"${idOrPrefix}" matches ${matches.length} brain records; use more of the id.`);
    throw new StapleError("not_found", `No brain record "${idOrPrefix}".`);
  }

  remember(input: RememberInput): BrainRecord {
    if (!isBrainKind(input.kind)) throw new StapleError("validation", `kind must be one of user, feedback, project, reference.`);
    if (!input.body.trim()) throw new StapleError("validation", "A brain record needs a body.");
    return this.workspace.journaled(() => {
      const now = nowIso();
      const id = input.id ?? randomUUID();
      const existing = this.tryGet(id);
      const record: BrainRecord = {
        id,
        kind: input.kind,
        name: input.name ?? existing?.name ?? null,
        description: input.description ?? existing?.description ?? null,
        body: input.body,
        why: input.why ?? existing?.why ?? null,
        scope: input.scope ?? existing?.scope ?? GLOBAL_SCOPE,
        tags: input.tags ?? existing?.tags ?? [],
        source: input.source ?? existing?.source ?? null,
        createdAt: existing?.createdAt ?? input.createdAt ?? now,
        updatedAt: now,
        verifiedAt: input.verifiedAt !== undefined ? input.verifiedAt : (existing?.verifiedAt ?? now),
        supersededBy: existing?.supersededBy ?? null,
        provisional: input.provisional ?? existing?.provisional ?? false,
      };
      if (existing && sameContent(existing, record)) return existing;
      this.write(record, existing === null);
      if (input.supersedes) {
        const old = this.get(input.supersedes);
        if (old.id !== id) this.write({ ...old, supersededBy: id, updatedAt: now }, false);
      }
      return record;
    });
  }

  /** Mark a record re-confirmed as still true. */
  verify(idOrPrefix: string): BrainRecord {
    return this.workspace.journaled(() => {
      const record = this.get(idOrPrefix);
      const now = nowIso();
      const next = { ...record, verifiedAt: now, updatedAt: now, provisional: false };
      this.write(next, false);
      return next;
    });
  }

  /** Delete a record everywhere it synchronizes: a journaled `setting` delete, tombstoned. */
  forget(idOrPrefix: string, actor?: string | null): BrainRecord {
    return this.workspace.journaled(() => {
      const record = this.get(idOrPrefix);
      this.db.prepare("DELETE FROM meta WHERE key = ?").run(`${META_PREFIX}${record.id}`);
      this.bumpRevision();
      if (this.leaves(record.scope)) {
        this.workspace.journal.record({
          entity: "setting",
          entityId: `${BRAIN_SETTING_PREFIX}${record.id}`,
          verb: "delete",
          payload: {},
          actor: actor ?? null,
        });
      }
      return record;
    });
  }

  private tryGet(id: string): BrainRecord | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`${META_PREFIX}${id}`) as { value: string } | undefined;
    return row ? decode(id, row.value) : null;
  }

  private write(record: BrainRecord, created: boolean): void {
    const { id, ...value } = record;
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`${META_PREFIX}${id}`, JSON.stringify({ v: 1, value }));
    this.bumpRevision();
    // A scope the policy keeps local is written here and never journaled (`config.ts`).
    if (!this.leaves(record.scope)) return;
    const entityId = `${BRAIN_SETTING_PREFIX}${id}`;
    // After a forget, only a `create` brings the entity back, here and in the service's fold.
    const verb = created || this.workspace.journal.isTombstoned("setting", entityId) ? "create" : "update";
    this.workspace.journal.record({ entity: "setting", entityId, verb, payload: { value }, actor: record.source });
  }

  private bumpRevision(): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('settings_revision', '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT)`,
      )
      .run();
  }
}

function sameContent(a: BrainRecord, b: BrainRecord): boolean {
  const strip = (r: BrainRecord) => JSON.stringify({ ...r, updatedAt: "", verifiedAt: "" });
  return strip(a) === strip(b);
}
