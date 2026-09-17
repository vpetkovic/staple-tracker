/**
 * Placing a document revision without reading every revision of its document.
 *
 * ## The rule, and what it cost read literally
 *
 * A `documentRevision` create settles against the revisions its document already holds
 * (`settleRevision` in `fold.ts`, `placeRevision` in `src/core/cloud/revision-placement.ts`):
 *
 *   - it is the SAME revision again when a live revision at or above its floor holds the same
 *     body (and the same author, where both name one), and then it adds nothing;
 *   - otherwise it takes the first number from the one it claimed upward that no live revision
 *     holds.
 *
 * Read literally, that needs every revision of the document, and the fold checkpoint loaded exactly
 * that for every step holding a create: a step of k creates on a document of R revisions parsed R
 * states and compared k x R times. On workerd one pull of a worklog saved 1,500 times cost 87 ms of
 * isolate time, and a step cannot get smaller than one operation, so past a few thousand revisions
 * no request could fold that repository any further.
 *
 * ## What the answer depends on
 *
 * Two small sets:
 *
 *   1. the live revisions at or above the floor holding the same body: found by the index on
 *      `(doc, body_key, rev)`, where equal bodies have equal keys ({@link bodyKey}) and a string
 *      key is only a sample, so each match is confirmed on the stored body before it counts;
 *   2. whether each number from the claim upward is held, up to the first that is not: read from
 *      the index on `(doc, rev)` as RUNS of consecutive held numbers, so a document numbered
 *      1..5,000 answers "1 to 5,000 held" in one row.
 *
 * Both are read from the checkpoint at the step's base mark and overlaid, here, with what the step
 * has already folded: the revisions it created, moved, deleted or revived, held in memory as the
 * fold holds them. A revision the step has touched is answered from memory, any other from D1, and
 * that is why the answer is the literal rule's to the byte (`worker/test/fold-equivalence.test.ts`
 * holds it to `foldLog`).
 *
 * ## When it does not know
 *
 * What is read ahead is bounded: a few runs from each document's lowest claim, a few same-body
 * revisions per create. A placement can reach past it (a claim far above the runs read, a walk
 * through a long stretch of numbers this step filled, more same-body revisions than were read), and
 * then {@link RevisionPlacer.place} answers what it needs rather than guessing. The step reads it,
 * a bounded number of times, or ends before that operation. The first operation of a step can
 * always be answered from D1, so every step folds at least one.
 *
 * NO WORKER IMPORTS, so the fake sync server can place revisions with this same code.
 */

import { sameRevision, summaryAt, writtenAs } from "../../src/core/cloud/revision-placement.js";

/** An operation as the placement reads it: `FoldOpRow` in `fold.ts`. */
export interface PlacementRow {
  seq: number;
  entity: string;
  entity_id: string;
  payload: string;
}

/** An entity as the placement reads it: `FoldedEntity` in `fold.ts`. */
export interface PlacementEntry {
  entity: string;
  entityId: string;
  deletedAt: number | null;
  state: Record<string, unknown>;
}

/** Where a revision sits: its document (its id up to and including the last `/`) and its number. */
export interface RevisionSlot {
  doc: string;
  rev: number;
}

/**
 * The slot the placement reads an entity at, or null for anything that is not a revision with an
 * integer number. The arithmetic of `settleRevisionCreate`: `Number` of the text after the last
 * `/`, so `05` and `5` are one number and an id with no `/` belongs to the document `""`.
 */
export function revisionSlot(entity: string, entityId: string): RevisionSlot | null {
  if (entity !== "documentRevision") return null;
  const slash = entityId.lastIndexOf("/");
  const rev = Number(entityId.slice(slash + 1));
  if (!Number.isInteger(rev)) return null;
  return { doc: entityId.slice(0, slash + 1), rev };
}

/** A body `sameRevision` can find `===` to another's: anything but an object. */
function comparable(body: unknown): boolean {
  return body === null || typeof body !== "object";
}

/** How much of a string body its key samples, from each end. */
const SAMPLED = 1024;

