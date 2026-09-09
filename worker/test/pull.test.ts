import { beforeEach, describe, expect, it } from "vitest";
import {
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

async function seedOps(count: number): Promise<void> {
  // Pushed in chunks under the advertised free-plan batch size of 25.
  for (let start = 1; start <= count; start += 20) {
    const ops = [];
    for (let i = start; i < Math.min(start + 20, count + 1); i += 1) {
      ops.push(envelope({ clientSeq: i, entityId: `issue-${i}` }));
    }
    const response = await pushOps(ops, { token });
    expect(response.status).toBe(200);
  }
}

describe("GET /v1/repos/{repoId}/ops — cursor pagination", () => {
  it("returns operations in ascending seq from the beginning when given no cursor", async () => {
    await seedOps(5);
    const body = await jsonOf(await call(`/v1/repos/${REPO}/ops`, { token }));

    expect(body.ops.map((o: any) => o.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(body.hasMore).toBe(false);
    expect(body.epoch).toBe(1);
  });

  it("bounds a page by limit and resumes exactly after the cursor", async () => {
    await seedOps(10);

    const first = await jsonOf(await call(`/v1/repos/${REPO}/ops?limit=4`, { token }));
    expect(first.ops.map((o: any) => o.seq)).toEqual([1, 2, 3, 4]);
    expect(first.hasMore).toBe(true);

    const second = await jsonOf(
      await call(`/v1/repos/${REPO}/ops?limit=4&cursor=${encodeURIComponent(first.nextCursor)}`, {
        token,
      }),
    );
    // Strictly after: 4 is not repeated.
    expect(second.ops.map((o: any) => o.seq)).toEqual([5, 6, 7, 8]);
    expect(second.hasMore).toBe(true);

    const third = await jsonOf(
      await call(`/v1/repos/${REPO}/ops?limit=4&cursor=${encodeURIComponent(second.nextCursor)}`, {
        token,
      }),
    );
    expect(third.ops.map((o: any) => o.seq)).toEqual([9, 10]);
    expect(third.hasMore).toBe(false);
  });

  it("walks the whole log without gaps or repeats across pages", async () => {
    await seedOps(23);

    const seen: number[] = [];
    let cursor = "";
    for (let page = 0; page < 20; page += 1) {
      const url = `/v1/repos/${REPO}/ops?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await jsonOf(await call(url, { token }));
      seen.push(...body.ops.map((o: any) => o.seq));
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }

    expect(seen).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  it("is gap-tolerant: a sequence gap is not the end of the log", async () => {
    await pushOps([envelope({ clientSeq: 1 })], { token }); // seq 1
    // Mixed batch leaves seq 3 reserved-but-unused.
    await pushOps(
      [envelope({ clientSeq: 2 }), envelope({ clientSeq: 1 }), envelope({ clientSeq: 3 })],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/ops`, { token }));
    // `WHERE seq > cursor` skips the hole without noticing it. A client must never
    // treat a gap as data loss, and must never derive a count from a range.
    expect(body.ops.map((o: any) => o.seq)).toEqual([1, 2, 4]);
    expect(body.hasMore).toBe(false);
  });

  it("returns an empty page and a stable cursor at the head of the log", async () => {
    await seedOps(2);
    const first = await jsonOf(await call(`/v1/repos/${REPO}/ops`, { token }));

    const caughtUp = await jsonOf(
      await call(`/v1/repos/${REPO}/ops?cursor=${encodeURIComponent(first.nextCursor)}`, { token }),
    );
    expect(caughtUp.ops).toEqual([]);
    expect(caughtUp.hasMore).toBe(false);
    // The cursor does not rewind when there is nothing new.
    expect(caughtUp.nextCursor).toBe(first.nextCursor);
  });

  it("round-trips the envelope, including a payload field the server knows nothing about", async () => {
    const payload = { title: "hello", somethingNew: { deep: true } };
    await pushOps([envelope({ clientSeq: 1, payload, verb: "create", baseVersion: null })], {
      token,
    });

    const body = await jsonOf(await call(`/v1/repos/${REPO}/ops`, { token }));
    expect(body.ops[0]).toMatchObject({
      opId: "op-1",
      entity: "issue",
      entityId: "issue-1",
      verb: "create",
      baseVersion: null,
      payload,
      actor: "opus-s4",
      clientSeq: 1,
      schema: 10,
      seq: 1,
      epoch: 1,
    });
  });
});

describe("GET /v1/repos/{repoId}/ops — cursor validation", () => {
  it("rejects an unparseable cursor", async () => {
    await expectError(
      await call(`/v1/repos/${REPO}/ops?cursor=not-a-cursor!!`, { token }),
      "cursor_invalid",
      400,
    );
  });

  it("rejects a cursor naming another repository", async () => {
    const forged = btoa(JSON.stringify({ v: 1, r: "someone-elses-repo", e: 1, s: 0 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expectError(
      await call(`/v1/repos/${REPO}/ops?cursor=${encodeURIComponent(forged)}`, { token }),
      "cursor_invalid",
      400,
    );
  });

  it("rejects a cursor from a superseded epoch with epoch_changed, never a silent reset", async () => {
    await seedOps(3);
    const before = await jsonOf(await call(`/v1/repos/${REPO}/ops`, { token }));

    await bumpEpoch();

    const response = await call(
      `/v1/repos/${REPO}/ops?cursor=${encodeURIComponent(before.nextCursor)}`,
      { token },
    );
    const body = await expectError(response, "epoch_changed", 409);
    expect(body.currentEpoch).toBe(2);
    expect(body.mustRebootstrap).toBe(true);
    // Not retryable: the device must re-bootstrap. A silent reset to the beginning
    // would replay the entire history into a live database.
    expect(body.retryable).toBe(false);
  });

  it("scopes results to the current epoch even for a cursor that named it", async () => {
    await seedOps(2); // epoch 1, seqs 1..2
    await bumpEpoch();
    await pushOps([envelope({ clientSeq: 50, entityId: "issue-new" })], { token }); // epoch 2

    const body = await jsonOf(await call(`/v1/repos/${REPO}/ops`, { token }));
    // The pre-restore rows are still stored — the epoch bump is non-truncating — but
    // they are not in this epoch's log.
    expect(body.ops.map((o: any) => o.epoch)).toEqual([2]);
    expect(body.ops.map((o: any) => o.entityId)).toEqual(["issue-new"]);
  });
});

describe("GET /v1/repos/{repoId}/ops — limit validation", () => {
  it("rejects a limit above the documented maximum rather than truncating silently", async () => {
    // A client that asked for 5,000 and quietly got 500 would conclude the log ended.
    const body = await expectError(
      await call(`/v1/repos/${REPO}/ops?limit=5000`, { token }),
      "payload_too_large",
      413,
    );
    expect(body.maxPullLimit).toBe(500);
  });

  it("rejects a non-positive or non-integer limit", async () => {
    await expectError(await call(`/v1/repos/${REPO}/ops?limit=0`, { token }), "validation", 400);
    await expectError(await call(`/v1/repos/${REPO}/ops?limit=abc`, { token }), "validation", 400);
  });
});
