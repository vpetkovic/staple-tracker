/**
 * The cloud sync error taxonomy, as `StapleError`s (STA-251).
 *
 * `docs/sync.md`, "Error taxonomy": thirteen codes the service sends and one, `offline`,
 * that only the client can produce. Every one is a `StapleErrorCode` member, so a sync
 * failure surfaces with the service's own code on every surface — the `--json` envelope,
 * the MCP error, the CLI's exit status — and its retry bit is the protocol's.
 *
 * It is its own module, and imports nothing that can reach the network, so that code
 * which refuses on the client's side of the wire (`seed.ts`, `hydrate.ts`) can build the
 * same error the client would without loading `client.ts`. `client.ts` re-exports all
 * of it; that file stays the only outbound call site.
 *
 * ## `detail.cloudCode` and `detail.retryable`
 *
 * Until STA-251 the StapleError code was the nearest STORE code (`validation`, `conflict`)
 * and these two keys carried the truth. They stay, because `--json` consumers read them,
 * and they now always equal the envelope's `code` and `retryable`. `detail.cloudCode` is
 * also what marks a failure as the cloud layer's rather than a local check that happens
 * to share a name: a local `validation` has none. {@link cloudCodeOf} reads it only for
 * that.
 */
import { StapleError, isRetryableErrorCode, type StapleErrorCode } from "../types.js";

/** Every sync code, in the contract table's order. */
export const CLOUD_ERROR_CODES = [
  "validation",
  "auth",
  "forbidden",
  "revoked",
  "not_found",
  "conflict",
  "epoch_changed",
  "cursor_invalid",
  "payload_too_large",
  "schema_ahead",
  "protocol_unsupported",
  "rate_limited",
  "unavailable",
  "offline",
] as const satisfies readonly StapleErrorCode[];

export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[number];

export function isCloudErrorCode(value: unknown): value is CloudErrorCode {
  return typeof value === "string" && (CLOUD_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * A sync failure. The code is `code`, and the retry bit is the one `errorEnvelope` will
 * report for it.
 *
 * Exported so that a client-side refusal carries the SAME shape as a server-side one. The
 * backup lane refuses two things before it ever makes a request — a backup written by a
 * newer schema (`schema_ahead`) and a command run without the third consent
 * (`forbidden`) — and a caller should not have to know which side of the wire decided.
 */
export function cloudError(
  code: CloudErrorCode,
  message: string,
  detail: Record<string, unknown> = {},
): StapleError {
  return new StapleError(code, message, {
    ...detail,
    cloudCode: code,
    retryable: isRetryableErrorCode(code),
  });
}

/**
 * The code of a failure the cloud layer produced, or null when it is not one.
 *
 * The code itself is the StapleError's own. The null is the point of the function: a
 * hub fan-out row reports the service's opinion beside the error code, and a local
 * `validation` — an unreadable connection record — is not the service's opinion.
 */
export function cloudCodeOf(error: unknown): CloudErrorCode | null {
  if (!(error instanceof StapleError) || !isCloudErrorCode(error.code)) return null;
  return error.detail?.cloudCode === error.code ? error.code : null;
}
