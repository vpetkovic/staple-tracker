/**
 * The only thing in this app that calls fetch().
 *
 * It owns three things nobody else should re-implement:
 *   1. the token — captured from the URL `staple ui` printed, kept in sessionStorage,
 *      scrubbed from the address bar, and sent as X-Staple-Token on every request;
 *   2. the 401/403 contract — those become a typed AuthError, never an unhandled
 *      rejection, so the shell can render the token screen instead of a blank page;
 *   3. the error envelope — the server answers { error, message, code, retryable } for
 *      every failure, and this turns that into an Error with those fields attached.
 *
 * WAVE 2: import from here. Adding an endpoint means adding a function here.
 */
import type {
  ActionPayload,
  AgentContext,
  Bootstrap,
  CloudMutationResult,
  CloudSurfaceReport,
  ConnectPreviewResponse,
  ConsentTicket,
  DocumentRevision,
  ErrorEnvelope,
  Graph,
  HubActionResult,
  HubAdoptResult,
  HubBackupConsentResult,
  HubBackupResult,
  HubBackupsResult,
  HubCloudReport,
  HubConnectPreviewResponse,
  HubConnectPreviewResult,
  HubFanOutResult,
  HubIdentityMintResult,
  HubIdentityResult,
  HubPublishResult,
  HubRegistryConnectPreviewResult,
  HubRegistryConnectResult,
  HubRegistryDisconnectResult,
  HubRestoreResult,
  HubUnregisterPreviewResult,
  InboxRow,
  IssueDetail,
  IssueDocument,
  IssueRow,
  MilestoneListRow,
  MilestoneView,
  Poll,
  ProjectFieldsInput,
  ProjectRemoval,
  ProjectRow,
  QueueView,
  RemoteBackup,
  RemoteDevice,
  StapleEvent,
  VocabularyOp,
} from "./types";
// Type-only, so the cycle with lib/settings.ts (which imports `getSettings`) is erased.
import type { SettingOp, WorkspaceSettingsEnvelope } from "./settings";

const TOKEN_KEY = "staple:token";

/**
 * Thrown for 401 and 403. The shell catches this specific type and swaps the whole
 * page for the token screen — every other failure is local to the view that asked.
 */
export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

/** A non-auth failure carrying the server's envelope fields. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly detail?: Record<string, unknown>;
  constructor(status: number, envelope: Partial<ErrorEnvelope>) {
    super(envelope.message ?? envelope.error ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = envelope.code ?? "unknown";
    this.retryable = envelope.retryable ?? false;
    if (envelope.detail) this.detail = envelope.detail;
  }
}

function readSession(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return ""; // private mode
  }
}

function writeSession(value: string): void {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the token lives for this page load only */
  }
}

/**
 * Runs once at module load, before React mounts.
 *
 * The server hands the token over exactly once, in the URL it printed. Stash it in
 * sessionStorage — origin-scoped, so it is per staple instance and dies with the tab —
 * then strip it from the address bar so it stays out of bookmarks, history, and the
 * Referer of any external link a rendered document happens to contain.
 */
let token: string = (() => {
  /**
   * NO BROWSER, NO TOKEN — O6 (STA-138).
   *
   * This IIFE reads `location` at module scope, which is correct in the app and fatal
   * anywhere else: the task-list suites render the row with `react-dom/server` in a Node
   * environment, and since the row can now open the Dependencies dialog, this module is in
   * the row's import graph. Without the guard, importing a ROW throws `location is not
   * defined` before a single assertion runs.
   *
   * Returning "" is the honest answer rather than a workaround. There is no URL to read a
   * token out of and no session to fall back on, so the module is left in exactly the state
   * `forgetToken()` leaves it in — `hasToken()` false — and every caller already handles
   * that. Nothing that is supposed to work in a browser behaves differently.
   */
  if (typeof location === "undefined") return "";
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("token");
  if (!fromUrl) return readSession();
  writeSession(fromUrl);
  params.delete("token");
  const qs = params.toString();
  history.replaceState({}, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
  return fromUrl;
})();

export function hasToken(): boolean {
  return token.length > 0;
}

/** Drop the token we hold — called when the server tells us it is no longer valid. */
export function forgetToken(): void {
  token = "";
  writeSession("");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), "x-staple-token": token },
  });

  if (res.status === 401 || res.status === 403) {
    // 401 is almost always a restarted server: the old token died with the old
    // process. Forget it so a reload shows the token screen rather than retrying
    // a credential that can never work again.
    if (res.status === 401) forgetToken();
    const envelope = (await res.json().catch(() => ({}))) as Partial<ErrorEnvelope>;
    const failure = new AuthError(res.status, envelope.code ?? "unauthorized", envelope.message ?? envelope.error ?? res.statusText);
    // Write handlers catch errors locally to render refusals; an AuthError must
    // still reach the shell, so it is broadcast as well as thrown.
    window.dispatchEvent(new CustomEvent("staple:auth-error", { detail: failure }));
    throw failure;
  }

  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new ApiError(res.status, body as Partial<ErrorEnvelope>);
  return body as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
};

