/**
 * The registry as operations, and operations back as a registry.
 *
 * Contract: `docs/sync.md`, "The hub registry is a set, not a map" and "Protocol
 * evolution". Sibling of {@link ./hub-registry.js}, which owns the payload type
 * and the adoption rules; this file owns only the translation to and from the
 * wire and knows nothing about hubs, databases or networks.
 *
 * ## Why the hub becomes a repository rather than growing a storage concept
 *
 * The service is repository-scoped end to end. `worker/src/auth.ts` resolves a
 * token to exactly one `repo_id` and binds it into every subsequent statement, so
 * "cross-repository access is structurally impossible rather than merely
 * checked"; a backup is a fold of one repository's operation log
 * (`worker/src/fold.ts`); a restore materialises that fold into a new epoch of
 * that same log. There is no second storage shape to reach for and no route that
 * takes a blob.
 *
 * So the hub is a repository, scoped by `hub.hubId()` — an identity `hub.ts`
 * already mints and stores in `hub.db`'s `meta` table for exactly this reason:
 * *"it is the thing a backup is OF, and a backup that cannot say what it is a
 * backup of cannot be safely restored"*. Its operation log carries the registry.
 * Then **backup is the existing fold and restore is the existing snapshot**, and
 * this feature adds no persistence mechanism at all — which is the whole reason
 * this shape was chosen over inventing one.
 *
 * ## Two entities, and why the pair rather than one
 *
 * `registration` keyed by `repositoryId`, `crossLink` keyed by its four names.
 * They are separate entities because they have different keys and different
 * lifecycles, and the fold is per entity: one blob entity holding the whole
 * registry would make every publish rewrite every workspace, so two machines
 * editing two different workspaces would each supersede the other's row. The
 * fold is last-write-wins per entity, so the granularity of the entity IS the
 * granularity of the conflict.
 *
 * ## A registration with no `repositoryId` is not publishable
 *
 * `RegistryEntry.repositoryId` is nullable, because a workspace that has never
 * recorded a `.staple/repository.json` has no identity yet. Such an entry has no
 * adoption key, and the entity id has to BE the adoption key — anything else and
 * two machines cannot agree that they are talking about the same workspace.
 *
 * Minting one here is precisely the silent fork `repo-identity.ts` exists to
 * prevent: the id would be this machine's invention, the real repository would
 * later record its own, and the registry would hold two rows for one workspace
 * with no way to notice. So the entry is REFUSED rather than skipped quietly, and
 * the caller reports it — `adoptRegistry` already has an `unmatchable` outcome
 * with a sentence for exactly this state, and this is the same fact seen from the
 * sending side.
 *
 * ## The cross-link entity id is an encoding, not a hash
 *
 * The requirement is that the same edge is the same entity on both machines, from
 * the four names alone. A hash would satisfy that and was rejected: it is one-way,
 * so a log row becomes unreadable to a human debugging it, and it introduces a
 * collision probability where none is needed. Percent-encoding each component and
 * joining with `/` is INJECTIVE by construction — `encodeURIComponent` escapes the
 * separator, so distinct four-tuples cannot collide — and it follows the
 * precedent already on the wire: a `document` entity id is `"<issueId>/<key>"`
 * and `apply.ts` splits it back. See {@link crossLinkEntityId}.
 *
 * It also keeps this module free of `node:crypto`, and therefore free of every
 * runtime assumption, which is what lets `worker/test/registry.test.ts` import it
 * and push the real shapes through the real routes instead of re-typing them as a
 * second set of literals that could drift.
 *
 * ## What cannot be in an emitted operation
 *
 * A path. Not by redaction — {@link RegistrationPayload} is a closed interface
 * with no path field, so emitting one is a compile error rather than a review
 * finding, exactly as `hub-registry.ts` arranged for `RegistryEntry`: *"the field
 * does not exist to be forgotten."* Every value in an emitted payload is copied
 * from the {@link HubRegistryPayload} it was given, and
 * `test/cloud-hub-registry-wire.test.ts` pins both halves — the exact key set of
 * every payload, and that a real hub's absolute `workspaces.path` appears nowhere
 * in the serialized batch.
 */
import { StapleError } from "../types.js";
import {
  REGISTRY_PAYLOAD_FORMAT,
  type HubRegistryPayload,
  type RegistryCrossLink,
  type RegistryEntry,
} from "./hub-registry.js";

