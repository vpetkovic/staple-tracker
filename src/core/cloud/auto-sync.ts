/**
 * The scheduler: one bounded, coalesced, cancellable automatic sync at a time.
 *
 * Contract: `docs/sync.md`, "Three consents" — *"After automatic — bounded
 * triggers only: startup, post-write, long-running session … Coalesced, jittered
 * backoff, cancellable, bounded timeout. **A tracker command never blocks
 * indefinitely on Cloudflare**; sync failure degrades to manual and reports, it
 * does not hang `staple checkout`."*
 *
 * ## `sync.ts` is loaded late, and that is the point
 *
 * The only reference to it in this file is a `await import("./sync.js")` that
 * runs AFTER {@link autoSyncGate} has returned `allowed`. On a disconnected or
 * manual-mode machine the transport module is never evaluated — no
 * `client.ts`, no `fetch` captured, no endpoint parsed. The everyday path is
 * silent because nothing that could speak was ever loaded, rather than because
 * everything that could speak declined to.
 *
 * The type-only `import type` above is erased by the compiler and creates no
 * such edge; `test/cloud-auto-sync.test.ts` asserts both halves of that.
 *
 * ## How the bound is enforced, and what it really bounds
 *
 * One `AbortController` per run, fired by a timer at the budget. It reaches the
 * transport through `fetchImpl` — the injection point `client.ts` already
 * documents — so `client.ts` is not modified and the abort composes with the
 * per-request `AbortSignal.timeout` it already sets, via `AbortSignal.any`.
 *
 * There is deliberately **no `Promise.race` against a deadline**. Racing would
 * return control at the budget while leaving `syncRepository` running detached,
 * still holding the database handle and still applying pages after its caller had
 * given up — and in a CLI the process stays alive for that continuation anyway,
 * so the race would buy nothing and cost a writer nobody is watching. Aborting
 * the transport instead means every request after the deadline rejects
 * immediately, so the run unwinds within one local step. The honest statement of
 * the bound is therefore: *no request is issued after the budget, and the run
 * ends within one local apply of it.*
 *
 * ## It never throws and never prints
 *
 * Never throws, because every caller is a surface that was doing something else:
 * a rejected background promise would become an `UnhandledPromiseRejection` and
 * take down an MCP server that was working perfectly.
 *
 * Never prints, because `staple ls --json` pipes its stdout into a parser. A
 * background sync that wrote one line of progress there would corrupt output that
 * has nothing to do with it. `STAPLE_AUTO_SYNC_DEBUG=1` sends one line per run to
 * stderr, which is the only channel a `--json` consumer is not reading.
 */
import type { DatabaseSync } from "node:sqlite";
import type { SyncOptions, SyncReport } from "./sync.js";
import {
  AUTO_SYNC_MAX_RETRY_AFTER_MS,
  autoSyncBackoffMs,
  autoSyncGate,
  type AutoSyncSkip,
  type AutoSyncTrigger,
} from "./auto.js";
import { readAutoSyncState, writeAutoSyncState, type AutoSyncState } from "./auto-state.js";

export type AutoSyncOutcome =
  | { readonly status: "skipped"; readonly reason: AutoSyncSkip }
  | { readonly status: "synced"; readonly report: SyncReport; readonly ms: number }
  /** The budget elapsed. No request was issued after it; local work is untouched. */
  | { readonly status: "timeout"; readonly ms: number }
  /** `stop()` fired, or the surface shut down mid-run. */
  | { readonly status: "cancelled"; readonly ms: number }
  | {
      readonly status: "failed";
      /** The cloud error code when there was one — `offline`, `unavailable`, … */
      readonly code: string | null;
      readonly message: string;
      readonly ms: number;
    };

/** What a run needs: an open handle and the repository it belongs to. */
export interface AutoSyncTarget {
  readonly db: DatabaseSync;
  readonly repositoryId: string;
}

