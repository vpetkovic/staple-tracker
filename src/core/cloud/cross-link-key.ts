/**
 * The portable identity of a cross-workspace link (STA-287).
 *
 * A link is identified by its two workspaces' `repositoryId`s and its two issue
 * identifiers. Slugs are left out on purpose. They come from directory names, so two
 * machines holding the same repositories under different directory names can disagree
 * about them. The identity from the tracked `.staple/repository.json` is the only thing
 * that means the same on both.
 *
 * This module has no imports. The hub (`hub.ts`, which records this machine's own link
 * changes against the key) and the wire (`hub-registry-ops.ts`) both need it, and
 * neither should pull the other in to get it.
 */

/** The portable identity of one link. */
export interface CrossLinkIdentity {
  readonly blockerRepositoryId: string;
  readonly blockerIdentifier: string;
  readonly blockedRepositoryId: string;
  readonly blockedIdentifier: string;
}

/**
 * The first component of every key this build writes.
 *
 * The earlier key (PR #94) was four percent-encoded SLUGS and identifiers joined by `/`.
 * This one has five components, so an old key can never parse as a new one, however its
 * slugs are spelled. `encodeURIComponent` escapes `/`, so the component count is exact.
 */
const SCHEME = "rid";

/**
 * `rid/<blockerRepositoryId>/<blockerIdentifier>/<blockedRepositoryId>/<blockedIdentifier>`,
 * each component percent-encoded.
 *
 * It's an encoding, not a hash: a human reading a log row can still read it, and it is
 * injective by construction. It is deterministic across machines because it is a pure
 * function of the four values.
 */
export function crossLinkEntityId(link: CrossLinkIdentity): string {
  return [
    SCHEME,
    ...[
      link.blockerRepositoryId,
      link.blockerIdentifier,
      link.blockedRepositoryId,
      link.blockedIdentifier,
    ].map(encodeURIComponent),
  ].join("/");
}

/**
 * Undo {@link crossLinkEntityId}. Null for anything that is not a key this build writes.
 *
 * That includes the slug-keyed ids an earlier build published. Those are not
 * errors: they are real entities in real service logs, and callers skip them by name
 * instead of crashing on them. See {@link parseLegacyCrossLinkEntityId}.
 */
export function parseCrossLinkEntityId(entityId: string): CrossLinkIdentity | null {
  const parts = entityId.split("/");
  if (parts.length !== 5 || parts[0] !== SCHEME) return null;
  const decoded = safeDecode(parts.slice(1));
  if (decoded === null || decoded.some((part) => part.length === 0)) return null;
  const [blockerRepositoryId, blockerIdentifier, blockedRepositoryId, blockedIdentifier] =
    decoded as [string, string, string, string];
  return { blockerRepositoryId, blockerIdentifier, blockedRepositoryId, blockedIdentifier };
}

/**
 * Read a slug-keyed id written before STA-287: `<blockerWs>/<blockerIdentifier>/<blockedWs>/<blockedIdentifier>`.
 *
 * Read only so the adopt report can name the link it skipped. Nothing writes this form.
 */
export function parseLegacyCrossLinkEntityId(entityId: string): {
  blockerWs: string;
  blockerIdentifier: string;
  blockedWs: string;
  blockedIdentifier: string;
} | null {
  const parts = entityId.split("/");
  if (parts.length !== 4) return null;
  const decoded = safeDecode(parts);
  if (decoded === null) return null;
  const [blockerWs, blockerIdentifier, blockedWs, blockedIdentifier] = decoded as [
    string,
    string,
    string,
    string,
  ];
  return { blockerWs, blockerIdentifier, blockedWs, blockedIdentifier };
}

/** `decodeURIComponent` throws on a malformed escape. A log row must never crash a reader. */
function safeDecode(parts: readonly string[]): string[] | null {
  try {
    return parts.map(decodeURIComponent);
  } catch {
    return null;
  }
}
