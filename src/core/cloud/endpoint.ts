/**
 * The endpoint a repository is connected to, validated before anything is done
 * with it.
 *
 * Contract: `docs/sync.md`, "Trust boundaries" — "**TLS is required.** No
 * plaintext transport, no certificate-validation escape hatch, no
 * `NODE_TLS_REJECT_UNAUTHORIZED` accommodation. A non-HTTPS endpoint is refused
 * at connect time, so it cannot be configured and discovered later."
 *
 * ## Everything here is parsing, and parsing only
 *
 * Nothing in this module resolves a hostname, opens a socket, or calls
 * `fetch`. That is not an omission — it is the reason the module exists as its
 * own file. `staple cloud connect` has to show a human what it is about to talk
 * to BEFORE it talks to it, and a validator that quietly did a DNS lookup to
 * "check the host is real" would make the preview itself an outbound call. The
 * network rule counts attempts, not successes, so that lookup would be a
 * violation even when it failed.
 *
 * `new URL(...)` is a pure string operation. It stays that way.
 *
 * ## Why loopback is exempt from the HTTPS requirement
 *
 * The same line the Worker draws in `worker/src/http.ts`: `wrangler dev --local`
 * serves `http://127.0.0.1`, and the contract's own network rule already says a
 * connection whose destination is `127.0.0.1`, `::1` or `localhost` is not
 * egress. Refusing plaintext loopback would make the Worker's own local
 * development mode unreachable from the client that is supposed to talk to it,
 * and would buy nothing: there is no network segment between the two processes
 * on which to intercept anything.
 *
 * This is deliberately not a general "trusted host" mechanism. There is no flag,
 * no environment variable and no allowlist — the exemption is the loopback
 * address itself, which cannot be pointed somewhere else.
 */
import { StapleError } from "../types.js";

/** Hosts for which plaintext HTTP is not egress and therefore not refused. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface CloudEndpoint {
  /** The normalized origin, no trailing slash. What every request is built from. */
  readonly origin: string;
  /** The hostname alone, for the preview a human reads before consenting. */
  readonly host: string;
  /** true when this is a loopback endpoint and the HTTPS requirement was waived. */
  readonly loopback: boolean;
}

export function isLoopbackHost(hostname: string): boolean {
  // `new URL("http://[::1]/").hostname` is "[::1]" — brackets included — so the
  // literal has to be unwrapped before it can be compared.
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

/**
 * Parse and validate an endpoint, or refuse with a sentence that says why.
 *
 * Refusals are `validation` because every one of them is a typo or a decision a
 * human has to make differently, never something to retry.
 */
export function parseEndpoint(raw: string): CloudEndpoint {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new StapleError("validation", "An endpoint is required, e.g. https://sync.example.workers.dev");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new StapleError(
      "validation",
      `"${trimmed}" is not a URL. Pass the full origin, e.g. https://sync.example.workers.dev`,
    );
  }

  const loopback = isLoopbackHost(url.hostname);

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new StapleError(
      "validation",
      `The endpoint must be https. "${url.protocol}//" is refused at connect time rather than ` +
        `accepted and discovered later, because a credential sent over plaintext is a credential ` +
        `that has already leaked. (http:// is allowed for 127.0.0.1, ::1 and localhost only, ` +
        `which is how \`wrangler dev --local\` is reached.)`,
    );
  }

  /**
   * Credentials are never in a URL. If someone pastes an endpoint carrying
   * userinfo, refuse it rather than silently stripping it: the paste they made
   * probably had a secret in it, and a command that quietly accepted it would
   * leave that secret in their shell history with no indication anything was
   * wrong.
   */
  if (url.username !== "" || url.password !== "") {
    throw new StapleError(
      "validation",
      "The endpoint must not carry a username or password. Credentials travel in the " +
        "Authorization header, never in a URL — a URL is logged, a header is not. " +
        "Remove the userinfo and pass the secret with --token.",
    );
  }

  if (url.search !== "" || url.hash !== "") {
    throw new StapleError(
      "validation",
      "The endpoint must be a bare origin with no query string or fragment. " +
        "Nothing in the sync protocol accepts a credential in a query parameter, and this " +
        "refusal is what keeps that true even by accident.",
    );
  }

  /**
   * A path is tolerated and normalized away rather than refused. Pasting the
   * origin with a trailing slash is not a mistake worth a refusal, and the
   * routes this client builds are absolute (`/v1/...`) so a base path would be
   * ignored anyway — better to drop it visibly in the preview than to carry a
   * component that has no effect.
   */
  const origin = `${url.protocol}//${url.host}`;

  return { origin, host: url.hostname, loopback };
}

/** Build a request URL for a route on this endpoint. Path only, never a query credential. */
export function endpointUrl(endpoint: CloudEndpoint, path: string): string {
  if (!path.startsWith("/")) throw new StapleError("validation", `route "${path}" must be absolute`);
  return `${endpoint.origin}${path}`;
}