/**
 * A key two `===` bodies always share. Exact for everything but a string, whose key is its length
 * and a hash of its first and last {@link SAMPLED} code units: cheap however long the body, and
 * confirmed against the stored body whenever it matches ({@link RevisionPlacer}), so two bodies
 * that share a key and differ are never taken for one. Null for an object or array, which `===`
 * never finds equal to anything parsed from another payload.
 */
export function bodyKey(body: unknown): string | null {
  if (body === undefined) return "u";
  if (body === null) return "z";
  if (typeof body === "boolean") return `b:${body}`;
  if (typeof body === "number") return `n:${String(body)}`;
  if (typeof body !== "string") return null;
  // FNV-1a over UTF-16 code units.
  let hash = 0x811c9dc5;
  const mix = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) hash = Math.imul(hash ^ body.charCodeAt(index), 0x01000193);
  };
  if (body.length <= 2 * SAMPLED) mix(0, body.length);
  else {
    mix(0, SAMPLED);
    mix(body.length - SAMPLED, body.length);
  }
  return `s:${body.length}:${(hash >>> 0).toString(36)}`;
}

/** What a create's same-revision check asks D1: its document, floor, body key and author. */
export interface CandidateRequest {
  doc: string;
  floor: number;
  bodyKey: string;
  /** The incoming author when it is a string; otherwise any author matches. */
  author: string | null;
}

export function candidateId(request: CandidateRequest): string {
  return JSON.stringify([request.doc, request.floor, request.bodyKey, request.author]);
}

/** What a placement needs read before it can answer. */
export type PlacementNeed =
  | { kind: "runs"; doc: string; from: number }
  | { kind: "candidates"; request: CandidateRequest; limit: number }
  | { kind: "bodies"; keys: string[] }
  | { kind: "version"; key: string }
  | { kind: "walk" };

/**
 * A placed operation: the row to fold and its parsed payload (null when the log already holds the
 * revision), and `revive` when it moved onto the id of a deleted revision D1 holds, whose version
 * count the create continues.
 */
export type Placed<R extends PlacementRow = PlacementRow> =
  | { row: R; payload: unknown; revive?: { version: number } }
  | { row: null }
  | { need: PlacementNeed };

/** Runs read ahead per document, and same-body revisions per create. The ordinary answer is none. */
export const RUNS_READ = 8;
export const CANDIDATES_READ = 4;

/** Numbers held by live revisions of a document, known from `from` to `to` (inclusive). */
interface KnownRuns {
  from: number;
  to: number;
  runs: Array<[number, number]>;
}

interface DocumentOverlay {
  /** Live keys the step knows, by number. */
  live: Map<number, Set<string>>;
  /** Live keys the step knows, by body. */
  bodies: Map<unknown, Set<string>>;
  /** Where each key the step knows was last indexed. */
  at: Map<string, { rev: number; live: boolean; body: unknown }>;
}

function keyOf(entity: string, entityId: string): string {
  return `${entity} ${entityId}`;
}

/**
 * The placement of a step's revision creates, over the fold the step holds in memory (`fold`, the
 * map `foldRow` folds into) and what was read from D1 at the step's base mark.
 */
export class RevisionPlacer {
  private readonly overlays = new Map<string, DocumentOverlay>();
  private readonly runs = new Map<string, KnownRuns[]>();
  /** D1's live keys at the number of every revision the step names. */
  private readonly slots = new Map<string, Map<number, string[]>>();
  private readonly candidates = new Map<string, { rows: Array<{ key: string; rev: number }>; complete: boolean; limit: number }>();
  /** Bodies and authors of stored revisions, read to confirm a key's match. */
  private readonly bodies = new Map<string, { body: unknown; author: unknown }>();
  /** Versions of ids a revision may move onto: null when D1 holds none. */
  private readonly versions = new Map<string, { version: number; deletedAt: number | null } | null>();
  /** Numbers stepped through one at a time, this step. */
  walked = 0;

  constructor(
    private readonly fold: ReadonlyMap<string, PlacementEntry>,
    /** Raised by the caller for an operation that must be placed however far it walks. */
    public walkLimit: number,
  ) {}

