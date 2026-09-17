/**
 * What the routes do with the checkpoint: where a snapshot pins its cutoff when the fold is
 * behind, which cursors it refuses, how a pull keeps the fold near the head, what a refusal
 * leaves behind, and that a database written by the Worker before the checkpoint needs no
 * step before this one can serve it.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeCursor, entityKey } from "../src/cursor.js";
import { foldLog, materializedVerb } from "../src/fold.js";
import { advanceFold, foldProgress } from "../src/fold-store.js";
import { LAZY_FOLD_BEHIND, PAGE_BYTES, foldBudgetOps, pullFoldOps, restoreStageEntities } from "../src/limits.js";
import { REPO, call, jsonOf, seedRepo } from "./helpers.js";
import { type GeneratedOp, generateLog, insertOps } from "./log-generator.js";
import { oldCaptureBackup } from "./old-worker.js";

let token: string;
let device: string;
let devices = 0;

/**
 * Every test its own device: the rate limiter allows one device 120 requests a minute, and
 * the tests here drive the routes as hard as a device catching up does.
 */
const req: typeof call = (path, options = {}) => call(path, { device, ...options });

beforeEach(async () => {
  devices += 1;
  device = `device-routes-${devices}`;
  token = await seedRepo(REPO, device);
  await req(`/v1/repos/${REPO}/backup`, { method: "PUT", token, body: { enabled: true } });
});

async function progress(epoch = 1): Promise<number> {
  return (await foldProgress(env, REPO, epoch)).seq;
}

/**
 * The checkpoint at the head of `epoch`, as devices that have synced leave it — folded here
 * directly, since how many pulls that takes depends on what the log's operations cost to fold.
 */
async function catchUp(epoch = 1): Promise<void> {
  const repo = (await env.DB.prepare(`SELECT last_seq FROM repos WHERE repo_id = ?1`).bind(REPO).first<{ last_seq: number }>())!;
  await advanceFold(env, REPO, epoch, repo.last_seq, { budget: { remaining: Number.MAX_SAFE_INTEGER } });
}

