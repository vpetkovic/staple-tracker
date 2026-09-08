import { beforeEach, describe, expect, it } from "vitest";
import { REPO, bumpEpoch, call, envelope, expectError, jsonOf, pushOps, seedRepo } from "./helpers.js";

let token: string;

beforeEach(async () => {
  token = await seedRepo();
});

describe("GET /v1/repos/{repoId}/snapshot", () => {
  it("folds the operation log into per-entity state", async () => {
    await pushOps(
      [
        envelope({
          clientSeq: 1,
          verb: "create",
          baseVersion: null,
          entityId: "issue-1",
          payload: { title: "first", status: "backlog" },
        }),
        envelope({ clientSeq: 2, entityId: "issue-1", payload: { status: "in_progress" } }),
        envelope({ clientSeq: 3, entityId: "issue-1", payload: { assignee: "opus-s4" } }),
      ],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    expect(body.entities).toHaveLength(1);

    const [entity] = body.entities;
    // Shallow field merge in seq order. Later writes win per FIELD; fields nobody
    // touched are untouched.
    expect(entity.state).toEqual({
      title: "first",
      status: "in_progress",
      assignee: "opus-s4",
    });
    expect(entity.version).toBe(3);
    expect(entity.lastSeq).toBe(3);
    expect(entity.deletedAt).toBeNull();
  });

  it("returns a tail cursor that resumes the pull exactly at the cutoff", async () => {
    await pushOps([envelope({ clientSeq: 1 }), envelope({ clientSeq: 2 })], { token });
    const snap = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    expect(snap.cutoffSeq).toBe(2);

    // Writes concurrent with the snapshot land in the tail, so nothing is missed and
    // nothing is applied twice.
    await pushOps([envelope({ clientSeq: 3, entityId: "issue-later" })], { token });

    const tail = await jsonOf(
      await call(`/v1/repos/${REPO}/ops?cursor=${encodeURIComponent(snap.tailCursor)}`, { token }),
    );
    expect(tail.ops.map((o: any) => o.seq)).toEqual([3]);
  });

  it("keeps a tombstone rather than omitting the entity", async () => {
    await pushOps(
      [
        envelope({ clientSeq: 1, verb: "create", baseVersion: null, payload: { title: "doomed" } }),
        envelope({ clientSeq: 2, verb: "delete", payload: {} }),
      ],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const [entity] = body.entities;
    // A device handed silence about a deleted entity cannot distinguish it from one it
    // has never heard of, and would resurrect it on its next push.
    expect(entity.deletedAt).not.toBeNull();
  });

  it("makes an update after a delete a no-op, not a resurrection", async () => {
    await pushOps(
      [
        envelope({ clientSeq: 1, verb: "create", baseVersion: null, payload: { title: "doomed" } }),
        envelope({ clientSeq: 2, verb: "delete", payload: {} }),
        envelope({ clientSeq: 3, payload: { title: "back from the dead" } }),
      ],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const [entity] = body.entities;
    // The tombstone wins regardless of arrival order, which is what makes convergence
    // order-independent.
    expect(entity.deletedAt).not.toBeNull();
    expect(entity.state.title).toBe("doomed");
  });

  it("supersedes rather than merges an ordered collection", async () => {
    await pushOps(
      [
        envelope({
          clientSeq: 1,
          entity: "queue",
          entityId: "queue",
          verb: "replace",
          payload: { entries: ["a", "b", "c"], baseRevision: 1 },
        }),
        envelope({
          clientSeq: 2,
          entity: "queue",
          entityId: "queue",
          verb: "replace",
          payload: { entries: ["c", "a"], baseRevision: 2 },
        }),
      ],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    // Merging two plans would invent an order neither human asked for.
    expect(body.entities[0].state.entries).toEqual(["c", "a"]);
    // And the verb the fold consumed travels, so the client does not have to guess
    // it back out of the shape of the state.
    expect(body.entities[0].verb).toBe("replace");
    // `{ replaced: … }` was fold-internal and no longer exists at all. It must not
    // reach a client under any circumstances.
    expect(body.entities[0].state.replaced).toBeUndefined();
  });

  /**
   * STA-259. The supersede above is right about the collection and used to be wrong
   * about everything else: it replaced the ENTITY, so it also discarded the fields the
   * operation had said nothing about.
   *
   * A milestone is the entity where that costs data, because it holds two facts that
   * travel as two different payload shapes against the same entity key — dates as
   * `update { targetDate, startDate }`, membership as `replace { members }`. Dated
   * Monday, re-membered Tuesday, folded to membership alone.
   */
  it("keeps the fields a `replace` never mentioned", async () => {
    await pushOps(
      [
        envelope({
          clientSeq: 1,
          entity: "milestone",
          entityId: "milestone-1",
          verb: "update",
          payload: { targetDate: "2026-12-24", startDate: "2026-10-01" },
        }),
        envelope({
          clientSeq: 2,
          entity: "milestone",
          entityId: "milestone-1",
          verb: "replace",
          payload: { members: ["b", "a"] },
        }),
      ],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    // The membership is superseded whole — and the dates, which that operation never
    // spoke about, are still here.
    expect(body.entities[0].state).toEqual({
      targetDate: "2026-12-24",
      startDate: "2026-10-01",
      members: ["b", "a"],
    });
    // The verb is still the one the fold consumed, and still carried rather than
    // inferred: with nothing wrapped, the shape of the state cannot reveal it.
    expect(body.entities[0].verb).toBe("replace");
  });

  /**
   * The other order, which failed differently and is the sharper proof.
   *
   * A later merge landed ON TOP of the fold's private `{ replaced: … }` wrapper, so the
   * wrapper itself crossed the wire — the exact thing the test above pins as
   * fold-internal — and the membership was invisible underneath it. One shape, two
   * symptoms; neither survives its removal.
   */
  it("keeps a superseded collection when an ordinary update follows it", async () => {
    await pushOps(
      [
        envelope({
          clientSeq: 1,
          entity: "milestone",
          entityId: "milestone-1",
          verb: "replace",
          payload: { members: ["b", "a"] },
        }),
        envelope({
          clientSeq: 2,
          entity: "milestone",
          entityId: "milestone-1",
          verb: "update",
          payload: { targetDate: "2026-12-24", startDate: "2026-10-01" },
        }),
      ],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    expect(body.entities[0].state).toEqual({
      members: ["b", "a"],
      targetDate: "2026-12-24",
      startDate: "2026-10-01",
    });
    expect(body.entities[0].state.replaced).toBeUndefined();
    // The last surviving write was the update, so this materialises as one — the verb
    // records what happened last, not which keys the state happens to hold.
    expect(body.entities[0].verb).toBe("create");
  });

  /**
   * STA-257. An ordered collection reaches a device by one of two routes — folded
   * into a snapshot, or replayed from the ordered tail — and it must look the same
   * either way. It did not: the fold wrapped a `replace` in `{ replaced: … }` and
   * dropped the verb, so the two halves of a bootstrap described the same plan in
   * two different shapes and the client had a handler for only one of them.
   *
   * Asserted at the wire rather than at its effect, because the effect can agree by
   * luck — a client that keys off the payload alone would pass a state comparison
   * while the shapes had already diverged again.
   */
  it("describes an ordered collection identically in the snapshot and in the tail", async () => {
    await pushOps(
      [
        envelope({
          clientSeq: 1,
          entity: "queue",
          entityId: "queue",
          verb: "replace",
          payload: { entries: ["a", "b", "c"], baseRevision: 1 },
        }),
      ],
      { token },
    );

    const snapshot = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const tail = await jsonOf(await call(`/v1/repos/${REPO}/ops`, { token }));

    const folded = snapshot.entities.find((e: any) => e.entity === "queue");
    const replayed = tail.ops.find((o: any) => o.entity === "queue");

    expect({ verb: folded.verb, payload: folded.state }).toEqual({
      verb: replayed.verb,
      payload: replayed.payload,
    });
  });

  it("separates entities that share an id across different entity types", async () => {
    await pushOps(
      [
        envelope({ clientSeq: 1, entity: "issue", entityId: "same-id", payload: { a: 1 } }),
        envelope({ clientSeq: 2, entity: "comment", entityId: "same-id", payload: { b: 2 } }),
      ],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    expect(body.entities).toHaveLength(2);
    expect(body.entities.map((e: any) => e.entity).sort()).toEqual(["comment", "issue"]);
  });
});

describe("GET /v1/repos/{repoId}/snapshot — paging", () => {
  it("pages by entity key against a cutoff pinned in the cursor", async () => {
    const ops = Array.from({ length: 20 }, (_, i) =>
      envelope({
        clientSeq: i + 1,
        entityId: `issue-${String(i).padStart(2, "0")}`,
        verb: "create",
        baseVersion: null,
        payload: { n: i },
      }),
    );
    await pushOps(ops, { token });

    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page += 1) {
      const url = `/v1/repos/${REPO}/snapshot?limit=6${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await jsonOf(await call(url, { token }));
      seen.push(...body.entities.map((e: any) => e.entityId));
      if (!body.hasMore) break;
      cursor = body.nextCursor;
    }

    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
  });

  it("pins the cutoff so a concurrent push cannot move it mid-bootstrap", async () => {
    await pushOps(
      Array.from({ length: 6 }, (_, i) =>
        envelope({ clientSeq: i + 1, entityId: `issue-${i}`, verb: "create", baseVersion: null }),
      ),
      { token },
    );

    const first = await jsonOf(await call(`/v1/repos/${REPO}/snapshot?limit=3`, { token }));
    expect(first.cutoffSeq).toBe(6);
    expect(first.hasMore).toBe(true);

    // A write lands between pages. It must not appear in this snapshot — it belongs to
    // the tail, and a snapshot that shifted mid-read would be one that never existed.
    await pushOps([envelope({ clientSeq: 7, entityId: "issue-late", verb: "create", baseVersion: null })], {
      token,
    });

    const second = await jsonOf(
      await call(`/v1/repos/${REPO}/snapshot?limit=3&cursor=${encodeURIComponent(first.nextCursor)}`, {
        token,
      }),
    );
    expect(second.cutoffSeq).toBe(6);
    const ids = [...first.entities, ...second.entities].map((e: any) => e.entityId);
    expect(ids).not.toContain("issue-late");
  });

  it("rejects a snapshot cursor from a superseded epoch", async () => {
    // Two entities against a page size of one, so there genuinely is a next cursor to
    // present after the epoch moves.
    await pushOps(
      [
        envelope({ clientSeq: 1, entityId: "issue-a" }),
        envelope({ clientSeq: 2, entityId: "issue-b" }),
      ],
      { token },
    );
    const first = await jsonOf(await call(`/v1/repos/${REPO}/snapshot?limit=1`, { token }));
    expect(first.nextCursor).toBeTruthy();
    await bumpEpoch();

    await expectError(
      await call(`/v1/repos/${REPO}/snapshot?cursor=${encodeURIComponent(first.nextCursor)}`, {
        token,
      }),
      "epoch_changed",
      409,
    );
  });

  it("scopes the fold to the current epoch", async () => {
    await pushOps([envelope({ clientSeq: 1, entityId: "old-issue" })], { token });
    await bumpEpoch();
    await pushOps([envelope({ clientSeq: 2, entityId: "new-issue" })], { token });

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    // The pre-restore rows are retained for forensics but are not this epoch's state.
    expect(body.entities.map((e: any) => e.entityId)).toEqual(["new-issue"]);
  });

  it("returns an empty snapshot for a repository with no operations", async () => {
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    expect(body.entities).toEqual([]);
    expect(body.cutoffSeq).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  it("rejects a page limit above the documented maximum", async () => {
    await expectError(
      await call(`/v1/repos/${REPO}/snapshot?limit=9000`, { token }),
      "payload_too_large",
      413,
    );
  });
});