  /** Held runs of `doc` from `from` upward: the first `limit`, or all of them when fewer. */
  absorbRuns(doc: string, from: number, limit: number, runs: Array<[number, number]>): void {
    const sorted = [...runs].sort((a, b) => a[0] - b[0]);
    const to = sorted.length < limit ? Number.POSITIVE_INFINITY : sorted[sorted.length - 1]![1] + 1;
    const list = this.runs.get(doc) ?? [];
    list.push({ from, to, runs: sorted });
    this.runs.set(doc, list);
  }

  /** D1's live keys at a number: every one, for a number some revision in the step is named at. */
  absorbSlot(doc: string, rev: number, keys: readonly string[]): void {
    const bySlot = this.slots.get(doc) ?? new Map<number, string[]>();
    bySlot.set(rev, [...(bySlot.get(rev) ?? []), ...keys]);
    this.slots.set(doc, bySlot);
  }

  absorbCandidates(request: CandidateRequest, limit: number, rows: ReadonlyArray<{ key: string; rev: number }>): void {
    const sorted = [...rows].sort((a, b) => a.rev - b.rev || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    this.candidates.set(candidateId(request), { rows: sorted, complete: sorted.length < limit, limit });
  }

  absorbBody(key: string, state: Record<string, unknown>): void {
    this.bodies.set(key, { body: state.body, author: state.author });
  }

  absorbVersion(key: string, version: { version: number; deletedAt: number | null } | null): void {
    this.versions.set(key, version);
  }

  /** Call after `foldRow` folds into `key`, so later placements read the revision as the step left it. */
  observe(key: string): void {
    const entry = this.fold.get(key);
    if (!entry) return;
    const slot = revisionSlot(entry.entity, entry.entityId);
    if (!slot) return;
    const overlay = this.overlays.get(slot.doc);
    // Not indexed yet: built from the fold when first asked, which will see this.
    if (!overlay) return;
    this.untrack(overlay, key);
    this.track(overlay, key, slot.rev, entry);
  }

  /**
   * A revision create as it folds, the same row `settleRevision` makes of it: as it is, moved to
   * another number, or nothing when it is a revision already held. Or what must be read first.
   * `payload` is the row's payload parsed, or undefined when it does not parse.
   */
  place<R extends PlacementRow>(row: R, payload: Record<string, unknown> | undefined): Placed<R> {
    if (payload === undefined) return { row, payload: undefined };
    const slash = row.entity_id.lastIndexOf("/");
    const doc = row.entity_id.slice(0, slash + 1);
    const claimed = Number(row.entity_id.slice(slash + 1));
    if (!Number.isInteger(claimed)) return { row, payload };

    const overlay = this.overlay(doc);
    const floor = Math.min(claimed, writtenAs(payload.changeSummary) ?? claimed);
    const incoming = { body: payload.body, author: payload.author };

    // 1. The same revision, already held at or above the floor: the lowest number holding it.
    let again: number | null = null;
    if (comparable(incoming.body)) {
      for (const key of overlay.bodies.get(incoming.body) ?? []) {
        const at = overlay.at.get(key)!;
        const held = this.fold.get(key)!;
        if (at.rev < floor || !sameRevision({ body: held.state.body, author: held.state.author }, incoming)) continue;
        if (again === null || at.rev < again) again = at.rev;
      }
      const request: CandidateRequest = {
        doc,
        floor,
        bodyKey: bodyKey(incoming.body)!,
        author: typeof incoming.author === "string" ? incoming.author : null,
      };
      const found = this.candidates.get(candidateId(request));
      if (!found) return { need: { kind: "candidates", request, limit: CANDIDATES_READ } };
      // D1's rows at the base mark, less every revision the step knows better (read above).
      const unknown = found.rows.filter((candidate) => !this.fold.has(candidate.key));
      const unconfirmed = typeof incoming.body === "string" ? unknown.filter((candidate) => !this.bodies.has(candidate.key)) : [];
      if (unconfirmed.length > 0) return { need: { kind: "bodies", keys: unconfirmed.map((candidate) => candidate.key) } };
      const same = unknown.find((candidate) => typeof incoming.body !== "string" || sameRevision(this.bodies.get(candidate.key)!, incoming));
      if (same) {
        if (again === null || same.rev < again) again = same.rev;
      } else if (!found.complete) {
        const last = found.rows[found.rows.length - 1]!.rev;
        if (again === null || again > last) return { need: { kind: "candidates", request, limit: found.limit * 2 } };
      }
    }
    if (again !== null) return { row: null };

    // 2. The first number from the claim upward that no live revision holds.
    let slot = claimed;
    for (;;) {
      this.walked += 1;
      if (this.walked > this.walkLimit) return { need: { kind: "walk" } };
      if ((overlay.live.get(slot)?.size ?? 0) > 0) {
        slot += 1;
        continue;
      }
      const aliases = this.slots.get(doc)?.get(slot);
      if (aliases !== undefined) {
        // Held while D1 has a live revision here that the step does not know (and so has not changed).
        if (aliases.some((key) => !this.fold.has(key))) {
          slot += 1;
          continue;
        }
        break;
      }
      const known = this.runs.get(doc)?.find((entry) => entry.from <= slot && slot <= entry.to);
      if (!known) return { need: { kind: "runs", doc, from: slot } };
      const run = known.runs.find(([lo, hi]) => lo <= slot && slot <= hi);
      if (!run) break;
      // Held by D1 to the end of the run, except where every revision at a number is one the step knows.
      let next = run[1] + 1;
      for (const listed of this.slots.get(doc)?.keys() ?? []) if (listed > slot && listed < next) next = listed;
      slot = next;
    }

    const changeSummary = summaryAt(payload.changeSummary, claimed, slot);
    if (slot === claimed && changeSummary === (payload.changeSummary ?? null)) return { row, payload };
    const entityId = `${doc}${slot}`;
    const key = keyOf("documentRevision", entityId);
    let revive: { version: number } | undefined;
    if (!this.fold.has(key)) {
      if (!this.versions.has(key)) return { need: { kind: "version", key } };
      const stored = this.versions.get(key);
      if (stored) {
        // No live revision holds this number (above), so one stored under this id is deleted.
        if (stored.deletedAt === null) throw new Error(`a revision was placed on ${entityId}, which is live`);
        revive = { version: stored.version };
      }
    }
    const moved = { ...payload, revision: slot, changeSummary };
    return { row: { ...row, entity_id: entityId, payload: JSON.stringify(moved) }, payload: moved, ...(revive ? { revive } : {}) };
  }

  private overlay(doc: string): DocumentOverlay {
    let overlay = this.overlays.get(doc);
    if (overlay) return overlay;
    overlay = { live: new Map(), bodies: new Map(), at: new Map() };
    for (const [key, entry] of this.fold) {
      const slot = revisionSlot(entry.entity, entry.entityId);
      if (slot?.doc === doc) this.track(overlay, key, slot.rev, entry);
    }
    this.overlays.set(doc, overlay);
    return overlay;
  }

  private track(overlay: DocumentOverlay, key: string, rev: number, entry: PlacementEntry): void {
    const live = entry.deletedAt === null;
    const body = entry.state.body;
    overlay.at.set(key, { rev, live, body });
    if (!live) return;
    add(overlay.live, rev, key);
    if (comparable(body)) add(overlay.bodies, body, key);
  }

  private untrack(overlay: DocumentOverlay, key: string): void {
    const at = overlay.at.get(key);
    if (!at) return;
    overlay.at.delete(key);
    if (!at.live) return;
    remove(overlay.live, at.rev, key);
    if (comparable(at.body)) remove(overlay.bodies, at.body, key);
  }
}

function add<K>(map: Map<K, Set<string>>, at: K, key: string): void {
  const set = map.get(at);
  if (set) set.add(key);
  else map.set(at, new Set([key]));
}

function remove<K>(map: Map<K, Set<string>>, at: K, key: string): void {
  const set = map.get(at);
  if (!set) return;
  set.delete(key);
  if (set.size === 0) map.delete(at);
}
