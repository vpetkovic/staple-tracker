/**
 * Snapshot, backup and restore past the old single-pass cap of 20,000 operations.
 *
 * The Worker used to fold the whole log inside one request and refused past 20,000
 * operations, so on a repository that size `GET /snapshot` answered `unavailable`, a backup
 * could not be taken, and a restore could not begin — because a restore takes a backup first.
 * These drive the real routes over a log written straight into D1.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { foldBudgetOps } from "../src/limits.js";
import { REPO, call, jsonOf, seedRepo } from "./helpers.js";
import { generateLog, insertOps } from "./log-generator.js";

let token: string;

beforeEach(async () => {
  token = await seedRepo();
  await call(`/v1/repos/${REPO}/backup`, { method: "PUT", token, body: { enabled: true } });
});

async function snapshotAll(): Promise<{ cutoffSeq: number; entities: any[]; pages: number }> {
  let cursor: string | null = null;
  const entities: any[] = [];
  let cutoffSeq = 0;
  let pages = 0;
  for (;;) {
    const query: string = cursor ? `?limit=500&cursor=${encodeURIComponent(cursor)}` : "?limit=500";
    const response = await call(`/v1/repos/${REPO}/snapshot${query}`, { token });
    const body = await jsonOf(response);
    expect(response.status, JSON.stringify(body).slice(0, 300)).toBe(200);
    pages += 1;
    cutoffSeq = body.cutoffSeq;
    entities.push(...body.entities);
    if (!body.hasMore) break;
    cursor = body.nextCursor;
  }
  return { cutoffSeq, entities, pages };
}

/** Read the whole ordered tail, page by page, the way a device catching up does. */
async function pullAll(): Promise<number> {
  let cursor: string | null = null;
  let ops = 0;
  for (;;) {
    const query: string = cursor ? `?limit=500&cursor=${encodeURIComponent(cursor)}` : "?limit=500";
    const body = await jsonOf(await call(`/v1/repos/${REPO}/ops${query}`, { token }));
    ops += body.ops.length;
    if (!body.hasMore) return ops;
    cursor = body.nextCursor;
  }
}

/**
 * Call until the answer is not "still folding", and check that every refusal was progress:
 * `foldedSeq` climbs on each one. Answers the final response and how many refusals it took.
 */
async function untilFolded(send: () => Promise<Response>): Promise<{ response: Response; body: any; refusals: number }> {
  let last = -1;
  for (let refusals = 0; refusals < 1000; refusals += 1) {
    const response = await send();
    const body = await jsonOf(response);
    if (!(response.status === 503 && typeof body.foldedSeq === "number")) return { response, body, refusals };
    expect(body.foldedSeq).toBeGreaterThan(last);
    expect(response.headers.get("retry-after")).toBe("1");
    last = body.foldedSeq;
  }
  throw new Error("the fold never finished");
}

async function restore(backupId: string): Promise<any> {
  let restoreId: string | undefined;
  for (let turn = 0; turn < 1000; turn += 1) {
    const { response, body } = await untilFolded(() =>
      call(`/v1/repos/${REPO}/backups/${backupId}/restore`, {
        method: "POST",
        token,
        body: { confirm: REPO, ...(restoreId ? { restoreId } : {}) },
      }),
    );
    expect(response.status, JSON.stringify(body)).toBe(200);
    restoreId = body.restoreId;
    if (body.done) return body;
  }
  throw new Error("restore did not finish");
}

describe("a repository past 20,000 operations", () => {
  it("takes a backup in one request once devices have synced, restores it, and serves its snapshot", async () => {
    const ops = generateLog({ seed: 20_001, count: 20_001, pool: 400 });
    await insertOps(env.DB, REPO, ops);
    // Devices pull the log as they sync, and every pull moves the checkpoint on.
    expect(await pullAll()).toBe(20_001);

    const created = await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} });
    const backup = await jsonOf(created);
    expect(created.status, JSON.stringify(backup)).toBe(200);
    expect(backup.backup.opCount).toBe(20_001);

    const listed = await jsonOf(await call(`/v1/repos/${REPO}/backups`, { token }));
    expect(listed.backups.map((b: any) => [b.backupId, b.entityCount, b.opCount])).toEqual([
      [backup.backup.backupId, backup.backup.entityCount, 20_001],
    ]);

    const done = await restore(backup.backup.backupId);
    expect(done.entityCount).toBe(backup.backup.entityCount);

    const snapshot = await snapshotAll();
    expect(snapshot.entities.length).toBe(backup.backup.entityCount);
  }, 120_000);

  it("finishes the fold across requests when nothing synced first, and every refusal is progress", async () => {
    const ops = generateLog({ seed: 20_002, count: 20_001, pool: 400 });
    await insertOps(env.DB, REPO, ops);

    const { response, body, refusals } = await untilFolded(() =>
      call(`/v1/repos/${REPO}/backups`, { method: "POST", token, body: {} }),
    );
    expect(response.status, JSON.stringify(body)).toBe(200);
    // Each request folds its budget and the one that reaches the head is served, so the refusals
    // are that many budgets, less one.
    expect(refusals).toBe(Math.ceil(20_001 / foldBudgetOps("free")) - 1);
    expect(body.backup.opCount).toBe(20_001);

    const done = await restore(body.backup.backupId);
    expect(done.entityCount).toBe(body.backup.entityCount);
    expect((await snapshotAll()).entities.length).toBe(body.backup.entityCount);
  }, 120_000);
});
