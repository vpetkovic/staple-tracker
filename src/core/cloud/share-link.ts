/**
 * The share link: what an owner sends a teammate so they can join a shared workspace.
 *
 *   https://<sync service>/join/<repositoryId>?n=<name>&p=<prefix>&by=<owner>&as=<invitee>
 *
 * It carries no secret. Every field is either already public to anyone who can see the
 * repository (the service address, the repository id) or a hint a person reads (names).
 * Joining still needs a member to approve the code the joining device shows, so a link
 * that leaks admits nobody.
 *
 * The path is the sync service's own landing page, so the link opens in a browser and
 * explains how to join. `staple cloud join '<link>'` and the web UI's `?join=<link>`
 * read the same string with {@link parseShareLink}.
 */
import { isRepositoryId } from "../repo-identity.js";
import { StapleError } from "../types.js";
import { parseEndpoint } from "./endpoint.js";

export interface ShareLink {
  /** The sync service's origin, no trailing slash. */
  readonly endpoint: string;
  readonly repositoryId: string;
  /** The workspace's name as the owner sees it (their hub slug). Shown, and used as the joiner's workspace name. */
  readonly name: string;
  /** The identifier prefix, e.g. `AII`. Shown only; the prefix itself arrives by sync. Null when unknown. */
  readonly prefix: string | null;
  /** Who shared it, as a member name. Shown only. Null when not given. */
  readonly sharedBy: string | null;
  /** The name the owner meant for the joiner. Shown, and prefilled at approval. Null when not given. */
  readonly invitedAs: string | null;
}

/** The longest name a link carries, for a workspace name or a member name. */
export const SHARE_LINK_NAME_MAX = 64;

const SLUG_SAFE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const PREFIX_SAFE = /^[A-Z][A-Z0-9]{0,9}$/;

export function buildShareLink(link: ShareLink): string {
  const endpoint = parseEndpoint(link.endpoint);
  if (!isRepositoryId(link.repositoryId)) {
    throw new StapleError("validation", "A share link needs this workspace's repository id.");
  }
  const url = new URL(`${endpoint.origin}/join/${link.repositoryId}`);
  url.searchParams.set("n", cleanName(link.name, "workspace name"));
  if (link.prefix !== null) url.searchParams.set("p", cleanPrefix(link.prefix));
  if (link.sharedBy !== null) url.searchParams.set("by", cleanName(link.sharedBy, "owner name"));
  if (link.invitedAs !== null) url.searchParams.set("as", cleanName(link.invitedAs, "teammate name"));
  return url.toString();
}

/**
 * Read a share link, or refuse with a sentence a person can act on.
 *
 * Strict on purpose: the endpoint is where this machine will send a join request after
 * consent, so anything that is not exactly the shape {@link buildShareLink} writes is
 * refused rather than guessed at.
 */
export function parseShareLink(raw: string): ShareLink {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new StapleError("validation", "That is not a share link. Ask whoever shared the workspace to copy it again.");
  }
  const endpoint = parseEndpoint(url.origin);
  const match = /^\/join\/([^/]+)\/?$/.exec(url.pathname);
  const repositoryId = match?.[1]?.toLowerCase();
  if (repositoryId === undefined || !isRepositoryId(repositoryId)) {
    throw new StapleError("validation", "That link does not name a workspace. A share link looks like https://<service>/join/<id>?n=<name>.");
  }
  const name = url.searchParams.get("n");
  if (name === null || name.trim().length === 0) {
    throw new StapleError("validation", "That share link has no workspace name. Ask whoever shared it to copy it again.");
  }
  const prefix = url.searchParams.get("p");
  const sharedBy = url.searchParams.get("by");
  const invitedAs = url.searchParams.get("as");
  return {
    endpoint: endpoint.origin,
    repositoryId,
    name: cleanName(name, "workspace name"),
    prefix: prefix === null || prefix.length === 0 ? null : cleanPrefix(prefix),
    sharedBy: sharedBy === null || sharedBy.length === 0 ? null : cleanName(sharedBy, "owner name"),
    invitedAs: invitedAs === null || invitedAs.length === 0 ? null : cleanName(invitedAs, "teammate name"),
  };
}

/** True when `raw` looks like a share link rather than a bare endpoint, so `join` can accept either. */
export function looksLikeShareLink(raw: string): boolean {
  try {
    return /^\/join\/[^/]+\/?$/.test(new URL(raw.trim()).pathname);
  } catch {
    return false;
  }
}

/** The command a teammate pastes into a terminal. Single-quoted for POSIX shells. */
export function shareJoinCommand(link: string): string {
  return `staple cloud join '${link.replace(/'/g, "'\\''")}'`;
}

function cleanName(value: string, what: string): string {
  const name = value.normalize("NFKC").trim();
  if (name.length === 0 || name.length > SHARE_LINK_NAME_MAX || !SLUG_SAFE.test(name)) {
    throw new StapleError(
      "validation",
      `The ${what} "${value}" can't go in a share link: use letters, digits, spaces, dots, dashes or underscores, up to ${SHARE_LINK_NAME_MAX} characters.`,
    );
  }
  return name;
}

function cleanPrefix(value: string): string {
  const prefix = value.trim().toUpperCase();
  if (!PREFIX_SAFE.test(prefix)) {
    throw new StapleError("validation", `"${value}" is not an identifier prefix.`);
  }
  return prefix;
}
