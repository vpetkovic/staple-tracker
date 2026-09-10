/**
 * The hub registry as a portable set: what this machine knows about, in a form
 * another machine can adopt.
 *
 * Contract: `docs/sync.md`, "What never leaves the machine" — amended by this
 * module and only this far.
 *
 * ## What changed in the contract, and what did not
 *
 * `docs/sync.md` put the whole hub database on the never-leaves list for two
 * reasons: `workspaces.path` is an absolute filesystem path, and cross-repository
 * topology is not a repository's business. Both survive intact.
 *
 *   - **Paths still never leave.** {@link exportRegistry} has no path in its
 *     output type. They are not redacted late, in a serializer somebody could
 *     later "fix" — the field does not exist to be forgotten.
 *   - **Topology still does not ride in any repository's channel.** Nothing here
 *     is reachable from a workspace's sync or backup. The set travels under the
 *     hub's own identity and its own consent, or it does not travel.
 *
 * What genuinely changes is that the set CAN travel at all, and it is worth
 * being blunt about the disclosure that buys: a machine that publishes its
 * registry tells the service the names, prefixes and identities of every
 * workspace on it, and that they sit together. Until now the wire format could
 * not express that, and the invariant was free. It is no longer free, so it is
 * paid for the only honest way — a separate, explicit consent that no other
 * consent implies, and a sentence at the point of granting it that says exactly
 * what is about to be uploaded.
 *
 * ## Why the set is worth replicating even though the paths are not
 *
 * A new machine that knows the SET can tell you what you are missing. A new
 * machine that knows nothing cannot, and the recovery it forces is a person
 * remembering which repositories they had — which is the failure this feature
 * exists to remove.
 *
 * ## Adoption, not duplication
 *
 * Every decision here keys on `repositoryId`, the UUID from the tracked
 * `.staple/repository.json` that survives cloning. Slugs and prefixes are NAMES,
 * and names are exactly what two machines can independently disagree about; the
 * identity is the only thing that means the same thing on both.
 *
 * The rule the whole module obeys: **this machine's stamps win, and a
 * disagreement is reported rather than resolved.** A prefix is written into the
 * workspace database and into every identifier that database has ever emitted —
 * `QDE-42` is in commit messages, in comments and in agent handoffs that no
 * migration can reach. Renumbering to accommodate an incoming set would silently
 * invalidate every one of those references, so it is never done. The hub is
 * derived state; it does not get to overrule a stamp.
 */
import { StapleError, nowIso } from "../types.js";
import { parseIdentifier } from "../ids.js";
import type { Hub, WorkspaceEntry } from "../hub.js";
import { crossLinkEntityId } from "./cross-link-key.js";

/**
 * The payload format number.
 *
 * A payload declaring a higher number was written by a newer build and is
 * refused rather than best-effort parsed, for the same reason
 * `repo-identity.ts` refuses a manifest it cannot understand: guessing at a
 * format you do not know produces a registry that is subtly wrong, and a wrong
 * registry is worse than none because it is believed.
 */
export const REGISTRY_PAYLOAD_FORMAT = 1;

/** One workspace, reduced to what is true independently of any machine. */
export interface RegistryEntry {
  /** The adoption key. Null for a workspace that has never recorded one. */
  readonly repositoryId: string | null;
  readonly slug: string;
  readonly prefix: string;
  readonly kind: string;
  readonly addedAt: string;
}

/**
 * A cross-workspace edge.
 *
 * Its identity is the two `repositoryId`s and the two identifiers (see
 * `cross-link-key.ts`). The slugs are there for display. On a registry read from the
 * service they are the names the first machine to publish the link used, and they may
 * differ from this machine's.
 *
 * A null `repositoryId` means that end can't be identified. Either the local workspace
 * never recorded an identity, or the entity was published under slug names by a build
 * from before STA-287. Neither kind can be published or adopted, and both are reported.
 */
export interface RegistryCrossLink {
  readonly blockerRepositoryId: string | null;
  readonly blockerWs: string;
  readonly blockerIdentifier: string;
  readonly blockedRepositoryId: string | null;
  readonly blockedWs: string;
  readonly blockedIdentifier: string;
  readonly type: "blocks";
}

/**
 * The whole publishable registry.
 *
 * Note what has no field here: no path, no `lastSeenAt`, no `hub_events`, no
 * schema version. `lastSeenAt` is an observation this machine made about its own
 * filesystem and means nothing anywhere else. `hub_events` is level-triggered
 * and is re-derived from the edges on arrival. The schema version is omitted for
 * the reason `docs/sync.md` already gives for the workspace one: replicating it
 * lets an older build be told it is newer than it is.
 */
