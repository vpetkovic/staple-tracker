/**
 * The kept fold IS the single-pass fold.
 *
 * Random logs, folded two ways: by `oracleFoldLog` — the single-pass fold this Worker ran
 * before the checkpoint, copied verbatim — and by the checkpoint in `src/fold-store.ts`,
 * advanced in random step sizes and random budgets and read at random cutoffs, most of
 * which fall between two marks. Every entity is compared as the bytes `JSON.stringify`
 * makes of it, so version, deletedAt, lastSeq, the verb, the state AND its key order,
 * fieldWrites and the created fields all have to agree, for every entity kind.
 *
 * The logs hold everything the fold has a rule for: tombstones, updates after a delete,
 * revives, a `replace` beside other keys, fields in both spellings (one payload naming
 * both, too), reopens, a restore's staged creates, payloads that are not objects,
 * integer-like keys, awkward ids in the order JavaScript and SQLite disagree about, gaps
 * in seq — and the two rules that reach across entities: two revisions written as one
 * number (the later renumbered, the same revision again dropped), and a status or kind
 * created again losing its place in an order written before.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodeCursor, entityKey } from "../src/cursor.js";
import { type FoldedEntity, foldLog, forBackup, materializedVerb } from "../src/fold.js";
import { restoreOrder } from "../src/backups.js";
import { advanceFold, entityCount, foldSummary, foldedPage, pinMark, restorePage } from "../src/fold-store.js";
import { call, jsonOf, seedRepo } from "./helpers.js";
import { type GeneratedOp, generateLog, insertOps, prng } from "./log-generator.js";

async function repoRow(repoId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, created_at) VALUES (?1, 1, 0, 0, 0)`,
  )
    .bind(repoId)
    .run();
}

/** The whole fold at a cutoff, read through the checkpoint in pages of random size. */
async function checkpointFold(
  repoId: string,
  epoch: number,
  cutoff: number,
  random: () => number,
): Promise<FoldedEntity[]> {
  const out: FoldedEntity[] = [];
  let after = "";
  for (;;) {
    // Pages cut by count or, as often, by bytes — a byte cap as small as one entity.
    const maxBytes = random() < 0.5 ? 1 + Math.floor(random() * 20_000) : undefined;
    const page = await foldedPage(env, repoId, epoch, cutoff, after, 1 + Math.floor(random() * 80), maxBytes);
    if (page.hasMore) expect(page.entities.length).toBeGreaterThan(0);
    out.push(...page.entities);
    if (!page.hasMore) return out;
    const last = page.entities[page.entities.length - 1]!;
    after = entityKey(last.entity, last.entityId);
  }
}

/** Equal byte for byte, entity by entity — and on failure, the first entity that differs. */
function expectSameFold(got: readonly unknown[], expected: readonly unknown[], context: string): void {
  const a = got.map((entity) => JSON.stringify(entity));
  const b = expected.map((entity) => JSON.stringify(entity));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) {
      expect({ context, index, got: a[index], expected: b[index] }).toEqual({
        context,
        index,
        got: b[index],
        expected: b[index],
      });
    }
  }
  expect(a.length).toBe(b.length);
}

/** A cutoff at or below `max`: sometimes an operation's seq, sometimes a gap, sometimes a mark. */
function someCutoff(ops: readonly GeneratedOp[], max: number, random: () => number): number {
  const eligible = ops.filter((op) => op.seq <= max);
  if (eligible.length === 0 || random() < 0.1) return max;
  const op = eligible[Math.floor(random() * eligible.length)]!;
  return random() < 0.2 ? Math.min(max, op.seq + 1) : op.seq;
}

