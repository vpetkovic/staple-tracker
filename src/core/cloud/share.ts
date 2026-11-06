/**
 * Sharing a workspace by link, and the two local questions a link raises on the other side:
 * which workspace a join connects, and whether automatic sync may be switched off.
 *
 * Nothing here makes a network call. The link itself is `share-link.ts`'s; this module only
 * decides what goes in it and what a joining machine does with it. The people decisions —
 * sending a join request, approving it — stay where they were (`join.ts`, `members.ts`),
 * and none of this is an MCP tool.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stapleHome } from "../../config/home.js";
import { Hub, isAbsentRow } from "../hub.js";
import { currentDbPathFor } from "../path-migration.js";
import {
  REPOSITORY_MANIFEST_FILENAME,
  REPOSITORY_MANIFEST_FORMAT,
  readRepositoryManifest,
  readWorkspaceManifest,
  renderRepositoryManifest,
} from "../repo-identity.js";
import { StapleError } from "../types.js";
import { initWorkspace, slugify } from "../workspace.js";
import { readConnection } from "./connection.js";
import { isSharedWorkspace, readMembersCache, selfMember } from "./members-cache.js";
import { buildShareLink, shareJoinCommand, type ShareLink } from "./share-link.js";

// ------------------------------------------------------------------ sharing

export interface ShareOffer {
  /** The link, written by `buildShareLink`. */
  link: string;
  /** The command a teammate pastes: `staple cloud join '<link>'`. */
  command: string;
  /** Ready-to-send text: who invites, the workspace, the link, the command, and what happens next. */
  message: string;
  /** The workspace's name as shared: this machine's hub slug. The joiner sees the same. */
  name: string;
  prefix: string | null;
  invitedAs: string | null;
  /** Sharing means every device syncs automatically once someone joins. */
  autoSyncMandatory: true;
}

/**
 * The link for this workspace, and everything that goes with it. Requires a connected
 * workspace whose service supports members, which this machine knows from having a member
 * list (written by a connect, a sync or `cloud members` against a service that has them).
 * Makes no network call.
 */
export function createShareOffer(args: { home: string; dbPath: string; invitedAs?: string | null }): ShareOffer {
  const manifest = readWorkspaceManifest(args.dbPath, args.home);
  if (!manifest) {
    throw new StapleError(
      "validation",
      "This workspace has no repository identity yet, so there is nothing to share. Run `staple init` in it first.",
    );
  }
  const connection = readConnection(args.home, manifest.repositoryId);
  if (!connection) {
    throw new StapleError(
      "validation",
      "This workspace is not connected to a sync service, so a teammate would have nothing to join. " +
        "Run `staple cloud connect` first.",
    );
  }
  if (connection.removed) {
    throw new StapleError(
      "forbidden",
      `This device was removed from the workspace by ${connection.removed.by}, so it cannot invite anyone.`,
    );
  }
  const cache = readMembersCache(args.home, manifest.repositoryId);
  if (cache === null) {
    throw new StapleError(
      "validation",
      "This machine does not have the workspace's member list yet, so it cannot tell whether the service " +
        "supports joining by approval. Run `staple cloud members` (or `staple cloud sync`), then share again.",
    );
  }
  const { slug, prefix } = workspaceNameOf(args.dbPath);
  const invitedAs = args.invitedAs?.trim() ? args.invitedAs.trim() : null;
  const sharedBy = selfMember(cache)?.name ?? null;
  const link = buildShareLink({
    endpoint: connection.endpoint,
    repositoryId: manifest.repositoryId,
    name: slug,
    prefix,
    sharedBy,
    invitedAs,
  });
  const command = shareJoinCommand(link);
  return {
    link,
    command,
    message: shareMessage({ name: slug, sharedBy, invitedAs, link, command }),
    name: slug,
    prefix,
    invitedAs,
    autoSyncMandatory: true,
  };
}

function shareMessage(args: { name: string; sharedBy: string | null; invitedAs: string | null; link: string; command: string }): string {
  return [
    `${args.invitedAs ? `Hi ${args.invitedAs}, ` : ""}${args.sharedBy ?? "I"} invited you to the Staple workspace "${args.name}".`,
    "",
    "Open this link to join:",
    args.link,
    "",
    "Or paste this into a terminal:",
    args.command,
    "",
    "You'll see a short code. Read it to me and I'll approve it. Once you're in, the workspace syncs automatically on both our machines.",
  ].join("\n");
}

