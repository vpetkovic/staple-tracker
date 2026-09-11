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
 *   - a purge needs the repository id typed back in its body, and is refused without
 *     it exactly as the Worker refuses it (`worker/test/purge-fixture.ts`)
 *   - a batch is validated whole and rejected whole; nothing is partially applied
 *   - the repository holds ONE vocabulary, claimed by its first push or restore, and
 *     the other is refused with the Worker's exact 409 (`worker/src/vocabulary.ts`)
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
/**
 * One field's provenance, as `worker/src/fold.ts::FieldWrite` computes it.
 *
 * Present only for keys a NON-CREATE operation carried, which is the whole of STA-263:
 * a create ships the entity's defaults too, and treating those as decisions would make
 * a later edit contest a value nobody chose.
 */
interface FieldWrite {
  baseVersion: number;
  opId: string;
  at: string;
}

/** A folded entity, as a backup stores it. `superseded` records the verb. */
interface FoldedEntity {
  entity: string;
  entityId: string;
  version: number;
  deletedAt: number | null;
  lastSeq: number;
  superseded: boolean;
  state: Record<string, unknown>;
  /** Stripped before a backup stores it, exactly as `fold.ts::forBackup` does. */
  fieldWrites: Record<string, FieldWrite>;
}

/**
 * What a backup stores — `worker/src/fold.ts::BackupEntity`.
 *
 * Without the provenance, because a restore materialises into a new epoch that restarts
 * entity versions and re-mints operation ids, so every number in `fieldWrites` would name
 * a timeline that no longer exists.
 */
type BackupEntity = Omit<FoldedEntity, "fieldWrites">;

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
  entities: BackupEntity[];
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
  /**
   * The repository's vocabulary as PROVISIONED — `repos.vocabulary`, migration 0005.
   * Omitted is `null`, an unclaimed repository whose first push claims it, which is what
   * a repository provisioned without the column set is on the real service.
   */
  vocabulary?: Vocabulary | null;
}

/** `worker/src/vocabulary.ts`: which vocabulary a repository's log holds. */
export type Vocabulary = "hub" | "workspace";

/**
 * The vocabulary, PER PROTOCOL VERSION — mirroring `worker/src/envelope.ts`.
 *
 * It used to be one flat set. It is protocol-scoped now for the same reason the real
 * Worker's is: `registration` and `crossLink` (STA-283) cannot be handed to a client
 * that would throw on them, and `src/core/cloud/apply.ts` throws on an entity it does
 * not know. A fake that accepted them at any protocol would let a client that forgot
 * to declare 2 pass here and be refused by the deployed service — which is exactly
 * the class of divergence this fixture exists to prevent.
 */
const ENTITIES_BY_PROTOCOL: ReadonlyArray<readonly [number, ReadonlySet<string>]> = [
  [
    1,
    new Set([
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
    ]),
  ],
  [2, new Set(["registration", "crossLink"])],
];
const REGISTRY_ENTITIES = new Set(["registration", "crossLink"]);
const VERBS = new Set(["create", "update", "delete", "replace", "renumber"]);

/** The lowest protocol admitting this entity, or null. Mirrors `minProtocolFor`. */
function minProtocolFor(entity: string): number | null {
  for (const [protocol, entities] of ENTITIES_BY_PROTOCOL) {
    if (entities.has(entity)) return protocol;
  }
  return null;
}

/** The vocabulary one entity belongs to — `worker/src/vocabulary.ts::vocabularyOf`. */
function vocabularyOf(entity: string): Vocabulary {
  return REGISTRY_ENTITIES.has(entity) ? "hub" : "workspace";
}

/**
 * The other vocabulary, refused — `worker/src/vocabulary.ts::vocabularyRefusal`, byte for
 * byte: 409 `conflict`, not retryable, and the same two detail keys. The wording is pinned
 * against `worker/test/vocabulary-fixture.ts`, which the Worker's own suite reads too.
 */