/** The two entity names this module emits. Mirrored in `worker/src/envelope.ts`. */
export const REGISTRATION_ENTITY = "registration";
export const CROSS_LINK_ENTITY = "crossLink";

/**
 * The protocol version the two entities require.
 *
 * A wire widening, declared rather than assumed. `docs/sync.md` used to claim that
 * "new entity kinds" were additive within a protocol version; they are not, because
 * `apply.ts` THROWS on an entity it does not know and only `ReferentMissing` is
 * deferred, so an older device pulling one of these would stall its whole page. See
 * `worker/src/envelope.ts` and the amended "Protocol evolution".
 */
export const REGISTRY_PROTOCOL = 2;

/**
 * One workspace, as a `registration` payload.
 *
 * A CLOSED interface, and that is the point rather than tidiness. There is no
 * `path`, no `lastSeenAt` and no index signature, so a later edit cannot add a
 * filesystem path to this shape without the compiler refusing it.
 *
 * `format` rides on every payload rather than being stated once for the log. Ops
 * from different builds interleave in one operation log — that is what a log is —
 * so a single declaration somewhere would describe whichever build wrote it last.
 * Per-op it is one small integer, it survives the fold untouched (every verb
 * merges the keys it carried), and a reader takes the maximum and refuses on it.
 */
export interface RegistrationPayload {
  readonly format: number;
  readonly slug: string;
  readonly prefix: string;
  readonly kind: string;
  readonly addedAt: string;
}

/**
 * One edge, as a `crossLink` payload. Also closed, for the same reason.
 *
 * ## `present` is a FIELD, and the alternative was un-resurrectable edges
 *
 * The obvious way to retract an edge is the `delete` verb, and it is wrong here. The
 * fold's tombstone is final by design — *"the tombstone wins regardless of arrival
 * order, which is what makes convergence order-independent"* — and `fold.ts` discards
 * every later operation on a tombstoned entity. That is exactly right for an `issue`,
 * whose id is minted once, because resurrecting one is meaningless.
 *
 * A cross-link's id is **derived from its content**. So "remove a blocker, then put it
 * back" — an ordinary thing a person does — produces the same entity id again, lands on
 * the tombstone, and is silently discarded while the push reports success. The edge
 * could never come back, and a restore would carry the tombstone into the new epoch
 * because `materializedVerb` reproduces a bare `delete`. The epoch bump is not an
 * escape from it.
 *
 * Two other options were considered and rejected:
 *
 *   - **Never retract at all**, mirroring the registration rule. But an edge removed
 *     locally would stay in the published set and `adoptRegistry` would put it back on
 *     the next adopt, so a person could not remove a blocker and have it stay removed.
 *   - **A generation counter in the key**, bumped past existing tombstones. Derivable
 *     from the snapshot, so it needs no local state — but it makes the key no longer a
 *     pure function of the four names, which is the property that lets two machines
 *     agree an edge is the same edge without coordinating.
 *
 * A `present` flag keeps the key pure, keeps retraction expressible, and makes
 * resurrection an ordinary field update that the fold's plain merge already handles.
 * The cost is that a retracted edge stays as a row — which a tombstone also does.
 *
 * **So this wire emits no `delete`, ever, for either entity.** `worker/src/envelope.ts`
 * refuses the verb for both registry entities so that stays true structurally rather
 * than by the client's good manners.
 */
export interface CrossLinkPayload {
  readonly format: number;
  readonly blockerWs: string;
  readonly blockerIdentifier: string;
  readonly blockedWs: string;
  readonly blockedIdentifier: string;
  readonly type: "blocks";
  /** False retracts the edge from the published set. See the type comment. */
  readonly present: boolean;
}

/** One operation to publish. The envelope's other fields are the caller's business. */
export interface RegistryOperation {
  readonly entity: typeof REGISTRATION_ENTITY | typeof CROSS_LINK_ENTITY;
  readonly entityId: string;
  /** Never `delete`. See {@link CrossLinkPayload} for why the verb is not used here. */
  readonly verb: "create" | "update";
  /**
   * The folded entity version this operation moves off — 0 for a `create`.
   *
   * Carried on the operation rather than left to the caller because it is part of the
   * operation's IDENTITY: `hub-registry-service.ts` derives the `opId` from it, which
   * is what stops a value that repeats over time from colliding with its own earlier
   * appearance. See that module's `operationId`.
   */
  readonly baseVersion: number;
  readonly payload: RegistrationPayload | CrossLinkPayload;
}