// ---------- reads ----------

export const getBootstrap = () => request<Bootstrap>("/api/bootstrap");

export const getPoll = () => request<Poll>("/api/poll");

/**
 * This machine's cloud state — the same `CloudSurfaceReport` the CLI prints and
 * the `cloud_status` MCP tool returns.
 *
 * Same-origin loopback to the local server, which answers it from three files
 * and the local database. There is no `refresh` parameter to pass and that is
 * structural, not an omission: *"a polled UI with a refreshing status endpoint
 * would turn one human's page-open into a heartbeat to Cloudflare every few
 * seconds."*
 *
 * Call this ONCE per mount. It is deliberately not part of the 1.5s fingerprint
 * poll — connection state changes when a human runs a command, not while they
 * read a page.
 */
export const getCloudStatus = () => request<CloudSurfaceReport>("/api/cloud/status");

/**
 * `GET /api/cloud/workspaces` — every registered workspace with its own
 * connection state. S16 (STA-275).
 *
 * Also once per mount, and for a stronger reason than `getCloudStatus`. This
 * response describes N workspaces, and the temptation with a list is to poll it
 * so it stays fresh. It must not be polled: the route reads the hub registry and
 * a handful of files per workspace, and a page that asked every 1.5 seconds
 * would be doing that work forever to watch a value that only changes when a
 * human runs `staple cloud connect` or `staple init` in a terminal.
 *
 * The route takes no parameters at all — no `ws`, because it is about all of
 * them, and no `refresh`, because a refresh across a hub is one authenticated
 * round trip per workspace.
 */
export const getCloudWorkspaces = () => request<HubCloudReport>("/api/cloud/workspaces");

// ---------- cloud mutations (S13, STA-258) ----------

/**
 * The cloud writes, and the two-step exchange that keeps connect's
 * preview-then-consent shape alive across HTTP.
 *
 * ── WHY THERE ARE TWO CONNECT CALLS AND NOT ONE ───────────────────────────────
 *
 * `previewCloudConnect` is the ONLY function in this app that can name an
 * endpoint. `cloudConnect` takes a consent id and a digest and has no parameter
 * for one — deliberately, and matching the route, which also has no such field.
 * The endpoint travels in one direction: it comes back in the preview response,
 * and there is no request shape that carries it forward. So a caller cannot
 * connect without having first been handed the description of what it would be
 * connecting to. See src/core/cloud/consent.ts for the whole argument.
 *
 * Collapsing these into one convenience function that previewed and then
 * connected would put that property back in the hands of whoever calls it, which
 * is exactly the kind of guarantee this codebase keeps structural instead.
 *
 * ── WHAT IS AND IS NOT A NETWORK CALL ─────────────────────────────────────────
 *
 * Everything on this page is a same-origin loopback request to the local server.
 * Of the routes below, only `listCloudDevices` and `revokeCloudDevice` cause that
 * server to leave the machine. `previewCloudConnect`, `setCloudConsent` and
 * `cloudDisconnect` read and write local files and nothing else — which is why
 * the settings section can render its entire state without any of them.
 *
 * There is no `purgeCloud`. `staple cloud purge` requires the repository id typed
 * back, STA-256 records that the server does not yet validate a confirmation on
 * the wire, and a one-click irreversible remote deletion behind a browser session
 * is not a thing to add while that is true. The section says purge exists and
 * names the command.
 */