export interface HubRegistryPayload {
  readonly format: number;
  readonly hubId: string;
  readonly capturedAt: string;
  readonly workspaces: readonly RegistryEntry[];
  /** Links that are in the registry. */
  readonly crossLinks: readonly RegistryCrossLink[];
  /**
   * Links the registry holds as removed (`present: false`). Only set on a registry read
   * from the service, because adoption needs them to carry a removal made on another
   * machine to this one. A local export has none.
   */
  readonly retractedCrossLinks?: readonly RegistryCrossLink[];
}

/**
 * Everything a hub backup contains, said in the words a person needs.
 *
 * Kept next to the payload type on purpose. A user will reasonably assume that
 * "back up the hub" covers their work — it does not, because there is no issues
 * table in `hub.db` — and the place to prevent that assumption is the same file
 * that decides what goes in, so the two cannot drift.
 */
export const HUB_BACKUP_CONTENTS: readonly string[] = [
  "Which workspaces exist, and what each one is called: its slug, its identifier prefix and its kind.",
  "Each workspace's sync identity, where it has recorded one. This is what lets another machine recognise a workspace it already has instead of registering it twice.",
  "The cross-workspace links — which issue blocks which, across workspaces.",
];

export const HUB_BACKUP_EXCLUSIONS: readonly string[] = [
  "No tasks. A hub backup contains none of your issues, comments, documents or attachments — those live in each workspace and are backed up separately, per workspace.",
  "No filesystem paths. Where each workspace sits on this machine stays on this machine, and is worked out again on the machine that restores.",
  "No credentials, and no device identity.",
];

/**
 * The one sentence that has to appear wherever the publish consent is granted.
 *
 * Lives HERE, in the leaf, rather than beside the code that spends the consent. Three
 * surfaces need it — the CLI's grant screen, the settings page, and the refusal when it
 * is missing — and one of them is reached by a route the page POLLS. Declaring it in
 * `hub-registry-service.ts` would have put `client.ts`, the only `fetch` in the tree,
 * into the import graph of a polled read; declaring it twice would have been two copies
 * of the load-bearing sentence in the feature. This module imports `../types.js` and a
 * `Hub` type and nothing else, so every surface can reach it and none of them acquires
 * the transport by doing so.
 *
 * It is the same sentence as the module header above, and as `docs/sync.md`, verbatim.
 * A disclosure reworded per surface is a disclosure whose strongest wording is whichever
 * surface the person did not read.
 */
export const REGISTRY_DISCLOSURE =
  "a machine that publishes its registry tells the service the names, prefixes and " +
  "identities of every workspace on it, and that they sit together.";

/**
 * What replacing a registry identity does to whatever the old one named.
 *
 * Stated UNCONDITIONALLY wherever a previous id exists, and worded as a fact about the id
 * rather than a warning about an observable state — because the state is not observable.
 * `adoptRegistryIdentity` refuses when a connection record exists for the old id, but
 * `performDisconnect` deletes that record (its contract is to leave nothing behind), so
 * `connect -> publish -> disconnect -> adopt` passes the check and orphans the old
 * registry with no local evidence it ever existed. A surface that said "this may orphan a
 * registry" would be hedging about something it cannot check; this says what is true
 * either way, including that the operation is reversible.
 *
 * Exported as a constant, like the publish disclosure, so the CLI and the settings page
 * cannot word it two ways. `%s` is the previous id.
 */
export const HUB_IDENTITY_REPLACEMENT_NOTICE =
  "If anything was ever published under %s, that registry stays on the service and this " +
  "machine will no longer point at it. Nothing is deleted, and re-adopting %s brings it back.";

/** The notice with the previous id substituted. */
export function describeIdentityReplacement(previousHubId: string): string {
  return HUB_IDENTITY_REPLACEMENT_NOTICE.replaceAll("%s", previousHubId);
}

/** The one sentence that has to appear wherever a hub backup is offered. */
export const HUB_BACKUP_HEADLINE =
  "A hub backup contains your workspace list and the links between them. " +
  "It does not contain any tasks — each workspace is backed up separately.";

/**
 * The registry, ready to publish.
 *
 * Reads rows and edges and drops everything machine-local. Takes no options: a
 * "include paths" switch would be a footgun with a default, and there is no
 * caller that wants one.
 */
export function exportRegistry(hub: Hub): HubRegistryPayload {
  const rows = hub.list();
  const identityOf = new Map(rows.map((row) => [row.slug, row.repositoryId]));
  return {
    format: REGISTRY_PAYLOAD_FORMAT,
    hubId: hub.hubId(),
    capturedAt: nowIso(),
    workspaces: rows.map((entry) => ({
      repositoryId: entry.repositoryId,
      slug: entry.slug,
      prefix: entry.prefix,
      kind: entry.kind,
      addedAt: entry.addedAt,
    })),
    crossLinks: hub.listCrossLinks().map((link) => ({
      blockerRepositoryId: identityOf.get(link.blockerWs) ?? null,
      blockerWs: link.blockerWs,
      blockerIdentifier: link.blockerIdentifier,
      blockedRepositoryId: identityOf.get(link.blockedWs) ?? null,
      blockedWs: link.blockedWs,
      blockedIdentifier: link.blockedIdentifier,
      type: "blocks" as const,
    })),
  };
}