export interface AutoSyncSchedulerOptions {
  readonly home: string;
  readonly now?: () => number;
  readonly random?: () => number;
  /**
   * Replaces the dynamic `import("./sync.js")` in tests.
   *
   * A seam rather than a mock of `fetch`, because what these tests are about is
   * the SCHEDULER — coalescing, bounds, backoff, cancellation — and driving that
   * through a real sync would mean standing up a service to test a timer. The
   * network-silence suite tests the other half against a real transport spy.
   */
  readonly syncImpl?: (
    db: DatabaseSync,
    repositoryId: string,
    options: SyncOptions,
  ) => Promise<SyncReport>;
  /** The base fetch the guard wraps. Defaults to the global one. */
  readonly fetchImpl?: typeof fetch;
  readonly debug?: (line: string) => void;
}

function debugSink(explicit?: (line: string) => void): ((line: string) => void) | null {
  if (explicit) return explicit;
  if (process.env.STAPLE_AUTO_SYNC_DEBUG !== "1") return null;
  return (line) => process.stderr.write(`staple auto-sync: ${line}\n`);
}

function codeOf(error: unknown): string | null {
  const detail = (error as { detail?: Record<string, unknown> } | null)?.detail;
  const code = detail?.cloudCode;
  return typeof code === "string" ? code : null;
}

/**
 * A `rate_limited` refusal's `Retry-After`, in milliseconds, or 0.
 *
 * Read here from the error's detail rather than imported from `sync.ts`, which this
 * module must not load until a run is allowed (see the module comment). Delta-seconds
 * or an HTTP date, as the header allows.
 */