const cloudWrite = <T>(route: string, body: Record<string, unknown>) =>
  request<T>(`/api/cloud/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * Step one. Local: parses the URL, reads two files, probes the credential store.
 *
 * `credentialFile` is `staple cloud connect --credential-file`. It belongs on the
 * PREVIEW rather than on the connect, because the preview is what says where the
 * secret is about to go — making the choice part of what consent is given to
 * rather than a setting hidden behind it.
 */
export const previewCloudConnect = (target: {
  ws?: string;
  endpoint: string;
  label?: string;
  credentialFile?: boolean;
}) => cloudWrite<ConnectPreviewResponse>("connect/preview", target);

/** Step two. Carries the ticket and the digest of the preview that was shown, and nothing else that names a service. */
export const cloudConnect = (target: {
  ws?: string;
  consent: ConsentTicket;
  /** The enrollment secret. Sent once, stored by the server, never echoed back. */
  token: string;
}) =>
  cloudWrite<CloudMutationResult>("connect", {
    ws: target.ws,
    consent: target.consent.id,
    digest: target.consent.digest,
    token: target.token,
  });

/** Local only — no request leaves the machine, not even a courtesy one. */
export const cloudDisconnect = (target: { ws?: string }) =>
  cloudWrite<CloudMutationResult>("disconnect", { ...target, confirm: true });

/**
 * One consent, one call. The signature takes a single flag rather than an object
 * of two, because the route refuses a body naming both: they are two decisions
 * and a control that spent both at once would be spending one of them silently.
 */
export const setCloudConsent = (target: { ws?: string; consent: "auto" | "backup"; value: boolean }) =>
  cloudWrite<CloudMutationResult>("consent", { ws: target.ws, [target.consent]: target.value });

/** EGRESSES. Called only from an explicit press, never on mount. */
export const listCloudDevices = (target: { ws?: string } = {}) =>
  cloudWrite<{ devices: RemoteDevice[] }>("devices", target);

/** EGRESSES. Ends that device's access on its very next request. */
export const revokeCloudDevice = (target: { ws?: string; deviceId: string }) =>
  cloudWrite<CloudMutationResult & { deviceId: string; revoked: boolean; self: boolean }>(
    "devices/revoke",
    { ...target, confirm: true },
  );

// ---------- the per-row cloud surface (S17/S19/S21) ----------

/**
 * Six calls, each naming the ONE workspace it acts on — S17 (STA-278), S19
 * (STA-280), S21 (STA-282).
 *
 * ## Why these are separate from the five above, and not a `ws` argument
 *
 * The functions above take an optional `ws` and hit `/api/cloud/*`, where the
 * server resolves it through `handleFor`. In HUB mode that resolves a slug. In
 * single-workspace mode — the ordinary `staple ui` in a repository — it IGNORES
 * the slug and answers with the one workspace the server was started on. That is
 * correct for those routes, which are about the workspace the dialog was opened
 * on; it would be catastrophic here, where pressing Disconnect on the `bravo`
 * row would silently disconnect `alpha`.
 *
 * So every function below hits `/api/cloud/workspace/*`, which addresses the
 * MACHINE REGISTRY by slug and never touches the server's store cache. The two
 * families look interchangeable and are not, which is why they do not share a
 * helper: a shared `cloudWrite` with an optional slug is one careless call away
 * from the bug.
 *
 * ## What leaves the machine
 *
 * `syncWorkspace` and `connectWorkspace`. Nothing else — `previewWorkspaceConnect`
 * reads local files and cannot import the client, `setWorkspaceConsent` writes one
 * file in the staple home, `disconnectWorkspace` deletes one, and
 * `unregisterWorkspace` deletes a row from the local registry. None of them is
 * called on mount; the list itself comes from `getCloudWorkspaces`, which is
 * silent by construction.
 */
const hubWrite = <T>(path: string, body: Record<string, unknown>) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * Step one, for one row. Local.
 *
 * Answers with `preview: null` and a reason when the row would be skipped — an
 * already-connected workspace, most often — and mints no ticket for it.
 */
export const previewWorkspaceConnect = (target: {
  slug: string;
  endpoint: string;
  label?: string;
  credentialFile?: boolean;
}) => hubWrite<HubConnectPreviewResult>("/api/cloud/workspace/connect/preview", target);

/**
 * Step two. EGRESSES. Carries the ticket, the digest and the slug — and no
 * endpoint, exactly as `cloudConnect` carries none.
 *
 * The slug does not weaken that guarantee: it names a workspace already
 * registered on this machine, and no arrangement of registered workspaces can
 * spell a service address. The server additionally refuses a ticket minted for a
 * different workspace, by name.
 */
export const connectWorkspace = (target: { slug: string; consent: ConsentTicket; token: string }) =>
  hubWrite<HubActionResult>("/api/cloud/workspace/connect", {
    slug: target.slug,
    consent: target.consent.id,
    digest: target.consent.digest,
    token: target.token,
  });

/** One consent, one row, one call. Writes a file in the staple home and nothing else. */
export const setWorkspaceConsent = (target: {
  slug: string;
  consent: "auto" | "backup";
  value: boolean;
}) =>
  hubWrite<HubActionResult>("/api/cloud/workspace/consent", {
    slug: target.slug,
    [target.consent]: target.value,
  });

/**
 * Local only. Offered even on a row whose disk is not mounted, deliberately: the
 * credential is on THIS machine and removing it is the whole point.
 */
export const disconnectWorkspace = (target: { slug: string }) =>
  hubWrite<HubActionResult>("/api/cloud/workspace/disconnect", { ...target, confirm: true });

/**
 * EGRESSES. A row that fails answers 200 with `outcome.status === "failed"` and
 * the service's own sentence — the fan-out reports a failure as a row rather
 * than by throwing, so the caller must read `status` and not merely `catch`.
 */
export const syncWorkspace = (target: { slug: string }) =>
  hubWrite<HubActionResult>("/api/cloud/workspace/sync", target);

/** What removal would do, having written nothing. Previews by default, like `hub prune`. */
export const previewUnregisterWorkspace = (target: { slug: string }) =>
  hubWrite<HubUnregisterPreviewResult>("/api/hub/unregister", target);

/**
 * Remove one row from this machine's registry.
 *
 * Unregisters; it does not delete. The workspace database and every file beside
 * it are untouched, which is a property of `deleteHubRegistration`'s signature
 * rather than a promise. Refused while the workspace is still connected, because
 * that would leave this machine's credential with nothing pointing at it.
 */
export const unregisterWorkspace = (target: { slug: string; removeCrossLinks?: boolean }) =>
  hubWrite<HubActionResult>("/api/hub/unregister", { ...target, confirm: true });

/**
 * Back up the hub itself — the registry and its cross-links, never any task.
 *
 * Takes no slug, because the hub is not one of the rows. Writes a file on this
 * machine and makes no network call, which is what lets it be offered
 * unconditionally.
 */
export const backupHub = () => hubWrite<HubBackupResult>("/api/hub/backup", {});

// ---------- the hub-wide verbs (S18, STA-279) ----------

/**
 * Four calls whose subject is the WHOLE machine registry — S18 (STA-279).
 *
 * ## Why these are separate from the per-row six, and not a flag on them
 *
 * Because `{ slug: "*" }` on `disconnectWorkspace` would put "one workspace" and
 * "every workspace on this machine" one character apart, in one function, behind
 * one confirmation. The blast radius is the thing being named, and a function
 * name is where a reader of this file can see it without opening a handler.
 *
 * ## What they are, underneath
 *
 * The same three core fan-outs the per-row calls use, with the `workspaces`
 * argument OMITTED so the enumeration is the registry rather than a
 * single-element array. There is no separate hub-wide implementation to drift.
 *
 * ## What leaves the machine
 *
 * `syncHub` and `connectHub`. Nothing else — `previewHubConnect` reads local
 * files and cannot import the client, and `disconnectHub` deletes files in the
 * staple home and makes no request even as a courtesy. **None of them is called
 * on mount**, and `syncHub` in particular is the widest egressing call on this
 * surface: one authenticated round trip per connected workspace. A settings page
 * that reached it on open would be a heartbeat with a multiplier on it.
 */

/**
 * Step one, for the whole registry. Local.
 *
 * Returns the fan-out preview — every registered workspace, including every one
 * it will skip and why — together with ONE CONSENT TICKET PER ACTIONABLE ROW. A
 * skipped row gets no ticket, because a consent for something that will not
 * happen is a consent with no subject.
 *
 * Refuses with a stated reason when nothing is actionable, rather than answering
 * an empty enumeration: an empty table is indistinguishable from a button that
 * did nothing.
 */
export const previewHubConnect = (target: {
  endpoint: string;
  label?: string;
  credentialFile?: boolean;
}) => hubWrite<HubConnectPreviewResponse>("/api/hub/connect/preview", target);

/**
 * Step two. EGRESSES, once per workspace. **Carries no endpoint and no
 * repositoryId** — only the tickets and the enrollment secret.
 *
 * The tickets are what make this expressible at all: there is no wire spelling
 * for "connect everything to X", so the description of every service, repository
 * and credential store was necessarily delivered to this client in a prior
 * response. Sending all of them together is what makes the confirm a confirm of
 * the ENUMERATION — the server re-derives it and refuses if a workspace has been
 * registered or connected since the screen was drawn.
 */
export const connectHub = (target: {
  consents: ReadonlyArray<{ slug: string; consent: ConsentTicket }>;
  token: string;
}) =>
  hubWrite<HubFanOutResult>("/api/hub/connect", {
    consents: target.consents.map((issued) => ({
      slug: issued.slug,
      consent: issued.consent.id,
      digest: issued.consent.digest,
    })),
    token: target.token,
  });

/**
 * EGRESSES, once per connected workspace. The widest outbound call on this
 * surface.
 *
 * A row that fails comes back inside a 200 with `status: "failed"` and the
 * service's own sentence — the fan-out reports a failure as a ROW rather than by
 * throwing, because folding `offline`, `revoked` and `rate_limited` into one
 * thrown error is what makes a multi-row table unactionable. So the caller must
 * read the rows and not merely `catch`.
 */
export const syncHub = () => hubWrite<HubFanOutResult>("/api/hub/sync", {});

/**
 * Local, and only local, N times over. Makes no request even as a courtesy: a
 * person who has decided to stop talking to a service must not need that
 * service's permission to stop.
 *
 * Not gated on availability, deliberately — the credentials are in the staple
 * home, so a workspace whose disk is unmounted is disconnected here too, which
 * is the whole point rather than an edge case.
 */
export const disconnectHub = () =>
  hubWrite<HubFanOutResult>("/api/hub/disconnect", { confirm: true });

/**
 * The HUB's own consent — S22 (STA-283). Local: writes one file in the staple
 * home and asks the service nothing.
 *
 * Takes no slug and no `ws`, like every other `/api/hub/*` call, because the
 * subject is the hub. It is deliberately NOT a fourth key on `setCloudConsent`
 * or `setWorkspaceConsent`: both of those are keyed by a repository id, and the
 * first resolves through `handleFor`, which in single-workspace mode ignores the
 * workspace it is handed. A hub-scoped consent sent either way would land under
 * the wrong subject.
 *
 * Refuses on a hub that has never been connected rather than creating a record,
 * so the surface must disable the control rather than let it error.
 */
export const setHubRegistryConsent = (enabled: boolean, disclosure?: string) =>
  hubWrite<HubActionResult>("/api/hub/consent", {
    registry: enabled,
    /**
     * **The acknowledgement, and it must come from the REPORT.**
     *
     * `setRegistryConsent` refuses to enable unless handed the disclosure
     * verbatim — evidence that whoever is granting this had the sentence in
     * hand. The server forwards what this sends rather than supplying its own,
     * so the check survives the HTTP boundary instead of being spent at it.
     *
     * The only place this client can obtain the string is
     * `report.self.registry.disclosure`, which requires having fetched the
     * report that draws the panel. Pass that value — never a literal typed here,
     * which would be both a second copy and a way to satisfy the check without
     * having rendered anything.
     *
     * Omitted when withdrawing: turning this OFF needs no acknowledgement,
     * because making revocation harder than granting is the wrong asymmetry.
     */
    ...(enabled ? { disclosure } : {}),
  });

// ---------- the hub registry leg (STA-289) ----------

/**
 * The hub's own leg to a sync service: identity, connect, publish, hub backups,
 * restore, adopt. Every call takes no slug and no `ws`, because the subject is the
 * hub, and the server addresses it through `hub.storedHubId()`.
 *
 * ## What leaves the machine
 *
 * `connectHubRegistry`, `publishHubRegistry`, `setHubBackupConsent` (when turning
 * it on), `listHubBackups`, `createHubBackup`, `restoreHubRegistry` and
 * `adoptHubRegistry`. **None is called on mount**; each is behind its own press.
 * The identity calls, the connect preview and the disconnect are local.
 */

/** Mint this hub's identity, or answer the one it already has. Local. */
export const mintHubIdentity = () => hubWrite<HubIdentityMintResult>("/api/hub/registry/identity/mint", {});

/**
 * Take on an identity another machine published under. Local.
 *
 * Without `confirm`, replacing an existing id only ASKS: the answer carries
 * `needsConfirm` and the orphan notice, and nothing changes.
 */
export const adoptHubIdentity = (hubId: string, confirm = false) =>
  hubWrite<HubIdentityResult>("/api/hub/registry/identity", { hubId, ...(confirm ? { confirm: true } : {}) });

/** Step one of connecting the hub. Local, and the only call here that names an endpoint. */
export const previewHubRegistryConnect = (target: {
  endpoint: string;
  label?: string;
  credentialFile?: boolean;
}) => hubWrite<HubRegistryConnectPreviewResult>("/api/hub/registry/connect/preview", target);

/**
 * Step two. EGRESSES. The ticket, its digest and the secret — no endpoint and no
 * repository id, because the route has neither field: it connects what the
 * preview showed or nothing.
 */
export const connectHubRegistry = (target: { consent: ConsentTicket; token: string }) =>
  hubWrite<HubRegistryConnectResult>("/api/hub/registry/connect", {
    consent: target.consent.id,
    digest: target.consent.digest,
    token: target.token,
  });

/** Local: removes the hub's credential. What was published stays published. */
export const disconnectHubRegistry = () =>
  hubWrite<HubRegistryDisconnectResult>("/api/hub/registry/disconnect", { confirm: true });

/** EGRESSES. Needs the publish consent, which the server checks from the record first. */
export const publishHubRegistry = () => hubWrite<HubPublishResult>("/api/hub/registry/publish", {});

/** EGRESSES when enabling: the service owns half of this consent and is asked first. */
export const setHubBackupConsent = (enabled: boolean) =>
  hubWrite<HubBackupConsentResult>("/api/hub/registry/backup/consent", { enabled });

/** EGRESSES. The service's hub backups, and the disclosure a restore is shown with. */
export const listHubBackups = () => hubWrite<HubBackupsResult>("/api/hub/registry/backups", {});

/** EGRESSES. Take a hub backup, then list. */
export const createHubBackup = (label?: string) =>
  hubWrite<HubBackupsResult>("/api/hub/registry/backup/create", label ? { label } : {});

/**
 * EGRESSES, and rewinds the registry for every machine on this hub id. Carries the
 * three facts the confirmation showed; the server compares them with its own list
 * and restores nothing if they differ.
 */
export const restoreHubRegistry = (backup: Pick<RemoteBackup, "backupId" | "epoch" | "entityCount">) =>
  hubWrite<HubRestoreResult>("/api/hub/registry/restore", {
    backupId: backup.backupId,
    epoch: backup.epoch,
    entityCount: backup.entityCount,
    confirm: true,
  });

/**
 * EGRESSES (a read of the service) and writes only `hub.db`. Without a digest it
 * previews; with one it applies exactly that preview or refuses.
 */
export const adoptHubRegistry = (digest?: string) =>
  hubWrite<HubAdoptResult>("/api/hub/registry/adopt", digest ? { apply: true, digest } : {});

export const getIssues = (params: { ws?: string; assignee?: string } = {}) =>
  request<IssueRow[]>(`/api/issues${qs(params)}`);

export const getInbox = (params: { assignee?: string } = {}) =>
  request<InboxRow[]>(`/api/inbox${qs(params)}`);

export const getIssue = (params: { ws?: string; ref: string }) =>
  request<IssueDetail>(`/api/issue${qs(params)}`);

export const getDocument = (params: { ws?: string; ref: string; key: string; revision?: number }) =>
  request<IssueDocument>(`/api/document${qs(params)}`);

/** A document's history, newest revision first. */
export const getRevisions = (params: { ws?: string; ref: string; key: string }) =>
  request<DocumentRevision[]>(`/api/revisions${qs(params)}`);

/**
 * The MCP `get_task` payload for one issue, byte-identical to what an agent receives.
 * `documents` maps to get_task's `include_documents` and defaults off, as it does there.
 */
export const getAgentContext = (params: { ws?: string; ref: string; documents?: boolean }) =>
  request<AgentContext>(
    `/api/agent-context${qs({ ws: params.ws, ref: params.ref, documents: params.documents ? "1" : undefined })}`,
  );

export const getGraph = () => request<Graph>("/api/graph");

/**
 * The event log. Workspace-scoped by default and capped at 100; pass `issue` (a ref)
 * for one issue's whole history instead — the detail timeline needs the latter, since
 * on a busy workspace an issue's first status change falls outside the 100.
 */
export const getEvents = (params: { ws?: string; since?: number; issue?: string } = {}) =>
  request<StapleEvent[]>(`/api/events${qs(params)}`);

// ---------- writes ----------

/**
 * The single write endpoint. The server pins it to POST and checks Origin, so this
 * must stay a same-origin POST with a JSON body — do not "helpfully" switch it to a
 * GET with query params.
 *
 * `ref` is optional because `{ type: "create" }` has no issue to point at yet. Every
 * other action needs one, and the server's `not_found` on a missing ref is the guard
 * for that — one refusal path rather than a client-side pre-check that could disagree
 * with it.
 */
export const action = <T = unknown>(target: { ws?: string; ref?: string; actor?: string }, payload: ActionPayload) =>
  request<T>("/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...target, ...payload }),
  });