/** What adoption did with one incoming entry. */
export type AdoptionOutcome =
  /** A local row already holds this identity and already agrees. Nothing written. */
  | "current"
  /** A local row holds this identity under a different slug or kind. Reported; nothing written. */
  | "adopted"
  /**
   * Known, not here. A row with an identity, a name and no path.
   *
   * There used to be a `repointed` outcome between these two — "no row held it, but a
   * present workspace does" — reachable only by passing `adoptRegistry` a `locate`
   * callback, which no surface ever supplied. It is gone rather than left advertised,
   * because an outcome the product cannot produce is a promise to whoever reads the
   * type. Its two real cases both have verbs now: `reconcileRepositoryIds` runs before
   * every adoption and fills the identity in from the manifest, so a registered clone
   * matches as `current` or `adopted`; and a clone the hub does not know about lands
   * `absent`, whose sentence names `staple hub registry locate`.
   */
  | "absent"
  /** This machine asked not to have this one back. */
  | "declined"
  /** The prefix or slug is held locally by a DIFFERENT identity. */
  | "conflict"
  /** No identity, so nothing can be matched on. Left for a human. */
  | "unmatchable";

export interface AdoptionDecision {
  readonly entry: RegistryEntry;
  readonly outcome: AdoptionOutcome;
  /** A sentence, for every outcome. Never empty, never a code. */
  readonly reason: string;
  /** The local slug this resolved to, when it resolved to one. */
  readonly localSlug: string | null;
  /** Set for `conflict`: what already holds the name, and which name it is. */
  readonly conflict: {
    readonly field: "prefix" | "slug";
    readonly value: string;
    readonly heldBySlug: string;
    readonly heldByRepositoryId: string | null;
  } | null;
}

/** What adoption did with one link the registry holds, or holds as removed. */
export type CrossLinkOutcome =
  /** Linked here. On a preview: would be. */
  | "added"
  /** Already linked here. Nothing written. */
  | "current"
  /** Could not land here. The reason says why, and it is never a guess. */
  | "skipped"
  /** Another machine removed it from the registry, so it was removed here. On a preview: would be. */
  | "removed"
  /** This machine removed it, so adopting does not bring it back. */
  | "kept_removed"
  /** Removed from the registry, but re-linked here since and not yet published. Kept. */
  | "kept_linked";

export interface CrossLinkDecision {
  readonly link: RegistryCrossLink;
  readonly outcome: CrossLinkOutcome;
  /** A sentence, for every outcome. Never empty, never a code. */
  readonly reason: string;
}

export interface AdoptionReport {
  readonly hubId: string;
  readonly capturedAt: string;
  readonly decisions: readonly AdoptionDecision[];
  /** Counts of {@link crossLinkDecisions} by outcome. On a preview, what the apply would do. */
  readonly crossLinks: {
    readonly added: number;
    readonly skipped: number;
    readonly current: number;
    readonly removed: number;
    readonly keptRemoved: number;
    readonly keptLinked: number;
  };
  /**
   * One decision per link that concerns this machine: every link the registry holds, plus
   * every removed link this machine still has. A removed link that isn't here gets no line,
   * because nothing about it concerns this machine.
   */
  readonly crossLinkDecisions: readonly CrossLinkDecision[];
  /** True when nothing was written — a preview. */
  readonly dryRun: boolean;
}

export interface AdoptOptions {
  /** Preview by default. Nothing is written unless this is true. */
  apply?: boolean;
  /**
   * There was a `locate` callback here, and it is gone with the `repointed` outcome it
   * produced. Nothing ever supplied it — the comment on it said "injected in tests;
   * production passes the hub's own view", and production passed nothing. Finding a
   * workspace by `repositoryId` is a filesystem scan, which is `staple discover`'s job;
   * attaching one the operator has already found is `staple hub registry locate`, which
   * calls {@link locateAbsent} and checks the identity before it writes.
   */
}

function assertPayload(payload: HubRegistryPayload): void {
  if (payload.format > REGISTRY_PAYLOAD_FORMAT) {
    throw new StapleError(
      "validation",
      `This registry was written in format ${payload.format}, and this build understands ` +
        `${REGISTRY_PAYLOAD_FORMAT}. Upgrade staple on this machine rather than adopting it ` +
        "partially — a registry read with the wrong rules is believed, which is worse than not " +
        "having one.",
    );
  }
}