/**
 * What the service currently holds, as a reader of `GET /snapshot` sees it.
 *
 * Keyed by `${entity} ${entityId}`, which is the same composite the Worker's
 * `entityKey` uses. Only what a diff needs: the folded state and whether the
 * entity is tombstoned.
 */
export interface PublishedState {
  readonly entity: string;
  readonly entityId: string;
  readonly state: Record<string, unknown>;
  readonly deleted: boolean;
  /**
   * Operations folded into this entity, as the snapshot reports it.
   *
   * Load-bearing rather than informational: it is what makes an operation id unique
   * over TIME. A registry value can legitimately return to an earlier value — a
   * workspace renamed back, an edge removed and re-added — and an id derived only from
   * the content would then repeat and be absorbed as a duplicate. The version is
   * monotonic in the number of operations, so it cannot.
   */
  readonly version: number;
}

/** An entity as `GET /snapshot` returns it, reduced to the fields this module reads. */
export interface SnapshotEntityLike {
  readonly entity: string;
  readonly entityId: string;
  readonly deletedAt: number | null;
  readonly state: Record<string, unknown>;
  /** Operations folded in. Optional only so a test fixture need not invent one. */
  readonly version?: number;
}

function key(entity: string, entityId: string): string {
  return `${entity} ${entityId}`;
}

/**
 * The entity id of a cross-link: its four names, each percent-encoded, joined by
 * `/`.
 *
 * Injective, because `encodeURIComponent` escapes `/` and `%`, so no two distinct
 * four-tuples can produce the same string and no component can smuggle a
 * separator. Deterministic across machines because it is a pure function of the
 * names, which is the requirement: the same edge has to be the same entity on
 * both sides or two machines will each hold their own copy of one link.
 *
 * `type` is deliberately NOT in the key. There is one edge type today, and if a
 * second is ever added it belongs in the payload where the fold can update it —
 * putting it in the key would make changing an edge's type a delete plus a create
 * of an unrelated entity.
 */
export function crossLinkEntityId(link: {
  blockerWs: string;
  blockerIdentifier: string;
  blockedWs: string;
  blockedIdentifier: string;
}): string {
  return [
    link.blockerWs,
    link.blockerIdentifier,
    link.blockedWs,
    link.blockedIdentifier,
  ]
    .map(encodeURIComponent)
    .join("/");
}

/** Undo {@link crossLinkEntityId}. Exported for the tests, which assert it inverts. */
export function parseCrossLinkEntityId(entityId: string): {
  blockerWs: string;
  blockerIdentifier: string;
  blockedWs: string;
  blockedIdentifier: string;
} | null {
  const parts = entityId.split("/");
  if (parts.length !== 4) return null;
  const [blockerWs, blockerIdentifier, blockedWs, blockedIdentifier] = parts.map(
    decodeURIComponent,
  ) as [string, string, string, string];
  return { blockerWs, blockerIdentifier, blockedWs, blockedIdentifier };
}

/**
 * Refuse a payload written in a format this build does not understand.
 *
 * The same refusal, for the same stated reason, as `hub-registry.ts`: *"guessing
 * at a format you do not know produces a registry that is subtly wrong, and a
 * wrong registry is worse than none because it is believed."*
 */
function assertFormat(format: number): void {
  if (format > REGISTRY_PAYLOAD_FORMAT) {
    throw new StapleError(
      "validation",
      `This registry was written in format ${format}, and this build understands ` +
        `${REGISTRY_PAYLOAD_FORMAT}. Upgrade staple on this machine rather than adopting it ` +
        "partially — a registry read with the wrong rules is believed, which is worse than not " +
        "having one.",
    );
  }
}

/** Index a snapshot page's entities for {@link diffRegistry}. */
export function publishedStateOf(
  entities: readonly SnapshotEntityLike[],
): Map<string, PublishedState> {
  const map = new Map<string, PublishedState>();
  for (const entity of entities) {
    if (entity.entity !== REGISTRATION_ENTITY && entity.entity !== CROSS_LINK_ENTITY) continue;
    map.set(key(entity.entity, entity.entityId), {
      entity: entity.entity,
      entityId: entity.entityId,
      state: entity.state,
      deleted: entity.deletedAt !== null,
      version: entity.version ?? 1,
    });
  }
  return map;
}

