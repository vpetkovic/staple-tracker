/**
 * The second consent, and the gate that spends it.
 *
 * Contract: `docs/sync.md`, "Three consents" — *"**A successful connection leaves
 * sync manual.** Manual is the default and stays the default … Automatic mode is
 * a second, separately named decision, and turning it off does not disconnect."*
 * And: *"After automatic — bounded triggers only: startup, post-write,
 * long-running session, pre-checkout. Coalesced, jittered backoff, cancellable,
 * bounded timeout."*
 *
 * ## This module cannot reach the network, and that is structural
 *
 * Its static import graph contains neither `client.ts` nor `sync.ts`. Not by
 * accident and not by anybody remembering: `test/cloud-auto-sync.test.ts` walks
 * the transitive `from "…"` graph out of this file and asserts the transport
 * modules are unreachable from it.
 *
 * That is the same guarantee `preview.ts` has, and it is here for a stronger
 * reason. This is the ONE function every surface calls on its everyday path —
 * after every `staple ls`, on every UI poll tick, after every MCP write. If
 * deciding "may I sync?" could reach the network, then the invariant would
 * depend on the answer rather than the answer depending on the invariant. Making
 * the decision provably local means the disconnected and manual paths are silent
 * because there is nothing in scope that could speak, which is a different and
 * much better claim than "we checked and it does not".
 *
 * `sync.ts` is reached only by `auto-sync.ts`, through `await import()`, and only
 * after {@link autoSyncGate} has already returned `allowed`. On a manual-mode
 * command the transport module is therefore never even evaluated.
 *
 * ## Why the gate order is the cheapest thing first
 *
 * A fresh install pays one `existsSync`. An unconnected-but-used machine pays one
 * `existsSync`. A connected machine in manual mode pays one small file read. The
 * order is load-bearing: this runs on every command, so a gate that opened the
 * workspace database to find out whether it was allowed to run would have made
 * automatic sync's cost universal — paid by the two states that never sync.
 */
import { existsSync } from "node:fs";
import { readConnection } from "./connection.js";
import { credentialDir } from "./credential-store.js";
import {
  autoSyncStatePath,
  readAutoSyncState,
  type AutoSyncState,
} from "./auto-state.js";

/**
 * The four trigger points `docs/sync.md` names, minus one.
 *
 * `pre-checkout` is **deliberately absent from this union**, and its absence is
 * the decision rather than an omission to be filled in later.
 *
 * The leases lane made global exclusivity a separately named `cloud lease` verb
 * precisely so that no part of `staple checkout` depends on a service being
 * reachable, and wrote that a flag on `checkout` *"would satisfy the letter of
 * the invariant and break its spirit."* A pre-checkout sync is that flag with a
 * better name. Gating it behind this consent would make it silent when automatic
 * mode is off — that part is easy and is exactly what {@link autoSyncGate} does
 * for every other trigger — but it would not fix the real problem, which is what
 * the feature would *mean*. A pull immediately before a local claim produces a
 * snapshot that is already stale by the time the claim is written, and it would
 * read to a human as "checkout is coordinated now" when the only thing that
 * coordinates a checkout across devices is a lease.
 *
 * `checkout` is a mutation, so it fires `post-write` instead: this device's claim
 * is pushed promptly, which is the half of the value that is true, and it is paid
 * for after the claim rather than in front of it. A defining enum member that
 * nothing fires would be worse than this comment.
 */
export type AutoSyncTrigger = "startup" | "post-write" | "session";

/**
 * Why a request did not become a sync. Every one of these is a normal outcome,
 * not an error — which is why they are a reason string and not a thrown error.
 */
export type AutoSyncSkip =
  /** No `cloud` directory in the staple home: nothing has ever been connected here. */
  | "no-connections"
  /** This workspace has no `repository.json`, so it has no sync identity. */
  | "no-identity"
  /** Connected on some machine, but not this one. */
  | "disconnected"
  /** Connected here, and automatic sync was never consented to. The default. */
  | "manual"
  /** A run for this trigger happened recently enough that another would be noise. */
  | "too-soon"
  /** The endpoint has been failing; the jittered backoff window has not elapsed. */
  | "backoff"
  /** A run was already in flight; this request joined it rather than starting a second. */
  | "coalesced"
  /** The scheduler was stopped — a surface shutting down, or an explicit cancel. */
  | "cancelled";

