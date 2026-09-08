/**
 * The automatic-sync clock: when this device last tried, and when it may try again.
 *
 * Contract: `docs/sync.md`, "Three consents" — *"Coalesced, jittered backoff,
 * cancellable, bounded timeout."* Coalescing and backoff both need memory, and a
 * CLI trigger has none: `staple status` is a whole process, so the run it started
 * and the run the next command would start cannot see each other in memory. This
 * file is that memory.
 *
 * ## Why a file in the staple home, and not the workspace database
 *
 * Same reason the connection record is one, and it is the same mistake to make.
 * The workspace database synchronizes. A "last attempted at" row written there
 * would replicate, so one laptop's backoff would silently become the fleet's, and
 * a device that had never failed would refuse to sync because a different device
 * had. It is machine-local bookkeeping about a machine-local consent, and it
 * belongs beside the machine-local consent.
 *
 * ## Why not `sync_state.last_sync_at`, which already exists
 *
 * Because it only moves on SUCCESS. `recordSyncedAt` is called after a completed
 * sync, so a device pointed at a dead endpoint has a `last_sync_at` that never
 * advances — and a coalescer reading it would decide, correctly by its own logic
 * and catastrophically in effect, that it was always due. Every command on that
 * machine would attempt a doomed sync. The value a backoff needs is "when did we
 * last TRY", and nothing in the schema records it.
 *
 * It would also have needed a migration, and this lane may not take one.
 *
 * ## The filename does not end in `.json`, on purpose
 *
 * `listConnections()` reads every `*.json` in the cloud directory through
 * `readConnection`, which **throws** on a JSON object that is not a connection
 * record. A sibling named `<id>.autosync.json` would therefore make `staple
 * doctor` fail on any machine that had ever run an automatic sync. `.autosync`
 * it is.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../config/atomic.js";
import { credentialDir } from "./credential-store.js";

export interface AutoSyncState {
  /** ISO 8601, or null when this device has never attempted an automatic sync. */
  readonly lastAttemptAt: string | null;
  /** ISO 8601 of the last attempt that completed. Null until one does. */
  readonly lastOkAt: string | null;
  /** Reset to zero by any completed run. Drives the backoff exponent. */
  readonly consecutiveFailures: number;
  /**
   * ISO 8601 before which no trigger may run. Null when there is no backoff in
   * force. Stored as an instant rather than as a duration so that a process which
   * starts, refuses and exits leaves the same decision behind it for the next.
   */
  readonly nextEligibleAt: string | null;
  /**
   * The last outcome, for a human reading `STAPLE_AUTO_SYNC_DEBUG` output or a
   * future surface. Never a decision input — the three fields above are.
   */
  readonly lastOutcome: string | null;
}

export const EMPTY_AUTO_SYNC_STATE: AutoSyncState = {
  lastAttemptAt: null,
  lastOkAt: null,
  consecutiveFailures: 0,
  nextEligibleAt: null,
  lastOutcome: null,
};

export function autoSyncStatePath(home: string, repositoryId: string): string {
  return join(credentialDir(home), `${repositoryId}.autosync`);
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read the clock, or the empty clock.
 *
 * **Unreadable is empty here**, which is the opposite of what `readConnection`
 * does with a damaged file, and the difference is the point. A damaged consent
 * record must be refused, because guessing at it either invents a permission or
 * hides one. A damaged clock holds no permission at all: the worst consequence
 * of reading it as "we have never run" is one extra sync on a machine that had
 * already consented to syncing automatically.
 */
export function readAutoSyncState(home: string, repositoryId: string): AutoSyncState {
  const path = autoSyncStatePath(home, repositoryId);
  if (!existsSync(path)) return EMPTY_AUTO_SYNC_STATE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return EMPTY_AUTO_SYNC_STATE;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return EMPTY_AUTO_SYNC_STATE;
  }

  const record = parsed as Record<string, unknown>;
  const failures = record.consecutiveFailures;
  return {
    lastAttemptAt: isoOrNull(record.lastAttemptAt),
    lastOkAt: isoOrNull(record.lastOkAt),
    consecutiveFailures:
      typeof failures === "number" && Number.isInteger(failures) && failures >= 0 ? failures : 0,
    nextEligibleAt: isoOrNull(record.nextEligibleAt),
    lastOutcome: isoOrNull(record.lastOutcome),
  };
}

/**
 * `0600` in a `0700` directory, like everything else in this directory.
 *
 * It holds no secret, but it sits beside two files that do, and a `0644` sibling
 * is how a directory's mode quietly stops meaning anything. It also discloses
 * that this repository is connected and roughly how often this machine is used,
 * which is not nothing.
 */
export function writeAutoSyncState(
  home: string,
  repositoryId: string,
  state: AutoSyncState,
): string {
  const path = autoSyncStatePath(home, repositoryId);
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
  return path;
}

/**
 * Forget the clock. Called by `disconnect` and by tests.
 *
 * Idempotent, and safe to call on a machine that never had one.
 */
export function clearAutoSyncState(home: string, repositoryId: string): boolean {
  const path = autoSyncStatePath(home, repositoryId);
  const existed = existsSync(path);
  rmSync(path, { force: true });
  return existed;
}
