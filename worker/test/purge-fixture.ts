/**
 * ONE committed artifact pinning the purge confirmation, read by BOTH suites (STA-256).
 *
 * `worker/test/backups.test.ts` asserts the real Worker answers exactly these bodies;
 * `test/cloud-purge-confirmation.test.ts` asserts `test/fixtures/fake-sync-server.ts`
 * answers exactly the same ones, and that the client maps them. Two sets of literals
 * would each agree with their own author and nothing else — the failure
 * `registry-fixture.ts` records this epic making four times.
 *
 * NO IMPORTS, for the same reason as `registry-fixture.ts`: it is the one kind of file
 * both tsconfigs can compile.
 *
 * ## The wire shape: `{ "confirm": "<repositoryId>" }` as the DELETE's JSON body
 *
 * A body rather than a header, for three reasons, all of them about what already exists:
 *
 *   - restore takes its typed confirmation as `confirm` in a JSON body, so both
 *     destructive routes spell the confirmation the same way;
 *   - the client transport already sends a JSON body on a DELETE, with its
 *     `Content-Length`, for lease release, and the Worker already reads one there. A
 *     header would have needed a per-call header option on the transport that nothing
 *     else uses;
 *   - the Worker bounds the body from `Content-Length` before it parses it, with the
 *     same cap a push gets.
 *
 * ## Why `validation`, and not a new code
 *
 * Every client already released maps a code it does not know to `unavailable`, and
 * `unavailable` is RETRYABLE, so a new code would turn this refusal into a retry loop on
 * every installed build. `validation` is 400 and non-retryable everywhere, and it is what
 * restore already answers a missing or wrong `confirm` with. The `confirmation` detail
 * key tells the two purge refusals apart from every other `validation`.
 *
 * ## `missing` is what every client released before STA-256 gets
 *
 * Those builds send the purge with no body at all. They print the service's message
 * verbatim (`error(validation): …`), so the message has to tell that person what to do,
 * and it does: update staple. It never echoes the value sent.
 */

export const PURGE_REFUSALS = {
  /** No body, an empty body, or a body without `confirm`. */
  missing: {
    status: 400,
    body: {
      code: "validation",
      message:
        "purge refused: the request carried no typed confirmation, and this service requires " +
        "the repository id in `confirm`. Nothing was deleted. Update staple, then run " +
        "`staple cloud purge --confirm <repositoryId>` again.",
      retryable: false,
      confirmation: "missing",
    },
  },
  /**
   * A body that is not JSON at all. The ordinary body rule (`worker/src/http.ts`,
   * `readJson`), pinned here because the purge route is where the fake has to mirror it.
   */
  malformed: {
    status: 400,
    body: { code: "validation", message: "request body is not valid JSON", retryable: false },
  },
  /** JSON, but an array or a string or a number rather than an object. Same rule. */
  notAnObject: {
    status: 400,
    body: { code: "validation", message: "request body must be a JSON object", retryable: false },
  },
  /** `confirm` is present and is not the repository id the credential belongs to. */
  mismatch: {
    status: 400,
    body: {
      code: "validation",
      message:
        "purge refused: `confirm` does not match this repository's id. Nothing was deleted.",
      retryable: false,
      confirmation: "mismatch",
    },
  },
} as const;
