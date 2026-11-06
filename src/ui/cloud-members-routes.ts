/**
 * The local server's routes for members and joining: Settings → Members, the approval
 * toast and the join card. Each is a thin call into `core/cloud/{join-preview,join,members}`,
 * the same functions `staple cloud join|requests|approve|deny|members` run, so the page and
 * the terminal cannot disagree about what a join or an approval does.
 *
 * ## Which of these leave the machine
 *
 * Every POST here except `join/preview` and `join/cancel` contacts the sync service. All of
 * them are pinned to POST, sit behind the Origin check with the other cloud writes, and are
 * on `CLOUD_LIFECYCLE_WRITES` (none journals an operation). They are people decisions, so
 * none of them has an MCP tool.
 *
 * `join/preview` makes NO request: `join-preview.ts` cannot reach the client. It mints a
 * consent ticket exactly as `/api/cloud/workspace/connect/preview` does, and `join/start`
 * carries only that ticket, never an endpoint. So the page cannot send a join request to a
 * service it did not first show.
 *
 * `GET join/offer` is a local read of the committed manifest and the connection record, for
 * the empty-state card. It makes no request either.
 *
 * ## The request secret stays in this process
 *
 * A join in flight is a {@link JoinTicket}, which holds the 256-bit request secret. It lives
 * in this server's memory, keyed by a random id the page holds, and is never sent to the
 * page or written to disk. A server restart loses it, and the request expires unused on the
 * service: the safe failure, as in the CLI.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { stapleHome } from "../config/index.js";
import { readRepositoryManifest } from "../core/repo-identity.js";
import type { HubWorkspace } from "../core/cloud/hub-scope.js";
import type { ConsentTicketStore } from "../core/cloud/consent.js";
import { performRevoke } from "../core/cloud/connect.js";
import { readConnection } from "../core/cloud/connection.js";
import { cloudCodeOf, type PendingJoinRequest } from "../core/cloud/client.js";
import {
  buildJoinPreview,
  normalizeJoinCode,
  resolveJoinEndpoint,
  type JoinEndpointSource,
  type JoinPreview,
} from "../core/cloud/join-preview.js";
import { completeJoin, pollJoin, startJoin, type JoinTicket } from "../core/cloud/join.js";
import {
  approveRequest,
  denyRequest,
  listPendingRequests,
  refreshMembersCache,
  removeMember,
  renameMember,
} from "../core/cloud/members.js";
import { readMembersCache, type MembersCache } from "../core/cloud/members-cache.js";
import { StapleError } from "../core/types.js";
import { listHubWorkspaces } from "../core/cloud/hub-scope.js";
import { isSharedWorkspace } from "../core/cloud/members-cache.js";
import { parseShareLink, type ShareLink } from "../core/cloud/share-link.js";
import { autoSyncLocked, createShareOffer, resolveJoinTarget } from "../core/cloud/share.js";
import { openWorkspace } from "../core/open.js";

/** Every POST route in this file. The server pins each to POST and keeps it off the sync trigger. */
export const MEMBER_POST_ROUTES: readonly string[] = [
  "/api/cloud/workspace/members",
  "/api/cloud/workspace/members/rename",
  "/api/cloud/workspace/members/remove",
  "/api/cloud/workspace/members/device/revoke",
  "/api/cloud/workspace/join-requests",
  "/api/cloud/workspace/join-requests/approve",
  "/api/cloud/workspace/join-requests/deny",
  "/api/cloud/workspace/join/preview",
  "/api/cloud/workspace/join/start",
  "/api/cloud/workspace/join/poll",
  "/api/cloud/workspace/join/cancel",
  "/api/cloud/workspace/share",
  "/api/cloud/join-link/preview",
  "/api/cloud/join-link/start",
];

/** Which registered workspaces are shared, and with whom: a local read for the badge and switcher. */
export const SHARED_WORKSPACES_ROUTE = "/api/cloud/shared-workspaces";

