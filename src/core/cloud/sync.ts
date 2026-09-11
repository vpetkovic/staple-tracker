/**
 * `staple cloud sync` — explicit, human-triggered synchronization.
 *
 * Contract: `docs/sync.md`, "Ordering, cursors and epochs" and "Three consents".
 *
 * ## Nothing here runs on an ordinary command path
 *
 * *"a `staple ls` on a connected repository in manual mode is as silent as a
 * `staple ls` on a disconnected one, and that is a tested assertion, not an
 * intention."* This module is reachable only from `staple cloud sync`, and it is
 * the only thing that imports the parts of `client.ts` that push and pull.
 *
 * ## Push, then pull. Always that order.
 *
 * A device that pulled first would apply a remote edit, bumping the local entity
 * version, and then push its own already-journaled operation carrying a
 * `baseVersion` computed before that remote edit arrived. The receiver reads a
 * stale `baseVersion` and records a conflict — one that exists only because this
 * device read in the wrong order. Pushing first means every operation this device
 * sends describes the state it was actually made against.
 *
 * ## The four ways a sync ends
 *
 *   - it completes, and the cursor moved
 *   - it completes with nothing to do, and the cursor did not move
 *   - the endpoint is unreachable: `offline`, bounded, local work untouched
 *   - the server refuses something a human has to decide about, and it says so
 *
 * There is no fifth state where some operations quietly did not go.
 */
import type { DatabaseSync } from "node:sqlite";
import { tx } from "../db.js";
import { assertOwnHost } from "../repo-identity.js";
import { bindJournal, replayOutboxFieldWrites, type Journal, type OperationEnvelope } from "../journal.js";
import { StapleError, isRetryableErrorCode, nowIso } from "../types.js";
import { CLOUD_ERROR_CODES } from "./errors.js";
import {
  CLIENT_PROTOCOL,
  cloudCodeOf,
  cloudError,
  fetchCapabilities,
  fetchSnapshotPage,
  pullOperations,
  pushOperations,
  type Capabilities,
  type CloudErrorCode,
  type RequestOptions,
} from "./client.js";
import { readAutoSyncState, writeAutoSyncState } from "./auto-state.js";
import { readConnection } from "./connection.js";
import { credentialStoreFor } from "./credential-store.js";
import { parseEndpoint, type CloudEndpoint } from "./endpoint.js";
import { ReferentMissing, applyToDatabase, bumpEntityVersion, refreshedIssuePayload } from "./apply.js";
import { carryIdentifierMovesToHub } from "../hub-follow.js";
import { closeSettledIdentifierConflicts, settleOwedClaims } from "./claims.js";
import { assertHubCanTakePrefix, prefixToAdopt, restampHubPrefix } from "./prefix-hub.js";
import { applyConflictOperation, countOpenConflicts, screenForConflicts } from "./conflicts.js";
import { hydrate } from "./hydrate.js";
import { seedModeOf, seedOwed, seedRepository, type RepositorySurvey, type SeedReport } from "./seed.js";
import {
  acknowledgeOperation,
  advanceCursor,
  beginBootstrap,
  completeSnapshot,
  pendingCount,
  recordHeadSeq,
  recordSnapshotPage,
  recordSyncedAt,
  requireSyncState,
} from "./sync-state.js";
import {
  toWireEnvelope,
  type PullPage,
  type PushResponse,
  type RemoteOperation,
  type SnapshotEntity,
  type SnapshotPage,
} from "./wire.js";

export interface BootstrapReport {
  readonly entities: number;
  readonly pages: number;
  /** The seq the snapshot was folded to. Every page of one bootstrap shares it. */
  readonly cutoffSeq: number;
  /** True when this sync continued a bootstrap an earlier run had started. */
  readonly resumed: boolean;
}

export interface SyncReport {
  readonly repositoryId: string;
  readonly deviceId: string;
  readonly endpoint: string;
  readonly epoch: number;
  readonly pushed: {
    readonly attempted: number;
    readonly applied: number;
    readonly duplicate: number;
  };
  readonly pulled: {
    readonly operations: number;
    readonly pages: number;
    /** Operations skipped as already applied, from the local dedup ledger. */
    readonly alreadyApplied: number;
  };
  /** Null when this sync was incremental. */
  readonly bootstrap: BootstrapReport | null;
  readonly headSeq: number;
  /** Operations still waiting to be pushed. Zero on a clean sync. */
  readonly pending: number;
  /** Unresolved conflict records after this sync. */
  readonly conflicts: number;
  /**
   * What this sync uploaded of the state the workspace already held, or null when the
   * seed was not owed. Non-null exactly once per repository per database: on the first
   * sync, or on the first sync by a build that seeds of a database that had synchronized
   * without seeding.
   */
  readonly seed: SeedReport | null;
  /** Operations taken out of the queue unsent, because the service would refuse them. */
  readonly withheld: readonly WithheldOperation[];
  /**
   * The snapshot this sync re-read because an earlier build of staple applied this
   * database's state, or null. See {@link APPLIER_VERSION}.
   */
  readonly caughtUp: BootstrapReport | null;
  readonly at: string;
}

/** One operation larger than the service takes, named rather than left to block the push. */
export interface WithheldOperation {
  readonly entity: string;
  readonly entityId: string;
  readonly opId: string;
  readonly bytes: number;
  readonly maxBytes: number;
}

export interface SyncOptions extends RequestOptions {
  /** The staple home. Where the connection record and credential live. */
  home: string;
  /** Injected in tests. Real code takes the default. */
  sleep?: (ms: number) => Promise<void>;
  /** Bounded retry attempts per request. */
  attempts?: number;
  /** Pull page size. Clamped to what the server advertises. */
  pullLimit?: number;
  /**
   * How long, in total, this sync may wait on the service's `Retry-After` before it
   * gives up and reports `rate_limited`. Automatic sync passes 0: its next attempt is its
   * retry, and it schedules that no sooner than the service asked.
   */
  rateLimitWaitMs?: number;
  /**
   * Told before each wait a service asked for, with the refusal's code, so a surface
   * can say why a sync has paused.
   */
  onServiceWait?: (waitMs: number, code: string) => void;
}

const DEFAULT_ATTEMPTS = 3;

