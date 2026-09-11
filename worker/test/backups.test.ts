/**
 * Backup, restore and purge.
 *
 * The centre of this file is one assertion: after a restore, a device that hydrates
 * through the ordinary bootstrap path sees the RESTORED CONTENT and not an empty
 * repository. Everything else here exists to stop that one from being true by
 * accident.
 *
 * A restore that only bumped the epoch would pass a test that checked the epoch
 * moved, a test that checked the old rows were retained, and a test that checked the
 * restore was audited. It would fail only this one, because `GET /snapshot` folds the
 * CURRENT epoch and a freshly bumped epoch is empty. That is why the assertion is
 * written against the snapshot route rather than against the `ops` table.
 */
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEVICE,
  ORIGIN,
  OTHER_REPO,
  REPO,
  call,
  expectError,
  jsonOf,
  pushOps,
  seedRepo,
} from "./helpers.js";
import { PURGE_REFUSALS } from "./purge-fixture.js";

async function enableBackup(repoId = REPO): Promise<void> {
  await env.DB.prepare(`UPDATE repos SET backup_enabled = 1 WHERE repo_id = ?1`)
    .bind(repoId)
    .run();
}

async function repoRow(repoId = REPO): Promise<{ epoch: number; last_seq: number }> {
  return (await env.DB.prepare(`SELECT epoch, last_seq FROM repos WHERE repo_id = ?1`)
    .bind(repoId)
    .first<{ epoch: number; last_seq: number }>())!;
}

/** One `create` envelope per entity id, so the fold has something to fold. */
function creates(ids: string[], from = 1): Record<string, unknown>[] {
  return ids.map((id, index) => ({
    opId: `op-${from + index}`,
    repoId: REPO,
    protocol: 1,
    schema: 10,
    entity: "issue",
    entityId: id,
    verb: "create",
    baseVersion: null,
    payload: { title: `title for ${id}` },
    deviceId: DEVICE,
    actor: "opus-s11",
    clientSeq: from + index,
    createdAt: "2026-09-08T10:00:00.000Z",
  }));
}

/** Drive the resumable restore route to completion, the way the client does. */
async function runRestore(
  token: string,
  backupId: string,
  confirm: string = REPO,
  device?: string,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = { confirm };
  let last: Record<string, unknown> = {};
  for (let guard = 0; guard < 50; guard += 1) {
    const response = await call(`/v1/repos/${REPO}/backups/${backupId}/restore`, {
      method: "POST",
      token,
      body,
      device,
    });
    expect(response.status).toBe(200);
    last = await jsonOf<Record<string, unknown>>(response);
    if (last.done === true) return last;
    body = { confirm, restoreId: last.restoreId };
  }
  throw new Error("restore did not converge");
}