function vocabularyRefusal(repository: Vocabulary, request: Vocabulary): ServerError {
  const message =
    repository === "workspace"
      ? "this repository holds workspace data; the hub registry needs its own repository."
      : "this repository holds a hub registry; workspace data needs its own repository.";
  return new ServerError(409, "conflict", `${message} Nothing was written.`, {
    retryable: false,
    repositoryVocabulary: repository,
    requestVocabulary: request,
  });
}

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

  /**
   * `repos.vocabulary` (migration 0005): null until the first push or restore claims it,
   * and never changed afterwards. Public so a test can read what was claimed.
   */
  vocabulary: Vocabulary | null;

  private readonly devices: Device[] = [];
  private readonly options: Required<FakeServerOptions>;

  constructor(options: FakeServerOptions) {
    this.options = {
      maxBatchSize: 25,
      maxPullLimit: 500,
      defaultPullLimit: 200,
      maxSnapshotPageSize: 500,
      // Matches `worker/src/limits.ts`. `min` did not move with `max`, which is what
      // keeps every protocol-1 client working.
      protocol: { min: 1, max: 2 },
      vocabulary: null,
      ...options,
    };
    this.vocabulary = this.options.vocabulary;
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

  /**
   * A 200 whose body's `protocol` is the version THIS REQUEST negotiated.
   *
   * Every success in this fixture goes through here, so `protocol` can only come from
   * `negotiate()`. It used to be the literal `1` in fourteen bodies — `pull` and
   * `snapshot` were threaded and nothing else was — so a protocol-2 registry push got
   * `{"protocol":1}` back from the fake while the deployed Worker echoes 2, and every
   * lease, backup, restore and consent response said 1 whatever the client asked for.
   * The Worker's handlers take `protocol` as a parameter and put it in the body
   * (`worker/src/leases.ts`, `worker/src/backups.ts`, `worker/src/devices.ts`); this is
   * the same thing in one place, so a fifteenth route cannot be given a literal without
   * going out of its way.
   *
   * `GET /v1/capabilities` is deliberately NOT routed through here: its `protocol` is
   * the supported RANGE object rather than a negotiated version, exactly as
   * `worker/src/limits.ts::capabilities` builds it.
   */
  private ok(protocol: number, body: Record<string, unknown>): Response {
    return this.json(200, { protocol, ...body });
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
    /**
     * Protocol BEFORE credential, matching `worker/src/index.ts`'s stated order:
     * *"TLS -> protocol -> route -> body size -> authenticate"*. The fake authenticated
     * first, which `worker/test/limits.test.ts` pins the opposite of on purpose — *"refuses
     * an unsupported version before authentication, so it is not an auth oracle"*.
     */
    const protocol = this.negotiate(headers);
    const session = this.authenticate(repoId, headers);
    const tail = match[2] ?? "";

    if (tail === "/ops" && method === "POST") {
      return this.push(session, JSON.parse(String(body)) as Record<string, unknown>, protocol);
    }
    if (tail === "/ops" && method === "GET") return this.pull(session, url, protocol);
    if (tail === "/snapshot" && method === "GET") return this.snapshot(session, url, protocol);

    // Backup, restore and purge. Modelled on worker/src/backups.ts, including the
    // property that matters most: a restore MATERIALISES the backup into the new
    // epoch rather than only bumping it. A fake that merely bumped would let a
    // bump-only client pass, which is the one bug these tests exist to catch. And a
    // purge is refused without its typed confirmation, as the Worker refuses it.
    if (tail === "/backup" && method === "PUT") {
      const parsed = JSON.parse(String(body)) as { enabled?: unknown };
      if (typeof parsed.enabled !== "boolean") {
        throw new ServerError(400, "validation", "enabled must be a boolean");
      }
      this.backupEnabled = parsed.enabled;
      return this.ok(protocol, { backupEnabled: this.backupEnabled });
    }
    if (tail === "/backups" && method === "POST") {
      this.assertBackupConsent();
      return this.ok(protocol, { backup: this.captureBackup(session.deviceId, "manual") });
    }
    if (tail === "/backups" && method === "GET") {
      this.assertBackupConsent();
      return this.ok(protocol, {
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
      return this.ok(protocol, { backupId: id, deleted: true });
    }
    if (backupMatch && backupMatch[2] && method === "POST") {
      this.assertBackupConsent();
      return this.restore(
        session,
        decodeURIComponent(backupMatch[1]!),
        JSON.parse(String(body)) as Record<string, unknown>,
        protocol,
      );
    }
    if (tail === "" && method === "DELETE") {
      this.assertPurgeConfirmed(session, body);
      this.ops.length = 0;
      this.backups.length = 0;
      this.restores.length = 0;
      // The Worker deletes `leases` too, and the fake used to leave them standing.
      this.leases.clear();
      this.devices.length = 0;
      // The Worker deletes the `repos` row itself, vocabulary and all.
      this.vocabulary = null;
      return this.ok(protocol, { purged: true });
    }

    if (tail === "/devices" && method === "GET") {
      // `protocol` was absent from this body entirely, while `worker/src/devices.ts`
      // sends it like every other route.
      return this.ok(protocol, {
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
      if (entityId === null && method === "POST") {
        return this.acquireLease(session, payload, protocol);
      }
      if (entityId !== null && lease[2] && method === "POST") {
        return this.renewLease(session, entityId, payload, protocol);
      }
      if (entityId !== null && !lease[2] && method === "DELETE") {
        return this.releaseLease(session, entityId, payload, protocol);
      }
    }
    throw new ServerError(404, "not_found", "no such route");
  }

  /**
   * Membership is checked on EVERY request, not at connection time. `repoId`
   * comes from the path and the device from the credential; neither is ever taken
   * from a request body.
   */
  /**
   * The negotiated protocol, from `Staple-Protocol` — `worker/src/http.ts`.
   *
   * A missing header is the MINIMUM, not the maximum, so that a client which has not
   * yet learned the range is not silently given the newest vocabulary.
   */
  private negotiate(headers: Headers): number {
    const raw = headers.get("staple-protocol");
    if (raw === null) return this.options.protocol.min;
    const protocol = Number(raw);
    if (!Number.isInteger(protocol)) {
      throw new ServerError(400, "validation", "Staple-Protocol must be an integer", {
        min: this.options.protocol.min,
        max: this.options.protocol.max,
      });
    }
    if (protocol < this.options.protocol.min || protocol > this.options.protocol.max) {
      throw new ServerError(
        426,
        "protocol_unsupported",
        `protocol ${protocol} is outside the supported range`,
        { min: this.options.protocol.min, max: this.options.protocol.max },
      );
    }
    return protocol;
  }

  /**
   * Refuse to hand a caller an entity its protocol does not admit — the read-side
   * half of the gate, mirroring `assertServable` in `worker/src/pull.ts`.
   *
   * Filtering instead would be worse than serving: a filtered page still advances the
   * cursor, so the operation would be skipped for ever rather than deferred.
   */
  private assertServable(entities: readonly { entity: string }[], protocol: number): void {
    for (const row of entities) {
      const required = minProtocolFor(row.entity);
      if (required !== null && required > protocol) {
        throw new ServerError(
          426,
          "protocol_unsupported",
          "this log contains operations that require a newer protocol than this request negotiated",
          {
            min: this.options.protocol.min,
            max: this.options.protocol.max,
            requiredProtocol: required,
            entity: row.entity,
          },
        );
      }
    }
  }

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
    protocol: number,
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
    return this.ok(protocol, { lease: this.leaseWire(lease) });
  }

  /**
   * `POST /leases/{entityId}/renew`. One predicate covers every way a renewal
   * can be illegitimate — wrong token, wrong device, or already expired.
   */
  private renewLease(
    session: { deviceId: string },
    entityId: string,
    body: Record<string, unknown>,
    protocol: number,
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
    return this.ok(protocol, { lease: this.leaseWire(lease) });
  }

  /** `DELETE /leases/{entityId}`, presenting the token. */
  private releaseLease(
    session: { deviceId: string },
    entityId: string,
    body: Record<string, unknown>,
    protocol: number,
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
    return this.ok(protocol, { released: true, entityId });
  }

  // ------------------------------------------------------------------- push

  private push(
    session: { repoId: string; deviceId: string },
    body: Record<string, unknown>,
    protocol: number,
  ): Response {
    if (!Array.isArray(body.ops)) throw new ServerError(400, "validation", "ops must be an array");
    if (body.ops.length > this.options.maxBatchSize) {
      throw new ServerError(413, "payload_too_large", "batch exceeds the advertised maximum", {
        maxBatchSize: this.options.maxBatchSize,
      });
    }
    /**
     * The epoch fence is an INTEGER when present. `worker/src/push.ts` runs it through
     * `intOrThrow`, so `null` and `"1"` are both `validation` there — and the fake ignored
     * anything that was not already a number, so a client sending either passed here.
     */
    if (body.epoch !== undefined) {
      if (typeof body.epoch !== "number" || !Number.isInteger(body.epoch)) {
        throw new ServerError(400, "validation", "epoch must be an integer");
      }
    }
    if (typeof body.epoch === "number" && body.epoch !== this.epoch) {
      /**
       * `currentEpoch` ONLY. The Worker sends exactly that field
       * (`worker/src/push.ts`), and this fake used to send `epoch` alongside it — which is
       * the literal anti-pattern `worker/test/registry-fixture.ts` names: *"a fixture
       * answering with both field names while the real service sent one."* A client reading
       * the wrong one worked here and failed in production.
       */
      throw new ServerError(409, "epoch_changed", "epoch has moved; re-bootstrap", {
        currentEpoch: this.epoch,
      });
    }

    // Validated WHOLE, before a single row is written.
    const ops = body.ops.map((raw, index) => this.validate(raw, index, session, protocol));

    /**
     * A batch may not mix the registry vocabulary with the workspace one — mirroring
     * `worker/src/push.ts`. A hub's log holds only registry entities and a workspace's
     * holds only the others, so a mixed batch is always a bug.
     */
    const registryCount = ops.filter((op) => REGISTRY_ENTITIES.has(op.entity)).length;
    if (registryCount > 0 && registryCount < ops.length) {
      throw new ServerError(
        400,
        "validation",
        "a batch may not mix hub registry entities with workspace entities",
      );
    }

    /**
     * A repeated `opId` within one batch is refused, not absorbed — mirroring
     * `worker/src/push.ts`.
     *
     * This is the one worth having most. The fake answers a duplicate with the ORIGINAL
     * seq and `status: "duplicate"`, which is the exact presentation of both operation-id
     * bugs in `hub-registry-service.ts`: accepted, acknowledged, never applied. A
     * regression that reintroduced a colliding id inside one batch would have looked like
     * success here and been a 400 in production.
     */
    const seenIds = new Set<string>();
    for (const [index, op] of ops.entries()) {
      if (seenIds.has(op.opId)) {
        throw new ServerError(
          400,
          "validation",
          `ops[${index}].opId is repeated within this batch`,
        );
      }
      seenIds.add(op.opId);
    }

    if (ops.length === 0) {
      return this.ok(protocol, {
        epoch: this.epoch,
        serverHighWatermark: this.lastSeq,
        results: [],
      });
    }

    /**
     * The repository holds ONE vocabulary — `worker/src/push.ts`, STA-290. The first
     * non-empty push claims it; after that the other vocabulary is refused before any
     * slot is reserved or any row written. Without this the fake accepted a registry
     * push into a workspace repository, which the deployed Worker refuses: a fake more
     * permissive than the service, in the one dimension this rule exists for.
     *
     * The Worker decides a race between two first pushes inside one D1 batch. This fake
     * is single-threaded and each push runs to completion, so check-then-claim here has
     * the same outcome the batch guarantees: exactly one claim.
     */
    const offered = vocabularyOf(ops[0]!.entity);
    if (this.vocabulary !== null && this.vocabulary !== offered) {
      throw vocabularyRefusal(this.vocabulary, offered);
    }
    this.vocabulary = offered;

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

    return this.ok(protocol, {
      epoch: this.epoch,
      serverHighWatermark: priorHigh + ops.length,
      results,
    });
  }

  private validate(
    raw: unknown,
    index: number,
    session: { repoId: string; deviceId: string },
    protocol: number,
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
    /**
     * `op.protocol` must equal the request header's — `worker/src/envelope.ts` refuses a
     * mismatch as `validation`, and the fake never checked it at all.
     *
     * This is the one envelope field the whole registry leg hangs on: `pushOperations` sets
     * the body's `protocol` and the header from the same value precisely because the Worker
     * requires them to agree. Unmirrored, a client that overrode one and not the other
     * passed every test here and was refused by the deployed service.
     */
    const opProtocol = int(op.protocol, "protocol");
    if (opProtocol !== protocol) {
      throw new ServerError(
        400,
        "validation",
        `${at}.protocol disagrees with the request header`,
      );
    }

    const entity = str(op.entity, "entity");
    const entityProtocol = minProtocolFor(entity);
    if (entityProtocol === null) {
      throw new ServerError(400, "validation", `${at}.entity is not a known entity`);
    }
    if (entityProtocol > protocol) {
      throw new ServerError(
        426,
        "protocol_unsupported",
        `${at}.entity requires a newer protocol than this request negotiated`,
        {
          min: this.options.protocol.min,
          max: this.options.protocol.max,
          requiredProtocol: entityProtocol,
        },
      );
    }
    const verb = str(op.verb, "verb");
    if (!VERBS.has(verb)) throw new ServerError(400, "validation", `${at}.verb is not a known verb`);
    /**
     * The registry entities BY NAME, and FIRST — the order `worker/src/envelope.ts` uses.
     *
     * This check used to sit after the two allowlist checks below, which refuse these
     * entities anyway because neither name appears in either list. So the by-name branch
     * never ran, and the message a client actually saw was always "is only for ordered
     * collections". Ordered first, the specific message is the one that appears, which is
     * the point: a registry entity is not an ordered collection that happens to be missing
     * from a list, and telling somebody it is sends them looking in the wrong place.
     *
     * `test/cloud-hub-registry-wire.test.ts` asserts on that specific message for both
     * entities and both verbs, so the ordering is pinned rather than merely written down.
     */
    if (REGISTRY_ENTITIES.has(entity) && (verb === "replace" || verb === "renumber")) {
      throw new ServerError(
        400,
        "validation",
        `${at}.verb '${verb}' is never valid for a registry entity`,
      );
    }
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
    /**
     * `delete` too — mirroring `worker/src/envelope.ts`.
     *
     * A tombstone on a content-derived key can never be undone, so retraction is a field.
     * Un-mirrored, a regression emitting `verb: "delete"` instead of `present: false` went
     * GREEN here and 400'd the whole batch in production.
     */
    if (REGISTRY_ENTITIES.has(entity) && verb === "delete") {
      throw new ServerError(
        400,
        "validation",
        `${at}.verb 'delete' is never valid for a registry entity — a retraction is a field`,
      );
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
    /**
     * The per-operation cap, ENFORCED — it was advertised by `/v1/capabilities` and never
     * checked, so a 700 KiB operation applied here and 413s against the Worker.
     */
    const payloadBytes = Buffer.byteLength(JSON.stringify(op.payload), "utf8");
    if (payloadBytes > 512 * 1024) {
      throw new ServerError(413, "payload_too_large", `${at}.payload exceeds the documented cap`, {
        maxBytes: 512 * 1024,
        bytes: payloadBytes,
      });
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

  private pull(
    session: { repoId: string; deviceId: string },
    url: URL,
    protocol: number,
  ): Response {
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

    this.assertServable(rows, protocol);

    return this.ok(protocol, {
      epoch: this.epoch,
      serverHighWatermark: this.lastSeq,
      // The version this REQUEST negotiated, not a constant — `worker/src/pull.ts`.
      ops: rows.map((op) => ({ ...op, protocol })),
      nextCursor: b64url(JSON.stringify({ v: 1, r: session.repoId, e: this.epoch, s: lastSeq })),
      hasMore,
    });
  }

  // --------------------------------------------------------------- snapshot

  private snapshot(
    session: { repoId: string; deviceId: string },
    url: URL,
    protocol: number,
  ): Response {
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

    const ordered = this.fold(cutoff).entities;
    // Over the WHOLE fold, not the page: a snapshot is one view across several pages,
    // and refusing halfway leaves a device holding a partial hydration.
    this.assertServable(ordered, protocol);
    const remaining = ordered.filter((entry) => `${entry.entity} ${entry.entityId}` > afterKey);
    const hasMore = remaining.length > limit;
    const page = remaining.slice(0, limit);
    const lastKey =
      page.length > 0
        ? `${page[page.length - 1]!.entity} ${page[page.length - 1]!.entityId}`
        : afterKey;

    return this.ok(protocol, {
      epoch: this.epoch,
      cutoffSeq: cutoff,
      tailCursor: b64url(JSON.stringify({ v: 1, r: session.repoId, e: this.epoch, s: cutoff })),
      /**
       * The state as the fold holds it, and the VERB carried separately — the shape the
       * real route emits (`worker/src/snapshot.ts::toWireEntity`). There is no unwrapping
       * step on either side since STA-259, because a `replace` no longer supersedes the
       * whole entity and so has nothing to be held apart from. This fixture has to agree
       * with the Worker it stands in for or an end-to-end bootstrap test proves nothing.
       */
      entities: page.map((entry) => ({
        entity: entry.entity,
        entityId: entry.entityId,
        version: entry.version,
        deletedAt: entry.deletedAt,
        lastSeq: entry.lastSeq,
        verb: entry.deletedAt !== null ? "delete" : entry.superseded ? "replace" : "create",
        state: entry.state,
        /**
         * A sibling of `state`, never derived from it (STA-263). The keys NOT here are
         * the ones only a `create` carried — the entity's defaults — and a device that
         * treated those as decisions would contest values nobody chose. A BACKUP gets
         * the opposite treatment: `worker/src/fold.ts::forBackup` strips this, because
         * a restore re-mints the very versions and operation ids it names.
         */
        fieldWrites: entry.fieldWrites,
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

  /**
   * `worker/src/fold.ts::foldLog`, reproduced.
   *
   * ONE fold, called by both the snapshot route and the backup capture, because the
   * Worker has one and *"a backup computed by a different rule from the one
   * `GET /snapshot` uses would restore into an epoch that hydrates differently from the
   * way it was captured"*. This fixture used to hold two copies of it, and a fixture
   * that disagrees with itself cannot prove the two halves of a bootstrap agree.
   */
  private fold(cutoff: number): {
    entities: FoldedEntity[];
    opCount: number;
    schemaVersion: number;
  } {
    const folded = new Map<string, FoldedEntity>();
    let opCount = 0;
    let schemaVersion = 0;

    for (const op of this.ops
      .filter((candidate) => candidate.epoch === this.epoch && candidate.seq <= cutoff)
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
          fieldWrites: {},
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
      if (op.payload === null || typeof op.payload !== "object" || Array.isArray(op.payload)) {
        continue;
      }
      // Every verb merges the keys it carried and is silent about the rest; only the
      // record of the verb differs. Mirrors `worker/src/fold.ts` (STA-259).
      Object.assign(entry.state, op.payload as Record<string, unknown>);
      entry.superseded = op.verb === "replace";

      // And the provenance, for every verb but `create` — the line `Journal.flush`
      // already draws, and what keeps an entity's defaults from looking chosen
      // (STA-263). `version` is already incremented, so `- 1` is the version moved off.
      if (op.verb !== "create") {
        for (const field of Object.keys(op.payload as Record<string, unknown>)) {
          entry.fieldWrites[field] = {
            baseVersion: entry.version - 1,
            opId: op.opId,
            at: op.createdAt,
          };
        }
      }
    }

    const entities = [...folded.values()].sort((a, b) =>
      `${a.entity} ${a.entityId}` < `${b.entity} ${b.entityId}` ? -1 : 1,
    );
    return { entities, opCount, schemaVersion };
  }

  private captureBackup(deviceId: string, kind: "manual" | "pre-restore"): Record<string, unknown> {
    const folded = this.fold(this.lastSeq);
    const backup: FakeBackup = {
      backupId: `backup-${this.backups.length + 1}`,
      epoch: this.epoch,
      cutoffSeq: this.lastSeq,
      entityCount: folded.entities.length,
      opCount: folded.opCount,
      schemaVersion: folded.schemaVersion,
      /**
       * The lowest protocol that can REPLAY this backup, mirroring
       * `worker/src/backups.ts`'s `protocolForEntities`. Hardcoding 1 made every hub
       * backup in the client suite claim protocol 1 while the deployed Worker stamps 2 —
       * the fixture being MORE permissive than the service, which is the one thing it
       * exists not to be.
       */
      protocol: folded.entities.some((entity) => REGISTRY_ENTITIES.has(entity.entity)) ? 2 : 1,
      kind,
      createdAt: Date.now() + this.backups.length,
      createdByDevice: deviceId,
      // `worker/src/fold.ts::forBackup` — the fold minus this epoch's provenance,
      // which a restore into a new epoch could only misdescribe.
      entities: folded.entities.map(({ fieldWrites: _provenance, ...rest }) => rest),
    };
    this.backups.push(backup);
    return this.describeBackup(backup);
  }

  private describeBackup(backup: FakeBackup): Record<string, unknown> {
    const { entities: _entities, ...metadata } = backup;
    return metadata;
  }

  /**
   * The purge's typed confirmation — `worker/src/backups.ts::purgeRepository` (STA-256).
   *
   * The fake used to purge on a bare DELETE, exactly as the Worker did, so every client
   * test of purge proved a request the product promised to refuse. Now both refuse it
   * with the bodies `worker/test/purge-fixture.ts` pins for the two of them: no body, an
   * empty body or no `confirm` is `missing` (the request every earlier client sends), and
   * anything but the credential's repository id is `mismatch`. Nothing is deleted.
   */
  private assertPurgeConfirmed(session: { repoId: string }, raw: unknown): void {
    let confirm: unknown = undefined;
    if (raw !== undefined && raw !== null && String(raw).length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        throw new ServerError(400, "validation", "request body is not valid JSON");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ServerError(400, "validation", "request body must be a JSON object");
      }
      confirm = (parsed as Record<string, unknown>).confirm;
    }
    if (confirm === undefined) {
      throw new ServerError(
        400,
        "validation",
        "purge refused: the request carried no typed confirmation, and this service requires " +
          "the repository id in `confirm`. Nothing was deleted. Update staple, then run " +
          "`staple cloud purge --confirm <repositoryId>` again.",
        { retryable: false, confirmation: "missing" },
      );
    }
    if (confirm !== session.repoId) {
      throw new ServerError(
        400,
        "validation",
        "purge refused: `confirm` does not match this repository's id. Nothing was deleted.",
        { retryable: false, confirmation: "mismatch" },
      );
    }
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
    protocol: number,
  ): Response {
    if (body.confirm !== this.options.repositoryId) {
      throw new ServerError(400, "validation", "restore requires the repository id in `confirm`");
    }

    const backup = this.backups.find((candidate) => candidate.backupId === backupId);
    if (!backup) throw new ServerError(404, "not_found", "no such backup");

    /**
     * Mirrors `worker/src/backups.ts`: a backup the REQUEST's protocol cannot read is
     * refused before the undo is captured and before anything is staged.
     *
     * This was missing, so a protocol-1 restore of a protocol-2 hub backup passed here
     * and was 426'd by the deployed Worker. Nothing bit only because `restoreRegistry`
     * happens to pass `REGISTRY_PROTOCOL` on every call — which is exactly the kind of
     * accident a fixture is supposed to catch rather than depend on.
     */
    if (backup.protocol > protocol) {
      throw new ServerError(
        426,
        "protocol_unsupported",
        "this backup contains operations this request's protocol cannot read",
        {
          min: this.options.protocol.min,
          max: this.options.protocol.max,
          requiredProtocol: backup.protocol,
        },
      );
    }

    let restore = this.restores.find((candidate) => candidate.restoreId === body.restoreId);
    if (body.restoreId === undefined) {
      if (this.restores.some((candidate) => candidate.status === "staging")) {
        throw new ServerError(409, "conflict", "a restore is already in flight");
      }
      this.claimForRestore(backup);
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
      return this.ok(protocol, {
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
      return this.ok(protocol, {
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
      // Asked again on every stage turn, as `worker/src/backups.ts::stageRestore` does.
      this.claimForRestore(backup);
      const chunk = backup.entities.slice(
        restore.staged,
        restore.staged + this.options.maxBatchSize,
      );
      for (const entity of chunk) {
        this.lastSeq += 1;
        // `worker/src/fold.ts::materializedVerb`: the whole state under the recorded verb,
        // except a tombstone, which materialises bare because the corpse is a state
        // nothing reads.
        const verb = entity.deletedAt !== null ? "delete" : entity.superseded ? "replace" : "create";
        const payload = entity.deletedAt !== null ? {} : entity.state;
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
      return this.ok(protocol, {
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
    return this.ok(protocol, {
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

  /**
   * A restore obeys the repository's vocabulary — `worker/src/backups.ts`,
   * `assertRestorableVocabulary`, decided at BEGIN before the undo is captured:
   * a backup holding both vocabularies is refused; a backup of the other vocabulary is
   * refused; an unclaimed repository is claimed for the backup's; an empty backup claims
   * nothing.
   */
  private claimForRestore(backup: FakeBackup): void {
    const total = backup.entities.length;
    if (total === 0) return;
    const registry = backup.entities.filter((entity) => REGISTRY_ENTITIES.has(entity.entity))
      .length;
    if (registry > 0 && registry < total) {
      throw new ServerError(
        409,
        "conflict",
        "this backup holds both hub registry and workspace entities, so restoring it would " +
          "put both into one repository. It was captured before this service kept the two " +
          "apart. Nothing was changed.",
        { retryable: false, requestVocabulary: "mixed" },
      );
    }
    const offered: Vocabulary = registry === total ? "hub" : "workspace";
    if (this.vocabulary !== null && this.vocabulary !== offered) {
      throw vocabularyRefusal(this.vocabulary, offered);
    }
    this.vocabulary = offered;
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
      // `currentEpoch` only — the push path was fixed and this one was missed. The Worker
      // sends exactly one field; sending both lets a client read the wrong name and pass.
      throw new ServerError(409, "epoch_changed", "cursor is from a superseded epoch", {
        currentEpoch: this.epoch,
      });
    }
  }
}