/**
 * The applier's generation, recorded in the database once a sync completes.
 *
 * An older build's applier dropped things this one applies — who queued an entry and its
 * note, a built-in status deleted elsewhere, the stand-in record a settlement closes — and
 * what it dropped stays dropped: nothing re-sends an operation a device has already applied.
 * Measured live, a device upgraded from a build before #101 kept a status every other device
 * had deleted and the author of every plan entry as "sync". So the first sync by a build
 * whose applier is newer than the one that wrote this database re-reads the snapshot once,
 * on the timeline it is already on — the same read a stuck tail recovers with — and the
 * state converges on what the log says. Raised whenever the applier learns to apply
 * something it used to drop.
 */
export const APPLIER_VERSION = 2;
const APPLIER_VERSION_KEY = "sync_applier_version";

function applierVersionOf(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(APPLIER_VERSION_KEY) as { value: string } | undefined;
  return Number(row?.value ?? 1);
}

function recordApplierVersion(db: DatabaseSync): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    APPLIER_VERSION_KEY,
    String(APPLIER_VERSION),
  );
}

/**
 * Whether a snapshot was served by a Worker whose fold this applier's generation needs.
 *
 * The client ships within minutes of a merge and the Worker whenever it is deployed, so
 * for a while an upgraded device reads a snapshot from the Worker before this build — one
 * that folds a delete as final even after a re-create, and says nothing of each create.
 * Re-reading that one deleted, on every upgraded device, a status removed and added back,
 * and then recorded the catch-up as done, so the new Worker never got to repair it. What
 * tells the two apart is on every entity: `createdSeq`, which the new fold always sends (a
 * number, or null) and the old one never does. An empty snapshot says nothing either way,
 * and has nothing to repair.
 */
function servedByCurrentFold(entities: readonly SnapshotEntity[]): boolean | null {
  if (entities.length === 0) return null;
  return entities.every((entity) => Object.prototype.hasOwnProperty.call(entity, "createdSeq"));
}

/** Set when this sync applied a snapshot from the older fold; read once, at the end. */
const hydratedFromOlderFold = new WeakMap<DatabaseSync, true>();

function noteFold(db: DatabaseSync, entities: readonly SnapshotEntity[]): void {
  if (servedByCurrentFold(entities) === false) hydratedFromOlderFold.set(db, true);
}

/**
 * One entity of the snapshot, to ask whether the service folds creates yet — so a device
 * that owes a re-read pays one small request per sync, not a whole snapshot, until the
 * Worker that can repair it is live.
 */
async function serviceFoldsCreates(session: Session, options: SyncOptions): Promise<boolean> {
  const page = (await attempt(
    () =>
      fetchSnapshotPage(
        session.endpoint,
        { repositoryId: session.repositoryId, token: session.token, deviceId: session.deviceId, cursor: null, limit: 1 },
        options,
      ),
    options,
  )) as SnapshotPage;
  return servedByCurrentFold(page.entities) !== false;
}

/**
 * The default `Retry-After` budget for one sync, and the longest single wait it takes.
 *
 * Sized for the one case that reaches it in ordinary use: the first sync of a large
 * workspace, which uploads its whole history in batches of `maxBatchSize` and can run
 * past the Worker's per-device limit (120 requests a minute, answered with
 * `Retry-After: 60`). Ten minutes carries a first sync of tens of thousands of items to
 * the end in one command; a single wait longer than two minutes is a service asking to
 * be left alone, and that is reported rather than sat through.
 */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 10 * 60_000;
