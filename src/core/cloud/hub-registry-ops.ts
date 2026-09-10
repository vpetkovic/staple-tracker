/**
 * The registry as operations, and operations back as a registry.
 *
 * Contract: `docs/sync.md`, "The hub registry is a set, not a map" and "Protocol
 * evolution". Sibling of {@link ./hub-registry.js}, which owns the payload type
 * and the adoption rules. This file owns only the translation to and from the
 * wire. It knows nothing about hubs, databases or networks.
 *
 * ## Why the hub becomes a repository rather than growing a storage concept
 *
 * The service is repository-scoped end to end. `worker/src/auth.ts` resolves a
 * token to exactly one `repo_id` and binds it into every subsequent statement, so
 * "cross-repository access is structurally impossible rather than merely
 * checked". A backup is a fold of one repository's operation log
 * (`worker/src/fold.ts`), and a restore materialises that fold into a new epoch of
 * that same log. There is no second storage shape to reach for and no route that
 * takes a blob.
 *
 * So the hub is a repository, scoped by `hub.hubId()`, and its operation log carries
 * the registry. Then **backup is the existing fold and restore is the existing
 * snapshot**, and the registry adds no persistence mechanism to the service.
 *
 * ## Publishing is a union
 *
 * Any number of machines can publish one registry, and they converge on the same set,
 * because no publish can destroy data another machine owns (STA-287):
 *
 *   - **Registration names are create-only.** `slug`, `prefix`, `kind` and `addedAt` go
 *     out only on the `create`. The product has no rename operation: nothing in `src`
 *     updates `workspaces.slug`, and a workspace's stored slug beats its directory name.
 *     So names diverge only when two machines choose different directory names at
 *     `staple init`, and first-writer-wins is the right resolution. A difference is
 *     reported in {@link RegistryDiff.renamed}. It is never sent.
 *   - **A registration is never deleted.** `staple hub unregister` is local by contract.
 *   - **A cross-link is retracted only by the machine that removed it.** The removal
 *     is recorded in `cross_link_changes` (hub migration 004). A machine that merely
 *     lacks a link never retracts it, and a machine still holding a link another
 *     machine retracted never puts it back unless it linked it again itself.
 *
 * Whatever the service holds that this machine lacks is left alone and reported in
 * {@link RegistryDiff.unadopted}. A machine that is behind can therefore publish
 * safely, and `staple hub registry adopt` takes the rest on.
 *
 * ## Two entities, and why the pair rather than one
 *
 * `registration` keyed by `repositoryId`, `crossLink` keyed by its portable identity.
 * They are separate entities because they have different keys and different
 * lifecycles, and the fold is per entity: one blob entity holding the whole
 * registry would make every publish rewrite every workspace. The fold is
 * last-write-wins per entity, so the granularity of the entity IS the granularity
 * of the conflict.
 *
 * ## An entry with no `repositoryId` is not publishable
 *
 * `RegistryEntry.repositoryId` is nullable, because a workspace that has never
 * recorded a `.staple/repository.json` has no identity yet. Such an entry has no
 * adoption key, and the entity id has to BE the adoption key. Minting one here is the
 * silent fork `repo-identity.ts` exists to prevent. So the entry is reported by name
 * and not sent, and so is every link with an end in it.
 *
 * ## What cannot be in an emitted operation
 *
 * A path. Not by redaction: {@link RegistrationPayload} is a closed interface
 * with no path field, so emitting one is a compile error rather than a review
 * finding. `test/cloud-hub-registry-wire.test.ts` pins both halves, the exact key set
 * of every payload, and that a real hub's absolute `workspaces.path` appears nowhere
 * in the serialized batch.
 */
import { StapleError } from "../types.js";
import type { CrossLinkChange } from "../hub.js";
import {
  REGISTRY_PAYLOAD_FORMAT,
  type HubRegistryPayload,
  type RegistryCrossLink,
  type RegistryEntry,
} from "./hub-registry.js";
import {
  crossLinkEntityId,
  parseCrossLinkEntityId,
  parseLegacyCrossLinkEntityId,
} from "./cross-link-key.js";