/**
 * Walk an incoming registry and decide what this machine should do with each
 * entry. Previews by default.
 *
 * Deliberately never deletes. A local row absent from the incoming set is left
 * exactly where it is — the incoming set is another machine's knowledge, not a
 * statement about what this machine should stop having. That asymmetry is the
 * whole answer to "a workspace unregistered on one machine must not vanish on
 * another": there is no code path here that removes anything, so it cannot.
 */
export function adoptRegistry(
  hub: Hub,
  payload: HubRegistryPayload,
  options: AdoptOptions = {},
): AdoptionReport {
  assertPayload(payload);
  const apply = options.apply === true;
  const declined = new Set(hub.listOptOuts().map((o) => o.repositoryId));
  const decisions: AdoptionDecision[] = [];

  for (const entry of payload.workspaces) {
    decisions.push(decide(hub, entry, declined, apply));
  }

  const crossLinkDecisions = adoptCrossLinks(hub, payload, decisions, apply);
  const count = (outcome: CrossLinkOutcome) =>
    crossLinkDecisions.filter((d) => d.outcome === outcome).length;

  return {
    hubId: payload.hubId,
    capturedAt: payload.capturedAt,
    decisions,
    crossLinks: {
      added: count("added"),
      skipped: count("skipped"),
      current: count("current"),
      removed: count("removed"),
      keptRemoved: count("kept_removed"),
      keptLinked: count("kept_linked"),
    },
    crossLinkDecisions,
    dryRun: !apply,
  };
}

/** One end of a link, resolved to the local workspace that holds it. */
type EndResolution =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The link half of adoption. Runs after the workspace decisions, so an apply sees the
 * rows they created.
 *
 * Each end is matched to a local workspace BY `repositoryId`, never by slug. That is
 * what lets a link cross between two machines that named the same repositories'
 * directories differently. Then the identifier's prefix has to be the prefix this
 * machine holds that repository under. A repository initialised independently on two
 * machines can get two prefixes, and then `ALP-3` names nothing here. This is a fact
 * about the data, so it is reported as the reason, never repaired: staple does not
 * renumber a prefix.
 *
 * Links ending in a workspace that did not land are skipped too. `crossBlockersOf`
 * reads a blocker it cannot resolve as BLOCKED, so importing one would wedge a live
 * issue with nothing to say why.
 */