/** A registration that cannot be published, and the sentence saying why. */
export interface UnpublishableEntry {
  readonly entry: RegistryEntry;
  readonly reason: string;
}

/** A published edge this machine declined to retract, and why. */
export interface RetainedEdge {
  readonly entityId: string;
  readonly reason: string;
}

export interface RegistryDiff {
  /** In log order: registrations first, then cross-links. Never a `delete`. */
  readonly operations: readonly RegistryOperation[];
  /** Entries with no `repositoryId`. Reported, never invented. See the header. */
  readonly unpublishable: readonly UnpublishableEntry[];
  /**
   * Published edges left alone because this machine has no basis for an opinion about
   * them. See {@link diffRegistry} — absence is not the same as removal.
   */
  readonly retained: readonly RetainedEdge[];
  /** True when the service already holds exactly this registry. */
  readonly upToDate: boolean;
}

/**
 * The operations that would make the service hold this registry.
 *
 * Derived from current state against the service's current fold, at push time,
 * and deliberately NOT from a hub outbox.
 *
 * ## Why there is no hub outbox and no hub migration
 *
 * Every workspace sync path assumes `sync_outbox`, `sync_state` and
 * `sync_field_writes` (workspace migrations 010/011/012), and `hub.db` has none of
 * them. Adding them would be a large, permanent surface — a journal seam, a
 * client-seq allocator, an applied-op ledger, a cursor, and a migration that every
 * future hub read has to carry — and it would buy nothing here, because the
 * registry is small and **fully re-derivable from current state**. There is no
 * history to replay: what should be on the service is a pure function of what the
 * hub holds right now, so the set of operations to publish is computable on demand
 * by comparing the two. An outbox exists to remember intent across a crash; a
 * re-derivable set has no intent to remember.
 *
 * The cost is one `GET /snapshot` per publish, which is the same read a restore
 * already makes and is bounded by the number of workspaces on one machine.
 *
 * ## A registration is never deleted, and that is the unregister rule
 *
 * `docs/sync.md`: *"`staple hub unregister` removes a row here and nowhere else …
 * Propagating it would turn a reversible local act into an irreversible remote
 * one."* A workspace missing from `local` is therefore left in the published set
 * untouched — the machine that unregistered it records a `registry_optouts` row
 * instead, which never leaves and which adoption consults so the row does not come
 * back HERE. Emitting a delete would be the propagation the contract refuses, and
 * it is not expressible: this function has no branch that produces a `delete` for a
 * registration.
 *
 * Cross-links ARE diffed both ways, because an edge is a level-triggered fact about two
 * issues rather than a machine's decision about its own list. A retraction sets
 * `present: false` and never uses the `delete` verb — see {@link CrossLinkPayload}.
 *
 * ## A machine may only retract an edge it could have HAD
 *
 * This is the floor, and without it a publish from an incompletely-adopted machine
 * permanently destroys edges nobody asked it to touch.
 *
 * Absence of an edge locally does not mean somebody removed it. It very often means
 * this machine never had it: `adoptRegistry` **previews by default**, and even on an
 * apply it *"skips an edge naming a workspace that did not land"* — which happens for an
 * opted-out `repositoryId`, a parked prefix collision, and an entry with no identity. So
 * a machine that adopted a preview, or that parked one prefix, or that has not adopted
 * at all, holds a registry that is a strict SUBSET of the published one through no fault
 * of anyone's.
 *
 * A naive `wanted`-minus-`published` retracts every one of those. Combined with a
 * content-derived key that used to tombstone, that made the loss irreversible, and the
 * shared registry converged not to last-write-wins but to the **intersection** of the
 * machines' edges.
 *
 * The rule is the mirror image of adoption's own, and it keys on IDENTITY: **an edge is
 * retractable only when, for both of its endpoint slugs, the workspace this machine has
 * under that slug is the same repository the SERVICE has a registration for.** Then
 * absence is a statement this machine is entitled to make.
 *
 * Keying on the slug alone — which the first version did — grants edge-deletion authority
 * on a name match, and this module's header says exactly why that fails: *"slugs and
 * prefixes are NAMES, and names are exactly what two machines can independently disagree
 * about; the identity is the only thing that means the same thing on both."* Slugs come
 * from directory names, so two machines holding the same repositories match by default,
 * and a machine that had cloned both but never applied an adopt destroyed the other's
 * edge on its first publish.
 *
 * Anything this machine has no standing on is left exactly as published and REPORTED in
 * {@link RegistryDiff.retained}, because a person who expected a removal to propagate
 * needs to know it did not. See {@link edgeStanding}.
 */
