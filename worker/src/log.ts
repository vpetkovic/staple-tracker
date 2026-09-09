/**
 * The only place in this Worker that calls `console.*`.
 *
 * Workers Logs documents NO redaction mechanism of its own. There is head sampling
 * and there is the ability to turn invocation logs off, and there is nothing that
 * scrubs a field. The platform's one redaction guarantee — `REDACTED` for header
 * names containing `auth`, `key`, `secret`, `token`, `jwt` or `cookie` — applies to
 * Tail Worker events, not to anything you log yourself. So: assume nothing is
 * redacted for you, and redact by construction instead.
 *
 * Redaction here is structural, not a filter. `LogFields` is a closed record of
 * primitives; there is no spread, no rest parameter, and no `unknown`. A credential
 * cannot be logged by this module because there is no parameter it would fit in.
 *
 * Two gates keep it that way:
 *   - `npm run lint:logs` fails if any file under src/ other than this one calls
 *     `console.*`.
 *   - test/redaction.test.ts drives real authenticated requests with a console spy
 *     and asserts no captured argument stringifies to contain the raw token.
 *
 * The corresponding config half is in wrangler.toml: `invocation_logs = false`,
 * because the invocation log's message is `<Method> <URL>` plus request and response
 * metadata nobody here chose to emit.
 */

/**
 * The complete set of things this Worker will ever log. Adding a field is a
 * deliberate edit to this type, which is the point.
 */
export interface LogFields {
  event: string;
  status: number;
  duration_ms?: number;

  /** Repository and device ids are opaque identifiers, not secrets. */
  repo_id?: string;
  device_id?: string;

  /** Never the token, and never a prefix of it. See `tokenFingerprint`. */
  token_fp?: string;

  op_count?: number;
  applied_count?: number;
  duplicate_count?: number;
  seq_from?: number;
  seq_to?: number;
  epoch?: number;
  entity_count?: number;
  protocol?: number;
  code?: string;
  route?: string;
  method?: string;
}

export function log(fields: LogFields): void {
  // Structured JSON, not interpolated text: Workers Logs indexes the fields of an
  // object and does not index the contents of a string.
  console.log(fields);
}

/**
 * A correlation handle for a credential that is not derived from the credential's
 * plaintext at all.
 *
 * The first four bytes of the SHA-256 we already computed for the lookup. Enough to
 * follow one device through a log, and a preimage-resistant dead end for anyone
 * reading the log. Explicitly NOT a prefix of the token: "the first few characters"
 * is a real disclosure, and the contract says redaction is total — no token, in whole
 * OR IN PART, in logs, events, error messages or responses.
 */
export function tokenFingerprint(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * What may be said about an unexpected throw.
 *
 * Deliberately not `String(err)` and never the error object: a D1 failure can echo
 * the statement that failed. Every statement in this Worker is parameterised and the
 * credential lookup binds a DIGEST rather than the secret, so even a full statement
 * dump would expose only a hash — but "would only expose a hash" is not a reason to
 * emit one. The class name is enough to tell an operator what kind of failure it was;
 * the rest is in the D1 error the platform records on its own side.
 */
export function errorKind(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