function adoptCrossLinks(
  hub: Hub,
  payload: HubRegistryPayload,
  decisions: readonly AdoptionDecision[],
  apply: boolean,
): CrossLinkDecision[] {
  /**
   * Which local workspaces hold each identity, including, on a PREVIEW, the rows the
   * workspace decisions WOULD create. A preview that counted only the rows on disk
   * would call every link between two absent workspaces skipped while the apply imports
   * it, and the preview is the consent gate for the apply.
   */
  const holders = new Map<string, { slug: string; prefix: string }[]>();
  const hold = (repositoryId: string | null, slug: string, prefix: string) => {
    if (repositoryId === null) return;
    const list = holders.get(repositoryId) ?? [];
    if (!list.some((h) => h.slug === slug)) list.push({ slug, prefix });
    holders.set(repositoryId, list);
  };
  for (const row of hub.list()) hold(row.repositoryId, row.slug, row.prefix);
  if (!apply) {
    for (const d of decisions) {
      if (d.outcome === "absent") hold(d.entry.repositoryId, d.entry.slug, d.entry.prefix);
    }
  }
  const decisionFor = new Map(decisions.map((d) => [d.entry.repositoryId, d]));
  const changes = new Map(hub.listCrossLinkChanges().map((c) => [c.key, c]));
  const localLinks = new Set(
    hub.listCrossLinks().map((l) => `${l.blockerIdentifier} ${l.blockedIdentifier}`),
  );

  const resolveEnd = (
    side: "blocker" | "blocked",
    repositoryId: string,
    publishedSlug: string,
    identifier: string,
  ): EndResolution => {
    const candidates = holders.get(repositoryId) ?? [];
    if (candidates.length === 0) {
      const decision = decisionFor.get(repositoryId);
      return {
        ok: false,
        reason:
          `the ${side} end, "${publishedSlug}", is not on this machine's list` +
          (decision === undefined
            ? ", and the registry has no workspace entry for it."
            : ` (its workspace entry above: ${decision.outcome}).`),
      };
    }
    const prefix = parseIdentifier(identifier)?.prefix ?? null;
    const match = candidates.find((c) => c.prefix === prefix);
    if (match !== undefined) return { ok: true, slug: match.slug };
    const held = candidates.map((c) => `"${c.slug}" under prefix ${c.prefix}`).join(" and ");
    return {
      ok: false,
      reason:
        `this machine holds the ${side} end's repository as ${held}, and the link names ` +
        `${identifier}. The repository was initialised here separately and given a different ` +
        `prefix, so ${identifier} names no issue here. Staple never renumbers a prefix, so ` +
        "the link stays in the registry and does not land on this machine.",
    };
  };

  const out: CrossLinkDecision[] = [];
  const skip = (link: RegistryCrossLink, reason: string) =>
    out.push({
      link,
      outcome: "skipped",
      reason: `${link.blockerIdentifier} -> ${link.blockedIdentifier} was not linked here: ${reason}`,
    });

  for (const link of payload.crossLinks) {
    if (link.blockerRepositoryId === null || link.blockedRepositoryId === null) {
      skip(
        link,
        `it was published by an older build of staple under the workspace names ` +
          `"${link.blockerWs}" and "${link.blockedWs}". Names differ between machines, so this ` +
          "machine can't tell which workspaces they mean. The machine that has the link " +
          "publishes it again under the repositories' identities the next time it runs " +
          "`staple hub registry publish`.",
      );
      continue;
    }
    const blocker = resolveEnd("blocker", link.blockerRepositoryId, link.blockerWs, link.blockerIdentifier);
    const blocked = resolveEnd("blocked", link.blockedRepositoryId, link.blockedWs, link.blockedIdentifier);
    if (!blocker.ok || !blocked.ok) {
      skip(link, [blocker, blocked].flatMap((e) => (e.ok ? [] : [e.reason])).join(" Also, "));
      continue;
    }
    const label = `${link.blockerIdentifier} -> ${link.blockedIdentifier}`;
    if (localLinks.has(`${link.blockerIdentifier} ${link.blockedIdentifier}`)) {
      out.push({ link, outcome: "current", reason: `${label} is already linked here.` });
      continue;
    }
    const change = changes.get(
      crossLinkEntityId({
        blockerRepositoryId: link.blockerRepositoryId,
        blockerIdentifier: link.blockerIdentifier,
        blockedRepositoryId: link.blockedRepositoryId,
        blockedIdentifier: link.blockedIdentifier,
      }),
    );
    if (change !== undefined && !change.present) {
      out.push({
        link,
        outcome: "kept_removed",
        reason:
          `${label} was removed on this machine, so adopting did not bring it back. It is still ` +
          "linked in the registry, where another machine can see it. To take it back here, " +
          `run \`staple link ${link.blockerIdentifier} ${link.blockedIdentifier}\`.`,
      });
      continue;
    }
    /**
     * The apply's own checks run on a preview too, whenever both ends are already
     * registered here. An end the adoption has yet to create has no database on this
     * machine, so the apply can't check it either.
     */
    const endsRegistered =
      hub.findBySlug(blocker.slug) !== undefined && hub.findBySlug(blocked.slug) !== undefined;
    try {
      if (apply) hub.adoptCrossLink(link.blockerIdentifier, link.blockedIdentifier);
      else if (endsRegistered) hub.checkCrossLink(link.blockerIdentifier, link.blockedIdentifier);
    } catch (error) {
      skip(link, error instanceof Error ? error.message : String(error));
      continue;
    }
    out.push({
      link,
      outcome: "added",
      reason: apply ? `${label} was linked here.` : `${label} would be linked here.`,
    });
  }

  for (const link of payload.retractedCrossLinks ?? []) {
    if (link.blockerRepositoryId === null || link.blockedRepositoryId === null) continue;
    if (!localLinks.has(`${link.blockerIdentifier} ${link.blockedIdentifier}`)) continue;
    const blocker = resolveEnd("blocker", link.blockerRepositoryId, link.blockerWs, link.blockerIdentifier);
    const blocked = resolveEnd("blocked", link.blockedRepositoryId, link.blockedWs, link.blockedIdentifier);
    // The identifiers matched a local link, but the repositories did not. This isn't the same link.
    if (!blocker.ok || !blocked.ok) continue;
    const label = `${link.blockerIdentifier} -> ${link.blockedIdentifier}`;
    const change = changes.get(
      crossLinkEntityId({
        blockerRepositoryId: link.blockerRepositoryId,
        blockerIdentifier: link.blockerIdentifier,
        blockedRepositoryId: link.blockedRepositoryId,
        blockedIdentifier: link.blockedIdentifier,
      }),
    );
    if (change !== undefined && change.present && !change.published) {
      out.push({
        link,
        outcome: "kept_linked",
        reason:
          `${label} was removed from the registry, but it was linked again on this machine ` +
          "since and that has not been published yet. It was kept. `staple hub registry publish` " +
          "shares it again.",
      });
      continue;
    }
    if (apply) hub.dropRetractedCrossLink(link.blockerIdentifier, link.blockedIdentifier);
    out.push({
      link,
      outcome: "removed",
      reason:
        `${label} was removed from the registry on another machine, so it ` +
        `${apply ? "was" : "would be"} removed here too. To keep it, link it again with ` +
        `\`staple link ${link.blockerIdentifier} ${link.blockedIdentifier}\` and publish.`,
    });
  }
  return out;
}

