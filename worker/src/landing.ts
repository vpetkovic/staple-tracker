/**
 * GET /join/{repoId} — the page a share link opens in a browser.
 *
 * A share link is `https://<this service>/join/<repositoryId>?n=<name>&p=<prefix>&by=<owner>&as=<invitee>`
 * (`src/core/cloud/share-link.ts`). Somebody who clicks one lands here and is told how to
 * join: open it in Staple, or paste the command into a terminal.
 *
 * WHAT THE PAGE KNOWS: nothing the request does not carry. It is the same static bytes for
 * every repository and every query. The path id is checked for shape and nothing is looked
 * up — no D1 read, so the page cannot tell anyone whether a repository exists — and the
 * names in the query are read by the page's own script in the browser and written with
 * `textContent`, never as markup. A hostile `n` is therefore text on the page, and nothing
 * here ever reflects it into the HTML the server sends.
 *
 * WHAT THE PAGE MAY DO: run its one inline script and its one inline style, both pinned by
 * hash in the Content-Security-Policy; nothing else. No external script, style, font or
 * image, no form, no framing, no referrer — the link's names stay out of the referrer the
 * "Open in Staple" link would otherwise send to the local app.
 */
import { SyncError } from "./errors.js";

/** The local Staple app a person opens the link in (`staple open` serves it here by default). */
export const LOCAL_APP_ORIGIN = "http://localhost:4400";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --card: #fff; --fg: #111; --muted: #666; --line: #e5e5e5; --accent: #111; --accent-fg: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --card: #161616; --fg: #ededed; --muted: #a1a1a1; --line: #2e2e2e; --accent: #ededed; --accent-fg: #0a0a0a; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 520px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
h1 { font-size: 20px; line-height: 1.3; margin: 0 0 4px; overflow-wrap: anywhere; }
p { margin: 0 0 16px; color: var(--muted); overflow-wrap: anywhere; }
.open { display: block; text-align: center; padding: 10px 14px; border-radius: 8px; background: var(--accent); color: var(--accent-fg); text-decoration: none; font-weight: 600; margin-bottom: 20px; }
.label { font-size: 13px; color: var(--muted); margin: 0 0 6px; }
.row { display: flex; gap: 8px; margin-bottom: 16px; }
code { flex: 1; min-width: 0; display: block; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-x: auto; white-space: nowrap; }
button { flex: none; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); font: inherit; font-size: 13px; cursor: pointer; }
.hint { font-size: 13px; margin: 0; }
.hint code.inline { display: inline; padding: 1px 4px; white-space: normal; }
`;

/**
 * Reads the link from the address bar, as the browser parsed it, and fills the page with
 * `textContent`. The checks mirror `cleanName`/`cleanPrefix` in share-link.ts loosely: a
 * name that would not fit in a link the client writes is shown as "a workspace" instead.
 */
const SCRIPT = `
(function () {
  var q = new URLSearchParams(location.search);
  var safe = /^[\\p{L}\\p{N}][\\p{L}\\p{N} ._-]*$/u;
  function nameOf(key) {
    var v = (q.get(key) || "").normalize("NFKC").trim();
    return v.length > 0 && v.length <= 64 && safe.test(v) ? v : null;
  }
  var n = nameOf("n");
  var by = nameOf("by");
  var as = nameOf("as");
  var prefix = (q.get("p") || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(prefix)) prefix = null;
  var link = location.origin + location.pathname + location.search;
  var command = "staple cloud join '" + link.replace(/'/g, "'\\\\''") + "'";
  function text(id, value) { document.getElementById(id).textContent = value; }
  text("title", (by ? by + " invited you to join " : "You are invited to join ") + (n ? n : "a shared workspace"));
  text("sub", (prefix ? prefix + " \\u00b7 " : "") + (as ? "You were invited as " + as + ". " : "") +
    "Joining shows a short code on your device. Read it to whoever shared this, and they approve it.");
  document.getElementById("open").setAttribute("href", ${JSON.stringify(LOCAL_APP_ORIGIN)} + "/?join=" + encodeURIComponent(link));
  text("command", command);
  document.getElementById("copy").addEventListener("click", function () {
    var button = this;
    function done(ok) { button.textContent = ok ? "Copied" : "Select and copy"; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(command).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  });
})();
`;

const BODY = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Join a shared Staple workspace</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1 id="title">You are invited to join a shared workspace</h1>
<p id="sub">Joining shows a short code on your device. Read it to whoever shared this, and they approve it.</p>
<a class="open" id="open" href="${LOCAL_APP_ORIGIN}/" rel="noreferrer">Open in Staple</a>
<p class="label">Or paste this into a terminal:</p>
<div class="row"><code id="command">staple cloud join '&lt;this link&gt;'</code><button type="button" id="copy">Copy</button></div>
<p class="hint">Don't have Staple yet? Install it with <code class="inline">npm install -g staple-cli</code>, run <code class="inline">staple open</code>, then come back to this link.</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

let policy: Promise<string> | null = null;

/** The CSP, with the one script and the one style pinned by hash. Computed once per isolate. */
function contentSecurityPolicy(): Promise<string> {
  policy ??= (async () => {
    const [script, style] = await Promise.all([sha256Base64(SCRIPT), sha256Base64(STYLE)]);
    return [
      "default-src 'none'",
      `script-src 'sha256-${script}'`,
      // Exactly one stylesheet. The page has no `style=` or `on*=` attributes: a hash
      // does not cover those, and the browser would block them.
      `style-src 'sha256-${style}'`,
      "img-src 'none'",
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
  })();
  return policy;
}

/** GET /join/{repoId}. `repoId` is the raw path segment. */
export async function joinLandingPage(request: Request, rawRepoId: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new SyncError("validation", "method not allowed");
  }
  let repoId: string;
  try {
    repoId = decodeURIComponent(rawRepoId).toLowerCase();
  } catch {
    throw new SyncError("not_found", "unknown route");
  }
  // Shape only. Whether such a repository exists is not this page's business, and not
  // something an unauthenticated visitor gets to find out.
  if (!UUID_RE.test(repoId)) throw new SyncError("not_found", "unknown route");

  return new Response(request.method === "HEAD" ? null : BODY, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": await contentSecurityPolicy(),
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000",
      // The page is the same bytes for every repository; caching it reveals nothing.
      "cache-control": "public, max-age=300",
    },
  });
}

/** For tests: the exact bytes the page serves. */
export const LANDING_PAGE_BODY = BODY;
