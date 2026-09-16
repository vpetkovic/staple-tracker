/**
 * Every statement the checkpoint and a restore write fits D1 as deployed, not only as it runs
 * here.
 *
 * Deployed D1 refuses a string or blob past 2,000,000 bytes, bound values included. The D1 in
 * this test runtime accepts several times that, so a statement that only works locally would
 * pass every other test in this suite. These run the Worker's own `fetch` with its D1
 * binding wrapped to refuse, as the deployed one does, any bound string past that — over a
 * log built to reach it: large states whose JSON text is mostly quotes, which a packed
 * statement escapes a second time, at twice their size.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { entityKey } from "../src/cursor.js";
import { DEVICE, ORIGIN, REPO, seedRepo } from "./helpers.js";
import { oracleFoldLog } from "./fold-oracle.js";
import { type GeneratedOp, insertOps } from "./log-generator.js";

const D1_VALUE_BYTES = 2_000_000;

/** The D1 binding, refusing what the deployed one refuses. */
function deployedD1(db: D1Database, seen: { largest: number }): D1Database {
  const encoder = new TextEncoder();
  const guard = (values: unknown[]) => {
    for (const value of values) {
      if (typeof value !== "string") continue;
      const bytes = encoder.encode(value).length;
      seen.largest = Math.max(seen.largest, bytes);
      if (bytes > D1_VALUE_BYTES) throw new Error(`D1_ERROR: string or blob too big: SQLITE_TOOBIG (${bytes} bytes bound)`);
    }
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => {
            guard(values);
            return wrap(target.bind(...values));
          };
        }
        if (property === "__inner") return target;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) =>
          target.batch(statements.map((statement) => (statement as unknown as { __inner?: D1PreparedStatement }).__inner ?? statement));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let token: string;
const seen = { largest: 0 };
const deployed = () => ({ ...env, DB: deployedD1(env.DB, seen), SYNC_LIMITER: undefined });

async function send(path: string, method = "GET", body?: unknown): Promise<{ status: number; json: any }> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Staple-Protocol": "1", "Staple-Device": DEVICE };
  if (text !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(new TextEncoder().encode(text).length);
  }
  const response = await worker.fetch(new Request(`${ORIGIN}/v1/repos/${REPO}${path}`, { method, headers, body: text }), deployed() as never);
  return { status: response.status, json: await response.json() };
}

/** Until the answer is not "still folding", each such answer being progress. */
async function untilFolded(path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  let folded = -1;
  for (;;) {
    const response = await send(path, method, body);
    if (!(response.status === 503 && typeof response.json.foldedSeq === "number")) return response;
    expect(response.json.foldedSeq).toBeGreaterThan(folded);
    folded = response.json.foldedSeq;
  }
}

beforeEach(async () => {
  token = await seedRepo();
  await env.DB.prepare(`UPDATE repos SET backup_enabled = 1 WHERE repo_id = ?1`).bind(REPO).run();
  seen.largest = 0;
});

/** A string of `n` quotes: `n + 2` bytes of JSON text, `2n + 2` escaped once more. */
const quotes = (n: number) => '"'.repeat(n);

describe("inside deployed D1's 2,000,000-byte ceiling on a bound value", () => {
  it("folds, serves, backs up and restores states that escape to more than it", async () => {
    const ops: GeneratedOp[] = [];
    const push = (entity: string, entityId: string, verb: string, payload: unknown) =>
      ops.push({
        seq: ops.length + 1,
        epoch: 1,
        opId: `quoted-${ops.length}`,
        deviceId: "device-a",
        entity,
        entityId,
        verb,
        baseVersion: verb === "create" ? null : ops.length,
        payload: JSON.stringify(payload),
        actor: "vp",
        clientSeq: ops.length + 1,
        schema: 10,
        createdAt: "2026-09-11T00:00:00.000Z",
        serverTs: 1_789_000_000_000 + ops.length,
      });
    // Documents whose state grows to 1.5 MB of JSON, three fields of 250,000 quotes: under a
    // row's ceiling as it is, past a bound value's once packed and escaped again.
    for (let n = 0; n < 3; n += 1) {
      push("document", `big-${n}`, "create", { title: `big ${n}`, a: quotes(250_000) });
      for (const field of ["b", "c"]) push("document", `big-${n}`, "update", { [field]: quotes(250_000) });
    }
    // And many small ones, which a pack gathers past the ceiling if nothing closes it.
    for (let n = 0; n < 60; n += 1) push("comment", `small-${String(n).padStart(3, "0")}`, "create", { body: quotes(30_000) });
    await insertOps(env.DB, REPO, ops);
    const head = ops[ops.length - 1]!.seq;

    // Pulls fold it, as devices syncing do.
    for (let n = 0; n < 40; n += 1) expect((await send(`/ops?limit=1`)).status).toBe(200);
    const taken = await untilFolded(`/backups`, "POST", {});
    expect(taken.status, JSON.stringify(taken.json).slice(0, 300)).toBe(200);
    expect(taken.json.backup.entityCount).toBe(63);

    const content = (entities: any[]) => entities.map((e) => JSON.stringify([entityKey(e.entity, e.entityId), e.state]));
    // The whole snapshot, and the cutoff its first page pinned.
    const read = async (): Promise<{ cutoff: number; entities: any[] }> => {
      const out: any[] = [];
      let cursor: string | null = null;
      let cutoff = 0;
      for (;;) {
        const page = await untilFolded(`/snapshot?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, "GET");
        expect(page.status).toBe(200);
        if (cursor === null) cutoff = page.json.cutoffSeq;
        out.push(...page.json.entities);
        if (!page.json.hasMore) return { cutoff, entities: out };
        cursor = page.json.nextCursor;
      }
    };
    const served = await read();
    expect(content(served.entities)).toEqual(content((await oracleFoldLog(env, REPO, 1, served.cutoff)).entities));
    const expected = content((await oracleFoldLog(env, REPO, 1, head)).entities);

    let restoreId: string | undefined;
    for (let turn = 0; turn < 500; turn += 1) {
      const response = await untilFolded(`/backups/${taken.json.backup.backupId}/restore`, "POST", {
        confirm: REPO,
        ...(restoreId ? { restoreId } : {}),
      });
      expect(response.status, JSON.stringify(response.json).slice(0, 300)).toBe(200);
      restoreId = response.json.restoreId;
      if (response.json.done) break;
    }
    expect(content((await read()).entities)).toEqual(expected);
    // It did reach the ceiling's neighbourhood: this is not a test of small values.
    expect(seen.largest).toBeGreaterThan(D1_VALUE_BYTES / 2);
  }, 120_000);
});
