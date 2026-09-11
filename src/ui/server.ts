/**
 * staple ui — tiny local web server, alive only while you use the page.
 * Serves the single-page UI plus a JSON API over the workspace file(s).
 * No websockets, no daemon: the page polls a cheap change fingerprint.
 *
 * Loopback is not a security boundary. Any page the user visits can reach
 * 127.0.0.1 on a guessable port, so every /api/* route is gated by a
 * per-process bearer token, the write route additionally checks Origin, and
 * both read and write routes pin their HTTP method.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub, notifyHubResolvedSafe } from "../core/hub.js";
import { openWorkspace, resolveWorkspace } from "../core/workspace.js";
import {
  StapleError,
  errorEnvelope,
  type IssuePriority,
  type IssueStatus,
  type ProjectKind,
  type ProjectSourceKind,
} from "../core/types.js";
// O7b (STA-141): the closed category set and the categories the code writes into,
// both served verbatim on /api/settings so the browser never hand-keeps a copy.
import { REQUIRED_STATUS_CATEGORIES, STATUS_CATEGORIES } from "../core/types.js";
import type { SettingOp, UpdateIssueInput, VocabularyOp, WorkspaceStore } from "../core/store.js";
import type { QueueVerb } from "../core/queue-store.js";
// R6a (STA-176): the settings registry and the global values it defines, served
// beside the workspace ones so the page can say which scope each setting has.
import { settingDefinitionsFor, settingRegistryView, settingValueView } from "../core/settings-registry.js";
import { sanitizeSvg } from "../core/svg-sanitize.js";
import { readStoredRepositoryId } from "../core/repo-identity.js";
import { SurfaceAutoSync } from "../core/cloud/auto-triggers.js";
import { listConflicts, resolveConflict } from "../core/cloud/conflicts.js";
import { localCloudStatus } from "../core/cloud/status.js";
import {
  cloudSurfaceReport,
  missingIdentityRemedy,
  noIdentityReport,
} from "../core/cloud/surface.js";
import {
  hubCloudReport,
  type HubCloudReport,
  type HubWorkspaceOutcome,
  type HubWorkspaceReport,
} from "../core/cloud/hub-surface.js";
import { adoptRegistry, exportRegistry } from "../core/cloud/hub-registry.js";
/**
 * S17/S19/S21 (STA-278, STA-280, STA-282): the per-row half of the cloud surface.
 *
 * ## Why a row is a fan-out of size one, rather than a new kind of operation
 *
 * `buildHubConnectPreview`, `syncAllWorkspaces` and `performHubDisconnect` each
 * take `workspaces?: readonly HubWorkspace[]` — an injection point that
 * "replaces the hub enumeration". Handing one of them a single-element array is
 * therefore not a hack around a hub-wide API; it is the API, scoped. Everything
 * the fan-out was built to get right comes with it unchanged: the preview cannot
 * reach the network, the enumeration opens no workspace database, a failure is a
 * ROW rather than a thrown error, and the outcome is already per-workspace
 * because a fan-out had no other way to report.
 *
 * The alternative was six new core functions differing from these only in taking
 * a slug — six more places for "what counts as skippable" to drift from
 * `skipReasonFor`, which `hub-scope.ts` says in as many words is the thing it
 * exists to prevent.
 *
 * ## Why these routes do not go through `handleFor`, and must not
 *
 * `handleFor(slug)` is this server's workspace resolution, and in HUB mode it
 * does resolve a slug. In single-workspace mode — which is how `staple ui` runs
 * for a repository, and therefore the common case — it ignores the argument
 * entirely and returns the one workspace it was started on. Every existing
 * `/api/cloud/*` mutation takes `ws` and resolves it that way, which is correct
 * for those routes because they are ABOUT the workspace the dialog was opened
 * on. Reusing them for a per-row press would mean a button on the `bravo` row
 * disconnecting `alpha`, silently, on the ordinary configuration — exactly the
 * failure STA-280 names ("an action on one row does not act on another").
 *
 * So these routes address the MACHINE REGISTRY by slug and never touch `stores`.
 * `test/ui-cloud-workspace-actions.test.ts` drives them in single-workspace mode
 * for that reason and no other.
 */
import { listHubWorkspaces, reconcileRepositoryIds, type HubWorkspace } from "../core/cloud/hub-scope.js";
import { buildHubConnectPreview, type HubConnectEntry } from "../core/cloud/hub-preview.js";
import { performHubConnect, performHubDisconnect } from "../core/cloud/hub-connect.js";
import { syncAllWorkspaces } from "../core/cloud/hub-sync.js";
/**
 * S22 (STA-283): the hub's own consent.
 *
 * ONE name is taken, and deliberately not the disclosure constant: this route
 * forwards the acknowledgement the CLIENT sent rather than supplying one, so
 * having the sentence in scope here would be an invitation to satisfy the check
 * on the client's behalf. See the route for why that would spend the check
 * rather than honour it.
 *
 * Importing `hub-registry-service.js` does NOT give this file a way to publish
 * anything. Every egress path in that module begins with
 * `requireRegistryConsent`, and `setRegistryConsent` writes one file in the
 * staple home and makes no request.
 */
import {
  adoptRegistryIdentity,
  buildHubRegistryPreview,
  connectHubRegistry,
  createHubBackup,
  describeIdentityReplacement,
  listHubBackups,
  publishRegistry,
  readPublishedRegistry,
  requireHubRegistryConnection,
  requireRegistryConsent,
  restoreRegistry,
  setHubBackupConsent,
  setRegistryConsent,
} from "../core/cloud/hub-registry-service.js";
import type { AdoptionReport } from "../core/cloud/hub-registry.js";
/**
 * S13 (STA-258): the cloud MUTATIONS, which until now had no HTTP surface at all.
 *
 * `buildConnectPreview` and `ConsentTicketStore` are the pre-consent half and
 * neither can reach the network — see `core/cloud/consent.ts` for why the
 * two-step exchange below is the property and not the ceremony. `connect.js` is
 * the post-consent half and DOES import `client.ts`; every function it exports
 * takes an already-shown preview or an existing connection record as its
 * subject, so importing it here does not give this file a way to reach a service
 * nobody named.
 */
import { buildConnectPreview } from "../core/cloud/preview.js";
import { ConsentTicketStore, MAX_OUTSTANDING_CONSENTS, previewDigest } from "../core/cloud/consent.js";
import { fetchDevices, performConnect, performDisconnect, performRevoke } from "../core/cloud/connect.js";
import { readConnection, setConsent } from "../core/cloud/connection.js";
import { readConfig, stapleHome } from "../config/index.js";

interface UiOptions {
  port: number;
  hub: boolean;
  db?: string;
  ws?: string;
  /** Caller-managed credential (the CLI's persistent ~/.staple/ui-token). Absent = per-process random. */
  token?: string;
}

interface StoreHandle {
  slug: string;
  prefix: string;
  store: WorkspaceStore;
  /**
   * The database this handle was opened from.
   *
   * Carried so a refusal can say something true about WHERE this workspace is:
   * whether its identity would be recorded on the next open or has to be
   * committed from a checkout depends on the path, and a message that guessed
   * would be the wrong advice half the time. See `missingIdentityRemedy`.
   */
  dbPath: string;
}

export interface UiHandle {
  /** Per-process bearer token. A new process means a new token by design. */
  token: string;
  server: Server;
  close(): void;
}

/**
 * Where the built Vite app lives, relative to whatever file is actually running.
 *
 * Two layouts ship, and the difference is not knowable from the source tree alone:
 *
 *   repository — this module is src/ui/server.ts and `npm run build:ui` writes the
 *                bundle beside it at src/ui/app/dist/.
 *   package    — esbuild has collapsed this module into one staple.mjs at the package
 *                root and the same bundle was copied next to it as assets/. There is
 *                no src/ or app/ directory left to point at.
 *
 * Probing for the packaged layout first keeps the repository answer byte-identical:
 * src/ui/assets/index.html does not exist in a checkout, so the fallback is the only
 * reachable branch there — including before the first build, so UI_BUILD_HINT still
 * names src/ui/app/dist and still tells a developer to run `npm run build:ui`.
 */
export function resolveUiDistDir(runtimeDir: string): string {
  const packaged = resolve(runtimeDir, "assets");
  if (existsSync(join(packaged, "index.html"))) return packaged;
  return resolve(runtimeDir, "app", "dist");
}

/** The built Vite app. Read-only here — nothing in the app's toolchain is a runtime dependency. */
export const UI_DIST_DIR = resolveUiDistDir(dirname(fileURLToPath(import.meta.url)));

/** True when `npm run build:ui` has been run. */
export function uiBundleExists(): boolean {
  return existsSync(join(UI_DIST_DIR, "index.html"));
}

export const UI_BUILD_HINT =
  "The staple UI bundle is missing. Build it once with:\n\n  npm run build:ui\n\n" +
  `(expected ${join(UI_DIST_DIR, "index.html")})`;

/**
 * Shown at / when the bundle is absent, so a missing build reads as an instruction
 * rather than a blank page or a stack trace. Inline and dependency-free by necessity:
 * the thing that would serve a stylesheet is exactly what has not been built.
 */