/**
 * No `options` parameter, and that is the honest signature rather than a silenced one.
 *
 * It took `options: AdoptOptions` for exactly one read — `options.locate?.(…)` — and that
 * went with the `repointed` outcome. `AdoptOptions` now holds only `apply`, which this
 * already receives as its own argument, so the parameter depended on nothing.
 *
 * Removed rather than renamed to `_options`: an underscore would keep the signature saying
 * this function consults the caller's options when it does not, and this file has been
 * bitten repeatedly by that gap between what code says and what it does.
 */
function decide(
  hub: Hub,
  entry: RegistryEntry,
  declined: Set<string>,
  apply: boolean,
): AdoptionDecision {
  const base = { entry, localSlug: null, conflict: null } as const;

  if (entry.repositoryId === null) {
    return {
      ...base,
      outcome: "unmatchable",
      reason:
        `"${entry.slug}" has never recorded a sync identity, so there is nothing to recognise it ` +
        "by on this machine. It is listed, and it has to be located by hand.",
    };
  }

  /**
   * The LOCAL ROW IS ASKED FIRST, and an opt-out only speaks about an identity that is
   * genuinely absent (STA-283).
   *
   * This used to be the other way round, and the order was the bug. `registry_optouts`
   * records "this machine does not want that identity back", nothing ever cleared one,
   * and so a workspace that legitimately returned — same identity, row present, path
   * live — was declined for ever. Reproduced: after `prune` recorded a `"pruned"`
   * opt-out and the workspace was re-initialised, `adopt` still answered
   * `outcome=declined  reason="keep" was removed from this machine's list`, about a row
   * that was sitting in the hub.
   *
   * Two things made it worse than a wrong label. The `learned` branch below became
   * unreachable for those rows, so a name that differed from the registry's was never
   * reported for exactly the rows most likely to have one. And the state was
   * undiscoverable: `listOptOuts` had no CLI surface at all.
   *
   * Asking the hub first is the fix, not a workaround, because a registered row and an
   * opt-out for one identity are contradictory records of the same fact, and the row is
   * the one backed by a file on disk. `Hub.recordRepositoryId` now retires the opt-out at
   * the moment of binding; clearing it here as well repairs hubs that already hold the
   * contradiction, which every machine that has pruned since STA-283 does.
   */
  const held = hub.findByRepositoryId(entry.repositoryId);
  if (held) {
    const stale = declined.has(entry.repositoryId);
    if (stale && apply) hub.clearOptOut(entry.repositoryId);
    /**
     * Said out loud, because silently stepping over it is how it stayed invisible — and in
     * the TENSE that matches what actually happened.
     *
     * The clear is gated on `apply`; the sentence was not, so a preview claimed the
     * opt-out "was retired" while the count was unchanged and the report ended "Nothing was
     * written." Same defect class as the cross-link count two functions below, and the fix
     * for that one landed on its half of the sentence and not on this one.
     *
     * This is the read-repair path for every machine that has pruned since STA-283, so it
     * is a normal outcome rather than a corner.
     */
    const retired = !stale
      ? ""
      : apply
        ? " The earlier opt-out on this identity was retired: the workspace is registered here again."
        : " An earlier opt-out on this identity would be retired, because the workspace is registered here again.";
    const learned = held.slug !== entry.slug || held.kind !== entry.kind;
    if (!learned) {
      return {
        ...base,
        outcome: "current",
        localSlug: held.slug,
        reason:
          `"${held.slug}" is already registered here as the same workspace. Nothing to do.` +
          retired,
      };
    }
    return {
      ...base,
      outcome: "adopted",
      localSlug: held.slug,
      reason:
        `Already here as "${held.slug}"; the published list calls it "${entry.slug}". Matched by ` +
        "sync identity and left where it is — this machine's name and path are unchanged." +
        retired,
    };
  }

  if (declined.has(entry.repositoryId)) {
    return {
      ...base,
      outcome: "declined",
      reason:
        `"${entry.slug}" was removed from this machine's list, so it was not brought back. It is ` +
        "still registered on the machine that published this. Undo it with " +
        `\`staple hub registry unignore ${entry.repositoryId}\` and adopt again, or leave it out ` +
        "by doing nothing.",
    };
  }

  // Nothing local holds the identity. The names are the last obstacle.
  const prefixHolder = hub.list().find((w) => w.prefix === entry.prefix);
  if (prefixHolder) {
    return {
      ...base,
      outcome: "conflict",
      conflict: {
        field: "prefix",
        value: entry.prefix,
        heldBySlug: prefixHolder.slug,
        heldByRepositoryId: prefixHolder.repositoryId,
      },
      /**
       * The remedy names two things a person can actually run.
       *
       * It used to say "Re-stamp one of them in its own repository, then adopt again",
       * and there is no re-stamp verb — deliberately, because the prefix is stamped into
       * every identifier ever written. So the sentence described an operation the product
       * does not have, which is worse than describing a hard choice honestly. These two
       * are the whole of what is possible, and both are reversible.
       */
      reason:
        `Prefix ${entry.prefix} is already held here by "${prefixHolder.slug}", which is a ` +
        `different workspace. "${entry.slug}" was not added, and neither one was renumbered: the ` +
        `prefix is stamped into its workspace database and into every ${entry.prefix}-N ever ` +
        "written, so renumbering either would break references no migration can reach. Two ways " +
        `out: keep what you have and leave the published one out for good with \`staple hub ` +
        `registry ignore ${entry.repositoryId}\`, or give up the local row with \`staple hub ` +
        `unregister ${prefixHolder.slug}\` and adopt again, which lands "${entry.slug}" under ` +
        `${entry.prefix}. \`staple hub registry status\` lists anything you have ignored.`,
    };
  }
  const slugHolder = hub.list().find((w) => w.slug === entry.slug);
  if (slugHolder) {
    return {
      ...base,
      outcome: "conflict",
      conflict: {
        field: "slug",
        value: entry.slug,
        heldBySlug: slugHolder.slug,
        heldByRepositoryId: slugHolder.repositoryId,
      },
      /**
       * "Rename one of them" named nothing that exists.
       *
       * There is no supported rename: `grep` finds no `UPDATE workspaces SET slug` in this
       * tree, the slug is written once by `initWorkspace`, and the stored slug then beats
       * the directory basename — so renaming the directory changes nothing either. Same
       * correction as the prefix conflict above, and the same two performable escapes.
       */
      reason:
        `The name "${entry.slug}" is already taken here by a different workspace, so the ` +
        "published one was not added, and nothing was renamed — staple has no rename verb, " +
        "because the name is stamped in the workspace itself. Two ways out: leave the " +
        `published one out for good with \`staple hub registry ignore ${entry.repositoryId}\`, ` +
        `or give up the local row with \`staple hub unregister ${slugHolder.slug}\` and adopt ` +
        "again.",
    };
  }

  if (apply) {
    hub.registerAbsent({
      slug: entry.slug,
      prefix: entry.prefix,
      kind: entry.kind,
      repositoryId: entry.repositoryId,
      addedAt: entry.addedAt,
    });
  }
  return {
    ...base,
    outcome: "absent",
    localSlug: entry.slug,
    /**
     * Both cases, each naming a verb that exists.
     *
     * This used to describe only the clone-it-again case. The other one — the workspace is
     * already on this machine, somewhere the hub does not know about — is the ordinary
     * state of a rebuilt box that restored some repositories by hand before adopting, and
     * the guidance for it was "point this row at it" with nothing to run. `locateAbsent`
     * had been the answer since the first commit of this epic and had no CLI verb until
     * `staple hub registry locate` was added for this sentence.
     *
     * ## The clause that used to end this sentence, and why it had to go
     *
     * It said *"the placeholder then goes with `staple hub unregister <slug>`"*. That was
     * true when it was written, because a clone-and-init used to leave the placeholder
     * beside the new row. It stopped being true in the same round that made `initWorkspace`
     * TAKE the placeholder over — after which there is no placeholder left to remove, and
     * following the sentence verbatim destroyed the row it had just attached:
     *
     *     $ staple hub unregister website --with-links
     *       removed cross-link WEB-1 blocks TRA-1
     *     $ staple hub ls
     *     TRA  tracker  repo  MISSING        # the row you just attached is gone
     *
     * It also freed the prefix and wrote an opt-out, so a later `adopt` reported `skipped`
     * until `unignore` — and produced the very contradiction this round added a refusal in
     * `ignore` to forbid, reached by following the product's own printed guidance rather
     * than by misusing a verb. Two halves of one sentence describing two different builds
     * is the failure mode this epic keeps finding; this is it in a single clause.
     */
    reason:
      `"${entry.slug}" is registered but its database is not on this machine. Nothing was ` +
      "invented for it. If you already have the workspace somewhere, attach it with " +
      `\`staple hub registry locate ${entry.slug} --path <directory>\` — the identity is checked, ` +
      "so a wrong directory is refused rather than silently attached. If you do not have it " +
      "yet, clone or copy it and run `staple init` in it: that takes this row over — same " +
      "name, same prefix, same identity — so there is nothing left to tidy up afterwards.",
  };
}

