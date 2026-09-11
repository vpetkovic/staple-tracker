/**
 * A rate-limited service is waited for, within the sync, for as long as it asks (STA-264).
 *
 * The deployed Worker limits each device to 120 requests a minute and answers the 121st
 * with 429 `rate_limited` and `Retry-After: 60` (`worker/src/http.ts`). The client's retry
 * schedule used to be 200 ms, 400 ms, then give up, so a first sync of a large workspace —
 * which pushes its whole history in batches of `maxBatchSize` — stopped halfway with
 * `rate_limited` and needed a person to run it again a minute later.
 *
 * Every test here runs the real client against the fake service with the Worker's limit
 * switched on, and moves the fake's clock by exactly what the client sleeps.
 */
import { afterEach, describe, expect, it } from "vitest";
import { AUTO_SYNC_MAX_RETRY_AFTER_MS } from "../src/core/cloud/auto.js";
import { AutoSyncScheduler } from "../src/core/cloud/auto-sync.js";
import { readAutoSyncState } from "../src/core/cloud/auto-state.js";
import { localCloudStatus } from "../src/core/cloud/status.js";
import { describeHubReport, hubCloudReport } from "../src/core/cloud/hub-surface.js";
import { setConsent } from "../src/core/cloud/connection.js";
import { StapleError } from "../src/core/types.js";
import { syncRepository } from "../src/core/cloud/sync.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000000a1";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

/** A service limited to `requests` a minute, on a clock the test owns. */
function limitedService(requests: number): { server: FakeSyncServer; clock: { now: number } } {
  const clock = { now: Date.parse("2026-09-10T12:00:00.000Z") };
  const server = new FakeSyncServer({
    repositoryId: REPO,
    maxBatchSize: 2,
    rateLimit: { requests, windowMs: 60_000, retryAfterSeconds: 60 },
  });
  server.now = () => clock.now;
  return { server, clock };
}

function pendingOf(db: import("node:sqlite").DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_seq IS NULL").get() as { n: number }).n;
}

describe("a sync that meets the rate limit", () => {
  it("waits as long as the service asks and finishes, sending nothing twice", async () => {
    const { server, clock } = limitedService(4);
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync({ sleep: async (ms) => void (clock.now += ms) });
    for (let n = 1; n <= 12; n += 1) a.store.createIssue({ title: `Issue ${n}` });

    const waits: number[] = [];
    const report = await a.sync({
      sleep: async (ms) => void (clock.now += ms),
      onServiceWait: (ms) => waits.push(ms),
    });

    // Six batches of two against four requests a minute: the service refused, and the
    // sync waited out every refusal instead of giving up on the first.
    expect(server.rateLimited).toBeGreaterThan(0);
    expect(waits.length).toBe(server.rateLimited);
    expect(waits.every((ms) => ms === 60_000)).toBe(true);
    expect(report.pushed.applied).toBe(12);
    expect(report.pushed.duplicate).toBe(0);
    expect(pendingOf(a.db)).toBe(0);
    expect(server.ops.filter((op) => op.entity === "issue")).toHaveLength(12);
  });

  it("with no budget to wait, stops with rate_limited and the next sync finishes the rest exactly once", async () => {
    const { server, clock } = limitedService(3);
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync({ sleep: async (ms) => void (clock.now += ms) });
    clock.now += 60_000;
    for (let n = 1; n <= 10; n += 1) a.store.createIssue({ title: `Issue ${n}` });

    const stopped = await a
      .sync({ rateLimitWaitMs: 0, sleep: async (ms) => void (clock.now += ms) })
      .then(() => null, (error: unknown) => error);
    expect(stopped).toBeInstanceOf(StapleError);
    expect((stopped as StapleError).detail?.cloudCode).toBe("rate_limited");
    // The service's own answer is in the detail, for a surface to schedule by.
    expect((stopped as StapleError).detail?.retryAfter).toBe("60");
    const sentBefore = server.ops.filter((op) => op.entity === "issue").length;
    expect(sentBefore).toBeGreaterThan(0);
    expect(pendingOf(a.db)).toBe(10 - sentBefore);

    clock.now += 60_000;
    const report = await a.sync({ sleep: async (ms) => void (clock.now += ms) });
    expect(report.pushed.duplicate).toBe(0);
    expect(server.ops.filter((op) => op.entity === "issue")).toHaveLength(10);
    expect(pendingOf(a.db)).toBe(0);
  });
});