async function snapshotAll(): Promise<{ cutoffSeq: number; tailCursor: string; entities: any[] }> {
  let cursor: string | null = null;
  const entities: any[] = [];
  let first: any = null;
  for (;;) {
    const query: string = `?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const response = await req(`/v1/repos/${REPO}/snapshot${query}`, { token });
    const body = await jsonOf(response);
    expect(response.status, JSON.stringify(body).slice(0, 300)).toBe(200);
    first ??= body;
    entities.push(...body.entities);
    if (!body.hasMore) return { cutoffSeq: first.cutoffSeq, tailCursor: first.tailCursor, entities };
    cursor = body.nextCursor;
  }
}

/**
 * Drive a restore to done, the way the client does. Any refusal fails, except — when asked
 * to wait for the fold — "still folding" at the start, as long as each one is progress.
 */
async function restore(
  backupId: string,
  waitForFold: "never" | "first turn" | "any turn" | boolean = "never",
  between: (turn: number) => Promise<void> = async () => undefined,
): Promise<any> {
  let restoreId: string | undefined;
  let folded = -1;
  const wait = waitForFold === true ? "first turn" : waitForFold === false ? "never" : waitForFold;
  for (let turn = 0; turn < 1000; turn += 1) {
    await between(turn);
    const response = await req(`/v1/repos/${REPO}/backups/${backupId}/restore`, {
      method: "POST",
      token,
      body: { confirm: REPO, ...(restoreId ? { restoreId } : {}) },
    });
    const body = await jsonOf(response);
    const waiting = wait === "any turn" || (wait === "first turn" && restoreId === undefined);
    if (waiting && response.status === 503 && typeof body.foldedSeq === "number") {
      expect(body.foldedSeq).toBeGreaterThan(folded);
      folded = body.foldedSeq;
      continue;
    }
    expect(response.status, JSON.stringify(body).slice(0, 300)).toBe(200);
    restoreId = body.restoreId;
    if (body.done) return body;
  }
  throw new Error("restore did not finish");
}

/** The content a restore of this fold must reproduce, entity by entity. */
function content(entities: any[]): string[] {
  return entities.map((e) =>
    JSON.stringify([entityKey(e.entity, e.entityId), e.deletedAt === null, e.deletedAt === null ? e.state : {}]),
  );
}

describe("GET /snapshot on a log the fold has not reached", () => {
  it("answers a first page still folding until the fold has reached the head, then pins the head", async () => {
    const ops = generateLog({ seed: 301, count: 5000, pool: 30 });
    await insertOps(env.DB, REPO, ops);
    const head = ops[ops.length - 1]!.seq;

    let refusals = 0;
    let folded = -1;
    let first: any;
    for (;;) {
      const response = await req(`/v1/repos/${REPO}/snapshot?limit=500`, { token });
      const body = await jsonOf(response);
      if (response.status === 200) {
        first = body;
        break;
      }
      expect({ status: response.status, code: body.code, cutoffSeq: body.cutoffSeq }).toEqual({ status: 503, code: "unavailable", cutoffSeq: head });
      expect(body.foldedSeq).toBeGreaterThan(folded);
      folded = body.foldedSeq;
      refusals += 1;
    }
    // A budget folded by each, and served by the one that reaches the head: never more than a
    // budget's operations folded in a request, and often fewer, since a step is cut by its work too.
    expect(refusals).toBeGreaterThanOrEqual(Math.ceil(ops.length / foldBudgetOps("free")) - 1);
    // Never a cutoff short of the head, and the cutoff is a mark.
    expect(first.cutoffSeq).toBe(head);
    expect(await progress()).toBe(head);
    const snapshot = await snapshotAll();
    expect(content(snapshot.entities)).toEqual(content((await foldLog(env, REPO, 1, head)).entities));
  });

  it("refuses a cursor naming a cutoff past the log, and folds nothing towards it", async () => {
    const ops = generateLog({ seed: 302, count: 300, pool: 10 });
    await insertOps(env.DB, REPO, ops);
    const head = ops[ops.length - 1]!.seq;
    const forged = encodeCursor({ v: 1, r: REPO, e: 1, c: head + 1000, k: "" });
    const response = await req(`/v1/repos/${REPO}/snapshot?cursor=${encodeURIComponent(forged)}`, { token });
    expect(response.status).toBe(400);
    expect((await jsonOf(response)).code).toBe("cursor_invalid");
    expect(await progress()).toBeLessThanOrEqual(head);
  });
});

describe("GET /ops keeps the fold near the head", () => {
  it("folds one pull's worth whenever the fold is a threshold behind, and nothing below it", async () => {
    const ops = generateLog({ seed: 303, count: 3000, pool: 30 });
    await insertOps(env.DB, REPO, ops);
    const head = ops[ops.length - 1]!.seq;

    // One pull's worth each: some operations, never more than a pull may fold, until the fold is
    // less than the threshold behind.
    let pulls = 0;
    let folded = 0;
    while (head - (await progress()) >= LAZY_FOLD_BEHIND) {
      await req(`/v1/repos/${REPO}/ops?limit=1`, { token });
      pulls += 1;
      const reached = await progress();
      const now = ops.filter((op) => op.seq <= reached).length;
      expect(now).toBeGreaterThan(folded);
      expect(now - folded).toBeLessThanOrEqual(pullFoldOps("free"));
      folded = now;
      expect(pulls).toBeLessThan(200);
    }
    expect(pulls).toBeGreaterThanOrEqual(Math.ceil((ops.length - LAZY_FOLD_BEHIND) / pullFoldOps("free")));

    // Fewer than the threshold behind — counted in seqs, and the log has no gaps from here on — and
    // a pull leaves the fold where it is.
    const stopped = await progress();
    await req(`/v1/repos/${REPO}/ops?limit=1`, { token });
    expect(await progress()).toBe(stopped);
    const more = generateLog({ seed: 304, count: LAZY_FOLD_BEHIND - 1 - (head - stopped), pool: 30, firstSeq: head + 1, gapRate: 0 });
    await insertOps(env.DB, REPO, more);
    await req(`/v1/repos/${REPO}/ops?limit=1`, { token });
    expect(await progress()).toBe(stopped);
    // One more operation, and it is exactly the threshold behind: the next pull folds.
    const last = generateLog({ seed: 305, count: 1, pool: 30, firstSeq: (more[more.length - 1]?.seq ?? head) + 1, gapRate: 0 });
    await insertOps(env.DB, REPO, last);
    expect(last[0]!.seq - stopped).toBe(LAZY_FOLD_BEHIND);
    await req(`/v1/repos/${REPO}/ops?limit=1`, { token });
    expect(await progress()).toBeGreaterThan(stopped);
    expect(await progress()).toBeLessThanOrEqual(last[0]!.seq);
  });
});

describe("a restore the fold is not ready for", () => {
  it("is refused before anything changes: no undo, no audit row, no vocabulary claimed", async () => {
    const early = generateLog({ seed: 306, count: 200, pool: 10 });
    await insertOps(env.DB, REPO, early);
    await oldCaptureBackup(env.DB, REPO, { backupId: "old-small", deviceId: "device-a" });
    const late = generateLog({ seed: 307, count: 6000, pool: 30, firstSeq: early[early.length - 1]!.seq + 1 });
    await insertOps(env.DB, REPO, late);

    const response = await req(`/v1/repos/${REPO}/backups/old-small/restore`, {
      method: "POST",
      token,
      body: { confirm: REPO },
    });
    const body = await jsonOf(response);
    expect({ status: response.status, code: body.code }).toEqual({ status: 503, code: "unavailable" });
    expect(body.cutoffSeq).toBe(late[late.length - 1]!.seq);
    expect(body.foldedSeq).toBeLessThan(body.cutoffSeq);
    expect(response.headers.get("retry-after")).toBe("1");

    const backups = await env.DB.prepare(`SELECT backup_id FROM backups WHERE repo_id = ?1`).bind(REPO).all();
    expect(backups.results.map((row: any) => row.backup_id)).toEqual(["old-small"]);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM restores`).first<{ n: number }>())!.n).toBe(0);
    const repo = await env.DB.prepare(`SELECT vocabulary, epoch FROM repos WHERE repo_id = ?1`).bind(REPO).first<any>();
    expect(repo).toEqual({ vocabulary: null, epoch: 1 });
  });

  it("finishes a restore whose source checkpoint was cleared while it staged, folding it back a turn at a time", async () => {
    const ops = generateLog({ seed: 316, count: 2500, pool: 400 });
    await insertOps(env.DB, REPO, ops);
    await catchUp();
    const taken = await jsonOf(await req(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }));
    expect(taken.backup.entityCount).toBeGreaterThan(restoreStageEntities("free"));
    const before = content((await foldLog(env, REPO, 1, ops[ops.length - 1]!.seq)).entities);

    await restore(taken.backup.backupId, "any turn", async (turn) => {
      // After the first stage turn, the whole checkpoint goes, the source epoch's with it.
      if (turn === 2) {
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM fold_versions WHERE epoch = 1`),
          env.DB.prepare(`DELETE FROM fold_marks WHERE epoch = 1`),
        ]);
      }
    });
    expect(content((await snapshotAll()).entities)).toEqual(before);
  });

  it("restores a backup of an older epoch after the checkpoint was cleared, folding that epoch first", async () => {
    const ops = generateLog({ seed: 308, count: 2500, pool: 30 });
    await insertOps(env.DB, REPO, ops);
    // Pulls fold part of it; the backup folds the rest, a request at a time.
    for (let n = 0; n < 4; n += 1) await req(`/v1/repos/${REPO}/ops?limit=1`, { token });
    let taken: any;
    for (let folded = -1; ; ) {
      const response = await req(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} });
      taken = await jsonOf(response);
      if (response.status !== 503) break;
      expect(taken.foldedSeq).toBeGreaterThan(folded);
      folded = taken.foldedSeq;
    }
    const done = await restore(taken.backup.backupId);
    const undo = done.preRestoreBackupId as string;
    const before = content((await foldLog(env, REPO, 1, ops[ops.length - 1]!.seq)).entities);

    // worker/README.md's recovery recipe clears the checkpoint; it is rebuilt from `ops`.
    await env.DB.batch([env.DB.prepare(`DELETE FROM fold_versions`), env.DB.prepare(`DELETE FROM fold_marks`)]);

    await restore(undo, true);
    expect(content((await snapshotAll()).entities)).toEqual(before);
  });
});

describe("a repository of large documents", () => {
  /**
   * 300 documents of 40 KB each, and an edit of each: 24 MB of log, 12 MB of state, where every other test
   * here is kilobytes. The counts alone bound nothing now — 500 operations of this are 20 MB
   * to fold, 200 entities are 8 MB to stage, a 500-entity page is 12 MB to send — so each of
   * those is cut by bytes too, and still ends with every document where it should be.
   */
  it("folds, serves, backs up and restores in requests bounded by bytes as well as counts", async () => {
    const body = (n: number) => `${String(n).padStart(6, "0")} ${"d".repeat(40_000)}`;
    const ops: GeneratedOp[] = [];
    for (let n = 0; n < 600; n += 1) {
      const id = `doc-${String(n % 300).padStart(4, "0")}`;
      ops.push({
        seq: n + 1,
        epoch: 1,
        opId: `big-${n}`,
        deviceId: "device-a",
        entity: "document",
        entityId: id,
        verb: n < 300 ? "create" : "update",
        baseVersion: n < 300 ? null : 1,
        payload: JSON.stringify(n < 300 ? { title: id, body: body(n) } : { body: body(n) }),
        actor: "vp",
        clientSeq: n + 1,
        schema: 10,
        createdAt: "2026-09-11T00:00:00.000Z",
        serverTs: 1_789_000_000_000 + n,
      });
    }
    await insertOps(env.DB, REPO, ops);

    // A pull folds a step of at most FOLD_STEP_BYTES (plus the one operation that crosses it).
    await req(`/v1/repos/${REPO}/ops?limit=1`, { token });
    const first = await progress();
    expect(first).toBeLessThan(ops[40]!.seq);
    expect(first).toBeGreaterThan(0);

    const taken = await jsonOf(
      await (async () => {
        for (;;) {
          const response = await req(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} });
          if (response.status !== 503) return response;
        }
      })(),
    );
    expect(taken.backup.entityCount).toBe(300);

    // Pages cut by bytes: none past PAGE_BYTES but by the one entity that crosses it.
    const pages: any[][] = [];
    let cursor: string | null = null;
    let firstCutoff: number | undefined;
    for (;;) {
      const query: string = `?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await jsonOf(await req(`/v1/repos/${REPO}/snapshot${query}`, { token }));
      firstCutoff ??= page.cutoffSeq;
      pages.push(page.entities);
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(pages.length).toBeGreaterThan(8);
    for (const page of pages) expect(JSON.stringify(page).length).toBeLessThan(PAGE_BYTES + 100_000);
    // At the cutoff the first page pinned: wherever the fold had got.
    expect(content(pages.flat())).toEqual(content((await foldLog(env, REPO, 1, firstCutoff!)).entities));
    const expected = content((await foldLog(env, REPO, 1, taken.backup.cutoffSeq)).entities);

    // A restore turn stages no more than PAGE_BYTES of it, so it takes many turns.
    let turns = 0;
    const done = await restore(taken.backup.backupId, "never", async (turn) => {
      turns = turn + 1;
    });
    expect(done.entityCount).toBe(300);
    // 12 MB of documents at no more than PAGE_BYTES a turn, besides the begin and the commit.
    expect(turns).toBeGreaterThanOrEqual(2 + Math.floor((300 * 40_000) / PAGE_BYTES));
    expect(content((await snapshotAll()).entities)).toEqual(expected);
  }, 120_000);
});