/**
 * Attach an absent row to a workspace the operator has found, refusing unless
 * the identities match.
 *
 * The refusal is the point. Locate exists precisely to be used when someone is
 * unsure where a workspace went, which is exactly when they are most likely to
 * offer the wrong directory — and stapling a registry row to the wrong
 * repository is silent, durable, and discovered later as two workspaces that
 * will not agree. Identity is checked because the operator cannot be expected to.
 */
export function locateAbsent(
  hub: Hub,
  slug: string,
  found: { path: string; prefix: string; repositoryId: string | null },
): WorkspaceEntry {
  const row = hub.get(slug);
  if (!row) {
    throw new StapleError("not_found", `No workspace "${slug}" is registered in the hub.`);
  }
  if (row.repositoryId === null) {
    throw new StapleError(
      "conflict",
      `"${slug}" has no recorded sync identity, so there is nothing to check a candidate against. ` +
        "Run `staple init` inside the workspace instead; that registers it from the workspace's " +
        "own stamp rather than from a guess made here.",
    );
  }
  if (found.repositoryId !== row.repositoryId) {
    throw new StapleError(
      "conflict",
      `That directory is a different repository. "${slug}" is registered with sync identity ` +
        `${row.repositoryId}, and the workspace you pointed at ` +
        (found.repositoryId === null
          ? "has not recorded one at all."
          : `calls itself ${found.repositoryId}.`) +
        " Nothing was changed. Pointing a registry row at the wrong repository is not something " +
        "that reports itself later.",
    );
  }
  if (found.prefix !== row.prefix) {
    throw new StapleError(
      "conflict",
      `"${slug}" is registered with prefix ${row.prefix}, and the workspace at that path is ` +
        `stamped ${found.prefix}. Staple will not renumber either one.`,
    );
  }
  hub.repointPath({ slug: row.slug, prefix: row.prefix, path: found.path, kind: row.kind });
  return hub.get(slug)!;
}