export const MAX_SINGLE_RATE_LIMIT_WAIT_MS = 2 * 60_000;

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(error: unknown, now: number = Date.now()): number | null {
  if (!(error instanceof StapleError)) return null;
  const raw = error.detail?.retryAfter;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Per-sync state `attempt` shares across every request of one sync. */
const waitBudgets = new WeakMap<SyncOptions, { remainingMs: number }>();

/**
 * Only these three are retried.
 *
 * *"Everything else is a decision for a human, and retrying it is how a client
 * turns one bad request into a sustained one."* `epoch_changed` in particular is
 * not retryable — it is handled once, by re-bootstrapping, and never by asking
 * again.
 */
const RETRYABLE: ReadonlySet<CloudErrorCode> = new Set(CLOUD_ERROR_CODES.filter(isRetryableErrorCode));

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exported for the lease client, which needs exactly the same three local files
 * resolved in exactly the same order. Duplicating {@link openSession} there
 * would mean two implementations of "the credential is missing" to keep in
 * agreement, and the one that drifted would be the one nobody was reading.
 */
export interface Session {
  readonly repositoryId: string;
  readonly token: string;
  readonly deviceId: string;
  readonly endpoint: CloudEndpoint;
  readonly endpointOrigin: string;
}

/**
 * Resolve the connection this workspace syncs through, or refuse.
 *
 * Reads three local files and makes no request. A repository with no connection
 * record is `not_found` rather than a prompt: connecting is a separate consent
 * and `sync` does not get to spend it.
 */
export function openSession(home: string, repositoryId: string): Session {
  const connection = readConnection(home, repositoryId);
  if (!connection) {
    throw new StapleError(
      "not_found",
      `This repository is not connected on this machine, so there is nothing to synchronize with. ` +
        `Run \`staple cloud connect --endpoint <url> --token <secret>\` first. Connecting stores a ` +
        `credential and nothing else — it does not start synchronizing.`,
    );
  }

  const token = credentialStoreFor(home, connection.credentialMechanism).read(repositoryId);
  if (token === null) {
    throw new StapleError(
      "validation",
      `The connection record for this repository points at a ${connection.credentialMechanism} ` +
        `credential that is not there. Re-connect with \`staple cloud connect\`; nothing was sent.`,
    );
  }

  return {
    repositoryId,
    token,
    deviceId: connection.deviceId,
    endpoint: parseEndpoint(connection.endpoint),
    endpointOrigin: connection.endpoint,
  };
}

/**
 * Run one bounded request with retry.
 *
 * Bounded on both axes: a fixed number of attempts and a growing but capped
 * delay. *"A tracker command never blocks indefinitely on Cloudflare"* — the
 * per-request timeout in `client.ts` bounds each attempt, and this bounds how
 * many there are.
 */
async function attempt<T>(
  work: () => Promise<T>,
  options: SyncOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const sleep = options.sleep ?? sleepDefault;
  let budget = waitBudgets.get(options);
  if (!budget) {
    budget = { remainingMs: options.rateLimitWaitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS };
    waitBudgets.set(options, budget);
  }
  let last: unknown;

  for (let n = 0; n < attempts; ) {
    try {
      return await work();
    } catch (error) {
      last = error;
      const code = cloudCodeOf(error);
      if (code === null || !RETRYABLE.has(code)) throw error;
      /**
       * A service that says how long to wait is waited for, and the request is sent
       * again — without spending one of the transient-failure attempts, because being
       * told "not yet" is not a failure. Before this the schedule below retried a
       * `Retry-After: 60` after 200 ms, was refused twice more, and the sync stopped
       * with `rate_limited` halfway through a large first upload.
       *
       * Bounded twice: no single wait longer than {@link MAX_SINGLE_RATE_LIMIT_WAIT_MS},
       * and no more in total than this sync's budget, so an absurd or hostile value
       * cannot hang a command. Past either, the refusal is reported at once, with the
       * service's `Retry-After` in its detail, and everything already acknowledged stays
       * acknowledged.
       */
      const asked = retryAfterMs(error);
      // `asked > 0`: a zero wait would retry without spending anything from either bound.
      const honourable =
        asked !== null && asked > 0 && asked <= MAX_SINGLE_RATE_LIMIT_WAIT_MS && asked <= budget.remainingMs;
      if (code === "rate_limited" && honourable) {
        budget.remainingMs -= asked;
        options.onServiceWait?.(asked, code);
        await sleep(asked);
        continue;
      }
      // Asked to stay away for longer than this sync will wait: say so now, rather than
      // asking again in 200 ms and being refused twice more.
      if (code === "rate_limited" && asked !== null) throw error;
      n += 1;
      if (n >= attempts) throw error;
      /**
       * Any other retryable answer spends an attempt, and still waits at least what the
       * service asked for when it said: a 503 with `Retry-After: 5` retried after 200 ms is
       * the same rudeness as a 429 retried early, within the same two bounds.
       */
      const backoff = Math.min(2_000, 200 * 2 ** (n - 1));
      if (honourable && asked > backoff) {
        budget.remainingMs -= asked;
        options.onServiceWait?.(asked, code);
        await sleep(asked);
      } else {
        await sleep(backoff);
      }
    }
  }
  throw last;
}

/**
 * The protocol handshake, run before anything is sent or applied.
 *
 * *"A client outside that range is refused with `protocol_unsupported`, carrying
 * the supported range, before any write — no partial batch, no half-applied
 * page."* Capabilities is a read that changes no state on either side, so
 * refusing here satisfies "before any write" in the strongest sense: at the point
 * of refusal, nothing has happened.
 */
async function negotiate(session: Session, options: SyncOptions): Promise<Capabilities> {
  const capabilities = await attempt(
    () => fetchCapabilities(session.endpoint, options),
    options,
  );
  if (
    CLIENT_PROTOCOL < capabilities.protocol.min ||
    CLIENT_PROTOCOL > capabilities.protocol.max
  ) {
    throw cloudError(
      "protocol_unsupported",
      `${session.endpointOrigin} speaks protocol ${capabilities.protocol.min}–` +
        `${capabilities.protocol.max} and this build speaks ${CLIENT_PROTOCOL}. Nothing was sent ` +
        `and nothing was changed. Upgrade staple, or connect to a service that supports this ` +
        `protocol version.`,
      { min: capabilities.protocol.min, max: capabilities.protocol.max },
    );
  }
  return capabilities;
}

/** The migration number this database is at. An operation stamped above it is refused. */
function localSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return Number(row?.value ?? 0);
}

// --------------------------------------------------------------------- entry

/**
 * Push, then pull. The whole command.
 *
 * `db` stays the only read and write path for everything else in the process;
 * this function is the only thing in the tree that moves operations across the
 * boundary.
 */