export interface AutoSyncBound {
  /**
   * Wall clock for the whole run, across the handshake, the push and every pull
   * page. *"A tracker command never blocks indefinitely on Cloudflare"* is a
   * bound on the command, so the bound has to be on the run rather than on each
   * request inside it.
   */
  readonly budgetMs: number;
  /**
   * How long after a run of this trigger another one is pointless. The floor for
   * coalescing across processes, which is the only kind a CLI has: two `staple
   * status` calls in one shell loop are two processes, and an in-memory
   * coalescer cannot see the first from the second.
   */
  readonly minIntervalMs: number;
}

/**
 * The bounds, per trigger. Deliberately a table rather than one number, because
 * the three triggers are answering different questions.
 *
 * `startup` is the tightest: somebody is waiting at a prompt for output that has
 * already been produced, so the cost of the trigger is pure added latency. Its
 * minute-long floor means a shell loop of reads syncs once, not once per read.
 *
 * `post-write` gets a slightly longer budget and a much shorter floor. There is
 * new local work that other devices cannot see, so the value of going now is
 * high, and a five-second floor still collapses a scripted burst of twenty
 * `staple comment` calls into one or two runs.
 *
 * `session` is the loose one, because nobody is waiting: a long-running UI or MCP
 * server ticks on an interval, and a ten-second budget is what lets a run that
 * needs a bootstrap page or two actually finish.
 */
export const AUTO_SYNC_BOUNDS: Record<AutoSyncTrigger, AutoSyncBound> = {
  startup: { budgetMs: 2_000, minIntervalMs: 60_000 },
  "post-write": { budgetMs: 3_000, minIntervalMs: 5_000 },
  session: { budgetMs: 10_000, minIntervalMs: 30_000 },
};

/** How often a long-running surface fires its `session` trigger. Five minutes. */
export const AUTO_SYNC_SESSION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The backoff schedule, applied on top of whichever trigger asked.
 *
 * Jittered, and the jitter is not decoration. Several devices pointed at one
 * repository fail together — the service is down, or the account is over its
 * limit — and an unjittered schedule reconverges all of them onto the same
 * instants, so the endpoint's first minute back is the worst-loaded one it will
 * see. The multiplier is uniform over [0.5, 1.5), which is enough spread to
 * break a fleet apart without making the shortest wait uselessly short.
 */
export const AUTO_SYNC_BACKOFF_BASE_MS = 5_000;
export const AUTO_SYNC_BACKOFF_CAP_MS = 5 * 60 * 1000;

export function autoSyncBackoffMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  if (consecutiveFailures <= 0) return 0;
  // `2 ** 20` overflows nothing but is pointless past the cap; clamp the exponent
  // so a device that has been failing for a week does not compute Infinity.
  const exponent = Math.min(consecutiveFailures - 1, 16);
  const flat = Math.min(AUTO_SYNC_BACKOFF_CAP_MS, AUTO_SYNC_BACKOFF_BASE_MS * 2 ** exponent);
  return Math.round(flat * (0.5 + random()));
}

export interface AutoSyncPermit {
  readonly allowed: true;
  readonly trigger: AutoSyncTrigger;
  readonly bound: AutoSyncBound;
  readonly repositoryId: string;
  /** The origin this run may talk to, and the only one. Carried so a caller can report it. */
  readonly endpoint: string;
  readonly state: AutoSyncState;
}

export interface AutoSyncRefusal {
  readonly allowed: false;
  readonly reason: AutoSyncSkip;
}

export type AutoSyncDecision = AutoSyncPermit | AutoSyncRefusal;

export interface AutoSyncGateInput {
  readonly home: string;
  /** Null when the workspace has no `repository.json` — refused as `no-identity`. */
  readonly repositoryId: string | null;
  readonly trigger: AutoSyncTrigger;
  /** Injected in tests. */
  readonly now?: number;
}