/** One-line count summary of an adoption, for a surface that shows one line. */
export function describeAdoption(report: AdoptionReport): string {
  const tally = new Map<AdoptionOutcome, number>();
  for (const d of report.decisions) tally.set(d.outcome, (tally.get(d.outcome) ?? 0) + 1);
  const say = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  const adopted = tally.get("adopted") ?? 0;
  if (adopted > 0) parts.push(`${say(adopted, "workspace")} matched to what is already here`);
  if (tally.get("current")) parts.push(`${tally.get("current")} already current`);
  if (tally.get("absent")) parts.push(`${say(tally.get("absent")!, "workspace")} listed but not on this machine`);
  if (tally.get("conflict")) parts.push(`${say(tally.get("conflict")!, "name conflict")} left alone`);
  if (tally.get("declined")) parts.push(`${tally.get("declined")} previously removed here`);
  if (tally.get("unmatchable")) parts.push(`${tally.get("unmatchable")} with no sync identity`);
  const head = parts.length === 0 ? "Nothing to adopt" : parts.join(", ");
  /**
   * "would be imported" on a PREVIEW, because "imported" there is a false statement.
   *
   * A dry run counts the edges it would add — `added += 1` without applying — so this
   * sentence used to read *"1 cross-workspace link imported. Nothing was written."*,
   * contradicting itself in eight words. Caught by reading a real preview against a real
   * Worker rather than by reading the code; the workspace half of the sentence describes
   * decisions and was always fine, and the edge half is the one that claimed an act.
   */
  const would = report.dryRun;
  const c = report.crossLinks;
  const linkParts: string[] = [];
  if (c.added > 0) linkParts.push(`${say(c.added, "cross-workspace link")} ${would ? "would be imported" : "imported"}`);
  if (c.removed > 0) {
    const also = would ? "would also be removed" : c.removed === 1 ? "was also removed" : "were also removed";
    linkParts.push(`${say(c.removed, "link")} removed on another machine ${also} here`);
  }
  if (c.current > 0) linkParts.push(`${say(c.current, "link")} already here`);
  if (c.keptRemoved > 0) linkParts.push(`${say(c.keptRemoved, "link")} kept removed, as this machine removed ${c.keptRemoved === 1 ? "it" : "them"}`);
  if (c.keptLinked > 0) linkParts.push(`${say(c.keptLinked, "link")} kept, as ${c.keptLinked === 1 ? "it was" : "they were"} linked again here since`);
  if (c.skipped > 0) linkParts.push(`${c.skipped} skipped`);
  const links = linkParts.length === 0 ? "" : ` ${linkParts.join(", ")}.`;
  return `${head}.${links}${would ? " Nothing was written." : ""}`;
}