export async function syncRepository(
  db: DatabaseSync,
  repositoryId: string,
  options: SyncOptions,
): Promise<SyncReport> {
  /**
   * First, before the session is even opened.
   *
   * The CLI refuses a copied home earlier and with the same words, but this is
   * the only chokepoint the AUTOMATIC path passes through: `AutoSyncScheduler`
   * imports this function directly, so a restored home whose device had already
   * consented to background sync would otherwise start pushing on the next write
   * with nobody typing anything. Placed ahead of `openSession` because a
   * restored home carries the credential too — reaching for it first would
   * report a connection problem instead of the copy that is actually the matter.
   */
  assertOwnHost(db);

  const session = openSession(options.home, repositoryId);
  const state = requireSyncState(db);
  // Read before the pull records anything. A database this sync hydrates — a first sync, a
  // join, a re-bootstrap — owes nothing more once it has (`hydrated`, below).
  const catchUpOwed = applierVersionOf(db) < APPLIER_VERSION;

  if (state.repositoryId !== repositoryId) {
    throw new StapleError(
      "conflict",
      `This database records repository ${state.repositoryId}, but the manifest names ` +
        `${repositoryId}. That happens when a directory was copied or a manifest was hand-edited. ` +
        `Nothing was sent. Resolve it with \`staple cloud fork-id\` if the split is intended, or by ` +
        `restoring .staple/repository.json from git if it is not.`,
    );
  }

  /**
   * Arm the seam for the rest of this process.
   *
   * Applying a pulled operation goes through `Journal.applyRemote`, which needs a
   * journal bound to this device; and a local mutation made after a sync in the
   * same process should journal against the same one. `bindJournal` is the entry
   * point the seam's author left for exactly this.
   */
  const journal = bindJournal(db, session.deviceId);

  const capabilities = await negotiate(session, options);

  /**
   * The seed, when this database owes one — before the push, so the push sends it.
   *
   * It needs to know what the service already holds, which is one full read of the
   * snapshot, and it is here rather than in `connect` for the consent reason: this
   * function is reached only by `staple cloud sync` or by automatic sync a human turned
   * on, so the seed follows exactly the rules every other upload follows, and a
   * connected workspace in manual mode stays as silent after connecting as before it.
   */
  /**
   * Push, and re-bootstrap once if the epoch moved under it.
   *
   * Without this the device deadlocks, and silently. *"A device presenting a
   * cursor from an older epoch gets `epoch_changed` … it must re-bootstrap
   * before it may push again"* — but push runs FIRST, so after a restore the
   * push is refused, the sync aborts before reaching the pull that would have
   * re-bootstrapped it, and the next run does exactly the same thing. The
   * repository is unreachable from that device for ever, and the only symptom is
   * an error a human reasonably reads as transient.
   *
   * So the re-bootstrap happens here too. The outbox is untouched by it — *"Its
   * pending local work survives; the outbox is never compacted"* — so the second
   * push sends the same operations, now fenced on the epoch the server actually
   * has.
   */
  let forcedBootstrap: BootstrapReport | null = null;
  const withheld: WithheldOperation[] = [];
  const pushed = { attempted: 0, applied: 0, duplicate: 0 };
  const pushAll = async (): Promise<void> => {
    let sent: SyncReport["pushed"];
    try {
      sent = await pushPending(db, journal, session, capabilities, options, withheld);
    } catch (error) {
      if (cloudCodeOf(error) !== "epoch_changed") throw error;
      beginBootstrap(db, epochFrom(error) ?? requireSyncState(db).epoch + 1);
      forcedBootstrap = await runBootstrap(db, journal, session, capabilities, options);
      sent = await pushPending(db, journal, session, capabilities, options, withheld);
    }
    pushed.attempted += sent.attempted;
    pushed.applied += sent.applied;
    pushed.duplicate += sent.duplicate;
  };

  let seed: SeedReport | null = null;
  let joined: BootstrapReport | null = null;
  if (seedOwed(db, repositoryId)) {
    /**
     * A heal sends what is already queued FIRST, under the ids it was queued with.
     *
     * A database that has been synchronizing can hold operations whose push landed and
     * whose acknowledgement did not — a dropped connection, a killed process, automatic
     * sync's budget aborting the request. Sent again under the same id, such an
     * operation comes back `duplicate` and is acknowledged; the heal must not give any
     * of them a new id, because a new id is applied a second time, at a later seq, on top
     * of whatever landed in between (see `seed.ts`). Sending them before the survey also
     * means the survey sees them, so the heal counts them in every version it stamps.
     *
     * A join does not: a database that has never synchronized has sent nothing, and its
     * whole pre-join journal is replaced by the seed.
     */
    const mode = seedModeOf(db);
    if (mode === "heal") await pushAll();
    const survey = await surveyRepository(session, capabilities, options);
    noteFold(db, survey.entities);
    /**
     * A joining workspace takes its repository's prefix (`repository-prefix.ts`) — refused
     * here, before the seed writes anything, when another workspace on this machine holds
     * it. Nothing has been written by this point: the survey only reads.
     */
    const adoptPrefix = mode === "join" ? prefixToAdopt(db, survey.entities) : null;
    if (adoptPrefix !== null) assertHubCanTakePrefix(options.home, db, adoptPrefix);
    seed = seedRepository(db, journal, {
      repositoryId,
      survey,
      maxOpBytes: capabilities.maxOpBytes,
      adoptPrefix,
    });
    if (seed?.prefix) restampHubPrefix(options.home, db, seed.prefix.to);
    if (seed?.mode === "join") {
      joined = { entities: survey.entities.length, pages: survey.pages, cutoffSeq: survey.cutoffSeq, resumed: false };
    }
  }

  await pushAll();

  const pull = await pullEverything(db, journal, session, capabilities, options);

  /**
   * What the pull made this device owe goes out in the same sync.
   *
   * Applying the pull can leave this device holding a later claim on an identifier or a
   * slug that another device claimed first, and it settles that with an operation of its
   * own (`claims.ts`). Until the settlement lands, every other device holds this device's
   * issue under a stand-in, so it is sent now rather than on the next sync — which might
   * be tomorrow.
   */
  if (pendingCount(db) > 0) await pushAll();

  let caughtUp: BootstrapReport | null = null;
  const hydrated = pull.bootstrap !== null || forcedBootstrap !== null || joined !== null;
  if (catchUpOwed && !hydrated && (await serviceFoldsCreates(session, options))) {
    caughtUp = (await recoverFromSnapshot(db, journal, session, capabilities, options, `applier-${APPLIER_VERSION}`)).bootstrap;
  }
  /**
   * Recorded only when what this database holds came through the fold this applier needs.
   * A snapshot from the older one — hydrated from, joined on, or re-read — leaves it owed,
   * and taken back if it was recorded, so the first sync after the new Worker is live
   * repairs it (`servedByCurrentFold`).
   */
  if (hydratedFromOlderFold.get(db) === true) {
    db.prepare("DELETE FROM meta WHERE key = ?").run(APPLIER_VERSION_KEY);
  } else if (!catchUpOwed || hydrated || caughtUp !== null) {
    recordApplierVersion(db);
  }
  hydratedFromOlderFold.delete(db);
  // And any identifier record an older build left open after applying its settlement.
  closeSettledIdentifierConflicts(db);

  const after = requireSyncState(db);
  recordSyncedAt(db);
  /**
   * A sync that worked is the answer to whatever automatic sync was waiting out — a
   * service's `Retry-After`, or its own failures — so the wait ends here, whichever surface
   * ran it. Left in place, it outlived every manual sync and was cleared only by reconnecting.
   */
  const waiting = readAutoSyncState(options.home, repositoryId);
  if (waiting.nextEligibleAt !== null || waiting.consecutiveFailures > 0) {
    writeAutoSyncState(options.home, repositoryId, { ...waiting, consecutiveFailures: 0, nextEligibleAt: null });
  }
  // The identifiers this sync moved, carried to this machine's hub cross-links (`hub-follow.ts`).
  carryIdentifierMovesToHub(db, options.home);

  const conflicts = countOpenConflicts(db);

  return {
    repositoryId,
    deviceId: session.deviceId,
    endpoint: session.endpointOrigin,
    epoch: after.epoch,
    pushed,
    pulled: pull.pulled,
    bootstrap: pull.bootstrap ?? forcedBootstrap ?? joined,
    headSeq: after.headSeq,
    pending: pendingCount(db),
    conflicts,
    seed,
    withheld,
    caughtUp,
    at: nowIso(),
  };
}

