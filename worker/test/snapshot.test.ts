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

  /**
   * STA-263. The fold ships one value per field, which tells a hydrating device WHAT
   * it holds and nothing about who decided it. Detection asks the applying device
   * *"have I written this field since the version you claim as your base?"*, and a
   * device that bootstrapped could not answer for any field — so the next stale write
   * to an inherited value was taken in silence.
   *
   * These pin the answer at the wire, and the ABSENCES matter as much as the entries:
   * marking every field of the state as written at the snapshot's version would make a
   * later `priority` edit contest a `medium` nobody ever chose, which is worse than the
   * silence it replaces.
   */
  it("attributes each field to the newest operation that carried it", async () => {
    await pushOps(
      [
        envelope({
          clientSeq: 1,
          verb: "create",
          baseVersion: null,
          payload: { title: "first", status: "backlog", priority: "medium" },
        }),
        envelope({ clientSeq: 2, payload: { status: "in_progress" } }),
        envelope({ clientSeq: 3, payload: { status: "done", assignee: "opus-s4" } }),
      ],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const [entity] = body.entities;

    // `baseVersion` counts the operations folded AHEAD of the writer, which is the
    // number `sync_field_writes.base_version` holds for the same operation applied
    // from the ordered tail. `status` names its LAST writer, not its first.
    expect(entity.fieldWrites).toEqual({
      status: { baseVersion: 2, opId: "op-3", at: "2026-09-05T12:00:00.000Z", seq: 3 },
      assignee: { baseVersion: 2, opId: "op-3", at: "2026-09-05T12:00:00.000Z", seq: 3 },
    });
    // And the state still holds every field, including the ones with no provenance.
    expect(entity.state.title).toBe("first");
    expect(entity.state.priority).toBe("medium");
  });

  it("gives a field only the create carried no provenance at all", async () => {
    await pushOps(
      [
        envelope({
          clientSeq: 1,
          verb: "create",
          baseVersion: null,
          payload: { title: "first", priority: "medium" },
        }),
      ],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    // Not "priority: version 1". Empty. A create carries the entity's whole field
    // inventory, defaults included, and a default is not a decision anybody made —
    // `Journal.flush` skips creates for exactly this reason and so does this.
    expect(body.entities[0].fieldWrites).toEqual({});
    expect(body.entities[0].state.priority).toBe("medium");
  });

  it("attributes an ordered collection to the `replace` that last set it", async () => {
    await pushOps(
      [
        envelope({
          clientSeq: 1,
          entity: "milestone",
          entityId: "m-1",
          verb: "create",
          baseVersion: null,
          payload: { targetDate: "2026-12-24" },
        }),
        envelope({
          clientSeq: 2,
          entity: "milestone",
          entityId: "m-1",
          verb: "replace",
          payload: { members: ["b", "a"] },
        }),
      ],
      { token },
    );

    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    // The whole-plan pseudo-field gets ordinary provenance, so a bootstrapped device
    // defends a plan by naming the operation that made it rather than by falling back
    // to the version comparison alone.
    expect(body.entities[0].fieldWrites).toEqual({
      members: { baseVersion: 1, opId: "op-2", at: "2026-09-05T12:00:00.000Z", seq: 2 },
    });
    expect(body.entities[0].state.targetDate).toBe("2026-12-24");
  });

  it("keeps provenance out of the way of the shape a tail replay pins", async () => {
    await pushOps(
      [
        envelope({
          clientSeq: 1,
          entity: "queue",
          entityId: "queue",
          verb: "replace",
          payload: { entries: ["a", "b"], baseRevision: 1 },
        }),
      ],
      { token },
    );

    const snapshot = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const tail = await jsonOf(await call(`/v1/repos/${REPO}/ops`, { token }));
    const folded = snapshot.entities[0];

    // `fieldWrites` is a SIBLING of `state`, never a transformation of it. The STA-259
    // guarantee — a collection arrives identically whichever half of a bootstrap
    // carried it — is about `verb` and `state`, and neither moved.
    expect({ verb: folded.verb, payload: folded.state }).toEqual({
      verb: tail.ops[0].verb,
      payload: tail.ops[0].payload,
    });
    expect(Object.keys(folded.fieldWrites).sort()).toEqual(["baseRevision", "entries"]);
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

describe("the fold's record of each entity's create", () => {
  /**
   * A tombstone turns away every late update, and yields to a create: somebody deciding,
   * after the delete, that the entity exists again — a status removed and added back, a
   * setting reset and set. Final, the second create was dropped here and applied by every
   * client reading the tail, and the two halves of a bootstrap disagreed.
   */
  it("begins an entity again when a create follows its delete, and forgets the old one", async () => {
    await pushOps(
      [
        envelope({ clientSeq: 1, entity: "status", entityId: "qa", verb: "create", baseVersion: null, payload: { label: "QA", category: "review", note: "old" } }),
        envelope({ clientSeq: 2, entity: "status", entityId: "qa", verb: "update", baseVersion: 1, payload: { label: "QA!" } }),
        envelope({ clientSeq: 3, entity: "status", entityId: "qa", verb: "delete", baseVersion: 2, payload: {} }),
        envelope({ clientSeq: 4, entity: "status", entityId: "qa", verb: "update", baseVersion: 2, payload: { label: "late" } }),
        envelope({ clientSeq: 5, entity: "status", entityId: "qa", verb: "create", baseVersion: null, payload: { label: "Quality", category: "review" } }),
      ],
      { token },
    );
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const [entity] = body.entities;
    expect(entity.deletedAt).toBeNull();
    expect(entity.verb).toBe("create");
    // The new life only: not the old note, not the late label, no inherited provenance — and,
    // a status, not the built-in it may have been.
    expect(entity.state).toEqual({ label: "Quality", category: "review", isBuiltin: false });
    expect(entity.fieldWrites).toEqual({});
    expect(entity.version).toBe(5);
    expect(entity.createdSeq).toBe(5);
  });

  it("carries the create's seq, time and actor, and each field write's seq", async () => {
    await pushOps(
      [
        envelope({ clientSeq: 1, verb: "create", baseVersion: null, payload: { title: "t" }, actor: "writer", createdAt: "2026-08-01T09:30:00.000Z" }),
        envelope({ clientSeq: 2, payload: { title: "u" }, actor: "editor", createdAt: "2026-08-02T09:30:00.000Z" }),
      ],
      { token },
    );
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const [entity] = body.entities;
    expect(entity.createdSeq).toBe(1);
    expect(entity.createdAt).toBe("2026-08-01T09:30:00.000Z");
    expect(entity.createdBy).toBe("writer");
    expect(entity.fieldWrites.title.seq).toBe(2);
  });

  it("folds a field written under both spellings as one field, holding the value written last", async () => {
    await pushOps(
      [
        envelope({ clientSeq: 1, verb: "create", baseVersion: null, payload: { title: "t", updatedAt: "2026-08-01T00:00:00.000Z" } }),
        envelope({ clientSeq: 2, payload: { updated_at: "2026-08-02T00:00:00.000Z" } }),
        envelope({ clientSeq: 3, payload: { updatedAt: "2026-08-03T00:00:00.000Z" } }),
      ],
      { token },
    );
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const [entity] = body.entities;
    expect(entity.state).toEqual({ title: "t", updatedAt: "2026-08-03T00:00:00.000Z" });
    expect(Object.keys(entity.fieldWrites)).toEqual(["updatedAt"]);
  });

  it("keeps the column's spelling of a field a restored create names in both", async () => {
    // A backup folded before one spelling holds a create's value by field name and every
    // later edit's by column, with no provenance; the column's is the edit.
    await pushOps(
      [
        envelope({
          clientSeq: 1,
          verb: "create",
          baseVersion: null,
          actor: "restore:backup-1",
          payload: { title: "t", estimatedSeconds: 3600, acceptanceCriteria: ["a", "b"], estimated_seconds: 10800, acceptance_criteria: ["a", "c"] },
        }),
      ],
      { token },
    );
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const [entity] = body.entities;
    expect(entity.state).toEqual({ title: "t", estimated_seconds: 10800, acceptance_criteria: ["a", "c"] });
  });

  it("records a reopen as a write of `reopens`, whether or not the operation said so", async () => {
    await pushOps(
      [
        envelope({ clientSeq: 1, verb: "create", baseVersion: null, entityId: "reopened", payload: { title: "t", status: "done" } }),
        envelope({ clientSeq: 2, entityId: "reopened", payload: { status: "todo" } }),
        envelope({ clientSeq: 3, verb: "create", baseVersion: null, entityId: "moved", payload: { title: "u", status: "backlog" } }),
        envelope({ clientSeq: 4, entityId: "moved", payload: { status: "todo" } }),
      ],
      { token },
    );
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const byId = Object.fromEntries(body.entities.map((entity: any) => [entity.entityId, entity]));
    expect(byId.reopened.fieldWrites.reopens.seq).toBe(2);
    expect(byId.reopened.state.reopens).toBeUndefined();
    expect(byId.moved.fieldWrites.reopens).toBeUndefined();
  });

  it("keeps both of two revisions written as one number: the earlier at it, the later next", async () => {
    const revision = (clientSeq: number, body: string, author: string) =>
      envelope({
        clientSeq,
        entity: "documentRevision",
        verb: "create",
        baseVersion: null,
        entityId: "issue-1/plan/1",
        payload: { issueId: "issue-1", key: "plan", revision: 1, body, author, createdAt: `2026-09-11T00:00:0${clientSeq}.000Z`, changeSummary: null },
      });
    await pushOps([revision(1, "A's plan", "alice"), revision(2, "B's plan", "bob")], { token });
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const revisions = body.entities
      .filter((entity: any) => entity.entity === "documentRevision")
      .map((entity: any) => [entity.entityId, entity.state.revision, entity.state.body]);
    expect(revisions).toEqual([
      ["issue-1/plan/1", 1, "A's plan"],
      ["issue-1/plan/2", 2, "B's plan"],
    ]);
    const moved = body.entities.find((entity: any) => entity.entityId === "issue-1/plan/2");
    expect(moved.state.changeSummary).toMatch(/^renumbered from r1 to r2/);
  });

  /**
   * The placement every device uses (`placeRevision`, `src/core/cloud/revision-placement.ts`):
   * in log order, each revision takes the first free number from the one it claimed; one the
   * log already holds at or above that number — by body and author, never by time — adds
   * nothing; a document put back to an earlier text is a new revision.
   */
  it("places revisions as every device does: in log order, first free from the claim, matched by content", async () => {
    let clientSeq = 0;
    const revision = (claimed: number, body: string, author: string, createdAt: string, changeSummary: string | null = null) => {
      clientSeq += 1;
      return envelope({
        clientSeq,
        entity: "documentRevision",
        verb: "create",
        baseVersion: null,
        entityId: `issue-1/spec/${claimed}`,
        payload: { issueId: "issue-1", key: "spec", revision: claimed, body, author, createdAt, changeSummary },
      });
    };
    const moved = (from: number, to: number) =>
      `renumbered from r${from} to r${to}: written at the same time as another r${from}, which the repository's log holds first`;
    await pushOps(
      [
        revision(1, "v1", "alice", "2026-09-11T00:00:01.000Z"),
        revision(2, "A's edit", "alice", "2026-09-11T00:00:02.000Z"),
        // Three in flight on another device, each on the last.
        revision(2, "B's first", "bob", "2026-09-11T00:00:03.000Z"),
        revision(3, "B's second", "bob", "2026-09-11T00:00:04.000Z"),
        revision(4, "B's third", "bob", "2026-09-11T00:00:05.000Z"),
        // Its device sends each again under the number it moved it to.
        revision(3, "B's first", "bob", "2026-09-11T00:00:03.000Z", moved(2, 3)),
        revision(4, "B's second", "bob", "2026-09-11T00:00:04.000Z", moved(3, 4)),
        revision(5, "B's third", "bob", "2026-09-11T00:00:05.000Z", moved(4, 5)),
        // r1 again, dated a millisecond off by a build that took the operation's time.
        revision(1, "v1", "alice", "2026-09-11T00:00:01.001Z"),
        // And the document put back to its first text: a revision of its own.
        revision(6, "v1", "alice", "2026-09-11T00:00:06.000Z"),
      ],
      { token },
    );
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const revisions = body.entities
      .filter((entity: any) => entity.entity === "documentRevision")
      .map((entity: any) => [entity.entityId, entity.state.body, entity.state.createdAt, entity.state.changeSummary]);
    expect(revisions).toEqual([
      ["issue-1/spec/1", "v1", "2026-09-11T00:00:01.000Z", null],
      ["issue-1/spec/2", "A's edit", "2026-09-11T00:00:02.000Z", null],
      ["issue-1/spec/3", "B's first", "2026-09-11T00:00:03.000Z", moved(2, 3)],
      ["issue-1/spec/4", "B's second", "2026-09-11T00:00:04.000Z", moved(3, 4)],
      ["issue-1/spec/5", "B's third", "2026-09-11T00:00:05.000Z", moved(4, 5)],
      ["issue-1/spec/6", "v1", "2026-09-11T00:00:06.000Z", null],
    ]);
  });

  it("forgets a status's place in an earlier order when it is created again", async () => {
    await pushOps(
      [
        envelope({ clientSeq: 1, entity: "status", verb: "create", baseVersion: null, entityId: "zz", payload: { label: "ZZ", category: "review" } }),
        envelope({ clientSeq: 2, entity: "status", entityId: "@order", payload: { order: ["todo", "zz", "done"] } }),
        envelope({ clientSeq: 3, entity: "status", verb: "delete", entityId: "zz", payload: {} }),
        envelope({ clientSeq: 4, entity: "status", verb: "create", baseVersion: null, entityId: "zz", payload: { label: "ZZ", category: "review" } }),
      ],
      { token },
    );
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const order = body.entities.find((entity: any) => entity.entity === "status" && entity.entityId === "@order");
    expect(order.state.order).toEqual(["todo", "done"]);
  });

  it("says a status or kind created again after a delete is not a built-in, when its create does not", async () => {
    await pushOps(
      [
        envelope({ clientSeq: 1, entity: "kind", verb: "delete", entityId: "spike", payload: {} }),
        envelope({ clientSeq: 2, entity: "kind", verb: "create", baseVersion: null, entityId: "spike", payload: { id: "spike", label: "Spike" } }),
        envelope({ clientSeq: 3, entity: "kind", verb: "create", baseVersion: null, entityId: "research", payload: { id: "research", label: "Research" } }),
      ],
      { token },
    );
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const kind = (id: string) => body.entities.find((entity: any) => entity.entity === "kind" && entity.entityId === id);
    expect(kind("spike").state).toEqual({ id: "spike", label: "Spike", isBuiltin: false });
    // Created once: nothing to say, and a device inserting it holds it as the workspace's own.
    expect(kind("research").state).toEqual({ id: "research", label: "Research" });
  });

  it("says nothing about a create the log does not hold", async () => {
    await pushOps([envelope({ clientSeq: 1, payload: { title: "an edit with no create" } })], { token });
    const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const [entity] = body.entities;
    expect(entity.createdSeq).toBeNull();
    expect(entity.createdAt).toBeNull();
    expect(entity.createdBy).toBeNull();
  });
});