/** The one GET: a local read for the empty-state card. */
export const JOIN_OFFER_ROUTE = "/api/cloud/workspace/join/offer";

/** What the members routes need from the server they are mounted in. */
export interface MemberRouteContext {
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  json(res: ServerResponse, status: number, payload: unknown): void;
  deny(res: ServerResponse, status: number, code: string, message: string): void;
  hubRowFor(res: ServerResponse, slug: unknown): HubWorkspace | null;
  hubRepositoryId(workspace: HubWorkspace): string;
  recordIdentityIfOpenWould(workspace: HubWorkspace): HubWorkspace;
  consents: ConsentTicketStore;
  /** Injected in tests; the global `fetch` otherwise. */
  fetchImpl?: typeof fetch;
}

/** A join the page started and has not finished. Holds the secret; see the module header. */
interface JoinInFlight {
  ticket: JoinTicket;
  slug: string;
  credentialFile: boolean;
  /** The read in flight, if any. A cancel waits for it rather than racing it. */
  busy: Promise<PollResult> | null;
  /** A person pressed Cancel. A read that comes back pending ends the join here. */
  cancelled: boolean;
}

/** What one read of a join request led to, as the poll route answers it. */
type PollResult =
  | { status: "pending"; code: string; expiresAt: number; transient?: boolean }
  | {
      status: "joined";
      code: string;
      member: { memberId: string; name: string } | null;
      endpoint: string;
      deviceId: string;
      auto: boolean;
      membersCached: boolean;
    }
  | { status: "denied" | "expired" | "cancelled"; code: string; expiresAt: number }
  | { status: "failed"; code: string; message: string }
  | { status: "error"; error: unknown };

/** At most this many joins in flight per server. A person starts one; a page that loops is cut off. */
const MAX_JOINS = 8;
/** How long past the service's expiry a join is kept before it is reported expired. */
const EXPIRY_GRACE_MS = 30_000;

