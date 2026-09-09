import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEVICE,
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
