/**
 * The sync service, in memory, with the deployed Worker's semantics.
 *
 * This is not a stub that returns whatever the client hopes for. It re-implements
 * the parts of `worker/src/` that the client's correctness depends on, and it is
 * deliberately as PICKY as the real one:
 *
 *   - `replace` is refused for anything but `queue` and `milestone`
 *     (`worker/src/envelope.ts`), which is what catches an emitter journalling a
 *     verb the service will not take
 *   - `actor` must be a string, `baseVersion` is required for every verb but
 *     `create`, `repoId` and `deviceId` must match the session
 *   - a batch is validated whole and rejected whole; nothing is partially applied
 *   - sequence slots are reserved for the WHOLE batch before any row is written,
 *     so a deduplicated operation leaves its slot unused and the log has GAPS
 *   - a `duplicate` result carries the seq of the ORIGINAL application
 *   - cursors are opaque to the caller, are re-validated against the session, and
 *     a superseded epoch is `epoch_changed` rather than a silent reset
 *
 * A friendlier fake would make the client's tests pass and the real service fail,
 * which is the only outcome worse than no test.
 *
 * It runs entirely in this process and touches no socket. It is handed to the
 * client as a `fetchImpl`, so `test/fixtures/network-spy.ts` stays satisfied:
 * nothing here is a network primitive.
 */

export interface StoredOp {
  seq: number;
  epoch: number;
  opId: string;
  deviceId: string;
  entity: string;
  entityId: string;
  verb: string;
  baseVersion: number | null;
  payload: unknown;
  actor: string;
  clientSeq: number;
  schema: number;
  createdAt: string;
  serverTs: number;
}

interface Device {
  token: string;
  deviceId: string;
  /** Set by {@link FakeSyncServer.revoke}. Refused at authentication, like the Worker. */
  revoked?: boolean;
}

/**
 * One lease, exactly as `worker/src/leases.ts` stores it.
 *
 * `expiresAt` is absolute server time and is only ever computed here, from this
 * object's own clock. A client's `ttlSeconds` is the only input it gets to
 * supply, which is the property the client tests exist to hold.
 */
interface StoredLease {
  entityId: string;
  fencingToken: number;
  holder: string;
  deviceId: string;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
}

/** `worker/src/limits.ts`. Reproduced so a bad ttl is refused here too. */
const DEFAULT_LEASE_TTL_SECONDS = 300;
const MAX_LEASE_TTL_SECONDS = 3600;
/** A folded entity, as a backup stores it. `superseded` records the verb. */
interface FoldedEntity {
  entity: string;
  entityId: string;
  version: number;
  deletedAt: number | null;
  lastSeq: number;
  superseded: boolean;
  state: Record<string, unknown>;
}

export interface FakeBackup {
  backupId: string;
  epoch: number;
  cutoffSeq: number;
  entityCount: number;
  opCount: number;
  schemaVersion: number;
  protocol: number;
  kind: "manual" | "pre-restore";
  createdAt: number;
  createdByDevice: string;
  entities: FoldedEntity[];
}

export interface FakeRestore {
  restoreId: string;
  backupId: string;
  preRestoreBackupId: string;
  fromEpoch: number;
  toEpoch: number;
  guardSeq: number;
  entityCount: number;
  staged: number;
  status: "staging" | "committed";
}

export interface FakeServerOptions {
  repositoryId: string;
  /** Advertised batch size. The client must size itself from this. */
  maxBatchSize?: number;
  maxPullLimit?: number;
  defaultPullLimit?: number;
  maxSnapshotPageSize?: number;
  protocol?: { min: number; max: number };
}

const ENTITIES = new Set([
  "issue",
  "comment",
  "document",
  "documentRevision",
  "relation",
  "project",
  "status",
  "kind",
  "setting",
  "milestone",
  "queue",
  "lease",
  "conflict",
]);
const VERBS = new Set(["create", "update", "delete", "replace", "renumber"]);