describe("backup consent", () => {
  it("refuses every backup route until the server-side flag is set", async () => {
    const token = await seedRepo();

    await expectError(await call(`/v1/repos/${REPO}/backups`, { token }), "forbidden", 403);
    await expectError(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
      "forbidden",
      403,
    );
    await expectError(
      await call(`/v1/repos/${REPO}/backups/anything/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO },
      }),
      "forbidden",
      403,
    );
  });

  it("is not granted by connecting or by anything push does", async () => {
    const token = await seedRepo();
    await pushOps(creates(["issue-1"]), { token });

    const row = await env.DB.prepare(`SELECT backup_enabled FROM repos WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ backup_enabled: number }>();
    expect(row?.backup_enabled).toBe(0);
  });

  it("is granted and withdrawn by its own route, and withdrawing keeps the backups", async () => {
    const token = await seedRepo();
    await pushOps(creates(["issue-1"]), { token });

    await call(`/v1/repos/${REPO}/backup`, { method: "PUT", token, body: { enabled: true } });
    const created = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );

    await call(`/v1/repos/${REPO}/backup`, { method: "PUT", token, body: { enabled: false } });
    await expectError(await call(`/v1/repos/${REPO}/backups`, { token }), "forbidden", 403);

    // Withdrawing permission to make new backups must not destroy the ones already
    // made. Deleting is a different verb, and purge is another.
    const still = await env.DB.prepare(`SELECT backup_id FROM backups WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ backup_id: string }>();
    expect(still?.backup_id).toBe(created.backup.backupId);
  });
});

describe("creating and retaining a backup changes no convergence state", () => {
  it("moves no epoch, no high-water mark and no lease", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1", "issue-2"]), { token });

    const before = await repoRow();
    const created = await jsonOf<{ backup: { backupId: string; entityCount: number } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    const afterCreate = await repoRow();

    await call(`/v1/repos/${REPO}/backups`, { token });
    const afterList = await repoRow();

    await call(`/v1/repos/${REPO}/backups/${created.backup.backupId}`, { method: "DELETE", token });
    const afterDelete = await repoRow();

    expect(afterCreate).toEqual(before);
    expect(afterList).toEqual(before);
    expect(afterDelete).toEqual(before);
    expect(created.backup.entityCount).toBe(2);
  });

  it("lists newest first and reports what the fold cost", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} });
    await pushOps(creates(["issue-2"], 2), { token });
    await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} });

    const listed = await jsonOf<{ backups: { entityCount: number; opCount: number; kind: string }[] }>(
      await call(`/v1/repos/${REPO}/backups`, { token }),
    );
    expect(listed.backups).toHaveLength(2);
    expect(listed.backups.map((b) => b.entityCount)).toEqual([2, 1]);
    expect(listed.backups.every((b) => b.kind === "manual")).toBe(true);
  });
});

describe("restore materialises into the new epoch", () => {
  /**
   * A restored operation is written with the time and actor of the create it replaces, so
   * the new epoch's fold hands a hydrating device the same date and author for a comment
   * or revision whose payload predates carrying its own — not the moment of the restore.
   */
  it("keeps each entity's create time and actor across the restore", async () => {
    // Its own device: see "hands a restored epoch no provenance" below for why.
    const device = "device-times";
    const token = await seedRepo(REPO, device);
    await enableBackup();
    await pushOps(
      creates(["issue-1"]).map((op) => ({ ...op, deviceId: device })),
      { token, device },
    );
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {}, device }),
    );
    await runRestore(token, backup.backup.backupId, REPO, device);
    const snapshot = await jsonOf<{ entities: Array<{ createdAt: string; createdBy: string }> }>(
      await call(`/v1/repos/${REPO}/snapshot`, { token, device }),
    );
    expect(snapshot.entities[0]!.createdAt).toBe("2026-09-08T10:00:00.000Z");
    expect(snapshot.entities[0]!.createdBy).toBe("opus-s11");
  });

  it("a device bootstrapping after a restore sees the restored content, not an empty repository", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1", "issue-2", "issue-3"]), { token });

    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );

    const outcome = await runRestore(token, backup.backup.backupId);
    expect(outcome.status).toBe("committed");
    expect(outcome.toEpoch).toBe(2);

    // Exactly what a freshly connected device does: no cursor, just ask.
    const snapshot = await jsonOf<{
      epoch: number;
      entities: { entity: string; entityId: string; state: Record<string, unknown> }[];
    }>(await call(`/v1/repos/${REPO}/snapshot`, { token }));

    expect(snapshot.epoch).toBe(2);
    expect(snapshot.entities.map((e) => e.entityId).sort()).toEqual([
      "issue-1",
      "issue-2",
      "issue-3",
    ]);
    expect(snapshot.entities[0]!.state).toEqual({ title: "title for issue-1" });
  });

  /**
   * STA-263. A backup stores the fold MINUS its per-field provenance, because the new
   * epoch restarts entity versions at zero and re-mints operation ids — an old epoch's
   * `baseVersion` is on a different scale and its `opId` names a row nobody will ever
   * pull. Carrying it across would let a device defend an inherited value by citing an
   * operation that does not exist in the timeline it is now on.
   *
   * What the restored epoch then has is whatever its OWN materialised operations
   * leave, and that is not nothing — see the ordered-collection case below. The
   * guarantee is not *"no provenance"*; it is that **a restore leaves no claim that
   * can outrank a later write**, because every claim it can leave sits at the floor of
   * the new epoch.
   */
  it("hands a restored epoch no provenance for an entity materialised as a create", async () => {
    /**
     * Its own device, and not for style. The rate limiter is keyed on
     * `repoId:deviceId` and its counter is a binding rather than D1, so it is the one
     * piece of state that survives the per-test storage isolation. This test is the
     * most request-hungry in the file — two pushes, two snapshots, a backup and a
     * restore — and running it under the shared device spends budget the tests after
     * it need, which surfaces as unrelated 429s three tests later.
     */
    const device = "device-prov";
    const token = await seedRepo(REPO, device);
    await enableBackup();

    const op = (over: Record<string, unknown>): Record<string, unknown> => ({
      repoId: REPO,
      protocol: 1,
      schema: 10,
      entity: "issue",
      entityId: "issue-1",
      deviceId: device,
      actor: "opus-prov",
      createdAt: "2026-09-08T10:00:00.000Z",
      ...over,
    });

    await pushOps(
      [
        op({ opId: "op-1", clientSeq: 1, verb: "create", baseVersion: null, payload: { title: "kept" } }),
        op({
          opId: "op-2",
          clientSeq: 2,
          verb: "update",
          baseVersion: 1,
          payload: { status: "in_progress" },
        }),
      ],
      { token, device },
    );

    const before = await jsonOf<{ entities: { fieldWrites: Record<string, unknown> }[] }>(
      await call(`/v1/repos/${REPO}/snapshot`, { token, device }),
    );
    expect(Object.keys(before.entities[0]!.fieldWrites)).toEqual(["status"]);

    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {}, device }),
    );
    await runRestore(token, backup.backup.backupId, REPO, device);

    const after = await jsonOf<{
      epoch: number;
      entities: { state: Record<string, unknown>; fieldWrites: Record<string, unknown> }[];
    }>(await call(`/v1/repos/${REPO}/snapshot`, { token, device }));

    expect(after.epoch).toBe(2);
    // The state survives whole; only the claims on it are gone.
    expect(after.entities[0]!.state).toEqual({ title: "kept", status: "in_progress" });
    expect(after.entities[0]!.fieldWrites).toEqual({});
  });

  /**
   * The case the test above does NOT cover, and the reason it needed a sibling.
   *
   * An ordered collection materialises as a `replace`, not a `create` — that is what
   * `materializedVerb` is for — and the fold excludes only `create`. So a restored
   * queue DOES carry provenance in the new epoch, and *"a restore leaves no
   * provenance"* would have been a false statement with a green test behind it.
   *
   * The true statement is narrower and stronger. The restored operation is the
   * entity's first in the epoch, so the fold records it at `baseVersion 0` — the
   * floor. `localFieldWrites` selects `base_version >= op.baseVersion`, and every
   * device hydrates the restored epoch at version 1 before it can write, so no later
   * operation can be matched by a row sitting at 0. **A restore leaves no claim that
   * can outrank a later write.**
   *
   * And what the row buys is real: the incumbent plan is attributable to the restore
   * operation, which every device computes identically because it is in the log. The
   * alternative — excluding it — would push a post-restore conflict on the plan onto
   * the `WHOLE` floor in `contest`, with `localOpId: null` and a conflict id no other
   * device reaches.
   *
   * There is no cheaper rule that would exclude it. `version > 1` looks like the
   * elegant fix and is wrong: an ordered collection's FIRST operation is a `replace`
   * in ordinary use — `QueueStore.recordPlan` never journals a create — so that rule
   * would strip provenance from the first plan anybody actually chose, and break the
   * agreement with `Journal.flush` that the whole design rests on.
   */
  it("leaves a restored ordered collection a claim at the floor, and no higher", async () => {
    const device = "device-prov-queue";
    const token = await seedRepo(REPO, device);
    await enableBackup();

    await pushOps(
      [
        {
          opId: "q-1",
          repoId: REPO,
          protocol: 1,
          schema: 10,
          entity: "queue",
          entityId: "@plan",
          verb: "replace",
          baseVersion: 0,
          payload: { order: ["issue-1", "issue-2"] },
          deviceId: device,
          actor: "opus-prov",
          clientSeq: 1,
          createdAt: "2026-09-08T10:00:00.000Z",
        },
      ],
      { token, device },
    );

    // Before the restore the plan is attributed to the device that chose it, at the
    // floor of ITS epoch — a first `replace` really is an entity's first operation.
    const before = await jsonOf<{ entities: { fieldWrites: Record<string, unknown> }[] }>(
      await call(`/v1/repos/${REPO}/snapshot`, { token, device }),
    );
    expect(before.entities[0]!.fieldWrites).toEqual({
      order: { baseVersion: 0, opId: "q-1", at: "2026-09-08T10:00:00.000Z", seq: expect.any(Number) },
    });

    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {}, device }),
    );
    await runRestore(token, backup.backup.backupId, REPO, device);

    const after = await jsonOf<{
      epoch: number;
      entities: {
        verb: string;
        version: number;
        state: Record<string, unknown>;
        fieldWrites: Record<string, { baseVersion: number; opId: string }>;
      }[];
    }>(await call(`/v1/repos/${REPO}/snapshot`, { token, device }));

    expect(after.epoch).toBe(2);
    expect(after.entities[0]!.verb).toBe("replace");
    expect(after.entities[0]!.state).toEqual({ order: ["issue-1", "issue-2"] });

    // A claim exists, it names the RESTORE rather than the device that chose the
    // plan, and it sits at the floor.
    const claim = after.entities[0]!.fieldWrites.order!;
    expect(claim.opId).not.toBe("q-1");
    expect(claim.baseVersion).toBe(0);
    // Which is the whole guarantee, stated against the number a hydrating device
    // actually adopts: it comes up holding version 1, so the first write it makes
    // carries `baseVersion 1`, and `base_version >= 1` cannot select a row at 0.
    expect(after.entities[0]!.version).toBe(1);
    expect(claim.baseVersion).toBeLessThan(after.entities[0]!.version);
  });

  it("restores the state as it was at the cutoff, discarding what came after", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });

    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );

    // Work that happened after the backup. A restore is exactly the decision to
    // discard it, and the pre-restore backup is where it survives.
    await pushOps(creates(["issue-99"], 2), { token });

    await runRestore(token, backup.backup.backupId);

    const snapshot = await jsonOf<{ entities: { entityId: string }[] }>(
      await call(`/v1/repos/${REPO}/snapshot`, { token }),
    );
    expect(snapshot.entities.map((e) => e.entityId)).toEqual(["issue-1"]);
  });

  it("materialises a tombstone, so a deleted entity does not come back to life", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1", "issue-2"]), { token });
    await pushOps(
      [
        {
          ...creates(["issue-2"], 3)[0],
          verb: "delete",
          baseVersion: 1,
          payload: {},
        },
      ],
      { token },
    );

    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    await runRestore(token, backup.backup.backupId);

    const snapshot = await jsonOf<{
      entities: { entityId: string; deletedAt: number | null }[];
    }>(await call(`/v1/repos/${REPO}/snapshot`, { token }));

    // The tombstone is RETURNED, not omitted. A re-bootstrapping device keeps its
    // local rows, so silence about issue-2 would resurrect it on every device that
    // still has one.
    const tombstone = snapshot.entities.find((e) => e.entityId === "issue-2");
    expect(tombstone).toBeDefined();
    expect(tombstone!.deletedAt).not.toBeNull();
  });

  it("round-trips an ordered collection through `replace` rather than merging it", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(
      [
        {
          ...creates(["plan-1"])[0],
          entity: "milestone",
          verb: "replace",
          baseVersion: 1,
          payload: { members: ["c", "a", "b"] },
        },
      ],
      { token },
    );

    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    await runRestore(token, backup.backup.backupId);

    const snapshot = await jsonOf<
      { entities: { verb: string; state: Record<string, unknown> }[] }
    >(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    // The order is the one that was backed up, still whole, still not merged — and it
    // arrives as the payload of a `replace`, which is the same shape the ordered tail
    // would have delivered it in.
    expect(snapshot.entities[0]!.verb).toBe("replace");
    expect(snapshot.entities[0]!.state).toEqual({ members: ["c", "a", "b"] });
  });

  /**
   * STA-259, through this path rather than through `/snapshot`.
   *
   * The two paths share `foldLog`, so a granularity mistake in the fold was never a
   * divergence between them — it was the same loss twice. It is worse here: a restore
   * materialises the folded state as real operations in the new epoch, so a dropped
   * field is written into the LOG and no later pull can disagree with it. The snapshot
   * path loses the dates for a device; this path loses them for the repository.
   */
  it("keeps the fields a `replace` never mentioned, through a backup and a restore", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(
      [
        {
          ...creates(["plan-1"])[0],
          entity: "milestone",
          verb: "update",
          baseVersion: 1,
          payload: { targetDate: "2026-12-24", startDate: "2026-10-01" },
        },
        {
          ...creates(["plan-1"], 2)[0],
          entity: "milestone",
          verb: "replace",
          baseVersion: 1,
          payload: { members: ["c", "a", "b"] },
        },
      ],
      { token },
    );

    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    await runRestore(token, backup.backup.backupId);

    const snapshot = await jsonOf<
      { entities: { verb: string; state: Record<string, unknown> }[] }
    >(await call(`/v1/repos/${REPO}/snapshot`, { token }));

    // Both facts crossed the backup and came back, and the collection is still whole
    // and still under the verb that carried it.
    expect(snapshot.entities[0]!.verb).toBe("replace");
    expect(snapshot.entities[0]!.state).toEqual({
      targetDate: "2026-12-24",
      startDate: "2026-10-01",
      members: ["c", "a", "b"],
    });
  });
});

describe("restore is non-truncating", () => {
  it("keeps the old epoch's rows and never rewinds the high-water mark", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1", "issue-2"]), { token });
    const before = await repoRow();

    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    await runRestore(token, backup.backup.backupId);
    const after = await repoRow();

    const old = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1 AND epoch = ?2`,
    )
      .bind(REPO, before.epoch)
      .first<{ n: number }>();

    expect(old?.n).toBe(2);
    expect(after.epoch).toBe(before.epoch + 1);
    // `seq` keeps climbing across the flip, so fenced lease tokens and every cursor
    // ever issued stay meaningful.
    expect(after.last_seq).toBeGreaterThan(before.last_seq);
  });

  it("mints operation ids that cannot collide with a device's own", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    await runRestore(token, backup.backup.backupId);

    const ids = await env.DB.prepare(`SELECT op_id, epoch FROM ops WHERE repo_id = ?1`)
      .bind(REPO)
      .all<{ op_id: string; epoch: number }>();

    const unique = new Set(ids.results.map((r) => `${r.epoch}:${r.op_id}`));
    expect(unique.size).toBe(ids.results.length);
    // The restored id is a 32-char digest, not the `op-N` a client sent.
    const restored = ids.results.filter((r) => r.epoch === 2);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.op_id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("staged rows are invisible until the epoch flips", () => {
  it("a device pulling and bootstrapping mid-restore sees the OLD timeline", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1", "issue-2"]), { token });

    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );

    // Begin and stage, but do NOT commit.
    const begun = await jsonOf<{ restoreId: string; entityCount: number }>(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO },
      }),
    );
    const staged = await jsonOf<{ staged: number; done: boolean }>(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO, restoreId: begun.restoreId },
      }),
    );
    expect(staged.staged).toBe(begun.entityCount);
    expect(staged.done).toBe(false);

    // The rows exist in the table...
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1 AND epoch = 2`,
    )
      .bind(REPO)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);

    // ...and no device can see any of them, by any route, because both pull and
    // snapshot filter on the session's epoch and the repository has not moved.
    const snapshot = await jsonOf<{ epoch: number; entities: unknown[] }>(
      await call(`/v1/repos/${REPO}/snapshot`, { token }),
    );
    expect(snapshot.epoch).toBe(1);
    expect(snapshot.entities).toHaveLength(2);

    const pulled = await jsonOf<{ epoch: number; ops: { epoch: number }[] }>(
      await call(`/v1/repos/${REPO}/ops`, { token }),
    );
    expect(pulled.epoch).toBe(1);
    expect(pulled.ops.every((op) => op.epoch === 1)).toBe(true);
  });
});

describe("restore refuses rather than destroying", () => {
  it("requires the repository id typed back on the wire", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );

    await expectError(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: "not-the-repository-id" },
      }),
      "validation",
      400,
    );

    // Nothing was staged and no audit row was written for a refused attempt.
    const restores = await env.DB.prepare(`SELECT COUNT(*) AS n FROM restores WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ n: number }>();
    expect(restores?.n).toBe(0);
    expect((await repoRow()).epoch).toBe(1);
  });

  it("refuses to commit over work that landed after it began", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );

    const begun = await jsonOf<{ restoreId: string }>(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO },
      }),
    );
    await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
      method: "POST",
      token,
      body: { confirm: REPO, restoreId: begun.restoreId },
    });

    // A device pushes into the epoch that is about to be left behind. That work is in
    // neither the backup nor the pre-restore fold.
    await pushOps(creates(["issue-late"], 50), { token });

    const response = await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
      method: "POST",
      token,
      body: { confirm: REPO, restoreId: begun.restoreId },
    });
    await expectError(response, "conflict", 409);
    expect((await repoRow()).epoch).toBe(1);
  });

  it("refuses a second concurrent restore", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );

    await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
      method: "POST",
      token,
      body: { confirm: REPO },
    });
    await expectError(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO },
      }),
      "conflict",
      409,
    );
  });

  it("refuses to delete the backup a restore is still using", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
      method: "POST",
      token,
      body: { confirm: REPO },
    });

    await expectError(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}`, {
        method: "DELETE",
        token,
      }),
      "conflict",
      409,
    );
  });

  it("answers a replayed commit with success rather than an error", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    const outcome = await runRestore(token, backup.backup.backupId);

    const replay = await jsonOf<{ done: boolean; status: string }>(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO, restoreId: outcome.restoreId },
      }),
    );
    expect(replay).toMatchObject({ done: true, status: "committed" });
    expect((await repoRow()).epoch).toBe(2);
  });
});

describe("the pre-restore snapshot and the audit record", () => {
  it("captures the undo before anything is staged, and the undo is itself restorable", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );

    // Work that only the pre-restore snapshot will contain.
    await pushOps(creates(["issue-later"], 2), { token });

    const outcome = await runRestore(token, backup.backup.backupId);
    const undoId = outcome.preRestoreBackupId as string;
    expect(undoId).toBeTruthy();

    // After the restore, `issue-later` is gone from the live timeline.
    const restored = await jsonOf<{ entities: { entityId: string }[] }>(
      await call(`/v1/repos/${REPO}/snapshot`, { token }),
    );
    expect(restored.entities.map((e) => e.entityId)).toEqual(["issue-1"]);

    // Restoring the undo brings it back — which is what "recoverable" has to mean.
    await runRestore(token, undoId);
    const undone = await jsonOf<{ epoch: number; entities: { entityId: string }[] }>(
      await call(`/v1/repos/${REPO}/snapshot`, { token }),
    );
    expect(undone.epoch).toBe(3);
    expect(undone.entities.map((e) => e.entityId).sort()).toEqual(["issue-1", "issue-later"]);
  });

  it("writes one audit row per restore, naming both timelines and the undo", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    await runRestore(token, backup.backup.backupId);

    const audit = await env.DB.prepare(
      `SELECT from_backup_id, pre_restore_backup_id, from_epoch, to_epoch, status,
              device_id, entity_count, staged_count
         FROM restores WHERE repo_id = ?1`,
    )
      .bind(REPO)
      .all<Record<string, unknown>>();

    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]).toMatchObject({
      from_backup_id: backup.backup.backupId,
      from_epoch: 1,
      to_epoch: 2,
      status: "committed",
      device_id: DEVICE,
      entity_count: 1,
      staged_count: 1,
    });
    expect(audit.results[0]!.pre_restore_backup_id).toBeTruthy();
  });

  it("keeps the audit row for a restore that was begun and abandoned", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
      method: "POST",
      token,
      body: { confirm: REPO },
    });

    // Somebody pointed a loaded weapon at a repository and then stopped. That is the
    // interesting row, so it is still here and it still says `staging`.
    const audit = await env.DB.prepare(`SELECT status FROM restores WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ status: string }>();
    expect(audit?.status).toBe("staging");
    expect((await repoRow()).epoch).toBe(1);
  });
});