/**
 * THE REVIEW GATE — Q2 (STA-144). Three writes, one shape.
 *
 * Separate from `action()` rather than three more `ActionPayload` members, matching
 * the server: a gate is a policy surface, `approve` means something different with
 * `children` than without it, and `request-changes` has a mandatory field no other
 * action has. Folding them into a nine-branch union whose every member can see the
 * others' fields is how a gate gets opened with the wrong verb's body.
 *
 * Each returns the REFRESHED `IssueDetail` — the same payload `/api/issue` sends —
 * so the panel redraws from one consistent read of the database rather than from a
 * follow-up fetch that could observe a different state. Refusals arrive as `ApiError`
 * with the store's own `code` and sentence, which is what `describeRefusal` renders.
 */
const gate = (route: string, body: Record<string, unknown>) =>
  request<IssueDetail>(`/api/gate/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...body }),
  });

/** Park a parent behind `owner`'s review; every open descendant becomes queued. */
export const requestGate = (target: { ws?: string; ref: string; owner: string; comment?: string }) =>
  gate("request", target);

/**
 * Approve. NO `children` (or an empty list) approves the WHOLE gate and releases the
 * subtree; naming children releases only those and leaves the parent parked, which is
 * granular approval rather than the end of review.
 */
export const approveGate = (target: { ws?: string; ref: string; children?: string[]; comment?: string }) =>
  gate("approve", target);

/** Send it back. The comment is mandatory — the store refuses an empty one. */
export const requestGateChanges = (target: { ws?: string; ref: string; comment: string }) =>
  gate("request-changes", target);
// ---------- workspace vocabulary (O7b / STA-141) ----------

/**
 * The workspace's statuses and kinds. THE ONLY ROUTE THAT READS AND WRITES ON ONE PATH —
 * `/api/settings` is GET here and POST below, which is why the server's method pin is a
 * list rather than a string.
 *
 * It is a read on its own function rather than a branch of `getBootstrap` because the
 * vocabulary is per WORKSPACE and bootstrap is per process: in hub mode switching the
 * workspace has to refetch this and must not refetch that.
 */
export const getSettings = (params: { ws?: string } = {}) =>
  request<WorkspaceSettingsEnvelope>(`/api/settings${qs(params)}`);

/**
 * Apply an ordered batch of vocabulary edits. Same-origin POST for the same reason
 * `action` is one: the server pins the method and checks Origin.
 *
 * Returns the WHOLE new settings envelope, identical in shape to `getSettings`. That is
 * the contract that lets the editor re-derive everything from one response instead of
 * merging a write result into the list it was holding — which is where a settings screen
 * usually stops agreeing with the store.
 *
 * The ops apply in order in ONE transaction, so a refusal anywhere leaves nothing behind.
 */
export function putSettings(
  target: "statuses" | "kinds",
  ops: readonly VocabularyOp[],
  params?: { ws?: string; actor?: string },
): Promise<WorkspaceSettingsEnvelope>;
/** R6a (STA-176): registered workspace values, same batch contract, same envelope back. */
export function putSettings(
  target: "settings",
  ops: readonly SettingOp[],
  params?: { ws?: string; actor?: string },
): Promise<WorkspaceSettingsEnvelope>;
export function putSettings(
  target: "statuses" | "kinds" | "settings",
  ops: readonly (VocabularyOp | SettingOp)[],
  params: { ws?: string; actor?: string } = {},
): Promise<WorkspaceSettingsEnvelope> {
  return request<WorkspaceSettingsEnvelope>("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...params, target, ops }),
  });
}

// ---------- milestones (R3c / STA-173) ----------

/** The store's own code for a stale `baseRevision`; the page shows it as a conflict, not a refusal. */
export const REVISION_CONFLICT_CODE = "revision_conflict";

export function isRevisionConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === REVISION_CONFLICT_CODE;
}

export const getMilestones = (params: { ws?: string; all?: boolean } = {}) =>
  request<MilestoneListRow[]>(`/api/milestones${qs({ ws: params.ws, all: params.all ? "1" : undefined })}`);

export const getMilestone = (params: { ws?: string; ref: string }) =>
  request<MilestoneView>(`/api/milestone${qs(params)}`);

/**
 * Every write answers with the same `MilestoneView` a read does, and every membership
 * write carries `baseRevision` — the CAS the store checks before touching the order. A
 * stale base is `revision_conflict` (409) and the order is untouched.
 */
const milestoneWrite = (route: string, body: Record<string, unknown>) =>
  request<MilestoneView>(`/api/milestone/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...body }),
  });

