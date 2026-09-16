/**
 * The single-pass fold as the Worker ran it before the checkpoint, kept VERBATIM as a test
 * oracle.
 *
 * Generated from `foldLog` in `worker/src/fold.ts` at b4a99fa, with every helper it calls
 * — and the revision placement it imports from `src/core/cloud/revision-placement.ts` —
 * copied beside it rather than imported: the checkpoint in `src/fold-store.ts` has to
 * reproduce this entity by entity, and an oracle that shared the production helpers would
 * agree with any mistake made in them. The only edits are the imports and `export`s, the
 * two constants it read from `limits.ts` (which no longer exist there), and its refusal
 * past the cap, which throws a plain Error.
 *
 * `worker/test/fold-equivalence.test.ts` folds random logs through this and through the
 * checkpoint and compares every byte.
 */
import type { FoldedEntity } from "../src/fold.js";

export interface FoldResult {
  entities: FoldedEntity[];
  opCount: number;
  schemaVersion: number;
}

const SNAPSHOT_FOLD_PAGE = 500;
const MAX_SNAPSHOT_FOLD_OPS = 20_000;

function entityKey(entity: string, entityId: string): string {
  return `${entity} ${entityId}`;
}

export async function oracleFoldLog(
  env: { DB: D1Database },
  repoId: string,
  epoch: number,
  cutoff: number,
): Promise<FoldResult> {
  const entities = new Map<string, FoldedEntity>();
  let after = 0;
  let opCount = 0;
  let schemaVersion = 0;

  for (;;) {
    const page = await env.DB.prepare(
      `SELECT seq, op_id, entity, entity_id, verb, payload, actor, created_at, server_ts, schema_version
         FROM ops
        WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 AND seq <= ?4
        ORDER BY seq
        LIMIT ?5`,
    )
      .bind(repoId, epoch, after, cutoff, SNAPSHOT_FOLD_PAGE)
      .all<{
        seq: number;
        op_id: string;
        entity: string;
        entity_id: string;
        verb: string;
        payload: string;
        actor: string | null;
        created_at: string;
        server_ts: number;
        schema_version: number;
      }>();

    if (page.results.length === 0) break;

    opCount += page.results.length;
    if (opCount > MAX_SNAPSHOT_FOLD_OPS) {
      // The same refusal `GET /snapshot` makes, for the same reason: a truncated
      // fold is a backup that silently omits entities, and restoring one would
      // delete real data while reporting success.
      throw new Error("operation log is too large to fold in one pass");
    }

    for (const original of page.results) {
      if (original.schema_version > schemaVersion) schemaVersion = original.schema_version;
      // Two revisions written as one number: the later in the log takes the next (`settleRevision`).
      const row = original.entity === "documentRevision" && original.verb === "create" ? settleRevision(entities, original) : original;
      // The same revision, held under the number it was moved to: nothing new.
      if (row === null) continue;

      const key = entityKey(row.entity, row.entity_id);
      let entry = entities.get(key);
      if (!entry) {
        entry = {
          entity: row.entity,
          entityId: row.entity_id,
          version: 0,
          deletedAt: null,
          lastSeq: row.seq,
          superseded: false,
          state: {},
          fieldWrites: {},
          createdSeq: null,
          createdAt: null,
          createdBy: null,
        };
        entities.set(key, entry);
      }

      entry.version += 1;
      entry.lastSeq = row.seq;

      if (row.verb === "delete") {
        entry.deletedAt = row.server_ts;
        continue;
      }
      if (row.verb === "create") {
        if (entry.deletedAt !== null) {
          // The entity begins again (see the module comment). Nothing of the deleted one
          // survives into it: not its fields, not their provenance, not its verb.
          entry.deletedAt = null;
          entry.state = {};
          entry.fieldWrites = {};
          entry.superseded = false;
          forgetPlace(entities.get(entityKey(row.entity, VOCABULARY_ORDER_ID)), row.entity, row.entity_id);
          // Nor is a status or kind created again the built-in it may have been: every device
          // that read the delete in the log holds the one added back, and a create from a build
          // before this one does not say so itself (`applyVocabulary`, `src/core/cloud/apply.ts`).
          if (row.entity === "status" || row.entity === "kind") entry.state.isBuiltin = false;
        }
        entry.createdSeq = row.seq;
        /**
         * Not a restore's own actor and instant. A restore stages every entity as a
         * `create`; when its backup kept the original creator and time (`forBackup`) it
         * stages under those, and otherwise — a backup from before this build, or a
         * restore by the Worker before it — under `restore:<id>` at the moment it ran.
         * Those say who restored and when, not who wrote the thing and when, and a device
         * dating an old comment or attributing an old revision by them rewrote the truth.
         */
        const restored = typeof row.actor === "string" && row.actor.startsWith("restore:");
        entry.createdAt = restored ? null : row.created_at;
        entry.createdBy = restored ? null : row.actor;
      }
      if (entry.deletedAt !== null) continue;

      const payload = JSON.parse(row.payload) as unknown;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        // No keys, so nothing to be authoritative about. `envelope.ts` refuses every
        // payload that is not a JSON object at ingest, arrays included (STA-262), and a
        // restore stages only folded state, which is always an object. So this is a
        // floor under a log written before that refusal existed, or edited by hand,
        // rather than a case the wire can carry. The floor is "contributes no state".
        continue;
      }

      // EVERY verb merges the keys it carried and is silent about the rest. A `replace`
      // still supersedes the collection it names, because that collection is the value
      // of a single key and the value is assigned whole — merging two plans element by
      // element would invent an order neither human asked for. What it no longer does is
      // discard `startsOn` because it happened to be talking about `members`.
      /**
       * One field, whichever spelling wrote it. Clients journaled some fields by field name
       * (`updatedAt`) and some by column (`updated_at`), and keeping both left one entity's
       * state holding a stale and a fresh value of the same field, applied in key order by a
       * hydrating device — so the stale one could win. A key's other spelling is dropped
       * when it is written, state and provenance alike, so the state holds the latest.
       */
      const carried = columnSpellingWins(payload as Record<string, unknown>);
      for (const key of Object.keys(carried)) {
        const other = otherSpelling(key);
        if (other !== key) {
          delete entry.state[other];
          delete entry.fieldWrites[other];
        }
      }
      const statusBefore = entry.state.status;
      Object.assign(entry.state, carried);
      // So the merge is the same for every verb and only the RECORD of the verb differs.
      entry.superseded = row.verb === "replace";

      /**
       * The same keys again, as provenance — for every verb EXCEPT `create` (STA-263).
       *
       * The exclusion is the fix, not an optimization. A create carries the entity's
       * whole field inventory including the defaults nobody chose, so recording it
       * would make a later edit contest a `medium` that was never a decision. It is
       * also precisely what `Journal.flush` does for a locally authored mutation, so
       * a hydrated device ends up holding the same rows a device that was present for
       * this log holds — and no others.
       *
       * `entry.version` has already been incremented for this row, so `- 1` is the
       * version the write moved off.
       */
      if (row.verb !== "create") {
        const write = { baseVersion: entry.version - 1, opId: row.op_id, at: row.created_at, seq: row.seq };
        for (const field of Object.keys(carried)) entry.fieldWrites[field] = write;
        if (entry.entity === "issue" && reopensOrigin(statusBefore, carried.status)) entry.fieldWrites.reopens = write;
      }
    }

    after = page.results[page.results.length - 1]!.seq;
    if (page.results.length < SNAPSHOT_FOLD_PAGE) break;
  }

  const ordered = [...entities.values()].sort((a, b) =>
    entityKey(a.entity, a.entityId) < entityKey(b.entity, b.entityId) ? -1 : 1,
  );

  return { entities: ordered, opCount, schemaVersion };
}