export { crossLinkEntityId, parseCrossLinkEntityId };

/** The two entity names this module emits. Mirrored in `worker/src/envelope.ts`. */
export const REGISTRATION_ENTITY = "registration";
export const CROSS_LINK_ENTITY = "crossLink";

/**
 * The protocol version the two entities require.
 *
 * A wire widening, declared rather than assumed: `apply.ts` THROWS on an entity it does
 * not know, so an older device pulling one of these would stall its whole page. See
 * `worker/src/envelope.ts` and "Protocol evolution" in `docs/sync.md`.
 */
export const REGISTRY_PROTOCOL = 2;

/**
 * One workspace, as a `registration` payload. Sent only on the `create`.
 *
 * A CLOSED interface. There is no `path`, no `lastSeenAt` and no index signature, so a
 * later edit cannot add a filesystem path without the compiler refusing it.
 *
 * `format` rides on every payload rather than being stated once for the log, because
 * ops from different builds interleave in one log. A reader takes the maximum and
 * refuses on it.
 */
export interface RegistrationPayload {
  readonly format: number;
  readonly slug: string;
  readonly prefix: string;
  readonly kind: string;
  readonly addedAt: string;
}

/**
 * One edge, as the `crossLink` payload of its `create`. Also closed.
 *
 * The slugs are for display. The entity id carries the identity, so two machines that
 * name a workspace differently are still talking about the same edge. Like a
 * registration's names, they are sent once and never updated.
 *
 * ## `present` is a FIELD, because a tombstone can't be undone
 *
 * The fold's tombstone is final: `fold.ts` discards every later operation on a
 * tombstoned entity. A cross-link's id is derived from its content, so "remove a
 * blocker, then put it back" would land on the tombstone and be dropped. So retraction
 * is `present: false`, and linking again is an update back to `present: true`, which
 * the fold's plain merge handles. **This wire emits no `delete`, ever, for either
 * entity**, and `worker/src/envelope.ts` refuses the verb for both.
 */
export interface CrossLinkPayload {
  readonly format: number;
  readonly blockerWs: string;
  readonly blockerIdentifier: string;
  readonly blockedWs: string;
  readonly blockedIdentifier: string;
  readonly type: "blocks";
  readonly present: true;
}

/** The only update this wire sends: a link retracted or linked again. */
export interface CrossLinkPresencePayload {
  readonly format: number;
  readonly present: boolean;
}

/** One operation to publish. The envelope's other fields are the caller's business. */
export interface RegistryOperation {
  readonly entity: typeof REGISTRATION_ENTITY | typeof CROSS_LINK_ENTITY;
  readonly entityId: string;
  /** Never `delete`. See {@link CrossLinkPayload}. */
  readonly verb: "create" | "update";
  /**
   * The folded entity version this operation moves off, 0 for a `create`.
   *
   * Part of the operation's IDENTITY: `hub-registry-service.ts` derives the `opId` from
   * it, which is what stops a link retracted and re-linked from colliding with its own
   * earlier appearance. See that module's `operationId`.
   */
  readonly baseVersion: number;
  readonly payload: RegistrationPayload | CrossLinkPayload | CrossLinkPresencePayload;
}

/**
 * What the service currently holds, as a reader of `GET /snapshot` sees it.
 *
 * Keyed by `${entity} ${entityId}`, which is the same composite the Worker's
 * `entityKey` uses.
 */
