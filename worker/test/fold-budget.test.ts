/**
 * A fold step, a pull, a snapshot page and a restore turn are bounded by the WORK they do, not
 * only by how many operations or bytes they touch.
 *
 * Isolate time cannot be measured inside this runtime, so these pin what bounds it: the rows and
 * bytes D1 hands the isolate, the statements a request issues, the estimated work a step is cut
 * at (`fold-work.ts`), and what a request folds when its budget is spent. Each fails when the bound
 * it pins is taken away.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { type FoldBudget, advanceFold, foldProgress } from "../src/fold-store.js";
import { runWork } from "../src/fold-work.js";
import { FOLD_STEP_WORK, requestWork } from "../src/limits.js";
import { DEVICE, ORIGIN, REPO, seedRepo } from "./helpers.js";
import { type GeneratedOp, insertOps } from "./log-generator.js";

/** What D1 handed the isolate, and what was asked of it. */
interface Meter {
  statements: number;
  rows: number;
  bytes: number;
  sql: string[];
  rowsRead: Map<string, number>;
}

function metered(db: D1Database, meter: Meter): D1Database {
  const take = (sql: string, result: D1Result<unknown>) => {
    meter.rows += result.results?.length ?? 0;
    for (const row of (result.results ?? []) as Array<Record<string, unknown>>) {
      for (const value of Object.values(row)) meter.bytes += typeof value === "string" ? value.length : 8;
    }
    meter.rowsRead.set(sql, (meter.rowsRead.get(sql) ?? 0) + (result.meta?.rows_read ?? 0));
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "__inner") return target;
        if (property === "__sql") return sql;
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === "all" || property === "run") {
          return async () => {
            meter.statements += 1;
            meter.sql.push(sql);
            const result = await (target[property] as () => Promise<D1Result<unknown>>).call(target);
            take(sql, result);
            return result;
          };
        }
        if (property === "first") {
          return async (column?: string) => {
            meter.statements += 1;
            meter.sql.push(sql);
            const result = await target.all();
            take(sql, result);
            const row = (result.results[0] ?? null) as Record<string, unknown> | null;
            return column === undefined || row === null ? row : (row[column] ?? null);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          meter.statements += statements.length;
          const results = await target.batch(statements.map((s) => (s as unknown as { __inner: D1PreparedStatement }).__inner ?? s));
          results.forEach((result, index) => {
            const sql = (statements[index] as unknown as { __sql?: string }).__sql ?? "?";
            meter.sql.push(sql);
            take(sql, result);
          });
          return results;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function meter(): Meter {
  return { statements: 0, rows: 0, bytes: 0, sql: [], rowsRead: new Map() };
}

let token: string;

beforeEach(async () => {
  token = await seedRepo();
  await env.DB.prepare(`UPDATE repos SET backup_enabled = 1 WHERE repo_id = ?1`).bind(REPO).run();
});

/** One operation, as `ops` stores it. */
function op(seq: number, entity: string, entityId: string, verb: string, payload: unknown): GeneratedOp {
  return {
    seq,
    epoch: 1,
    opId: `budget-${seq}`,
    deviceId: DEVICE,
    entity,
    entityId,
    verb,
    baseVersion: verb === "create" ? null : 1,
    payload: JSON.stringify(payload),
    actor: "alice",
    clientSeq: seq,
    schema: 10,
    createdAt: "2026-09-17T00:00:00.000Z",
    serverTs: 1_789_000_000_000 + seq,
  };
}

/** A worklog's saves: revision `from` to `from + count - 1` of one document, each a new body. */
function saves(firstSeq: number, from: number, count: number, tag = "entry"): GeneratedOp[] {
  return Array.from({ length: count }, (_, index) =>
    op(firstSeq + index, "documentRevision", `issue-1/worklog/${from + index}`, "create", {
      issueId: "issue-1",
      key: "worklog",
      revision: from + index,
      body: `# Worklog\n\n"${tag} ${from + index}" \\ ${"w".repeat(200)}`,
      author: "alice",
      changeSummary: null,
    }),
  );
}

/** A description of `bytes` of JSON text, nearly all of it escapes. */
const quoted = (bytes: number, tag: string) => `${tag}${'"'.repeat(Math.floor(bytes / 2))}`;

async function head(): Promise<number> {
  return (await env.DB.prepare(`SELECT last_seq FROM repos WHERE repo_id = ?1`).bind(REPO).first<{ last_seq: number }>())!.last_seq;
}

async function foldAll(): Promise<void> {
  await advanceFold(env, REPO, 1, await head(), { budget: { remaining: Number.MAX_SAFE_INTEGER } });
}

async function send(path: string, db: D1Database, method = "GET", body?: unknown): Promise<{ status: number; json: any }> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Staple-Protocol": "1", "Staple-Device": DEVICE };
  if (text !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(new TextEncoder().encode(text).length);
  }
  const response = await worker.fetch(
    new Request(`${ORIGIN}/v1/repos/${REPO}${path}`, { method, headers, body: text }),
    { ...env, DB: db, SYNC_LIMITER: undefined } as never,
  );
  return { status: response.status, json: await response.json() };
}

describe("placing a revision", () => {
  /**
   * The same saves onto a document of 100 revisions and onto one of 3,000: what a step reads from
   * D1 does not grow with the document. Reading the document's revisions to place each save — the
   * step before this one — handed the isolate every one of them.
   */
  it("reads what a save can collide with, however many revisions its document holds", async () => {
    const handed: Array<{ rows: number; bytes: number; statements: number }> = [];
    for (const held of [100, 3000]) {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM ops`),
        env.DB.prepare(`DELETE FROM fold_versions`),
        env.DB.prepare(`DELETE FROM fold_marks`),
        env.DB.prepare(`UPDATE repos SET last_seq = 0 WHERE repo_id = ?1`).bind(REPO),
      ]);
      await insertOps(env.DB, REPO, saves(1, 1, held));
      await foldAll();
      // Forty more saves, two claiming a number already held and one the first number of all.
      const more = saves(held + 1, held + 1, 40);
      more[10] = saves(held + 11, held - 1, 1, "again")[0]!;
      more[20] = saves(held + 21, 1, 1, "again")[0]!;
      await insertOps(env.DB, REPO, more);
      const m = meter();
      const mark = await advanceFold({ ...env, DB: metered(env.DB, m) }, REPO, 1, await head(), {
        budget: { remaining: 500, work: 100 * FOLD_STEP_WORK },
        stepWork: 100 * FOLD_STEP_WORK,
      });
      expect(mark.seq).toBe(await head());
      handed.push({ rows: m.rows, bytes: m.bytes, statements: m.statements });
    }
    const [small, large] = handed as [(typeof handed)[0], (typeof handed)[0]];
    expect(large.statements).toBe(small.statements);
    expect(large.rows).toBeLessThanOrEqual(small.rows + 10);
    expect(large.bytes).toBeLessThan(small.bytes + 20_000);
    // A few rows a save, not a document's worth.
    expect(large.rows).toBeLessThan(40 * 10);
  }, 120_000);

  /**
   * Saves whose placements need more than was read ahead — each claims a number past the runs a
   * step reads first — end the step once it has made its reads, and the rest fold in the next.
   */
  it("reads a bounded number of times a step, and ends the step before a save that needs more", async () => {
    // Revisions 1..400 with every other number deleted: 200 runs of one number each.
    const ops = saves(1, 1, 400);
    let seq = 400;
    for (let n = 2; n <= 400; n += 2) ops.push(op(++seq, "documentRevision", `issue-1/worklog/${n}`, "delete", {}));
    await insertOps(env.DB, REPO, ops);
    await foldAll();
    // New saves, each claiming a number far above the last one's runs.
    const claims = Array.from({ length: 30 }, (_, index) => saves(seq + 1 + index, 1 + index * 13, 1, "late")[0]!);
    await insertOps(env.DB, REPO, claims);

    const m = meter();
    const steps: Array<{ runs: number }> = [];
    let seen = 0;
    await advanceFold({ ...env, DB: metered(env.DB, m) }, REPO, 1, await head(), {
      budget: { remaining: 500, work: 100 * FOLD_STEP_WORK },
      stepWork: 100 * FOLD_STEP_WORK,
      // Each step's reads of runs, counted when it has folded and before it writes.
      beforeWrite: async () => {
        const runs = m.sql.slice(seen).filter((sql) => sql.includes("islands AS")).length;
        seen = m.sql.length;
        steps.push({ runs });
      },
    });
    expect((await foldProgress(env, REPO, 1)).seq).toBe(await head());
    // More than one step: a step stopped at its reads, and the next went on from the save it stopped at.
    expect(steps.length).toBeGreaterThan(1);
    // The one planned read of runs, and no more than a step's reads beside it.
    for (const step of steps) expect(step.runs).toBeLessThanOrEqual(1 + 4);
  }, 120_000);
});

describe("a fold step's work", () => {
  /**
   * Five hundred issues whose descriptions are 30 KB of quotes: 15 MB of the JSON V8 is slowest at,
   * which the step before this one folded in one step and wrote back in 80 statements. A step is
   * now cut at its estimated work, which bounds what it reads, what it writes and its statements.
   */
  it("is cut at its estimate, and so are the bytes and statements a step writes", async () => {
    const ops: GeneratedOp[] = [];
    for (let n = 0; n < 500; n += 1) {
      ops.push(op(n + 1, "issue", `issue-${String(n).padStart(3, "0")}`, "create", { title: `wide ${n}`, description: quoted(30_000, `${n}`) }));
    }
    await insertOps(env.DB, REPO, ops);
    let progress = 0;
    let steps = 0;
    while (progress < ops[ops.length - 1]!.seq) {
      const m = meter();
      const budget: FoldBudget = { remaining: 500, bytes: 1024 * 1024, work: FOLD_STEP_WORK };
      const mark = await advanceFold({ ...env, DB: metered(env.DB, m) }, REPO, 1, await head(), { budget });
      const taken = ops.filter((o) => o.seq > progress && o.seq <= mark.seq);
      expect(taken.length).toBeGreaterThan(0);
      // The estimate of what it folded fits the step, unless it folded one operation alone.
      const estimate = runWork(
        taken.map((o) => ({ keys: [`issue ${o.entityId}`], bytes: o.payload.length, escapes: (o.payload.match(/["\\]/g) ?? []).length })),
        () => undefined,
      );
      if (taken.length > 1) expect(estimate[estimate.length - 1]!).toBeLessThanOrEqual(FOLD_STEP_WORK);
      expect(m.statements).toBeLessThanOrEqual(10);
      expect(m.bytes).toBeLessThan(2 * 1024 * 1024);
      progress = mark.seq;
      steps += 1;
    }
    expect(steps).toBeGreaterThan(20);
  }, 120_000);

  it("folds one operation larger than any budget, alone, and nothing once the request has folded", async () => {
    await insertOps(env.DB, REPO, [
      op(1, "issue", "issue-big", "create", { title: "big", description: quoted(500_000, "a") }),
      op(2, "issue", "issue-big", "update", { description: quoted(500_000, "b") }),
    ]);
    // A request that has spent nothing folds the first however large.
    const fresh: FoldBudget = { remaining: 500, bytes: 1024 * 1024, work: 1 };
    expect((await advanceFold(env, REPO, 1, 2, { budget: fresh })).seq).toBe(1);
    // One that has folded (or served) something folds nothing it has no room for.
    const spent: FoldBudget = { remaining: 500, bytes: 1024 * 1024, work: requestWork("free"), folded: true };
    expect((await advanceFold(env, REPO, 1, 2, { budget: spent })).seq).toBe(1);
    expect((await advanceFold(env, REPO, 1, 2, { budget: { remaining: 500, work: 1 } })).seq).toBe(2);
  });
});

describe("a request's budget", () => {
  it("is what its pull page leaves: a page that costs it all folds nothing", async () => {
    // 600 operations, the fold 500 behind: a pull of a page of 30 KB quote-heavy edits spends the
    // request on its page; a pull of one small operation folds.
    const ops: GeneratedOp[] = [];
    for (let n = 0; n < 100; n += 1) ops.push(op(n + 1, "issue", `issue-${n}`, "create", { title: `wide ${n}`, description: quoted(30_000, `${n}`) }));
    for (let n = 100; n < 600; n += 1) ops.push(op(n + 1, "issue", `issue-${n % 100}`, "update", { title: `t${n}` }));
    await insertOps(env.DB, REPO, ops);

    const large = await send(`/ops?limit=100`, env.DB);
    expect(large.status).toBe(200);
    expect((await foldProgress(env, REPO, 1)).seq).toBe(0);

    const small = await send(`/ops?limit=1&cursor=${encodeURIComponent(large.json.nextCursor)}`, env.DB);
    expect(small.status).toBe(200);
    expect((await foldProgress(env, REPO, 1)).seq).toBeGreaterThan(0);
  });

  it("is shared by a snapshot page: after folding, a page with no room is deferred, and served when asked again", async () => {
    const ops: GeneratedOp[] = [];
    for (let n = 0; n < 40; n += 1) ops.push(op(n + 1, "issue", `issue-${String(n).padStart(2, "0")}`, "create", { title: `wide ${n}`, description: quoted(60_000, `${n}`) }));
    // And a last edit larger than a request's whole budget.
    ops.push(op(41, "issue", "issue-00", "update", { description: quoted(500_000, "last") }));
    await insertOps(env.DB, REPO, ops);
    // Folded to one short of the head, so the first page's request folds the last operation.
    await advanceFold(env, REPO, 1, 40, { budget: { remaining: Number.MAX_SAFE_INTEGER } });

    const first = await send(`/snapshot?limit=500`, env.DB);
    expect({ status: first.status, foldedSeq: first.json.foldedSeq, cutoffSeq: first.json.cutoffSeq }).toEqual({ status: 503, foldedSeq: 41, cutoffSeq: 41 });
    const again = await send(`/snapshot?limit=500`, env.DB);
    expect(again.status).toBe(200);
    // Cut by work long before its 500 entities or its bytes: 60 KB of quotes each.
    expect(again.json.entities.length).toBeGreaterThan(0);
    expect(again.json.entities.length).toBeLessThan(8);
  });
});

describe("a restore turn", () => {
  /**
   * Progress is counted from the rows, but only the rows a turn has not counted yet: the count a
   * turn reads is what the turns before it staged since, never the whole restore again.
   */
  it("counts only what was staged since the last turn", async () => {
    const ops: GeneratedOp[] = [];
    for (let n = 0; n < 1500; n += 1) ops.push(op(n + 1, "comment", `comment-${String(n).padStart(4, "0")}`, "create", { issueId: "i", body: `c${n}` }));
    await insertOps(env.DB, REPO, ops);
    await foldAll();
    const taken = await send(`/backups`, env.DB, "POST", {});
    expect(taken.status).toBe(200);

    let restoreId: string | undefined;
    const counted: number[] = [];
    for (let turn = 0; turn < 100; turn += 1) {
      const m = meter();
      const response = await send(`/backups/${taken.json.backup.backupId}/restore`, metered(env.DB, m), "POST", {
        confirm: REPO,
        ...(restoreId ? { restoreId } : {}),
      });
      expect(response.status, JSON.stringify(response.json).slice(0, 200)).toBe(200);
      restoreId = response.json.restoreId;
      counted.push([...m.rowsRead].filter(([sql]) => sql.includes("COUNT(*)") && sql.includes("FROM ops")).reduce((sum, [, n]) => sum + n, 0));
      if (response.json.done) break;
    }
    expect(counted.length).toBeGreaterThan(5);
    // No turn counts more than a turn's rows, however much the restore has staged.
    for (const rows of counted) expect(rows).toBeLessThanOrEqual(3 * 200 + 10);
  }, 120_000);
});
