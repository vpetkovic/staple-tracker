/**
 * ONE committed artifact pinning the repository-vocabulary refusal, read by BOTH suites.
 *
 * `worker/test/vocabulary.test.ts` asserts the real Worker answers exactly these bodies;
 * `test/cloud-repository-vocabulary.test.ts` asserts `test/fixtures/fake-sync-server.ts`
 * answers exactly the same ones. Two independent sets of literals would each agree with
 * their own author and with nothing else, which is the failure `registry-fixture.ts`
 * records this epic making four times. Change the Worker's wording, status, code or
 * detail and the Worker suite fails here; change the fake's and the root suite does.
 *
 * NO IMPORTS, for the same reason as `registry-fixture.ts`: it is the one kind of file
 * both tsconfigs can compile.
 *
 * ## Why `conflict`, and not a new code
 *
 * Every client already released maps a code it does not know to `unavailable`
 * (`src/core/cloud/client.ts`, `request`), and `unavailable` is RETRYABLE. A new code
 * would therefore turn a permanent refusal into a retry loop on every installed client,
 * which is the opposite of what a refusal is for. `conflict` is 409, non-retryable
 * everywhere, and means what this is: the request is well-formed and authorized, and it
 * conflicts with what the repository already holds. The two detail keys are what tell
 * this conflict apart from a lease race.
 */

export const VOCABULARY_REFUSALS = {
  /** Registry operations (`registration`, `crossLink`) offered to a workspace repository. */
  hubIntoWorkspace: {
    status: 409,
    body: {
      code: "conflict",
      message:
        "this repository holds workspace data; the hub registry needs its own repository. " +
        "Nothing was written.",
      retryable: false,
      repositoryVocabulary: "workspace",
      requestVocabulary: "hub",
    },
  },
  /** Workspace operations offered to a hub repository. */
  workspaceIntoHub: {
    status: 409,
    body: {
      code: "conflict",
      message:
        "this repository holds a hub registry; workspace data needs its own repository. " +
        "Nothing was written.",
      retryable: false,
      repositoryVocabulary: "hub",
      requestVocabulary: "workspace",
    },
  },
  /**
   * A restore of a backup that holds BOTH vocabularies. Only a backup captured before
   * migration 0005 can: after it, no route can put the two into one log. No
   * `repositoryVocabulary`, because the refusal does not depend on it — a mixed backup
   * is refused whatever the repository holds.
   */
  mixedBackup: {
    status: 409,
    body: {
      code: "conflict",
      message:
        "this backup holds both hub registry and workspace entities, so restoring it would " +
        "put both into one repository. It was captured before this service kept the two " +
        "apart. Nothing was changed.",
      retryable: false,
      requestVocabulary: "mixed",
    },
  },
} as const;