const UNBUILT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>staple — UI not built</title>
<style>
  body { margin:0; padding:3rem 1.5rem; background:#0f1620; color:#e4ebf3;
         font:14px/1.6 ui-monospace, Menlo, Consolas, monospace; }
  main { max-width:34rem; margin:0 auto; }
  h1 { font-size:1rem; margin:0 0 0.75rem; }
  code { background:#1c2734; border-radius:4px; padding:0.15rem 0.4rem; }
  p { color:#97a6b6; }
  @media (prefers-color-scheme: light) { body { background:#f4f6f9; color:#1b2531; }
    code { background:#ecf0f5; } p { color:#5b6c7d; } }
</style></head>
<body><main>
  <h1>staple &mdash; the UI bundle has not been built</h1>
  <p>The web UI ships as a static bundle. Build it once:</p>
  <p><code>npm run build:ui</code></p>
  <p>Then reload this page. The API is already running and already authenticated &mdash;
     only the page itself is missing.</p>
</main></body></html>`;

/**
 * The queue's write routes (STA-168), one per mutating verb, spelled the same as
 * the CLI subcommands and the MCP tools. A set rather than a prefix test because
 * `/api/queue` and `/api/queue/next` share that prefix and are reads.
 */
const QUEUE_VERBS: Record<string, QueueVerb> = {
  "/api/queue/enqueue": "add",
  "/api/queue/remove": "rm",
  "/api/queue/move": "mv",
  "/api/queue/reorder": "reorder",
  "/api/queue/prune": "prune",
};
const QUEUE_WRITE_PATHS = new Set(Object.keys(QUEUE_VERBS));

/**
 * The cloud writes that must NOT arm the post-write sync trigger (S10).
 *
 * Every one of them changes this machine's relationship to the service rather
 * than the tracker's contents: there is no journalled operation behind them for a
 * sync to carry, so a trigger would produce a request with nothing in it.
 *
 * `/api/cloud/disconnect` is the one that would actually be wrong rather than
 * merely pointless — *"a person who has decided to stop talking to a service must
 * not need that service's permission to stop"* — and `/api/cloud/consent` is
 * excluded because the consent route fires its own, deliberately, and only in the
 * direction that turns automatic sync ON.
 */
const CLOUD_LIFECYCLE_WRITES = new Set([
  "/api/cloud/connect/preview",
  "/api/cloud/connect",
  "/api/cloud/disconnect",
  "/api/cloud/consent",
  "/api/cloud/devices",
  "/api/cloud/devices/revoke",
  /**
   * S17/S19/S21: the per-row routes, all six, for the same reason and one more.
   *
   * None of them journals an operation, so a post-write trigger behind them
   * would produce a request with nothing in it. `/api/cloud/workspace/sync` is
   * the one that would be actively wrong: it has just synchronized, and arming
   * the trigger would queue a second run of the thing that just finished.
   *
   * And the trigger reads its workspace from the QUERY STRING, because the body
   * has not been parsed yet and cannot be read twice (see the note where it is
   * registered). Every route here names its workspace in the BODY, so a trigger
   * on one of them would fire at the DEFAULT workspace — a sync of `alpha`
   * caused by pressing a button on `bravo`, which is the exact confusion S19
   * exists to remove.
   */
  "/api/cloud/workspace/connect/preview",
  "/api/cloud/workspace/connect",
  "/api/cloud/workspace/consent",
  "/api/cloud/workspace/disconnect",
  "/api/cloud/workspace/sync",
  "/api/hub/unregister",
  // A hub backup reads the registry and writes a file. It changes no issue, so
  // a sync trigger would be a wake-up about nothing.
  "/api/hub/backup",
  /**
   * S18 (STA-279): the four hub-wide verbs, and this is the list they most
   * belong on.
   *
   * None of them journals an operation, so a post-write trigger behind any of
   * them would produce a request with nothing in it. Two would be actively
   * wrong rather than merely pointless:
   *
   * `/api/hub/sync` has just synchronized EVERY connected workspace. Arming the
   * trigger would queue a second run of the thing that just finished, across
   * the whole machine.
   *
   * `/api/hub/disconnect` is the stronger case, and it is the same one
   * `/api/cloud/disconnect` is here for said N times over: *"a person who has
   * decided to stop talking to a service must not need that service's
   * permission to stop."* A trigger fired in the act of disconnecting every
   * workspace would be a request made in the act of ceasing to make them.
   *
   * And the trigger reads its workspace from the QUERY STRING, which none of
   * these routes has — they are about the whole registry, so there is no `ws`
   * for it to read. It would therefore fire at the DEFAULT workspace: a sync of
   * `alpha` caused by disconnecting the hub.
   */
  "/api/hub/connect/preview",
  "/api/hub/connect",
  "/api/hub/sync",
  "/api/hub/disconnect",
  /**
   * S22 (STA-283). Writes one file in the staple home and journals nothing, so a
   * post-write trigger behind it would produce a request with nothing in it —
   * and the same argument `/api/cloud/consent` is on this list for applies with
   * more force: this consent is the one that decides whether the registry may be
   * published at all, and firing a sync in the act of granting it would be a
   * request made before the thing the consent authorizes.
   */
  "/api/hub/consent",
  /**
   * STA-289: the rest of the hub registry leg. None of them journals a WORKSPACE
   * operation — they change the hub's identity, its connection, its consents, what
   * the service holds, or `hub.db` — so a post-write trigger behind any of them would
   * sync the DEFAULT workspace (the trigger reads `ws` from the query string, and
   * these have none) about nothing. Publish and restore would be actively wrong: a
   * workspace sync fired in the act of rewinding the registry is a second, unrelated
   * request riding on the most destructive one.
   */
  "/api/hub/registry/identity/mint",
  "/api/hub/registry/identity",
  "/api/hub/registry/connect/preview",
  "/api/hub/registry/connect",
  "/api/hub/registry/disconnect",
  "/api/hub/registry/publish",
  "/api/hub/registry/backup/consent",
  "/api/hub/registry/backups",
  "/api/hub/registry/backup/create",
  "/api/hub/registry/restore",
  "/api/hub/registry/adopt",
]);

/**
 * What the page shows before a hub restore — the CLI's own disclosure (`runRestore` in
 * `src/commands/hub-registry.ts`), carried to the page on the backup list and repeated
 * in the refusal a confirm-less restore gets.
 *
 * The headline and the three bullets about the SERVICE are the CLI's words verbatim;
 * `test/ui-hub-registry.test.ts` runs the CLI and compares, so the two cannot drift.
 * The last bullet is the one sentence that has to differ, because the CLI names a flag:
 * here the local half is the separate "apply" press that follows.
 */
export const HUB_RESTORE_NOTICE: { readonly headline: string; readonly bullets: readonly string[] } = {
  headline: "Restoring rewinds the registry ON THE SERVICE to this backup.",
  bullets: [
    "the service moves to a new epoch; work published since is discarded",
    "every machine on this hub id is affected, not just this one",
    "a pre-restore copy is taken first, and this prints its id",
    "your local hub is only changed if you apply the adoption that follows",
  ],
};

/**
 * The identities whose opt-out applying this adoption would retire.
 *
 * An opt-out and a registered row for one identity are contradictory records, and
 * `adoptRegistry` clears the opt-out when it applies (`decide` in
 * `src/core/cloud/hub-registry.ts`: a row holds the identity AND it is declined). That
 * write happens on a `current` row, whose outcome says "nothing to do", so without this
 * list the page announced "Nothing to apply" about an apply that still writes.
 *
 * The rule is `decide`'s, restated over the same two reads — a row holds the identity,
 * and the opt-out list names it — and `test/ui-hub-registry.test.ts` applies an
 * adoption this names and asserts the opt-out is gone, so the two cannot disagree
 * without a failing test.
 */
function optOutsAdoptionRetires(hub: Hub, report: AdoptionReport): string[] {
  const optedOut = new Set(hub.listOptOuts().map((optOut) => optOut.repositoryId));
  return report.decisions.flatMap((decision) => {
    const id = decision.entry.repositoryId;
    return id !== null && optedOut.has(id) && hub.findByRepositoryId(id) !== undefined ? [id] : [];
  });
}

/**
 * A fingerprint of an adoption PREVIEW, which is what an apply has to hand back.
 *
 * The same one-way-then-back shape as the connect ticket, sized to what adoption is:
 * it only ever writes `hub.db` and never deletes, so a digest is enough — the apply
 * re-previews, compares, and refuses if what the service holds or this machine's list
 * moved while the screen was up. Consent to a list of decisions that is no longer the
 * list is not consent.
 *
 * `capturedAt` is the one field two previews of the same state disagree on, so it is
 * the one field left out. Everything else — each decision, its sentence, the
 * cross-link counts and decisions, whatever the report grows — is in, with keys
 * sorted, so a restore's preview and the adopt route's preview of the same state
 * produce the same digest.
 */
function adoptionDigest(report: AdoptionReport): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== "capturedAt")
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, inner]) => [key, canonical(inner)]),
      );
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(report))).digest("hex");
}

/**
 * How many events GET /api/events?issue= returns — the newest N, oldest first.
 * Higher than the unfiltered route's 100 because one issue's whole life is usually
 * well under this, and a timeline that starts mid-story is worse than a long one.
 */
const ISSUE_EVENT_LIMIT = 500;

/** Extension -> content type, for the handful of things Vite actually emits. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * A JSON body field that should be a list of non-empty strings — labels, blocker refs.
 *
 * Returns undefined for anything that is not an array, which is what the store's
 * inputs already mean by "the caller did not say". Non-strings and blanks are dropped
 * rather than rejected: `["", "ui"]` from a form that split a trailing comma is a
 * one-label list, not a validation error worth a 409.
 */
/**
 * Optional idleness threshold off a JSON body. Absent stays absent (old
 * behaviour); present but not a finite number is a loud validation error rather
 * than a silent undefined, which would quietly turn an intended steal into a
 * plain checkout and report success.
 */
function optionalSeconds(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new StapleError("validation", `${name} must be a non-negative number of seconds`);
  }
  return seconds;
}

/**
 * `estimateSeconds` off a JSON body.
 *
 * Deliberately NOT `optionalSeconds`: that one collapses null to undefined,
 * which is right for an idleness threshold ("not asked for") and wrong here,
 * where null is the CLEAR. This returns undefined only for a genuinely absent
 * key and lets the store own every range refusal — one sentence, one place.
 */
function optionalEstimate(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    throw new StapleError("validation", "estimateSeconds must be a number of seconds or null");
  }
  return seconds;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}

/**
 * Resolve a URL path inside the bundle directory, or null.
 *
 * Normalizing before the prefix check is the whole guard: `/assets/../../../etc/passwd`
 * collapses to something outside UI_DIST_DIR and is refused. The `sep` suffix matters —
 * without it a sibling directory whose name merely starts with "dist" would pass.
 */
/** Hosts the browser was actually pointed at locally — the DNS-rebinding gate. */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

function resolveAsset(pathname: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return null; // malformed percent-encoding is not a path we serve
    }
  })();
  if (decoded === null || decoded.includes("\0")) return null;
  const candidate = resolve(UI_DIST_DIR, `.${normalize(decoded)}`);
  if (candidate !== UI_DIST_DIR && !candidate.startsWith(UI_DIST_DIR + sep)) return null;
  // The page itself is only served by the no-store branch above. Reaching it here
  // (e.g. /index%2ehtml) would cache a token-bearing URL to disk for a year.
  if (candidate === resolve(UI_DIST_DIR, "index.html")) return null;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

export function startUiServer(options: UiOptions): UiHandle {
  const stores = new Map<string, StoreHandle>();

  // 32 random bytes, base64url so it survives a query string untouched. This module
  // never persists it; the CLI may pass a token it keeps in a 0600 file so that
  // bookmarks survive restarts.
  const token = options.token ?? randomBytes(32).toString("base64url");
  const tokenBytes = Buffer.from(token);

  function handleFor(slug?: string): StoreHandle {
    if (options.hub) {
      const hub = Hub.open();
      try {
        const entries = hub.list().filter((e) => e.available);
        for (const entry of entries) {
          if (!stores.has(entry.slug)) {
            const ws = openWorkspace(entry.path);
            stores.set(entry.slug, {
              slug: entry.slug,
              prefix: entry.prefix,
              store: ws.store,
              dbPath: ws.dbPath,
            });
          }
        }
        const wanted = slug ?? entries[0]?.slug;
        const handle = wanted ? stores.get(wanted) : undefined;
        if (!handle) throw new StapleError("not_found", `No available workspace${slug ? ` "${slug}"` : ""}`);
        return handle;
      } finally {
        hub.close();
      }
    }
    let handle = stores.get("__single__");
    if (!handle) {
      const ws = resolveWorkspace({ db: options.db, ws: options.ws });
      handle = {
        slug: ws.store.slug,
        prefix: ws.store.prefix,
        store: ws.store,
        dbPath: ws.dbPath,
      };
      stores.set("__single__", handle);
    }
    return handle;
  }

  /**
   * The hub, or null when there isn't one this process can use.
   *
   * The read routes already open the hub inside a try/catch and degrade to an empty
   * `crossBlockers` on failure; the create branch needs the same tolerance for the same
   * reason. A hub that cannot be opened means every ref is local, which is precisely the
   * behaviour this surface had before R8 — so a broken or absent hub costs the
   * cross-workspace feature and nothing else.
   */
  function openHubSafe(): Hub | null {
    try {
      return Hub.open();
    } catch {
      return null;
    }
  }

  function allHandles(): StoreHandle[] {
    if (!options.hub) return [handleFor()];
    handleFor(); // populate cache
    return [...stores.values()];
  }

  function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(body);
  }

  /** Same envelope shape as errorEnvelope(), for the codes HTTP owns rather than the core. */
  function deny(
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    headers: Record<string, string> = {},
  ): void {
    json(res, status, { error: message, message, code, retryable: false }, headers);
  }

  /**
   * Three accepted transports. The custom header is the load-bearing one: a
   * cross-origin page cannot set it without a CORS preflight we never answer.
   * Bearer is for conventional clients, ?token= is for curl and for the page's
   * own first load.
   */
  function presentedToken(req: IncomingMessage, url: URL): string | null {
    const header = req.headers["x-staple-token"];
    if (typeof header === "string" && header) return header;
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
    return url.searchParams.get("token");
  }

  function authorized(req: IncomingMessage, url: URL): boolean {
    const presented = presentedToken(req, url);
    if (!presented) return false;
    const bytes = Buffer.from(presented);
    return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
  }

  /** Read from the live socket so --port 0 (tests) reports the port it actually got. */
  function boundPort(): number {
    const address = server.address();
    return typeof address === "object" && address ? address.port : options.port;
  }

  /**
   * An absent Origin is allowed: curl and the CLI never send one, and the token
   * already gated the request. A browser always sends Origin on a cross-origin
   * POST, which is precisely the case being rejected here. localhost is accepted
   * alongside 127.0.0.1 because both name the loopback socket this server is
   * bound to — an attacker's page is on neither.
   */
  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    const port = boundPort();
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  }

  /**
   * The machine's global settings with provenance, read fresh per request from
   * `<home>/config.json` — a file another process may have just rewritten. A
   * corrupt file surfaces as the config module's own refusal rather than as a
   * silently-default envelope, matching `staple config`.
   */
  function globalSettings(): {
    path: string;
    present: boolean;
    values: Record<string, ReturnType<typeof settingValueView>>;
  } {
    const loaded = readConfig(stapleHome());
    const explicit = new Set(loaded.explicitKeys);
    const config = loaded.config as unknown as Record<string, unknown>;
    return {
      path: loaded.path,
      present: loaded.present,
      values: Object.fromEntries(
        settingDefinitionsFor("global").map((definition) => {
          const field = definition.configKey!;
          return [
            definition.key,
            settingValueView(definition, config[field], explicit.has(field) ? "config" : "default"),
          ];
        }),
      ),
    };
  }

  function fingerprint(): string {
    return allHandles()
      .map((h) => {
        const events = h.store.db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM events").get() as { s: number };
        const issues = h.store.db
          .prepare("SELECT COUNT(*) AS c, COALESCE(MAX(updated_at),'') AS u FROM issues")
          .get() as { c: number; u: string };
        const comments = h.store.db.prepare("SELECT COUNT(*) AS c FROM comments").get() as { c: number };
        return `${h.slug}:${events.s}:${issues.c}:${issues.u}:${comments.c}`;
      })
      .join("|");
  }

  /**
   * THE DETAIL PAYLOAD — what `/api/issue` returns, and what each `/api/gate/*` write
   * answers with once it has succeeded.
   *
   * Extracted from the route by Q2 (STA-144) so the two cannot drift. A gate action
   * that answered with `store.gateIssue()`'s bare `Issue` would leave the panel to
   * refetch, and the refetch would observe a database that another agent may have
   * moved in between — so the button's own result and the panel's next render could
   * disagree about the click that produced them. Answering with the whole detail is
   * one round trip AND one consistent read.
   *
   * NOT SHARED WITH `/api/agent-context`, deliberately. That route is pinned
   * byte-for-byte against the MCP `get_task` tool by test/ui-agent-context.test.ts;
   * this one carries `workspace` and now `childrenQueued`, neither of which an agent
   * sees. The divergence is the point, and sharing a builder would erase it.
   */
  function issueDetail(handle: ReturnType<typeof handleFor>, ref: string): Record<string, unknown> {
    const context = handle.store.context(ref);
    let crossBlockers: unknown[] = [];
    try {
      const hub = Hub.open();
      try {
        crossBlockers = hub.crossBlockersOf(context.issue.identifier);
      } finally {
        hub.close();
      }
    } catch {
      crossBlockers = [];
    }
    /**
     * WHAT THIS GATE IS HOLDING — the detail panel's review checklist (Q2, STA-144;
     * rewritten by Q5, STA-154).
     *
     * Q2 built this as `identifier -> QueuedBy` over the DIRECT CHILDREN, and VP's
     * review found both halves of that wrong on one screen:
     *
     *   - DIRECT CHILDREN ONLY meant a queued grandchild had no row. Approving a
     *     parent releases its whole subtree, so a checklist that cannot show the
     *     subtree cannot show what the tick actually does.
     *   - `queuedByFor` had no notion of eligibility, so done children (STA-137,
     *     STA-138 on VP's snapshot) were listed, counted, and offered as decisions
     *     that release nothing.
     *
     * It is now `store.gateQueueOf()`: a flat PRE-ORDER ARRAY of the open descendants
     * this gate still holds, each carrying the `depth` the client indents by. The name
     * is kept because the field means the same thing it always meant — the work this
     * gate has queued — and because a shared HTTP golden pins this payload key for
     * key.
     *
     * Still the SERVER's answer and not "my parent is gated", for the reason it always
     * was: per-child approval sets a release flag the client cannot see, and that flag
     * is the entire mechanism the checklist exists to drive. And still the same
     * derivation the tree's captions and the inbox's `queued` bucket read, because
     * `gateQueueOf` is written on top of the very walk `queuedByFor` runs.
     */
    const childrenQueued = handle.store.gateQueueOf(context.issue.id);
    return {
      workspace: handle.slug,
      ...context,
      crossBlockers,
      claim: handle.store.claimActivity(context.issue.id),
      gate: handle.store.gate(context.issue.id),
      queuedBy: handle.store.queuedBy(context.issue.id),
      childrenQueued,
      // Additive: the Analytics tab's whole payload, from the one store
      // method get_task also spreads, so the two cannot drift.
      ...handle.store.detailTiming(context.issue.id),
    };
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }

  // ------------------------------------------------------------- cloud (S13, STA-258)

  /**
   * The outstanding connect consents of THIS process. See `core/cloud/consent.ts`
   * for the whole argument; the short version is that `/api/cloud/connect` has no
   * endpoint parameter, so the only way to reach a service is to hold a ticket
   * this server minted while returning the preview that named it.
   *
   * One store per server, not per workspace: a ticket already carries the
   * repository id it was built for, and the redeem path re-derives the preview
   * from that id rather than from anything the request said.
   */
  const consents = new ConsentTicketStore();

  /**
   * S10: this server's automatic-sync registration, and all of it.
   *
   * Contract: `docs/sync.md`, "Three consents" — *"After automatic — bounded
   * triggers only: startup, post-write, long-running session … Coalesced,
   * jittered backoff, cancellable, bounded timeout."*
   *
   * `resolve` hands over this server's own workspace resolution rather than
   * duplicating it: `handleFor` already knows about hub mode, and
   * `readStoredRepositoryId` is the same read `/api/cloud/status` does. A
   * workspace with no identity returns null and nothing is fired.
   *
   * Everything about *whether* it may run lives in `core/cloud/auto.ts`. Nothing
   * here checks a consent, which is the point of it being one gate rather than
   * one per surface.
   */
  const autoSync = new SurfaceAutoSync({
    home: () => stapleHome(),
    resolve: (ws) => {
      const handle = handleFor(ws);
      const repositoryId = readStoredRepositoryId(handle.store.db);
      return repositoryId === null ? null : { db: handle.store.db, repositoryId };
    },
  });

  /**
   * This workspace's sync identity, or a refusal naming why there is none.
   *
   * Same read as `/api/cloud/status` — `sync_state.repository_id`, written from
   * the manifest at open time — and the same failure mode: a workspace old enough
   * to have no table, or a global workspace that never had a manifest, has no
   * identity for a connection to be ABOUT. `/api/cloud/status` answers that with
   * `noIdentityReport()`; a mutation has to refuse, because there is nothing to
   * mutate.
   */
  function requireRepositoryId(handle: StoreHandle): string {
    let repositoryId: string | null = null;
    try {
      repositoryId = readStoredRepositoryId(handle.store.db);
    } catch {
      repositoryId = null;
    }
    if (repositoryId === null) {
      /**
       * The remedy comes from `core/cloud/surface.ts` rather than being worded
       * here, which is the whole point of that file. It used to read *"Run
       * `staple init` inside a repository to record one"* — said about a
       * workspace this server has open, whose data it is serving, and which
       * therefore plainly exists. Since STA-281 most workspaces record an
       * identity on their next open and must not be told to run anything at all.
       */
      throw new StapleError(
        "not_found",
        `This workspace is registered and its data is intact, but it has no sync identity, so ` +
          `it cannot be connected. ${missingIdentityRemedy(handle.dbPath)}`,
      );
    }
    return repositoryId;
  }

  /** The report every cloud mutation answers with, so one round trip both acts and refreshes. */
  function cloudReport(handle: StoreHandle, repositoryId: string) {
    return cloudSurfaceReport(localCloudStatus(stapleHome(), repositoryId), handle.store.db);
  }

  // ------------------------------------- the per-row cloud surface (S17/S19/S21)

  /**
   * One registered workspace, addressed by SLUG through the machine registry.
   *
   * `listHubWorkspaces()` reads the hub registry and each workspace's
   * `repository.json` and opens no workspace database — the property
   * `hub-scope.ts` exists to hold. Deliberately NOT `handleFor`: see the import
   * header. A slug that names nothing is `not_found` rather than the default
   * workspace, which is the whole difference.
   */
  function hubRowFor(res: ServerResponse, slug: unknown): HubWorkspace | null {
    const wanted = typeof slug === "string" ? slug.trim() : "";
    /**
     * A missing slug is a 400 through `deny` rather than a thrown `StapleError`,
     * and the difference is not stylistic. The catch-all at the bottom of this
     * server answers `not_found` with 404 and EVERY other staple code with 409,
     * so a thrown `validation` would arrive as "409 Conflict" for a body that is
     * simply malformed. Every other body-shape refusal on this file already uses
     * `deny(400, "validation")`; this joins them.
     *
     * There is deliberately no default. A route that fell back to "the current
     * workspace" when `slug` was absent would reintroduce, one careless client
     * call at a time, exactly the wrong-workspace defect these routes exist to
     * avoid — see the import header.
     */
    if (wanted === "") {
      deny(
        res,
        400,
        "validation",
        "A workspace slug is required. Every control on this list names the one workspace it " +
          "acts on; there is no wire spelling for 'the current one' here on purpose.",
      );
      return null;
    }
    const workspace = listHubWorkspaces().find((entry) => entry.slug === wanted);
    if (!workspace) {
      // `not_found` DOES map cleanly, so this one is thrown and lands as a 404.
      throw new StapleError(
        "not_found",
        `No workspace "${wanted}" is registered on this machine. The list is enumerated on every ` +
          `read, so a workspace unregistered a moment ago is already gone from it.`,
      );
    }
    return workspace;
  }

  /**
   * The sync identity of a row, or a refusal that says which of the two absences
   * this is.
   *
   * The single-workspace `requireRepositoryId` cannot serve here: it reads
   * `sync_state.repository_id` out of an OPEN DATABASE, and the whole point of
   * this path is that drawing and acting on a list must not open twelve of them.
   * This reads the manifest, which `listHubWorkspaces` already did.
   */
  function hubRepositoryId(workspace: HubWorkspace): string {
    if (workspace.repositoryId !== null) return workspace.repositoryId;
    throw new StapleError(
      "not_found",
      `"${workspace.slug}" has no sync identity, so there is no connection for this to act on. ` +
        (workspace.recordsIdentityOnOpen
          ? "Connecting it records one; nothing else needs doing first."
          : `It is inside a version control checkout, where ${workspace.identityDir}/repository.json ` +
            "is committed alongside the code rather than minted behind you."),
    );
  }

  /**
   * Give a row its sync identity, if opening it is what records one.
   *
   * THE ONE PLACE ON THIS PATH THAT OPENS A WORKSPACE DATABASE, and it does it
   * on a human's press, for one workspace, at the start of a connect the human
   * has asked for. `openWorkspace` reconciles the identity when the workspace is
   * not in a checkout (`src/core/open.ts`, `if (!isCheckoutBacked(dbPath))`), so
   * this is the same gesture `staple cloud connect --ws <slug>` performs — and
   * the reason the settings page can offer a plain Connect button on a row that
   * used to be told to run `staple init`.
   *
   * A no-op for every other row, including a checkout-backed one: opening that
   * would migrate a schema and produce no identity, which is a cost with no
   * benefit attached.
   */
  function recordIdentityIfOpenWould(workspace: HubWorkspace): HubWorkspace {
    if (workspace.repositoryId !== null) return workspace;
    if (!workspace.available || !workspace.recordsIdentityOnOpen) return workspace;
    const opened = openWorkspace(workspace.path);
    opened.store.db.close();
    // Re-enumerated rather than patched: the manifest is the authority for the
    // id, and reading it back is how we know the open actually recorded one.
    return listHubWorkspaces().find((entry) => entry.slug === workspace.slug) ?? workspace;
  }

  /**
   * Every per-row route's answer: what happened to this row, and the whole list
   * as it now reads.
   *
   * The refreshed list rather than the one row, for the same reason the
   * single-workspace mutations answer with a `CloudSurfaceReport`: acting and
   * re-reading are one round trip, so the page never renders the state that
   * existed before the thing it just did. It is the LIST because a per-row
   * action can change another row's rendering — the header's actionable count
   * moves, and unregistering removes a row outright.
   */
  function hubActed(res: ServerResponse, outcome: HubWorkspaceOutcome): void {
    json(res, 200, { outcome, report: hubCloudReport(stapleHome()) });
  }

  /** An outcome, stamped. Written once so six routes cannot disagree on the shape. */
  function outcomeOf(
    slug: string,
    action: HubWorkspaceOutcome["action"],
    status: HubWorkspaceOutcome["status"],
    detail: string,
  ): HubWorkspaceOutcome {
    return { slug, action, status, detail, at: new Date().toISOString() };
  }

  // ------------------------------------------- the HUB-WIDE verbs (S18, STA-279)

  /**
   * ─── WHICH ROWS A HUB-WIDE VERB WOULD VISIT ──────────────────────────────────
   *
   * Two predicates, one line each, and they deliberately do not agree with each
   * other. The disagreement is the design, and it is the same asymmetry
   * `hubRowControls` states for one row:
   *
   *   sync       needs the disk AND a connection. `syncRepository` opens the
   *              workspace database, so a row whose volume is unmounted cannot be
   *              synchronized — and `hub-scope.ts` explains at length why reaching
   *              for the missing path would be worse than useless.
   *
   *   disconnect needs a connection AND NOTHING ELSE. The record and the
   *              credential live in the staple home, so removing them for a
   *              workspace whose disk is gone is both possible and right.
   *              Refusing on `available` would leave a live credential behind for
   *              precisely the row somebody is most likely to be disconnecting.
   *
   * `row.skip` is `skipReasonFor`'s answer, decided once in `hub-scope.ts` so the
   * connect fan-out and the sync fan-out cannot drift on what "actionable" means.
   * Note it is NOT `row.actionable`, which is the broader per-BUTTON question: a
   * workspace that will record its sync identity on its next open is
   * `actionable: true` and `skip: "no_identity"`, and a fan-out will not touch it
   * because a fan-out reads files and never opens a database. Pressing that row's
   * own Connect button is what opens it. Using `actionable` here would make the
   * count promise something the fan-out then declines to do.
   *
   * ## These two predicates are stated twice, and that is a known cost
   *
   * `cloud-settings.ts` states them again, because the browser cannot import
   * `src/core` — it is a hand-kept mirror, which is the whole reason
   * `test/contract-ui-types.test.ts` exists. The page's copy decides a LABEL
   * ("Sync 2 connected workspaces"); this copy decides a REFUSAL. So a
   * divergence can only ever produce a wrong number on a button followed by an
   * honest refusal from here, never a wrong action —
   * `test/ui-cloud-hub-verbs.test.ts` asserts the two agree.
   */

  /** The rows a hub-wide SYNC would visit. */
  function hubSyncTargets(report: HubCloudReport): HubWorkspaceReport[] {
    return report.workspaces.filter((row) => row.skip === null && row.state !== "disconnected");
  }

  /** The rows a hub-wide DISCONNECT would visit. Not gated on `available`; see above. */
  function hubDisconnectTargets(report: HubCloudReport): HubWorkspaceReport[] {
    return report.workspaces.filter((row) => row.state !== "disconnected");
  }

  /**
   * Every hub-wide verb's answer: **a table, and the refreshed list.**
   *
   * A table rather than an aggregate, and this is where the recorded refusal in
   * `CloudSection.tsx` gets answered rather than overruled. The objection was
   * that a fan-out *"produces a per-workspace outcome a dialog has nowhere to
   * put"*. It is true that a toast has nowhere to put it. The remedy is not to
   * withhold the verb; it is to stop reaching for a toast.
   * `HubConnectOutcome`, `HubSyncOutcome` and `HubDisconnectOutcome` are already
   * per-workspace shapes precisely because a fan-out had no other way to report,
   * and this normalizes all three into the ONE row shape S19 already pinned —
   * so the page renders one outcome table with one renderer, and a fourth verb
   * added later cannot invent a fifth way of wording a failure.
   *
   * The refreshed report comes along for the same reason every per-row mutation
   * carries one: acting and re-reading are one round trip, so the page never
   * renders the state that existed before the thing it just did. After a
   * hub-wide verb that matters more, not less — every row's rendering moved.
   */
  function hubFanOutActed(
    res: ServerResponse,
    action: "connect" | "sync" | "disconnect",
    workspaces: HubWorkspaceOutcome[],
  ): void {
    json(res, 200, {
      fanOut: {
        action,
        at: new Date().toISOString(),
        ok: workspaces.filter((row) => row.status === "ok").length,
        skipped: workspaces.filter((row) => row.status === "skipped").length,
        failed: workspaces.filter((row) => row.status === "failed").length,
        workspaces,
      },
      report: hubCloudReport(stapleHome()),
    });
  }

  /**
   * The hub, opened for one registry route, with its stored identity — or a
   * refusal that mints nothing. STA-289.
   *
   * The service module addresses the hub through `hubRepositoryId(hub)`, which is
   * `hub.hubId()`, which MINTS when there is no id. So a publish, an adopt or a
   * connect preview on a hub with no identity would invent one on its way to
   * failing, and a later "take on the identity another machine published under"
   * would then have to replace an id nobody chose. The CLI's `requireHubId` refuses
   * up front for the same reason; this is that, for the page.
   *
   * The handle is closed however `work` ends, including across its awaits.
   */
  async function withRegistryHub<T>(work: (hub: Hub, hubId: string) => Promise<T> | T): Promise<T> {
    const hub = Hub.open();
    try {
      const hubId = hub.storedHubId();
      if (hubId === null) {
        throw new StapleError(
          "not_found",
          "This machine's hub has no registry identity yet, so there is nothing to connect, " +
            "publish, back up, restore or adopt. Mint one for an operator to provision, or take " +
            "on the identity another machine published under. Nothing was changed.",
        );
      }
      return await work(hub, hubId);
    } finally {
      hub.close();
    }
  }

  /**
   * Why a hub-wide connect has nothing to do, stated per row.
   *
   * *"Refuse with a stated reason when the fan-out would be empty, rather than
   * answering 200 with zero rows."* A 200 carrying an empty table is the worst
   * available answer: it is indistinguishable, to a reader, from a button that
   * did nothing, and it is indistinguishable to a script from success. The
   * sentences are the fan-out's own — `describeSkip`'s and `hub-preview.ts`'s —
   * because a refusal that paraphrased them would be a fifth wording of the same
   * three facts.
   */
  function hubConnectRefusal(entries: readonly HubConnectEntry[]): string {
    if (entries.length === 0) {
      return (
        "No workspaces are registered on this machine, so there is nothing to connect. " +
        "Running staple in a repository registers it, and it appears here on the next read."
      );
    }
    const rows = entries.map((entry) => `${entry.slug}: ${entry.reason}`).join(" ");
    return (
      `None of the ${entries.length} ${entries.length === 1 ? "workspace" : "workspaces"} ` +
      `registered on this machine can be connected right now, so nothing was sent. ${rows}`
    );
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      // The page itself is served without a token: it has to load in order to read the
      // token out of its own URL. Everything it then asks for is gated below.
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        if (url.pathname === "/" || url.pathname === "/index.html") {
          const index = join(UI_DIST_DIR, "index.html");
          let body: Buffer | string = uiBundleExists() ? readFileSync(index, "utf8") : UNBUILT_PAGE;
          // Loopback visitors get the token seeded into the page, so plain
          // http://localhost:4400 works with no ?token= ritual. Safe because:
          // cross-origin JS cannot read this document (same-origin policy), writes
          // stay Origin-checked regardless, and the Host check below is what stops
          // DNS rebinding — a page fetched as evil.example resolving to 127.0.0.1
          // presents Host: evil.example and gets the plain, tokenless page.
          if (typeof body === "string" && isLoopbackHost(req.headers.host)) {
            body = body.replace(
              "</head>",
              `<script>sessionStorage.setItem("staple:token", ${JSON.stringify(token)});</script></head>`,
            );
          }
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            // The token is in this page's URL until the app scrubs it. Caching the
            // page would put a credential in the disk cache for the next process to
            // find, and the bundle is on loopback anyway.
            "cache-control": "no-store",
          });
          res.end(body);
          return;
        }

        const asset = resolveAsset(url.pathname);
        if (asset) {
          res.writeHead(200, {
            "content-type": contentTypeFor(asset),
            // Vite fingerprints these filenames, so a hit is always the right bytes.
            "cache-control": "public, max-age=31536000, immutable",
          });
          res.end(readFileSync(asset));
          return;
        }
      }

      // One gate in front of the whole API. Auth precedes method so an
      // unauthenticated caller cannot map the surface by telling 404 from 405.
      if (url.pathname.startsWith("/api/")) {
        if (!authorized(req, url)) {
          deny(
            res,
            401,
            "unauthorized",
            "Missing or invalid token. Open the URL `staple ui` printed, or send X-Staple-Token.",
          );
          return;
        }
        /**
         * WHICH METHODS EACH ROUTE ACCEPTS — and therefore, since every POST is
         * Origin-checked below, which routes can be WRITTEN at all.
         *
         * Two widenings met here and both are load-bearing. Q2 (STA-144) turned a
         * comparison against one literal into a predicate over the `/api/gate/`
         * FAMILY, which is a security change rather than a tidying one: written as
         * `pathname === "/api/action"`, every new POST route would have defaulted
         * to GET-only, been answered with 405 for the POST it actually is, and —
         * had anyone "fixed" that by special-casing the method further down —
         * sailed past the Origin check entirely. On a loopback server that holds
         * the whole tracker, that is a cross-origin-writable endpoint. O7b
         * (STA-141) then added `/api/settings`, the one route that READS AND
         * WRITES on the same path, which is why `expected` is a LIST rather than a
         * string.
         *
         * So the rule is stated once, here, in front of everything, and a route
         * not named below is unchanged: GET only.
         * `test/ui-gate-routes.test.ts` pins all three gate refusals.
         */
        const expected =
          url.pathname === "/api/action" ||
          url.pathname === "/api/glyph/sanitize" ||
          url.pathname.startsWith("/api/gate/") ||
          url.pathname.startsWith("/api/milestone/") ||
          /**
           * The project writes. `/api/projects` (plural) is the read and does not
           * share this prefix, so the family test admits no read.
           */
          url.pathname.startsWith("/api/project/") ||
          /**
           * The queue's mutating verbs (STA-168). `/api/queue` and
           * `/api/queue/next` are READS and are deliberately NOT in this list, so
           * naming the family by prefix the way the gate routes do would have
           * made two reads cross-origin-writable. The verbs are therefore named.
           */
          QUEUE_WRITE_PATHS.has(url.pathname) ||
          /**
           * Settling a sync conflict. Named, not prefixed, for the same reason
           * the queue's verbs are: `/api/cloud/conflicts` and
           * `/api/cloud/status` are reads sharing the prefix, and a family rule
           * would have made both cross-origin-writable.
           */
          url.pathname === "/api/cloud/conflicts/resolve" ||
          /**
           * S13 (STA-258): the cloud mutations. Named individually for the same
           * reason the conflict verb is — `/api/cloud/status` and
           * `/api/cloud/conflicts` are reads under the same prefix, and a family
           * rule would make both cross-origin-writable.
           *
           * `/api/cloud/devices` is in this list although it READS. It is here
           * because it LEAVES THE MACHINE: it presents this device's credential
           * to the endpoint and asks who else is enrolled. The GET default exists
           * for routes that touch local state, and a route that reaches
           * Cloudflare belongs behind the Origin check with the writes — a
           * cross-origin page that could make this server call out has made a
           * request the user never authorized, whether or not anything changed.
           *
           * There is deliberately NO `/api/cloud/purge`. `staple cloud purge`
           * requires the repository id typed back, and the service checks it on
           * the wire (STA-256). That proves the caller knew the id, which this
           * page knows as well as a person does; it cannot prove anybody read the
           * disclosure. A one-click irreversible remote deletion behind a browser
           * session is not a thing to add.
           */
          url.pathname === "/api/cloud/connect/preview" ||
          url.pathname === "/api/cloud/connect" ||
          url.pathname === "/api/cloud/disconnect" ||
          url.pathname === "/api/cloud/consent" ||
          url.pathname === "/api/cloud/devices" ||
          url.pathname === "/api/cloud/devices/revoke" ||
          /**
           * S17/S19/S21: the per-row routes. Named individually, like every
           * cloud route above and for the same reason — `/api/cloud/status`,
           * `/api/cloud/conflicts` and `/api/cloud/workspaces` are READS under
           * the shared prefix, and a `startsWith("/api/cloud/")` family rule
           * would make all three cross-origin-writable in one line.
           *
           * `/api/hub/unregister` is the only `/api/hub/` route and is still
           * named rather than prefixed, so that adding a `/api/hub/…` READ later
           * does not inherit a write pin nobody asked for.
           */
          url.pathname === "/api/cloud/workspace/connect/preview" ||
          url.pathname === "/api/cloud/workspace/connect" ||
          url.pathname === "/api/cloud/workspace/consent" ||
          url.pathname === "/api/cloud/workspace/disconnect" ||
          url.pathname === "/api/cloud/workspace/sync" ||
          url.pathname === "/api/hub/unregister" ||
          url.pathname === "/api/hub/backup" ||
          /**
           * S18 (STA-279): the four HUB-WIDE verbs. Named individually, like
           * every cloud and hub route above, and the reason is sharper here
           * than anywhere else on this list.
           *
           * `/api/hub/` now holds six routes and will hold reads later — a
           * `startsWith("/api/hub/")` family rule would pin those reads as
           * cross-origin-writable the day somebody adds one, which is a
           * security change disguised as a tidying. Worse, this family is the
           * one where a mistake is machine-wide: a cross-origin page that
           * could POST `/api/hub/disconnect` would remove every credential on
           * the machine in one request.
           *
           * `/api/hub/sync` is on this list for what it WRITES and for what it
           * SENDS. It is the third route on this server that leaves the
           * machine, after `/api/cloud/devices` and
           * `/api/cloud/workspace/sync`, and it leaves it once per connected
           * workspace — so it is the single route here with the largest
           * outbound blast radius, and the one most obviously belonging behind
           * the Origin check.
           *
           * There is deliberately NO `/api/hub/purge`, for the reason
           * `/api/cloud/purge` does not exist and more so: the confirmation
           * the service checks (STA-256) proves the caller knew an id, not
           * that a person read what it destroys, and a one-click irreversible
           * remote deletion of every workspace at once is not a thing to add.
           */
          url.pathname === "/api/hub/connect/preview" ||
          url.pathname === "/api/hub/connect" ||
          url.pathname === "/api/hub/sync" ||
          url.pathname === "/api/hub/disconnect" ||
          /**
           * S22 (STA-283). Named like its five siblings and never by prefix. It
           * writes the consent that gates publishing this machine's workspace
           * list, so a cross-origin page able to POST it could turn on the one
           * disclosure the product asks for most explicitly.
           */
          url.pathname === "/api/hub/consent" ||
          /**
           * STA-289: the rest of the hub registry leg, eleven routes, each named.
           *
           * Named rather than matched by a `/api/hub/registry/` prefix for the
           * reason every hub route above is: a family rule would pin the next READ
           * added under that prefix as cross-origin-writable. Seven of these leave
           * the machine (connect, publish, backup consent, the backup list, backup
           * create, restore, and adopt's read of the service), and a POST behind the Origin
           * check is where a route that reaches a service belongs — a cross-origin
           * page that could make this server rewind a registry has made the most
           * destructive request on the page without anybody pressing anything.
           */
          url.pathname === "/api/hub/registry/identity/mint" ||
          url.pathname === "/api/hub/registry/identity" ||
          url.pathname === "/api/hub/registry/connect/preview" ||
          url.pathname === "/api/hub/registry/connect" ||
          url.pathname === "/api/hub/registry/disconnect" ||
          url.pathname === "/api/hub/registry/publish" ||
          url.pathname === "/api/hub/registry/backup/consent" ||
          url.pathname === "/api/hub/registry/backups" ||
          url.pathname === "/api/hub/registry/backup/create" ||
          url.pathname === "/api/hub/registry/restore" ||
          url.pathname === "/api/hub/registry/adopt"
            ? ["POST"]
            : url.pathname === "/api/settings"
              ? ["GET", "POST"]
              : ["GET"];
        const allow = expected.join(", ");
        if (!expected.includes(req.method ?? "")) {
          deny(res, 405, "method_not_allowed", `${url.pathname} accepts ${allow} only`, { allow });
          return;
        }
        /**
         * Keyed on the ACTUAL method rather than on the pinned one, which is the
         * only change the settings route required here: a POST is Origin-checked
         * wherever it lands, and a GET on a read/write path is not — same guard,
         * same sentence, now stated about the request instead of about the route.
         */
        if (req.method === "POST" && !originAllowed(req)) {
          deny(res, 403, "forbidden", `Cross-origin request rejected (Origin: ${req.headers.origin})`);
          return;
        }

        /**
         * S10: the post-write trigger, registered ONCE, for every mutating route.
         *
         * On `finish` rather than inline, which buys two properties that matter
         * more than the brevity. The response is already on the wire, so the
         * trigger cannot delay a write no matter what the link is doing — the
         * page's latency is unchanged whether this machine is in automatic mode or
         * not. And `res.statusCode` is settled, so a refused or failed write does
         * not produce a request to Cloudflare: only work that actually happened is
         * worth telling anybody about.
         *
         * `CLOUD_LIFECYCLE_WRITES` is excluded because none of them journals
         * anything. Connecting, disconnecting and listing devices change this
         * machine's relationship to the service; there is no new operation for a
         * sync to carry, and firing one on `disconnect` in particular would be a
         * request made in the act of stopping.
         *
         * KNOWN LIMIT, stated rather than hidden: the workspace is read from the
         * query string because the body has not been parsed yet and cannot be read
         * twice. In single-workspace mode — every connected repository today —
         * that is exact. In hub mode a write that named its workspace only in the
         * body triggers the default workspace instead; the named one still syncs
         * on its session tick. Fixing it properly means threading the resolved
         * handle out of the route, which is not a thin registration.
         */
        if (req.method === "POST" && !CLOUD_LIFECYCLE_WRITES.has(url.pathname)) {
          const ws = url.searchParams.get("ws") ?? undefined;
          res.once("finish", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) autoSync.postWrite(ws);
          });
        }
      }

      if (url.pathname === "/api/bootstrap") {
        const handles = allHandles();
        json(res, 200, {
          mode: options.hub ? "hub" : "workspace",
          workspaces: handles.map((h) => ({ slug: h.slug, prefix: h.prefix })),
        });
        return;
      }

      /**
       * `GET /api/cloud/status` — read-only, and network-free by construction.
       *
       * `docs/sync.md`, on what a surface may do before a repository is
       * connected: *"render 'not connected' and a static hint naming
       * `staple cloud connect`. Static text. No probe, no reachability check, no
       * 'we noticed you might want to connect'. The UI does not prompt."*
       *
       * So this route exists precisely so the UI does NOT have to guess, and it
       * deliberately has no `refresh` parameter. `localCloudStatus` reads files;
       * there is no argument that can make it call out. A polled UI with a
       * refreshing status endpoint would turn one human's page-open into a
       * heartbeat to Cloudflare every few seconds, which is a telemetry channel
       * arrived at by accident — and *"no telemetry, no update check, no
       * discovery request, ever."*
       *
       * GET-only falls out of the method table above, which defaults every route
       * not named there to GET. This one must never be named there.
       *
       * Identity comes from `sync_state.repository_id` rather than the manifest
       * because the server holds a database handle and not a path. That row is
       * written from the manifest at open time by `reconcileRepositoryIdentity`,
       * so it is the same id — and on a workspace old enough not to have the
       * table, the read fails closed to "disconnected", which is true.
       */
      if (url.pathname === "/api/cloud/status") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        let repositoryId: string | null = null;
        try {
          repositoryId = readStoredRepositoryId(handle.store.db);
        } catch {
          repositoryId = null;
        }
        /**
         * STA-75: both branches now return `CloudSurfaceReport` verbatim — the
         * same object `cloud_status` returns over MCP and `staple cloud status
         * --json` prints. This route used to re-map nine fields by hand and word
         * its own "no sync identity" sentence, and `src/mcp.ts` did both again,
         * slightly differently. One contract, four renderings; the mapping lives
         * in `core/cloud/surface.ts` and nowhere else.
         */
        json(
          res,
          200,
          repositoryId === null
            ? noIdentityReport(handle.dbPath)
            : cloudSurfaceReport(localCloudStatus(stapleHome(), repositoryId), handle.store.db),
        );
        return;
      }

      /**
       * `GET /api/cloud/workspaces` — every registered workspace and its own
       * connection state. STA-275.
       *
       * ## Why this is a separate route and not a field on `/api/cloud/status`
       *
       * `/api/cloud/status` is about ONE workspace and returns a
       * `CloudSurfaceReport`, which carries counters read out of that
       * workspace's database. Folding a list into it would either make the list
       * carry counters — N databases opened and migrated per poll of the
       * settings page — or make the response shape depend on a query parameter,
       * which the UI type mirror could not express.
       *
       * So the list is its own route with its own type, and everything on it
       * comes from files: the hub registry, each workspace's `repository.json`,
       * and the connection records in the staple home. No workspace database is
       * opened by this handler at all.
       *
       * ## Silent, with no `--refresh` equivalent and deliberately no way to add one
       *
       * `hubCloudReport` cannot reach the transport — nothing in its import
       * graph does — so this route is silent by construction rather than by
       * discipline. There is no `?refresh` parameter here and there must never
       * be: a refresh across a hub is one authenticated round trip per
       * workspace, and this page polls. That is *"one human's page-open into a
       * heartbeat to Cloudflare"* with a multiplier on it.
       *
       * `probeCredentials` is likewise NOT passed. Establishing whether each
       * credential is really present means a `security(1)` subprocess per
       * workspace on macOS, and this response is rendered every few seconds.
       * `credentialPresent` therefore comes back `null`, which the type says
       * means "not asked" — an honest third value. `staple cloud status --all`,
       * typed once by a human, is where the probe happens.
       */
      if (url.pathname === "/api/cloud/workspaces") {
        json(res, 200, hubCloudReport(stapleHome()));
        return;
      }

      /**
       * `GET /api/cloud/conflicts` — what two devices disagree about.
       *
       * A local read of one table, so it is available in every cloud state
       * including disconnected: a repository that has synced and then been
       * disconnected still holds its conflicts, and hiding them behind a
       * connection check would make an unsettled decision invisible for as long
       * as the credential was gone.
       */
      if (url.pathname === "/api/cloud/conflicts") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        const includeResolved = url.searchParams.get("all") === "1";
        json(res, 200, {
          conflicts: listConflicts(handle.store.db, { includeResolved }),
        });
        return;
      }

      /**
       * `POST /api/cloud/conflicts/resolve` — settle one, from the page.
       *
       * `{ id, take?: "local" | "remote", value?, actor?, ws? }`. Exactly one of
       * `take` and `value` — a resolve with neither is a `validation` error
       * rather than a default, because a default here is the last-write-wins the
       * whole feature removes.
       *
       * No decision is made in this file: the refusals for "already resolved",
       * "no such conflict" and "custom with no value" all live in
       * `resolveConflict`, with one wording that every surface repeats.
       */
      if (url.pathname === "/api/cloud/conflicts/resolve") {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const take = body.take as "local" | "remote" | undefined;
        if ((take === undefined) === (body.value === undefined)) {
          deny(
            res,
            400,
            "validation",
            'Pass exactly one of take ("local" or "remote") and value.',
          );
          return;
        }
        json(
          res,
          200,
          resolveConflict(handle.store.db, {
            id: body.id as string,
            choice: take ?? "custom",
            value: body.value,
            actor: (body.actor as string) || "ui",
          }),
        );
        return;
      }

      /**
       * `POST /api/cloud/connect/preview` — step one of two, and the only place
       * an endpoint may be named.
       *
       * Local by construction: `buildConnectPreview` parses a URL, reads the
       * connection record and the device id, and probes the credential store. It
       * cannot reach the network, because `preview.ts` does not import
       * `client.ts` — *"the way to keep a consent mechanism from quietly
       * acquiring a network call is not to remember not to add one; it is to
       * build it somewhere a network call cannot be written."*
       *
       * A POST although it computes rather than commits, because it takes a body
       * and because it has one local side effect worth the Origin check: probing
       * the OS keychain writes and deletes a sentinel item, which on macOS can
       * raise an unlock prompt. That is not a page another origin gets to summon.
       *
       * The response carries the preview AND a consent ticket minted from it.
       * The ticket is the only thing `/api/cloud/connect` will accept, which is
       * what makes "shown before asked" a property of the wire rather than of the
       * client.
       */
      if (url.pathname === "/api/cloud/connect/preview") {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const repositoryId = requireRepositoryId(handle);
        const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
        if (endpoint === "") {
          deny(res, 400, "validation", "An endpoint is required to preview a connection.");
          return;
        }
        /**
         * `credentialFile` is `staple cloud connect --credential-file`, offered
         * here for the same reason it is offered there: on a machine whose
         * keychain prompts, or whose keychain the user would rather staple stayed
         * out of, the honest `0600` file is a legitimate choice. The preview then
         * SAYS "a 0600 file in your staple home", so the choice is part of what
         * consent is given to rather than a setting hidden behind it.
         */
        const context = { credentialFile: body.credentialFile === true };
        const preview = buildConnectPreview({
          home: stapleHome(),
          repositoryId,
          endpoint,
          label: typeof body.label === "string" ? body.label : undefined,
          credential: { forceFile: context.credentialFile },
        });
        json(res, 200, { preview, consent: consents.mint(preview, context) });
        return;
      }

      /**
       * `POST /api/cloud/connect` — step two. **No endpoint. No repository id.**
       *
       * `{ consent, digest, token }`, and the absence of the first two fields is
       * the design. There is no wire spelling for "connect to X": the endpoint is
       * a field of the PREVIEW RESPONSE and appears in no request this server
       * accepts. The only thing a connect may carry is an id minted while a
       * preview was being returned, so the description of what is about to happen
       * was necessarily delivered to the client first.
       *
       * The preview is REBUILT here from local state rather than taken from the
       * ticket alone, and the two digests are compared: the ticket's (what the
       * human read) against the rebuilt one (what is true now). A repository that
       * was connected by another process, or a keychain that locked and pushed the
       * credential to a `0600` file, changes something the preview asserted, and
       * consent to a sentence that is no longer true is not consent.
       *
       * `token` is the enrollment credential and is the one secret on this route.
       * It is never stored by this file, never logged, and never echoed: the
       * response is the connection record and the surface report, and
       * `CloudConnection` deliberately does not contain the credential.
       */
      if (url.pathname === "/api/cloud/connect") {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const repositoryId = requireRepositoryId(handle);
        const enrollmentSecret = typeof body.token === "string" ? body.token : "";

        /**
         * Redeem first, connect second. `redeem` consumes the ticket, re-derives
         * the preview THROUGH THE TICKET'S OWN endpoint — the callback is how the
         * endpoint gets here at all — and refuses on a mismatch. Every refusal on
         * this path happens before a socket is opened, which is what makes
         * "nothing was sent" a true sentence in each of those messages.
         */
        const { preview, context } = consents.redeem(body.consent, body.digest, (stored, choices) =>
          buildConnectPreview({
            home: stapleHome(),
            repositoryId,
            endpoint: stored.endpoint.origin,
            label: stored.label,
            credential: { forceFile: choices.credentialFile },
          }),
        );

        const outcome = await performConnect(preview, {
          home: stapleHome(),
          enrollmentSecret,
          credential: { forceFile: context.credentialFile },
        });

        json(res, 200, {
          connection: outcome.connection,
          capabilities: outcome.capabilities,
          credentialLocation: outcome.credentialLocation,
          report: cloudReport(handle, repositoryId),
        });
        return;
      }

      /**
       * `POST /api/cloud/disconnect` — local, and only local.
       *
       * *"Disconnect is local. It removes this device's credential, stops all
       * later cloud traffic, and preserves the entire local database including
       * pending outbox operations."* So this route makes NO network call, not
       * even a courtesy "please forget me": a person who has decided to stop
       * talking to a service must not need that service's permission to stop.
       * Revoking the device server-side is the separately named operation below.
       *
       * `confirm` is the CLI's `--yes`, restated. Nothing irreversible happens —
       * the workspace database is untouched — but the credential goes, and a
       * re-connect needs an enrollment secret the user may not have to hand.
       */
      if (url.pathname === "/api/cloud/disconnect") {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const repositoryId = requireRepositoryId(handle);
        if (body.confirm !== true) {
          deny(
            res,
            400,
            "validation",
            "Disconnecting removes this machine's credential for this repository. Pass " +
              "confirm to proceed. Your local database, including pending operations, is not " +
              "touched.",
          );
          return;
        }
        const outcome = performDisconnect(stapleHome(), repositoryId);
        json(res, 200, { ...outcome, report: cloudReport(handle, repositoryId) });
        return;
      }

      /**
       * `POST /api/cloud/consent` — the two later consents, one at a time.
       *
       * `{ auto: boolean }` OR `{ backup: boolean }`, and **exactly one**. Two
       * consents are two decisions; a body carrying both would let one click
       * spend both, which is the shape `docs/sync.md` separates them to prevent.
       *
       * This writes a file in the staple home — `setConsent` — and nothing else.
       * It is emphatically NOT a workspace setting and never touches
       * `/api/settings`: the workspace database synchronizes, so an `auto` flag
       * stored there would replicate and turn one laptop's decision into a fleet
       * policy. See the header of `core/cloud/connection.ts`.
       *
       * `setConsent` refuses `not_found` on an unconnected repository rather than
       * springing a record into existence, so turning automatic sync on before
       * connecting is an error and not a silent partial connection.
       */
      if (url.pathname === "/api/cloud/consent") {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const repositoryId = requireRepositoryId(handle);
        const named = ["auto", "backup"].filter((key) => body[key] !== undefined);
        if (named.length !== 1 || typeof body[named[0]!] !== "boolean") {
          deny(
            res,
            400,
            "validation",
            "Pass exactly one of auto and backup, as a boolean. They are two separate consents " +
              "and are changed one decision at a time.",
          );
          return;
        }
        const key = named[0] as "auto" | "backup";
        setConsent(stapleHome(), repositoryId, { [key]: body[key] as boolean });
        json(res, 200, { report: cloudReport(handle, repositoryId) });
        /**
         * S10: **this route fires no trigger, in either direction.** It writes one
         * file and answers, exactly as it did before automatic sync existed.
         *
         * Firing one on the way ON was the obvious thing to want — a human just
         * said "keep this device up to date", and making them wait for a session
         * tick is a poor first impression. It was written, and then removed,
         * because S13 pinned this route as silent on purpose (`test/network-
         * silence.test.ts`, *"Turning a consent on and off is a local file write
         * and must say nothing to anybody"*), and a lane that quietly relaxed
         * another lane's assertion to make its own feature feel snappier would be
         * spending a guarantee it does not own. The route that SPENDS a consent
         * does one thing; the next trigger — a write, or the session tick — is
         * what acts on it.
         *
         * On the way OFF there is nothing to fire and nothing to send. Stopping is
         * the absence of requests, and the gate is what produces that absence:
         * every later trigger reads `auto: false` and returns before
         * `core/cloud/sync.js` is so much as loaded. A run already in flight is
         * bounded by its own budget. There is deliberately no "tell the service we
         * stopped" either — a device that announced its withdrawal would be making
         * a request in the act of ceasing to make them.
         */
        return;
      }

      /**
       * `POST /api/cloud/devices` — the server's device list, which is the
       * authority.
       *
       * **This route egresses.** It is the only read on this server that does, it
       * is a POST for exactly that reason (see the method gate), and it is never
       * called on mount: the settings section renders its whole connected state
       * from `/api/cloud/status`, which is network-free, and asks for devices only
       * when a human presses the button. A panel that listed devices on open would
       * turn opening settings into a request to Cloudflare — the shape
       * `docs/sync.md` calls a heartbeat arrived at by accident.
       */
      if (url.pathname === "/api/cloud/devices") {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const repositoryId = requireRepositoryId(handle);
        json(res, 200, { devices: await fetchDevices(stapleHome(), repositoryId) });
        return;
      }

      /**
       * `POST /api/cloud/devices/revoke` — end one device's access, from here.
       *
       * Revoking THIS device is allowed and is a real thing to want: a stolen
       * laptop is revoked from the laptop you still have. `performRevoke` reports
       * it as `self` rather than refusing, and deliberately leaves the local
       * credential in place — it is already useless, and deleting it would
       * conflate revoke with disconnect, which the contract insists on keeping
       * apart.
       *
       * `confirm` because this one is not undoable from here: a revoked device
       * re-enrols with `staple cloud connect` and an enrollment secret, which is
       * a trip to another machine.
       */
      if (url.pathname === "/api/cloud/devices/revoke") {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const repositoryId = requireRepositoryId(handle);
        const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
        if (deviceId === "") {
          deny(res, 400, "validation", "A deviceId is required.");
          return;
        }
        if (body.confirm !== true) {
          deny(
            res,
            400,
            "validation",
            "Revoking ends that device's access on its very next request. Pass confirm to " +
              "proceed. Its local data and pending work are untouched.",
          );
          return;
        }
        const outcome = await performRevoke(stapleHome(), repositoryId, deviceId);
        json(res, 200, { ...outcome, report: cloudReport(handle, repositoryId) });
        return;
      }

      /**
       * ─── THE PER-ROW CLOUD SURFACE — S17/S19/S21 ────────────────────────────
       *
       * Five routes under `/api/cloud/workspace/`, each naming the ONE workspace
       * it acts on, plus `/api/hub/unregister` below. Read the import header for
       * why these exist beside the `/api/cloud/*` routes rather than replacing
       * them: those are about the workspace the dialog was opened on and resolve
       * through `handleFor`; these are about a row in a machine-wide list and
       * resolve through the registry.
       *
       * The shape is uniform on purpose. Every one of them answers
       * `{ outcome, report }` — what happened to this row, and the refreshed
       * list — so the surface has one thing to render and cannot end up with six
       * differently-worded outcome lines.
       */

      /**
       * `POST /api/cloud/workspace/connect/preview` — step one, for one row.
       *
       * The single-workspace `/api/cloud/connect/preview` remains the only OTHER
       * route that may name an endpoint, and this one inherits every property of
       * it: `buildHubConnectPreview` imports `preview.ts`, `connection.ts`,
       * `credential-store.ts`, `endpoint.ts` and `hub-scope.ts` and **nothing
       * that reaches `client.ts`** — a walk `test/cloud-hub-connect.test.ts`
       * makes transitively. So this cannot contact the service it is describing,
       * and that is a property of the import graph rather than of this handler's
       * restraint.
       *
       * A skipped row answers with `preview: null` and the fan-out's own sentence
       * for WHY, and mints no ticket. A ticket for something that will not happen
       * would be a consent with no subject.
       */
      if (url.pathname === "/api/cloud/workspace/connect/preview") {
        const body = await readBody(req);
        const addressed = hubRowFor(res, body.slug);
        if (addressed === null) return;
        const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
        if (endpoint === "") {
          deny(res, 400, "validation", "An endpoint is required to preview a connection.");
          return;
        }
        const credentialFile = body.credentialFile === true;
        /**
         * Before the preview, not after: a workspace that records its identity
         * on open has none to preview a connection FOR until it has been opened.
         * This is the whole of STA-281's remedy expressed as a button.
         */
        const workspace = recordIdentityIfOpenWould(addressed);
        const preview = buildHubConnectPreview({
          home: stapleHome(),
          endpoint,
          label: typeof body.label === "string" ? body.label : undefined,
          credential: { forceFile: credentialFile },
          workspaces: [workspace],
        });
        const entry = preview.entries[0]!;
        json(res, 200, {
          slug: workspace.slug,
          action: entry.action,
          /** The fan-out's sentence for this row, skipped or not. Never invented here. */
          reason: entry.reason,
          preview: entry.preview,
          consent: entry.preview === null ? null : consents.mint(entry.preview, { credentialFile }),
          report: hubCloudReport(stapleHome()),
        });
        return;
      }

      /**
       * `POST /api/cloud/workspace/connect` — step two. **No endpoint.**
       *
       * `{ slug, consent, digest, token }`. The absence of an endpoint field is
       * the same structural guarantee `/api/cloud/connect` gives, and it is worth
       * restating that adding a slug did not weaken it: a slug names a workspace
       * this machine already has registered, and no arrangement of registered
       * workspaces can spell a service address.
       *
       * The slug is checked AGAINST THE TICKET, in the rebuild callback. A client
       * that previewed `alpha` and posted the resulting ticket with `slug:
       * "bravo"` would otherwise reach the digest comparison and be refused with
       * "this machine's connection state changed" — true in a sense, and the
       * wrong sentence entirely. Refused here instead, by name.
       */
      if (url.pathname === "/api/cloud/workspace/connect") {
        const body = await readBody(req);
        const workspace = hubRowFor(res, body.slug);
        if (workspace === null) return;
        const repositoryId = hubRepositoryId(workspace);
        const enrollmentSecret = typeof body.token === "string" ? body.token : "";

        const { preview, context } = consents.redeem(body.consent, body.digest, (stored, choices) => {
          if (stored.repositoryId !== repositoryId) {
            throw new StapleError(
              "validation",
              `That confirmation was issued for a different workspace, so it cannot be used to ` +
                `connect "${workspace.slug}". Nothing was sent. Review the connection for this ` +
                `workspace and confirm what that shows.`,
            );
          }
          return buildConnectPreview({
            home: stapleHome(),
            repositoryId,
            endpoint: stored.endpoint.origin,
            label: stored.label,
            credential: { forceFile: choices.credentialFile },
          });
        });

        const outcome = await performConnect(preview, {
          home: stapleHome(),
          enrollmentSecret,
          credential: { forceFile: context.credentialFile },
        });
        hubActed(
          res,
          outcomeOf(
            workspace.slug,
            "connect",
            "ok",
            `Connected to ${outcome.connection.endpoint}. The credential for this machine is in ` +
              `${outcome.credentialLocation}. Automatic sync and backup are off — they are ` +
              `separate decisions.`,
          ),
        );
        return;
      }

      /**
       * `POST /api/cloud/workspace/consent` — the two later consents, for one row.
       *
       * `{ slug, auto }` OR `{ slug, backup }`, and exactly one, for the reason
       * `/api/cloud/consent` gives: two consents are two decisions and a body
       * carrying both would let one press spend both.
       *
       * Writes one file in the staple home and opens no database at all — which
       * is why a row can carry these toggles without the page paying for twelve
       * schema migrations to draw them. Fires no sync trigger, in either
       * direction; see `CLOUD_LIFECYCLE_WRITES` and the note on the
       * single-workspace consent route, which this deliberately copies rather
       * than improves on.
       */
      if (url.pathname === "/api/cloud/workspace/consent") {
        const body = await readBody(req);
        const workspace = hubRowFor(res, body.slug);
        if (workspace === null) return;
        const repositoryId = hubRepositoryId(workspace);
        const named = ["auto", "backup"].filter((key) => body[key] !== undefined);
        if (named.length !== 1 || typeof body[named[0]!] !== "boolean") {
          deny(
            res,
            400,
            "validation",
            "Pass exactly one of auto and backup, as a boolean. They are two separate consents " +
              "and are changed one decision at a time.",
          );
          return;
        }
        const key = named[0] as "auto" | "backup";
        const value = body[key] as boolean;
        // `setConsent` refuses `not_found` on an unconnected repository rather
        // than springing a record into existence, so this cannot become a silent
        // partial connection.
        setConsent(stapleHome(), repositoryId, { [key]: value });
        hubActed(
          res,
          outcomeOf(
            workspace.slug,
            key,
            "ok",
            key === "auto"
              ? value
                ? "Automatic sync is on for this workspace, on this machine only."
                : "Automatic sync is off. Nothing is uploaded until a sync is run."
              : value
                ? "Backup is on for this workspace, on this machine only. It does not turn on sync."
                : "Backup is off. No snapshot will be taken.",
          ),
        );
        return;
      }

      /**
       * `POST /api/cloud/workspace/disconnect` — local, and only local.
       *
       * `performHubDisconnect` is **not** gated on `available`, deliberately, and
       * this route inherits that: the connection record and the credential live
       * in the staple home rather than in the workspace, so disconnecting a
       * workspace whose disk is unmounted is both possible and right. Refusing
       * would leave a live credential behind for precisely the row somebody is
       * most likely to be disconnecting — which is why the surface keeps this one
       * control enabled on a row where everything else is disabled.
       */
      if (url.pathname === "/api/cloud/workspace/disconnect") {
        const body = await readBody(req);
        const workspace = hubRowFor(res, body.slug);
        if (workspace === null) return;
        if (body.confirm !== true) {
          deny(
            res,
            400,
            "validation",
            `Disconnecting removes this machine's credential for "${workspace.slug}". Pass ` +
              "confirm to proceed. Its database, including pending operations and unsettled " +
              "conflicts, is not touched, and no other device is affected.",
          );
          return;
        }
        const row = performHubDisconnect(stapleHome(), { workspaces: [workspace] }).workspaces[0]!;
        hubActed(
          res,
          outcomeOf(
            workspace.slug,
            "disconnect",
            // `failed` is reachable on a single row too — an unreadable
            // connection record — and reporting it as `skipped` would say
            // "nothing needed doing" about a credential still sitting there.
            row.status === "disconnected" ? "ok" : row.status === "failed" ? "failed" : "skipped",
            row.reason,
          ),
        );
        return;
      }

      /**
       * `POST /api/cloud/workspace/sync` — **this route egresses.**
       *
       * One of the two on this server that leave the machine, alongside
       * `/api/cloud/devices`, and it is a POST for that reason as much as for
       * what it writes. It is never called on load: `test/network-silence.test.ts`
       * drives the page's whole mount path and this is not on it.
       *
       * A row that fails answers **200 with `status: "failed"`**, and that is not
       * a swallowed error. `syncAllWorkspaces` deliberately does not throw for a
       * row — every failure becomes a row carrying the service's own message and
       * its own `cloudCode`, because folding `offline`, `revoked` and
       * `rate_limited` into one thrown error is the thing that makes a
       * multi-row table unactionable. Re-throwing here would discard exactly the
       * distinction the fan-out was built to keep.
       */
      if (url.pathname === "/api/cloud/workspace/sync") {
        const body = await readBody(req);
        const workspace = hubRowFor(res, body.slug);
        if (workspace === null) return;
        const row = (await syncAllWorkspaces({ home: stapleHome(), workspaces: [workspace] }))
          .workspaces[0]!;
        hubActed(
          res,
          outcomeOf(
            workspace.slug,
            "sync",
            row.status === "synced" ? "ok" : row.status === "skipped" ? "skipped" : "failed",
            row.reason,
          ),
        );
        return;
      }

      /**
       * `POST /api/hub/unregister` — take a row off the list. S21 (STA-282).
       *
       * ## Why this is not under `/api/cloud/`
       *
       * Because it is not a cloud operation. It deletes a row from the machine
       * registry and touches nothing else — no credential, no connection record,
       * no workspace file. Filing it under `cloud` would be a name that lied
       * about what it reaches, and the method gate's per-route reasoning is only
       * useful while the route names are honest.
       *
       * ## Previews by default, like `hub_prune`
       *
       * Without `confirm` this WRITES NOTHING and answers with what would happen:
       * the path, whether cross-workspace links name it, and whether it is still
       * connected. The surface renders that as its confirmation, which is how the
       * page can say "this unregisters and does not delete data" over a fact
       * rather than over a hope.
       *
       * ## The one refusal this route adds
       *
       * A CONNECTED workspace is refused. The connection record and credential
       * are keyed by repository id in the staple home, and the registry row is
       * the only thing on this machine that points a human at them; removing it
       * leaves a live credential nothing names. Disconnect first — which the
       * surface offers on the same row, and which the refusal says.
       *
       * `deleteHubRegistration` is what makes "never touches the workspace
       * database" structural: it is handed a database connection and a NAME, and
       * has no `fs` and no workspace opener to do damage with.
       */
      /**
       * Back up the hub — S18 (STA-279).
       *
       * Writes the registry and its cross-links, with every path dropped, to a
       * timestamped file in the staple home. Local, so it is available with no
       * connection and no consent beyond the press — which is what "the main hub
       * should always have option to backup" requires. Publishing the same
       * payload to a service is a separate, separately-consented act.
       *
       * Makes no network call, which is why it is safe to reach from a page that
       * `test/network-silence.test.ts` drives.
       */
      if (url.pathname === "/api/hub/backup") {
        const hub = Hub.open();
        try {
          const payload = exportRegistry(hub);
          const dir = join(stapleHome(), "backups");
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const file = join(dir, `hub-${payload.capturedAt.replace(/[:.]/g, "-")}.json`);
          writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
          json(res, 200, {
            path: file,
            workspaces: payload.workspaces.length,
            crossLinks: payload.crossLinks.length,
            report: hubCloudReport(stapleHome()),
          });
        } finally {
          hub.close();
        }
        return;
      }

      if (url.pathname === "/api/hub/unregister") {
        const body = await readBody(req);
        const workspace = hubRowFor(res, body.slug);
        if (workspace === null) return;
        const connected =
          workspace.repositoryId !== null &&
          (() => {
            try {
              return readConnection(stapleHome(), workspace.repositoryId) !== null;
            } catch {
              // Unreadable is not "connected". A record nobody can parse is
              // reported by the row's own `skip`, and blocking removal on it
              // would make a broken record unremovable from here forever.
              return false;
            }
          })();

        const hub = Hub.open();
        try {
          const preview = hub.previewUnregister(workspace.slug);
          if (body.confirm !== true) {
            json(res, 200, {
              preview: {
                slug: preview.entry.slug,
                prefix: preview.entry.prefix,
                path: preview.entry.path,
                available: workspace.available,
                connected,
                crossLinks: preview.crossLinks,
              },
              report: hubCloudReport(stapleHome()),
            });
            return;
          }
          if (connected) {
            deny(
              res,
              409,
              "conflict",
              `"${workspace.slug}" is still connected on this machine. Removing it from the list ` +
                `would leave its credential here with nothing pointing at it. Disconnect it ` +
                `first — that removes the credential and keeps every byte of its data.`,
            );
            return;
          }
          // A `conflict` naming the cross-workspace links propagates from here
          // when there are links and the caller did not ask for the cascade. The
          // surface offers the cascade as a second press rather than performing
          // it behind the first: deleting a dependency edge is a decision.
          hub.unregister(workspace.slug, { withLinks: body.removeCrossLinks === true });
        } finally {
          hub.close();
        }
        hubActed(
          res,
          outcomeOf(
            workspace.slug,
            "remove",
            "ok",
            `Removed from this machine's list. Its database and every file beside it are ` +
              `untouched — this unregisters, it does not delete. ` +
              (workspace.available
                ? `Because its files are still here, running staple in ${dirname(workspace.path)} ` +
                  `registers it again.`
                : `Its files are not on this machine, so nothing will register it again.`),
          ),
        );
        return;
      }

      /**
       * ─── THE HUB-WIDE VERBS — S18 (STA-279) ──────────────────────────────────
       *
       * Four routes, and the acceptance criterion they close is *"Hub-wide
       * connect, sync and disconnect are performed from there"* — from the hub
       * panel, which is where the hub is now a thing in its own right.
       *
       * ## A row is a fan-out of size one; the hub is the same call unscoped
       *
       * `buildHubConnectPreview`, `syncAllWorkspaces` and `performHubDisconnect`
       * each take `workspaces?: readonly HubWorkspace[]`, an injection point that
       * replaces the hub enumeration. The `/api/cloud/workspace/*` routes above
       * pass a single-element array. **These routes pass nothing**, so the
       * enumeration is the whole registry — and that is the entire difference
       * between the two families. There is no new core function here, no second
       * definition of "skippable", and no place for the per-row and hub-wide
       * answers to drift apart, because they are the same code with a different
       * argument.
       *
       * ## THE RECORDED REFUSAL, AND WHY IT NO LONGER HOLDS
       *
       * `CloudSection.tsx` carried this, and it was right when it was written:
       *
       *   > connecting every workspace at once spends one enrollment secret
       *   > against N services and produces a per-workspace outcome a dialog has
       *   > nowhere to put, so naming `staple cloud connect --all` was more use
       *   > than a button asking for less than the CLI preview does.
       *
       * Two objections. Both are answered by building the thing properly rather
       * than by declining to build it.
       *
       * **"One secret against N services."** The remedy is that the secret is
       * never offered to a service the human has not been shown, per workspace,
       * by name. `/api/hub/connect/preview` returns the fan-out preview whose
       * every actionable row carries its own `ConnectPreview` — the endpoint, the
       * repository id, the device id, the label and the credential store that
       * row's secret is about to go into — and a row that would be skipped
       * carries `preview: null` and the fan-out's own sentence for why. A
       * workspace already talking to a DIFFERENT service is one of those skips,
       * and it says which service. Then the confirm carries ONE TICKET PER ROW,
       * so the consent is literally over the enumeration rather than over a
       * count: `willConnect: 9` is a number, and agreeing to a number is not
       * agreeing to anything. And the enumeration is re-derived and compared
       * before the secret moves, so a workspace registered or connected while the
       * screen was up is a REFUSAL, not a silent tenth connection.
       *
       * What this deliberately does NOT offer is `--reconnect`. Replacing an
       * existing credential and resetting its consents is destructive, and doing
       * it to N workspaces behind one press is the unbounded blast radius the
       * refusal above was actually worried about. An already-connected workspace
       * is skipped here and has its own Connect button on its own row.
       *
       * It equally does not open any workspace database. A row that has not
       * recorded a sync identity yet is skipped, with `describeSkip`'s sentence
       * saying that opening it records one — which its own row's Connect button
       * does, for one workspace, on one press. A hub-wide connect that took the
       * `recordIdentityIfOpenWould` door would migrate the schema of every
       * project on the machine behind a single button, which is exactly what
       * `hub-scope.ts` exists to prevent.
       *
       * **"An outcome a dialog has nowhere to put."** True of a dialog, and the
       * conclusion drawn from it was wrong. `HubConnectOutcome`, `HubSyncOutcome`
       * and `HubDisconnectOutcome` are per-workspace shapes precisely because a
       * fan-out had no other way to report; `hubFanOutActed` normalizes all three
       * into the row shape S19 already pinned, and the page renders a TABLE. A
       * toast was the wrong container, not the outcome the wrong shape.
       *
       * ## What is still not here
       *
       * No hub-wide purge, and nothing that reaches `staple cloud purge`. The
       * service checks a purge's typed confirmation (STA-256), which proves the
       * caller knew an id and not that a person read the disclosure, and a
       * one-click irreversible remote deletion is worse hub-wide than per
       * workspace by exactly the factor this whole family multiplies by.
       */

      /**
       * `POST /api/hub/connect/preview` — step one, for the whole registry.
       *
       * **Reaches no network, and that is the import graph rather than this
       * handler's restraint.** `buildHubConnectPreview` lives in `hub-preview.ts`,
       * which imports `preview.ts`, `connection.ts`, `credential-store.ts`,
       * `endpoint.ts` and `hub-scope.ts` and **nothing that reaches `client.ts`**;
       * `test/cloud-hub-connect.test.ts` walks that graph transitively and
       * asserts it, and `test/network-silence.test.ts` drives this route under a
       * real spy. It is a separate file from `hub-connect.ts` for exactly this
       * reason — if the two are ever merged, the graph walk fails, which is the
       * review moment.
       *
       * One ticket per ACTIONABLE row, and none for a skipped one: a consent for
       * something that will not happen is a consent with no subject.
       */
      if (url.pathname === "/api/hub/connect/preview") {
        const body = await readBody(req);
        const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
        if (endpoint === "") {
          deny(res, 400, "validation", "An endpoint is required to preview a hub-wide connection.");
          return;
        }
        const credentialFile = body.credentialFile === true;
        const preview = buildHubConnectPreview({
          home: stapleHome(),
          endpoint,
          label: typeof body.label === "string" ? body.label : undefined,
          credential: { forceFile: credentialFile },
          /**
           * `workspaces` OMITTED. This is the whole of "hub-wide": the fan-out
           * enumerates the registry itself, through `listHubWorkspaces()`, which
           * opens the hub READ-ONLY and opens no workspace database at all.
           */
        });

        const actionable = preview.entries.filter((entry) => entry.preview !== null);
        if (actionable.length === 0) {
          deny(res, 409, "conflict", hubConnectRefusal(preview.entries));
          return;
        }
        /**
         * A HONEST CEILING, rather than a silent one. `ConsentTicketStore` holds
         * `MAX_OUTSTANDING_CONSENTS` tickets and evicts the oldest first, so a
         * fan-out wider than that would quietly invalidate its own earliest
         * tickets and then refuse them at confirm time with "that consent has
         * expired" — a true sentence about the wrong thing. Refused up front,
         * naming the per-row route as the remedy.
         */
        if (actionable.length > MAX_OUTSTANDING_CONSENTS) {
          deny(
            res,
            409,
            "conflict",
            `${actionable.length} workspaces would be connected, and this server holds at most ` +
              `${MAX_OUTSTANDING_CONSENTS} outstanding confirmations — a wider fan-out would ` +
              `discard its own earliest consent before you could give it. Connect them from ` +
              `their own rows, or use \`staple cloud connect --all\` at a terminal, which has ` +
              `no such limit because it does not carry consent over HTTP.`,
          );
          return;
        }

        json(res, 200, {
          preview,
          consents: actionable.map((entry) => ({
            slug: entry.slug,
            // `entry.preview` is non-null by the filter above.
            consent: consents.mint(entry.preview!, { credentialFile }),
          })),
          report: hubCloudReport(stapleHome()),
        });
        return;
      }

      /**
       * `POST /api/hub/connect` — step two. **No endpoint. No repository id.**
       *
       * `{ consents: [{ slug, consent, digest }], token }`, and the absence of the
       * first two fields is structural and load-bearing. There is no wire spelling
       * for "connect everything to X": the endpoint is a field of the PREVIEW
       * RESPONSE and appears in no request this server accepts, on this route or
       * any other except the two preview routes. A ticket is minted only in the
       * act of returning a preview, so the bytes naming each service, each
       * repository, each device and each credential store were necessarily
       * delivered to the client before any ticket existed for it to send back.
       * See `src/core/cloud/consent.ts`, and the comment above
       * `/api/cloud/connect`, which this restates N times over.
       *
       * ## Three refusals, in this order, and the order is deliberate
       *
       * 1. **A blank enrollment secret, BEFORE any ticket is redeemed.**
       *    `performHubConnect` validates it too, but only after the tickets are
       *    consumed — and burning N consents over an empty password field is a
       *    materially worse failure than burning one. Checked here so the same
       *    tickets still work on the retry.
       * 2. **Each ticket, against the row it names.** `redeem` consumes it,
       *    re-derives that row's preview from local state and refuses on a
       *    mismatch, so every per-row fact the human read is re-checked. The slug
       *    is compared inside the rebuild callback, by NAME, for the reason
       *    `/api/cloud/workspace/connect` does it: without that check a ticket
       *    previewed for `alpha` and posted against `bravo` reaches the digest
       *    comparison and is refused with "this machine's connection state
       *    changed" — true in a sense, and the wrong sentence entirely.
       * 3. **The enumeration, against the one that was shown.** The fan-out
       *    preview is rebuilt and its actionable set compared to the consented
       *    set. A workspace that appeared is refused because consent to three is
       *    not consent to a fourth; one that vanished is refused because the
       *    screen described something that is no longer true. Either way nothing
       *    is sent, and the remedy is to look at the new preview.
       */
      if (url.pathname === "/api/hub/connect") {
        const body = await readBody(req);
        const enrollmentSecret = typeof body.token === "string" ? body.token : "";
        if (enrollmentSecret.trim() === "") {
          deny(
            res,
            400,
            "validation",
            "An enrollment credential is required. It is offered to each workspace in turn, and " +
              "a workspace whose service does not accept it is reported rather than aborting the " +
              "others. Nothing was sent, and the confirmations you were issued are still valid.",
          );
          return;
        }

        const offered = Array.isArray(body.consents) ? body.consents : [];
        if (offered.length === 0) {
          deny(
            res,
            400,
            "validation",
            "A hub-wide connect must carry the confirmations the preview issued, one for each " +
              "workspace it named. There is no way to name an endpoint here: connecting requires " +
              "having been shown, in a prior response, every service and repository it would bind.",
          );
          return;
        }

        const registry = listHubWorkspaces();
        /** slug -> the digest of the preview that row's consent was given to. */
        const agreed = new Map<string, string>();
        let endpoint: string | null = null;
        let label: string | null = null;
        let credentialFile: boolean | null = null;

        for (const raw of offered) {
          const ticket = raw as { slug?: unknown; consent?: unknown; digest?: unknown };
          const slug = typeof ticket.slug === "string" ? ticket.slug.trim() : "";
          if (slug === "") {
            deny(
              res,
              400,
              "validation",
              "Every confirmation in a hub-wide connect names the workspace it was issued for. " +
                "There is no wire spelling for 'the rest of them' here on purpose.",
            );
            return;
          }
          if (agreed.has(slug)) {
            deny(
              res,
              400,
              "validation",
              `"${slug}" appears twice in this confirmation. One consent buys one connection.`,
            );
            return;
          }
          const workspace = registry.find((entry) => entry.slug === slug);
          if (!workspace) {
            throw new StapleError(
              "not_found",
              `No workspace "${slug}" is registered on this machine. The registry is enumerated ` +
                `on every read, so a workspace unregistered a moment ago is already gone from it.`,
            );
          }
          const repositoryId = hubRepositoryId(workspace);

          let redeemed;
          try {
            redeemed = consents.redeem(ticket.consent, ticket.digest, (stored, choices) => {
              if (stored.repositoryId !== repositoryId) {
                throw new StapleError(
                  "validation",
                  `That confirmation was issued for a different workspace, so it cannot be used ` +
                    `to connect "${slug}". Nothing was sent. Review the hub-wide connection ` +
                    `again and confirm what that shows.`,
                );
              }
              return buildConnectPreview({
                home: stapleHome(),
                repositoryId,
                endpoint: stored.endpoint.origin,
                label: stored.label,
                credential: { forceFile: choices.credentialFile },
              });
            });
          } catch (error) {
            /**
             * **A FAN-OUT'S REFUSAL HAS TO NAME THE ROW IT IS ABOUT.**
             *
             * `ConsentTicketStore`'s own sentences are written for one
             * workspace, where the subject is unambiguous: *"This machine's
             * connection state changed while that preview was on screen."* Said
             * about a screen listing four workspaces, that is the exact failure
             * this epic keeps meeting from different directions — a true
             * sentence that leaves a reader with four directories to go and
             * check. `hub-sync.ts` makes the same argument about why `offline`
             * and `revoked` must not both fold into `conflict`.
             *
             * The code is preserved, so the HTTP status and any script reading
             * it are unchanged; only the subject is added. Re-thrown rather than
             * `deny`d because these are the codes the catch-all already maps
             * correctly, and a second mapping here would be a place for the two
             * to disagree.
             */
            if (error instanceof StapleError) {
              throw new StapleError(error.code, `Confirming "${slug}": ${error.message}`);
            }
            throw error;
          }
          const { preview, context } = redeemed;

          /**
           * ONE GESTURE, ONE SERVICE, ONE CREDENTIAL CHOICE. Every ticket came
           * out of a single preview, which has a single endpoint and a single
           * credential-store decision, so a disagreement here means two previews
           * were mixed — and a fan-out assembled out of two screens is a
           * consent nobody gave in one piece.
           */
          if (endpoint === null) {
            endpoint = preview.endpoint.origin;
            label = preview.label;
            credentialFile = context.credentialFile;
          } else if (
            preview.endpoint.origin !== endpoint ||
            preview.label !== label ||
            context.credentialFile !== credentialFile
          ) {
            deny(
              res,
              400,
              "validation",
              "These confirmations came from more than one preview, so they do not describe one " +
                "decision. Nothing was sent. Review the hub-wide connection again.",
            );
            return;
          }
          agreed.set(slug, previewDigest(preview));
        }

        /**
         * THE ENUMERATION, RE-DERIVED. `endpoint` and `label` come out of the
         * tickets and out of nothing else — the request could not name them —
         * which is why this rebuild is possible at all without a field the design
         * refuses to accept.
         */
        if (endpoint === null) {
          // Unreachable: the loop above ran at least once and every path through
          // it either sets this or returns. Stated rather than asserted away,
          // because the alternative is a `!` on the one value this whole route
          // exists to make sure the request could not supply.
          deny(res, 400, "validation", "No confirmation named a service. Nothing was sent.");
          return;
        }
        const preview = buildHubConnectPreview({
          home: stapleHome(),
          endpoint,
          label: label ?? undefined,
          credential: { forceFile: credentialFile === true },
        });
        const actionable = preview.entries.filter((entry) => entry.preview !== null);
        const appeared = actionable.filter((entry) => !agreed.has(entry.slug)).map((e) => e.slug);
        const vanished = [...agreed.keys()].filter(
          (slug) => !actionable.some((entry) => entry.slug === slug),
        );
        if (appeared.length > 0 || vanished.length > 0) {
          deny(
            res,
            409,
            "conflict",
            "This machine's workspaces changed while that preview was on screen, so it no longer " +
              "describes what would happen. Nothing was sent. " +
              (appeared.length > 0
                ? `Not covered by what you agreed to: ${appeared.join(", ")}. `
                : "") +
              (vanished.length > 0
                ? `No longer connectable: ${vanished.join(", ")}. `
                : "") +
              "Review the hub-wide connection again and read what it now says.",
          );
          return;
        }
        for (const entry of actionable) {
          if (previewDigest(entry.preview!) !== agreed.get(entry.slug)) {
            deny(
              res,
              409,
              "conflict",
              `What connecting "${entry.slug}" would do has changed since that preview was ` +
                `shown, so it no longer describes what you agreed to. Nothing was sent. Review ` +
                `the hub-wide connection again.`,
            );
            return;
          }
        }

        const outcome = await performHubConnect(preview, {
          home: stapleHome(),
          enrollmentSecret,
          credential: { forceFile: credentialFile === true },
        });
        hubFanOutActed(
          res,
          "connect",
          outcome.workspaces.map((row) =>
            outcomeOf(
              row.slug,
              "connect",
              row.status === "connected" ? "ok" : row.status === "failed" ? "failed" : "skipped",
              row.reason,
            ),
          ),
        );
        return;
      }

      /**
       * `POST /api/hub/sync` — **this route egresses, once per connected
       * workspace.**
       *
       * The widest outbound surface on this server, and it is a POST for that
       * reason as much as for what it writes. **It is not on the page's mount
       * path**: `test/network-silence.test.ts` drives every route an opening
       * settings panel touches and this is deliberately absent from all of those
       * lists, exactly as `/api/cloud/workspace/sync` and `/api/cloud/devices`
       * are. A settings page that synchronized the machine when you opened it
       * would be the heartbeat `docs/sync.md` describes as arrived at by
       * accident, multiplied by the size of the registry.
       *
       * A row that fails answers **200 with `status: "failed"`**, and that is not
       * a swallowed error. `syncAllWorkspaces` deliberately does not throw for a
       * row: every failure becomes a row carrying the service's own message and
       * its own `cloudCode`, because folding `offline`, `revoked` and
       * `rate_limited` into one thrown error is the thing that makes a
       * twelve-row table unactionable. Re-throwing here would discard exactly the
       * distinction the fan-out was built to keep.
       */
      if (url.pathname === "/api/hub/sync") {
        const before = hubCloudReport(stapleHome());
        const targets = hubSyncTargets(before);
        if (targets.length === 0) {
          /**
           * Refused rather than answered 200 with an empty table, and the reason
           * distinguishes the three ways of having nothing to do. A single
           * "nothing to sync" would send somebody looking for a network problem
           * when the answer is that they have not connected anything.
           */
          const connected = hubDisconnectTargets(before);
          const detail =
            before.workspaces.length === 0
              ? "No workspaces are registered on this machine."
              : connected.length === 0
                ? `None of the ${before.workspaces.length} registered ` +
                  `${before.workspaces.length === 1 ? "workspace is" : "workspaces are"} ` +
                  `connected on this machine. Connecting is a separate consent, and a sync run ` +
                  `does not get to spend it.`
                : `${connected.length} ${connected.length === 1 ? "workspace is" : "workspaces are"} ` +
                  `connected but not available to synchronize right now. ` +
                  connected.map((row) => `${row.slug}: ${row.skipDetail ?? "unavailable"}`).join(" ");
          deny(res, 409, "conflict", `There is nothing to synchronize. ${detail}`);
          return;
        }

        /**
         * `workspaces` OMITTED — the fan-out enumerates the registry. Nothing
         * here loops over `handleFor`, which in single-workspace mode would
         * answer with the server's own workspace whatever it was asked and turn a
         * hub-wide sync into one workspace synchronized N times.
         */
        const outcome = await syncAllWorkspaces({ home: stapleHome() });
        hubFanOutActed(
          res,
          "sync",
          outcome.workspaces.map((row) =>
            outcomeOf(
              row.slug,
              "sync",
              row.status === "synced" ? "ok" : row.status === "failed" ? "failed" : "skipped",
              row.reason,
            ),
          ),
        );
        return;
      }

      /**
       * `POST /api/hub/disconnect` — local, and only local, N times over.
       *
       * `performHubDisconnect` inherits `performDisconnect`'s contract exactly:
       * **no network call**, not even a courtesy one, and the entire local
       * database of every workspace preserved including pending outbox
       * operations. A person who has decided to stop talking to a service must
       * not need that service's permission to stop, and that is no less true of
       * twelve workspaces than of one — which is why this route is **not gated on
       * service availability**, and not gated on `available` either. The
       * credential lives in the staple home, so disconnecting a workspace whose
       * disk is unmounted is both possible and right; refusing would leave a live
       * credential behind for precisely the workspace somebody is most likely to
       * be disconnecting. Same reasoning as the per-row route above.
       *
       * ## Why the empty check comes before the confirmation
       *
       * `confirm` is the CLI's `--yes`, and the confirmation NAMES THE COUNT AND
       * THE WORKSPACES — which it can only do once it knows them. So the order is
       * "is there anything to do", then "are you sure about these". Asking for a
       * confirmation of nothing, and then reporting that nothing was there, would
       * be two round trips to learn one fact.
       */
      if (url.pathname === "/api/hub/disconnect") {
        const body = await readBody(req);
        const before = hubCloudReport(stapleHome());
        const targets = hubDisconnectTargets(before);
        if (targets.length === 0) {
          deny(
            res,
            409,
            "conflict",
            "There is nothing to disconnect. " +
              (before.workspaces.length === 0
                ? "No workspaces are registered on this machine."
                : `None of the ${before.workspaces.length} registered ` +
                  `${before.workspaces.length === 1 ? "workspace is" : "workspaces are"} ` +
                  `connected on this machine, so no credential is stored for any of them.`),
          );
          return;
        }
        if (body.confirm !== true) {
          deny(
            res,
            400,
            "validation",
            `Disconnecting the hub removes this machine's credential for ${targets.length} ` +
              `connected ${targets.length === 1 ? "workspace" : "workspaces"}: ` +
              `${targets.map((row) => row.slug).join(", ")}. Pass confirm to proceed. Every ` +
              `database, including pending operations and unsettled conflicts, is untouched, no ` +
              `other device is affected, and no remote copy is deleted. Re-connecting later needs ` +
              `an enrollment credential.`,
          );
          return;
        }
        /**
         * `workspaces` OMITTED. The registry is the enumeration.
         *
         * `performHubDisconnect` reports a row it could not act on as a
         * `failed` ROW rather than throwing — a connection record this build
         * refuses to parse is the only way to get one — so a corrupt file
         * belonging to one workspace cannot abort the fan-out and hide the
         * disconnections that already happened. That per-row catch was added
         * for this route: without it, three connected workspaces and one
         * unreadable record produced two deleted credentials, an exception
         * about a JSON file, and no outcome table at all.
         */
        const outcome = performHubDisconnect(stapleHome());
        hubFanOutActed(
          res,
          "disconnect",
          outcome.workspaces.map((row) =>
            outcomeOf(
              row.slug,
              "disconnect",
              row.status === "disconnected" ? "ok" : row.status === "failed" ? "failed" : "skipped",
              row.reason,
            ),
          ),
        );
        return;
      }

      /**
       * `POST /api/hub/consent` — the HUB's own consent. S22 (STA-283).
       *
       * `{ registry: boolean }`, keyed by `hub.storedHubId()`, and it resolves no
       * workspace at all.
       *
       * ## Why this is a new route rather than a fourth key on the two that exist
       *
       * It was very nearly one. `/api/cloud/consent` and
       * `/api/cloud/workspace/consent` both take `["auto", "backup"]` and refuse
       * a body naming more than one, and adding `"registry"` to those two
       * literals is a two-character change that would have worked in hub mode.
       *
       * It would have been the wrong-subject defect this whole file is careful
       * about, in its purest form. `/api/cloud/consent` resolves through
       * `handleFor(body.ws)`, and **in single-workspace mode `handleFor` ignores
       * its argument** and returns the workspace the server was started on. A
       * consent that belongs to the HUB, posted there, would be written into
       * `~/.staple/cloud/<that workspace's repositoryId>.json` — silently, on the
       * ordinary `staple ui` configuration, under a key naming the wrong thing
       * entirely. `/api/cloud/workspace/consent` is no better: it is keyed by
       * `hubRepositoryId(workspace)` by construction.
       *
       * So the hub's consent goes where the hub's other verbs go, and its
       * subject is legible from its name.
       *
       * ## No network call, and the reason it cannot become one
       *
       * `setRegistryConsent` writes one file in the staple home. Unlike
       * `setBackupConsent` it asks the server nothing, because this consent has
       * one half rather than two: there is no wire spelling for "this machine may
       * describe itself", and every operation it gates is an ordinary push the
       * credential already authorizes. It is enforced entirely on this side, by
       * `requireRegistryConsent` at the head of every egress path in
       * `hub-registry-service.ts`.
       *
       * ## Refuses on an unconnected hub rather than creating a record
       *
       * Inherited from `setConsent`, and the surface disables the switch rather
       * than letting it error — but the route refuses regardless, because a
       * client is not the surface. *"Before a repository is connected, no cloud
       * setting, credential or request may exist at all"*, and `at all` is not
       * satisfied by a file recording a consent for a connection that is not
       * there.
       */
      if (url.pathname === "/api/hub/consent") {
        const body = await readBody(req);
        if (typeof body.registry !== "boolean") {
          deny(
            res,
            400,
            "validation",
            "Pass registry as a boolean. It is the hub's own consent — whether this machine may " +
              "publish its workspace registry — and it is separate from every workspace's " +
              "connect, automatic sync and backup consents.",
          );
          return;
        }
        /**
         * `storedHubId()`, never `hubId()`. The latter MINTS, and a route that
         * minted a permanent identity while refusing the request would leave a
         * value behind that nothing asked for. A hub with no stored id has never
         * been connected, so the refusal below is the right answer anyway.
         */
        const hub = Hub.openReadOnly();
        let hubId: string | null;
        try {
          hubId = hub.storedHubId();
        } finally {
          hub.close();
        }
        if (hubId === null) {
          throw new StapleError(
            "not_found",
            "This machine's hub has no identity yet, so it has never been connected and there " +
              "is no connection for this consent to be recorded against. Connect the hub first.",
          );
        }

        /**
         * ─── THE ACKNOWLEDGEMENT CROSSES THE WIRE, AND THAT IS THE POINT ─────
         *
         * `setRegistryConsent` refuses to ENABLE unless handed the disclosure
         * verbatim — evidence that the caller had the sentence in hand. It is
         * not authentication; a caller can look the constant up. What it removes
         * is *"somebody adds a toggle, wires it to the setter, and nobody
         * notices the screen was never built."*
         *
         * That argument means nothing here if this route supplies the constant
         * itself. A server that passed `REGISTRY_DISCLOSURE` on the client's
         * behalf would satisfy the check while proving exactly nothing about
         * whether anything was ever displayed — the check would have been
         * spent, not honoured. It is the same failure `/api/cloud/connect` would
         * have if it accepted an `endpoint`: a property that holds inside the
         * process, discarded at the last surface.
         *
         * **So the CLIENT sends it back, and this route forwards what the client
         * sent — never a constant of its own.** The browser's only source for
         * the sentence is `report.self.registry.disclosure`, which it can only
         * have by fetching the report that draws the panel. A caller that never
         * had the panel cannot produce the string, and `setRegistryConsent`
         * refuses it. The disclosure therefore travels OUT in a report and back
         * IN on the grant, which is the same one-way-then-back shape the connect
         * preview and its ticket have.
         *
         * Withdrawing carries nothing, because `setRegistryConsent` requires
         * nothing to withdraw: making it harder to turn off than on is the wrong
         * asymmetry in a revocation that has to work offline.
         */
        const acknowledgement =
          typeof body.disclosure === "string" ? body.disclosure : undefined;
        const outcome = setRegistryConsent(
          stapleHome(),
          hubId,
          body.registry,
          acknowledgement,
        );
        json(res, 200, {
          outcome: outcomeOf(
            "",
            "registry",
            "ok",
            outcome.enabled
              ? "Publishing this machine's workspace registry is on. What that discloses is " +
                "stated above the switch, and is unchanged by turning it on."
              : "Publishing this machine's workspace registry is off. Nothing about your " +
                "workspace list leaves this machine.",
          ),
          report: hubCloudReport(stapleHome()),
        });
        return;
      }

      /**
       * ─── THE HUB REGISTRY LEG — STA-289 ──────────────────────────────────────
       *
       * Identity, connect, disconnect, publish, hub backups, restore and adopt: the
       * rest of what `staple hub registry` does, so the publish switch above stops
       * being permanently disabled on a machine that never opened a terminal.
       *
       * Every one of these addresses the hub through `hub.storedHubId()` and the
       * service module, and none goes near `handleFor` — in single-workspace mode
       * that ignores its argument and returns the workspace the server booted on, so
       * a hub-scoped write through it would land under that workspace's id.
       * `test/ui-hub-registry.test.ts` runs the whole leg in that mode and asserts
       * the workspace's id never gains a connection.
       *
       * None of them mints an identity except the one route named for it. The
       * service's `hubRepositoryId` is `hub.hubId()`, which mints, so each route
       * refuses on a hub with no stored id BEFORE the service is called — see
       * `withRegistryHub`.
       */

      /** `POST /api/hub/registry/identity/mint` — `staple hub registry id`. Local. */
      if (url.pathname === "/api/hub/registry/identity/mint") {
        const hub = Hub.open();
        let hubId: string;
        let minted: boolean;
        try {
          minted = hub.storedHubId() === null;
          hubId = hub.hubId();
        } finally {
          hub.close();
        }
        json(res, 200, { hubId, minted, report: hubCloudReport(stapleHome()) });
        return;
      }

      /**
       * `POST /api/hub/registry/identity` — take on an identity another machine
       * published under. Local. `{ hubId, confirm? }`.
       *
       * Replacing an existing id asks first: without `confirm` the answer is 200
       * with `needsConfirm` and the core's own orphan notice, and nothing changes.
       * The notice is stated whenever there is a previous id, and never branched on
       * whether that id was used — a disconnect leaves no evidence either way, so
       * "was it used" is the one thing this machine cannot know.
       */
      if (url.pathname === "/api/hub/registry/identity") {
        const body = await readBody(req);
        const wanted = typeof body.hubId === "string" ? body.hubId.trim() : "";
        if (wanted === "") {
          deny(
            res,
            400,
            "validation",
            "A hub id is required. It comes from the machine that published the registry, or " +
              "from wherever it was kept with the enrollment secret. Nothing was changed.",
          );
          return;
        }
        /**
         * A confirmation names the identity its warning was about, and is refused if that
         * is no longer the stored one. The warning is `describeIdentityReplacement` of a
         * PARTICULAR id; a yes given to it after another tab or `staple hub registry
         * identity` replaced that id would replace a different one, whose orphan notice
         * nobody was shown.
         */
        const confirming = body.confirm === true;
        if (confirming && body.previousHubId !== null && typeof body.previousHubId !== "string") {
          deny(
            res,
            400,
            "validation",
            "A confirmed replacement names the identity its warning was about, as previousHubId " +
              "(null when there was none). Ask again without confirm to be shown it. Nothing " +
              "was changed.",
          );
          return;
        }
        const hub = Hub.open();
        let answer: {
          hubId: string;
          adopted: boolean;
          needsConfirm: boolean;
          previousHubId: string | null;
          notice: string | null;
        };
        try {
          const previous = hub.storedHubId();
          if (confirming && body.previousHubId !== previous) {
            throw new StapleError(
              "conflict",
              `This hub's identity is now ${previous ?? "unset"}, and the warning you confirmed ` +
                `was about ${String(body.previousHubId)} — it was changed from somewhere else ` +
                "while the warning was on screen. Nothing was changed. Take the id on again to " +
                "see what replacing the current one means.",
            );
          }
          if (previous !== null && previous !== wanted && !confirming) {
            answer = {
              hubId: wanted,
              adopted: false,
              needsConfirm: true,
              previousHubId: previous,
              notice: describeIdentityReplacement(previous),
            };
          } else {
            const outcome = adoptRegistryIdentity(stapleHome(), hub, wanted);
            answer = {
              hubId: wanted,
              adopted: outcome.adopted,
              needsConfirm: false,
              previousHubId: outcome.previousHubId,
              notice:
                outcome.adopted && outcome.previousHubId !== null
                  ? describeIdentityReplacement(outcome.previousHubId)
                  : null,
            };
          }
        } finally {
          hub.close();
        }
        json(res, 200, { ...answer, report: hubCloudReport(stapleHome()) });
        return;
      }

      /**
       * `POST /api/hub/registry/connect/preview` — step one, and the only registry
       * route that may name an endpoint. Local: `buildHubRegistryPreview` is
       * `buildConnectPreview` pointed at the hub id, and `preview.ts` cannot reach
       * the network. The ticket comes from the same `ConsentTicketStore` every
       * connect on this server uses.
       */
      if (url.pathname === "/api/hub/registry/connect/preview") {
        const body = await readBody(req);
        const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
        if (endpoint === "") {
          deny(res, 400, "validation", "An endpoint is required to preview the hub's connection.");
          return;
        }
        const credentialFile = body.credentialFile === true;
        const preview = await withRegistryHub((hub) =>
          buildHubRegistryPreview({
            home: stapleHome(),
            hub,
            endpoint,
            label: typeof body.label === "string" ? body.label : undefined,
            credential: { forceFile: credentialFile },
          }),
        );
        json(res, 200, {
          preview,
          consent: consents.mint(preview, { credentialFile }),
          report: hubCloudReport(stapleHome()),
        });
        return;
      }

      /**
       * `POST /api/hub/registry/connect` — step two. **No endpoint, no repositoryId.**
       *
       * `{ consent, digest, token }`, exactly `/api/cloud/connect`'s shape and for
       * its reason: the endpoint is a field of the PREVIEW RESPONSE and of the
       * ticket, and appears in no request this route reads. Two refusals the
       * workspace route does not need:
       *
       *  - a blank secret is refused BEFORE the ticket is redeemed, so the retry
       *    can use the same confirmation;
       *  - a ticket minted for anything but this hub's id is refused inside the
       *    rebuild. The ticket store is shared with every workspace connect on this
       *    server, so without the check a workspace's preview could be redeemed
       *    here — and the digest would then refuse it with a sentence about
       *    "connection state changed", which is true and the wrong sentence.
       */
      if (url.pathname === "/api/hub/registry/connect") {
        const body = await readBody(req);
        const enrollmentSecret = typeof body.token === "string" ? body.token : "";
        if (enrollmentSecret.trim() === "") {
          deny(
            res,
            400,
            "validation",
            "An enrollment credential is required: the secret whoever runs the service created " +
              "with the hub's repository row. Nothing was sent, and the confirmation you were " +
              "issued is still valid.",
          );
          return;
        }
        const outcome = await withRegistryHub((hub, hubId) => {
          const { preview, context } = consents.redeem(body.consent, body.digest, (stored, choices) => {
            if (stored.repositoryId !== hubId) {
              throw new StapleError(
                "validation",
                "That confirmation was issued for a different subject — a workspace's connection, " +
                  "or this hub under another identity — so it cannot connect this machine's hub. " +
                  "Nothing was sent. Review the hub's connection again.",
              );
            }
            return buildHubRegistryPreview({
              home: stapleHome(),
              hub,
              endpoint: stored.endpoint.origin,
              label: stored.label,
              credential: { forceFile: choices.credentialFile },
            });
          });
          return connectHubRegistry(preview, {
            home: stapleHome(),
            enrollmentSecret,
            credential: { forceFile: context.credentialFile },
          });
        });
        json(res, 200, {
          connection: outcome.connection,
          capabilities: outcome.capabilities,
          credentialLocation: outcome.credentialLocation,
          report: hubCloudReport(stapleHome()),
        });
        return;
      }

      /**
       * `POST /api/hub/registry/disconnect` — `staple hub registry disconnect`.
       * Local, and only local: `performDisconnect` pointed at the hub id. What was
       * published stays published; the identity stays too, so re-connecting later
       * reaches the same registry.
       */
      if (url.pathname === "/api/hub/registry/disconnect") {
        const body = await readBody(req);
        if (body.confirm !== true) {
          deny(
            res,
            400,
            "validation",
            "Disconnecting the hub removes this machine's credential for its registry. Pass " +
              "confirm to proceed. The published registry is not deleted, other machines are " +
              "unaffected, and every workspace is untouched.",
          );
          return;
        }
        const outcome = await withRegistryHub((_hub, hubId) => performDisconnect(stapleHome(), hubId));
        json(res, 200, { ...outcome, report: hubCloudReport(stapleHome()) });
        return;
      }

      /**
       * `POST /api/hub/registry/publish` — EGRESSES. `publishRegistry` begins with
       * the publish consent, so on a hub that has not granted it this refuses from
       * the connection record before a request is built.
       */
      if (url.pathname === "/api/hub/registry/publish") {
        const publish = await withRegistryHub((hub) => publishRegistry(hub, stapleHome()));
        json(res, 200, { publish, report: hubCloudReport(stapleHome()) });
        return;
      }

      /**
       * `POST /api/hub/registry/backup/consent` — `{ enabled }`. EGRESSES when
       * enabling, because the server owns half of this consent and is asked first;
       * withdrawing is local first and tells the service best-effort, returning a
       * warning rather than failing when it cannot.
       */
      if (url.pathname === "/api/hub/registry/backup/consent") {
        const body = await readBody(req);
        if (typeof body.enabled !== "boolean") {
          deny(
            res,
            400,
            "validation",
            "Pass enabled as a boolean. Hub backup is its own decision, separate from publishing.",
          );
          return;
        }
        const enabled = body.enabled;
        const backup = await withRegistryHub((_hub, hubId) =>
          setHubBackupConsent(stapleHome(), hubId, enabled),
        );
        json(res, 200, { backup, report: hubCloudReport(stapleHome()) });
        return;
      }

      /**
       * `POST /api/hub/registry/backups` — the service's hub backups. EGRESSES, so
       * it is a POST behind the Origin check although it reads, like
       * `/api/cloud/devices`, and the page asks only when a button is pressed.
       * Carries the restore disclosure, so the page has it before it offers one.
       */
      if (url.pathname === "/api/hub/registry/backups") {
        const backups = await withRegistryHub((_hub, hubId) => listHubBackups(stapleHome(), hubId));
        json(res, 200, {
          backups,
          restoreNotice: HUB_RESTORE_NOTICE,
          report: hubCloudReport(stapleHome()),
        });
        return;
      }

      /** `POST /api/hub/registry/backup/create` — `{ label? }`. EGRESSES: take one, then list. */
      if (url.pathname === "/api/hub/registry/backup/create") {
        const body = await readBody(req);
        const label =
          typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : null;
        const answer = await withRegistryHub(async (_hub, hubId) => {
          const backup = await createHubBackup(stapleHome(), hubId, label);
          return { backup, backups: await listHubBackups(stapleHome(), hubId) };
        });
        json(res, 200, {
          ...answer,
          restoreNotice: HUB_RESTORE_NOTICE,
          report: hubCloudReport(stapleHome()),
        });
        return;
      }

      /**
       * `POST /api/hub/registry/restore` — the most destructive registry action.
       * EGRESSES. `{ backupId, epoch, entityCount, confirm }`.
       *
       * ## Confirmed over the enumeration, not over a yes
       *
       * The body carries the three facts the confirmation showed — which backup,
       * its epoch, how many entities — and the service's own list is read and
       * compared before anything moves. A backup that is not there, or whose facts
       * differ from what was agreed to, is refused and nothing is restored.
       *
       * ## The service half only
       *
       * `restoreRegistry` with `apply: false`: the service is rewound and the
       * adoption of what came back is PREVIEWED. Applying it locally is the adopt
       * route with this response's `digest`, one more press — never a second restore,
       * which would cost another epoch. The undo is `preRestoreBackupId`, an
       * ordinary backup restorable by this same route.
       */
      if (url.pathname === "/api/hub/registry/restore") {
        const body = await readBody(req);
        const backupId = typeof body.backupId === "string" ? body.backupId.trim() : "";
        const epoch = body.epoch;
        const entityCount = body.entityCount;
        if (backupId === "" || typeof epoch !== "number" || typeof entityCount !== "number") {
          deny(
            res,
            400,
            "validation",
            "A restore names the backup, its epoch and its entity count — the facts its " +
              "confirmation showed. Nothing was changed, here or on the service.",
          );
          return;
        }
        if (body.confirm !== true) {
          deny(
            res,
            400,
            "validation",
            `${HUB_RESTORE_NOTICE.headline} ${HUB_RESTORE_NOTICE.bullets.join("; ")}. Pass ` +
              "confirm to proceed. Nothing was changed, here or on the service.",
          );
          return;
        }
        const answer = await withRegistryHub(async (hub, hubId) => {
          // Both consents, checked from the record BEFORE the list is asked for, so a
          // restore that is going to be refused is refused without a request.
          // `restoreRegistry` checks them again; this is ordering, not the fence.
          requireRegistryConsent(requireHubRegistryConnection(stapleHome(), hubId));
          const listed = await listHubBackups(stapleHome(), hubId);
          const target = listed.find((backup) => backup.backupId === backupId);
          if (!target) {
            throw new StapleError(
              "not_found",
              `The service holds no hub backup ${backupId}. Nothing was restored. Show the ` +
                "backups again and pick one from what it lists.",
            );
          }
          if (target.epoch !== epoch || target.entityCount !== entityCount) {
            throw new StapleError(
              "conflict",
              `Backup ${backupId} is epoch ${target.epoch} with ${target.entityCount} entities, and ` +
                `the confirmation was for epoch ${epoch} with ${entityCount}. It no longer ` +
                "describes what would be restored, so nothing was. Show the backups again.",
            );
          }
          const restore = await restoreRegistry(hub, stapleHome(), backupId, { apply: false });
          return {
            restore,
            digest: adoptionDigest(restore.adoption),
            retiresOptOuts: optOutsAdoptionRetires(hub, restore.adoption),
            backups: await listHubBackups(stapleHome(), hubId),
          };
        });
        json(res, 200, { ...answer, report: hubCloudReport(stapleHome()) });
        return;
      }

      /**
       * `POST /api/hub/registry/adopt` — `{ apply?, digest? }`. Reads the service
       * (EGRESSES) and writes only `hub.db`.
       *
       * Without `apply` it previews: one decision per incoming entry, and the digest
       * an apply must hand back. With `apply` it previews AGAIN, compares, and only
       * then applies — so the decisions a person agreed to are the decisions that
       * are written, or nothing is.
       */
      if (url.pathname === "/api/hub/registry/adopt") {
        const body = await readBody(req);
        const apply = body.apply === true;
        const digest = typeof body.digest === "string" ? body.digest : "";
        if (apply && digest === "") {
          deny(
            res,
            400,
            "validation",
            "Applying an adoption carries the digest of the preview it was shown, so what is " +
              "written is what was agreed to. Preview the adoption first. Nothing was written.",
          );
          return;
        }
        const answer = await withRegistryHub(async (hub, hubId) => {
          /**
           * ONE READ OF THE SERVICE, and both the check and the write come from it.
           *
           * This was `adoptPublishedRegistry` twice — preview, compare, then apply — and
           * each call read the service. A publish from another machine landing between
           * the two reads was written without having been previewed:
           * `test/ui-hub-registry.test.ts` publishes a workspace from inside the second
           * read and watched it land. So this is `adoptPublishedRegistry`'s own three
           * steps, with the read done once: reconcile the identity column first (the
           * adoption keys on it), read, then preview and apply the SAME payload. Nothing
           * awaits between the preview and the apply, so this machine's hub cannot move
           * between them either.
           */
          reconcileRepositoryIds(hub);
          const { registry } = await readPublishedRegistry(stapleHome(), hubId);
          const preview = adoptRegistry(hub, registry);
          const seen = adoptionDigest(preview);
          const retiresOptOuts = optOutsAdoptionRetires(hub, preview);
          if (!apply) return { registry, adoption: preview, digest: seen, retiresOptOuts };
          if (seen !== digest) {
            throw new StapleError(
              "conflict",
              "What the service holds, or this machine's list, changed since that preview was " +
                "shown, so it no longer describes what adopting would do. Nothing was written. " +
                "Preview the adoption again.",
            );
          }
          const applied = adoptRegistry(hub, registry, { apply: true });
          return { registry, adoption: applied, digest: seen, retiresOptOuts };
        });
        json(res, 200, { ...answer, report: hubCloudReport(stapleHome()) });
        return;
      }

      if (url.pathname === "/api/poll") {
        json(res, 200, { fingerprint: fingerprint() });
        return;
      }

      if (url.pathname === "/api/issues") {
        const wanted = url.searchParams.get("ws") ?? undefined;
        const assignee = url.searchParams.get("assignee") ?? undefined;
        const targets = options.hub && !wanted ? allHandles() : [handleFor(wanted)];
        const out = targets.flatMap((h) => {
          const issues = h.store.listIssues({
            includeResolved: true,
            assignee: assignee || undefined,
          });
          const ids = issues.map((i) => i.id);
          // One batched liveness query per workspace, not one per row.
          const claims = h.store.claimActivityFor(ids);
          /**
           * The same treatment for "when did anyone last leave a handoff" (STA-113).
           * One batched query per workspace, for the reason spelled out in §2a of the
           * STA-108 spec: a client-side path would be 114 `/api/document` calls against
           * a page polled every 1.5s, which is a non-starter rather than a slow option.
           *
           * A SIBLING of `issue`, never a field on it — the argument `lib/types.ts`
           * already makes for `claim` and `pullRequests`. A worklog summary is a
           * different clock than the issue, and freezing a clock reading into a cached
           * entity is a lie waiting to happen.
           */
          const worklogs = h.store.worklogSummaryFor(ids);
          /**
           * O6 (STA-138): what each row is waiting on, and what is waiting on it.
           *
           * ADDITIVE and batched, exactly like `claims` above — two index scans for the
           * whole page rather than four round trips per row. It rides as ONE sibling field
           * (`deps`) rather than two, so a reader sees the pair as the pair it is.
           *
           * Deliberately here and NOT on `/api/issue` or `/api/agent-context`: the detail
           * route already sends the full `blockedBy`/`blocks` with titles and statuses, and
           * `test/ui-agent-context.test.ts` pins that route byte-for-byte against the MCP
           * `get_task` tool. This is a list affordance and it stays on the list route.
           */
          const blockedBy = h.store.unresolvedBlockersFor(ids);
          const blocks = h.store.openDependentsFor(ids);
          /**
           * Q1 (STA-143): the gate pair, batched exactly like everything above it.
           *
           * Two SIBLINGS rather than one wrapper, because they are complementary
           * rather than a pair of a thing: `gate` is "this row holds a queue",
           * `queuedBy` is "this row stands in one". At most one is ever non-null,
           * and which one it is changes what the row should say completely.
           */
          const gates = h.store.gateFor(ids);
          const queuedBy = h.store.queuedByFor(ids);
          return issues.map((issue) => ({
            workspace: h.slug,
            issue,
            claim: claims.get(issue.id) ?? null,
            gate: gates.get(issue.id) ?? null,
            queuedBy: queuedBy.get(issue.id) ?? null,
            // Absent-from-the-map becomes an explicit null on the wire, exactly as
            // `claim` does, so the page never has to tell "no worklog" from "field
            // missing" — it never invents a fact it was not sent.
            worklog: worklogs.get(issue.id) ?? null,
            deps: {
              blockedBy: blockedBy.get(issue.id) ?? [],
              blocks: blocks.get(issue.id) ?? [],
            },
          }));
        });
        json(res, 200, out);
        return;
      }

      if (url.pathname === "/api/inbox") {
        const assignee = url.searchParams.get("assignee") ?? undefined;
        const out = allHandles().map((h) => {
          const inbox = h.store.inbox(assignee || undefined);
          const entries = [...inbox.ready, ...inbox.queued, ...inbox.blocked];
          const claims = h.store.claimActivityFor(entries.map((i) => i.id));
          /**
           * The same worklog summary `/api/issues` carries (STA-113), from the same store
           * method, so the two routes cannot disagree about one ticket.
           *
           * Attached ONTO the entry beside `claim` rather than beside it, because that is
           * the shape this route already has — `claim` is spread in here while on
           * `/api/issues` it sits next to `issue`. `lib/types.ts` documents that
           * divergence deliberately ("the two endpoints genuinely differ in shape here;
           * this type follows the wire"). Following the spec's prose instead would put two
           * different shapes on one route, which is worse than the inconsistency.
           */
          const worklogs = h.store.worklogSummaryFor(entries.map((i) => i.id));
          /**
           * A derived-blocked parent (STA-98) has no unblock descriptor of its
           * own — the fact belongs to the blocking CHILD — so the card would
           * otherwise render "? must act". One batched lookup over the blocked
           * bucket hands the page what it needs to name the real owner.
           *
           * Deliberately added HERE and not inside `store.inbox()`: the MCP
           * inbox tool spreads that return value straight onto the wire, and its
           * shape is a pinned contract. This is a UI affordance, so it lives on
           * the UI's route.
           */
          const blockingChildren = h.store.blockingChildrenOf(inbox.blocked.map((i) => i.id));
          const withClaim = <T extends { id: string }>(entry: T) => ({
            ...entry,
            claim: claims.get(entry.id) ?? null,
            worklog: worklogs.get(entry.id) ?? null,
          });
          return {
            workspace: h.slug,
            inbox: {
              ...inbox,
              ready: inbox.ready.map((entry) => ({ ...withClaim(entry), derivedBlockers: [] })),
              /**
               * The third bucket (STA-143). `gate` and `queuedBy` already ride on
               * every entry — `store.inbox()` computes them as part of the
               * bucketing decision — so the bucket and the fields cannot disagree
               * about one ticket, and there is nothing to re-derive here.
               *
               * `derivedBlockers: []` because a gate is not a blocker: the page
               * renders the reason from `queuedBy`/`gate`, and borrowing a child's
               * unblock descriptor would say something untrue about it.
               */
              queued: inbox.queued.map((entry) => ({ ...withClaim(entry), derivedBlockers: [] })),
              blocked: inbox.blocked.map((entry) => ({
                ...withClaim(entry),
                derivedBlockers: blockingChildren.get(entry.id) ?? [],
              })),
            },
          };
        });
        json(res, 200, out);
        return;
      }

      if (url.pathname === "/api/issue") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        json(res, 200, issueDetail(handle, url.searchParams.get("ref")!));
        return;
      }

      if (url.pathname === "/api/document") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        const doc = handle.store.getDocument(
          url.searchParams.get("ref")!,
          url.searchParams.get("key")!,
          url.searchParams.get("revision") ? Number(url.searchParams.get("revision")) : undefined,
        );
        json(res, 200, doc);
        return;
      }

      /**
       * The EXACT payload the MCP `get_task` tool returns, for the "what the agent
       * sees" pane.
       *
       * This must stay expression-for-expression identical to the get_task handler in
       * src/mcp.ts — same store.context() call, same includeDocuments flag, same
       * swallow-on-failure crossBlockers, and deliberately NO `workspace` key, which
       * /api/issue adds and get_task does not. A pane whose whole job is to show what
       * the agent really receives must not differ from it by even one field.
       *
       * test/ui-agent-context.test.ts holds the two surfaces together: it spawns a real
       * MCP server, calls get_task, calls this route, and asserts deep equality for both
       * values of include_documents. mcp.ts itself is not imported — the shared thing is
       * core/store.ts, which is what both call.
       */
      if (url.pathname === "/api/agent-context") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        const context = handle.store.context(url.searchParams.get("ref")!, {
          includeDocuments: url.searchParams.get("documents") === "1",
        });
        let crossBlockers: unknown[] = [];
        try {
          const hub = Hub.open();
          try {
            crossBlockers = hub.crossBlockersOf(context.issue.identifier);
          } finally {
            hub.close();
          }
        } catch {
          crossBlockers = [];
        }
        // get_task carries `claim` and the timing pair, so this route must too —
        // the whole point of this pane is that it differs from the agent's view
        // by exactly nothing.
        json(res, 200, {
          ...context,
          crossBlockers,
          claim: handle.store.claimActivity(context.issue.id),
          // Added here and in the get_task handler in src/mcp.ts in the same
          // change, deliberately: ui-agent-context.test.ts asserts deep equality
          // between the two, so one without the other is a red test, which is
          // exactly the guard that pin exists to be.
          gate: handle.store.gate(context.issue.id),
          queuedBy: handle.store.queuedBy(context.issue.id),
          ...handle.store.detailTiming(context.issue.id),
        });
        return;
      }

      /**
       * A document's history. A plain GET, so the token gate and the method pin above
       * already cover it — nothing about auth changed to add this.
       */
      if (url.pathname === "/api/revisions") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        json(
          res,
          200,
          handle.store.listDocumentRevisions(url.searchParams.get("ref")!, url.searchParams.get("key")!),
        );
        return;
      }

      if (url.pathname === "/api/graph") {
        if (options.hub) {
          const hub = Hub.open();
          try {
            json(res, 200, hub.graph());
          } finally {
            hub.close();
          }
        } else {
          const handle = handleFor();
          const issues = handle.store.listIssues({ includeResolved: true });
          /**
           * `parent`, for the graph's epic clusters (G3).
           *
           * IT IS THE PARENT'S IDENTIFIER, NOT `issue.parentId`. Every id in this
           * payload — node ids, both ends of every edge — is an identifier (`STA-12`),
           * while `parentId` is the internal uuid. Sending the uuid would give the
           * client a foreign key that joins to nothing in the document it arrived in.
           *
           * The map is built from the rows this route already read, so grouping the
           * whole graph by epic costs one extra pass over a list we have in hand and
           * no second query. A parent outside the list cannot happen (the list is
           * unfiltered), but `?? null` keeps a missing one as "no parent" — an
           * ungrouped node — rather than a dangling cluster key.
           *
           * Additive: every field that was here is still here, unchanged. The hub
           * branch above does NOT carry `parent` — that payload is built by
           * `Hub.graph()` in src/core — so hub mode derives no epics and draws the
           * flat graph exactly as before. The client treats `parent` as optional for
           * precisely this reason.
           */
          const identifierOf = new Map(issues.map((issue) => [issue.id, issue.identifier]));
          json(res, 200, {
            nodes: issues.map((issue) => ({
              id: issue.identifier,
              workspace: handle.slug,
              title: issue.title,
              status: issue.status,
              // Both graph producers send this one (STA-124) — see the note in
              // Hub.graph(). Unlike `parent`, there is no degraded branch.
              kind: issue.kind,
              parent: issue.parentId ? (identifierOf.get(issue.parentId) ?? null) : null,
            })),
            edges: handle.store.edges().map((edge) => ({ from: edge.blocker, to: edge.blocked, cross: false })),
          });
        }
        return;
      }

      if (url.pathname === "/api/events") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        const issue = url.searchParams.get("issue");
        if (issue) {
          /**
           * Issue-scoped window, for the detail panel's activity timeline.
           *
           * Without this the timeline would have to filter the workspace log
           * client-side, and the unfiltered route caps at 100 events — on a real
           * workspace that is a few hours, so an issue's first status change falls off
           * the window and the thread silently starts mid-story.
           *
           * store.listEvents() has no issue filter and src/core is not this route's to
           * change, so the query lives here. Reading handle.store.db directly is
           * precedent in this file, not a new pattern — fingerprint() does the same —
           * and the row mapping below mirrors listEvents() field for field so the two
           * shapes cannot drift.
           */
          const id = handle.store.getIssue(issue).id;
          const since = Number(url.searchParams.get("since") ?? 0);
          const rows = handle.store.db
            .prepare(
              `SELECT * FROM (
                 SELECT * FROM events WHERE issue_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?
               ) ORDER BY seq`,
            )
            .all(id, since, ISSUE_EVENT_LIMIT) as Array<{
            seq: number;
            kind: string;
            issue_id: string | null;
            actor: string | null;
            payload: string;
            dedup_key: string | null;
            created_at: string;
          }>;
          json(
            res,
            200,
            rows.map((row) => ({
              seq: row.seq,
              kind: row.kind,
              issueId: row.issue_id,
              actor: row.actor,
              payload: JSON.parse(row.payload) as Record<string, unknown>,
              dedupKey: row.dedup_key,
              createdAt: row.created_at,
            })),
          );
          return;
        }
        json(res, 200, handle.store.listEvents(Number(url.searchParams.get("since") ?? 0), 100));
        return;
      }

      /**
       * THE GATE FAMILY — Q2 (STA-144). Method and Origin were already enforced above.
       *
       * `POST /api/gate/request`         { ref, owner?, comment? }
       * `POST /api/gate/approve`         { ref, children?, comment? }
       * `POST /api/gate/request-changes` { ref, comment }
       *
       * Each answers `200` with the same payload `/api/issue` sends, or the store's own
       * refusal through the catch at the bottom of this handler — 409 with the store's
       * `code`, exactly as every other write on this server does.
       *
       * ── WHY THREE ROUTES AND NOT THREE MORE `/api/action` BRANCHES ──────────────────
       *
       * `/api/action` is `{ type }` over a flat body, and it has grown to nine branches
       * that share exactly one thing: they all end in `handle.store.<verb>(ref, …)`.
       * A gate is not that shape. `approve` takes a LIST of child refs and means
       * something different with it than without it; `request-changes` has a mandatory
       * field that no other action has. Folding them in would have meant three more
       * `body.x as Y` casts inside a chain whose every branch can already see the
       * others' fields — and the one thing a policy surface must not be is easy to call
       * by accident with the wrong verb's body.
       *
       * Separate paths also give the family its own place in the auth predicate above,
       * which is what lets "every write is POST + same-Origin" stay one sentence.
       *
       * ── THIS FILE DOES NOT DECIDE ANYTHING ─────────────────────────────────────────
       *
       * No validation here, and no re-wording. "A leaf has nothing to queue", "a gate
       * needs an owner", "that child is not underneath this gate", "request-changes
       * needs a comment" are all guards inside Q1's store methods, with sentences
       * written to be read by whoever is stuck. Re-checking any of them here would
       * create a second opinion that can drift; the `?? ""` on `owner` and `comment`
       * below is not a default but a cast, letting the store's own emptiness check be
       * the one that speaks.
       *
       * `actor` is `body.actor || "ui"`, the same attribution every `/api/action`
       * branch uses, so a gate opened from the page is attributed rather than
       * anonymous. It reaches the event log and, for request-changes, the comment.
       */
      if (url.pathname.startsWith("/api/gate/")) {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const ref = body.ref as string;
        const actor = (body.actor as string) || "ui";

        switch (url.pathname) {
          case "/api/gate/request":
            handle.store.gateIssue(
              ref,
              { owner: (body.owner as string) ?? "", comment: (body.comment as string) || undefined },
              actor,
            );
            break;
          case "/api/gate/approve":
            handle.store.approveGate(
              ref,
              {
                // Absent and empty mean the same thing to the store — approve the
                // WHOLE gate — and they must, because a checklist with nothing ticked
                // is the page's way of saying "all of it", not a request to release
                // zero children.
                children: stringList(body.children) ?? undefined,
                comment: (body.comment as string) || undefined,
              },
              actor,
            );
            break;
          case "/api/gate/request-changes":
            handle.store.requestChanges(ref, { comment: (body.comment as string) ?? "" }, actor);
            break;
          default:
            // An unknown member of the family is a 404, not a gate write. It falls
            // through to the same not-found the rest of this handler ends in.
            json(res, 404, { error: "not found" });
            return;
        }

        // Re-read rather than returning the store's `Issue`: the panel needs the
        // children, the comments and the refreshed `childrenQueued` to redraw the
        // checklist, and one consistent read is better than the client stitching two.
        json(res, 200, issueDetail(handle, ref));
        return;
      }

      /**
       * The SVG sanitiser over HTTP — R5d (STA-184). `POST /api/glyph/sanitize`
       * `{ svg, label? }` answers `{ svg, viewBox, label }`, the canonical document
       * `src/core/svg-sanitize.ts` writes, or the sanitiser's refusal as a 409
       * through the catch below, the way every other refusal reaches the page.
       *
       * It exists because the store accepts an `svg` appearance ONLY as the
       * sanitiser's own output and the sanitiser is core code the browser cannot
       * import: the picker sends the raw document here and stores nothing but the
       * answer. Nothing is written — no workspace handle is resolved, no event is
       * logged; it is a pure function over the body. POST all the same, and so
       * Origin-checked, because the body is markup somebody pasted, and a route
       * that reflects it must not be reachable from another origin's page.
       */
      if (url.pathname === "/api/glyph/sanitize") {
        const body = await readBody(req);
        const result = sanitizeSvg(body.svg, { label: typeof body.label === "string" ? body.label : undefined });
        if (!result.ok) throw new StapleError("validation", `Custom SVG must be ${result.problem}`);
        json(res, 200, { svg: result.svg, viewBox: result.viewBox, label: result.label });
        return;
      }

      /**
       * The workspace vocabulary — O7b (STA-141). The ONE route that both reads
       * and writes, which is why the method pin above became a list.
       *
       * GET and POST answer the SAME envelope. That is deliberate and it is what
       * lets the settings editor re-derive everything from one shape after a write
       * instead of merging a write result into a read it fetched earlier — the
       * merge is where a list quietly stops matching what the store believes.
       *
       * `usage` is the field the UI cannot do without: it is what makes the
       * migrate-to picker REQUIRED rather than merely offered, because the client
       * knows before it asks whether any issue still carries the row being removed.
       * The store remains the only authority on whether the removal is ALLOWED —
       * `removeStatus` refuses without a target and refuses to empty a required
       * category, and both refusals reach the page as the store's own sentence
       * through the catch below. The count only decides which control renders.
       */
      if (url.pathname === "/api/settings") {
        const handle = handleFor(
          (req.method === "POST" ? undefined : url.searchParams.get("ws")) ?? undefined,
        );

        /** The whole vocabulary, plus what a removal would have to move. */
        const envelope = (h: StoreHandle) => {
          const statuses = h.store.getStatuses();
          // Each kind row carries its resolved appearance (R5a, STA-181) — the
          // same record `list_kinds` and `staple kinds ls --json` serve.
          const kinds = h.store.getKindsWithAppearance();
          return {
            workspace: h.slug,
            statuses,
            kinds,
            /**
             * THE DERIVED ORDERS, computed by the store and never by the browser.
             *
             * `statuses` above is the CONFIGURED order — what the editor's drag
             * produces and what it must paint. It is NOT the order a list groups by:
             * `statusOrder()` tiers by category (active, review, gated, blocked,
             * ready, unstarted, done, cancelled) and lets the configured order break
             * ties WITHIN a tier, which is the same rank the store's own `CASE`
             * fragment sorts rows by.
             *
             * Serving it rather than letting the client re-derive it is the whole
             * point: a browser that reimplemented the tiering would be a second
             * authority on it, and the first time the two disagreed a group header
             * would sit above rows that sorted the other way. For a default
             * workspace `groupOrder` is byte-identical to the UI mirror's old
             * `[...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES]`.
             */
            groupOrder: h.store.statusOrder(),
            openOrder: h.store.openStatusOrder(),
            /** Agent-inbox pickup tiers, for a surface that wants to mirror them. */
            pickupOrder: h.store.inboxPickupOrder(),
            // Fixed and non-configurable — the category select's options, named by
            // the server so the client never hand-keeps a copy of a closed set.
            categories: [...STATUS_CATEGORIES],
            requiredCategories: [...REQUIRED_STATUS_CATEGORIES],
            usage: {
              statuses: Object.fromEntries(statuses.map((s) => [s.id, h.store.statusUsageCount(s.id)])),
              kinds: Object.fromEntries(kinds.map((k) => [k.id, h.store.kindUsageCount(k.id)])),
            },
            /**
             * THE REGISTRY (R6a, STA-176): every category and every typed setting
             * definition, so the shell enumerates its navigation from this and a
             * new setting reaches the page without a client change. `values` are
             * this workspace's effective values with provenance; `unknownKeys`
             * are stored keys this build has no definition for — preserved,
             * reported, never rewritten. `global` is the machine's config.json,
             * read-only here: it is a different store on purpose, and its write
             * path is `staple config set`.
             */
            registry: settingRegistryView(),
            values: Object.fromEntries(h.store.settingValues().map((view) => [view.key, view])),
            unknownKeys: h.store.unknownSettingKeys(),
            global: globalSettings(),
          };
        };

        if (req.method === "GET") {
          json(res, 200, envelope(handle));
          return;
        }

        // POST. Method and Origin were already enforced by the gate above.
        const body = await readBody(req);
        const target = body.target;
        const ops = body.ops;
        if (target !== "statuses" && target !== "kinds" && target !== "settings") {
          throw new StapleError("validation", 'settings requires target "statuses", "kinds" or "settings"');
        }
        if (!Array.isArray(ops) || ops.length === 0) {
          throw new StapleError("validation", "settings requires a non-empty ops array");
        }
        const writeHandle = handleFor((body.ws as string) ?? undefined);
        const actor = (body.actor as string) || "ui";
        // One ordered, all-or-nothing batch — the same store call `update_statuses`
        // and `update_kinds` make, so the two surfaces cannot disagree about what
        // an op means or about which of them is refused. `settings` (R6a) writes
        // registered WORKSPACE values the same way; a global key is refused by the
        // store with the sentence that names `staple config set`.
        if (target === "settings") writeHandle.store.applySettingOps(ops as SettingOp[], actor);
        else if (target === "statuses") writeHandle.store.applyStatusOps(ops as VocabularyOp[], actor);
        else writeHandle.store.applyKindOps(ops as VocabularyOp[], actor);
        json(res, 200, envelope(writeHandle));
        return;
      }

      // Method and Origin were already enforced by the gate above.
      if (url.pathname === "/api/action") {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const ref = body.ref as string;
        const actor = (body.actor as string) || "ui";
        const type = body.type as string;
        let result: unknown;
        if (type === "status") {
          const status = body.status as IssueStatus;
          result = handle.store.updateIssue(ref, { status, comment: body.comment as string | undefined }, actor);
          if (status === "done" || status === "cancelled") {
            notifyHubResolvedSafe(handle.slug, handle.store.getIssue(ref).identifier);
          }
        } else if (type === "checkout") {
          // Additive: absent stealIfIdleSeconds is exactly the old behaviour.
          result = handle.store.checkoutIssue(ref, actor, undefined, {
            stealIfIdleSeconds: optionalSeconds(body.stealIfIdleSeconds, "stealIfIdleSeconds"),
            /**
             * The human override (STA-168) — the UI's confirm-with-a-reason
             * dialog. Absent is exactly the old behaviour; present and blank is
             * refused by the store, so the "a reason is mandatory" rule has one
             * implementation for all three surfaces.
             */
            overrideReason: body.overrideReason === undefined ? undefined : String(body.overrideReason),
          });
        } else if (type === "release") {
          result = handle.store.releaseIssue(ref, actor, {
            ifIdleSeconds: optionalSeconds(body.ifIdleSeconds, "ifIdleSeconds"),
          });
        } else if (type === "comment") {
          result = handle.store.addComment(ref, body.body as string, actor, "user");
        } else if (type === "assignee") {
          result = handle.store.updateIssue(ref, { assignee: (body.assignee as string) || null }, actor);
        } else if (type === "doc_restore") {
          /**
           * Restore an old revision by writing its body forward as a NEW revision.
           * History is append-only: the restore itself shows up in the event log and
           * in the timeline, which is the point.
           *
           * store.restoreDocumentRevision() exists but takes no baseRevision, so it
           * cannot express optimistic concurrency. Composing the two public store
           * methods does, and a stale base throws revision_conflict, which the catch
           * below already maps to 409 / retryable.
           */
          const key = body.key as string;
          const revision = Number(body.revision);
          if (!Number.isInteger(revision) || revision < 1) {
            throw new StapleError("validation", "doc_restore requires an integer revision >= 1");
          }
          const base = body.baseRevision;
          if (base != null && !Number.isInteger(Number(base))) {
            throw new StapleError("validation", "baseRevision must be an integer when provided");
          }
          const old = handle.store.getDocument(ref, key, revision);
          result = handle.store.putDocument(ref, key, old.body, {
            baseRevision: base == null ? undefined : Number(base),
            author: actor,
            changeSummary: `restore revision ${revision}`,
          });
        } else if (type === "create") {
          /**
           * The first write on this surface that does not start from a ref.
           *
           * Everything it could refuse over — an empty title, the tree depth cap, a
           * repeated open title under the same parent — is already a guard inside
           * store.createIssue(), so this branch validates nothing itself and re-words
           * nothing: it shapes the body into a CreateIssueInput and lets the store
           * speak. `duplicate` had no HTTP projection before this branch existed;
           * test/contract-http.test.ts moved it out of the gap golden because of it.
           *
           * `actor` is the same `body.actor || "ui"` every other branch uses, so a
           * task created from the page is attributed rather than anonymous.
           */
          /**
           * R8 (STA-110): refs are routed by the workspace that OWNS them.
           *
           * A blocking relation between two workspaces is a real, supported thing — the
           * hub has held that edge since M1 (`Hub.addCrossLink`, `hub link`, MCP
           * `cross_link`). It simply had no HTTP route, which R7 mistook for
           * "unsupported" and turned into a same-workspace restriction. That is
           * backwards: cross-referencing across workspaces is what a hub is FOR.
           *
           * The two kinds of edge are genuinely different tables, and the hub insists on
           * the distinction rather than papering over it — `addCrossLink` REFUSES a
           * same-workspace pair with "use the workspace-local blocked-by instead". So we
           * partition first and never hand either side the other's refs.
           *
           * A ref the hub cannot place — unparseable, or a prefix the registry does not
           * know — is treated as LOCAL. That is not a fallback so much as the old
           * behaviour preserved exactly: the store's own `requireRow` still refuses it,
           * in its own words, and non-hub mode never touches this code at all.
           */
          const hub = options.hub ? openHubSafe() : null;
          try {
            const owner = (ref: string): string | null => {
              if (!hub) return null;
              try {
                return hub.resolveIdentifier(ref).entry.slug;
              } catch {
                return null; // not an identifier, or a prefix this hub does not know
              }
            };
            const partition = (refs: string[]) => {
              const local: string[] = [];
              const foreign: string[] = [];
              for (const ref of refs) {
                const slug = owner(ref);
                (slug === null || slug === handle.slug ? local : foreign).push(ref);
              }
              return { local, foreign };
            };

            const blockedBy = partition(stringList(body.blockedBy) ?? []);
            const blocking = partition(stringList(body.blocking) ?? []);

            /**
             * Everything createIssue() could refuse over — an empty title, the tree
             * depth cap, a repeated open title under the same parent — is already a
             * guard inside it, so this branch validates nothing itself and re-words
             * nothing: it shapes the body into a CreateIssueInput and lets the store
             * speak. Only the LOCAL blockers go in; `createIssue` resolves them with
             * `requireRow`, which cannot see another workspace's file.
             *
             * `actor` is the same `body.actor || "ui"` every other branch uses, so a
             * task created from the page is attributed rather than anonymous.
             */
            const created = handle.store.createIssue({
              title: body.title as string,
              description: (body.description as string) || null,
              priority: (body.priority as IssuePriority) || undefined,
              /**
               * O1b (STA-125). Additive, and shaped exactly like `priority` above: an
               * absent or empty value becomes `undefined`, which `createIssue` reads as
               * "use the workspace's default kind". It is NOT validated here — a kind
               * outside the configured vocabulary is refused by
               * `store.assertConfiguredKind()` in its own words, which is the same
               * bargain every other field on this branch makes.
               */
              kind: (body.kind as string) || undefined,
              parent: (body.parent as string) || null,
              labels: stringList(body.labels),
              blockedBy: blockedBy.local,
              estimatedSeconds: optionalEstimate(body.estimateSeconds),
              // Absent or empty means "no project"; an unknown one is the project
              // store's `not_found`, in its own words, before an issue number is spent.
              project: (body.project as string) || null,
              createdBy: actor,
            });

            /**
             * Everything after the insert, in one try so one refusal reports one truth.
             *
             * NOT TRANSACTIONAL WITH THE CREATE, and deliberately not pretended to be.
             * `tx()` opens `BEGIN IMMEDIATE` and is not re-entrant, so `createIssue`,
             * each `setBlockedBy` and each `addCrossLink` (a different database
             * entirely) are separate transactions that no third one can enclose. A
             * refusal partway leaves the task created and some edges written; the catch
             * below says so rather than letting the store's sentence imply nothing
             * happened, because the user's next move would otherwise be a retry that
             * trips the duplicate-title guard.
             */
            let phase = "Blocking links";
            try {
              /**
               * LOCAL blocking — the inverse relation, from R7.
               *
               * The store has no create-time input for it and no method with these
               * semantics: `setBlockedBy` REPLACES an issue's whole blocker set
               * (`DELETE … WHERE blocked_id = ?` then re-insert), so "also let this new
               * task block T" means writing T's entire next list. This composes two
               * public store methods to get there, exactly as `doc_restore` above
               * composes `getDocument` + `putDocument`.
               *
               * It happens HERE and not in the client because a UI doing
               * read-union-write across two round trips would silently delete any
               * blocker another agent added to T in between — and several agents
               * writing at once is this tracker's normal operating condition.
               */
              for (const targetRef of blocking.local) {
                const target = handle.store.getIssue(targetRef);
                const current = handle.store.blockersOf(target.id).map((row) => row.identifier);
                // INSERT OR IGNORE dedupes the edge, but the identifier list is what
                // gets re-inserted, so a repeat would be a wasted write, not a duplicate.
                if (current.includes(created.identifier)) continue;
                handle.store.setBlockedBy(targetRef, [...current, created.identifier], actor);
              }

              /**
               * CROSS-WORKSPACE, both directions. `addCrossLink(blocker, blocked)` is
               * directional, which is exactly what lets Blocking work across workspaces
               * as well as Blocked by — the new task is the blocked side in one case and
               * the blocker in the other. The hub validates that both identifiers
               * resolve, that each issue exists in its own file, and that the edge does
               * not close a cross-file cycle.
               */
              if (hub) {
                phase = "cross-workspace links";
                for (const blockerRef of blockedBy.foreign) {
                  hub.addCrossLink(blockerRef, created.identifier);
                }
                for (const blockedRef of blocking.foreign) {
                  hub.addCrossLink(created.identifier, blockedRef);
                }
              }
            } catch (error) {
              const because = error instanceof Error ? error.message : String(error);
              throw new StapleError(
                error instanceof StapleError ? error.code : "conflict",
                `${created.identifier} was created, but its ${phase} were not applied: ${because}`,
                {
                  identifier: created.identifier,
                  blockedBy: blockedBy.foreign,
                  blocking: [...blocking.local, ...blocking.foreign],
                },
              );
            }

            result = created;
          } finally {
            hub?.close();
          }
        } else if (type === "update") {
          /**
           * Inline property editing: title, priority, labels.
           *
           * store.updateIssue() already accepted all three — the gap was only that no
           * HTTP branch called it with them. The patch is built key by key so an
           * ABSENT key stays absent: `updateIssue` treats `undefined` as "leave alone"
           * and anything else as "set to this", so blindly copying the body would let
           * a title edit blank out the label set.
           *
           * Status is deliberately not routable here. It has its own branch, its own
           * hub fan-out on done/cancelled, and letting a second path set it would mean
           * two places that must remember to call notifyHubResolvedSafe().
           */
          const patch: UpdateIssueInput = {};
          if (body.title !== undefined) patch.title = body.title as string;
          if (body.priority !== undefined) patch.priority = body.priority as IssuePriority;
          /**
           * O1b (STA-125). Presence, not truthiness, like every other key on this patch —
           * but unlike `estimateSeconds` below there is no clear to express: `kind` is
           * two-state because the column is NOT NULL with a default (see
           * `UpdateIssueInput.kind`). An unconfigured value is `assertConfiguredKind`'s
           * to refuse, not this branch's.
           */
          if (body.kind !== undefined) patch.kind = body.kind as string;
          if (body.labels !== undefined) {
            const labels = stringList(body.labels);
            // A present-but-malformed labels value must not collapse to "delete all".
            if (labels === undefined) {
              throw new StapleError("validation", "labels must be an array of strings");
            }
            patch.labels = labels;
          }
          /**
           * Three-state, and the reason this is checked for PRESENCE rather than
           * truthiness: `null` is the clear, and `if (body.estimateSeconds)`
           * would drop it silently along with the clear the user asked for.
           */
          if (body.estimateSeconds !== undefined) {
            patch.estimatedSeconds = optionalEstimate(body.estimateSeconds) ?? null;
          }
          if (Object.keys(patch).length === 0) {
            throw new StapleError(
              "validation",
              "update requires one of title, priority, labels, estimateSeconds",
            );
          }
          result = handle.store.updateIssue(ref, patch, actor);
        } else {
          throw new StapleError("validation", `Unknown action "${type}"`);
        }
        json(res, 200, result);
        return;
      }

      /**
       * Milestones — R3b (STA-172), docs/milestones.md. Two reads and a POST
       * family, the gate routes' shape: every answer is the ONE milestone view
       * the CLI prints under `--json` and the MCP tools return, so the
       * Milestones page (R3c) redraws from a write result exactly as it does
       * from a read. `create` with `preview: true` writes nothing and returns
       * the plan; a stale `baseRevision` is the store's own revision_conflict.
       */
      if (url.pathname === "/api/milestones") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        json(res, 200, handle.store.milestones().list({ all: url.searchParams.get("all") === "1" }));
        return;
      }

      if (url.pathname === "/api/milestone") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        json(res, 200, handle.store.milestones().get(url.searchParams.get("ref") ?? ""));
        return;
      }

      if (url.pathname.startsWith("/api/milestone/")) {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const milestones = handle.store.milestones();
        const actor = (body.actor as string) || "ui";
        const ref = body.ref as string;
        const position = {
          before: body.before as string | undefined,
          after: body.after as string | undefined,
          at: body.at as number | undefined,
        };
        const baseRevision = body.baseRevision as number | undefined;
        let payload: unknown;
        switch (url.pathname) {
          case "/api/milestone/create":
            payload = milestones.create(
              {
                title: body.title as string | undefined,
                description: body.description as string | null | undefined,
                targetDate: body.targetDate as string | null | undefined,
                startDate: body.startDate as string | null | undefined,
                fromEpic: body.fromEpic as string | null | undefined,
                preview: body.preview === true,
              },
              actor,
            );
            break;
          case "/api/milestone/update":
            payload = milestones.update(
              ref,
              {
                targetDate: body.targetDate as string | null | undefined,
                startDate: body.startDate as string | null | undefined,
              },
              actor,
            );
            break;
          case "/api/milestone/add":
            payload = milestones.addMember(
              body.milestone as string,
              ref,
              { ...position, baseRevision, note: (body.note as string | undefined) ?? null },
              actor,
            );
            break;
          case "/api/milestone/remove":
            payload = milestones.removeMember(body.milestone as string, ref, { baseRevision }, actor);
            break;
          case "/api/milestone/move":
            payload = milestones.moveMember(ref, { ...position, to: body.to as string | undefined, baseRevision }, actor);
            break;
          case "/api/milestone/reorder":
            payload = milestones.reorderMembers(
              body.milestone as string,
              stringList(body.order) ?? [],
              { baseRevision },
              actor,
            );
            break;
          default:
            json(res, 404, { error: "not found" });
            return;
        }
        json(res, 200, payload);
        return;
      }

      /**
       * Projects — migration 009, docs/web-ui.md "Projects". One read and a POST
       * family, the milestone routes' shape.
       *
       * The read answers `{ workspace, project }` rows rather than bare projects,
       * and in hub mode with no `ws` it answers for EVERY workspace at once — the
       * same bargain `/api/issues` makes, and for the same reason: the rail lists
       * projects across workspaces when the page is on "all workspaces", and two
       * projects called `docs` in two workspaces have to be tellable apart.
       *
       * `assign` answers the refreshed `/api/issue` payload, as the gate routes
       * do, so the detail panel redraws from one consistent read.
       */
      if (url.pathname === "/api/projects") {
        const wanted = url.searchParams.get("ws") ?? undefined;
        const targets = options.hub && !wanted ? allHandles() : [handleFor(wanted)];
        json(
          res,
          200,
          targets.flatMap((h) => h.store.projects().list().map((project) => ({ workspace: h.slug, project }))),
        );
        return;
      }

      if (url.pathname.startsWith("/api/project/")) {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const projects = handle.store.projects();
        const actor = (body.actor as string) || "ui";
        /**
         * A missing or non-string `ref` is a validation refusal in the same envelope
         * every other refusal uses — not a TypeError three frames down that arrives as
         * a 500 with a stack trace for a message.
         */
        const requireRef = (): string => {
          if (typeof body.ref !== "string" || body.ref.trim() === "") {
            throw new StapleError("validation", "ref is required: a project id or slug, or an issue identifier", {
              field: "ref",
            });
          }
          return body.ref;
        };
        const fields = {
          name: body.name as string | null | undefined,
          kind: body.kind as ProjectKind | null | undefined,
          sourceKind: body.sourceKind as ProjectSourceKind | null | undefined,
          source: body.source as string | null | undefined,
        };
        switch (url.pathname) {
          case "/api/project/create":
            json(res, 200, { workspace: handle.slug, project: projects.create(fields, actor) });
            return;
          case "/api/project/update":
            json(res, 200, { workspace: handle.slug, project: projects.update(requireRef(), fields, actor) });
            return;
          case "/api/project/delete": {
            const removal = projects.remove(requireRef(), actor);
            json(res, 200, { workspace: handle.slug, ...removal });
            return;
          }
          case "/api/project/assign": {
            const ref = requireRef();
            // `project` must be SAID: a string files the issue, null takes it out. An
            // absent key is refused rather than read as "take it out" — a body that
            // forgot the field must not unfile a task by accident.
            if (!("project" in body) || (body.project !== null && typeof body.project !== "string")) {
              throw new StapleError("validation", "project must be a project id or slug, or null to unfile", {
                field: "project",
              });
            }
            projects.assign(ref, body.project as string | null, actor);
            json(res, 200, issueDetail(handle, ref));
            return;
          }
          default:
            json(res, 404, { error: "not found" });
            return;
        }
      }

      /**
       * The pickup queue — R2c (STA-168), docs/queue.md "Operations, by surface".
       * Two reads and a POST family, the milestone routes' shape: every answer is
       * the ONE `{revision, entries, effective}` view the CLI prints under
       * `--json` and the MCP tools return, so the queue editor (R2d) redraws from
       * a write result exactly as it does from a read. Every mutation goes
       * through `QueueStore.mutate`, the same method the other two surfaces call.
       */
      if (url.pathname === "/api/queue") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        json(
          res,
          200,
          handle.store.queue().view({
            all: url.searchParams.get("all") === "1",
            actor: url.searchParams.get("actor") ?? undefined,
          }),
        );
        return;
      }

      if (url.pathname === "/api/queue/next") {
        const handle = handleFor(url.searchParams.get("ws") ?? undefined);
        const { revision, next, skipped } = handle.store
          .queue()
          .effectiveQueue({ actor: url.searchParams.get("actor") ?? undefined });
        json(res, 200, { revision, next, skipped });
        return;
      }

      if (QUEUE_WRITE_PATHS.has(url.pathname)) {
        const body = await readBody(req);
        const handle = handleFor((body.ws as string) ?? undefined);
        const verb = QUEUE_VERBS[url.pathname]!;
        json(
          res,
          200,
          handle.store.queue().mutate(
            verb,
            {
              ref: body.ref as string | undefined,
              order: stringList(body.order) ?? undefined,
              before: body.before as string | undefined,
              after: body.after as string | undefined,
              at: body.at as number | undefined,
              baseRevision: body.baseRevision as number | undefined,
              note: (body.note as string | undefined) ?? null,
              all: body.all === true,
            },
            (body.actor as string) || "ui",
          ),
        );
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (error) {
      const envelope = errorEnvelope(error);
      if (error instanceof StapleError) {
        json(res, error.code === "not_found" ? 404 : 409, {
          error: envelope.message,
          message: envelope.message,
          code: envelope.code,
          detail: envelope.detail,
          retryable: envelope.retryable,
        });
      } else {
        json(res, 500, {
          error: envelope.message,
          message: envelope.message,
          code: envelope.code,
          retryable: envelope.retryable,
        });
      }
    }
  });

  /**
   * The workspace name for the startup banner — and the one place a resolution
   * failure used to kill the process.
   *
   * A1 filed this as a pre-existing bug against A6 (the ticket that owns the UI
   * lifecycle): `handleFor()` was called directly inside the `server.listen`
   * callback, which runs on a tick with no enclosing try/catch. A `StapleError`
   * from workspace resolution therefore escaped as an uncaught exception and
   * took the whole process down — after the socket was already bound, so the
   * failure looked like a crash rather than like "there is no workspace here".
   * A5 then gave it a second trigger: resolution can now also throw `conflict`
   * when a directory holds two canonical databases.
   *
   * Catching here is the right layer, not merely the convenient one. This
   * server's contract is that resolution happens per request and a failure is
   * answered with an error envelope on that request (that is what the surviving
   * `/api/*` handlers do); the banner is decoration over the same lazily-opened
   * handle. Refusing to START because the banner cannot be written would be a
   * different, worse contract.
   *
   * The command layer is where "there is no workspace here" becomes a non-zero
   * exit: `staple open` resolves before it ever calls this function, so an
   * unresolvable directory exits 3 (or 4) without binding a socket at all. What
   * is left here is the in-process caller — a test, or an embedder — for whom a
   * live server answering 404s is the useful behaviour.
   *
   * On the success path the returned string is byte-identical to the old
   * expression, so every pinned startup line is unchanged.
   */
  function describeMode(): string {
    if (options.hub) return "hub (all workspaces)";
    try {
      return `workspace "${handleFor().slug}"`;
    } catch (error) {
      const envelope = errorEnvelope(error);
      return `unresolved workspace (${envelope.code}: ${envelope.message.split("\n")[0]})`;
    }
  }

  server.listen(options.port, "127.0.0.1", () => {
    /**
     * S10: the startup and long-running-session triggers, both of them, here.
     *
     * On `listening` rather than at construction, because a server that failed to
     * bind is not a session and must not have started one. Both calls are silent
     * on a machine that has not consented — `startup` returns after one
     * `existsSync` on a fresh install — and the interval is `unref`'d, so a
     * process that has finished its work is never held open by its own heartbeat.
     */
    autoSync.startup();
    autoSync.startSession();
    const mode = describeMode();
    // The token rides in the URL because that URL is the only way into the page.
    console.log(`staple ui — ${mode} at http://localhost:${boundPort()}/`);
    console.log(`  (browser on this machine needs no token; API callers use ~/.staple/ui-token or ?token=${token.slice(0, 8)}…)`);
  });

  return {
    token,
    server,
    close() {
      /**
       * S10: FIRST, before the stores are closed.
       *
       * A run in flight holds `handle.store.db` and will keep applying pulled
       * pages to it. Closing the handle underneath it would turn a routine
       * shutdown into a write against a closed database, and the abort has to
       * land before that can happen. It also stops the session interval, without
       * which a `close()` would leave a timer firing at a resolver whose stores
       * are gone.
       */
      autoSync.stop();
      server.closeAllConnections();
      server.close();
      // Outstanding connect consents die with the process that showed them. A
      // ticket is a record that somebody was looking at a preview a moment ago,
      // not a stored permission; see `core/cloud/consent.ts`.
      consents.clear();
      for (const handle of stores.values()) {
        try {
          handle.store.db.close();
        } catch {
          /* already closed */
        }
      }
      stores.clear();
    },
  };
}
