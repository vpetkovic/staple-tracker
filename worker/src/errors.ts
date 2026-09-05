/**
 * The error taxonomy from docs/sync.md, and the only way this Worker produces a
 * non-2xx response.
 *
 * The shape is the one the CLI already returns — `{ code, message, retryable }` —
 * because a client that already knows how to render a Staple error should not have
 * to learn a second vocabulary for the network.
 *
 * `retryable` is a property of the CODE, not of the call site. It is looked up here
 * rather than passed in, so no route can accidentally mark a `validation` retryable
 * and turn one bad request into a sustained one.
 */

export type ErrorCode =
  | "validation"
  | "auth"
  | "forbidden"
  | "revoked"
  | "not_found"
  | "conflict"
  | "epoch_changed"
  | "cursor_invalid"
  | "payload_too_large"
  | "schema_ahead"
  | "protocol_unsupported"
  | "rate_limited"
  | "unavailable";

/**
 * HTTP status per code, and whether a client may retry it.
 *
 * Only `rate_limited` and `unavailable` are retryable. (`offline` is in the contract's
 * table too, but it is a client-side condition — there is no server response that
 * carries it, so it is not a code this Worker can emit.)
 */
const TAXONOMY: Record<ErrorCode, { status: number; retryable: boolean }> = {
  validation: { status: 400, retryable: false },
  auth: { status: 401, retryable: false },
  forbidden: { status: 403, retryable: false },
  revoked: { status: 403, retryable: false },
  not_found: { status: 404, retryable: false },
  conflict: { status: 409, retryable: false },
  epoch_changed: { status: 409, retryable: false },
  cursor_invalid: { status: 400, retryable: false },
  payload_too_large: { status: 413, retryable: false },
  schema_ahead: { status: 422, retryable: false },
  protocol_unsupported: { status: 426, retryable: false },
  rate_limited: { status: 429, retryable: true },
  unavailable: { status: 503, retryable: true },
};

/**
 * Thrown anywhere in a route and caught by the one handler in index.ts.
 *
 * `detail` carries the code-specific extras the contract names — the supported
 * protocol range on `protocol_unsupported`, the current epoch on `epoch_changed` —
 * and is merged into the response body. It is a plain record of primitives on
 * purpose: nothing that could transitively hold a credential can be put in it.
 */
export class SyncError extends Error {
  readonly code: ErrorCode;
  readonly detail: Record<string, string | number | boolean>;
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    detail: Record<string, string | number | boolean> = {},
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }

  get status(): number {
    return TAXONOMY[this.code].status;
  }

  get retryable(): boolean {
    return TAXONOMY[this.code].retryable;
  }

  toResponse(): Response {
    return json(
      { code: this.code, message: this.message, retryable: this.retryable, ...this.detail },
      this.status,
      this.headers,
    );
  }
}

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The contract requires TLS and this Worker refuses plaintext, so tell the
      // browser and any intermediary the same thing rather than relying on it.
      "strict-transport-security": "max-age=31536000",
      // A sync endpoint is not a document. Nothing here should ever be sniffed,
      // framed, or cached by an intermediary.
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function isRetryable(code: ErrorCode): boolean {
  return TAXONOMY[code].retryable;
}

export function statusFor(code: ErrorCode): number {
  return TAXONOMY[code].status;
}
