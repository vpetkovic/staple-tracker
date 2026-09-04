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
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub, notifyHubResolvedSafe } from "../core/hub.js";
import { openWorkspace, resolveWorkspace } from "../core/workspace.js";
import { StapleError, errorEnvelope, type IssuePriority, type IssueStatus } from "../core/types.js";
// O7b (STA-141): the closed category set and the categories the code writes into,
// both served verbatim on /api/settings so the browser never hand-keeps a copy.
import { REQUIRED_STATUS_CATEGORIES, STATUS_CATEGORIES } from "../core/types.js";
import type { SettingOp, UpdateIssueInput, VocabularyOp, WorkspaceStore } from "../core/store.js";
// R6a (STA-176): the settings registry and the global values it defines, served
// beside the workspace ones so the page can say which scope each setting has.
import { settingDefinitionsFor, settingRegistryView, settingValueView } from "../core/settings-registry.js";
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
            stores.set(entry.slug, { slug: entry.slug, prefix: entry.prefix, store: ws.store });
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
      handle = { slug: ws.store.slug, prefix: ws.store.prefix, store: ws.store };
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
          url.pathname === "/api/action" || url.pathname.startsWith("/api/gate/")
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
      }

      if (url.pathname === "/api/bootstrap") {
        const handles = allHandles();
        json(res, 200, {
          mode: options.hub ? "hub" : "workspace",
          workspaces: handles.map((h) => ({ slug: h.slug, prefix: h.prefix })),
        });
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
    const mode = describeMode();
    // The token rides in the URL because that URL is the only way into the page.
    console.log(`staple ui — ${mode} at http://localhost:${boundPort()}/`);
    console.log(`  (browser on this machine needs no token; API callers use ~/.staple/ui-token or ?token=${token.slice(0, 8)}…)`);
  });

  return {
    token,
    server,
    close() {
      server.closeAllConnections();
      server.close();
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
