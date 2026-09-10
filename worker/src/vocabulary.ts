/**
 * Which vocabulary a repository holds, and the one refusal that follows from it (STA-290).
 *
 * A hub's log holds only the registry entities; a workspace's holds only the others.
 * `repos.vocabulary` (migration 0005) records which, and it is claimed by the first
 * write rather than by a separate step:
 *
 *   - `push.ts` claims it inside the batch that reserves the push's sequence numbers,
 *     and conditions every insert on the repository holding the batch's vocabulary
 *     afterwards. Two concurrent first pushes of different vocabularies therefore
 *     serialize inside D1 and exactly one of them writes anything.
 *   - `backups.ts` claims it when a restore BEGINS, before the undo is captured, so a
 *     push arriving while the restore stages cannot claim the repository out from under
 *     the entities being staged.
 *
 * No statement in this Worker ever changes a vocabulary that is already set. Every write
 * of the column is guarded by `vocabulary IS NULL OR vocabulary = <the same value>`.
 */

import { REGISTRY_ENTITIES } from "./envelope.js";
import { SyncError } from "./errors.js";

export type Vocabulary = "hub" | "workspace";

/** The vocabulary one entity belongs to. */
export function vocabularyOf(entity: string): Vocabulary {
  return REGISTRY_ENTITIES.has(entity) ? "hub" : "workspace";
}

/**
 * Read a stored value defensively. The column's CHECK admits only these two and NULL,
 * so anything else is a database edited by hand past its own constraint, and is treated
 * as unclaimed rather than trusted.
 */
export function storedVocabulary(value: unknown): Vocabulary | null {
  return value === "hub" || value === "workspace" ? value : null;
}

/**
 * The refusal, as `conflict`: 409, and not retryable anywhere.
 *
 * Not a new code. Every client already released maps a code it does not recognise to
 * `unavailable`, and `unavailable` is retryable, so a new code would turn a permanent
 * refusal into a retry loop on every installed client. `conflict` already means "well
 * formed, authorized, and at odds with what the repository holds", which is exactly
 * this. The two detail keys tell it apart from a lease race.
 *
 * The message never echoes the request. It says what the repository holds and what the
 * other vocabulary needs, which is the whole of what a human has to know to act.
 */
export function vocabularyRefusal(repository: Vocabulary, request: Vocabulary): SyncError {
  const message =
    repository === "workspace"
      ? "this repository holds workspace data; the hub registry needs its own repository."
      : "this repository holds a hub registry; workspace data needs its own repository.";
  return new SyncError("conflict", `${message} Nothing was written.`, {
    repositoryVocabulary: repository,
    requestVocabulary: request,
  });
}

/**
 * A backup holding BOTH vocabularies. Only a backup captured before migration 0005 can.
 * Refused whatever the repository holds, because restoring it would materialise both
 * into one epoch, which is the contamination this rule exists to prevent.
 */
export function mixedBackupRefusal(): SyncError {
  return new SyncError(
    "conflict",
    "this backup holds both hub registry and workspace entities, so restoring it would put " +
      "both into one repository. It was captured before this service kept the two apart. " +
      "Nothing was changed.",
    { requestVocabulary: "mixed" },
  );
}

/** The registry entity names as ONE bound parameter, for `IN (SELECT value FROM json_each(?))`. */
export function registryEntitiesJson(): string {
  return JSON.stringify([...REGISTRY_ENTITIES]);
}