/**
 * Read the whole snapshot without applying any of it: what the service holds, at one
 * pinned cutoff, with the tail cursor that cutoff pinned.
 *
 * The cutoff is fixed by the first page and carried in every later cursor, so every
 * page describes the same instant, exactly as for a bootstrap. Reading nothing into the
 * database is the point — the seed decides what to write only once it knows everything
 * the service holds, and it writes all of it in one transaction.
 */
async function surveyRepository(
  session: Session,
  capabilities: Capabilities,
  options: SyncOptions,
): Promise<RepositorySurvey> {
  const entities: SnapshotEntity[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page = (await attempt(
      () =>
        fetchSnapshotPage(
          session.endpoint,
          {
            repositoryId: session.repositoryId,
            token: session.token,
            deviceId: session.deviceId,
            cursor,
            limit: capabilities.maxSnapshotPageSize,
          },
          options,
        ),
      options,
    )) as SnapshotPage;
    pages += 1;
    entities.push(...page.entities);
    if (page.nextCursor === null) {
      return { epoch: page.epoch, cutoffSeq: page.cutoffSeq, tailCursor: page.tailCursor, entities, pages };
    }
    cursor = page.nextCursor;
  }
}

// ---------------------------------------------------------------------- push

/**
 * `projects.source` is redacted per row, keyed on its sibling column.
 *
 * *"When `source_kind = 'local'` it holds an absolute filesystem path, which
 * discloses the device's directory layout and, on macOS and Linux, the account
 * name out of `/Users/<name>`."* The seam deliberately does not redact — the
 * decision needs a sibling column and belongs where the privacy contract is
 * enforced and testable, which is here.
 *
 * The sibling comes from the payload when the operation carries it and from the
 * local row otherwise, because a `project.update` that changed only `source`
 * carries only `source`.
 */
function redactOutbound(db: DatabaseSync, op: OperationEnvelope): OperationEnvelope {
  if (op.entity !== "project") return op;
  if (!("source" in op.payload)) return op;
  if (op.payload.source === null) return op;

  const kind =
    typeof op.payload.sourceKind === "string"
      ? op.payload.sourceKind
      : ((
          db.prepare("SELECT source_kind FROM projects WHERE id = ?").get(op.entityId) as
            | { source_kind: string | null }
            | undefined
        )?.source_kind ?? null);

  // A `github` source is a public URL and replicates unchanged. Stripping it
  // unconditionally would break GitHub-sourced projects for no privacy gain.
  if (kind !== "local") return op;
  return { ...op, payload: { ...op.payload, source: null } };
}

async function pushPending(
  db: DatabaseSync,
  journal: Journal,
  session: Session,
  capabilities: Capabilities,
  options: SyncOptions,
  withheld: WithheldOperation[],
): Promise<SyncReport["pushed"]> {
  let attempted = 0;
  let applied = 0;
  let duplicate = 0;

  /**
   * Re-read the outbox for each batch rather than paging one snapshot of it.
   *
   * Acknowledged rows drop out of `pending()` by construction, so re-reading is
   * how the loop terminates, and it is also what makes a mutation that landed
   * mid-sync get picked up rather than silently deferred to the next run.
   */
  for (;;) {
    const batch = journal.pending(capabilities.maxBatchSize);
    if (batch.length === 0) break;

    /**
     * An operation the service will refuse whatever happens is never sent as part of a
     * batch. The service refuses an oversized payload for the WHOLE batch, so one of them
     * in the outbox failed the same push on every sync and nothing queued behind it ever
     * left the machine. The journal refuses one at write time; this is for an outbox
     * written before it did, and for a service that advertises a smaller cap than the
     * journal's.
     *
     * A document revision or a comment is taken out of the queue and named. Nothing
     * refers to one revision — the next revision and the head pointer land without it —
     * and a comment is written once and never edited or named by anything, so leaving
     * either behind costs its text on the other devices and nothing else, which is the
     * decision the seed makes too.
     *
     * An issue cannot be left behind: every later edit, child, comment and blocker of it
     * would name something the other devices never receive. The queued operation never
     * landed — the service refuses it every time — so it is rebuilt from the issue as it
     * stands now, which is what makes editing the issue below the limit the way out.
     * Anything still too large is refused by name. This build cannot queue any of these
     * (the journal refuses them); only an outbox written by an older build can hold one.
     */
    const sizeOf = (payload: unknown): number => Buffer.byteLength(JSON.stringify(payload), "utf8");
    const outbound = batch.map((op) => redactOutbound(db, op));
    const tooLarge = outbound.filter((op) => sizeOf(op.payload) > capabilities.maxOpBytes);
    const skippable = (op: OperationEnvelope): boolean => op.entity === "documentRevision" || op.entity === "comment";
    let rebuilt = false;
    for (const op of tooLarge) {
      if (skippable(op) || op.entity !== "issue") continue;
      const fresh = refreshedIssuePayload(db, op.entityId, op.payload);
      if (fresh !== null && sizeOf(fresh) <= capabilities.maxOpBytes) {
        db.prepare("UPDATE sync_outbox SET payload = ? WHERE op_id = ? AND acknowledged_seq IS NULL").run(
          JSON.stringify(fresh),
          op.opId,
        );
        rebuilt = true;
      }
    }
    if (rebuilt) continue;
    const unskippable = tooLarge.find((op) => !skippable(op));
    if (unskippable) {
      const bytes = sizeOf(unskippable.payload);
      const label =
        unskippable.entity === "issue"
          ? `issue ${
              (db.prepare("SELECT identifier FROM issues WHERE id = ?").get(unskippable.entityId) as
                | { identifier: string }
                | undefined)?.identifier ?? unskippable.entityId
            }`
          : `${unskippable.entity} ${unskippable.entityId}`;
      throw cloudError(
        "payload_too_large",
        `A queued change to ${label} is ${bytes} bytes and ${session.endpointOrigin} takes at most ` +
          `${capabilities.maxOpBytes}, so it can never be sent, and leaving it out would break everything ` +
          `that refers to it. Nothing was sent. It was queued by an older build of staple.` +
          (unskippable.entity === "issue"
            ? ` Edit its description or title below the limit (in the UI, or with the MCP update_task tool) ` +
              `and run \`staple cloud sync\` again: the queued change is rebuilt from the edited issue.`
            : ""),
        { bytes, maxBytes: capabilities.maxOpBytes },
      );
    }
    if (tooLarge.length > 0) {
      tx(db, () => {
        for (const op of tooLarge) {
          journal.withhold(op.opId);
          withheld.push({
            entity: op.entity,
            entityId: op.entityId,
            opId: op.opId,
            bytes: Buffer.byteLength(JSON.stringify(op.payload), "utf8"),
            maxBytes: capabilities.maxOpBytes,
          });
        }
      });
      continue;
    }

    /**
     * Zero is not an epoch — it is migration 010's default, meaning this device
     * has never learned one. Fencing on it would refuse every first push.
     */
    const known = requireSyncState(db).epoch;
    const epoch = known > 0 ? known : null;
    const wire = outbound.map((op) => toWireEnvelope(op));

    const response = (await attempt(
      () =>
        pushOperations(
          session.endpoint,
          {
            repositoryId: session.repositoryId,
            token: session.token,
            deviceId: session.deviceId,
            epoch,
            ops: wire,
          },
          options,
        ),
      options,
    )) as PushResponse;

    attempted += batch.length;

    /**
     * One transaction for the whole acknowledgement.
     *
     * A `duplicate` is a success and carries the seq of its ORIGINAL
     * application, so it is acknowledged exactly like an `applied` — that is the
     * lost-acknowledgement recovery, and treating it as an error would make the
     * device push the same work for ever.
     */
    tx(db, () => {
      for (const result of response.results) {
        acknowledgeOperation(db, result.opId, result.seq);
        if (result.status === "duplicate") duplicate += 1;
        else applied += 1;
      }
      recordHeadSeq(db, response.serverHighWatermark, response.epoch);
    });

    /**
     * A server that acknowledged nothing would otherwise spin. This cannot
     * happen against a correct server — every operation in an accepted batch
     * gets a result — and the guard is here because "cannot happen" plus "loop
     * until empty" is how a client hangs.
     */
    if (response.results.length === 0) {
      throw cloudError(
        "unavailable",
        `${session.endpointOrigin} accepted a batch of ${batch.length} operations and returned no ` +
          `results. Nothing was marked acknowledged; the operations are still queued locally.`,
      );
    }
  }

  return { attempted, applied, duplicate };
}