function columnSpellingWins(payload: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const key of Object.keys(payload)) {
    if (!key.includes("_")) continue;
    const camel = otherSpelling(key);
    if (camel === key || !(camel in payload)) continue;
    out ??= { ...payload };
    delete out[camel];
  }
  return out ?? payload;
}

const ORIGIN_RELEASING_STATUSES: readonly string[] = ["done", "cancelled"];

function reopensOrigin(before: unknown, after: unknown): boolean {
  return (
    typeof before === "string" &&
    typeof after === "string" &&
    ORIGIN_RELEASING_STATUSES.includes(before) &&
    !ORIGIN_RELEASING_STATUSES.includes(after)
  );
}

function settleRevision<T extends { entity_id: string; payload: string; seq: number }>(
  entities: Map<string, FoldedRevisionEntry>,
  row: T,
): T | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return row;
  }
  const settled = settleRevisionCreate(entities.values(), row.entity_id, payload);
  if (settled === null) return null;
  if (settled.entityId === row.entity_id && settled.payload === payload) return row;
  return { ...row, entity_id: settled.entityId, payload: JSON.stringify(settled.payload) };
}

const VOCABULARY_ORDER_ID = "@order";

function forgetPlace(order: { state: Record<string, unknown> } | undefined, entity: string, id: string): void {
  if (order === undefined || (entity !== "status" && entity !== "kind")) return;
  if (Array.isArray(order.state.order)) order.state.order = order.state.order.filter((listed) => listed !== id);
}

function otherSpelling(key: string): string {
  if (key.includes("_")) return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (/[A-Z]/.test(key)) return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return key;
}

// ---- src/core/cloud/revision-placement.ts at b4a99fa, verbatim but for `export`.


/** What identifies a revision's content. */
interface RevisionContent {
  readonly body?: unknown;
  readonly author?: unknown;
}

/**
 * The same revision: the same body, and the same author where both have one.
 *
 * Never its time. A build before this one stamped a revision it applied with the time of
 * the operation, which can be a millisecond off the time the revision carries; compared,
 * every revision such a device held read as a different one, and it gained a renumbered
 * copy of each.
 */