export function diffRegistry(
  local: HubRegistryPayload,
  published: Map<string, PublishedState>,
  /**
   * Identities held by more than one local row. Parked rather than published.
   *
   * Two rows sharing a `repositoryId` are ONE entity on the wire, so publishing both
   * emits two operations on one entity and the published slug flips between them on every
   * pass — `published: 1, upToDate: false` for ever, appending an operation to a paid log
   * each time. Hub migration 003 asks for exactly this handling: a non-null duplicate is
   * *"a real problem, but it is a problem to REPORT"*. And it is not always a problem —
   * two clones or two `git worktree` checkouts of one repository legitimately share an
   * identity — so the honest move is to publish neither and name both, rather than pick
   * one and be silently wrong half the time.
   */
  duplicateIdentities: readonly { repositoryId: string; slugs: readonly string[] }[] = [],
): RegistryDiff {
  assertFormat(local.format);
  const duplicated = new Map(duplicateIdentities.map((d) => [d.repositoryId, d.slugs]));

  const operations: RegistryOperation[] = [];
  const unpublishable: UnpublishableEntry[] = [];
  const retained: RetainedEdge[] = [];

  for (const entry of local.workspaces) {
    if (entry.repositoryId === null) {
      unpublishable.push({
        entry,
        reason:
          `"${entry.slug}" has no sync identity recorded against it, so there is no key another ` +
          "machine could recognise it by. It is left out of the published registry rather than " +
          "given an id here: an id minted on this machine would not be the one the repository " +
          "itself records later, and the registry would then hold two rows for one workspace. " +
          "Staple records the identity the next time it OPENS that workspace, so run any command " +
          `against it — \`staple ls --ws ${entry.slug}\` is enough — and publish again. If that ` +
          "does not fix it, either the workspace's database is not on this machine or its " +
          "`.staple/repository.json` is present and unreadable; publish reports which.",
      });
      continue;
    }

    /**
     * An identity two local rows share is parked, not published. See the parameter.
     *
     * Checked BEFORE the payload is built, so nothing about a duplicated identity reaches
     * an operation — the flip-flop was the published slug changing on every pass.
     */
    const sharing = duplicated.get(entry.repositoryId);
    if (sharing !== undefined) {
      const others = sharing.filter((slug) => slug !== entry.slug).map((slug) => `"${slug}"`);
      unpublishable.push({
        entry,
        reason:
          `"${entry.slug}" shares the sync identity ${entry.repositoryId} with ` +
          `${others.join(", ")} on this machine, and one identity is one entry in the registry — ` +
          "publishing both would make the published name flip between them on every pass. Two " +
          "clones or two git worktrees of one repository legitimately share an identity, so " +
          "nothing was changed and nothing is wrong with either row. Unregister the ones you do " +
          "not want listed with `staple hub unregister`, and the survivor publishes next pass.",
      });
      continue;
    }

    const payload: RegistrationPayload = {
      format: REGISTRY_PAYLOAD_FORMAT,
      slug: entry.slug,
      prefix: entry.prefix,
      kind: entry.kind,
      addedAt: entry.addedAt,
    };
    const held = published.get(key(REGISTRATION_ENTITY, entry.repositoryId));
    if (held !== undefined && !held.deleted && statesAgree(held.state, payload)) continue;
    operations.push({
      entity: REGISTRATION_ENTITY,
      entityId: entry.repositoryId,
      // `create` when the service has never folded this entity, `update` otherwise.
      // The distinction is not cosmetic: `fold.ts` records per-field provenance for
      // every verb EXCEPT `create`, so calling a genuine first write an `update`
      // would claim somebody chose each of these values when they merely arrived.
      verb: held === undefined ? "create" : "update",
      baseVersion: held?.version ?? 0,
      payload,
    });
  }

  const wanted = new Map<string, CrossLinkPayload>();
  for (const link of local.crossLinks) {
    wanted.set(crossLinkEntityId(link), {
      format: REGISTRY_PAYLOAD_FORMAT,
      blockerWs: link.blockerWs,
      blockerIdentifier: link.blockerIdentifier,
      blockedWs: link.blockedWs,
      blockedIdentifier: link.blockedIdentifier,
      type: link.type,
      present: true,
    });
  }

  for (const [entityId, payload] of wanted) {
    const held = published.get(key(CROSS_LINK_ENTITY, entityId));
    /**
     * A tombstoned edge cannot be resurrected, and saying so beats looping.
     *
     * Nothing this module emits tombstones anything any more — retraction is
     * `present: false`. But a tombstone written by an EARLIER build is still in the log,
     * and `fold.ts` discards every operation on a tombstoned entity. Emitting an update
     * would be accepted, acknowledged and dropped, for ever, with the publish reporting
     * success every pass. Reported as unpublishable instead, with the only remedy there
     * is.
     */
    if (held !== undefined && held.deleted) {
      retained.push({
        entityId,
        reason:
          `The link ${payload.blockerIdentifier} -> ${payload.blockedIdentifier} was deleted ` +
          "from the published registry by an older build, and a deletion is final in the " +
          "operation log — re-publishing it would be accepted and then discarded. The link is " +
          "intact on this machine. Restoring the registry from a backup taken before the " +
          "deletion is the only way to bring it back to the shared set.",
      });
      continue;
    }
    if (held !== undefined && statesAgree(held.state, payload)) continue;
    operations.push({
      entity: CROSS_LINK_ENTITY,
      entityId,
      verb: held === undefined ? "create" : "update",
      baseVersion: held?.version ?? 0,
      payload,
    });
  }

  for (const held of published.values()) {
    if (held.entity !== CROSS_LINK_ENTITY) continue;
    if (held.deleted) continue;
    if (wanted.has(held.entityId)) continue;
    // Already retracted. Nothing to say.
    if (held.state.present === false) continue;

    /**
     * The floor, keyed on IDENTITY rather than on the slug.
     *
     * The first version tested `localSlugs.has(blockerWs) && localSlugs.has(blockedWs)`,
     * which granted edge-deletion authority on a NAME match — and this module's own header
     * is emphatic about why that is wrong: *"slugs and prefixes are NAMES, and names are
     * exactly what two machines can independently disagree about; the identity is the only
     * thing that means the same thing on both."* Slugs derive from directory names, so two
     * machines holding the same repositories match **by default**, and a machine that had
     * cloned both repositories but never applied an adopt would retract the other machine's
     * edge on its first publish. Reproduced.
     *
     * So the test is: for each endpoint slug, does the workspace THIS machine has under
     * that slug carry the same `repositoryId` as the published `registration` for it? Both
     * sides are already in hand — the local registry and the same snapshot this diff reads
     * — so it costs no new state and no round trip. If the answer is no for either end,
     * the machines are talking about different workspaces and this one has no standing.
     */
    const names = readEdgeNames(held);
    const standing = names === null ? null : edgeStanding(names, local, published);
    if (names === null || standing !== null) {
      retained.push({
        entityId: held.entityId,
        reason:
          `The published link ${names?.blockerIdentifier ?? held.entityId} -> ` +
          `${names?.blockedIdentifier ?? "?"} ${standing ?? "could not be read"}, so its ` +
          "absence here is not a statement that it was removed. Left exactly as published.",
      });
      continue;
    }

    operations.push({
      entity: CROSS_LINK_ENTITY,
      entityId: held.entityId,
      // An `update`, never a `delete`. See {@link CrossLinkPayload}.
      verb: "update",
      baseVersion: held.version,
      payload: {
        format: REGISTRY_PAYLOAD_FORMAT,
        blockerWs: names.blockerWs,
        blockerIdentifier: names.blockerIdentifier,
        blockedWs: names.blockedWs,
        blockedIdentifier: names.blockedIdentifier,
        type: "blocks",
        present: false,
      },
    });
  }

  return {
    operations,
    unpublishable,
    retained,
    upToDate: operations.length === 0,
  };
}

