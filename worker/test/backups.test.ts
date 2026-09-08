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
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEVICE, REPO, call, expectError, jsonOf, pushOps, seedRepo } from "./helpers.js";

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
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = { confirm };
  let last: Record<string, unknown> = {};
  for (let guard = 0; guard < 50; guard += 1) {
    const response = await call(`/v1/repos/${REPO}/backups/${backupId}/restore`, {
      method: "POST",
      token,
      body,
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
   * THE assertion. A bump-only restore passes every other test in this file and fails
   * this one, which is the entire reason it is written against `/snapshot` — the route
   * a fresh device actually hydrates from — rather than against the `ops` table.
   */
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
  it("destroys every trace of the repository, including its backups", async () => {
    const token = await seedRepo();
    await enableBackup();
    await pushOps(creates(["issue-1"]), { token });
    await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} });

    const response = await call(`/v1/repos/${REPO}`, { method: "DELETE", token });
    expect(response.status).toBe(200);
    expect(await jsonOf<{ purged: boolean }>(response)).toMatchObject({ purged: true });

    for (const table of ["ops", "backups", "restores", "repos", "devices", "leases"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repo_id = ?1`)
        .bind(REPO)
        .first<{ n: number }>();
      expect({ table, n: row?.n }).toEqual({ table, n: 0 });
    }
  });

  it("leaves every other device with a credential that no longer authenticates", async () => {
    const token = await seedRepo();
    await call(`/v1/repos/${REPO}`, { method: "DELETE", token });
    // The credential row is gone, so this is `auth` rather than `not_found`: the
    // server cannot tell a purged repository from one that never existed, and should
    // not be able to.
    await expectError(await call(`/v1/repos/${REPO}/ops`, { token }), "auth", 401);
  });
});