describe("the two bounds on waiting", () => {
  it("does not sit through a wait longer than two minutes: it reports it at once", async () => {
    const clock = { now: Date.parse("2026-09-10T12:00:00.000Z") };
    const server = new FakeSyncServer({
      repositoryId: REPO,
      rateLimit: { requests: 1, windowMs: 60 * 60_000, retryAfterSeconds: 3600 },
    });
    server.now = () => clock.now;
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const slept: number[] = [];
    const stopped = await a
      .sync({ sleep: async (ms) => void slept.push(ms) })
      .then(() => null, (error: unknown) => error);
    expect((stopped as StapleError).detail?.cloudCode).toBe("rate_limited");
    expect((stopped as StapleError).detail?.retryAfter).toBe("3600");
    // Not an hour, and not three quick retries at a service that asked for an hour.
    expect(slept).toEqual([]);
    expect(server.rateLimited).toBe(1);
  });

  it("waits what an unavailable service asked for, instead of the 200 ms default", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync();
    a.store.createIssue({ title: "Queued while the service is down" });
    server.failNext = { route: "POST /v1/repos/:id/ops", times: 1, status: 503, code: "unavailable", headers: { "retry-after": "5" } };
    const slept: number[] = [];
    const report = await a.sync({ sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([5_000]);
    expect(report.pushed.applied).toBe(1);
  });
});

describe("automatic sync, which has a budget and waits between runs instead", () => {
  it("schedules its next run no sooner than the service asked", async () => {
    const { server, clock } = limitedService(2);
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync({ sleep: async (ms) => void (clock.now += ms) });
    for (let n = 1; n <= 8; n += 1) a.store.createIssue({ title: `Issue ${n}` });
    setConsent(a.home, REPO, { auto: true });

    const scheduler = new AutoSyncScheduler({
      home: a.home,
      now: () => clock.now,
      // The real transport, not a stand-in: the scheduler's own options reach the service.
      syncImpl: syncRepository,
      fetchImpl: server.fetch,
    });
    const outcome = await scheduler.request({ db: a.db, repositoryId: REPO }, "startup");
    expect(outcome.status).toBe("failed");

    const state = readAutoSyncState(a.home, REPO);
    expect(state.consecutiveFailures).toBe(1);
    // The jittered backoff after one failure is at most 7.5 s; the service asked for 60.
    expect(Date.parse(state.nextEligibleAt!) - clock.now).toBeGreaterThanOrEqual(60_000);
  });

  /**
   * The service's number, taken as given, set the next run a year out for `Retry-After:
   * 31536000` — surviving a manual sync, shown nowhere, cleared only by reconnecting — and
   * threw a RangeError inside the scheduler for anything past 1e14 seconds, which no Date
   * can hold. It is bounded now, shown by `cloud status`, and cleared by a sync that works.
   */
  for (const [label, retryAfter] of [
    ["a year", "31536000"],
    ["more seconds than a date can hold", "100000000000000"],
    ["a date past the end of time", "Tue, 01 Jan 275760 00:00:00 GMT"],
    ["garbage", "soon, probably"],
  ] as const) {
    it(`bounds a Retry-After of ${label}, says so in status, and a working sync clears it`, async () => {
      const clock = { now: Date.parse("2026-09-10T12:00:00.000Z") };
      const server = new FakeSyncServer({ repositoryId: REPO });
      server.now = () => clock.now;
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      await a.sync();
      a.store.createIssue({ title: "Waiting" });
      setConsent(a.home, REPO, { auto: true });
      server.failNext = { route: "POST /v1/repos/:id/ops", times: 1, status: 429, code: "rate_limited", headers: { "retry-after": retryAfter } };

      const scheduler = new AutoSyncScheduler({
        home: a.home,
        now: () => clock.now,
        syncImpl: syncRepository,
        fetchImpl: server.fetch,
      });
      const outcome = await scheduler.request({ db: a.db, repositoryId: REPO }, "startup");
      expect(outcome.status).toBe("failed");
      const waited = Date.parse(readAutoSyncState(a.home, REPO).nextEligibleAt!) - clock.now;
      expect(waited).toBeGreaterThan(0);
      expect(waited).toBeLessThanOrEqual(AUTO_SYNC_MAX_RETRY_AFTER_MS);

      const status = localCloudStatus(a.home, REPO, { now: clock.now });
      expect(status.warnings.join("\n")).toContain(readAutoSyncState(a.home, REPO).nextEligibleAt!);
      // And `cloud status --all` says the same, for every workspace.
      const hubRow = hubCloudReport(a.home, { now: clock.now }).workspaces.find((row) => row.repositoryId === REPO)!;
      expect(hubRow.autoWaitingUntil).toBe(readAutoSyncState(a.home, REPO).nextEligibleAt);
      expect(describeHubReport(hubCloudReport(a.home, { now: clock.now }))).toContain(`waiting until ${hubRow.autoWaitingUntil}`);

      // A manual sync goes ahead, and once it has worked there is nothing left to wait for.
      await a.sync();
      expect(readAutoSyncState(a.home, REPO).nextEligibleAt).toBeNull();
      expect(localCloudStatus(a.home, REPO, { now: clock.now }).warnings).toEqual([]);
      expect(hubCloudReport(a.home, { now: clock.now }).workspaces.find((row) => row.repositoryId === REPO)!.autoWaitingUntil).toBeNull();
    });
  }
});