describe("the epoch a restore fills", () => {
  async function begin(backupId: string): Promise<Response> {
    return req(`/v1/repos/${REPO}/backups/${backupId}/restore`, { method: "POST", token, body: { confirm: REPO } });
  }

  it("starts its checkpoint at the restore's guard, and is folded by the time it goes live", async () => {
    const ops = generateLog({ seed: 311, count: 1200, pool: 20 });
    await insertOps(env.DB, REPO, ops);
    for (let n = 0; n < 3; n += 1) await req(`/v1/repos/${REPO}/ops?limit=1`, { token });
    const head = ops[ops.length - 1]!.seq;
    const taken = await jsonOf(await req(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }));

    const begun = await jsonOf(await begin(taken.backup.backupId));
    const floor = await env.DB.prepare(`SELECT seq, op_count, kinds FROM fold_marks WHERE repo_id = ?1 AND epoch = 2`)
      .bind(REPO)
      .all();
    expect(floor.results).toEqual([{ seq: head, op_count: 0, kinds: "{}" }]);

    let restoreId = begun.restoreId;
    for (;;) {
      const body = await jsonOf(
        await req(`/v1/repos/${REPO}/backups/${taken.backup.backupId}/restore`, { method: "POST", token, body: { confirm: REPO, restoreId } }),
      );
      restoreId = body.restoreId;
      if (body.done) break;
    }
    const repo = (await env.DB.prepare(`SELECT last_seq FROM repos WHERE repo_id = ?1`).bind(REPO).first<{ last_seq: number }>())!;
    expect(await progress(2)).toBe(repo.last_seq);
    // So the first snapshot of the new epoch is the whole of it.
    const snapshot = await snapshotAll();
    expect(snapshot.cutoffSeq).toBe(repo.last_seq);
    expect(snapshot.entities).toHaveLength(taken.backup.entityCount);
  });

  it("clears fold rows an abandoned restore left in it, and folds the new one from its own rows", async () => {
    const ops = generateLog({ seed: 312, count: 600, pool: 15 });
    await insertOps(env.DB, REPO, ops);
    for (let n = 0; n < 2; n += 1) await req(`/v1/repos/${REPO}/ops?limit=1`, { token });
    const head = ops[ops.length - 1]!.seq;
    // What a restore abandoned after it staged leaves once its operations are removed: a
    // checkpoint of epoch 2 that describes rows no longer there.
    const ghost = generateLog({ seed: 313, count: 300, pool: 15, epoch: 2, firstSeq: head + 1 });
    await insertOps(env.DB, REPO, ghost);
    await advanceFold(env, REPO, 2, ghost[ghost.length - 1]!.seq, { budget: { remaining: 10_000 } });
    await env.DB.prepare(`DELETE FROM ops WHERE repo_id = ?1 AND epoch = 2`).bind(REPO).run();

    const taken = await jsonOf(await req(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }));
    await restore(taken.backup.backupId);
    const repo = (await env.DB.prepare(`SELECT last_seq FROM repos WHERE repo_id = ?1`).bind(REPO).first<{ last_seq: number }>())!;
    const served = await snapshotAll();
    expect(served.entities.map((e) => JSON.stringify(e.state))).toEqual(
      (await foldLog(env, REPO, 2, repo.last_seq)).entities.map((e) => JSON.stringify(e.state)),
    );
    expect(content(served.entities)).toEqual(content((await foldLog(env, REPO, 1, head)).entities));
  });

  it("refuses to begin while it holds operations an abandoned restore left, and changes nothing", async () => {
    const ops = generateLog({ seed: 314, count: 400, pool: 15 });
    await insertOps(env.DB, REPO, ops);
    await catchUp();
    await oldCaptureBackup(env.DB, REPO, { backupId: "before-orphans", deviceId: "device-a" });
    // A restore's staged rows whose `restores` row was deleted by hand, and nothing else.
    const orphans = generateLog({ seed: 315, count: 25, pool: 15, epoch: 2, firstSeq: ops[ops.length - 1]!.seq + 1 });
    await insertOps(env.DB, REPO, orphans);

    const response = await begin("before-orphans");
    const body = await jsonOf(response);
    expect({ status: response.status, code: body.code, epoch: body.epoch }).toEqual({ status: 409, code: "conflict", epoch: 2 });
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM backups`).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM restores`).first<{ n: number }>())!.n).toBe(0);
    expect(await env.DB.prepare(`SELECT vocabulary, epoch FROM repos WHERE repo_id = ?1`).bind(REPO).first()).toEqual({
      vocabulary: null,
      epoch: 1,
    });
  });
});

