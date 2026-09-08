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
    return { repoId, deviceId: device.deviceId };
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
      } else if (op.payload !== null && typeof op.payload === "object" && !Array.isArray(op.payload)) {
        Object.assign(entry.state, op.payload as Record<string, unknown>);
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
      entities: page,
      nextCursor: hasMore
        ? b64url(
            JSON.stringify({ v: 1, r: session.repoId, e: this.epoch, c: cutoff, k: lastKey }),
          )
        : null,
      hasMore,
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
