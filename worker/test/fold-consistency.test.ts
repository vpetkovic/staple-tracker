/**
 * The checkpoint under concurrency and across epochs.
 *
 * Two properties, each checked against the single-pass oracle at many cutoffs:
 *
 *   - A checkpoint is never read across an epoch change. A restore moves the repository to
 *     a new epoch whose operations reuse the old one's entity ids at higher seqs; folding or
 *     reading the new epoch must never see a mark or a version of the old.
 *   - Nothing concurrent tears it: two requests advancing at once, with different steps and
 *     interleaved at every point a step has; a push landing between a step's read and its
 *     write; a step that dies before its batch.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { entityKey } from "../src/cursor.js";
import { restoreOrder } from "../src/backups.js";
import { type FoldedEntity, foldLog, forBackup, materializedVerb } from "../src/fold.js";
import { advanceFold, foldProgress, foldedPage, pinMark, restorePage } from "../src/fold-store.js";
import { REPO, call, jsonOf, seedRepo } from "./helpers.js";
import { type GeneratedOp, generateLog, insertOps, prng } from "./log-generator.js";

const BIG = { remaining: 1_000_000 };

async function repoRow(repoId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, created_at) VALUES (?1, 1, 0, 0, 0)`,
  )
    .bind(repoId)
    .run();
}

async function wholeFold(repoId: string, epoch: number, cutoff: number): Promise<string[]> {
  const out: FoldedEntity[] = [];
  let after = "";
  for (;;) {
    const page = await foldedPage(env, repoId, epoch, cutoff, after, 97);
    out.push(...page.entities);
    if (!page.hasMore) return out.map((entity) => JSON.stringify(entity));
    const last = page.entities[page.entities.length - 1]!;
    after = entityKey(last.entity, last.entityId);
  }
}

/** At every operation's seq up to `head` (sampled), the kept fold is the oracle's. */
async function expectFoldEverywhere(repoId: string, epoch: number, ops: readonly GeneratedOp[], head: number): Promise<void> {
  const seqs = ops.filter((op) => op.epoch === epoch && op.seq <= head).map((op) => op.seq);
  const every = Math.max(1, Math.floor(seqs.length / 25));
  for (const cutoff of [...seqs.filter((_, index) => index % every === 0), head]) {
    const expected = (await foldLog(env, repoId, epoch, cutoff)).entities.map((entity) => JSON.stringify(entity));
    expect({ epoch, cutoff, fold: await wholeFold(repoId, epoch, cutoff) }).toEqual({ epoch, cutoff, fold: expected });
  }
}