class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
function unb64url(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

export class FakeSyncServer {
  readonly ops: StoredOp[] = [];
  epoch = 1;
  lastSeq = 0;
  /** Requests served, by route. Tests assert on batching and page counts. */
  readonly calls: string[] = [];
  /** Set to make the next N matching requests fail transiently. */
  failNext: { route: string; times: number; status: number; code: string } | null = null;

  /** The server-side half of the third consent. Off until something turns it on. */
  backupEnabled = false;
  readonly backups: FakeBackup[] = [];
  readonly restores: FakeRestore[] = [];

  private readonly devices: Device[] = [];
  private readonly options: Required<FakeServerOptions>;

  constructor(options: FakeServerOptions) {
    this.options = {
      maxBatchSize: 25,
      maxPullLimit: 500,
      defaultPullLimit: 200,
      maxSnapshotPageSize: 500,
      protocol: { min: 1, max: 1 },
      ...options,
    };
  }

  /** Register a device and its bearer. The real service does this at `connect`. */
  enroll(deviceId: string, token: string): void {
    this.devices.push({ deviceId, token });
  }

  /**
   * Revoke a device, the way `cloud devices revoke` does.
   *
   * Effective on that device's very next request, and reported as `revoked`
   * rather than `auth` — the Worker looks the row up WITHOUT filtering on
   * `revoked_at` precisely so it can tell a revoked device from an unknown one.
   */
  revoke(deviceId: string): void {
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId);
    if (device) device.revoked = true;
  }

  /**
   * The server's clock, and the only clock any expiry in this fixture comes
   * from. Tests move it to make a lease expire; they never move the client's.
   */
  now = (): number => Date.now();

  /** Every lease the service currently holds, for assertions. */
  readonly leases = new Map<string, StoredLease>();

  /** Per-repository, monotonic, never reused — including across a takeover. */
  private lastFencingToken = 0;

  /** Bump the epoch the way a restore does: NON-truncating. The old ops stay. */
  bumpEpoch(): void {
    this.epoch += 1;
  }

  /** The `fetchImpl` the client is given. */
  get fetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const method = init?.method ?? "GET";
      const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
      const route = `${method} ${url.pathname.replace(/\/v1\/repos\/[^/]+/, "/v1/repos/:id")}`;
      this.calls.push(route);

      if (this.failNext && this.failNext.route === route && this.failNext.times > 0) {
        this.failNext.times -= 1;
        return this.json(this.failNext.status, {
          code: this.failNext.code,
          message: "transient",
        });
      }

      try {
        return await this.route(url, method, headers, init?.body);
      } catch (error) {
        if (error instanceof ServerError) {
          return this.json(error.status, {
            code: error.code,
            message: error.message,
            ...error.extra,
          });
        }
        throw error;
      }
    }) as typeof fetch;
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private async route(
    url: URL,
    method: string,
    headers: Headers,
    body: unknown,
  ): Promise<Response> {
    if (url.pathname === "/v1/capabilities") {
      return this.json(200, {
        protocol: this.options.protocol,
        maxBatchSize: this.options.maxBatchSize,
        maxOpBytes: 512 * 1024,
        maxPullLimit: this.options.maxPullLimit,
        defaultPullLimit: this.options.defaultPullLimit,
        maxSnapshotPageSize: this.options.maxSnapshotPageSize,
      });
    }

    const match = /^\/v1\/repos\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) throw new ServerError(404, "not_found", "no such route");

    const repoId = decodeURIComponent(match[1]!);
    const session = this.authenticate(repoId, headers);
    const tail = match[2] ?? "";

    if (tail === "/ops" && method === "POST") {
      return this.push(session, JSON.parse(String(body)) as Record<string, unknown>);
    }
    if (tail === "/ops" && method === "GET") return this.pull(session, url);
    if (tail === "/snapshot" && method === "GET") return this.snapshot(session, url);

    // Backup, restore and purge. Modelled on worker/src/backups.ts, including the
    // property that matters most: a restore MATERIALISES the backup into the new
    // epoch rather than only bumping it. A fake that merely bumped would let a
    // bump-only client pass, which is the one bug these tests exist to catch.
    if (tail === "/backup" && method === "PUT") {
      const parsed = JSON.parse(String(body)) as { enabled?: unknown };
      if (typeof parsed.enabled !== "boolean") {
        throw new ServerError(400, "validation", "enabled must be a boolean");
      }
      this.backupEnabled = parsed.enabled;
      return this.json(200, { protocol: 1, backupEnabled: this.backupEnabled });
    }
    if (tail === "/backups" && method === "POST") {
      this.assertBackupConsent();
      return this.json(200, { protocol: 1, backup: this.captureBackup(session.deviceId, "manual") });
    }
    if (tail === "/backups" && method === "GET") {
      this.assertBackupConsent();
      return this.json(200, {
        protocol: 1,
        epoch: this.epoch,
        backups: [...this.backups]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((backup) => this.describeBackup(backup)),
      });
    }
    const backupMatch = /^\/backups\/([^/]+)(\/restore)?$/.exec(tail);
    if (backupMatch && !backupMatch[2] && method === "DELETE") {
      this.assertBackupConsent();
      const id = decodeURIComponent(backupMatch[1]!);
      const index = this.backups.findIndex((backup) => backup.backupId === id);
      if (index < 0) throw new ServerError(404, "not_found", "no such backup");
      this.backups.splice(index, 1);
      return this.json(200, { protocol: 1, backupId: id, deleted: true });
    }
    if (backupMatch && backupMatch[2] && method === "POST") {
      this.assertBackupConsent();
      return this.restore(
        session,
        decodeURIComponent(backupMatch[1]!),
        JSON.parse(String(body)) as Record<string, unknown>,
      );
    }
    if (tail === "" && method === "DELETE") {
      this.ops.length = 0;
      this.backups.length = 0;
      this.restores.length = 0;
      this.devices.length = 0;
      return this.json(200, { protocol: 1, purged: true });
    }

    if (tail === "/devices" && method === "GET") {
      return this.json(200, {
        devices: this.devices.map((device) => ({
          deviceId: device.deviceId,
          label: null,
          createdAt: 0,
          lastSeenAt: null,
          revokedAt: null,
          self: device.deviceId === session.deviceId,
        })),
      });
    }
    const lease = /^\/leases(?:\/([^/]+))?(\/renew)?$/.exec(tail);
    if (lease) {
      const entityId = lease[1] ? decodeURIComponent(lease[1]) : null;
      const text = body === undefined || body === null ? "{}" : String(body);
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (entityId === null && method === "POST") return this.acquireLease(session, payload);
      if (entityId !== null && lease[2] && method === "POST") {
        return this.renewLease(session, entityId, payload);
      }
      if (entityId !== null && !lease[2] && method === "DELETE") {
        return this.releaseLease(session, entityId, payload);
      }
    }
    throw new ServerError(404, "not_found", "no such route");
  }

  /**
   * Membership is checked on EVERY request, not at connection time. `repoId`
   * comes from the path and the device from the credential; neither is ever taken
   * from a request body.
   */
  private authenticate(repoId: string, headers: Headers): { repoId: string; deviceId: string } {
    if (repoId !== this.options.repositoryId) {
      throw new ServerError(403, "forbidden", "not a member of this repository");
    }
    const auth = headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    const device = this.devices.find((candidate) => candidate.token === token);
    if (!device) throw new ServerError(401, "auth", "no such credential");
    if (device.revoked === true) {
      throw new ServerError(403, "revoked", "this device was revoked; re-connect required");
    }
    return { repoId, deviceId: device.deviceId };
  }

  // ----------------------------------------------------------------- leases

  private ttlOf(raw: unknown): number {
    if (raw === undefined || raw === null) return DEFAULT_LEASE_TTL_SECONDS;
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      throw new ServerError(400, "validation", "ttlSeconds must be an integer");
    }
    if (raw < 1 || raw > MAX_LEASE_TTL_SECONDS) {
      throw new ServerError(400, "validation", "ttlSeconds is outside the permitted range", {
        maxTtlSeconds: MAX_LEASE_TTL_SECONDS,
      });
    }
    return raw;
  }

  private leaseWire(lease: StoredLease): Record<string, unknown> {
    return {
      entityId: lease.entityId,
      fencingToken: lease.fencingToken,
      holder: lease.holder,
      deviceId: lease.deviceId,
      acquiredAt: lease.acquiredAt,
      renewedAt: lease.renewedAt,
      expiresAt: lease.expiresAt,
    };
  }

  /**
   * `POST /leases`. The token is allocated BEFORE the slot is contested, so it
   * increments even for the loser of a race — gaps are as legal as gaps in
   * `seq`, and reusing a number is the one thing fencing cannot survive.
   *
   * An expired lease on this entity is cleared lazily, by the acquire that wants
   * the slot. There is no sweeper here either.
   */
  private acquireLease(
    session: { deviceId: string },
    body: Record<string, unknown>,
  ): Response {
    const entityId = String(body.entityId ?? "");
    const holder = String(body.holder ?? "");
    if (!entityId || !holder) {
      throw new ServerError(400, "validation", "entityId and holder must be non-empty strings");
    }
    const ttl = this.ttlOf(body.ttlSeconds);
    const now = this.now();
    this.lastFencingToken += 1;

    const existing = this.leases.get(entityId);
    if (existing && existing.expiresAt <= now) this.leases.delete(entityId);

    const live = this.leases.get(entityId);
    if (live) {
      throw new ServerError(409, "conflict", "lease is held by another device", {
        entityId,
        holder: live.holder,
        expiresAt: live.expiresAt,
      });
    }

    const lease: StoredLease = {
      entityId,
      fencingToken: this.lastFencingToken,
      holder,
      deviceId: session.deviceId,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: now + ttl * 1000,
    };
    this.leases.set(entityId, lease);
    return this.json(200, { protocol: 1, lease: this.leaseWire(lease) });
  }

  /**
   * `POST /leases/{entityId}/renew`. One predicate covers every way a renewal
   * can be illegitimate — wrong token, wrong device, or already expired.
   */
  private renewLease(
    session: { deviceId: string },
    entityId: string,
    body: Record<string, unknown>,
  ): Response {
    const fencingToken = body.fencingToken;
    if (typeof fencingToken !== "number" || !Number.isInteger(fencingToken)) {
      throw new ServerError(400, "validation", "fencingToken must be an integer");
    }
    const ttl = this.ttlOf(body.ttlSeconds);
    const now = this.now();
    const lease = this.leases.get(entityId);

    if (
      !lease ||
      lease.fencingToken !== fencingToken ||
      lease.deviceId !== session.deviceId ||
      lease.expiresAt <= now
    ) {
      throw new ServerError(409, "conflict", "lease is not held with that fencing token", {
        entityId,
        ...(lease ? { currentFencingToken: lease.fencingToken } : {}),
      });
    }

    lease.renewedAt = now;
    lease.expiresAt = now + ttl * 1000;
    return this.json(200, { protocol: 1, lease: this.leaseWire(lease) });
  }

  /** `DELETE /leases/{entityId}`, presenting the token. */
  private releaseLease(
    session: { deviceId: string },
    entityId: string,
    body: Record<string, unknown>,
  ): Response {
    const fencingToken = body.fencingToken;
    if (typeof fencingToken !== "number" || !Number.isInteger(fencingToken)) {
      throw new ServerError(400, "validation", "fencingToken must be an integer");
    }
    const lease = this.leases.get(entityId);
    if (!lease || lease.fencingToken !== fencingToken || lease.deviceId !== session.deviceId) {
      throw new ServerError(409, "conflict", "lease is not held with that fencing token", {
        entityId,
      });
    }
    this.leases.delete(entityId);
    return this.json(200, { protocol: 1, released: true, entityId });
  }

  // ------------------------------------------------------------------- push

  private push(
    session: { repoId: string; deviceId: string },
    body: Record<string, unknown>,
  ): Response {
    if (!Array.isArray(body.ops)) throw new ServerError(400, "validation", "ops must be an array");
    if (body.ops.length > this.options.maxBatchSize) {
      throw new ServerError(413, "payload_too_large", "batch exceeds the advertised maximum", {
        maxBatchSize: this.options.maxBatchSize,
      });
    }
    if (typeof body.epoch === "number" && body.epoch !== this.epoch) {
      throw new ServerError(409, "epoch_changed", "epoch has moved; re-bootstrap", {
        currentEpoch: this.epoch,
        epoch: this.epoch,
      });
    }

    // Validated WHOLE, before a single row is written.
    const ops = body.ops.map((raw, index) => this.validate(raw, index, session));

    if (ops.length === 0) {
      return this.json(200, {
        protocol: 1,
        epoch: this.epoch,
        serverHighWatermark: this.lastSeq,
        results: [],
      });
    }

    /**
     * Slots are reserved for the whole batch first. A duplicate's slot is then
     * never used, which is where the legal gaps in `seq` come from — the single
     * most important property of this fake, because a client that quietly assumes
     * density passes against a dense fake and corrupts a real repository.
     */
    const priorHigh = this.lastSeq;
    this.lastSeq += ops.length;

    const now = Date.now();
    const results = ops.map((op, index) => {
      const existing = this.ops.find(
        (stored) => stored.epoch === this.epoch && stored.opId === op.opId,
      );
      if (existing) {
        // The seq of the ORIGINAL application. `duplicate` is a success.
        return { opId: op.opId, status: "duplicate" as const, seq: existing.seq };
      }
      const seq = priorHigh + index + 1;
      this.ops.push({ ...op, seq, epoch: this.epoch, deviceId: session.deviceId, serverTs: now });
      return { opId: op.opId, status: "applied" as const, seq };
    });

    return this.json(200, {
      protocol: 1,
      epoch: this.epoch,
      serverHighWatermark: priorHigh + ops.length,
      results,
    });
  }

  private validate(
    raw: unknown,
    index: number,
    session: { repoId: string; deviceId: string },
  ): Omit<StoredOp, "seq" | "epoch" | "serverTs"> {
    const at = `ops[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ServerError(400, "validation", `${at} is not an object`);
    }
    const op = raw as Record<string, unknown>;
    const str = (value: unknown, field: string): string => {
      if (typeof value !== "string") {
        throw new ServerError(400, "validation", `${at}.${field} must be a string`);
      }
      return value;
    };
    const int = (value: unknown, field: string): number => {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new ServerError(400, "validation", `${at}.${field} must be an integer`);
      }
      return value;
    };

    if (str(op.repoId, "repoId") !== session.repoId) {
      throw new ServerError(403, "forbidden", `${at}.repoId does not match the credential`);
    }
    if (str(op.deviceId, "deviceId") !== session.deviceId) {
      throw new ServerError(403, "forbidden", `${at}.deviceId does not match the credential`);
    }
    const entity = str(op.entity, "entity");
    if (!ENTITIES.has(entity)) {
      throw new ServerError(400, "validation", `${at}.entity is not a known entity`);
    }
    const verb = str(op.verb, "verb");
    if (!VERBS.has(verb)) throw new ServerError(400, "validation", `${at}.verb is not a known verb`);
    if (verb === "replace" && entity !== "queue" && entity !== "milestone") {
      throw new ServerError(
        400,
        "validation",
        `${at}.verb 'replace' is only for ordered collections`,
      );
    }
    if (verb === "renumber" && entity !== "issue") {
      throw new ServerError(400, "validation", `${at}.verb 'renumber' is only for issues`);
    }

    let baseVersion: number | null = null;
    if (op.baseVersion !== null && op.baseVersion !== undefined) {
      baseVersion = int(op.baseVersion, "baseVersion");
    } else if (verb !== "create") {
      throw new ServerError(400, "validation", `${at}.baseVersion is required for '${verb}'`);
    }

    if (op.payload === null || typeof op.payload !== "object") {
      throw new ServerError(400, "validation", `${at}.payload must be an object or an array`);
    }

    return {
      opId: str(op.opId, "opId"),
      deviceId: str(op.deviceId, "deviceId"),
      entity,
      entityId: str(op.entityId, "entityId"),
      verb,
      baseVersion,
      payload: op.payload,
      actor: str(op.actor, "actor"),
      clientSeq: int(op.clientSeq, "clientSeq"),
      schema: int(op.schema, "schema"),
      createdAt: str(op.createdAt, "createdAt"),
    };
  }

  // ------------------------------------------------------------------- pull

  private pull(session: { repoId: string; deviceId: string }, url: URL): Response {
    const limit = this.limit(url, this.options.defaultPullLimit, this.options.maxPullLimit);
    const raw = url.searchParams.get("cursor");
    let after = 0;
    if (raw) {
      const cursor = this.decodeCursor(raw);
      this.assertScope(cursor, session.repoId);
      after = Number(cursor.s ?? 0);
    }

    const eligible = this.ops
      .filter((op) => op.epoch === this.epoch && op.seq > after)
      .sort((a, b) => a.seq - b.seq);
    const hasMore = eligible.length > limit;
    const rows = eligible.slice(0, limit);
    // The cursor advances to the last seq RETURNED, never to the watermark.
    const lastSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : after;

    return this.json(200, {
      protocol: 1,
      epoch: this.epoch,
      serverHighWatermark: this.lastSeq,
      ops: rows.map((op) => ({ ...op, protocol: 1 })),
      nextCursor: b64url(JSON.stringify({ v: 1, r: session.repoId, e: this.epoch, s: lastSeq })),
      hasMore,
    });
  }

  // --------------------------------------------------------------- snapshot

  private snapshot(session: { repoId: string; deviceId: string }, url: URL): Response {
    const limit = this.limit(url, 200, this.options.maxSnapshotPageSize);
    const raw = url.searchParams.get("cursor");
    let cutoff: number;
    let afterKey = "";
    if (raw) {
      const cursor = this.decodeCursor(raw);
      this.assertScope(cursor, session.repoId);
      // Pinned in the cursor: every page of one snapshot folds to the same seq.
      cutoff = Number(cursor.c ?? 0);
      afterKey = String(cursor.k ?? "");
    } else {
      cutoff = this.lastSeq;
    }

    const folded = new Map<
      string,
      {
        entity: string;
        entityId: string;
        version: number;
        deletedAt: number | null;
        lastSeq: number;
        /** True when the last surviving write was a `replace`. Mirrors `worker/src/fold.ts`. */
        superseded: boolean;
        state: Record<string, unknown>;
      }
    >();

    for (const op of this.ops
      .filter((candidate) => candidate.epoch === this.epoch && candidate.seq <= cutoff)
      .sort((a, b) => a.seq - b.seq)) {
      const key = `${op.entity} ${op.entityId}`;
      let entry = folded.get(key);
      if (!entry) {
        entry = {
          entity: op.entity,
          entityId: op.entityId,
          version: 0,
          deletedAt: null,
          lastSeq: op.seq,
          superseded: false,
          state: {},
        };
        folded.set(key, entry);
      }
      entry.version += 1;
      entry.lastSeq = op.seq;
      if (op.verb === "delete") {
        entry.deletedAt = op.serverTs;
        continue;
      }
      if (entry.deletedAt !== null) continue;
      if (op.verb === "replace") {
        entry.state = { replaced: op.payload } as Record<string, unknown>;
        entry.superseded = true;
      } else if (op.payload !== null && typeof op.payload === "object" && !Array.isArray(op.payload)) {
        Object.assign(entry.state, op.payload as Record<string, unknown>);
        entry.superseded = false;
      }
    }

    const ordered = [...folded.values()].sort((a, b) =>
      `${a.entity} ${a.entityId}` < `${b.entity} ${b.entityId}` ? -1 : 1,
    );
    const remaining = ordered.filter((entry) => `${entry.entity} ${entry.entityId}` > afterKey);
    const hasMore = remaining.length > limit;
    const page = remaining.slice(0, limit);
    const lastKey =
      page.length > 0
        ? `${page[page.length - 1]!.entity} ${page[page.length - 1]!.entityId}`
        : afterKey;

    return this.json(200, {
      protocol: 1,
      epoch: this.epoch,
      cutoffSeq: cutoff,
      tailCursor: b64url(JSON.stringify({ v: 1, r: session.repoId, e: this.epoch, s: cutoff })),
      /**
       * `{ replaced: … }` is how a fold represents a superseded ordered collection to
       * itself, and it does not cross the wire — the real route unwraps it here and
       * carries the verb instead (`worker/src/snapshot.ts::toWireEntity`). This fixture
       * has to do the same or an end-to-end bootstrap test proves nothing about the
       * Worker it is standing in for.
       */
      entities: page.map((entry) => ({
        entity: entry.entity,
        entityId: entry.entityId,
        version: entry.version,
        deletedAt: entry.deletedAt,
        lastSeq: entry.lastSeq,
        verb: entry.deletedAt !== null ? "delete" : entry.superseded ? "replace" : "create",
        state: entry.superseded ? (entry.state.replaced as Record<string, unknown>) : entry.state,
      })),
      nextCursor: hasMore
        ? b64url(
            JSON.stringify({ v: 1, r: session.repoId, e: this.epoch, c: cutoff, k: lastKey }),
          )
        : null,
      hasMore,
    });
  }

  // --------------------------------------------------------- backup, restore

  private assertBackupConsent(): void {
    if (!this.backupEnabled) {
      throw new ServerError(403, "forbidden", "backup is not enabled for this repository");
    }
  }

  /** The same fold `snapshot` computes, plus the verb, pinned at the watermark. */
  private foldForBackup(): { entities: FoldedEntity[]; opCount: number; schemaVersion: number } {
    const folded = new Map<string, FoldedEntity>();
    let opCount = 0;
    let schemaVersion = 0;

    for (const op of this.ops
      .filter((candidate) => candidate.epoch === this.epoch && candidate.seq <= this.lastSeq)
      .sort((a, b) => a.seq - b.seq)) {
      opCount += 1;
      if (op.schema > schemaVersion) schemaVersion = op.schema;

      const key = `${op.entity} ${op.entityId}`;
      let entry = folded.get(key);
      if (!entry) {
        entry = {
          entity: op.entity,
          entityId: op.entityId,
          version: 0,
          deletedAt: null,
          lastSeq: op.seq,
          superseded: false,
          state: {},
        };
        folded.set(key, entry);
      }
      entry.version += 1;
      entry.lastSeq = op.seq;
      if (op.verb === "delete") {
        entry.deletedAt = op.serverTs;
        continue;
      }
      if (entry.deletedAt !== null) continue;
      if (op.verb === "replace") {
        entry.state = { replaced: op.payload } as Record<string, unknown>;
        entry.superseded = true;
      } else if (op.payload !== null && typeof op.payload === "object" && !Array.isArray(op.payload)) {
        Object.assign(entry.state, op.payload as Record<string, unknown>);
        entry.superseded = false;
      }
    }

    const entities = [...folded.values()].sort((a, b) =>
      `${a.entity} ${a.entityId}` < `${b.entity} ${b.entityId}` ? -1 : 1,
    );
    return { entities, opCount, schemaVersion };
  }

  private captureBackup(deviceId: string, kind: "manual" | "pre-restore"): Record<string, unknown> {
    const folded = this.foldForBackup();
    const backup: FakeBackup = {
      backupId: `backup-${this.backups.length + 1}`,
      epoch: this.epoch,
      cutoffSeq: this.lastSeq,
      entityCount: folded.entities.length,
      opCount: folded.opCount,
      schemaVersion: folded.schemaVersion,
      protocol: 1,
      kind,
      createdAt: Date.now() + this.backups.length,
      createdByDevice: deviceId,
      entities: folded.entities,
    };
    this.backups.push(backup);
    return this.describeBackup(backup);
  }

  private describeBackup(backup: FakeBackup): Record<string, unknown> {
    const { entities: _entities, ...metadata } = backup;
    return metadata;
  }

  /**
   * The resumable restore, with the property under test: it MATERIALISES.
   *
   * Staged operations are written with `epoch = toEpoch` while the server is still
   * on `fromEpoch`, so — exactly as in the real Worker — no pull and no snapshot
   * can see them until the flip, because both filter on the current epoch.
   */
  private restore(
    session: { repoId: string; deviceId: string },
    backupId: string,
    body: Record<string, unknown>,
  ): Response {
    if (body.confirm !== this.options.repositoryId) {
      throw new ServerError(400, "validation", "restore requires the repository id in `confirm`");
    }

    const backup = this.backups.find((candidate) => candidate.backupId === backupId);
    if (!backup) throw new ServerError(404, "not_found", "no such backup");

    let restore = this.restores.find((candidate) => candidate.restoreId === body.restoreId);
    if (body.restoreId === undefined) {
      if (this.restores.some((candidate) => candidate.status === "staging")) {
        throw new ServerError(409, "conflict", "a restore is already in flight");
      }
      const undo = this.captureBackup(session.deviceId, "pre-restore");
      restore = {
        restoreId: `restore-${this.restores.length + 1}`,
        backupId,
        preRestoreBackupId: String(undo.backupId),
        fromEpoch: this.epoch,
        toEpoch: this.epoch + 1,
        guardSeq: this.lastSeq,
        entityCount: backup.entityCount,
        staged: 0,
        status: "staging",
      };
      this.restores.push(restore);
      return this.json(200, {
        protocol: 1,
        restoreId: restore.restoreId,
        status: "staging",
        done: false,
        fromEpoch: restore.fromEpoch,
        toEpoch: restore.toEpoch,
        entityCount: restore.entityCount,
        staged: 0,
        preRestoreBackupId: restore.preRestoreBackupId,
      });
    }

    if (!restore) throw new ServerError(404, "not_found", "no such restore");
    if (restore.status === "committed") {
      return this.json(200, {
        protocol: 1,
        restoreId: restore.restoreId,
        status: "committed",
        done: true,
        epoch: restore.toEpoch,
        toEpoch: restore.toEpoch,
        entityCount: restore.entityCount,
        staged: restore.entityCount,
      });
    }

    if (restore.staged < restore.entityCount) {
      const chunk = backup.entities.slice(
        restore.staged,
        restore.staged + this.options.maxBatchSize,
      );
      for (const entity of chunk) {
        this.lastSeq += 1;
        const verb = entity.deletedAt !== null ? "delete" : entity.superseded ? "replace" : "create";
        const payload =
          entity.deletedAt !== null
            ? {}
            : entity.superseded
              ? (entity.state.replaced as Record<string, unknown>)
              : entity.state;
        this.ops.push({
          seq: this.lastSeq,
          epoch: restore.toEpoch,
          opId: `restore-${restore.restoreId}-${entity.entity} ${entity.entityId}`,
          deviceId: session.deviceId,
          entity: entity.entity,
          entityId: entity.entityId,
          verb,
          baseVersion: verb === "create" ? null : 0,
          payload,
          actor: `restore:${restore.restoreId}`,
          clientSeq: restore.staged + 1,
          schema: backup.schemaVersion,
          createdAt: new Date().toISOString(),
          serverTs: Date.now(),
        });
        restore.staged += 1;
      }
      return this.json(200, {
        protocol: 1,
        restoreId: restore.restoreId,
        status: "staging",
        done: false,
        fromEpoch: restore.fromEpoch,
        toEpoch: restore.toEpoch,
        entityCount: restore.entityCount,
        staged: restore.staged,
      });
    }

    // Commit. Refuse over work that landed in the old epoch after we began: it is
    // in neither the backup nor the pre-restore fold.
    const intruder = this.ops.find(
      (op) => op.epoch === restore.fromEpoch && op.seq > restore.guardSeq,
    );
    if (intruder) {
      throw new ServerError(409, "conflict", "operations landed after this restore began");
    }
    this.epoch = restore.toEpoch;
    restore.status = "committed";
    return this.json(200, {
      protocol: 1,
      restoreId: restore.restoreId,
      status: "committed",
      done: true,
      fromEpoch: restore.fromEpoch,
      toEpoch: restore.toEpoch,
      epoch: restore.toEpoch,
      entityCount: restore.entityCount,
      staged: restore.entityCount,
      preRestoreBackupId: restore.preRestoreBackupId,
    });
  }

  // ------------------------------------------------------------------ utils

  private limit(url: URL, fallback: number, max: number): number {
    const raw = url.searchParams.get("limit");
    if (!raw) return fallback;
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ServerError(400, "validation", "limit must be a positive integer");
    }
    if (limit > max) {
      throw new ServerError(413, "payload_too_large", "limit exceeds the documented maximum");
    }
    return limit;
  }

  private decodeCursor(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(unb64url(raw)) as unknown;
      if (parsed === null || typeof parsed !== "object") throw new Error("shape");
      return parsed as Record<string, unknown>;
    } catch {
      throw new ServerError(400, "cursor_invalid", "cursor is not decodable");
    }
  }

  /** Repository first, then epoch. A superseded epoch is never a silent reset. */
  private assertScope(cursor: Record<string, unknown>, repoId: string): void {
    if (cursor.r !== repoId) {
      throw new ServerError(400, "cursor_invalid", "cursor is from another repository");
    }
    if (cursor.e !== this.epoch) {
      throw new ServerError(409, "epoch_changed", "cursor is from a superseded epoch", {
        currentEpoch: this.epoch,
        epoch: this.epoch,
      });
    }
  }
}