// ---------------------------------------------------------------------- pull

interface PullOutcome {
  readonly pulled: SyncReport["pulled"];
  readonly bootstrap: SyncReport["bootstrap"];
}

/**
 * Pull, and re-bootstrap once if the epoch moved out from under any cursor.
 *
 * ## Every stored cursor is epoch-scoped, so every replay of one can be refused
 *
 * `worker/src/cursor.ts` fences BOTH cursor kinds through the same
 * `assertCursorScope`, so `epoch_changed` can come from the snapshot route as
 * readily as from the pull route. An earlier shape of this function guarded only
 * the drain, and that left a device killed between snapshot pages permanently
 * stuck: it keeps `bootstrap_cursor`, the resume replays it, the service refuses
 * it, the sync aborts before the drain's handler is reached, and the position is
 * still there for the next run to replay identically. That device can never
 * finish a sync — so it can never push either, and its local work stops leaving
 * the machine entirely. The symptom is a message about a cursor a human cannot
 * edit, which reads like something transient.
 *
 * The recovery is the same either way and so is the guard: forget the position,
 * take a fresh snapshot, drain from the tail it pins. It is deliberately not
 * per-call-site.
 */
async function pullEverything(
  db: DatabaseSync,
  journal: Journal,
  session: Session,
  capabilities: Capabilities,
  options: SyncOptions,
): Promise<PullOutcome> {
  try {
    return await pullOnce(db, journal, session, capabilities, options);
  } catch (error) {
    if (error instanceof StapleError && error.detail?.referentMissing === true) {
      return recoverFromSnapshot(db, journal, session, capabilities, options);
    }
    if (cloudCodeOf(error) !== "epoch_changed") throw error;

    /**
     * The epoch moved. *"A device presenting a cursor from an older epoch gets
     * `epoch_changed`, which is not retryable: it must re-bootstrap before it
     * may push again."*
     *
     * `beginBootstrap` is what makes the retry different from the attempt that
     * just failed: it clears `cursor` AND `bootstrap_cursor`, so the fresh run
     * asks for a new snapshot with no cursor at all rather than replaying the
     * dead one.
     *
     * The epoch written here is provisional — the service's own answer arrives
     * with the snapshot and `completeSnapshot` adopts it — so a guess that is
     * wrong by more than one is corrected rather than compounded.
     *
     * The re-bootstrap happens once and is not itself retried on a second
     * `epoch_changed` — two epoch bumps inside one sync means somebody is
     * restoring repeatedly, and a client that kept chasing it would never
     * finish.
     */
    const epoch = epochFrom(error) ?? requireSyncState(db).epoch + 1;
    beginBootstrap(db, epoch);
    const redone = await runBootstrap(db, journal, session, capabilities, options);
    const pulled = await drainTail(db, journal, session, capabilities, options);
    return { pulled, bootstrap: { ...redone, resumed: false } };
  }
}

/**
 * A tail page that cannot be applied because it names what no earlier operation created:
 * read the snapshot instead, once.
 *
 * *"A device cannot edit an entity it has never seen, so the edit necessarily sorts after
 * the create"* was true of every device but one kind: a device on a build before the
 * seed, which edited issues it had never uploaded. Their creates arrive only once some
 * device seeds or heals, and then at the END of the log — arbitrarily many pages after
 * the edits that name them, where the pull loop's end-of-page retry can never reach. A
 * device already connected when those edits were pushed stops at them, on every sync.
 *
 * The snapshot does not have that problem: it folds every operation on an entity into
 * one state whatever order they arrived in, so an update followed much later by its
 * create folds to a complete entity. So the page's failure is answered by one read of
 * the snapshot, applied in one transaction as a join is (`seed.ts`), after which the
 * tail resumes from the cutoff that snapshot pinned. Nothing is forgotten: the ledger,
 * the versions and the field record are kept, because this is the timeline the device is
 * already on, and inherited provenance is taken at the fold's own numbers.
 *
 * Once per sync. If the snapshot cannot resolve it either — the create exists nowhere —
 * that failure is thrown, naming the referent, exactly as the page's would have been.
 */