describe("a database the Worker before the checkpoint wrote", () => {
  /**
   * Written row by row as that Worker wrote them: an epoch of operations, an INLINE backup
   * of it, a committed restore into epoch 2 (its staged operations, its audit row and its
   * inline undo), and work in epoch 2 after it. No fold row exists anywhere. The new Worker
   * lists the backups, serves the snapshot, and restores both inline backups, with nothing
   * run in between.
   */
  it("is served, listed and restored with no step in between", async () => {
    const first = generateLog({ seed: 309, idSeed: 7, count: 3000, pool: 30 });
    await insertOps(env.DB, REPO, first);
    const b1 = await oldCaptureBackup(env.DB, REPO, { backupId: "old-manual", deviceId: "device-a" });
    const undo = await oldCaptureBackup(env.DB, REPO, { backupId: "old-undo", deviceId: "device-a", kind: "pre-restore" });

    // The old restore: B1's entities materialised into epoch 2, as `stageRestore` wrote them.
    const stored = JSON.parse(
      (await env.DB.prepare(`SELECT state FROM backups WHERE backup_id = 'old-manual'`).first<{ state: string }>())!.state,
    ) as { entities: any[] };
    let seq = b1.cutoffSeq + 10;
    const staged: GeneratedOp[] = stored.entities.map((entity, index) => {
      const { verb, payload } = materializedVerb(entity);
      seq += 1;
      return {
        seq,
        epoch: 2,
        opId: `restore-op-${index}`,
        deviceId: "device-a",
        entity: entity.entity,
        entityId: entity.entityId,
        verb,
        baseVersion: verb === "create" ? null : 0,
        payload: JSON.stringify(payload),
        actor: entity.createdBy ?? "restore:old-restore",
        clientSeq: index + 1,
        schema: 10,
        createdAt: entity.createdAt ?? "2026-09-10T00:00:00.000Z",
        serverTs: 1_789_000_000_000,
      };
    });
    const after = generateLog({ seed: 310, idSeed: 7, count: 1500, pool: 30, epoch: 2, firstSeq: seq + 1 });
    await insertOps(env.DB, REPO, [...staged, ...after]);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO restores (repo_id, restore_id, from_backup_id, pre_restore_backup_id, from_epoch, to_epoch,
                               guard_seq, entity_count, staged_count, status, device_id, actor, began_at, committed_at)
         VALUES (?1, 'old-restore', 'old-manual', 'old-undo', 1, 2, ?2, ?3, ?3, 'committed', 'device-a', NULL, 1, 2)`,
      ).bind(REPO, b1.cutoffSeq, staged.length),
      env.DB.prepare(`UPDATE repos SET epoch = 2 WHERE repo_id = ?1`).bind(REPO),
    ]);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM fold_marks`).first<{ n: number }>())!.n).toBe(0);

    const listed = await jsonOf(await req(`/v1/repos/${REPO}/backups`, { token }));
    expect(listed.backups.map((b: any) => [b.backupId, b.entityCount, b.cutoffSeq]).sort()).toEqual(
      [
        ["old-manual", b1.entityCount, b1.cutoffSeq],
        ["old-undo", undo.entityCount, undo.cutoffSeq],
      ].sort(),
    );

    // The restored epoch, as a device bootstrapping now reads it: the fold of epoch 2.
    const head = after[after.length - 1]!.seq;
    await catchUp(2);
    const served = await snapshotAll();
    expect(served.cutoffSeq).toBe(head);
    expect(served.entities.map((e) => JSON.stringify([e.entity, e.entityId, e.version, e.lastSeq, e.state, e.fieldWrites]))).toEqual(
      (await foldLog(env, REPO, 2, head)).entities.map((e) =>
        JSON.stringify([e.entity, e.entityId, e.version, e.lastSeq, e.state, e.fieldWrites]),
      ),
    );

    // Each inline backup restores, and a device then reads exactly what it held.
    const heldByUndo = JSON.parse(
      (await env.DB.prepare(`SELECT state FROM backups WHERE backup_id = 'old-undo'`).first<{ state: string }>())!.state,
    ) as { entities: any[] };
    await restore("old-undo");
    expect(content((await snapshotAll()).entities)).toEqual(content(heldByUndo.entities));
    await restore("old-manual");
    expect(content((await snapshotAll()).entities)).toEqual(content(stored.entities));
  }, 120_000);
});