/**
 * May this machine retract this published edge? `null` means yes; a phrase means no.
 *
 * The phrase is returned rather than a boolean because the caller has to say WHY in a
 * sentence a person can act on, and "which end, and how it differs" is the whole content.
 *
 * For each endpoint slug: find the workspace this machine has under that slug, find the
 * `registration` the SERVICE holds for that slug, and require the identities to match. A
 * slug the local machine does not have at all, or one the service does not have a
 * registration for, is equally not this machine's to speak about.
 */
function edgeStanding(
  names: { blockerWs: string; blockedWs: string },
  local: HubRegistryPayload,
  published: Map<string, PublishedState>,
): string | null {
  const publishedIdentityFor = (slug: string): string | null => {
    for (const held of published.values()) {
      if (held.entity !== REGISTRATION_ENTITY) continue;
      if (held.deleted) continue;
      if (held.state.slug === slug) return held.entityId;
    }
    return null;
  };

  for (const [end, slug] of [
    ["blocker", names.blockerWs],
    ["blocked", names.blockedWs],
  ] as const) {
    const mine = local.workspaces.find((w) => w.slug === slug);
    if (mine === undefined) {
      return `names a ${end} workspace "${slug}" this machine does not have registered`;
    }
    if (mine.repositoryId === null) {
      return `names a ${end} workspace "${slug}" whose sync identity this machine has not recorded`;
    }
    const theirs = publishedIdentityFor(slug);
    if (theirs === null) {
      return `names a ${end} workspace "${slug}" the service has no registration for`;
    }
    if (theirs !== mine.repositoryId) {
      return (
        `names a ${end} workspace "${slug}" that is a DIFFERENT repository here (${mine.repositoryId}) ` +
        `from the one the service has under that name (${theirs}) — a slug is a name, and two ` +
        "machines can disagree about a name"
      );
    }
  }
  return null;
}

