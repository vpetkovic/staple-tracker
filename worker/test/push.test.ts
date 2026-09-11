import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEVICE,
  ORIGIN,
  OTHER_REPO,
  REPO,
  bumpEpoch,
  call,
  envelope,
  expectError,
  jsonOf,
  pushOps,
  seedRepo,
} from "./helpers.js";
import { EMITTED_PAYLOADS } from "./emitted-payloads.js";
import { payloadRefusal } from "./payload-fixture.js";

let token: string;

beforeEach(async () => {
  token = await seedRepo();
});

describe("POST /v1/repos/{repoId}/ops — sequence assignment", () => {
  it("assigns strictly increasing sequence numbers within a repository", async () => {
    const response = await pushOps(
      [envelope({ clientSeq: 1 }), envelope({ clientSeq: 2 }), envelope({ clientSeq: 3 })],
      { token },
    );
    expect(response.status).toBe(200);

    const body = await jsonOf(response);
    const seqs = body.results.map((r: any) => r.seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(body.serverHighWatermark).toBe(3);
    expect(body.results.every((r: any) => r.status === "applied")).toBe(true);
  });

  it("continues the sequence across separate pushes, never restarting", async () => {
    await pushOps([envelope({ clientSeq: 1 }), envelope({ clientSeq: 2 })], { token });
    const second = await pushOps([envelope({ clientSeq: 3 })], { token });

    const body = await jsonOf(second);
    expect(body.results[0].seq).toBe(3);
    expect(body.serverHighWatermark).toBe(3);
  });

  it("never recomputes the high-water mark from MAX(seq), so deletion cannot rewind it", async () => {
    await pushOps([envelope({ clientSeq: 1 }), envelope({ clientSeq: 2 })], { token });

    // Simulate compaction removing the newest row. `repos.last_seq` is an independent
    // counter, so the next assignment must still be 3 — if it were derived from
    // MAX(ops.seq) it would be 2 and would collide with a seq a client already holds.
    await env.DB.prepare(`DELETE FROM ops WHERE repo_id = ?1 AND seq = 2`).bind(REPO).run();

    const response = await pushOps([envelope({ clientSeq: 3 })], { token });
    expect((await jsonOf(response)).results[0].seq).toBe(3);
  });

  it("assigns disjoint sequence numbers under concurrent pushes", async () => {
    // The reservation is one UPDATE inside an atomic batch, and D1 processes queries
    // one at a time, so two concurrent pushes cannot reserve the same window. This is
    // the property that would otherwise need a Durable Object in front.
    const responses = await Promise.all([
      pushOps([envelope({ clientSeq: 1 }), envelope({ clientSeq: 2 })], { token }),
      pushOps([envelope({ clientSeq: 3 }), envelope({ clientSeq: 4 })], { token }),
      pushOps([envelope({ clientSeq: 5 }), envelope({ clientSeq: 6 })], { token }),
    ]);

    for (const response of responses) expect(response.status).toBe(200);
    const seqs = (await Promise.all(responses.map(jsonOf)))
      .flatMap((b: any) => b.results.map((r: any) => r.seq))
      .sort((a, b) => a - b);

    expect(new Set(seqs).size).toBe(6);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("is atomic: one invalid operation writes none of the batch", async () => {
    const response = await pushOps(
      [envelope({ clientSeq: 1 }), envelope({ clientSeq: 2, verb: "not-a-verb" })],
      { token },
    );
    await expectError(response, "validation", 400);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ n: number }>();
    expect(count!.n).toBe(0);

    // And the watermark did not move, so the reservation rolled back with everything
    // else. A client retrying the corrected batch gets seq 1.
    const repo = await env.DB.prepare(`SELECT last_seq FROM repos WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ last_seq: number }>();
    expect(repo!.last_seq).toBe(0);
  });

  it("accepts an empty batch as a no-op", async () => {
    const response = await pushOps([], { token });
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body.results).toEqual([]);
    expect(body.serverHighWatermark).toBe(0);
  });
});

describe("POST /v1/repos/{repoId}/ops — idempotency", () => {
  it("deduplicates a replayed batch and returns the ORIGINAL seq for each duplicate", async () => {
    const ops = [envelope({ clientSeq: 1 }), envelope({ clientSeq: 2 })];

    const first = await jsonOf(await pushOps(ops, { token }));
    expect(first.results.map((r: any) => r.status)).toEqual(["applied", "applied"]);

    // The client lost the acknowledgement and retried the identical batch. `opId` is
    // deterministic, so the ids are byte-identical and the unique index absorbs them.
    const replay = await jsonOf(await pushOps(ops, { token }));
    expect(replay.results.map((r: any) => r.status)).toEqual(["duplicate", "duplicate"]);

    // This is the whole point of the field: the seq of the ORIGINAL application, not a
    // new one, so a client that lost an acknowledgement reconciles without re-deriving
    // anything. `duplicate` is a success, not an error.
    expect(replay.results.map((r: any) => r.seq)).toEqual(first.results.map((r: any) => r.seq));
    expect(replay.results[0].seq).toBe(1);
  });

  it("writes no second row for a replayed operation", async () => {
    const ops = [envelope({ clientSeq: 1 })];
    await pushOps(ops, { token });
    await pushOps(ops, { token });
    await pushOps(ops, { token });

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("leaves a GAP when part of a batch deduplicates — strictly increasing, not dense", async () => {
    await pushOps([envelope({ clientSeq: 1 })], { token }); // seq 1

    // A batch mixing one already-applied operation with two new ones. Slots are
    // reserved for the whole batch before the rows are written, so the duplicate's
    // reserved slot goes unused.
    const mixed = await jsonOf(
      await pushOps(
        [envelope({ clientSeq: 2 }), envelope({ clientSeq: 1 }), envelope({ clientSeq: 3 })],
        { token },
      ),
    );

    expect(mixed.results.map((r: any) => r.status)).toEqual(["applied", "duplicate", "applied"]);
    // Slots 2, 3, 4 were reserved. The duplicate held slot 3 and never used it.
    expect(mixed.results[0].seq).toBe(2);
    expect(mixed.results[1].seq).toBe(1); // its ORIGINAL seq
    expect(mixed.results[2].seq).toBe(4); // note: not 3

    // The watermark counts reserved slots, not written rows. A client must never
    // derive a count from a range, and must never assert next == last + 1.
    expect(mixed.serverHighWatermark).toBe(4);

    const stored = await env.DB.prepare(
      `SELECT seq FROM ops WHERE repo_id = ?1 ORDER BY seq`,
    )
      .bind(REPO)
      .all<{ seq: number }>();
    expect(stored.results.map((r) => r.seq)).toEqual([1, 2, 4]);
  });

  it("rejects a batch that repeats an opId within itself", async () => {
    const response = await pushOps([envelope({ clientSeq: 1 }), envelope({ clientSeq: 1 })], {
      token,
    });
    await expectError(response, "validation", 400);
  });
});

describe("POST /v1/repos/{repoId}/ops — epoch scoping", () => {
  it("scopes deduplication by epoch, so a restored client is not silently absorbed", async () => {
    // THE DEFECT THIS GUARDS. `opId` derives from (repoId, epoch, deviceId, clientSeq).
    // `deviceId` lives in machine config and survives a client-side database rebuild;
    // `clientSeq` lives only in the workspace database, which a re-bootstrap rebuilds
    // from zero. An epoch bump forces exactly that re-bootstrap and is non-truncating,
    // so the pre-restore operations are still here.
    //
    // If the unique index were on (repo_id, op_id) alone, an older client that got the
    // derivation wrong would re-mint ids matching its own pre-restore work, the dedupe
    // would absorb genuinely new operations as duplicates, and the response would hand
    // back the ORIGINAL seq — which the client reads as an acknowledgement. Silent
    // data loss, in the exact path the epoch mechanism exists to make safe.
    const original = await jsonOf(await pushOps([envelope({ clientSeq: 1 })], { token }));
    expect(original.results[0].status).toBe("applied");

    await bumpEpoch();

    // Same opId, new epoch. It must be treated as NEW work, not as a duplicate.
    const afterRestore = await jsonOf(await pushOps([envelope({ clientSeq: 1 })], { token }));
    expect(afterRestore.results[0].status).toBe("applied");
    expect(afterRestore.epoch).toBe(2);

    // Both rows exist, in different epochs. The old one was not overwritten — the
    // epoch bump is non-truncating and seq keeps climbing.
    const rows = await env.DB.prepare(
      `SELECT epoch, seq FROM ops WHERE repo_id = ?1 AND op_id = 'op-1' ORDER BY epoch`,
    )
      .bind(REPO)
      .all<{ epoch: number; seq: number }>();
    expect(rows.results).toEqual([
      { epoch: 1, seq: 1 },
      { epoch: 2, seq: 2 },
    ]);
  });

  it("still refuses a true duplicate within one epoch after a restore", async () => {
    await bumpEpoch();
    const ops = [envelope({ clientSeq: 9 })];
    expect((await jsonOf(await pushOps(ops, { token }))).results[0].status).toBe("applied");
    expect((await jsonOf(await pushOps(ops, { token }))).results[0].status).toBe("duplicate");
  });

  it("rejects a push whose claimed epoch is stale, without writing anything", async () => {
    await bumpEpoch(); // repository is now epoch 2

    const response = await call(`/v1/repos/${REPO}/ops`, {
      method: "POST",
      token,
      body: { protocol: 1, deviceId: DEVICE, epoch: 1, ops: [envelope({ clientSeq: 1 })] },
    });

    const body = await expectError(response, "epoch_changed", 409);
    expect(body.currentEpoch).toBe(2);
    expect(body.mustRebootstrap).toBe(true);
    expect(body.retryable).toBe(false);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("binds the epoch from the repository row, never from the request body", async () => {
    // A body claiming a future epoch cannot cause a write stamped with it.
    const response = await call(`/v1/repos/${REPO}/ops`, {
      method: "POST",
      token,
      body: { protocol: 1, deviceId: DEVICE, epoch: 99, ops: [envelope({ clientSeq: 1 })] },
    });
    await expectError(response, "epoch_changed", 409);
  });
});

describe("POST /v1/repos/{repoId}/ops — the epoch fence is an integer or absent", () => {
  /**
   * `push.ts` runs `body.epoch` through `intOrThrow`, which demands BOTH
   * `typeof value === "number"` and `Number.isInteger(value)`. Every other test in this
   * file fences on a whole number, so a guard that had decayed to the type half alone
   * would still pass all of them: a fractional or infinite fence would sail past it and
   * be compared against the repository's epoch instead of being refused.
   *
   * Which is why every case here asserts the code and the status TOGETHER. The two
   * outcomes are distinguishable in the response and only in the response: a refused
   * fence is `validation`/400, raised before a statement is prepared, while a fence that
   * reached the comparison is `epoch_changed`/409.
   */

  /** The op count for the repository, to show a refusal wrote nothing. */
  async function opCount(): Promise<number> {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ n: number }>();
    return row!.n;
  }

  /** A push whose body is raw bytes rather than an object the `call` helper stringifies. */
  async function pushRawBody(raw: string): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/v1/repos/${REPO}/ops`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Staple-Protocol": "1",
        "Staple-Device": DEVICE,
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(raw).length),
      },
      body: raw,
    });
  }

  /** A push fencing on `value`, exactly as a client's `JSON.stringify` would send it. */
  async function pushFencedOn(value: unknown): Promise<Response> {
    return call(`/v1/repos/${REPO}/ops`, {
      method: "POST",
      token,
      body: { protocol: 1, deviceId: DEVICE, epoch: value, ops: [envelope({ clientSeq: 1 })] },
    });
  }

  it("refuses a fractional epoch instead of comparing it", async () => {
    const body = await expectError(await pushFencedOn(1.5), "validation", 400);
    expect(body.message).toBe("epoch must be an integer");
    expect(body.retryable).toBe(false);
    expect(await opCount()).toBe(0);
  });

  it("refuses a numeric string, because the fence is a number and not its spelling", async () => {
    // `"1"` is the shape a client that read the epoch out of a URL or an env var sends,
    // and it is the one a loose `==` comparison would have accepted.
    const body = await expectError(await pushFencedOn("1"), "validation", 400);
    expect(body.message).toBe("epoch must be an integer");
    expect(await opCount()).toBe(0);
  });

  it("refuses an explicit null, which is not the same as omitting the field", async () => {
    const body = await expectError(await pushFencedOn(null), "validation", 400);
    expect(body.message).toBe("epoch must be an integer");
    expect(await opCount()).toBe(0);
  });

  it("refuses NaN in the form it can actually arrive in, which is `null`", async () => {
    // JSON has no NaN, so there is no such thing as a request body carrying one. What a
    // real client produces is `null` — asserted here rather than assumed, because the
    // whole point of this case is what reaches the handler and not what the caller wrote.
    expect(JSON.stringify({ epoch: NaN })).toBe('{"epoch":null}');
    const body = await expectError(await pushFencedOn(NaN), "validation", 400);
    expect(body.message).toBe("epoch must be an integer");
    expect(await opCount()).toBe(0);
  });

  it("refuses a body with a bare NaN token, which is not JSON at all", async () => {
    // The other way a client could try: hand-built JSON. It never reaches the epoch
    // guard, because `readJson` refuses the body first — worth pinning so the absence of
    // an `epoch must be an integer` message here is not read as a hole.
    const response = await pushRawBody(
      `{"protocol":1,"deviceId":"${DEVICE}","epoch":NaN,"ops":[]}`,
    );
    const body = await expectError(response, "validation", 400);
    expect(body.message).toBe("request body is not valid JSON");
    expect(await opCount()).toBe(0);
  });

  it("refuses Infinity, which arrives as a literal too large for a double", async () => {
    // `JSON.stringify(Infinity)` is `null`, so a client cannot serialise one — but
    // `JSON.parse` PRODUCES one from an overflowing literal, so a hand-built body can put
    // an actual `Infinity` in front of the guard. Asserted, again, rather than assumed.
    expect((JSON.parse('{"epoch":1e999}') as { epoch: number }).epoch).toBe(
      Number.POSITIVE_INFINITY,
    );

    const response = await pushRawBody(
      `{"protocol":1,"deviceId":"${DEVICE}","epoch":1e999,"ops":[${JSON.stringify(
        envelope({ clientSeq: 1 }),
      )}]}`,
    );
    const body = await expectError(response, "validation", 400);
    expect(body.message).toBe("epoch must be an integer");
    expect(await opCount()).toBe(0);
  });

  it("accepts a push that omits the epoch, because the fence is optional", async () => {
    // `undefined` is the ONE value that skips the check: the field is additive and
    // optional (`push.ts`), so a client that does not fence must not be refused. This is
    // the other half of the guard — without it, "refuse anything that is not an integer"
    // could be over-tightened into refusing the common case.
    const response = await pushOps([envelope({ clientSeq: 1 })], { token });
    expect(response.status).toBe(200);

    const body = await jsonOf(response);
    expect(body.epoch).toBe(1);
    expect(body.results[0].status).toBe("applied");
  });
});

