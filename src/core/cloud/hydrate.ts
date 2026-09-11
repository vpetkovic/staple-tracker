/**
 * Applying a snapshot's entities in an order a database can take them.
 *
 * Contract: `docs/sync.md`, "Bootstrap is a snapshot cutoff plus the ordered tail".
 *
 * ## The snapshot is ordered for paging, not for applying
 *
 * `GET /snapshot` pages entities by their key, `"<entity> <entityId>"`, because that is
 * a stable order a cursor can resume from. It is not a dependency order: `comment …`
 * and `documentRevision …` sort before `issue …`, a child issue sorts before its parent
 * whenever its UUID does, and `status @order` sorts before every status it orders. A
 * device hydrating a repository with a single comment in it therefore met the comment
 * before its issue, the applier refused it as `ReferentMissing`, and the bootstrap
 * failed on every attempt, with nothing to say why beyond a referent name.
 *
 * Asking the service for a different order would change what a snapshot cursor
 * means on a Worker every client depends on, and it still would not help: a
 * dependency can sit on a later PAGE than its dependent. So the order is repaired
 * where the rows are written:
 *
 *   - within what is in hand, entities are applied dependencies first
 *     ({@link orderForHydration});
 *   - an entity whose referent has not arrived is PARKED rather than failed, and is
 *     retried as later entities land ({@link hydrate});
 *   - only when the whole snapshot is in hand does a still-missing referent fail, and
 *     it fails loudly, naming it — the same rule the pull loop applies to one page.
 */
import type { DatabaseSync } from "node:sqlite";
import { recordInheritedFieldWrites, type Journal } from "../journal.js";
import { ReferentMissing, applyToDatabase, localEntityVersion, noteLoggedOriginClaim, setEntityVersion, snapshotToInput } from "./apply.js";
import { withoutOpenContests } from "./conflicts.js";
import { cloudError } from "./errors.js";
import type { SnapshotEntity } from "./wire.js";

/** The sentinel entity the vocabulary order travels on. Mirrors `store.ts` and `apply.ts`. */
export const VOCABULARY_ORDER_ID = "@order";

/**
 * The synthetic ledger id a snapshot entity is applied under.
 *
 * Derived from the entity key and the cutoff, so re-applying a re-fetched page is a
 * ledger hit rather than a second write. It is not an operation id the server ever
 * issued, and it is never sent anywhere.
 */
export function snapshotOpId(
  cutoffSeq: number,
  entity: { entity: string; entityId: string },
  ledger = "snap",
): string {
  return `${ledger}:${cutoffSeq}:${entity.entity} ${entity.entityId}`;
}

/**
 * Where an entity sits in dependency order. Lower applies first.
 *
 * 0  nothing else in a workspace is a precondition for it
 * 1  issues, which everything below may name
 * 2  entities that name an issue
 * 3  entities that name a SET of other entities and are wrong if applied early:
 *    the plan, and a vocabulary order, whose ids an early apply silently skips
 */
export function hydrationRank(entity: { entity: string; entityId: string }): number {
  switch (entity.entity) {
    case "setting":
    case "project":
      return 0;
    case "status":
    case "kind":
      return entity.entityId === VOCABULARY_ORDER_ID ? 3 : 0;
    case "issue":
      return 1;
    case "queue":
      return 3;
    default:
      return 2;
  }
}

/**
 * Where an entity's claim on its unique value sits in the log: the seq of the last write
 * of that value when some operation after the create set it, else the create's seq.
 * `Infinity` from a service too old to say, which leaves those in the snapshot's order.
 */
function claimSeq(entity: SnapshotEntity): number {
  const field = entity.entity === "issue" ? "identifier" : entity.entity === "project" ? "slug" : null;
  const written = field ? entity.fieldWrites?.[field]?.seq : undefined;
  if (typeof written === "number") return written;
  return typeof entity.createdSeq === "number" ? entity.createdSeq : Number.POSITIVE_INFINITY;
}

/**
 * Dependencies first, parents before children among the issues, and within each group
 * the earlier claim first.
 *
 * The last is what makes a hydrating device settle two claims on one identifier or slug
 * the way a device reading the ordered tail did. The applier gives the value to whoever
 * holds it and a stand-in to whoever arrives second (`claims.ts`), so arriving in log
 * order is the whole of agreeing with the log. Applied in key order instead — the order
 * the snapshot is paged in, a function of the UUIDs — a fresh device gave `STA-5` to
 * whichever of two issues happened to sort first, and disagreed with every other device
 * about which issue `STA-5` is.
 */
