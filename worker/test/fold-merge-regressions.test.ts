import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { catchUpFolds } from "../src/catch-up.js";
import { bodyKey } from "../src/fold-revisions.js";
import { advanceFold, foldedPage } from "../src/fold-store.js";
import { foldLog } from "../src/fold.js";
import { countEscapes, runWork, writeWork } from "../src/fold-work.js";
import { FOLD_RETRY_MS, requestFoldBudget } from "../src/limits.js";
import { REPO, DEVICE, seedRepo } from "./helpers.js";
import { type GeneratedOp, insertOps } from "./log-generator.js";

function op(seq: number, entity: string, id: string, verb: string, payload: unknown): GeneratedOp {
  return { seq, epoch: 1, opId: `merge-${seq}`, deviceId: DEVICE, entity, entityId: id,
    verb, baseVersion: verb === "create" ? null : 1, payload: JSON.stringify(payload),
    actor: "alice", clientSeq: seq, schema: 18, createdAt: "2026-09-17T00:00:00.000Z", serverTs: seq };
}

function countQueries(db: D1Database): { db: D1Database; count: () => number } {
  let count = 0;
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, {
    get(target, property) {
      if (property === "__inner") return target;
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
      if (property === "all" || property === "first" || property === "run") return (...args: unknown[]) => {
        count += 1;
        return (target[property] as Function).apply(target, args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { count: () => count, db: new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch") return (statements: D1PreparedStatement[]) => {
        count += statements.length;
        return target.batch(statements.map(s => (s as unknown as { __inner: D1PreparedStatement }).__inner));
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) };
}

describe("checkpoint compatibility with current emitters", () => {
  it("matches the full fold for real attempt ends, narration and opaque revision fields", async () => {
    await seedRepo();
    const rows = [
      op(1, "attempt", "a", "create", { role: "orchestrator", endedAt: null }),
      op(2, "attempt", "a", "update", { endedAt: "2026-09-18T00:00:00Z", endReason: "coordination_ended" }),
      op(3, "attempt", "a", "update", { endedAt: "2026-09-19T00:00:00Z", endReason: "issue_resolved", originEvents: [{ type: "private narration" }] }),
      op(4, "documentRevision", "i/worklog/1", "create", { body: "first", revision: 1 }),
      op(5, "documentRevision", "i/worklog/1", "create", { body: "second", revision: 1, instructions: true, future: { untouched: [1, 2] } }),
      op(6, "attachment", "file", "create", { sha256: "abc", mediaType: "image/png" }),
    ];
    await insertOps(env.DB, REPO, rows);
    await advanceFold(env, REPO, 1, 6, { budget: { remaining: 100 } });
    const page = await foldedPage(env, REPO, 1, 6, "", 100);
    expect(page.entities).toEqual((await foldLog(env, REPO, 1, 6)).entities);
    const moved = page.entities.find(e => e.entityId === "i/worklog/2")!;
    expect(moved.state).toMatchObject({ instructions: true, future: { untouched: [1, 2] } });
    expect(page.entities.find(e => e.entity === "attempt")!.state).not.toHaveProperty("originEvents");
  });

  it("makes progress past equal-ended revision bodies within a free request budget", async () => {
    await seedRepo();
    const body = (n: number) => "H".repeat(1024) + String(n).padStart(12, "0") + "T".repeat(1024);
    expect(new Set(Array.from({ length: 65 }, (_, n) => bodyKey(body(n)))).size).toBe(65);
    const rows = Array.from({ length: 64 }, (_, n) => op(n + 1, "documentRevision", `d/${n + 1}`, "create", { body: body(n), revision: n + 1 }));
    await insertOps(env.DB, REPO, rows);
    await advanceFold(env, REPO, 1, 64, { budget: { remaining: 1000 } });
    await insertOps(env.DB, REPO, [op(65, "documentRevision", "d/1", "create", { body: body(64), revision: 1, instructions: true })]);
    const measured = countQueries(env.DB);
    expect((await advanceFold({ ...env, DB: measured.db }, REPO, 1, 65, { budget: requestFoldBudget("free") })).seq).toBe(65);
    expect(measured.count()).toBeLessThanOrEqual(45);
    expect((await foldedPage(env, REPO, 1, 65, "", 100)).entities).toEqual((await foldLog(env, REPO, 1, 65)).entities);
  });

  it("charges provenance per field instead of once for a wide update", () => {
    const fields = Object.fromEntries(Array.from({ length: 1200 }, (_, n) => [`f${n}`, 0]));
    const payload = JSON.stringify(fields);
    const provenance = JSON.stringify(Object.fromEntries(Object.keys(fields).map(k => [k,
      { baseVersion: 1, opId: "f".repeat(128), at: "2026-09-17T00:00:00.000Z", seq: 1 }])));
    const estimate = runWork([{ keys: ["issue i"], bytes: payload.length, escapes: countEscapes(payload), fields: 1200 }], () => undefined)[0]!;
    expect(estimate).toBeGreaterThan(writeWork(payload.length + provenance.length, countEscapes(payload) + countEscapes(provenance)));
  });

  it("paces repeated folding below the configured 120 requests per minute", () => {
    expect(60_000 / FOLD_RETRY_MS).toBeLessThan(120);
  });
});

it("ranks catch-up by the current epoch backlog rather than previous epochs", async () => {
  await seedRepo();
  await seedRepo("busy-repo");
  await env.DB.prepare("UPDATE repos SET epoch = 2 WHERE repo_id = ?1").bind(REPO).run();
  await insertOps(env.DB, REPO, [{ ...op(100_001, "issue", "one", "create", { title: "one" }), epoch: 2 }]);
  await insertOps(env.DB, "busy-repo", Array.from({ length: 400 }, (_, n) => op(n + 1, "issue", `i${n}`, "create", { title: "busy" })));
  const runs = await catchUpFolds(env);
  expect(runs[0]!.repoId).toBe("busy-repo");
});
