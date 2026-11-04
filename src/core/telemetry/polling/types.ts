/**
 * Live usage polling (design/execution-telemetry.md, "Live polling"): one small interface
 * every provider implements, so adding a provider is one new module in this directory
 * and one line in `registry.ts`.
 *
 * A poller asks its provider for the account's current usage with the sign-in the
 * provider's own tool already keeps on this machine, and maps the answer onto the same
 * {@link BudgetReading} the passive sources produce (`sources/`), marked
 * `source.kind: "usage_poll"`. It never stores anything itself: the runner (`run.ts`)
 * hands its readings to `ingestPolledReadings`, the store tail every source shares.
 *
 * ## Credentials
 *
 * A credential is read at call time into memory, sent only to the provider's own usage
 * endpoint, and dropped. It is never logged, printed, stored, returned or written back
 * (a token is never refreshed or rotated here: an expired sign-in is reported, and the
 * provider's own tool renews it the next time it runs). A failure carries only the fixed
 * sentence its poller wrote, never an error message from a subprocess, a response body or
 * the network stack, any of which could echo the secret.
 */
import type { BindingSource, KnownBinding } from "../config.js";
import type { ParsedItem } from "../sources/types.js";

/** Why a poll produced no reading, in a closed set the page words for itself. */
export type PollFailureCode =
  /** No sign-in for this binding's home on this machine. */
  | "signed_out"
  /** The stored sign-in has expired; the provider's tool renews it when it next runs. */
  | "expired"
  /** A sign-in exists but cannot read plan limits (an API key, a setup token). */
  | "unsupported_login"
  /** The provider refused the sign-in (401/403). */
  | "rejected"
  /** The provider asked us to slow down (429). */
  | "rate_limited"
  /** No answer within the timeout. */
  | "timeout"
  /** The request never reached the provider (DNS, offline, TLS). */
  | "network"
  /** The provider answered with an error status. */
  | "provider_error"
  /** The provider answered, but not in a shape this build reads. */
  | "unexpected_response";

export interface PollFailure {
  readonly ok: false;
  readonly code: PollFailureCode;
  /** One plain sentence for the operator, written by the poller. Never contains a secret. */
  readonly message: string;
  /** From a 429's Retry-After, when it gave one. */
  readonly retryAfterSeconds?: number;
}

export interface PollSuccess {
  readonly ok: true;
  /** Readings (and limits skipped with a reason), exactly as a passive source would hand them over. */
  readonly items: readonly ParsedItem[];
  /**
   * Limits the provider reported with no window running (nothing used since the last
   * reset): stored as nothing, like a passive source that has no window to report, but
   * named so the page can say the allowance is full rather than unknown.
   */
  readonly idle: readonly string[];
}

export type PollResult = PollSuccess | PollFailure;

/** Reads a stored sign-in. Injected so tests never touch a real keychain or credential file. */
export interface SecretReader {
  /** A macOS keychain generic password (`security find-generic-password -w`), or null when there is none. */
  keychain(service: string, account: string): Promise<string | null>;
  /** A file's text, or null when it does not exist. */
  file(path: string): string | null;
}

export interface PollContext {
  readonly fetch: typeof fetch;
  readonly now: () => string;
  readonly platform: NodeJS.Platform;
  /** The OS user name, the account a keychain item is filed under. */
  readonly userName: string;
  readonly secrets: SecretReader;
  /** How long one request may take, in milliseconds. */
  readonly timeoutMs: number;
}

export interface UsagePoller {
  /** A short stable id: `claude`, `codex`. Keys the poll state and the log. */
  readonly id: string;
  /** What the page and the log call it. */
  readonly name: string;
  /** The binding source whose home holds this provider's sign-in. */
  readonly bindingSource: BindingSource;
  /** The provider slug a binding must name for this poller to ask on its behalf. */
  readonly provider: string;
  /** The one host this poller ever calls, for the consent text and the network rule. */
  readonly host: string;
  /** Whether this poller can ask for this binding at all (its source and provider), without I/O. */
  isAvailable(binding: KnownBinding): boolean;
  /** Ask once. Never throws: every failure is a {@link PollFailure}. */
  poll(binding: KnownBinding, context: PollContext): Promise<PollResult>;
}

export function failure(code: PollFailureCode, message: string, retryAfterSeconds?: number): PollFailure {
  return retryAfterSeconds === undefined ? { ok: false, code, message } : { ok: false, code, message, retryAfterSeconds };
}

/**
 * One GET to a provider's usage endpoint, with the failures every poller words the same
 * way. The response body is parsed only on 200 and never quoted back; redirects are
 * refused so a credential cannot follow one to another host.
 */
export async function getJson(
  context: PollContext,
  url: string,
  headers: Record<string, string>,
  name: string,
  signIn: string,
): Promise<{ ok: true; body: unknown } | PollFailure> {
  let response: Response;
  try {
    response = await context.fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(context.timeoutMs) });
  } catch (error) {
    const kind = (error as { name?: string } | null)?.name;
    if (kind === "TimeoutError" || kind === "AbortError") {
      return failure("timeout", `${name} didn't answer within ${Math.round(context.timeoutMs / 1000)} seconds. We'll try again at the next check.`);
    }
    return failure("network", `We couldn't reach ${name} from this computer (offline, or the connection was blocked). We'll try again at the next check.`);
  }
  if (response.status === 401 || response.status === 403) {
    return failure("rejected", `${name} turned down the sign-in on this computer. ${signIn}`);
  }
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const seconds = header === null ? Number.NaN : Number(header);
    return failure(
      "rate_limited",
      `${name} asked us to check less often. We'll wait and try again.`,
      Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : undefined,
    );
  }
  if (!response.ok) {
    return failure("provider_error", `${name}'s usage service answered with an error (HTTP ${response.status}). We'll try again at the next check.`);
  }
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return failure("unexpected_response", `${name} answered in a form we don't recognise, so no reading was stored.`);
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