export function orderForHydration(entities: readonly SnapshotEntity[]): SnapshotEntity[] {
  const byRank = [...entities].sort((a, b) => hydrationRank(a) - hydrationRank(b) || claimSeq(a) - claimSeq(b));
  const issues = byRank.filter((entity) => entity.entity === "issue");
  if (issues.length < 2) return byRank;

  const byId = new Map(issues.map((issue) => [issue.entityId, issue]));
  const ordered: SnapshotEntity[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (issue: SnapshotEntity): void => {
    if (placed.has(issue.entityId) || visiting.has(issue.entityId)) return;
    visiting.add(issue.entityId);
    const parentId = issue.state.parentId ?? issue.state.parent_id;
    const parent = typeof parentId === "string" ? byId.get(parentId) : undefined;
    if (parent) place(parent);
    visiting.delete(issue.entityId);
    placed.add(issue.entityId);
    ordered.push(issue);
  };
  for (const issue of issues) place(issue);

  const firstIssue = byRank.findIndex((entity) => entity.entity === "issue");
  const rest = byRank.filter((entity) => entity.entity !== "issue");
  return [...rest.slice(0, firstIssue), ...ordered, ...rest.slice(firstIssue)];
}

/**
 * Apply ONE snapshot entity: its state, its version, and the provenance it carries.
 *
 * Throws {@link ReferentMissing} when something it names has not arrived; the
 * `applyRemote` savepoint has already rolled back the ledger row and anything written,
 * so the caller can retry it later as though it had never been tried.
 */
export function applySnapshotEntity(
  db: DatabaseSync,
  journal: Journal,
  entity: SnapshotEntity,
  cutoffSeq: number,
  at: string,
  sameTimeline = false,
  ledger = "snap",
): void {
  const input = snapshotToInput(withoutStalePlaces(db, `${ledger}:${cutoffSeq}`, entity), at);
  // Where its claim on an external origin sits in the log, for the settlement of a later one.
  noteLoggedOriginClaim(db, `${ledger}:${cutoffSeq}`, entity);
  /**
   * Through `applyRemote` so the write is echo-suppressed: a hydrating device must not
   * journal an outbound copy of every row it was handed, which would push the entire
   * repository straight back at the server.
   */
  journal.applyRemote({ opId: snapshotOpId(cutoffSeq, entity, ledger), seq: entity.lastSeq }, () => {
    /**
     * Read BEFORE `setEntityVersion`, and used below. On a first bootstrap this is 0; on
     * a re-bootstrap it is the counter this device carried across the epoch change,
     * which `beginBootstrap` deliberately does not rewind. `recordInheritedFieldWrites`
     * needs the one from before, because the one from after is the snapshot's own number.
     */
    /**
     * Except when this device is re-reading the timeline it is already on (`sameTimeline`,
     * the recovery in `sync.ts`). Then its counter and the fold's count the same
     * operations, and lifting every inherited write to the counter would claim each field
     * was written just now — contesting the next remote edit of a field nobody has touched
     * in weeks. The fold's own numbers are already on this device's scale; the upsert
     * keeps whichever claim is newer.
     */
    const priorVersion = sameTimeline ? 0 : localEntityVersion(db, entity.entity, entity.entityId);
    /**
     * On the timeline it is already on, a device may hold values an open record here is
     * still about, and the fold holds the other side of each: those are withheld, as the
     * screen withholds them from an operation (`withoutOpenContests`).
     */
    const screened = sameTimeline ? withoutOpenContests(db, input) : { input, keeps: () => true };
    if (screened.input !== null) applyToDatabase(db, screened.input);
    setEntityVersion(db, entity.entity, entity.entityId, entity.version);
    /**
     * And the provenance for the values just inherited (STA-263). `fieldWrites` names only
     * the fields a non-`create` operation carried, so the defaults that rode along inside
     * a create acquire no claim. An older Worker sends nothing here and the device is left
     * exactly as blind as it was before, which is the only safe degradation.
     */
    recordInheritedFieldWrites(
      db,
      entity.entity,
      entity.entityId,
      Object.entries(entity.fieldWrites ?? {})
        .filter(([field]) => screened.keeps(field))
        .map(([field, write]) => ({
        field,
        baseVersion: write.baseVersion,
        opId: write.opId,
        at: write.at,
      })),
      priorVersion,
    );
  });
}

/** Each status and kind's create seq, per snapshot, for the order that follows them. */
const createdAt = new WeakMap<DatabaseSync, { snapshot: string; seqs: Map<string, number> }>();

/**
 * A vocabulary order without the entries created after it was written.
 *
 * A status or kind removed and added again with no position — an older build's `rm` then
 * `add` — is put at the end by every device reading the log, and a fold from before this
 * build still held its old place in the order. The service's fold now forgets that place
 * (`forgetPlace`, `worker/src/fold.ts`); this is the same rule for a snapshot that does not:
 * an entry whose create is later in the log than the order's last write is not in it, and
 * goes where an entry the order does not name goes — after it.
 */
function withoutStalePlaces(db: DatabaseSync, snapshot: string, entity: SnapshotEntity): SnapshotEntity {
  if (entity.entity !== "status" && entity.entity !== "kind") return entity;
  let held = createdAt.get(db);
  if (!held || held.snapshot !== snapshot) {
    held = { snapshot, seqs: new Map() };
    createdAt.set(db, held);
  }
  if (entity.entityId !== VOCABULARY_ORDER_ID) {
    if (typeof entity.createdSeq === "number") held.seqs.set(`${entity.entity}/${entity.entityId}`, entity.createdSeq);
    return entity;
  }
  const order = entity.state.order;
  const written = entity.fieldWrites?.order?.seq ?? entity.createdSeq;
  if (!Array.isArray(order) || typeof written !== "number") return entity;
  const seqs = held.seqs;
  const kept = order.filter((id) => !(typeof id === "string" && (seqs.get(`${entity.entity}/${id}`) ?? -1) > written));
  return kept.length === order.length ? entity : { ...entity, state: { ...entity.state, order: kept } };
}

export interface HydrateOutcome {
  /** Entities written by this call, including parked ones that finally landed. */
  readonly applied: number;
  /** Entities still waiting for a referent. Empty whenever `final` was set. */
  readonly parked: SnapshotEntity[];
}

/**
 * Apply what is in hand, park what cannot land yet, and retry until nothing moves.
 *
 * MUST run inside the caller's transaction. `parked` carries entities an earlier page
 * could not place; they are tried again here, after this page's entities, because a
 * later page is exactly where their referents come from.
 *
 * A vocabulary order is parked until `final` regardless of whether it would apply: it
 * names every status of its class, and one applied before the last of them has arrived
 * silently skips the ids it cannot find — the order is then wrong with nothing to say
 * so. There is no referent check that could catch that, which is why it is a rule.
 *
 * With `final` set, anything still parked is a snapshot that cannot be applied
 * coherently, and it fails whole: *"a partial page is worse than none"* is as true of a
 * snapshot as of a page.
 */
export function hydrate(
  db: DatabaseSync,
  journal: Journal,
  entities: readonly SnapshotEntity[],
  parked: readonly SnapshotEntity[],
  cutoffSeq: number,
  at: string,
  final: boolean,
  sameTimeline = false,
  /**
   * The namespace of the synthetic ledger ids. A re-read of a snapshot this device has
   * already applied at the same cutoff — the applier catch-up in `sync.ts` — needs ids of
   * its own, or every entity is a ledger hit and nothing is re-applied.
   */
  ledger = "snap",
): HydrateOutcome {
  let applied = 0;
  let pending = orderForHydration([...entities, ...parked]);
  let missing: ReferentMissing | null = null;

  for (;;) {
    const next: SnapshotEntity[] = [];
    let progressed = false;
    for (const entity of pending) {
      if (!final && isVocabularyOrder(entity)) {
        next.push(entity);
        continue;
      }
      try {
        applySnapshotEntity(db, journal, entity, cutoffSeq, at, sameTimeline, ledger);
        applied += 1;
        progressed = true;
      } catch (error) {
        if (!(error instanceof ReferentMissing)) throw error;
        missing = error;
        next.push(entity);
      }
    }
    pending = next;
    if (!progressed || pending.length === 0) break;
  }

  if (final && pending.length > 0) {
    const first = pending[0]!;
    throw cloudError(
      "validation",
      `The snapshot's ${first.entity} ${first.entityId} names something the snapshot never ` +
        `delivered${missing ? `: ${missing.what}` : ""}. Nothing from this snapshot page was ` +
        `applied and the position did not move, so the next sync retries it.`,
      { parked: pending.length },
    );
  }
  return { applied, parked: pending };
}

function isVocabularyOrder(entity: SnapshotEntity): boolean {
  return (entity.entity === "status" || entity.entity === "kind") && entity.entityId === VOCABULARY_ORDER_ID;
}