function retryAfterFrom(error: unknown, now: number): number {
  if (codeOf(error) !== "rate_limited") return 0;
  const raw = (error as { detail?: Record<string, unknown> } | null)?.detail?.retryAfter;
  if (typeof raw !== "string" && typeof raw !== "number") return 0;
  const text = String(raw).trim();
  const asked = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  // Bounded, and never NaN or Infinity (`AUTO_SYNC_MAX_RETRY_AFTER_MS`).
  return Number.isNaN(asked) ? 0 : Math.min(Math.max(0, asked), AUTO_SYNC_MAX_RETRY_AFTER_MS);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One scheduler per surface. The CLI builds one and drops it; a UI or MCP server
 * keeps one for its lifetime and calls `stop()` when it closes.
 */
export class AutoSyncScheduler {
  private inflight: Promise<AutoSyncOutcome> | null = null;
  private controller: AbortController | null = null;
  /**
   * At most ONE follow-up, no matter how many requests arrive during a run.
   *
   * This is the coalescing rule, and the bound is what makes it coalescing rather
   * than queueing: twenty MCP writes during one four-second sync must produce one
   * more sync, not twenty. The trigger recorded with it is the highest-value one
   * seen — a `post-write` that arrived during a `startup` run should not be
   * downgraded to another `startup`, because it is the one that has new local
   * work behind it.
   */
  private queued: AutoSyncTrigger | null = null;
  private stopped = false;

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly debug: ((line: string) => void) | null;

  constructor(private readonly options: AutoSyncSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.debug = debugSink(options.debug);
  }

  /**
   * Ask for a sync. Resolves to what happened; never rejects.
   *
   * A request that arrives while a run is in flight JOINS it and resolves with
   * that run's outcome, and separately arms one follow-up. Joining rather than
   * refusing matters for a caller that awaits: an MCP tool that wanted its write
   * pushed gets a truthful answer about the run that will carry it.
   */
  request(target: AutoSyncTarget, trigger: AutoSyncTrigger): Promise<AutoSyncOutcome> {
    if (this.stopped) return Promise.resolve({ status: "skipped", reason: "cancelled" });

    if (this.inflight) {
      this.queued = rank(trigger) > rank(this.queued) ? trigger : this.queued;
      return this.inflight;
    }

    const run = this.run(target, trigger).finally(() => {
      this.inflight = null;
      this.controller = null;
      const next = this.queued;
      this.queued = null;
      /**
       * The follow-up is fired and NOT awaited by the original caller, and it goes
       * through `request` again — so it meets the gate, the floor and the backoff
       * exactly as a fresh trigger would. A follow-up that bypassed them would be
       * the one path in this file that could run unbounded.
       */
      if (next && !this.stopped) void this.request(target, next);
    });
    this.inflight = run;
    return run;
  }

  /**
   * Stop. Aborts the in-flight run's transport and refuses everything after.
   *
   * *"Disabling automatic mode stops background requests"* has two halves. This is
   * the immediate half, for a surface that is closing or for a consent that was
   * just revoked in-process. The durable half is the gate: the next process reads
   * `auto: false` and never gets here.
   */
  stop(): void {
    this.stopped = true;
    this.queued = null;
    this.controller?.abort(new Error("automatic sync was cancelled"));
  }

  /** For a surface that turned automatic mode back on without restarting. */
  resume(): void {
    this.stopped = false;
  }

  /** True while a run is in flight. For tests and for a status line; never a decision input. */
  get busy(): boolean {
    return this.inflight !== null;
  }

  private async run(target: AutoSyncTarget, trigger: AutoSyncTrigger): Promise<AutoSyncOutcome> {
    const home = this.options.home;
    const startedAt = this.now();

    const decision = autoSyncGate({
      home,
      repositoryId: target.repositoryId,
      trigger,
      now: startedAt,
    });
    if (!decision.allowed) {
      this.debug?.(`${trigger} skipped (${decision.reason})`);
      return { status: "skipped", reason: decision.reason };
    }

    /**
     * The attempt is recorded BEFORE it is made.
     *
     * A run that crashed the process — an out-of-memory, a `SIGKILL`, a bug in a
     * module this one does not own — would otherwise leave the clock exactly where
     * it was, and the next command would attempt the same thing again. That is a
     * hot loop whose only symptom is a machine that is always slightly busy.
     * Writing first costs one skipped sync in the rare case the process dies
     * mid-run, and it makes crash-looping impossible.
     */
    this.persist(target.repositoryId, {
      ...decision.state,
      lastAttemptAt: new Date(startedAt).toISOString(),
    });

    const controller = new AbortController();
    this.controller = controller;
    /**
     * A distinct object, so the catch below can tell "the budget elapsed" from
     * "somebody closed the window" by identity rather than by re-reading
     * `this.stopped` — which would have raced with a `stop()` that arrived while
     * the run was already unwinding from its deadline.
     */
    const budgetElapsed = new Error("automatic sync budget elapsed");
    const deadline = setTimeout(() => controller.abort(budgetElapsed), decision.bound.budgetMs);
    // A background timer must never be the reason a CLI process stays alive.
    deadline.unref?.();

    try {
      /**
       * Here, and not one line earlier. Every `return` above this point happened
       * without `sync.ts` — and therefore without `client.ts` — being evaluated.
       */
      const sync = this.options.syncImpl ?? (await import("./sync.js")).syncRepository;

      const report = await sync(target.db, target.repositoryId, {
        home,
        /**
         * One attempt per run. `sync.ts` retries `rate_limited`, `unavailable` and
         * `offline` with a fixed `200 * 2**n` schedule, which is right for a human
         * who typed `staple cloud sync` and is watching. For a background trigger
         * it is the wrong shape twice over: it is unjittered, so a fleet
         * reconverges on the endpoint's first second back; and it burns the run's
         * budget on a link that is already known to be down. The retry for a
         * trigger is the NEXT trigger, after this file's jittered, persisted
         * backoff window.
         */
        attempts: 1,
        /**
         * And no waiting inside the run on a `Retry-After`: the run has a budget, and a
         * service asking for a minute is answered by scheduling the next run no sooner
         * than that — see the backoff below.
         */
        rateLimitWaitMs: 0,
        timeoutMs: decision.bound.budgetMs,
        fetchImpl: this.guard(controller.signal),
      });

      const ms = this.now() - startedAt;
      this.persist(target.repositoryId, {
        lastAttemptAt: new Date(startedAt).toISOString(),
        lastOkAt: new Date(this.now()).toISOString(),
        consecutiveFailures: 0,
        nextEligibleAt: null,
        lastOutcome: `synced in ${ms}ms (${trigger})`,
      });
      this.debug?.(
        `${trigger} synced in ${ms}ms — pushed ${report.pushed.applied}, pulled ` +
          `${report.pulled.operations}, pending ${report.pending}`,
      );
      return { status: "synced", report, ms };
    } catch (error) {
      const ms = this.now() - startedAt;
      const outcome: AutoSyncOutcome = !controller.signal.aborted
        ? { status: "failed", code: codeOf(error), message: messageOf(error), ms }
        : controller.signal.reason === budgetElapsed
          ? { status: "timeout", ms }
          : { status: "cancelled", ms };

      /**
       * A cancellation is not a failure and must not push the backoff out.
       * Somebody closed a UI window; the endpoint said nothing about itself. A
       * timeout IS counted — a service too slow to answer inside the budget is a
       * service this device should back off from, which is the whole reason the
       * budget exists.
       */
      const failed = outcome.status !== "cancelled";
      const failures = failed ? readAutoSyncState(home, target.repositoryId).consecutiveFailures + 1 : 0;
      /**
       * Never sooner than the service asked. The jittered backoff starts at five
       * seconds, and a rate-limited service says how long it wants — sixty, from the
       * deployed Worker — so the next trigger waits for whichever is later.
       */
      const asked = retryAfterFrom(error, this.now());
      this.persist(target.repositoryId, {
        lastAttemptAt: new Date(startedAt).toISOString(),
        lastOkAt: readAutoSyncState(home, target.repositoryId).lastOkAt,
        consecutiveFailures: failed ? failures : 0,
        nextEligibleAt: failed
          ? new Date(this.now() + Math.max(autoSyncBackoffMs(failures, this.random), asked)).toISOString()
          : null,
        lastOutcome: `${outcome.status} after ${ms}ms (${trigger})`,
      });
      this.debug?.(`${trigger} ${outcome.status} after ${ms}ms`);
      return outcome;
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * The cancellable fetch.
   *
   * Rejecting BEFORE calling through is what makes the budget a bound on the run
   * rather than on one request: once the deadline has fired, the handshake, the
   * push and every remaining pull page fail instantly, so `syncRepository`
   * unwinds instead of working its way through a page list at one timeout each.
   *
   * `AbortSignal.any` rather than replacing `init.signal`: `client.ts` sets its
   * own per-request `AbortSignal.timeout` and that bound must survive. Whichever
   * fires first wins, which is the correct composition of "this request is taking
   * too long" and "this run is over".
   */
  private guard(signal: AbortSignal): typeof fetch {
    const base = this.options.fetchImpl ?? globalThis.fetch;
    return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (signal.aborted) {
        return Promise.reject(signal.reason ?? new Error("automatic sync was cancelled"));
      }
      const combined = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
      return base(input, { ...init, signal: combined });
    }) as typeof fetch;
  }

  /**
   * Writing the clock must never be the thing that breaks a command.
   *
   * A read-only staple home, a full disk, a directory somebody chmodded — none of
   * those are reasons for `staple ls` to fail. The cost of swallowing is that
   * coalescing degrades to "every trigger runs", which is the behaviour of a
   * machine that has consented to automatic sync anyway.
   */
  private persist(repositoryId: string, state: AutoSyncState): void {
    try {
      writeAutoSyncState(this.options.home, repositoryId, state);
    } catch {
      /* the clock is an optimization; the consent is not */
    }
  }
}

/** `post-write` outranks `session` outranks `startup`. See `queued`. */
function rank(trigger: AutoSyncTrigger | null): number {
  switch (trigger) {
    case "post-write":
      return 3;
    case "session":
      return 2;
    case "startup":
      return 1;
    default:
      return 0;
  }
}