export const addMilestoneMember = (target: {
  ws?: string;
  milestone: string;
  ref: string;
  baseRevision: number;
  before?: string;
  after?: string;
  at?: number;
  note?: string;
}) => milestoneWrite("add", target);

export const removeMilestoneMember = (target: { ws?: string; milestone: string; ref: string; baseRevision: number }) =>
  milestoneWrite("remove", target);

export const reorderMilestoneMembers = (target: {
  ws?: string;
  milestone: string;
  order: readonly string[];
  baseRevision: number;
}) => milestoneWrite("reorder", target);

// ---------- the glyph sanitiser (R5d / STA-184) ----------

/**
 * Sanitise a custom SVG glyph. The store accepts an `svg` appearance ONLY as the
 * sanitiser's canonical output, and the sanitiser is core code the browser cannot
 * import — so the raw document goes here first, and what comes back is the only
 * thing the picker ever offers as a choice. A refusal is the sanitiser's own sentence
 * through the usual envelope, which `describeRefusal` renders. Same-origin POST, like
 * every write, although it writes nothing: it is a pure function over the body.
 */
export const sanitizeGlyphSvg = (input: { svg: string; label?: string }) =>
  request<{ svg: string; viewBox: string; label: string }>("/api/glyph/sanitize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

// ---------- the pickup queue (R2d / STA-169) ----------

/**
 * The plan and the effective order, in ONE payload — `{revision, entries, effective}`.
 * `all` includes resolved entries, the way `getMilestones({all})` includes resolved
 * milestones; the editor ties it to the page's "show done" so one switch governs both.
 */
export const getQueue = (params: { ws?: string; all?: boolean } = {}) =>
  request<QueueView>(`/api/queue${qs({ ws: params.ws, all: params.all ? "1" : undefined })}`);

/**
 * Every queue write answers with the same `QueueView` a read does, and every one of them
 * carries `baseRevision` — the CAS the store checks before touching the plan. A stale
 * base is `revision_conflict` (409, `detail.currentRevision`) and the plan is untouched,
 * which is what lets the editor restore the server order and offer a deliberate retry
 * rather than silently replaying a write against an order it has not seen.
 *
 * The route names are the HTTP spelling from docs/queue.md "Operations, by surface"
 * (`enqueue`/`remove`), NOT the CLI's shorter verbs (`add`/`rm`). `/api/queue/move` and
 * `/api/queue/next` have no function here because nothing calls them: the editor's every
 * move is a bulk `reorder` (see views/queue/QueueView.tsx), and with no actor the next
 * item is the first `eligible` row of the `effective` list the page already holds.
 */
const queueWrite = (route: string, body: Record<string, unknown>) =>
  request<QueueView>(`/api/queue/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...body }),
  });

/** Put an issue, epic or milestone in the plan. `at` is a 1-based plan position. */
export const enqueueTask = (target: {
  ws?: string;
  ref: string;
  baseRevision: number;
  before?: string;
  after?: string;
  at?: number;
  note?: string;
}) => queueWrite("enqueue", target);

export const dequeueTask = (target: { ws?: string; ref: string; baseRevision: number }) =>
  queueWrite("remove", target);

/**
 * THE ONE ATOMIC REORDER. Drag and every keyboard move in the editor land here — one
 * call, one transaction, one revision bump — so the two input methods cannot drift into
 * two write paths that disagree about what a move is.
 */
export const reorderQueue = (target: { ws?: string; order: readonly string[]; baseRevision: number }) =>
  queueWrite("reorder", target);

/** Drop every resolved entry. `all` is not a thing here: prune takes the whole plan. */
export const pruneQueue = (target: { ws?: string; baseRevision: number }) => queueWrite("prune", target);

// ---------- projects (migration 009) ----------

/**
 * Every project, as workspace-labelled rows. With no `ws` in hub mode the server
 * answers for every workspace at once, which is what the rail lists on "all
 * workspaces"; with one, that workspace's projects only.
 */
export const getProjects = (params: { ws?: string } = {}) =>
  request<ProjectRow[]>(`/api/projects${qs(params)}`);

const projectWrite = <T>(route: string, body: Record<string, unknown>) =>
  request<T>(`/api/project/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...body }),
  });

export const createProject = (target: { ws?: string } & ProjectFieldsInput) =>
  projectWrite<ProjectRow>("create", { ...target });

export const updateProject = (target: { ws?: string; ref: string } & ProjectFieldsInput) =>
  projectWrite<ProjectRow>("update", { ...target });

/** Delete the project; every issue filed under it is let go, not deleted. */
export const deleteProject = (target: { ws?: string; ref: string }) =>
  projectWrite<ProjectRemoval>("delete", target);

/**
 * File an issue under a project (`project` is an id or a slug), or take it out
 * (`project: null`). Answers the refreshed `IssueDetail`, as the gate routes do.
 */
export const assignProject = (target: { ws?: string; ref: string; project: string | null }) =>
  projectWrite<IssueDetail>("assign", target);