export function createMemberRoutes(ctx: MemberRouteContext) {
  const joins = new Map<string, JoinInFlight>();
  const options = (credentialFile = false) => ({
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    forceFile: credentialFile,
  });

  function sweep(): void {
    const now = Date.now();
    for (const [id, join] of joins) {
      if (now > join.ticket.expiresAt + EXPIRY_GRACE_MS) joins.delete(id);
    }
  }

  /**
   * One read of a join request, and everything it leads to. The credential is collected here
   * and only here, so a join that was reported cancelled can never reach `completeJoin`: the
   * cancel either found no read in flight and ended the join first, or waited for this one.
   */
  async function readOnce(joinId: string, join: JoinInFlight): Promise<PollResult> {
    const home = stapleHome();
    const { ticket } = join;
    if (Date.now() > ticket.expiresAt + EXPIRY_GRACE_MS) {
      joins.delete(joinId);
      return { status: "expired", code: ticket.code, expiresAt: ticket.expiresAt };
    }
    let state;
    try {
      state = await pollJoin(ticket, options(join.credentialFile));
    } catch (error) {
      const code = cloudCodeOf(error);
      if (join.cancelled) return { status: "cancelled", code: ticket.code, expiresAt: ticket.expiresAt };
      if (code === "offline" || code === "unavailable" || code === "rate_limited") {
        return { status: "pending", code: ticket.code, expiresAt: ticket.expiresAt, transient: true };
      }
      joins.delete(joinId);
      return { status: "error", error };
    }
    if (state.status === "approved" && state.token !== undefined) {
      // The credential is in hand and the service will not hand it out again: store it, even
      // if Cancel was pressed while this read was out. The cancel reports this outcome.
      joins.delete(joinId);
      try {
        const outcome = await completeJoin(ticket, state, {
          home,
          credential: { forceFile: join.credentialFile },
          ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        });
        return {
          status: "joined",
          code: ticket.code,
          member: outcome.member,
          endpoint: outcome.connection.endpoint,
          deviceId: outcome.connection.deviceId,
          auto: outcome.connection.auto,
          membersCached: outcome.members !== null,
        };
      } catch (error) {
        return { status: "error", error };
      }
    }
    if (join.cancelled) return { status: "cancelled", code: ticket.code, expiresAt: ticket.expiresAt };
    if (state.status === "pending") return { status: "pending", code: ticket.code, expiresAt: ticket.expiresAt };
    joins.delete(joinId);
    if (state.status === "denied" || state.status === "expired") {
      return { status: state.status, code: ticket.code, expiresAt: ticket.expiresAt };
    }
    // Approved, but the credential was handed out to something that is not this process.
    return {
      status: "failed",
      code: ticket.code,
      message:
        `Join request ${ticket.code} was approved, but its credential was already collected and ` +
        `this window never received it. Ask the approver to remove device ${ticket.deviceId}, then ` +
        "start again.",
    };
  }

  function workspaceFor(res: ServerResponse, slug: unknown): { workspace: HubWorkspace; repositoryId: string } | null {
    const workspace = ctx.hubRowFor(res, slug);
    if (workspace === null) return null;
    return { workspace, repositoryId: ctx.hubRepositoryId(workspace) };
  }

  function manifestEndpoint(workspace: HubWorkspace): string | undefined {
    if (workspace.identityDir === null) return undefined;
    try {
      return readRepositoryManifest(workspace.identityDir)?.endpoint;
    } catch {
      return undefined;
    }
  }

  function wirePreview(preview: JoinPreview) {
    return { ...preview, endpoint: preview.endpoint.origin };
  }

  /**
   * The join preview for a share link. Local only: parses, reads files, probes the credential
   * store. The link names the service and the repository; nothing is created or sent here.
   */
  function linkPreview(link: ShareLink, label: string | undefined, credentialFile: boolean): JoinPreview {
    return buildJoinPreview({ home: stapleHome(), link, label, credential: { forceFile: credentialFile } });
  }

  /**
   * The link preview as the page reads it. The preview itself carries who invited whom to
   * what (`link`) and that sync will be on (`autoSync`).
   */
  function wireLinkPreview(preview: JoinPreview) {
    return wirePreview(preview);
  }

  /** Handle the request when it is one of ours. Returns false for every other path. */
  async function handle(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const home = stapleHome();

    // ------------------------------------------------------------ the join card's read
    if (url.pathname === SHARED_WORKSPACES_ROUTE) {
      // Local: the hub registry and each workspace's member list, no request.
      const workspaces = listHubWorkspaces().flatMap((workspace) => {
        if (workspace.repositoryId === null) return [];
        const cache = readMembersCache(home, workspace.repositoryId);
        const shared = isSharedWorkspace(cache);
        return [
          {
            slug: workspace.slug,
            shared,
            autoSyncLocked: shared && autoSyncLocked(home, workspace.repositoryId),
            members:
              cache === null
                ? []
                : cache.members
                    .filter((member) => !member.removed)
                    .map((member) => ({
                      memberId: member.memberId,
                      name: member.name,
                      isOwner: member.isOwner,
                      self: member.memberId === cache.self.memberId,
                    })),
          },
        ];
      });
      ctx.json(res, 200, { workspaces });
      return true;
    }

    if (url.pathname === JOIN_OFFER_ROUTE) {
      const addressed = workspaceFor(res, url.searchParams.get("ws"));
      if (addressed === null) return true;
      const connection = readConnection(home, addressed.repositoryId);
      ctx.json(res, 200, {
        slug: addressed.workspace.slug,
        repositoryId: addressed.repositoryId,
        endpoint: manifestEndpoint(addressed.workspace) ?? null,
        connected: connection !== null,
        removedBy: connection?.removed?.by ?? null,
      });
      return true;
    }

    if (!MEMBER_POST_ROUTES.includes(url.pathname)) return false;
    const body = await ctx.readBody(req);

    // ---------------------------------------------------------------------- joining
    if (url.pathname === "/api/cloud/workspace/join/preview") {
      const row = ctx.hubRowFor(res, body.slug);
      if (row === null) return true;
      const workspace = ctx.recordIdentityIfOpenWould(row);
      const repositoryId = ctx.hubRepositoryId(workspace);
      const credentialFile = body.credentialFile === true;
      const { endpoint, source } = resolveJoinEndpoint(
        typeof body.endpoint === "string" ? body.endpoint : undefined,
        manifestEndpoint(workspace),
      );
      const preview = buildJoinPreview({
        home,
        repositoryId,
        endpoint,
        endpointSource: source,
        label: typeof body.label === "string" ? body.label : undefined,
        credential: { forceFile: credentialFile },
      });
      ctx.json(res, 200, {
        slug: workspace.slug,
        preview: wirePreview(preview),
        consent: ctx.consents.mint(preview, { credentialFile }),
      });
      return true;
    }

    // ------------------------------------------------------------- sharing by link
    if (url.pathname === "/api/cloud/workspace/share") {
      // Local: builds the link from this machine's connection and member list; sends nothing.
      const addressed = workspaceFor(res, body.slug);
      if (addressed === null) return true;
      const invitedAs = typeof body.invitedAs === "string" && body.invitedAs.trim() !== "" ? body.invitedAs.trim() : null;
      ctx.json(res, 200, createShareOffer({ home, dbPath: addressed.workspace.path, invitedAs }));
      return true;
    }

    if (url.pathname === "/api/cloud/join-link/preview") {
      const link = parseShareLink(typeof body.link === "string" ? body.link : "");
      const credentialFile = body.credentialFile === true;
      // Where the join would land, decided and NOT created: creating waits for consent.
      const target = resolveJoinTarget({ home, cwd: process.cwd(), link, create: false });
      const preview = linkPreview(link, typeof body.label === "string" ? body.label : undefined, credentialFile);
      ctx.json(res, 200, {
        preview: wireLinkPreview(preview),
        consent: ctx.consents.mint(preview, { credentialFile }),
        target: { name: target.name, created: target.created, fromCheckout: target.fromCheckout },
      });
      return true;
    }

    if (url.pathname === "/api/cloud/join-link/start") {
      const link = parseShareLink(typeof body.link === "string" ? body.link : "");
      sweep();
      if (joins.size >= MAX_JOINS) {
        throw new StapleError("conflict", "Too many joins are already waiting in this window. Cancel one first.");
      }
      let preview: JoinPreview | null = null;
      const { context } = ctx.consents.redeem(body.consent, body.digest, (stored, choices) => {
        if (stored.repositoryId !== link.repositoryId || stored.endpoint.origin !== link.endpoint) {
          throw new StapleError(
            "validation",
            "That confirmation was for a different workspace or service than this link names. Nothing was sent.",
          );
        }
        preview = linkPreview(link, stored.label, choices.credentialFile);
        return preview;
      });
      // Consent given: only now may a workspace be created for the link.
      const target = resolveJoinTarget({ home, cwd: process.cwd(), link, create: true });
      const ticket = await startJoin(preview!, { home, ...options(context.credentialFile) });
      const joinId = randomUUID();
      joins.set(joinId, { ticket, slug: target.name, credentialFile: context.credentialFile, busy: null, cancelled: false });
      ctx.json(res, 200, {
        joinId,
        code: ticket.code,
        expiresAt: ticket.expiresAt,
        label: ticket.label,
        endpoint: ticket.endpoint.origin,
        workspace: target.name,
        created: target.created,
      });
      return true;
    }

    if (url.pathname === "/api/cloud/workspace/join/start") {
      const addressed = workspaceFor(res, body.slug);
      if (addressed === null) return true;
      sweep();
      if (joins.size >= MAX_JOINS) {
        throw new StapleError("conflict", "Too many joins are already waiting in this window. Cancel one first.");
      }
      let joinPreview: JoinPreview | null = null;
      const { context } = ctx.consents.redeem(body.consent, body.digest, (stored, choices) => {
        if (stored.repositoryId !== addressed.repositoryId) {
          throw new StapleError(
            "validation",
            `That confirmation was issued for a different workspace, so it cannot be used to join ` +
              `from "${addressed.workspace.slug}". Nothing was sent.`,
          );
        }
        const source: JoinEndpointSource = (stored as Partial<JoinPreview>).endpointSource ?? "flag";
        joinPreview = buildJoinPreview({
          home,
          repositoryId: addressed.repositoryId,
          endpoint: stored.endpoint.origin,
          endpointSource: source,
          label: stored.label,
          credential: { forceFile: choices.credentialFile },
        });
        return joinPreview;
      });
      const ticket = await startJoin(joinPreview!, { home, ...options(context.credentialFile) });
      const joinId = randomUUID();
      joins.set(joinId, { ticket, slug: addressed.workspace.slug, credentialFile: context.credentialFile, busy: null, cancelled: false });
      ctx.json(res, 200, {
        joinId,
        code: ticket.code,
        expiresAt: ticket.expiresAt,
        label: ticket.label,
        endpoint: ticket.endpoint.origin,
      });
      return true;
    }

    if (url.pathname === "/api/cloud/workspace/join/poll") {
      const joinId = typeof body.joinId === "string" ? body.joinId : "";
      const join = joins.get(joinId);
      if (!join) {
        throw new StapleError(
          "not_found",
          "No join is waiting under that id. It finished, was cancelled, or this server restarted. " +
            "Start again for a new code.",
        );
      }
      // One read at a time per join, and the one in flight is what a cancel waits for.
      const result = await (join.busy ??= readOnce(joinId, join).finally(() => {
        join.busy = null;
      }));
      if (result.status === "error") throw result.error;
      ctx.json(res, 200, result);
      return true;
    }

    if (url.pathname === "/api/cloud/workspace/join/cancel") {
      const joinId = typeof body.joinId === "string" ? body.joinId : "";
      const join = joins.get(joinId);
      if (!join) {
        ctx.json(res, 200, { cancelled: false, code: null, expiresAt: null });
        return true;
      }
      join.cancelled = true;
      /**
       * A read may be in flight, and it may be the one that collects the credential (the
       * service hands it out once). Cancelling around it would say "cancelled" about a device
       * that is about to be connected. So the cancel waits for that read and reports what it
       * did: a join that completed is answered as joined, never as cancelled.
       */
      if (join.busy) {
        const outcome = await join.busy;
        if (outcome.status === "joined") {
          ctx.json(res, 200, { cancelled: false, ...outcome });
          return true;
        }
      }
      joins.delete(joinId);
      // Local only: the service is not told, and the request expires by itself.
      ctx.json(res, 200, { cancelled: true, code: join.ticket.code, expiresAt: join.ticket.expiresAt });
      return true;
    }

    // -------------------------------------------------------------- members and requests
    const addressed = workspaceFor(res, body.slug);
    if (addressed === null) return true;
    const { repositoryId } = addressed;
    const opts = options(readConnection(home, repositoryId)?.credentialMechanism === "file");

    const membersPayload = (members: MembersCache | null, requests?: PendingJoinRequest[]) => ({
      members: members ?? readMembersCache(home, repositoryId),
      ...(requests ? { requests } : {}),
    });

    if (url.pathname === "/api/cloud/workspace/members") {
      // Opening the Members category is a person's action: fetch both, every time.
      const members = await refreshMembersCache(home, repositoryId, opts);
      const requests = await listPendingRequests(home, repositoryId, opts);
      ctx.json(res, 200, membersPayload(members, requests));
      return true;
    }

    if (url.pathname === "/api/cloud/workspace/join-requests") {
      /**
       * The approval toast asks on its own, so it says so (`background: true`) and is held to
       * what this device agreed to, decided here, from local files, before any request: the
       * page's copy of the consent may be minutes old. Automatic sync must be on for this
       * workspace right now, and this machine must hold a member list, which it has only if
       * the service supports members and this workspace is shared. A person's own request
       * (opening Members, or Refresh) is never gated.
       */
      if (body.background === true) {
        const connection = readConnection(home, repositoryId);
        if (!connection || connection.auto !== true || connection.removed) {
          throw new StapleError(
            "forbidden",
            "Automatic sync is off for this workspace on this computer, so the page does not ask the service on its own.",
            { reason: "auto_sync_off" },
          );
        }
        if (readMembersCache(home, repositoryId) === null) {
          throw new StapleError(
            "forbidden",
            "This computer has no member list for this workspace, so there is nobody to approve requests here.",
            { reason: "no_members" },
          );
        }
      }
      ctx.json(res, 200, { requests: await listPendingRequests(home, repositoryId, opts) });
      return true;
    }

    if (url.pathname === "/api/cloud/workspace/join-requests/approve") {
      const code = normalizeJoinCode(typeof body.code === "string" ? body.code : "");
      const as =
        typeof body.newMember === "string"
          ? { asNewMember: body.newMember }
          : typeof body.memberId === "string"
            ? { toMember: body.memberId }
            : null;
      if (as === null) {
        ctx.deny(res, 400, "validation", "Say who the device belongs to: newMember (a name) or memberId.");
        return true;
      }
      const outcome = await approveRequest(home, repositoryId, code, as, opts);
      const requests = await listPendingRequests(home, repositoryId, opts).catch(() => undefined);
      ctx.json(res, 200, {
        approved: { code: outcome.code, member: outcome.member, newMember: outcome.newMember },
        ...membersPayload(outcome.members, requests),
      });
      return true;
    }

    if (url.pathname === "/api/cloud/workspace/join-requests/deny") {
      const outcome = await denyRequest(home, repositoryId, typeof body.code === "string" ? body.code : "", opts);
      const requests = await listPendingRequests(home, repositoryId, opts).catch(() => undefined);
      ctx.json(res, 200, { denied: { code: outcome.code }, ...membersPayload(null, requests) });
      return true;
    }

    if (url.pathname === "/api/cloud/workspace/members/rename") {
      const memberId = typeof body.memberId === "string" ? body.memberId : "";
      const name = typeof body.name === "string" ? body.name : "";
      // The addressed workspace, opened by its own path, so its tickets move with the member.
      const opened = openWorkspace(addressed.workspace.path);
      let outcome: Awaited<ReturnType<typeof renameMember>>;
      try {
        outcome = await renameMember(home, repositoryId, memberId, name, opts, { store: opened.store, actor: null });
      } finally {
        opened.store.db.close();
      }
      ctx.json(res, 200, {
        renamed: { from: outcome.from, to: outcome.to, reassigned: outcome.reassigned },
        ...membersPayload(outcome.members),
      });
      return true;
    }

    if (url.pathname === "/api/cloud/workspace/members/remove") {
      const memberId = typeof body.memberId === "string" ? body.memberId : "";
      const confirm = typeof body.confirm === "string" ? body.confirm : undefined;
      const outcome = await removeMember(home, repositoryId, memberId, confirm, opts);
      ctx.json(res, 200, {
        removed: { name: outcome.name, devicesRevoked: outcome.devicesRevoked },
        ...membersPayload(outcome.members),
      });
      return true;
    }

    if (url.pathname === "/api/cloud/workspace/members/device/revoke") {
      const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
      if (deviceId === "") {
        ctx.deny(res, 400, "validation", "A device id is required.");
        return true;
      }
      const outcome = await performRevoke(home, repositoryId, deviceId, opts);
      const members = await refreshMembersCache(home, repositoryId, opts).catch(() => null);
      ctx.json(res, 200, { revoked: { deviceId: outcome.deviceId, self: outcome.self }, ...membersPayload(members) });
      return true;
    }

    return false;
  }

  return { handle, joinsInFlight: () => joins.size };
}