async function compareAt(repoId: string, epoch: number, cutoff: number, random: () => number, context: string) {
  const expected = await foldLog(env, repoId, epoch, cutoff);
  expectSameFold(await checkpointFold(repoId, epoch, cutoff, random), expected.entities, `${context} cutoff=${cutoff}`);
  const summary = await foldSummary(env, repoId, epoch, cutoff);
  expect({
    opCount: summary.opCount,
    schemaVersion: summary.schemaVersion,
    entities: entityCount(summary),
    kinds: Object.keys(summary.kinds),
  }).toEqual({
    opCount: expected.opCount,
    schemaVersion: expected.schemaVersion,
    entities: expected.entities.length,
    kinds: [...new Set(expected.entities.map((entity) => entity.entity))].sort(),
  });

  // Half the time, make the cutoff a mark — as a backup taken there does, often after later
  // steps have passed it — and page it the way a restore stages it: in `restoreOrder`, over
  // what `forBackup` makes of the single-pass fold. Later rounds then read beside the versions
  // the pin added, so a pin that disturbed any other cutoff fails there.
  if (random() < 0.5) {
    // Where pages are cut must not depend on whether the cutoff is a mark: before the pin, the
    // tail's entities are measured in the isolate; after it, in SQLite. Both in UTF-8 bytes.
    const cuts = async () => {
      const lengths: number[] = [];
      let after = "";
      for (;;) {
        const page = await foldedPage(env, repoId, epoch, cutoff, after, 40, 2_000);
        lengths.push(page.entities.length);
        if (!page.hasMore) return lengths;
        const last = page.entities[page.entities.length - 1]!;
        after = entityKey(last.entity, last.entityId);
      }
    };
    const before = await cuts();
    const pinned = await pinMark(env, repoId, epoch, cutoff);
    expect(await cuts(), `${context} page cuts at cutoff=${cutoff}`).toEqual(before);
    expect(pinned.opCount).toBe(expected.opCount);
    const staged: unknown[] = [];
    let after: string | null = null;
    for (;;) {
      const maxBytes = random() < 0.5 ? 1 + Math.floor(random() * 20_000) : undefined;
      const page = await restorePage(env, repoId, epoch, cutoff, after, 1 + Math.floor(random() * 80), maxBytes);
      if (page.length === 0) break;
      staged.push(...page.map(forBackup));
      const last = page[page.length - 1]!;
      after = entityKey(last.entity, last.entityId);
    }
    expectSameFold(staged, restoreOrder(expected.entities.map(forBackup)), `${context} restore order cutoff=${cutoff}`);
  }
}

const SEEDS = Array.from({ length: 24 }, (_, index) => 1000 + index * 37);

describe("the checkpoint reproduces the single-pass fold", () => {
  it.each(SEEDS)("seed %i: at every cutoff, whatever the steps and budgets", async (seed) => {
    const random = prng(seed * 7919);
    const repoId = `repo-${seed}`;
    await repoRow(repoId);
    const ops = generateLog({
      seed,
      count: 150 + Math.floor(random() * 1500),
      pool: 6 + Math.floor(random() * 30),
      registry: seed % 3 === 0,
    });
    await insertOps(env.DB, repoId, ops);
    const head = ops[ops.length - 1]!.seq;
    const stepOps = 1 + Math.floor(random() * 150);
    // Small enough, often, that a step stops on bytes before it stops on count.
    const stepBytes = random() < 0.5 ? 200 + Math.floor(random() * 20_000) : undefined;

    let progress = 0;
    let rounds = 0;
    while (progress < head) {
      // A target anywhere ahead — an operation's seq or a gap — and a budget that may stop short of it.
      const target = Math.min(head, progress + 1 + Math.floor(random() * 500));
      const mark = await advanceFold(env, repoId, 1, target, {
        budget: { remaining: 1 + Math.floor(random() * 400), ...(random() < 0.3 ? { bytes: 1 + Math.floor(random() * 30_000) } : {}) },
        stepOps,
        ...(stepBytes ? { stepBytes } : {}),
      });
      expect(mark.seq).toBeGreaterThan(progress);
      progress = mark.seq;
      rounds += 1;
      await compareAt(repoId, 1, someCutoff(ops, progress, random), random, `seed=${seed} round=${rounds}`);
    }
    await compareAt(repoId, 1, head, random, `seed=${seed} head`);
  }, 120_000);
});