describe("staging is chunked", () => {
  it("takes more than one call when the backup exceeds the batch ceiling", async () => {
    const token = await seedRepo();
    await enableBackup();

    // 30 entities against a free-plan ceiling of 25 per stage.
    const ids = Array.from({ length: 30 }, (_, i) => `issue-${i + 1}`);
    for (let i = 0; i < ids.length; i += 25) {
      await pushOps(creates(ids.slice(i, i + 25), i + 1), { token });
    }

    const backup = await jsonOf<{ backup: { backupId: string; entityCount: number } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    expect(backup.backup.entityCount).toBe(30);

    const begun = await jsonOf<{ restoreId: string }>(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO },
      }),
    );

    const first = await jsonOf<{ staged: number; done: boolean }>(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO, restoreId: begun.restoreId },
      }),
    );
    expect(first.staged).toBe(25);
    expect(first.done).toBe(false);

    const second = await jsonOf<{ staged: number; done: boolean }>(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO, restoreId: begun.restoreId },
      }),
    );
    expect(second.staged).toBe(30);

    const committed = await jsonOf<{ done: boolean }>(
      await call(`/v1/repos/${REPO}/backups/${backup.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO, restoreId: begun.restoreId },
      }),
    );
    expect(committed.done).toBe(true);

    const snapshot = await jsonOf<{ entities: unknown[] }>(
      await call(`/v1/repos/${REPO}/snapshot`, { token }),
    );
    expect(snapshot.entities).toHaveLength(30);
  });
});

describe("purge", () => {
  /** Every table purge deletes from, which is every table this Worker has. */
  const TABLES = ["ops", "backups", "restores", "repos", "devices", "leases"] as const;

  /**
   * Its own device per test, for the reason `device-prov` above gives: the rate
   * limiter's counter survives the per-test truncation, and a fully populated
   * repository costs a dozen requests to build.
   */
  let device = "";
  let tests = 0;
  beforeEach(() => {
    tests += 1;
    device = `purger-${tests}`;
  });

  /**
   * Each table's rows for this repository, every column, in a stable order. Sorted
   * here rather than by `rowid`, because `ops` is `WITHOUT ROWID`.
   */
  async function everyTable(repoId = REPO): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const table of TABLES) {
      const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE repo_id = ?1`)
        .bind(repoId)
        .all();
      out[table] = rows.results.map((row) => JSON.stringify(row)).sort();
    }
    return out;
  }

  /**
   * A repository with a row in EVERY table: operations, a backup, a finished restore
   * (which adds the restore audit row, a pre-restore backup and a second epoch of
   * operations), a lease, and two devices. A refused purge is then proved against all
   * six tables, not only against the ones a refusal would most obviously touch.
   */
  async function populated(): Promise<string> {
    const token = await seedRepo(REPO, device);
    await seedRepo(REPO, `${device}-other`);
    await enableBackup();
    const pushed = await pushOps(
      creates(["issue-1", "issue-2"]).map((op) => ({ ...op, deviceId: device })),
      { token, device },
    );
    expect(pushed.status).toBe(200);
    const backup = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {}, device }),
    );
    await runRestore(token, backup.backup.backupId, REPO, device);
    const lease = await call(`/v1/repos/${REPO}/leases`, {
      method: "POST",
      token,
      device,
      body: { entityId: "issue-1", holder: "opus-s11", ttlSeconds: 300 },
    });
    expect(lease.status).toBe(200);

    const tables = await everyTable();
    for (const table of TABLES) {
      expect({ table, populated: tables[table]!.length > 0 }).toEqual({ table, populated: true });
    }
    return token;
  }

  function purge(token: string, body?: unknown, headers?: Record<string, string>) {
    return call(`/v1/repos/${REPO}`, { method: "DELETE", token, device, body, headers });
  }

  async function expectRefusal(response: Response, refusal: { status: number; body: unknown }) {
    expect({ status: response.status, body: await response.json() }).toEqual(refusal);
  }

  it("destroys every trace of the repository with the right confirmation", async () => {
    const token = await populated();

    const response = await purge(token, { confirm: REPO });
    expect(response.status).toBe(200);
    expect(await jsonOf<{ purged: boolean }>(response)).toMatchObject({ purged: true });

    for (const table of TABLES) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repo_id = ?1`)
        .bind(REPO)
        .first<{ n: number }>();
      expect({ table, n: row?.n }).toEqual({ table, n: 0 });
    }
  });

  it("leaves every other device with a credential that no longer authenticates", async () => {
    const token = await seedRepo(REPO, device);
    expect((await purge(token, { confirm: REPO })).status).toBe(200);
    // The credential row is gone, so this is `auth` rather than `not_found`: the
    // server cannot tell a purged repository from one that never existed, and should
    // not be able to.
    await expectError(await call(`/v1/repos/${REPO}/ops`, { token, device }), "auth", 401);
  });

  /**
   * STA-256. This is the request every client released before the fix sends: a bare
   * DELETE, no body, no `Content-Length`. It used to destroy the repository on a bearer
   * credential alone. The refusal's message is what that client prints, so it tells
   * the person to update.
   */
  it("refuses a purge with no confirmation at all, and every table is left exactly as it was", async () => {
    const token = await populated();
    const before = await everyTable();

    await expectRefusal(await purge(token), PURGE_REFUSALS.missing);

    expect(await everyTable()).toEqual(before);
    // And the credential still works, which is what "nothing was deleted" means to
    // the device that asked.
    expect((await call(`/v1/repos/${REPO}/snapshot`, { token, device })).status).toBe(200);
  });

  it("treats an empty body, and a body with no `confirm`, as no confirmation", async () => {
    const token = await populated();
    const before = await everyTable();

    await expectRefusal(await purge(token, {}), PURGE_REFUSALS.missing);
    await expectRefusal(
      await purge(token, undefined, { "Content-Length": "0" }),
      PURGE_REFUSALS.missing,
    );
    await expectRefusal(await purge(token, { repositoryId: REPO }), PURGE_REFUSALS.missing);

    expect(await everyTable()).toEqual(before);
  });

  it("refuses a wrong confirmation, and every table is left exactly as it was", async () => {
    const token = await populated();
    // A second repository the caller has no credential for, so "wrong" includes a real
    // repository id and not only garbage.
    await seedRepo(OTHER_REPO);
    const before = await everyTable();
    const otherBefore = await everyTable(OTHER_REPO);

    const wrong: unknown[] = [
      OTHER_REPO,
      `${REPO.slice(0, -1)}2`,
      ` ${REPO}`,
      `${REPO}\n`,
      "",
      null,
      1,
      true,
      [REPO],
      { repoId: REPO },
    ];
    for (const confirm of wrong) {
      await expectRefusal(await purge(token, { confirm }), PURGE_REFUSALS.mismatch);
    }

    expect(await everyTable()).toEqual(before);
    expect(await everyTable(OTHER_REPO)).toEqual(otherBefore);
  });

  it("never echoes the value it was sent", async () => {
    const token = await populated();
    const response = await purge(token, { confirm: "stpl_looks-like-a-secret" });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("stpl_looks-like-a-secret");
  });

  it("refuses a body that is not a JSON object, and deletes nothing", async () => {
    const token = await populated();
    const before = await everyTable();

    // Byte for byte, because the fake is held to the same text (`cloud-purge-confirmation`).
    const exactly = async (response: Response, refusal: { status: number; body: unknown }) =>
      expect({ status: response.status, text: await response.text() }).toEqual({
        status: refusal.status,
        text: JSON.stringify(refusal.body),
      });
    await exactly(await purge(token, [REPO]), PURGE_REFUSALS.notAnObject);
    await exactly(await purge(token, REPO), PURGE_REFUSALS.notAnObject);
    await exactly(await purge(token, 7), PURGE_REFUSALS.notAnObject);
    const garbled = await SELF.fetch(`${ORIGIN}/v1/repos/${REPO}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Staple-Protocol": "1",
        "Staple-Device": device,
        "Content-Length": "5",
      },
      body: "{conf",
    });
    await exactly(garbled, PURGE_REFUSALS.malformed);
    await exactly(await purge(token), PURGE_REFUSALS.missing);
    await exactly(await purge(token, { confirm: OTHER_REPO }), PURGE_REFUSALS.mismatch);

    expect(await everyTable()).toEqual(before);
  });

  it("bounds the body from Content-Length before it reads it, as a push does", async () => {
    const token = await populated();
    const before = await everyTable();

    await expectError(
      await purge(token, { confirm: REPO }, { "Content-Length": String(999 * 1024 * 1024) }),
      "payload_too_large",
      413,
    );

    expect(await everyTable()).toEqual(before);
  });
});