/** The workspace's hub slug and prefix, as its own database records them. */
function workspaceNameOf(dbPath: string): { slug: string; prefix: string | null } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const read = (key: string) =>
      (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
    const slug = read("slug");
    if (!slug) throw new StapleError("validation", `The workspace at ${dbPath} has no name recorded.`);
    return { slug, prefix: read("prefix") };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ joining

export interface JoinTarget {
  /** The workspace the join will connect. */
  dbPath: string;
  /** The name the joiner will see: the link's name, suffixed only on a real collision. */
  name: string;
  /** True when a home-resident workspace was (or, before consent, would be) created for this link. */
  created: boolean;
  /** True when the current directory is a checkout of the same repository. */
  fromCheckout: boolean;
}

/**
 * Which workspace a share link joins on this machine. Local only, no network call.
 *
 * 1. A checkout of the same repository at or above `cwd` (its `.staple/repository.json`
 *    names the link's repository): that workspace.
 * 2. A workspace this machine's hub already holds for the repository: that one.
 * 3. Otherwise a home-resident workspace in the staple home, named after the link's `n`,
 *    adopting the link's repository id, so the joiner sees the owner's workspace name and
 *    not a local folder name. A suffix is added only when that name is taken by a
 *    different workspace. The identifier prefix arrives with the first sync.
 *
 * With `create: false` nothing is written, and `created` says whether a workspace WOULD be
 * created; that is what a consent preview shows. Creation happens only with `create: true`,
 * after the person agreed.
 */
export function resolveJoinTarget(args: { home: string; cwd: string; link: ShareLink; create: boolean }): JoinTarget {
  const home = resolve(args.home);
  if (home !== resolve(stapleHome())) {
    // The hub and `initWorkspace` read the staple home from the environment; a different
    // `home` here would resolve against one hub and create in another.
    throw new StapleError("validation", `resolveJoinTarget: home ${args.home} is not the staple home in effect (${stapleHome()}).`);
  }
  const { repositoryId } = args.link;

  // 1. A checkout of this repository.
  const checkout = checkoutOf(args.cwd, repositoryId);
  if (checkout !== null) {
    const created = !existsSync(checkout.dbPath);
    if (created && args.create) {
      const opened = initWorkspace({ dir: checkout.root });
      opened.store.db.close();
      return { dbPath: opened.dbPath, name: opened.store.slug, created: true, fromCheckout: true };
    }
    return { dbPath: checkout.dbPath, name: checkout.name, created, fromCheckout: true };
  }

  const hub = Hub.open();
  let name: string;
  let dbPath: string;
  try {
    // 2. A workspace this machine already has for the repository.
    const listed = hub.findByRepositoryId(repositoryId);
    if (listed && !isAbsentRow(listed) && existsSync(listed.path)) {
      return { dbPath: listed.path, name: listed.slug, created: false, fromCheckout: false };
    }
    // 3. A home-resident workspace named after the link. A row a registry adoption left
    //    for this repository (no database yet) keeps its name and prefix.
    name = listed ? listed.slug : freeSlug(hub, home, slugify(args.link.name), repositoryId);
    dbPath = join(home, "workspaces", `${name}.db`);
  } finally {
    hub.close();
  }

  const exists = existsSync(dbPath);
  if (!exists && args.create) {
    // The identity first, so `initWorkspace` adopts the link's repository id rather than
    // minting a new one: this workspace IS the shared one, on another machine.
    const identityDir = join(dirname(dbPath), name);
    mkdirSync(identityDir, { recursive: true });
    const manifestPath = join(identityDir, REPOSITORY_MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      writeFileSync(manifestPath, renderRepositoryManifest({ repositoryId, format: REPOSITORY_MANIFEST_FORMAT }), "utf8");
    }
    const opened = initWorkspace({ global: true, slug: name });
    opened.store.db.close();
    return { dbPath: opened.dbPath, name: opened.store.slug, created: true, fromCheckout: false };
  }
  return { dbPath, name, created: !exists, fromCheckout: false };
}

/** The checkout at or above `cwd` whose manifest names `repositoryId`, or null. */
function checkoutOf(cwd: string, repositoryId: string): { root: string; dbPath: string; name: string } | null {
  let dir = resolve(cwd);
  for (let hops = 0; hops < 64; hops += 1) {
    const stapleDir = join(dir, ".staple");
    if (existsSync(join(stapleDir, REPOSITORY_MANIFEST_FILENAME))) {
      let manifest: ReturnType<typeof readRepositoryManifest> = null;
      try {
        manifest = readRepositoryManifest(stapleDir);
      } catch {
        return null;
      }
      // The nearest checkout decides: inside another repository, a link for this one does
      // not reach past it to some parent directory.
      if (manifest?.repositoryId !== repositoryId) return null;
      const dbPath = currentDbPathFor(dir);
      return { root: dir, dbPath, name: existsSync(dbPath) ? (workspaceNameOf(dbPath).slug ?? slugify(dir)) : slugify(dir.split(/[\\/]/).pop() ?? "") };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** `wanted`, or `wanted-2`, `wanted-3`… when a different workspace already has the name. */
function freeSlug(hub: Hub, home: string, wanted: string, repositoryId: string): string {
  const taken = (slug: string): boolean => {
    const row = hub.list().find((entry) => entry.slug === slug);
    if (row) return row.repositoryId !== repositoryId;
    return existsSync(join(home, "workspaces", `${slug}.db`));
  };
  if (!taken(wanted)) return wanted;
  for (let n = 2; n < 1000; n += 1) {
    if (!taken(`${wanted}-${n}`)) return `${wanted}-${n}`;
  }
  throw new StapleError("conflict", `Every name from "${wanted}" to "${wanted}-999" is taken on this machine.`);
}

// ------------------------------------------------------------------ the shared lock

/** True when automatic sync is mandatory for this repository on this machine. Reads the members cache only. */
export function autoSyncLocked(home: string, repositoryId: string): boolean {
  return isSharedWorkspace(readMembersCache(home, repositoryId));
}

export { sharedLine, sharedStatus, type SharedStatus } from "./shared-status.js";