describe("long revision histories and wide states, in steps of every size down to one operation", () => {
  /**
   * Revision creates are placed against the few revisions D1 is asked for, overlaid with what the
   * step has folded (`fold-revisions.ts`), and steps are cut by work (`foldRun`). So these logs are
   * built to make both matter: documents saved hundreds of times with contested, stale, re-sent and
   * doubly spelled numbers, deleted and edited revisions, bodies alike at both ends; issues whose
   * descriptions are tens of kilobytes of quotes. They are folded in steps whose work, operations,
   * placement reads and walk are all random — a step of one operation often, and a budget spent so
   * that a step folds nothing — and compared with `foldLog` at cutoffs along the way.
   */
  const HEAVY = Array.from({ length: 10 }, (_, index) => 5000 + index * 101);
  it.each(HEAVY)("seed %i", async (seed) => {
    const random = prng(seed * 31337);
    const repoId = `heavy-${seed}`;
    await repoRow(repoId);
    const ops = generateLog({
      seed,
      count: 700 + Math.floor(random() * 1300),
      pool: 8,
      heavyRevisions: 150,
      wide: seed % 2 === 0 ? 2 : 0,
    });
    await insertOps(env.DB, repoId, ops);
    const head = ops[ops.length - 1]!.seq;

    let progress = 0;
    let rounds = 0;
    while (progress < head) {
      const target = Math.min(head, progress + 1 + Math.floor(random() * 300));
      const options = () => ({
        stepOps: 1 + Math.floor(random() * 120),
        stepWork: random() < 0.3 ? 1 : 1 + Math.floor(random() * 6_000_000),
        stepReads: Math.floor(random() * 4),
        stepWalk: 1 + Math.floor(random() * 40),
      });
      let mark = await advanceFold(env, repoId, 1, target, {
        budget: {
          remaining: 1 + Math.floor(random() * 300),
          ...(random() < 0.5 ? { work: 1 + Math.floor(random() * 3_000_000) } : {}),
          // A request that has already spent its budget on something else: a step may fold nothing.
          ...(random() < 0.3 ? { folded: true } : {}),
        },
        ...options(),
      });
      // A request that has spent nothing always folds at least one operation.
      if (mark.seq === progress) mark = await advanceFold(env, repoId, 1, target, { budget: { remaining: 1, work: 1 }, ...options() });
      expect(mark.seq).toBeGreaterThan(progress);
      progress = mark.seq;
      rounds += 1;
      if (rounds % 3 === 0) await compareAt(repoId, 1, someCutoff(ops, progress, random), random, `seed=${seed} round=${rounds}`);
    }
    await compareAt(repoId, 1, head, random, `seed=${seed} head`);
  }, 300_000);
});

describe("the snapshot route serves the single-pass fold", () => {
  /**
   * Through `GET /snapshot`, at the head and at cutoffs pinned in cursors — the path a
   * cursor from an older Worker takes, since this one never handed it out. The wire form
   * is `toWireEntity` in `src/snapshot.ts`, rebuilt from the oracle's entities.
   */
  it.each(SEEDS.slice(0, 6))("seed %i", async (seed) => {
    const random = prng(seed * 104729);
    const token = await seedRepo();
    const repoId = "11111111-1111-4111-8111-111111111111";
    const ops = generateLog({ seed, count: 300 + Math.floor(random() * 1200), pool: 10, registry: seed % 3 === 0 });
    await insertOps(env.DB, repoId, ops);
    const head = ops[ops.length - 1]!.seq;
    const protocol = seed % 3 === 0 ? 2 : 1;

    // A first page (its cutoff is wherever the fold got), then cutoffs pinned in cursors —
    // the head and two anywhere below it — which the route folds towards, a budget at a time,
    // answering "still folding" until it is there, exactly as a client meets it.
    for (const pinned of [null, head, someCutoff(ops, head, random), someCutoff(ops, head, random)]) {
      let cursor: string | null = pinned === null ? null : encodeCursor({ v: 1, r: repoId, e: 1, c: pinned, k: "" });
      let cutoff = pinned;
      const got: unknown[] = [];
      let folded = -1;
      for (;;) {
        const limit = 1 + Math.floor(random() * 120);
        const query = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const response = await call(`/v1/repos/${repoId}/snapshot${query}`, { token, protocol });
        const body = await jsonOf(response);
        if (response.status === 503 && got.length === 0 && typeof body.foldedSeq === "number") {
          expect(body.foldedSeq).toBeGreaterThan(folded);
          folded = body.foldedSeq;
          continue;
        }
        expect(response.status, JSON.stringify(body).slice(0, 200)).toBe(200);
        cutoff ??= body.cutoffSeq;
        expect(body.cutoffSeq).toBe(cutoff);
        got.push(...body.entities);
        if (!body.hasMore) break;
        cursor = body.nextCursor;
      }
      const expected = (await foldLog(env, repoId, 1, cutoff!)).entities.map((entity) => ({
        entity: entity.entity,
        entityId: entity.entityId,
        version: entity.version,
        deletedAt: entity.deletedAt,
        lastSeq: entity.lastSeq,
        verb: materializedVerb(entity).verb,
        state: entity.state,
        fieldWrites: entity.fieldWrites,
        createdSeq: entity.createdSeq,
        createdAt: entity.createdAt ?? null,
        createdBy: entity.createdBy ?? null,
      }));
      expectSameFold(got, expected, `seed=${seed} cutoff=${cutoff} pinned=${pinned}`);
    }
  }, 120_000);
});