/**
 * The four names of a published edge, from its state with the key as the fallback.
 *
 * The key is an encoding of the names, so it can always answer — which matters for a row
 * whose payload a mixed-fleet fold left partial.
 */
function readEdgeNames(held: PublishedState): {
  blockerWs: string;
  blockerIdentifier: string;
  blockedWs: string;
  blockedIdentifier: string;
} | null {
  const fromId = parseCrossLinkEntityId(held.entityId);
  if (fromId === null) return null;
  return {
    blockerWs: strOr(held.state.blockerWs, fromId.blockerWs),
    blockerIdentifier: strOr(held.state.blockerIdentifier, fromId.blockerIdentifier),
    blockedWs: strOr(held.state.blockedWs, fromId.blockedWs),
    blockedIdentifier: strOr(held.state.blockedIdentifier, fromId.blockedIdentifier),
  };
}

/**
 * Does the service already hold this payload?
 *
 * Compares only the keys the payload carries, because that is what an operation
 * asserts: `fold.ts` is explicit that *"every verb here merges its payload's keys
 * over the state and is silent about every key it did not mention"*. A folded
 * state holding an extra key from a NEWER build is therefore not a disagreement,
 * and treating it as one would make an older machine re-publish on every pass,
 * for ever, deleting nothing and fixing nothing.
 */
function statesAgree(state: Record<string, unknown>, payload: object): boolean {
  for (const [field, value] of Object.entries(payload)) {
    if (state[field] !== value) return false;
  }
  return true;
}

/**
 * A folded snapshot, back to a registry.
 *
 * The inverse of {@link diffRegistry} over the two collections, and it has to be an
 * inverse rather than an approximation: this is what a restore feeds to
 * `adoptRegistry`, so a lossy read here would adopt a registry that is not the one
 * that was published — and a wrong registry is believed.
 *
 * `capturedAt` is supplied by the CALLER and is the moment this machine read the
 * service, not the moment the publishing machine exported. The service's fold has
 * no single capture time — it is a fold of a log written over days by possibly
 * several machines — and picking one operation's `createdAt` would name the newest
 * edit while claiming to describe the whole set. The honest available fact is when
 * it was read.
 *
 * A tombstoned entity is skipped, not surfaced. A deleted cross-link is an edge
 * that is not there, and there is no "absent edge" for a registry to express;
 * contrast a deleted ISSUE, which `fold.ts` returns precisely because a device
 * that already has it must be told to remove it. Nothing adopts edges it was not
 * given, so silence is the correct materialisation.
 */
