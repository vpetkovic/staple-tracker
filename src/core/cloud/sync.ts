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
import {
  bindJournal,
  recordInheritedFieldWrites,
  replayOutboxFieldWrites,
  type Journal,
  type OperationEnvelope,
} from "../journal.js";
import { StapleError, nowIso } from "../types.js";
import {
  CLIENT_PROTOCOL,
  cloudCodeOf,
  fetchCapabilities,
  fetchSnapshotPage,
  pullOperations,
  pushOperations,
  type Capabilities,
  type CloudErrorCode,
  type RequestOptions,
} from "./client.js";
import { readConnection } from "./connection.js";
import { credentialStoreFor } from "./credential-store.js";
import { parseEndpoint, type CloudEndpoint } from "./endpoint.js";
import {
  ReferentMissing,
  applyToDatabase,
  bumpEntityVersion,
  localEntityVersion,
  setEntityVersion,
  snapshotToInput,
} from "./apply.js";
import { applyConflictOperation, countOpenConflicts, screenForConflicts } from "./conflicts.js";
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
  readonly at: string;
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
}

const DEFAULT_ATTEMPTS = 3;

/**
 * Only these three are retried.
 *
 * *"Everything else is a decision for a human, and retrying it is how a client
 * turns one bad request into a sustained one."* `epoch_changed` in particular is
 * not retryable — it is handled once, by re-bootstrapping, and never by asking
 * again.
 */
const RETRYABLE: ReadonlySet<CloudErrorCode> = new Set(["rate_limited", "unavailable", "offline"]);

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
  let last: unknown;

  for (let n = 0; n < attempts; n += 1) {
    try {
      return await work();
    } catch (error) {
      last = error;
      const code = cloudCodeOf(error);
      if (code === null || !RETRYABLE.has(code)) throw error;
      if (n === attempts - 1) throw error;
      await sleep(Math.min(2_000, 200 * 2 ** n));
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
    throw new StapleError(
      "validation",
      `${session.endpointOrigin} speaks protocol ${capabilities.protocol.min}–` +
        `${capabilities.protocol.max} and this build speaks ${CLIENT_PROTOCOL}. Nothing was sent ` +
        `and nothing was changed. Upgrade staple, or connect to a service that supports this ` +
        `protocol version.`,
      {
        cloudCode: "protocol_unsupported",
        retryable: false,
        min: capabilities.protocol.min,
        max: capabilities.protocol.max,
      },
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
  let pushed: SyncReport["pushed"];
  try {
    pushed = await pushPending(db, journal, session, capabilities, options);
  } catch (error) {
    if (cloudCodeOf(error) !== "epoch_changed") throw error;
    beginBootstrap(db, epochFrom(error) ?? state.epoch + 1);
    forcedBootstrap = await runBootstrap(db, journal, session, capabilities, options);
    pushed = await pushPending(db, journal, session, capabilities, options);
  }

  const pull = await pullEverything(db, journal, session, capabilities, options);

  const after = requireSyncState(db);
  recordSyncedAt(db);

  const conflicts = countOpenConflicts(db);

  return {
    repositoryId,
    deviceId: session.deviceId,
    endpoint: session.endpointOrigin,
    epoch: after.epoch,
    pushed,
    pulled: pull.pulled,
    bootstrap: pull.bootstrap ?? forcedBootstrap,
    headSeq: after.headSeq,
    pending: pendingCount(db),
    conflicts,
    at: nowIso(),
  };
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
     * Zero is not an epoch — it is migration 010's default, meaning this device
     * has never learned one. Fencing on it would refuse every first push.
     */
    const known = requireSyncState(db).epoch;
    const epoch = known > 0 ? known : null;
    const wire = batch.map((op) => toWireEnvelope(redactOutbound(db, op)));

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
      throw new StapleError(
        "conflict",
        `${session.endpointOrigin} accepted a batch of ${batch.length} operations and returned no ` +
          `results. Nothing was marked acknowledged; the operations are still queued locally.`,
        { cloudCode: "unavailable", retryable: true },
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
  const epoch = error.detail?.epoch ?? error.detail?.currentEpoch;
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
     * One transaction per page: the entities, the versions and the position all
     * commit together. A kill anywhere inside leaves the previous page's
     * position, and the page is simply re-fetched — the fold is deterministic
     * for a pinned cutoff, so a re-fetched page is byte-identical.
     */
    const at = nowIso();
    tx(db, () => {
      for (const entity of page.entities) {
        const input = snapshotToInput(entity, at);
        /**
         * Through `applyRemote` so the write is echo-suppressed: a hydrating
         * device must not journal an outbound copy of every row it was handed,
         * which would push the entire repository straight back at the server.
         *
         * The synthetic op id is derived from the entity key and the cutoff, so
         * re-applying a re-fetched page is a ledger hit rather than a second
         * write. It is not an operation id the server ever issued, and it is
         * never sent anywhere.
         */
        journal.applyRemote(
          { opId: `snap:${cutoffSeq}:${entity.entity} ${entity.entityId}`, seq: entity.lastSeq },
          () => {
            /**
             * Read BEFORE `setEntityVersion`, and used below. On a first bootstrap
             * this is 0; on a re-bootstrap it is the counter this device carried
             * across the epoch change, which `beginBootstrap` deliberately does not
             * rewind. `recordInheritedFieldWrites` needs the one from before,
             * because the one from after is the snapshot's own number.
             */
            const priorVersion = localEntityVersion(db, entity.entity, entity.entityId);
            applyToDatabase(db, input);
            setEntityVersion(db, entity.entity, entity.entityId, entity.version);
            /**
             * And the provenance for the values just inherited (STA-263).
             *
             * Without this a bootstrapped device holds a title somebody chose with no
             * record anywhere saying so, and hands it to the next stale write in
             * silence — the relay defect of STA-261, reached by the other road.
             *
             * `entity.fieldWrites` names only the fields a non-`create` operation
             * carried, so the defaults that rode along inside the create acquire no
             * claim. That distinction is made by the server's fold, and it has to be:
             * `state` holds one value per field and cannot tell a decision from a
             * default. An older Worker sends nothing here and the device is left
             * exactly as blind as it was before, which is the only safe degradation —
             * synthesising rows from `state` is the failure this ticket exists to
             * avoid.
             */
            recordInheritedFieldWrites(
              db,
              entity.entity,
              entity.entityId,
              Object.entries(entity.fieldWrites ?? {}).map(([field, write]) => ({
                field,
                baseVersion: write.baseVersion,
                opId: write.opId,
                at: write.at,
              })),
              priorVersion,
            );
          },
        );
        entities += 1;
      }

      if (page.nextCursor === null) {
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
        recordSnapshotPage(db, { snapshot: page.nextCursor, tail: page.tailCursor });
      }
    });

    if (page.nextCursor === null) break;
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
      throw new StapleError(
        "validation",
        `Operation ${op.opId} was written under workspace schema ${op.schema} and this database ` +
          `is at ${schema}. Nothing was applied. Upgrade staple and run \`staple migrate\`.`,
        { cloudCode: "schema_ahead", retryable: false, schema: op.schema, local: schema },
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
        throw new StapleError(
          "validation",
          `Operation ${op.opId} (${op.entity}.${op.verb} on ${op.entityId}) names something this ` +
            `page never delivered: ${error.what}. The whole page was rolled back and nothing was ` +
            `applied; the cursor did not move, so the next sync retries it.`,
          { cloudCode: "validation", retryable: false },
        );
      }
    }
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
