/**
 * The lease heartbeat: a bounded, observable renewal loop.
 *
 * Contract: `docs/sync.md` — *"Renewal is a bounded, observable heartbeat."*
 *
 * ## The one distinction this whole file is built around
 *
 * **The client's timer decides when to ask. The server decides whether the lease
 * still exists.** Those are different powers and this module holds exactly one
 * of them. It schedules — an interval, a beat count, a wall budget, a
 * cancellation signal, all of them the client's own business — and it draws no
 * conclusion whatsoever from `serverExpiresAt`. A loop that checked the stored
 * expiry before beating would stop renewing a live lease on a machine whose
 * clock was fast, and would keep renewing on one whose clock was slow, and in
 * both cases would be substituting its own judgement for the only judgement that
 * counts.
 *
 * ## Bounded on two axes, and bounded by default
 *
 * A beat count and a wall budget, both with defaults, so a caller that names
 * neither still gets a loop that ends. An unbounded heartbeat is a background
 * process, and *"there is still no sweeper and no automatic takeover"* is a
 * promise about background processes as much as about takeovers.
 *
 * ## Why `offline` does not stop it, and `conflict` does
 *
 * A `conflict` is the server stating that this device does not hold the lease —
 * it expired, or was taken over, or the token was superseded. That is a fact,
 * it will not change by asking again, and the loop stops and forgets the mirror
 * row. An `offline` is this device failing to reach the server. It says nothing
 * about who holds the lease; the lease may be perfectly healthy and the wifi may
 * not be. So the beat is recorded as `offline`, the mirror row survives, and the
 * loop keeps its schedule until its bounds run out.
 */
import type { DatabaseSync } from "node:sqlite";
import { cloudCodeOf } from "./client.js";
import { renewLease, type LeaseOptions } from "./lease.js";
import { readLocalLease } from "./lease-store.js";

/** What one beat did. Every one of these is reported, in order. */
export interface HeartbeatBeat {
  /** 1-based. The number a human counts with. */
  readonly n: number;
  readonly outcome: "renewed" | "refused" | "offline";
  /** The expiry the SERVER stated on this beat. Null when it did not answer. */
  readonly serverExpiresAt: string | null;
  readonly fencingToken: number | null;
  /** The service's own sentence, on anything but a clean renewal. */
  readonly message: string | null;
}

export interface HeartbeatReport {
  readonly entityId: string;
  readonly beats: readonly HeartbeatBeat[];
  readonly stopped: "beats" | "budget" | "cancelled" | "refused";
  /**
   * Whether this device still holds the lease, as far as the server has said.
   * False only after an explicit refusal — never inferred from a timestamp.
   */
  readonly holds: boolean;
}

export interface HeartbeatOptions extends LeaseOptions {
  /** How long to wait between beats. Should be well under the granted TTL. */
  readonly everyMs: number;
  readonly maxBeats?: number;
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
  readonly onBeat?: (beat: HeartbeatBeat) => void;
  /** Injected in tests. Real callers take the default. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected in tests. Used ONLY to spend the budget — never to judge a lease. */
  readonly now?: () => number;
}

/**
 * The defaults. Two hours of beats at the shortest sensible interval, or an hour
 * of wall time, whichever runs out first.
 *
 * They are not tuning knobs so much as a statement that the loop terminates. A
 * session that needs longer runs the command again, which is a decision somebody
 * made rather than a process nobody remembers starting.
 */
const DEFAULT_MAX_BEATS = 240;
const DEFAULT_BUDGET_MS = 3_600_000;

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function runHeartbeat(
  db: DatabaseSync,
  repositoryId: string,
  entityId: string,
  options: HeartbeatOptions,
): Promise<HeartbeatReport> {
  const maxBeats = Math.max(1, options.maxBeats ?? DEFAULT_MAX_BEATS);
  const budgetMs = Math.max(0, options.budgetMs ?? DEFAULT_BUDGET_MS);
  const sleep = options.sleep ?? sleepDefault;
  const now = options.now ?? Date.now;
  const startedAt = now();
  /**
   * Read through a call rather than inline, so the second check in the loop is
   * not narrowed away by the first. `aborted` genuinely changes underneath us —
   * that is the entire point of a signal — and control-flow analysis has no way
   * to know that.
   */
  const aborted = (): boolean => options.signal?.aborted ?? false;

  const beats: HeartbeatBeat[] = [];
  let stopped: HeartbeatReport["stopped"] = "beats";
  let holds = true;

  for (let n = 1; n <= maxBeats; n += 1) {
    if (aborted()) {
      stopped = "cancelled";
      break;
    }

    let beat: HeartbeatBeat;
    try {
      const outcome = await renewLease(db, repositoryId, entityId, options);
      beat = {
        n,
        outcome: "renewed",
        serverExpiresAt: outcome.lease.serverExpiresAt,
        fencingToken: outcome.lease.fencingToken,
        message: null,
      };
    } catch (error) {
      const code = cloudCodeOf(error);
      const message = error instanceof Error ? error.message : String(error);
      /**
       * Anything that is not a plain transport failure is treated as a refusal.
       * `conflict` is the ordinary one; `revoked`, `forbidden` and `auth` mean
       * this device cannot renew anything ever again until somebody re-connects
       * it, and beating on is noise rather than resilience.
       */
      const transient = code === "offline" || code === "unavailable" || code === "rate_limited";
      beat = {
        n,
        outcome: transient ? "offline" : "refused",
        serverExpiresAt: null,
        fencingToken: null,
        message,
      };
      if (!transient) {
        beats.push(beat);
        options.onBeat?.(beat);
        // `renewLease` has already forgotten the mirror row on a `conflict`.
        // The loop's job here is only to stop asking.
        holds = false;
        stopped = "refused";
        break;
      }
    }

    beats.push(beat);
    options.onBeat?.(beat);

    if (n === maxBeats) {
      stopped = "beats";
      break;
    }

    await sleep(options.everyMs);

    if (aborted()) {
      stopped = "cancelled";
      break;
    }
    if (now() - startedAt >= budgetMs) {
      stopped = "budget";
      break;
    }
  }

  return {
    entityId,
    beats,
    stopped,
    // A belt-and-braces read of the mirror: `holds` must never be true for a
    // lease this device has already been told it does not have.
    holds: holds && readLocalLease(db, entityId) !== null,
  };
}