export interface PublishedState {
  readonly entity: string;
  readonly entityId: string;
  readonly state: Record<string, unknown>;
  readonly deleted: boolean;
  /** Operations folded into this entity. Monotonic, which makes an opId unique over time. */
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
 * Refuse a payload written in a format this build does not understand.
 *
 * *"Guessing at a format you do not know produces a registry that is subtly wrong, and
 * a wrong registry is worse than none because it is believed."*
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

/** A local link that cannot be published, and the sentence saying why. */
export interface UnpublishableLink {
  readonly link: RegistryCrossLink;
  readonly reason: string;
}

/** A published entity this publish left exactly as it is, and why. */
export interface RetainedEdge {
  readonly entityId: string;
  readonly reason: string;
}

/** A link, named the way a person reads it. */
export interface LinkRef {
  readonly entityId: string;
  readonly blockerIdentifier: string;
  readonly blockedIdentifier: string;
}

/**
 * One workspace this machine calls by a different name from the registry.
 *
 * Informational: nothing is sent. The registry keeps the name its first writer chose.
 */
export interface RenamedEntry {
  /** The `repositoryId`. The identity is shared, and only the name differs. */
  readonly entityId: string;
  /** This machine's slug. */
  readonly local: string;
  /** The registry's slug. Equal to {@link local} when only the prefix or kind differs. */
  readonly published: string;
  /** Present, with {@link publishedPrefix}, only when the two prefixes differ. */
  readonly localPrefix?: string;
  readonly publishedPrefix?: string;
  /** Present, with {@link publishedKind}, only when the two kinds differ. */
  readonly localKind?: string;
  readonly publishedKind?: string;
}

export interface RegistryDiff {
  /** In log order: registrations first, then cross-links. Never a `delete`. */
  readonly operations: readonly RegistryOperation[];
  /** Entries with no usable `repositoryId`. Reported, never invented. */
  readonly unpublishable: readonly UnpublishableEntry[];
  /** Local links with an end in an unpublishable entry. */
  readonly unpublishableLinks: readonly UnpublishableLink[];
  /** Published entities left as they are, each with its reason. */
  readonly retained: readonly RetainedEdge[];
  /** Links this publish retracts: removed on this machine, still present on the service. */
  readonly retracted: readonly LinkRef[];
  /** Links this publish puts back: retracted on the service, linked again on this machine. */
  readonly relinked: readonly LinkRef[];
  /** Workspaces this machine names differently from the registry. Nothing is sent for them. */
  readonly renamed: readonly RenamedEntry[];
  /**
   * What the service holds and this machine does not have. Left untouched. It is what
   * `staple hub registry adopt` would take on.
   *
   * An identity this machine unregistered (`registry_optouts`) is not counted, and nor is
   * a link this machine removed itself. Both absences are this machine's own decision.
   */
  readonly unadopted: {
    readonly registrations: readonly { entityId: string; slug: string }[];
    readonly crossLinks: readonly LinkRef[];
  };
  /**
   * This machine's recorded link changes that the service will agree with once
   * {@link operations} land, or already agrees with. `publishRegistry` settles them
   * after a successful push. See `Hub.settleCrossLinkChanges`.
   */
  readonly settled: readonly CrossLinkChange[];
  /**
   * True when no operation is needed.
   *
   * NOT the same as "nothing to report". `renamed`, `retained` and `unadopted` are
   * routinely non-empty while this is `true`.
   */
  readonly upToDate: boolean;
}

/** Local context the diff needs beyond the two registries. */
export interface DiffContext {
  /**
   * Identities held by more than one local row. Parked rather than published.
   *
   * Two rows sharing a `repositoryId` are ONE entity on the wire, and two clones or two
   * `git worktree` checkouts of one repository legitimately share an identity. So
   * neither row is published and both are named, rather than one picked at random.
   */
  readonly duplicateIdentities?: readonly { repositoryId: string; slugs: readonly string[] }[];
  /** `registry_optouts`: identities this machine removed from its own list. */
  readonly optedOut?: readonly string[];
  /** `cross_link_changes`: this machine's own link changes. See hub migration 004. */
  readonly changes?: readonly CrossLinkChange[];
}

function refOf(entityId: string, link: { blockerIdentifier: string; blockedIdentifier: string }): LinkRef {
  return { entityId, blockerIdentifier: link.blockerIdentifier, blockedIdentifier: link.blockedIdentifier };
}

function isPresent(held: PublishedState): boolean {
  // Absent `present` reads as present: an edge published before the field existed.
  return !held.deleted && held.state.present !== false;
}

/**
 * The operations that make the service hold the union of what it has and what this
 * machine has, plus the retractions this machine is entitled to send.
 *
 * Derived from current state against the service's current fold, at push time.
 * The registry is small and re-derivable, so one `GET /snapshot` per publish is the
 * whole cost, and an interrupted publish re-run re-derives the same diff.
 */
export function diffRegistry(
  local: HubRegistryPayload,
  published: Map<string, PublishedState>,
  context: DiffContext = {},
): RegistryDiff {
  assertFormat(local.format);
  const duplicated = new Map(
    (context.duplicateIdentities ?? []).map((d) => [d.repositoryId, d.slugs]),
  );
  const optedOut = new Set(context.optedOut ?? []);
  const changes = new Map((context.changes ?? []).map((c) => [c.key, c]));

  const operations: RegistryOperation[] = [];
  const unpublishable: UnpublishableEntry[] = [];
  const unpublishableLinks: UnpublishableLink[] = [];
  const retained: RetainedEdge[] = [];
  const retracted: LinkRef[] = [];
  const relinked: LinkRef[] = [];
  const renamed: RenamedEntry[] = [];
  const settled: CrossLinkChange[] = [];

  /** Why an entry can't be published, or null when it can. Shared with the link loop. */
  const refusal = (entry: RegistryEntry): string | null => {
    if (entry.repositoryId === null) {
      return (
        `"${entry.slug}" has no sync identity recorded against it, so there is no key another ` +
        "machine could recognise it by. It is left out of the published registry rather than " +
        "given an id here: an id minted on this machine would not be the one the repository " +
        "itself records later, and the registry would then hold two rows for one workspace. " +
        /**
         * `staple init`, and ONLY that. Measured after clearing the column on a real
         * machine: `staple ls` and `staple ls --ws <slug>` both leave it null, and
         * re-running `staple init` restores it.
         */
        `Run \`staple init\` in that workspace's directory, then publish again — it records ` +
        "the identity and creates nothing new. If that does not fix it, either the " +
        "workspace's database is not on this machine, or its `.staple/repository.json` is " +
        "present and unreadable; publish reports which."
      );
    }
    const sharing = duplicated.get(entry.repositoryId);
    if (sharing !== undefined) {
      const others = sharing.filter((slug) => slug !== entry.slug).map((slug) => `"${slug}"`);
      return (
        `"${entry.slug}" shares the sync identity ${entry.repositoryId} with ` +
        `${others.join(", ")} on this machine, and one identity is one entry in the registry. ` +
        "Two clones or two git worktrees of one repository legitimately share an identity, so " +
        "nothing was changed and nothing is wrong with either row. Unregister the ones you do " +
        "not want listed with `staple hub unregister`, and the survivor publishes next pass."
      );
    }
    return null;
  };

  const bySlug = new Map(local.workspaces.map((w) => [w.slug, w]));

  for (const entry of local.workspaces) {
    const reason = refusal(entry);
    if (reason !== null || entry.repositoryId === null) {
      unpublishable.push({ entry, reason: reason ?? "" });
      continue;
    }
    const held = published.get(key(REGISTRATION_ENTITY, entry.repositoryId));

    if (held === undefined) {
      operations.push({
        entity: REGISTRATION_ENTITY,
        entityId: entry.repositoryId,
        // `create`: `fold.ts` records no per-field provenance for a create, which is honest
        // for a first write. Nobody chose these values over others.
        verb: "create",
        baseVersion: 0,
        payload: {
          format: REGISTRY_PAYLOAD_FORMAT,
          slug: entry.slug,
          prefix: entry.prefix,
          kind: entry.kind,
          addedAt: entry.addedAt,
        },
      });
      continue;
    }

    /**
     * A tombstoned registration is reported, not re-created for ever. Nothing emits a
     * registration `delete` and the Worker refuses the verb, so only a log written before
     * that rule can hold one, and a create on it would be accepted and then discarded.
     */
    if (held.deleted) {
      retained.push({
        entityId: entry.repositoryId,
        reason:
          `"${entry.slug}" was deleted from the published registry by an older build, and a ` +
          "deletion is final in the operation log — re-publishing it would be accepted and " +
          "then discarded. The workspace is intact here. Restoring from a backup taken before " +
          "the deletion is the only way to return it to the shared set.",
      });
      continue;
    }

    // Held: the names are create-only, so this is information and never an operation.
    const heldSlug = typeof held.state.slug === "string" ? held.state.slug : entry.slug;
    const heldPrefix = typeof held.state.prefix === "string" ? held.state.prefix : entry.prefix;
    const heldKind = typeof held.state.kind === "string" ? held.state.kind : entry.kind;
    if (heldSlug !== entry.slug || heldPrefix !== entry.prefix || heldKind !== entry.kind) {
      renamed.push({
        entityId: entry.repositoryId,
        local: entry.slug,
        published: heldSlug,
        ...(heldPrefix !== entry.prefix ? { localPrefix: entry.prefix, publishedPrefix: heldPrefix } : {}),
        ...(heldKind !== entry.kind ? { localKind: entry.kind, publishedKind: heldKind } : {}),
      });
    }
  }

  // ---- cross-links this machine has
  const wanted = new Set<string>();
  for (const link of local.crossLinks) {
    const ends = [bySlug.get(link.blockerWs), bySlug.get(link.blockedWs)];
    const blocked = ends.flatMap((end, index) => {
      const slug = index === 0 ? link.blockerWs : link.blockedWs;
      if (end === undefined) return [`"${slug}" is not registered on this machine`];
      const why = refusal(end);
      return why === null ? [] : [`"${slug}" can't be published (see its entry)`];
    });
    if (blocked.length > 0 || link.blockerRepositoryId === null || link.blockedRepositoryId === null) {
      unpublishableLinks.push({
        link,
        reason:
          `The link ${link.blockerIdentifier} -> ${link.blockedIdentifier} is identified by its two ` +
          "workspaces' sync identities, and " +
          (blocked.length > 0 ? blocked.join(" and ") : "one of them has none") +
          ". It is left out until both ends are publishable.",
      });
      continue;
    }
    const entityId = crossLinkEntityId({
      blockerRepositoryId: link.blockerRepositoryId,
      blockerIdentifier: link.blockerIdentifier,
      blockedRepositoryId: link.blockedRepositoryId,
      blockedIdentifier: link.blockedIdentifier,
    });
    if (wanted.has(entityId)) continue;
    wanted.add(entityId);
    const change = changes.get(entityId);
    const held = published.get(key(CROSS_LINK_ENTITY, entityId));

    if (held === undefined) {
      operations.push({
        entity: CROSS_LINK_ENTITY,
        entityId,
        verb: "create",
        baseVersion: 0,
        payload: {
          format: REGISTRY_PAYLOAD_FORMAT,
          blockerWs: link.blockerWs,
          blockerIdentifier: link.blockerIdentifier,
          blockedWs: link.blockedWs,
          blockedIdentifier: link.blockedIdentifier,
          type: link.type,
          present: true,
        },
      });
      if (change?.present) settled.push(change);
      continue;
    }
    /**
     * A tombstoned edge can't be resurrected. Only a log written before `present`
     * existed can hold one, and an update would be accepted and discarded for ever.
     */
    if (held.deleted) {
      retained.push({
        entityId,
        reason:
          `The link ${link.blockerIdentifier} -> ${link.blockedIdentifier} was deleted ` +
          "from the published registry by an older build, and a deletion is final in the " +
          "operation log — re-publishing it would be accepted and then discarded. The link is " +
          "intact on this machine. Restoring the registry from a backup taken before the " +
          "deletion is the only way to bring it back to the shared set.",
      });
      continue;
    }
    if (isPresent(held)) {
      if (change?.present) settled.push(change);
      continue;
    }
    /**
     * The service holds this link as RETRACTED, and this machine has it.
     *
     * Put it back only if this machine linked it again and hasn't published that yet.
     * Otherwise this copy is older than the retraction: it was adopted, or published
     * earlier, and then another machine removed it. Sending it again would undo someone
     * else's removal, and the two machines would take turns on every pass.
     */
    if (change?.present === true && !change.published) {
      operations.push({
        entity: CROSS_LINK_ENTITY,
        entityId,
        verb: "update",
        baseVersion: held.version,
        payload: { format: REGISTRY_PAYLOAD_FORMAT, present: true },
      });
      relinked.push(refOf(entityId, link));
      settled.push(change);
      continue;
    }
    retained.push({
      entityId,
      reason:
        `The link ${link.blockerIdentifier} -> ${link.blockedIdentifier} was removed from the ` +
        "published registry by another machine, and this machine still has it. Publishing " +
        "does not put it back, because that would undo someone else's removal. " +
        "`staple hub registry adopt --apply` removes it here. To keep it and share it again, " +
        `run \`staple link ${link.blockerIdentifier} ${link.blockedIdentifier}\` and publish.`,
    });
  }

  // ---- cross-links this machine removed, and (re)links whose link has since gone
  const localKeys = new Set(
    local.crossLinks.flatMap((l) =>
      l.blockerRepositoryId === null || l.blockedRepositoryId === null
        ? []
        : [
            crossLinkEntityId({
              blockerRepositoryId: l.blockerRepositoryId,
              blockerIdentifier: l.blockerIdentifier,
              blockedRepositoryId: l.blockedRepositoryId,
              blockedIdentifier: l.blockedIdentifier,
            }),
          ],
    ),
  );
  for (const change of changes.values()) {
    if (wanted.has(change.key)) continue;
    if (change.present) {
      /**
       * A (re)link whose link is no longer on this hub: `unregister --with-links` took it
       * without recording a removal. There is nothing left to share, so it is forgotten.
       * A link still here but held back (an end parked as a duplicate identity) keeps its
       * record for when it becomes publishable.
       */
      if (!localKeys.has(change.key)) settled.push(change);
      continue;
    }
    const held = published.get(key(CROSS_LINK_ENTITY, change.key));
    if (held === undefined || !isPresent(held)) {
      // Nothing on the service to retract, so the removal is already true there.
      if (!change.published) settled.push(change);
      continue;
    }
    if (!change.published) {
      operations.push({
        entity: CROSS_LINK_ENTITY,
        entityId: change.key,
        verb: "update",
        baseVersion: held.version,
        payload: { format: REGISTRY_PAYLOAD_FORMAT, present: false },
      });
      retracted.push(refOf(change.key, change));
      settled.push(change);
      continue;
    }
    /**
     * This machine's removal was published, and the service holds the link again:
     * another machine linked it since. That is newer than the removal, so it stands, and
     * this machine keeps its own copy removed.
     */
    retained.push({
      entityId: change.key,
      reason:
        `The link ${change.blockerIdentifier} -> ${change.blockedIdentifier} was removed on ` +
        "this machine and that was published, and another machine has linked it again since. " +
        "It stays linked in the registry and stays removed here. To take it back here, run " +
        `\`staple link ${change.blockerIdentifier} ${change.blockedIdentifier}\`.`,
    });
  }

  // ---- what the service holds and this machine doesn't
  const localIds = new Set(
    local.workspaces.map((w) => w.repositoryId).filter((id): id is string => id !== null),
  );
  const unadoptedRegistrations: { entityId: string; slug: string }[] = [];
  const unadoptedLinks: LinkRef[] = [];
  for (const held of published.values()) {
    if (held.deleted) continue;
    if (held.entity === REGISTRATION_ENTITY) {
      if (localIds.has(held.entityId) || optedOut.has(held.entityId)) continue;
      unadoptedRegistrations.push({
        entityId: held.entityId,
        slug: typeof held.state.slug === "string" ? held.state.slug : "(unnamed)",
      });
      continue;
    }
    // Links: present, in the key this build writes, not here, and not removed here.
    if (!isPresent(held) || wanted.has(held.entityId) || changes.has(held.entityId)) continue;
    const identity = parseCrossLinkEntityId(held.entityId);
    if (identity === null) continue;
    unadoptedLinks.push(refOf(held.entityId, identity));
  }

  return {
    operations,
    unpublishable,
    unpublishableLinks,
    retained,
    retracted,
    relinked,
    renamed,
    unadopted: { registrations: unadoptedRegistrations, crossLinks: unadoptedLinks },
    settled,
    upToDate: operations.length === 0,
  };
}

/**
 * A folded snapshot, back to a registry.
 *
 * The inverse of {@link diffRegistry} over the two collections: this is what a restore
 * and an adopt feed to `adoptRegistry`, so a lossy read here would adopt a registry
 * that is not the one that was published.
 *
 * `capturedAt` is supplied by the CALLER and is the moment this machine read the
 * service. The fold has no single capture time, because several machines wrote it.
 *
 * A tombstoned entity is skipped. A link with `present: false` goes to
 * `retractedCrossLinks`, which is how a removal made on one machine reaches another.
 * A link under the slug key an earlier build wrote lands in `crossLinks` with null
 * `repositoryId`s. Adoption can't place it and says so, but it is never dropped
 * silently and never an error.
 */
export function registryFromSnapshot(args: {
  hubId: string;
  capturedAt: string;
  entities: readonly SnapshotEntityLike[];
}): HubRegistryPayload {
  const workspaces: RegistryEntry[] = [];
  const crossLinks: RegistryCrossLink[] = [];
  const retractedCrossLinks: RegistryCrossLink[] = [];
  let format = REGISTRY_PAYLOAD_FORMAT;

  for (const entity of args.entities) {
    if (entity.deletedAt !== null) continue;
    const declared = entity.state.format;
    if (typeof declared === "number" && declared > format) format = declared;

    if (entity.entity === REGISTRATION_ENTITY) {
      workspaces.push({
        // The entity id IS the adoption key, and the fold guarantees it is stable.
        repositoryId: entity.entityId,
        slug: str(entity.state.slug),
        prefix: str(entity.state.prefix),
        kind: str(entity.state.kind),
        addedAt: str(entity.state.addedAt),
      });
      continue;
    }
    if (entity.entity !== CROSS_LINK_ENTITY) continue;

    const present = entity.state.present !== false;
    const identity = parseCrossLinkEntityId(entity.entityId);
    if (identity !== null) {
      // The identity is read from the KEY, which is what both machines agreed the entity is.
      (present ? crossLinks : retractedCrossLinks).push({
        blockerRepositoryId: identity.blockerRepositoryId,
        blockerWs: str(entity.state.blockerWs),
        blockerIdentifier: identity.blockerIdentifier,
        blockedRepositoryId: identity.blockedRepositoryId,
        blockedWs: str(entity.state.blockedWs),
        blockedIdentifier: identity.blockedIdentifier,
        type: "blocks",
      });
      continue;
    }
    const legacy = parseLegacyCrossLinkEntityId(entity.entityId);
    if (legacy === null || !present) continue;
    crossLinks.push({
      blockerRepositoryId: null,
      blockerWs: strOr(entity.state.blockerWs, legacy.blockerWs),
      blockerIdentifier: strOr(entity.state.blockerIdentifier, legacy.blockerIdentifier),
      blockedRepositoryId: null,
      blockedWs: strOr(entity.state.blockedWs, legacy.blockedWs),
      blockedIdentifier: strOr(entity.state.blockedIdentifier, legacy.blockedIdentifier),
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
    retractedCrossLinks,
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