describe("a checkpoint is never read across an epoch change", () => {
  it("folds a new epoch from its own operations, over the same entity ids, beside a folded old one", async () => {
    const repoId = "repo-epochs";
    await repoRow(repoId);
    // The same ids in both epochs (one id seed), different operations, the new one above.
    const first = generateLog({ seed: 71, idSeed: 5, count: 900, pool: 12 });
    const firstHead = first[first.length - 1]!.seq;
    const second = generateLog({ seed: 72, idSeed: 5, count: 700, pool: 12, epoch: 2, firstSeq: firstHead + 50 });
    await insertOps(env.DB, repoId, first);
    await advanceFold(env, repoId, 1, firstHead, { budget: { ...BIG }, stepOps: 83 });
    await insertOps(env.DB, repoId, second);
    await env.DB.prepare(`UPDATE repos SET epoch = 2 WHERE repo_id = ?1`).bind(repoId).run();

    // Epoch 2 has no marks of its own yet, however far epoch 1 got.
    expect((await foldProgress(env, repoId, 2)).seq).toBe(0);
    const secondHead = second[second.length - 1]!.seq;
    await advanceFold(env, repoId, 2, secondHead, { budget: { ...BIG }, stepOps: 61 });

    await expectFoldEverywhere(repoId, 2, second, secondHead);
    // And the old epoch still reads as it was: a restore of one of its backups needs it.
    await expectFoldEverywhere(repoId, 1, first, firstHead);
  }, 120_000);

  /**
   * Epochs do not own ranges of seq. A restore stages its rows into the next epoch while
   * pushes may still land in the current one, so the two interleave — which is when a read
   * that forgot its epoch would find the other epoch's newer version of the same entity.
   */
  it("keeps two epochs apart when their seqs interleave", async () => {
    const repoId = "repo-interleaved";
    await repoRow(repoId);
    const first = generateLog({ seed: 74, idSeed: 6, count: 800, pool: 8, gapRate: 0 });
    const second = generateLog({ seed: 75, idSeed: 6, count: 800, pool: 8, epoch: 2, gapRate: 0 });
    // Seqs dealt out alternately, in runs, so each epoch's operations sit between the other's.
    const random = prng(11);
    const merged: GeneratedOp[] = [];
    let a = 0;
    let b = 0;
    while (a < first.length || b < second.length) {
      const run = 1 + Math.floor(random() * 20);
      const takeFirst = b >= second.length || (a < first.length && random() < 0.5);
      for (let n = 0; n < run; n += 1) {
        const op = takeFirst ? first[a++] : second[b++];
        if (op) merged.push({ ...op, seq: merged.length + 1 });
      }
    }
    await insertOps(env.DB, repoId, merged);
    const head = merged.length;
    // Advance both epochs in alternation, each in small steps, so every step of one reads
    // versions the other has just written at nearby seqs.
    for (let progress = 0; progress < head; progress += 97) {
      const target = Math.min(head, progress + 97);
      await advanceFold(env, repoId, 1, target, { budget: { ...BIG }, stepOps: 29 });
      await advanceFold(env, repoId, 2, target, { budget: { ...BIG }, stepOps: 31 });
    }
    await expectFoldEverywhere(repoId, 1, merged, head);
    await expectFoldEverywhere(repoId, 2, merged, head);
  }, 120_000);

  it("serves a device bootstrapping after a real restore the new epoch, and refuses its old cursor", async () => {
    const token = await seedRepo();
    await call(`/v1/repos/${REPO}/backup`, { method: "PUT", token, body: { enabled: true } });
    const ops = generateLog({ seed: 73, count: 1500, pool: 20 });
    await insertOps(env.DB, REPO, ops);
    const head = ops[ops.length - 1]!.seq;

    // A snapshot of epoch 1 begun before the restore, its cursor kept.
    let before: any;
    for (;;) {
      const response = await call(`/v1/repos/${REPO}/snapshot?limit=10`, { token });
      before = await jsonOf(response);
      if (response.status === 200) break;
    }
    expect(before.hasMore).toBe(true);

    let created = await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} });
    while (created.status === 503) created = await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} });
    const backup = (await jsonOf(created)).backup;
    let restoreId: string | undefined;
    for (;;) {
      const response = await call(`/v1/repos/${REPO}/backups/${backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO, ...(restoreId ? { restoreId } : {}) },
      });
      const body = await jsonOf(response);
      if (response.status === 503) continue;
      expect(response.status, JSON.stringify(body)).toBe(200);
      restoreId = body.restoreId;
      if (body.done) break;
    }

    const stale = await call(`/v1/repos/${REPO}/snapshot?cursor=${encodeURIComponent(before.nextCursor)}`, { token });
    expect(stale.status).toBe(409);
    expect((await jsonOf(stale)).code).toBe("epoch_changed");

    // The new epoch, through the route: the oracle's fold of epoch 2, entity for entity, and
    // the backup's content, field for field.
    const repo = (await env.DB.prepare(`SELECT epoch, last_seq FROM repos WHERE repo_id = ?1`).bind(REPO).first<{ epoch: number; last_seq: number }>())!;
    expect(repo.epoch).toBe(2);
    const served: any[] = [];
    let cursor: string | null = null;
    for (;;) {
      const query: string = `?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot${query}`, { token }));
      served.push(...body.entities);
      if (!body.hasMore) break;
      cursor = body.nextCursor;
    }
    const restored = (await foldLog(env, REPO, 2, repo.last_seq)).entities;
    expect(served.map((e) => [e.entity, e.entityId, e.version, e.lastSeq, JSON.stringify(e.state)])).toEqual(
      restored.map((e) => [e.entity, e.entityId, e.version, e.lastSeq, JSON.stringify(e.state)]),
    );
    // A restore materialises a tombstone as a bare `delete` and a superseded entity as a
    // `replace` (`materializedVerb`), and only a `create` carries its time back.
    const original = (await foldLog(env, REPO, 1, head)).entities;
    const restoredAs = (e: any) => [
      e.entityId,
      e.deletedAt === null,
      JSON.stringify(e.deletedAt === null ? e.state : {}),
      e.deletedAt === null && !e.superseded && e.verb !== "replace" ? e.createdAt : "-",
    ];
    expect(served.map(restoredAs)).toEqual(original.map(restoredAs));
  }, 120_000);
});

describe("nothing concurrent tears the checkpoint", () => {
  for (const seam of ["afterRead", "beforeWrite"] as const) {
    it(`two advances interleaved at ${seam}, with different steps, leave the oracle's fold`, async () => {
      const repoId = `repo-race-${seam}`;
      await repoRow(repoId);
      const ops = generateLog({ seed: 81, count: 1200, pool: 10 });
      await insertOps(env.DB, repoId, ops);
      const head = ops[ops.length - 1]!.seq;
      const random = prng(9);

      // Every step of A lets B run a few steps of its own, of another size, to another target.
      let rounds = 0;
      await advanceFold(env, repoId, 1, head, {
        budget: { ...BIG },
        stepOps: 97,
        [seam]: async () => {
          rounds += 1;
          const progress = (await foldProgress(env, repoId, 1)).seq;
          await advanceFold(env, repoId, 1, Math.min(head, progress + 1 + Math.floor(random() * 300)), {
            budget: { remaining: 1 + Math.floor(random() * 150) },
            stepOps: 41,
          });
        },
      });
      expect(rounds).toBeGreaterThan(3);
      await expectFoldEverywhere(repoId, 1, ops, head);
    }, 120_000);
  }

  it("a push landing between a step's read and its write is folded by the next step, not claimed by this one", async () => {
    const repoId = "repo-push";
    await repoRow(repoId);
    const ops = generateLog({ seed: 91, count: 1600, pool: 10 });
    const early = ops.slice(0, 800);
    const late = ops.slice(800);
    await insertOps(env.DB, repoId, early);
    const target = early[early.length - 1]!.seq;

    let pushed = false;
    const mark = await advanceFold(env, repoId, 1, target, {
      budget: { ...BIG },
      beforeWrite: async () => {
        if (pushed) return;
        pushed = true;
        await insertOps(env.DB, repoId, late);
      },
    });
    expect(pushed).toBe(true);
    expect(mark.seq).toBe(target);

    const head = late[late.length - 1]!.seq;
    await advanceFold(env, repoId, 1, head, { budget: { ...BIG } });
    await expectFoldEverywhere(repoId, 1, ops, head);
  }, 120_000);

  /**
   * A backup pins its cutoff as a mark (`pinMark`) while another request's step folds past it,
   * each writing versions of the same entities, some at the same seqs. Interleaved at both of
   * the step's seams, at cutoffs inside the run that step is folding: the fold stays the
   * oracle's at every cutoff, and each pinned cutoff pages a restore in `restoreOrder`.
   */
  for (const seam of ["afterRead", "beforeWrite"] as const) {
    it(`a pin interleaved with a step at ${seam}, inside that step's run, leaves the oracle's fold`, async () => {
      const repoId = `repo-pin-${seam}`;
      await repoRow(repoId);
      const ops = generateLog({ seed: 111, count: 1500, pool: 12 });
      await insertOps(env.DB, repoId, ops);
      const head = ops[ops.length - 1]!.seq;
      const random = prng(13);
      const pinned: number[] = [];
      await advanceFold(env, repoId, 1, head, {
        budget: { ...BIG },
        stepOps: 120,
        [seam]: async () => {
          const progress = (await foldProgress(env, repoId, 1)).seq;
          const inside = ops.filter((op) => op.seq > progress && op.seq <= progress + 120);
          if (inside.length === 0) return;
          const cutoff = inside[Math.floor(random() * inside.length)]!.seq;
          await pinMark(env, repoId, 1, cutoff);
          pinned.push(cutoff);
        },
      });
      expect(pinned.length).toBeGreaterThan(5);
      await expectFoldEverywhere(repoId, 1, ops, head);
      for (const cutoff of pinned.slice(0, 6)) {
        const staged: string[] = [];
        let after: string | null = null;
        for (;;) {
          const page = await restorePage(env, repoId, 1, cutoff, after, 37);
          if (page.length === 0) break;
          staged.push(...page.map((entity) => JSON.stringify(forBackup(entity))));
          const last = page[page.length - 1]!;
          after = entityKey(last.entity, last.entityId);
        }
        const expected = restoreOrder((await foldLog(env, repoId, 1, cutoff)).entities.map(forBackup));
        expect({ cutoff, staged }).toEqual({ cutoff, staged: expected.map((entity) => JSON.stringify(entity)) });
      }
    }, 120_000);
  }

  /**
   * A backup restored after the log moved on past it — renumbers, re-creates, edits — with the
   * checkpoint folding the old epoch again between every restore turn. The new epoch is the
   * backup's fold, staged in its order, and nothing past the cutoff leaks in.
   */
  it("a restore staged while the checkpoint folds past its backup stages exactly the backup", async () => {
    const token = await seedRepo();
    await call(`/v1/repos/${REPO}/backup`, { method: "PUT", token, body: { enabled: true } });
    const ops = generateLog({ seed: 121, count: 1400, pool: 25 });
    const early = ops.slice(0, 900);
    await insertOps(env.DB, REPO, early);
    let taken: any;
    for (;;) {
      const response = await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} });
      taken = await jsonOf(response);
      if (response.status !== 503) break;
    }
    const cutoff = taken.backup.cutoffSeq as number;
    expect(cutoff).toBe(early[early.length - 1]!.seq);
    const expected = restoreOrder((await foldLog(env, REPO, 1, cutoff)).entities.map(forBackup));

    const late = ops.slice(900);
    await insertOps(env.DB, REPO, late);
    await advanceFold(env, REPO, 1, late[late.length - 1]!.seq, { budget: { ...BIG }, stepOps: 70 });

    let restoreId: string | undefined;
    let toEpoch = 0;
    for (let turn = 0; turn < 100; turn += 1) {
      const response = await call(`/v1/repos/${REPO}/backups/${taken.backup.backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO, ...(restoreId ? { restoreId } : {}) },
      });
      const body = await jsonOf(response);
      if (response.status === 503) continue;
      expect(response.status, JSON.stringify(body)).toBe(200);
      restoreId = body.restoreId;
      toEpoch = body.toEpoch;
      if (body.done) break;
      // Another request's fold of the old epoch between turns: nothing new at or below the cutoff.
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM fold_marks WHERE repo_id = ?1 AND epoch = 1 AND seq > ?2`).bind(REPO, cutoff),
        env.DB.prepare(`DELETE FROM fold_versions WHERE repo_id = ?1 AND epoch = 1 AND seq > ?2`).bind(REPO, cutoff),
      ]);
      await advanceFold(env, REPO, 1, late[late.length - 1]!.seq, { budget: { ...BIG }, stepOps: 50 + turn * 13 });
    }
    const staged = await env.DB.prepare(`SELECT entity, entity_id, verb, payload FROM ops WHERE repo_id = ?1 AND epoch = ?2 ORDER BY seq`)
      .bind(REPO, toEpoch)
      .all<{ entity: string; entity_id: string; verb: string; payload: string }>();
    expect(staged.results.map((row) => [row.entity, row.entity_id, row.verb, JSON.parse(row.payload)])).toEqual(
      expected.map((entity) => [entity.entity, entity.entityId, materializedVerb(entity).verb, materializedVerb(entity).payload]),
    );
  }, 120_000);

  it("a step that dies before its batch writes nothing, and the next one folds as if it never ran", async () => {
    const repoId = "repo-crash";
    await repoRow(repoId);
    const ops = generateLog({ seed: 101, count: 700, pool: 10 });
    await insertOps(env.DB, repoId, ops);
    const head = ops[ops.length - 1]!.seq;

    await advanceFold(env, repoId, 1, ops[299]!.seq, { budget: { ...BIG }, stepOps: 100 });
    const before = (await foldProgress(env, repoId, 1)).seq;
    await expect(
      advanceFold(env, repoId, 1, head, {
        budget: { ...BIG },
        stepOps: 100,
        beforeWrite: async () => {
          throw new Error("the isolate died");
        },
      }),
    ).rejects.toThrow("the isolate died");
    expect((await foldProgress(env, repoId, 1)).seq).toBe(before);
    const stray = await env.DB.prepare(`SELECT COUNT(*) AS n FROM fold_versions WHERE repo_id = ?1 AND seq > ?2`)
      .bind(repoId, before)
      .first<{ n: number }>();
    expect(stray!.n).toBe(0);

    await advanceFold(env, repoId, 1, head, { budget: { ...BIG }, stepOps: 100 });
    await expectFoldEverywhere(repoId, 1, ops, head);
  }, 120_000);
});
