/**
 * Distinct exit codes so CI can branch on the failure class without parsing stderr.
 *
 * ONE table for every command. `main()` in `cli.ts` sets the exit code for a synchronous
 * failure and `settle()` in `commands/cloud.ts` for an asynchronous one; they used to hold
 * a table each, and the async copy was "the subset an async command can reach" — which
 * stopped being true the moment the sync codes became real codes (STA-251).
 *
 * Typed over every `StapleErrorCode`, so a code added to the union without a number here
 * fails typecheck rather than exiting 1 as though it were a crash.
 */
import type { StapleErrorCode } from "../core/types.js";

export const EXIT_CODES: Readonly<Record<StapleErrorCode | "timeout", number>> = {
  validation: 2,
  not_found: 3,
  conflict: 4,
  duplicate: 5,
  cycle: 6,
  revision_conflict: 7,
  // `wait` only: a budget outcome, not a store error, so it is not a StapleError code.
  timeout: 8,
  /**
   * Refused by a review gate (STA-143). Its own number so CI and shell loops can
   * branch on "a human has to act" without parsing stderr — the one failure
   * class where retrying, picking another task, or waiting longer are all
   * equally useless.
   */
  gated: 9,
  /**
   * Refused by the pickup plan (STA-168, `queue.policy = strict`). Its own
   * number for the same reason `gated` has one: this is a THIRD instruction, not
   * a shade of conflict. Retrying is useless, picking any other task is useless,
   * and the one useful move — take the identifier in `detail.expected` — is
   * something a shell loop can only act on if it can tell this case apart
   * without parsing stderr.
   */
  out_of_order: 10,
  /**
   * The cloud sync taxonomy (STA-251), in `docs/sync.md`'s table order. `validation`,
   * `not_found` and `conflict` are shared with the store and keep 2, 3 and 4.
   *
   * Each has its own number because each asks for a different remedy: `auth` and
   * `revoked` need a re-connect, `forbidden` a different secret or the missing consent,
   * `protocol_unsupported` and `schema_ahead` an upgrade. The three RETRYABLE codes are
   * adjacent, 19–21. Test for exactly those (`case $? in 19|20|21)`), never `-ge 19`:
   * the installed launcher exits 70 with no runtime and a signal gives 128+n, and a
   * retry loop must not spin on either.
   */
  auth: 11,
  forbidden: 12,
  revoked: 13,
  epoch_changed: 14,
  cursor_invalid: 15,
  payload_too_large: 16,
  schema_ahead: 17,
  protocol_unsupported: 18,
  rate_limited: 19,
  unavailable: 20,
  offline: 21,
};

/** The exit code for an envelope's code. 1 is an error nothing classified. */
export function exitCodeFor(code: string): number {
  return (EXIT_CODES as Record<string, number>)[code] ?? 1;
}
