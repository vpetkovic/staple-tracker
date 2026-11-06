/**
 * TEMPORARY. Stands in for `src/core/cloud/share.ts` (the CLI lane's) to its agreed
 * signatures, until that file lands on the shared branch. Deleted then, and every import of
 * it pointed at the real module. Nothing else may import this file.
 */
import { listHubWorkspaces } from "../core/cloud/hub-scope.js";
import { readConnection } from "../core/cloud/connection.js";
import { isSharedWorkspace, readMembersCache } from "../core/cloud/members-cache.js";
import { buildShareLink, shareJoinCommand, type ShareLink } from "../core/cloud/share-link.js";
import { readWorkspaceManifest } from "../core/repo-identity.js";
import { StapleError } from "../core/types.js";

export interface ShareOffer {
  link: string;
  command: string;
  message: string;
  name: string;
  prefix: string | null;
  invitedAs: string | null;
  autoSyncMandatory: true;
}

export function createShareOffer(args: { home: string; dbPath: string; invitedAs?: string | null }): ShareOffer {
  const manifest = readWorkspaceManifest(args.dbPath);
  if (!manifest) throw new StapleError("not_found", "This workspace has no sync identity to share.");
  const connection = readConnection(args.home, manifest.repositoryId);
  if (!connection) throw new StapleError("not_found", "Connect this workspace before sharing it.");
  const row = listHubWorkspaces().find((workspace) => workspace.path === args.dbPath);
  const cache = readMembersCache(args.home, manifest.repositoryId);
  const self = cache?.members.find((member) => member.memberId === cache.self.memberId) ?? null;
  const name = row?.slug ?? "workspace";
  const prefix = row?.prefix ?? null;
  const invitedAs = args.invitedAs?.trim() || null;
  const link = buildShareLink({
    endpoint: connection.endpoint,
    repositoryId: manifest.repositoryId,
    name,
    prefix,
    sharedBy: self?.name ?? null,
    invitedAs,
  });
  const command = shareJoinCommand(link);
  return {
    link,
    command,
    message:
      `${self?.name ?? "I"} invited you to the shared Staple workspace ${name}.\n\n` +
      `Open: ${link}\nor run: ${command}\n\nYou'll see a short code. Read it to me and I'll approve it.`,
    name,
    prefix,
    invitedAs,
    autoSyncMandatory: true,
  };
}

export interface JoinTarget {
  dbPath: string;
  name: string;
  created: boolean;
  fromCheckout: boolean;
}

/** Shim: finds a registered workspace for the link's repository; creation awaits the real module. */
export function resolveJoinTarget(args: { home: string; cwd: string; link: ShareLink; create: boolean }): JoinTarget {
  const found = listHubWorkspaces().find((workspace) => workspace.repositoryId === args.link.repositoryId);
  if (found) return { dbPath: found.path, name: found.slug, created: false, fromCheckout: false };
  if (args.create) throw new StapleError("unavailable", "Creating a workspace from a link needs the CLI lane's share.ts.");
  return { dbPath: "", name: args.link.name, created: true, fromCheckout: false };
}

export function autoSyncLocked(home: string, repositoryId: string): boolean {
  return isSharedWorkspace(readMembersCache(home, repositoryId));
}
