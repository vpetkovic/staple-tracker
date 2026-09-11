/**
 * A device that only ever synchronizes automatically still reaches a log too large for the
 * service to fold.
 *
 * Such a log is read whole from the ordered tail and folded on the device (`tail-fold.ts`),
 * which on a real repository — 20,000 operations and more — is more pages than an automatic
 * sync's 2–10 s budget, and more requests than the service's rate limit (120 a minute)
 * allows one run. The command line waits the limit out; automatic sync does not wait inside
 * a run. So every run stopped part-way, reported a failure, pushed its backoff out, and
 * began again from the first page next time: the device never got there. Now a stopped
 * read is kept (`surveyFromTail`, `sync.ts`), the next run goes on from the page it stopped
 * at, and a run that got somewhere reports progress rather than failure (`auto-sync.ts`).
 *
 * The fake folds at most 30 operations, serves 5 a page, and lets a device make 6 requests
 * a minute — the Worker's 20,000, 500 and 120, scaled so one run cannot finish.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AutoSyncScheduler, type AutoSyncOutcome } from "../src/core/cloud/auto-sync.js";
import { setConsent } from "../src/core/cloud/connection.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000183";
const CAP = 30;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function everything(db: DatabaseSync): unknown {
  return {
    issues: db.prepare("SELECT id, identifier, title, status, updated_at FROM issues ORDER BY id").all(),
    comments: db.prepare("SELECT id, body, created_at FROM comments ORDER BY id").all(),
  };
}

const surveyed = (db: DatabaseSync): number | null =>
  (db.prepare("SELECT json_extract(value, '$.operations') AS n FROM meta WHERE key = 'sync_tail_survey'").get() as { n: number } | undefined)?.n ?? null;

describe("automatic sync on a log too large for the service to fold", () => {
  for (const reading of ["a new device's first read", "an upgraded device's one-time re-read"] as const) {
    it(`finishes ${reading} over several runs, each going on from the last, and none a failure`, async () => {
      let clock = Date.parse("2026-09-11T00:00:00.000Z");
      const server = new FakeSyncServer({ repositoryId: REPO, maxSnapshotFoldOps: CAP, maxPullLimit: 5, defaultPullLimit: 5 });
      server.now = () => clock;
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      await a.sync();
      const v = fleet.machine("v");
      if (reading === "an upgraded device's one-time re-read") await v.sync();
      a.use();
      for (let n = 0; n < CAP + 20; n += 1) {
        const issue = a.store.createIssue({ title: `Issue ${n}` });
        if (n % 4 === 0) a.store.addComment(issue.id, `comment ${n}`, "agent-a", "agent");
      }
      await a.sync();
      expect(server.ops.length).toBeGreaterThan(CAP * 2);
      if (reading === "an upgraded device's one-time re-read") {
        // Everything but the re-read, which it owes.
        v.use();
        await v.sync();
        v.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();
      }

      server.limitRate({ requests: 6, windowMs: 60_000, retryAfterSeconds: 60 });
      setConsent(v.home, REPO, { auto: true });
      let pulls = 0;
      const counting: typeof fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (/\/ops\?/.test(String(input)) && (init?.method ?? "GET") === "GET") pulls += 1;
        return server.fetch(input, init);
      }) as typeof fetch;
      const scheduler = new AutoSyncScheduler({ home: v.home, now: () => clock, random: () => 0, fetchImpl: counting });

      const outcomes: AutoSyncOutcome["status"][] = [];
      const read: number[] = [];
      for (let run = 0; run < 60; run += 1) {
        v.use();
        const outcome = await scheduler.request({ db: v.db, repositoryId: REPO }, "session");
        outcomes.push(outcome.status);
        if (outcome.status === "synced") break;
        read.push(surveyed(v.db) ?? 0);
        clock += 61_000;
      }

      expect(outcomes.at(-1)).toBe("synced");
      expect(outcomes.length).toBeGreaterThan(2);
      expect(outcomes.filter((status) => status !== "progressed" && status !== "synced")).toEqual([]);
      // Each stopped run went on from the one before.
      expect(read).toEqual([...read].sort((x, y) => x - y));
      expect(new Set(read).size).toBe(read.length);
      // And the log was read about once: its pages, not its pages once per run.
      expect(pulls).toBeLessThan(Math.ceil(server.ops.length / 5) * 2 + outcomes.length * 2);
      expect(surveyed(v.db)).toBeNull();
      expect(everything(v.db)).toEqual(everything(a.db));
      if (reading === "an upgraded device's one-time re-read") {
        expect(v.db.prepare("SELECT value FROM meta WHERE key = 'sync_applier_version'").get()).toBeTruthy();
      }
    });
  }
});