function sameRevision(held: RevisionContent, incoming: RevisionContent): boolean {
  if (held.body !== incoming.body) return false;
  if (typeof held.author === "string" && typeof incoming.author === "string" && held.author !== incoming.author) return false;
  return true;
}

/** The first number from `from` upward that `taken` does not hold. */
function firstFreeRevision(taken: ReadonlySet<number>, from: number): number {
  let slot = from;
  while (taken.has(slot)) slot += 1;
  return slot;
}

const RENUMBERED = /^(?:([\s\S]*) — )?renumbered from r(\d+) to r\d+: written at the same time as another r\2, which the repository's log holds first$/;

/**
 * A renumbered revision's change summary: its own, and what happened to its number — from
 * the number it was written as, whatever it was moved through on the way, so every device
 * says the same thing about it.
 */
function renumberedSummary(summary: unknown, from: number, to: number): string {
  const written = writtenAs(summary) ?? from;
  const own = writtenSummary(summary) ?? "";
  const kept = own.trim() !== "" ? `${own} — ` : "";
  return `${kept}renumbered from r${written} to r${to}: written at the same time as another r${written}, which the repository's log holds first`;
}

/** The summary a revision was written with, without what a renumbering added. */
function writtenSummary(summary: unknown): string | null {
  if (typeof summary !== "string") return null;
  const moved = RENUMBERED.exec(summary);
  if (!moved) return summary;
  return moved[1] ?? null;
}

/** The number a renumbered revision was written as, from its summary; null for one never moved. */
function writtenAs(summary: unknown): number | null {
  if (typeof summary !== "string") return null;
  const moved = RENUMBERED.exec(summary);
  return moved ? Number(moved[2]) : null;
}

/** A revision's summary at `slot`, when it claimed `claimed` (or, moved before, the number its summary says). */
function summaryAt(summary: unknown, claimed: number, slot: number): string | null {
  const written = writtenAs(summary) ?? claimed;
  return slot === written ? writtenSummary(summary) : renumberedSummary(summary, written, slot);
}

interface Placement {
  /** The number the revision holds. */
  readonly revision: number;
  /** True when the log already placed this revision: a re-send, or the same text sent twice. */
  readonly again: boolean;
  /** Its change summary there, the move said in it when it moved. */
  readonly changeSummary: string | null;
}

/**
 * One step of the log: a revision claiming `claimed`, against the revisions of its document
 * the log placed before it.
 *
 * It is already there when a revision with its content sits at or above the number it was
 * written as — a device sending again the revision it moved, under the number it moved it
 * to (`claims.ts`), or two devices sending the same text. Below that number it is not: a
 * document put back to an earlier text is a new revision of it. Otherwise it takes the
 * first free number from `claimed` upward.
 */
function placeRevision(
  held: Iterable<RevisionContent & { readonly revision: number }>,
  claimed: number,
  incoming: RevisionContent & { readonly changeSummary?: unknown },
): Placement {
  const floor = Math.min(claimed, writtenAs(incoming.changeSummary) ?? claimed);
  const taken = new Set<number>();
  let again: number | null = null;
  for (const row of held) {
    taken.add(row.revision);
    if (row.revision >= floor && sameRevision(row, incoming) && (again === null || row.revision < again)) again = row.revision;
  }
  if (again !== null) return { revision: again, again: true, changeSummary: null };
  const revision = firstFreeRevision(taken, claimed);
  return { revision, again: false, changeSummary: summaryAt(incoming.changeSummary, claimed, revision) };
}

/** An entity as a fold of the log holds it. */
interface FoldedRevisionEntry {
  readonly entity: string;
  readonly entityId: string;
  readonly deletedAt: number | null;
  readonly state: Record<string, unknown>;
}

/**
 * A revision's `create`, as a fold of the log takes it: under the number {@link placeRevision}
 * settles it to, the move said in its summary — or null when the log already holds it, and
 * the operation adds nothing. `entityId` is `<issue>/<key>/<revision>`.
 */
function settleRevisionCreate(
  entries: Iterable<FoldedRevisionEntry>,
  entityId: string,
  payload: Record<string, unknown>,
): { entityId: string; payload: Record<string, unknown> } | null {
  const slash = entityId.lastIndexOf("/");
  const document = entityId.slice(0, slash + 1);
  const claimed = Number(entityId.slice(slash + 1));
  if (!Number.isInteger(claimed)) return { entityId, payload };
  const held: Array<RevisionContent & { revision: number }> = [];
  for (const entry of entries) {
    if (entry.entity !== "documentRevision" || entry.deletedAt !== null || !entry.entityId.startsWith(document)) continue;
    const revision = Number(entry.entityId.slice(document.length));
    if (Number.isInteger(revision)) held.push({ revision, body: entry.state.body, author: entry.state.author });
  }
  const placed = placeRevision(held, claimed, payload);
  if (placed.again) return null;
  if (placed.revision === claimed && placed.changeSummary === (payload.changeSummary ?? null)) return { entityId, payload };
  return {
    entityId: `${document}${placed.revision}`,
    payload: { ...payload, revision: placed.revision, changeSummary: placed.changeSummary },
  };
}