export function registryFromSnapshot(args: {
  hubId: string;
  capturedAt: string;
  entities: readonly SnapshotEntityLike[];
}): HubRegistryPayload {
  const workspaces: RegistryEntry[] = [];
  const crossLinks: RegistryCrossLink[] = [];
  let format = REGISTRY_PAYLOAD_FORMAT;

  for (const entity of args.entities) {
    if (entity.deletedAt !== null) continue;
    const declared = entity.state.format;
    if (typeof declared === "number" && declared > format) format = declared;

    if (entity.entity === REGISTRATION_ENTITY) {
      workspaces.push({
        // The entity id IS the adoption key. Read from there rather than from the
        // payload, because the key is what the fold guarantees is stable and what
        // both machines agreed the entity was; a `repositoryId` field in the state
        // would be a second copy able to disagree with it.
        repositoryId: entity.entityId,
        slug: str(entity.state.slug),
        prefix: str(entity.state.prefix),
        kind: str(entity.state.kind),
        addedAt: str(entity.state.addedAt),
      });
      continue;
    }
    if (entity.entity !== CROSS_LINK_ENTITY) continue;

    /**
     * Read from the PAYLOAD, with the entity id as the fallback.
     *
     * The two are redundant by construction — the id is an encoding of these four
     * names — and the payload is preferred because it is what the publishing build
     * actually said. The fallback exists for a row whose payload a mixed-fleet fold
     * left partial, and it is derivable precisely because the encoding is injective.
     */
    /**
     * A retracted edge is not in the registry.
     *
     * `present === false` is the retraction; anything else — including the field being
     * absent, which is how every edge published before this field existed reads — is
     * present. Defaulting absence to PRESENT is the safe direction: an older payload
     * describes an edge somebody created, and dropping it would silently lose edges on
     * upgrade.
     */
    if (entity.state.present === false) continue;

    const fromId = parseCrossLinkEntityId(entity.entityId);
    if (fromId === null) continue;
    crossLinks.push({
      blockerWs: strOr(entity.state.blockerWs, fromId.blockerWs),
      blockerIdentifier: strOr(entity.state.blockerIdentifier, fromId.blockerIdentifier),
      blockedWs: strOr(entity.state.blockedWs, fromId.blockedWs),
      blockedIdentifier: strOr(entity.state.blockedIdentifier, fromId.blockedIdentifier),
      type: "blocks",
    });
  }

  // Refused AFTER the walk, on the maximum any operation declared, so the message
  // names the newest writer rather than the first one encountered.
  assertFormat(format);

  return {
    format: REGISTRY_PAYLOAD_FORMAT,
    hubId: args.hubId,
    capturedAt: args.capturedAt,
    workspaces,
    crossLinks,
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Split a batch so no push exceeds what the service advertised.
 *
 * Sized from `capabilities().maxBatchSize` — 25 on the free plan, 200 on paid —
 * and never from a constant here, for the reason `limits.ts` gives: *"the ceilings
 * differ by plan, and a client that hardcodes the paid number fails permanently on
 * the free one."* A machine with forty workspaces and a hundred edges is an
 * ordinary machine and must not be the one that discovers this.
 *
 * D1's 100-bound-parameter ceiling is not the binding constraint on this path and
 * is worth saying so explicitly, because it is the one that surprises people: the
 * Worker's push writes ONE prepared statement per operation, each binding fifteen
 * parameters, and the only statement that binds a list at all passes it as a single
 * `json_each` parameter. So the ceiling that bites first is queries-per-invocation,
 * which is exactly what `maxBatchSize` already encodes.
 */
export function chunkOperations(
  operations: readonly RegistryOperation[],
  maxBatchSize: number,
): RegistryOperation[][] {
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new StapleError(
      "validation",
      `The service advertised a batch ceiling of ${maxBatchSize}, which is not a usable size. ` +
        "Nothing was sent.",
    );
  }
  const chunks: RegistryOperation[][] = [];
  for (let at = 0; at < operations.length; at += maxBatchSize) {
    chunks.push(operations.slice(at, at + maxBatchSize));
  }
  return chunks;
}