/**
 * May this process synchronize on its own, right now?
 *
 * Reads at most three local files and makes no request, ever. Returns a decision
 * rather than throwing, because "no" is the answer on the overwhelming majority
 * of calls — every command on every machine that has not opted in — and an
 * exception is the wrong shape for the normal case.
 *
 * A damaged connection record is the one thing that throws, and it throws from
 * `readConnection`, which is deliberate: *"A parse failure that fell back to 'not
 * connected' would tell a human they had never connected."* This function does
 * not soften that. It does soften a damaged *state* file, because that one holds
 * nothing but timing and the safe reading of an unreadable clock is "we have
 * never run", which costs at most one extra sync.
 */
export function autoSyncGate(input: AutoSyncGateInput): AutoSyncDecision {
  const now = input.now ?? Date.now();

  /**
   * One `existsSync`, and it is the whole cost on a machine that has never
   * connected anything. This is the fresh-install case the epic's first
   * invariant is about, and it is answered before a repository id is even
   * looked at.
   */
  if (!existsSync(credentialDir(input.home))) return { allowed: false, reason: "no-connections" };

  if (input.repositoryId === null) return { allowed: false, reason: "no-identity" };

  const connection = readConnection(input.home, input.repositoryId);
  if (!connection) return { allowed: false, reason: "disconnected" };

  /**
   * THE SECOND CONSENT, and the only line in this file that matters more than
   * the comments around it.
   *
   * `connection.auto` is `true` only after `staple cloud auto on` or a UI
   * confirmation wrote it. `readConnection` already refuses to read anything but
   * a literal `true` as consent — *"a consent flag whose value cannot be read is
   * not consent"* — so a truncated or hand-edited record lands here as manual.
   *
   * Connecting cannot produce `true`: `performConnect` writes `auto: false`, and
   * `setConsent` is the only other writer of the field. That is what makes
   * "storing a credential is not consent to use it" a property of the code rather
   * than a promise in a document.
   */
  if (connection.auto !== true) return { allowed: false, reason: "manual" };

  const state = readAutoSyncState(input.home, input.repositoryId);
  const bound = AUTO_SYNC_BOUNDS[input.trigger];

  /**
   * Backoff first, floor second. The order matters when both would refuse: a
   * device whose endpoint is down should be told it is in backoff, not that it
   * synced too recently, because those two facts lead a human to different
   * places.
   */
  if (state.nextEligibleAt !== null && Date.parse(state.nextEligibleAt) > now) {
    return { allowed: false, reason: "backoff" };
  }

  const lastAttemptMs = state.lastAttemptAt === null ? null : Date.parse(state.lastAttemptAt);
  if (lastAttemptMs !== null && Number.isFinite(lastAttemptMs)) {
    /**
     * A clock that jumped backwards — a suspended laptop, an NTP correction —
     * would otherwise pin the floor shut for as long as the skew lasted. A future
     * `lastAttemptAt` is treated as "just now", which costs one skipped run at
     * most, rather than as a permanent refusal.
     */
    const elapsed = now - lastAttemptMs;
    if (elapsed >= 0 && elapsed < bound.minIntervalMs) {
      return { allowed: false, reason: "too-soon" };
    }
  }

  return {
    allowed: true,
    trigger: input.trigger,
    bound,
    repositoryId: input.repositoryId,
    endpoint: connection.endpoint,
    state,
  };
}

/**
 * Is automatic sync consented to for this repository on this machine?
 *
 * The gate without the clock, for a caller that wants to render the mode rather
 * than decide whether to run — `cloud status` already has `auto` on its report,
 * so this exists for the narrower question a trigger registration asks: "is there
 * any point wiring me up at all?"
 */
export function autoSyncConsented(home: string, repositoryId: string | null): boolean {
  if (repositoryId === null) return false;
  if (!existsSync(credentialDir(home))) return false;
  const connection = readConnection(home, repositoryId);
  return connection !== null && connection.auto === true;
}

export { autoSyncStatePath };