async function recoverFromSnapshot(
  db: DatabaseSync,
  journal: Journal,
  session: Session,
  capabilities: Capabilities,
  options: SyncOptions,
  ledger = "snap",
): Promise<PullOutcome> {
  const survey = await surveyRepository(session, capabilities, options);
  noteFold(db, survey.entities);
  tx(db, () => {
    hydrate(db, journal, survey.entities, [], survey.cutoffSeq, nowIso(), true, true, ledger);
    completeSnapshot(db, survey.tailCursor, survey.epoch);
    replayOutboxFieldWrites(db);
    settleOwedClaims(db, journal);
  });
  const pulled = await drainTail(db, journal, session, capabilities, options);
  return {
    pulled,
    bootstrap: { entities: survey.entities.length, pages: survey.pages, cutoffSeq: survey.cutoffSeq, resumed: false },
  };
}

/**
 * One attempt at the pull half: bootstrap if this device owes one, then drain.
 *
 * The decision is made from which columns are populated, and nothing else:
 *
 *     bootstrap_cursor present  -> resume the snapshot half
 *     cursor present            -> incremental
 *     neither                   -> fresh bootstrap
 */
async function pullOnce(
  db: DatabaseSync,
  journal: Journal,
  session: Session,
  capabilities: Capabilities,
  options: SyncOptions,
): Promise<PullOutcome> {
  let bootstrap: BootstrapReport | null = null;
  const state = requireSyncState(db);

  if (state.bootstrap !== null || state.cursor === null) {
    bootstrap = await runBootstrap(db, journal, session, capabilities, options);
  }

  const pulled = await drainTail(db, journal, session, capabilities, options);
  return { pulled, bootstrap };
}

function epochFrom(error: unknown): number | null {
  if (!(error instanceof StapleError)) return null;
  /**
   * `currentEpoch` FIRST. Every `SyncError("epoch_changed", …)` in `worker/src/` carries
   * `currentEpoch` and none carries `epoch`, so the old order preferred a spelling only the
   * test fake emitted — which is exactly backwards from *"where they disagree the Worker
   * wins"*. Both are still read, so a service using either is understood.
   */
  const epoch = error.detail?.currentEpoch ?? error.detail?.epoch;
  return typeof epoch === "number" ? epoch : null;
}

/**
 * The snapshot half of a bootstrap: a stable cutoff, then the ordered tail.
 *
 * *"A hydrating device reads a materialized snapshot taken at `seq = C`, then
 * pulls from cursor `C` forward. Writes concurrent with the snapshot are in the
 * tail, so nothing is missed and nothing is applied twice."*
 *
 * The cutoff is pinned inside the cursor the server hands back, so every page of
 * one bootstrap folds to the same `seq`. That is why a resumed bootstrap replays
 * the stored cursor rather than starting a new snapshot: a new one would pin a
 * LATER cutoff, and the operations between the two cutoffs would be in neither
 * half.
 */
async function runBootstrap(
  db: DatabaseSync,
  journal: Journal,
  session: Session,
  capabilities: Capabilities,
  options: SyncOptions,
): Promise<BootstrapReport> {
  const start = requireSyncState(db);
  const resumed = start.bootstrap !== null;
  let cursor = start.bootstrap?.snapshot ?? null;
  let parked: readonly SnapshotEntity[] = start.bootstrap?.parked ?? [];
  let entities = 0;
  let pages = 0;
  let cutoffSeq = 0;
  const limit = capabilities.maxSnapshotPageSize;

  for (;;) {
    const page = (await attempt(
      () =>
        fetchSnapshotPage(
          session.endpoint,
          {
            repositoryId: session.repositoryId,
            token: session.token,
            deviceId: session.deviceId,
            cursor,
            limit,
          },
          options,
        ),
      options,
    )) as SnapshotPage;

    cutoffSeq = page.cutoffSeq;
    pages += 1;

    /**
     * One transaction per page: the entities, the versions, the position and whatever
     * had to be parked all commit together. A kill anywhere inside leaves the previous
     * page's position and parked set, and the page is simply re-fetched — the fold is
     * deterministic for a pinned cutoff, so a re-fetched page is byte-identical.
     *
     * The page is applied in dependency order, not in the order it arrived, and an
     * entity whose referent is on a later page is parked until it lands; see
     * `hydrate.ts` for why the snapshot's own order cannot be applied as it stands.
     */
    const at = nowIso();
    const final = page.nextCursor === null;
    tx(db, () => {
      noteFold(db, page.entities);
      const outcome = hydrate(db, journal, page.entities, parked, cutoffSeq, at, final);
      entities += outcome.applied;
      parked = outcome.parked;
      settleOwedClaims(db, journal);

      if (final) {
        // The snapshot half is done. The tail becomes the ordinary cursor and
        // the bootstrap position is cleared, in one statement.
        completeSnapshot(db, page.tailCursor, page.epoch);
        /**
         * And the last word goes to work this device has not sent yet.
         *
         * `beginBootstrap` cleared the field record because every row in it was
         * denominated in the epoch being left behind. The outbox was NOT cleared —
         * it never is — so the fields those queued operations name are values this
         * device still holds and must still be able to defend. Replayed here rather
         * than in `beginBootstrap` so that it lands after the server's view: a
         * snapshot is older than an operation the server has not seen.
         */
        replayOutboxFieldWrites(db);
      } else {
        recordSnapshotPage(db, { snapshot: page.nextCursor, tail: page.tailCursor, parked });
      }
    });

    if (final) break;
    cursor = page.nextCursor;
  }

  return { entities, pages, cutoffSeq, resumed };
}

/**
 * Drain the ordered tail from the incremental cursor.
 *
 * `WHERE seq > cursor` is gap-tolerant by construction, so nothing here asserts
 * that the next `seq` is the last plus one, treats a gap as loss, or derives a
 * count from a range. `hasMore` is the server's answer and not something computed
 * from the page size — a page that happens to be exactly `limit` long is not
 * evidence of anything.
 */