describe("POST /v1/repos/{repoId}/ops — cross-repository rejection", () => {
  it("rejects an envelope whose repoId is not the credential's repository", async () => {
    await seedRepo(OTHER_REPO, "device-b");
    const response = await pushOps([envelope({ clientSeq: 1, repoId: OTHER_REPO })], { token });
    await expectError(response, "forbidden", 403);
  });

  it("rejects a path repoId that is not the credential's repository", async () => {
    await seedRepo(OTHER_REPO, "device-b");
    const response = await pushOps([envelope({ clientSeq: 1 })], { token, repoId: OTHER_REPO });
    await expectError(response, "forbidden", 403);
  });

  it("writes nothing to the other repository when a cross-repository push is refused", async () => {
    await seedRepo(OTHER_REPO, "device-b");
    await pushOps([envelope({ clientSeq: 1, repoId: OTHER_REPO })], { token });

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1`)
      .bind(OTHER_REPO)
      .first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("rejects an envelope claiming another device", async () => {
    const response = await pushOps([envelope({ clientSeq: 1, deviceId: "someone-else" })], {
      token,
    });
    await expectError(response, "forbidden", 403);
  });
});

describe("POST /v1/repos/{repoId}/ops — envelope validation", () => {
  it("stores the payload verbatim, preserving fields it has no knowledge of", async () => {
    // A device receiving an entity field it has no column for stores it verbatim and
    // re-emits it unchanged. This is what lets a fleet run mixed versions through a
    // schema upgrade without the older build silently deleting the newer one's data.
    const payload = { status: "done", aFieldFromTheFuture: { nested: [1, 2, 3] } };
    await pushOps([envelope({ clientSeq: 1, payload })], { token });

    const row = await env.DB.prepare(`SELECT payload FROM ops WHERE repo_id = ?1 AND seq = 1`)
      .bind(REPO)
      .first<{ payload: string }>();
    expect(JSON.parse(row!.payload)).toEqual(payload);
  });

  it("requires baseVersion for a non-create verb and allows it to be null on create", async () => {
    await expectError(
      await pushOps([envelope({ clientSeq: 1, verb: "update", baseVersion: null })], { token }),
      "validation",
      400,
    );
    const created = await pushOps(
      [envelope({ clientSeq: 2, verb: "create", baseVersion: null })],
      { token },
    );
    expect(created.status).toBe(200);
  });

  it("restricts 'replace' to ordered collections and 'renumber' to issues", async () => {
    await expectError(
      await pushOps([envelope({ clientSeq: 1, entity: "issue", verb: "replace" })], { token }),
      "validation",
      400,
    );
    await expectError(
      await pushOps([envelope({ clientSeq: 2, entity: "comment", verb: "renumber" })], { token }),
      "validation",
      400,
    );

    const queue = await pushOps(
      [
        envelope({
          clientSeq: 3,
          entity: "queue",
          verb: "replace",
          entityId: "queue",
          payload: { entries: ["a", "b"], baseRevision: 4 },
        }),
      ],
      { token },
    );
    expect(queue.status).toBe(200);
  });

  /**
   * STA-262. An array is `typeof "object"`, so it used to pass. It then took a sequence
   * number and folded into nothing — the fold merges a payload's keys and an array has
   * none — so it vanished from every snapshot and backup while the push said `applied`.
   * `replace` on the plan is the case the ticket names; the rule is the same for every
   * verb, because no emitter sends an array for any of them (see payload-fixture.ts).
   */
  it("refuses an array payload for every verb, and writes nothing and burns no seq", async () => {
    const arrays: Record<string, unknown>[] = [
      { entity: "queue", entityId: "queue", verb: "replace", payload: ["issue-1", "issue-2"] },
      { entity: "milestone", entityId: "m-1", verb: "replace", payload: [] },
      { entity: "issue", verb: "create", baseVersion: null, payload: [{ title: "t" }] },
      { entity: "issue", verb: "update", payload: ["status", "done"] },
      { entity: "issue", verb: "renumber", payload: ["TST-2"] },
      { entity: "issue", verb: "delete", payload: [] },
    ];
    for (const [index, shape] of arrays.entries()) {
      const response = await pushOps([envelope({ clientSeq: index + 1, ...shape })], { token });
      expect({ status: response.status, body: await response.json() }).toEqual(payloadRefusal(0));
    }

    const repo = await env.DB.prepare(`SELECT last_seq FROM repos WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ last_seq: number }>();
    const ops = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ n: number }>();
    expect({ lastSeq: repo!.last_seq, ops: ops!.n }).toEqual({ lastSeq: 0, ops: 0 });
  });

  it("names the offending operation, and refuses the whole batch around it", async () => {
    const response = await pushOps(
      [
        envelope({ clientSeq: 1, payload: { status: "done" } }),
        envelope({ clientSeq: 2, entity: "queue", entityId: "queue", verb: "replace", payload: ["a"] }),
      ],
      { token },
    );
    expect({ status: response.status, body: await response.json() }).toEqual(payloadRefusal(1));
    const ops = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ n: number }>();
    expect(ops!.n).toBe(0);
  });

  /**
   * The other half of STA-262: the refusal costs no legitimate emitter anything.
   *
   * `EMITTED_PAYLOADS` is one real payload per entity and verb the workspace client
   * sends, recorded by `test/cloud-emitter-payloads.test.ts` from the emitters themselves
   * and compared there on every run, so it is what the client sends today and not a
   * hand-written guess at it. Every one goes through the real route and is `applied`.
   */
  it("accepts every payload a real emitter sends, one per entity and verb", async () => {
    expect(EMITTED_PAYLOADS.length).toBeGreaterThanOrEqual(20);
    const device = "device-emitters";
    const own = await seedRepo(REPO, device);
    const ops = EMITTED_PAYLOADS.map((recorded, index) =>
      envelope({
        opId: `emitted-${index + 1}`,
        clientSeq: index + 1,
        deviceId: device,
        entity: recorded.entity,
        entityId: `${recorded.entity}-${index + 1}`,
        verb: recorded.verb,
        baseVersion: recorded.verb === "create" ? null : 1,
        payload: recorded.payload,
      }),
    );

    const statuses: string[] = [];
    for (let start = 0; start < ops.length; start += 20) {
      const response = await pushOps(ops.slice(start, start + 20), { token: own, device });
      expect(response.status).toBe(200);
      const body = await jsonOf<{ results: { status: string }[] }>(response);
      statuses.push(...body.results.map((result) => result.status));
    }
    expect(statuses).toEqual(EMITTED_PAYLOADS.map(() => "applied"));

    const stored = await env.DB.prepare(`SELECT payload FROM ops WHERE repo_id = ?1 ORDER BY seq`)
      .bind(REPO)
      .all<{ payload: string }>();
    expect(stored.results.map((row) => JSON.parse(row.payload))).toEqual(
      EMITTED_PAYLOADS.map((recorded) => recorded.payload),
    );
  });

  it("still refuses null and scalars, with the same sentence", async () => {
    for (const [index, payload] of [null, "a string", 7, true].entries()) {
      const response = await pushOps([envelope({ clientSeq: index + 1, payload })], { token });
      expect({ status: response.status, body: await response.json() }).toEqual(payloadRefusal(0));
    }
  });

  it("rejects an unknown entity", async () => {
    await expectError(
      await pushOps([envelope({ clientSeq: 1, entity: "hub" })], { token }),
      "validation",
      400,
    );
  });

  it("rejects a body that is not an object and an ops field that is not an array", async () => {
    await expectError(
      await call(`/v1/repos/${REPO}/ops`, { method: "POST", token, body: [1, 2] }),
      "validation",
      400,
    );
    await expectError(
      await call(`/v1/repos/${REPO}/ops`, {
        method: "POST",
        token,
        body: { protocol: 1, ops: "nope" },
      }),
      "validation",
      400,
    );
  });
});