async function drainTail(
  db: DatabaseSync,
  journal: Journal,
  session: Session,
  capabilities: Capabilities,
  options: SyncOptions,
): Promise<SyncReport["pulled"]> {
  const limit = Math.min(
    options.pullLimit ?? capabilities.defaultPullLimit,
    capabilities.maxPullLimit,
  );
  let operations = 0;
  let pages = 0;
  let alreadyApplied = 0;

  for (;;) {
    const cursor = requireSyncState(db).cursor;
    const page = (await attempt(
      () =>
        pullOperations(
          session.endpoint,
          {
            repositoryId: session.repositoryId,
            token: session.token,
            deviceId: session.deviceId,
            cursor,
            limit,
          },
          options,
        ),
      options,
    )) as PullPage;

    pages += 1;
    if (page.ops.length > 0) {
      const outcome = applyPage(db, journal, page.ops, session.deviceId);
      operations += outcome.applied;
      alreadyApplied += outcome.skipped;
    }

    // The cursor advances even for an empty page: the server's `nextCursor` is
    // still the correct place to resume from, and writing it records the epoch
    // and the watermark this device has now seen.
    tx(db, () => advanceCursor(db, page.nextCursor, page.serverHighWatermark, page.epoch));

    if (!page.hasMore) break;
  }

  return { operations, pages, alreadyApplied };
}

/**
 * Apply one page as one transaction.
 *
 * *"Within a page, operations apply in `seq` order; an operation whose referent
 * does not exist yet is deferred to the end of the page and retried once. If it
 * is still unresolvable when the page ends, the page fails whole with
 * `validation` and nothing is committed."*
 *
 * Causality across devices is mostly self-enforcing — a device cannot edit an
 * entity it has never seen, so the edit necessarily sorts after the create — but
 * "mostly" is not a guarantee to build an apply loop on.
 */
function applyPage(
  db: DatabaseSync,
  journal: Journal,
  ops: readonly RemoteOperation[],
  localDeviceId: string,
): { applied: number; skipped: number } {
  const schema = localSchemaVersion(db);

  /**
   * The schema refusal runs over the WHOLE page before a single row is written.
   * *"It never applies part of a page and never guesses at a column it does not
   * have."*
   */
  for (const op of ops) {
    if (op.schema > schema) {
      throw cloudError(
        "schema_ahead",
        `Operation ${op.opId} was written under workspace schema ${op.schema} and this database ` +
          `is at ${schema}. Nothing was applied. Upgrade staple and run \`staple migrate\`.`,
        { schema: op.schema, local: schema },
      );
    }
  }

  let applied = 0;
  let skipped = 0;

  tx(db, () => {
    const deferred: RemoteOperation[] = [];

    for (const op of ops) {
      const outcome = applyOne(db, journal, op, localDeviceId);
      if (outcome === "deferred") deferred.push(op);
      else if (outcome === "skipped") skipped += 1;
      else applied += 1;
    }

    // The single retry. Anything still unresolvable is a page that cannot be
    // applied coherently, and a partial page is worse than none.
    for (const op of deferred) {
      try {
        const outcome = applyOne(db, journal, op, localDeviceId, true);
        if (outcome === "skipped") skipped += 1;
        else applied += 1;
      } catch (error) {
        if (!(error instanceof ReferentMissing)) throw error;
        throw cloudError(
          "validation",
          `Operation ${op.opId} (${op.entity}.${op.verb} on ${op.entityId}) names something this ` +
            `page never delivered: ${error.what}. The whole page was rolled back and nothing was ` +
            `applied; the cursor did not move, so the next sync retries it.`,
          { referentMissing: true },
        );
      }
    }
    /**
     * Every later claim of this device's that yielded to one in this page is settled now,
     * in the same transaction, as ordinary operations (`claims.ts`).
     */
    settleOwedClaims(db, journal);
  });

  return { applied, skipped };
}

function applyOne(
  db: DatabaseSync,
  journal: Journal,
  op: RemoteOperation,
  localDeviceId: string,
  final = false,
): "applied" | "skipped" | "deferred" {
  try {
    /**
     * `applyRemote` returns null when the operation id is already in the ledger,
     * which makes redelivery free — and redelivery is normal, not exceptional: a
     * cursor that did not advance because the process died mid-page replays the
     * whole page on the next run.
     */
    const result = journal.applyRemote({ opId: op.opId, seq: op.seq }, () => {
      if (op.entity === "conflict") {
        /**
         * Somebody settled a disagreement. That is not a fold onto a row, so it
         * does not go through the applier's switch — see
         * {@link applyConflictOperation}.
         */
        applyConflictOperation(db, op);
        bumpEntityVersion(db, op.entity, op.entityId);
        return true;
      }

      /**
       * Screen before applying. A field this device has changed since the
       * version this operation claims as its base is recorded as a conflict and
       * WITHHELD — *"No path applies last-write-wins."* The rest of the same
       * operation still lands, so one contested field cannot wedge the entity
       * it sits on, and `null` means every contentful field was contested and
       * there is nothing left to write.
       */
      const screened = screenForConflicts(db, op, localDeviceId);
      if (screened !== null) applyToDatabase(db, screened);
      /**
       * The local entity version moves because, as far as this database is
       * concerned, this entity just changed. Not set to the remote's
       * `baseVersion + 1`: the local counter also counts this device's own
       * mutations, and adopting a remote number would make the next local
       * operation claim a version the receiver has already seen.
       *
       * ONCE PER OPERATION, which is why the device's own echo is excluded. A
       * push acknowledges into the outbox and does not move the cursor, so a
       * device pulls its own operations back and applies them; counting them a
       * second time here made the counter
       * `(operations seen) + (operations authored)` rather than
       * `(operations seen)`, and two devices with different shares of the
       * authorship drifted apart permanently. Conflict detection reads
       * "`baseVersion` behind the local version" as "the sender had seen less
       * than I have", and that is only true of a counter both devices increment
       * on the same events. Four enqueues on one device and one on the other
       * was enough to put the drift past the gap and lose the conflict
       * entirely.
       */
      if (op.deviceId !== localDeviceId) bumpEntityVersion(db, op.entity, op.entityId);
      return true;
    });
    return result === null ? "skipped" : "applied";
  } catch (error) {
    if (error instanceof ReferentMissing && !final) return "deferred";
    throw error;
  }
}
