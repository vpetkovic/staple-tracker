/**
 * Automatic synchronization: the second consent, and the three bounded triggers.
 *
 * Contract: `docs/sync.md`, "Three consents".
 *
 * This file is about the SCHEDULER and the GATE — consent, coalescing, bounds,
 * jittered backoff, cancellation, and the import graph that makes the gate
 * incapable of reaching the network. What it deliberately does not do is drive a
 * real sync to prove silence: that is `test/network-silence.test.ts`'s job,
 * against a real transport spy, and duplicating it here with a mocked `fetch`
 * would produce a second, weaker witness to the same claim.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_SYNC_BACKOFF_BASE_MS,
  AUTO_SYNC_BACKOFF_CAP_MS,
  AUTO_SYNC_BOUNDS,
  autoSyncBackoffMs,
  autoSyncConsented,
  autoSyncGate,
} from "../src/core/cloud/auto.js";
import {
  autoSyncStatePath,
  clearAutoSyncState,
  readAutoSyncState,
  writeAutoSyncState,
} from "../src/core/cloud/auto-state.js";
import { AutoSyncScheduler } from "../src/core/cloud/auto-sync.js";
import {
  CLI_COMMAND_TRIGGERS,
  SurfaceAutoSync,
  globalFlagsOf,
  runCommandTrigger,
} from "../src/core/cloud/auto-triggers.js";
import { listConnections, setConsent, writeConnection } from "../src/core/cloud/connection.js";
import type { SyncReport } from "../src/core/cloud/sync.js";
import { initWorkspace } from "../src/core/workspace.js";

const REPO = "0e77fa01-1111-2222-3333-444455556666";

let home: string;

function connect(auto: boolean, repositoryId = REPO): void {
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId,
    endpoint: "https://staple-sync-dev.example.workers.dev",
    deviceId: "11111111-2222-3333-4444-555555555555",
    label: "test device",
    credentialMechanism: "file",
    connectedAt: new Date().toISOString(),
    auto,
    backup: false,
    protocol: 1,
  });
}

/** A `db` the scheduler only ever passes through to the injected sync. */
const FAKE_DB = {} as never;

function report(): SyncReport {
  return {
    repositoryId: REPO,
    deviceId: "11111111-2222-3333-4444-555555555555",
    endpoint: "https://staple-sync-dev.example.workers.dev",
    epoch: 1,
    pushed: { attempted: 0, applied: 0, duplicate: 0 },
    pulled: { operations: 0, pages: 0, alreadyApplied: 0 },
    bootstrap: null,
    headSeq: 0,
    pending: 0,
    conflicts: 0,
    seed: null,
    at: new Date().toISOString(),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-auto-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ------------------------------------------------------------------- the consent

describe("the second consent, which connecting does not spend", () => {
  it("refuses before anything has ever been connected on this machine", () => {
    // The fresh-install case, and the cheapest refusal in the file: the `cloud`
    // directory does not exist, so no repository id is even considered.
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup" })).toEqual({
      allowed: false,
      reason: "no-connections",
    });
  });

  it("refuses a workspace with no sync identity", () => {
    connect(false);
    expect(autoSyncGate({ home, repositoryId: null, trigger: "startup" })).toEqual({
      allowed: false,
      reason: "no-identity",
    });
  });

  it("refuses a repository connected on some OTHER machine", () => {
    connect(false, "aaaaaaaa-0000-0000-0000-000000000000");
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup" })).toEqual({
      allowed: false,
      reason: "disconnected",
    });
  });

  /**
   * The acceptance criterion, stated as directly as it can be:
   * *"Manual remains the default for every newly connected repository"* and
   * *"Credentials or a saved connection never activate automatic synchronization"*.
   *
   * A connection record and a credential are both present here. The answer is
   * still no, and the reason is `manual` rather than anything that sounds like a
   * failure, because manual IS the working state.
   */
  it("refuses a freshly connected repository — storing a credential is not consent to use it", () => {
    connect(false);
    writeFileSync(join(home, "cloud", `${REPO}.token`), "stpl_fake\n", { mode: 0o600 });
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup" })).toEqual({
      allowed: false,
      reason: "manual",
    });
    expect(autoSyncConsented(home, REPO)).toBe(false);
  });

  it("allows only after the separate consent, and refuses again the moment it is revoked", () => {
    connect(false);
    setConsent(home, REPO, { auto: true });
    const permitted = autoSyncGate({ home, repositoryId: REPO, trigger: "startup" });
    expect(permitted.allowed).toBe(true);
    expect(autoSyncConsented(home, REPO)).toBe(true);

    // `cloud auto off` — and note that the connection survives it.
    const after = setConsent(home, REPO, { auto: false });
    expect(after.endpoint).toBe("https://staple-sync-dev.example.workers.dev");
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup" })).toEqual({
      allowed: false,
      reason: "manual",
    });
  });

  /**
   * *"a consent flag whose value cannot be read is not consent"*. `readConnection`
   * already refuses to read anything but a literal `true`; this pins that the gate
   * inherits it rather than doing its own truthiness test.
   */
  it("reads a non-boolean auto flag as no consent", () => {
    connect(false);
    const path = join(home, "cloud", `${REPO}.json`);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const value of ["true", 1, {}, [], null]) {
      writeFileSync(path, JSON.stringify({ ...record, auto: value }));
      expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup" })).toEqual({
        allowed: false,
        reason: "manual",
      });
    }
  });

  it("consent is per-repository: enabling one does not enable its neighbour", () => {
    const other = "bbbbbbbb-0000-0000-0000-000000000000";
    connect(false);
    connect(false, other);
    setConsent(home, REPO, { auto: true });
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup" }).allowed).toBe(true);
    expect(autoSyncGate({ home, repositoryId: other, trigger: "startup" })).toEqual({
      allowed: false,
      reason: "manual",
    });
  });
});

// ---------------------------------------------------------------- the clock file

describe("the cross-process clock", () => {
  it("does not end in .json, so `staple doctor` can still list connections", () => {
    connect(true);
    writeAutoSyncState(home, REPO, {
      lastAttemptAt: new Date().toISOString(),
      lastOkAt: null,
      consecutiveFailures: 2,
      nextEligibleAt: null,
      lastOutcome: "failed",
    });
    /**
     * `listConnections` reads every `*.json` in this directory through
     * `readConnection`, which THROWS on a JSON object that is not a connection
     * record. A sibling named `<id>.autosync.json` would therefore have broken
     * `staple doctor` on every machine that had ever run an automatic sync.
     */
    expect(autoSyncStatePath(home, REPO).endsWith(".json")).toBe(false);
    expect(listConnections(home).map((c) => c.repositoryId)).toEqual([REPO]);
  });

  /**
   * `clearAutoSyncState` exists for `disconnect`, which does not yet call it.
   *
   * Recorded here rather than left implicit: a `.autosync` file surviving a
   * disconnect is not a correctness problem — the gate refuses on the absent
   * connection record long before it reads a clock — but it is a file left behind
   * by an operation whose whole contract is to leave nothing behind, and the
   * one-line fix belongs in `connect.ts`, which is not this lane's file.
   */
  it("can be cleared, idempotently, and clearing restores a clean gate", () => {
    connect(true);
    writeAutoSyncState(home, REPO, {
      lastAttemptAt: new Date().toISOString(),
      lastOkAt: null,
      consecutiveFailures: 9,
      nextEligibleAt: new Date(Date.now() + 600_000).toISOString(),
      lastOutcome: "failed",
    });
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup" })).toEqual({
      allowed: false,
      reason: "backoff",
    });
    expect(clearAutoSyncState(home, REPO)).toBe(true);
    expect(clearAutoSyncState(home, REPO)).toBe(false);
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup" }).allowed).toBe(true);
  });

  it("reads a damaged clock as empty, unlike a damaged consent record", () => {
    connect(true);
    writeFileSync(autoSyncStatePath(home, REPO), "{not json");
    expect(readAutoSyncState(home, REPO).lastAttemptAt).toBeNull();
    // And the gate still permits: an unreadable clock holds no permission, so
    // losing it costs one extra sync rather than silently disabling the feature.
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup" }).allowed).toBe(true);
  });

  it("holds the floor between runs of the same trigger, across processes", () => {
    connect(true);
    const t0 = Date.parse("2026-09-08T12:00:00.000Z");
    writeAutoSyncState(home, REPO, {
      lastAttemptAt: new Date(t0).toISOString(),
      lastOkAt: new Date(t0).toISOString(),
      consecutiveFailures: 0,
      nextEligibleAt: null,
      lastOutcome: "synced",
    });

    const floor = AUTO_SYNC_BOUNDS.startup.minIntervalMs;
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup", now: t0 + floor - 1 })).toEqual({
      allowed: false,
      reason: "too-soon",
    });
    expect(
      autoSyncGate({ home, repositoryId: REPO, trigger: "startup", now: t0 + floor }).allowed,
    ).toBe(true);

    /**
     * The floors differ per trigger, and that is the whole reason the bounds are a
     * table: a write has new local work behind it and is worth going for far
     * sooner than a read is.
     */
    expect(
      autoSyncGate({ home, repositoryId: REPO, trigger: "post-write", now: t0 + 6_000 }).allowed,
    ).toBe(true);
  });

  it("treats a clock from the future as 'just now' rather than as a permanent refusal", () => {
    connect(true);
    const t0 = Date.parse("2026-09-08T12:00:00.000Z");
    writeAutoSyncState(home, REPO, {
      lastAttemptAt: new Date(t0 + 86_400_000).toISOString(),
      lastOkAt: null,
      consecutiveFailures: 0,
      nextEligibleAt: null,
      lastOutcome: null,
    });
    // A suspended laptop or an NTP correction must not pin the floor shut for a
    // day. Negative elapsed is ignored, so the gate falls through to permitted.
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup", now: t0 }).allowed).toBe(true);
  });

  it("holds the backoff window, and reports backoff rather than the floor", () => {
    connect(true);
    const t0 = Date.parse("2026-09-08T12:00:00.000Z");
    writeAutoSyncState(home, REPO, {
      lastAttemptAt: new Date(t0 - 86_400_000).toISOString(),
      lastOkAt: null,
      consecutiveFailures: 4,
      nextEligibleAt: new Date(t0 + 30_000).toISOString(),
      lastOutcome: "failed",
    });
    // The floor is long satisfied; the backoff is not, and the backoff is what a
    // human needs to be told, because it names a service that is not answering.
    expect(autoSyncGate({ home, repositoryId: REPO, trigger: "startup", now: t0 })).toEqual({
      allowed: false,
      reason: "backoff",
    });
    expect(
      autoSyncGate({ home, repositoryId: REPO, trigger: "startup", now: t0 + 30_001 }).allowed,
    ).toBe(true);
  });
});

describe("the backoff is jittered, and the jitter is the point", () => {
  it("grows, and is capped", () => {
    const mid = () => 0.5; // multiplier exactly 1.0
    expect(autoSyncBackoffMs(0, mid)).toBe(0);
    expect(autoSyncBackoffMs(1, mid)).toBe(AUTO_SYNC_BACKOFF_BASE_MS);
    expect(autoSyncBackoffMs(2, mid)).toBe(AUTO_SYNC_BACKOFF_BASE_MS * 2);
    expect(autoSyncBackoffMs(40, mid)).toBe(AUTO_SYNC_BACKOFF_CAP_MS);
  });

  it("spreads a fleet that failed together over [0.5, 1.5) of the flat delay", () => {
    /**
     * Unjittered, every device pointed at one repository would reconverge on the
     * same instant after a shared outage, and the endpoint's first second back
     * would be the worst-loaded it ever sees. This asserts spread, not a
     * distribution: the claim is that two devices do not land together.
     */
    const low = autoSyncBackoffMs(3, () => 0);
    const high = autoSyncBackoffMs(3, () => 0.999_999);
    const flat = AUTO_SYNC_BACKOFF_BASE_MS * 4;
    expect(low).toBe(Math.round(flat * 0.5));
    expect(high).toBeLessThan(Math.round(flat * 1.5) + 1);
    expect(high).toBeGreaterThan(low * 2.9);
  });
});

// ------------------------------------------------------------------ the scheduler

describe("the scheduler: coalescing, bounds, cancellation", () => {
  let clock = Date.parse("2026-09-08T12:00:00.000Z");
  const now = () => clock;

  beforeEach(() => {
    clock = Date.parse("2026-09-08T12:00:00.000Z");
    connect(true);
  });

  it("does not load the transport at all when the gate refuses", async () => {
    setConsent(home, REPO, { auto: false });
    let loaded = false;
    const scheduler = new AutoSyncScheduler({
      home,
      now,
      syncImpl: async () => {
        loaded = true;
        return report();
      },
    });
    expect(await scheduler.request({ db: FAKE_DB, repositoryId: REPO }, "post-write")).toEqual({
      status: "skipped",
      reason: "manual",
    });
    expect(loaded).toBe(false);
    // And no clock file was written: a refused trigger leaves no trace at all.
    expect(existsSync(autoSyncStatePath(home, REPO))).toBe(false);
  });

  it("coalesces a burst into ONE run and at most ONE follow-up", async () => {
    let started = 0;
    // An array rather than a `let`, so that releasing a run does not depend on
    // which assignment the type checker last saw.
    const gates: Array<() => void> = [];
    const scheduler = new AutoSyncScheduler({
      home,
      now,
      syncImpl: async () => {
        started += 1;
        await new Promise<void>((resolve) => gates.push(resolve));
        return report();
      },
    });

    const target = { db: FAKE_DB, repositoryId: REPO };
    const first = scheduler.request(target, "post-write");
    // Twenty more arriving while the first is in flight — an agent writing in a
    // loop. All twenty JOIN, none starts a second run.
    const joined = Array.from({ length: 20 }, () => scheduler.request(target, "post-write"));
    await Promise.resolve();
    expect(started).toBe(1);

    // The floor is satisfied by the time the follow-up asks, so it really runs —
    // and there is exactly one of it, not twenty.
    clock += AUTO_SYNC_BOUNDS["post-write"].minIntervalMs + 1;
    gates.shift()!();
    const outcome = await first;
    expect(outcome.status).toBe("synced");
    for (const other of await Promise.all(joined)) expect(other).toBe(outcome);

    // Let the queued follow-up start and finish.
    await new Promise((resolve) => setImmediate(resolve));
    gates.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(2);
  });

  it("the follow-up meets the gate like any other trigger, so a burst cannot outrun the floor", async () => {
    let started = 0;
    const gates: Array<() => void> = [];
    const scheduler = new AutoSyncScheduler({
      home,
      now,
      syncImpl: async () => {
        started += 1;
        await new Promise<void>((resolve) => gates.push(resolve));
        return report();
      },
    });
    const target = { db: FAKE_DB, repositoryId: REPO };
    const first = scheduler.request(target, "post-write");
    void scheduler.request(target, "post-write");
    await Promise.resolve();
    // No clock advance this time: the follow-up asks inside the floor and is
    // refused, which is what keeps a write-heavy agent from turning the floor
    // into a no-op.
    gates.shift()!();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(1);
  });

  it("bounds the run: once the budget elapses no further request is issued", async () => {
    const calls: string[] = [];
    const scheduler = new AutoSyncScheduler({
      home,
      now: Date.now,
      // A sync that keeps asking for pages. The guard is what stops it.
      syncImpl: async (_db, _id, options) => {
        for (let page = 0; page < 1_000; page += 1) {
          calls.push(`page-${page}`);
          await options.fetchImpl!("https://staple-sync-dev.example.workers.dev/v1/pull");
        }
        return report();
      },
      fetchImpl: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response("{}");
      }) as typeof fetch,
    });

    const outcome = await scheduler.request({ db: FAKE_DB, repositoryId: REPO }, "startup");
    expect(outcome.status).toBe("timeout");
    // It stopped well short of a thousand pages: the bound is on the RUN, not on
    // each request, so every page after the deadline fails instantly rather than
    // costing another timeout each.
    expect(calls.length).toBeLessThan(1_000);
    expect(outcome.status === "timeout" && outcome.ms).toBeLessThan(
      AUTO_SYNC_BOUNDS.startup.budgetMs + 1_500,
    );

    // A timeout counts as a failure: a service too slow to answer inside the
    // budget is one this device should back off from.
    const state = readAutoSyncState(home, REPO);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.nextEligibleAt).not.toBeNull();
  });

  it("cancels: stop() aborts the transport, and cancellation is not a failure", async () => {
    let rejected: unknown = null;
    const scheduler = new AutoSyncScheduler({
      home,
      now: Date.now,
      syncImpl: async (_db, _id, options) => {
        try {
          await options.fetchImpl!("https://staple-sync-dev.example.workers.dev/v1/pull");
        } catch (error) {
          rejected = error;
          throw error;
        }
        return report();
      },
      fetchImpl: ((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        })) as unknown as typeof fetch,
    });

    const running = scheduler.request({ db: FAKE_DB, repositoryId: REPO }, "session");
    await Promise.resolve();
    scheduler.stop();
    const outcome = await running;

    expect(outcome.status).toBe("cancelled");
    // The abort reached the SOCKET, not merely the scheduler: the injected fetch
    // was rejected by the signal it was handed.
    expect(rejected).toBeInstanceOf(Error);

    /**
     * Somebody closed a window. The endpoint said nothing about itself, so the
     * backoff must not move — otherwise closing a UI would teach this device that
     * the service was failing.
     */
    const state = readAutoSyncState(home, REPO);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.nextEligibleAt).toBeNull();

    // And nothing runs afterwards.
    expect(await scheduler.request({ db: FAKE_DB, repositoryId: REPO }, "post-write")).toEqual({
      status: "skipped",
      reason: "cancelled",
    });
  });

  it("refuses to call through at all once aborted, rather than opening one more socket", async () => {
    let base = 0;
    const scheduler = new AutoSyncScheduler({
      home,
      now: Date.now,
      syncImpl: async (_db, _id, options) => {
        scheduler.stop();
        await expect(options.fetchImpl!("https://elsewhere.example/v1/pull")).rejects.toThrow();
        return report();
      },
      fetchImpl: (() => {
        base += 1;
        return Promise.resolve(new Response("{}"));
      }) as typeof fetch,
    });
    await scheduler.request({ db: FAKE_DB, repositoryId: REPO }, "startup");
    expect(base).toBe(0);
  });

  it("records a failure, backs off, and never throws at its caller", async () => {
    const scheduler = new AutoSyncScheduler({
      home,
      now,
      random: () => 0.5,
      syncImpl: async () => {
        throw new Error("the endpoint said no");
      },
    });
    const outcome = await scheduler.request({ db: FAKE_DB, repositoryId: REPO }, "startup");
    expect(outcome.status).toBe("failed");
    const state = readAutoSyncState(home, REPO);
    expect(state.consecutiveFailures).toBe(1);
    expect(Date.parse(state.nextEligibleAt!)).toBe(clock + AUTO_SYNC_BACKOFF_BASE_MS);
  });

  it("records the attempt BEFORE making it, so a crashing sync cannot become a hot loop", async () => {
    const scheduler = new AutoSyncScheduler({
      home,
      now,
      syncImpl: async () => {
        // The clock is already on disk at this point, which is the whole claim:
        // a process killed here leaves the next one refused by the floor.
        expect(readAutoSyncState(home, REPO).lastAttemptAt).toBe(new Date(clock).toISOString());
        return report();
      },
    });
    await scheduler.request({ db: FAKE_DB, repositoryId: REPO }, "startup");
  });

  it("clears the backoff on a run that completes", async () => {
    writeAutoSyncState(home, REPO, {
      lastAttemptAt: new Date(clock - 86_400_000).toISOString(),
      lastOkAt: null,
      consecutiveFailures: 7,
      nextEligibleAt: new Date(clock - 1).toISOString(),
      lastOutcome: "failed",
    });
    const scheduler = new AutoSyncScheduler({ home, now, syncImpl: async () => report() });
    expect((await scheduler.request({ db: FAKE_DB, repositoryId: REPO }, "startup")).status).toBe(
      "synced",
    );
    const state = readAutoSyncState(home, REPO);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.nextEligibleAt).toBeNull();
    expect(state.lastOkAt).not.toBeNull();
  });
});

// ------------------------------------------------------------ the surface wiring

describe("the surface wiring", () => {
  it("a stopped surface fires nothing, and its interval is gone", () => {
    connect(true);
    let resolved = 0;
    const surface = new SurfaceAutoSync({
      home: () => home,
      resolve: () => {
        resolved += 1;
        return { db: FAKE_DB, repositoryId: REPO };
      },
      sessionIntervalMs: 1,
    });
    surface.startSession();
    surface.stop();
    surface.postWrite();
    surface.startup();
    expect(resolved).toBe(0);
  });

  it("a resolver that throws is not a reason for anything to fail", () => {
    connect(true);
    const surface = new SurfaceAutoSync({
      home: () => home,
      resolve: () => {
        throw new Error("no workspace here");
      },
    });
    expect(() => surface.postWrite()).not.toThrow();
    expect(() => surface.startup()).not.toThrow();
  });

  it("a workspace with no identity fires nothing", () => {
    connect(true);
    const surface = new SurfaceAutoSync({ home: () => home, resolve: () => null });
    expect(() => surface.postWrite()).not.toThrow();
    expect(surface.busy).toBe(false);
  });
});

describe("the CLI command table", () => {
  /**
   * *"absence means no trigger"*. These are the commands whose presence would be
   * a bug, and each is here for its own reason — so a future edit that adds one
   * has to delete a line that says why it must not.
   */
  it("never triggers on a cloud subcommand — a trigger on `cloud sync` is a recursion", () => {
    expect(CLI_COMMAND_TRIGGERS.cloud).toBeUndefined();
  });

  it("never triggers on the lifecycle commands that move a home or a database", () => {
    for (const command of ["install", "init", "migrate", "config"]) {
      expect(CLI_COMMAND_TRIGGERS[command], command).toBeUndefined();
    }
  });

  it("never triggers on the UI commands, which register their own", () => {
    for (const command of ["open", "ui", "help"]) {
      expect(CLI_COMMAND_TRIGGERS[command], command).toBeUndefined();
    }
  });

  it("never triggers on doctor, which exists to report a machine rather than change it", () => {
    expect(CLI_COMMAND_TRIGGERS.doctor).toBeUndefined();
  });

  it("puts the everyday writes on post-write and the everyday reads on startup", () => {
    for (const command of ["new", "checkout", "done", "comment", "status", "release"]) {
      expect(CLI_COMMAND_TRIGGERS[command], command).toBe("post-write");
    }
    for (const command of ["ls", "show", "tree", "board", "inbox"]) {
      expect(CLI_COMMAND_TRIGGERS[command], command).toBe("startup");
    }
  });

  it("reads --db and --ws out of a raw argv in both spellings", () => {
    expect(globalFlagsOf(["NET-1", "--db", "/tmp/a.db"])).toEqual({ db: "/tmp/a.db" });
    expect(globalFlagsOf(["--ws=alpha", "--json"])).toEqual({ ws: "alpha" });
    // A flag with no value is not a value: `--db --json` must not yield "--json".
    expect(globalFlagsOf(["--db", "--json"])).toEqual({});
  });
});

describe("runCommandTrigger, on the everyday path", () => {
  let repoDir: string;
  let dbPath: string;
  let previousHome: string | undefined;
  let counter = 0;

  beforeEach(() => {
    // The hub lives in the staple home, and `initWorkspace` registers in it. Point
    // it at this case's temporary home so the suite never touches the real one.
    previousHome = process.env.STAPLE_HOME;
    process.env.STAPLE_HOME = home;
    repoDir = mkdtempSync(join(tmpdir(), "staple-auto-repo-"));
    mkdirSync(join(repoDir, ".staple"), { recursive: true });
    counter += 1;
    const ws = initWorkspace({ dir: repoDir, slug: `autotrigger${counter}` });
    dbPath = ws.dbPath;
    ws.store.db.close();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previousHome;
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns without opening a database when nothing has ever been connected", async () => {
    let opened = 0;
    const outcome = await runCommandTrigger("ls", ["--db", dbPath], {
      home,
      open: () => {
        opened += 1;
        throw new Error("unreachable");
      },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "no-connections" });
    expect(opened).toBe(0);
  });

  it("returns without opening a database on a CONNECTED repository in manual mode", async () => {
    const manifest = JSON.parse(
      readFileSync(join(dirname(dbPath), "repository.json"), "utf8"),
    ) as { repositoryId: string };
    connect(false, manifest.repositoryId);

    let opened = 0;
    const outcome = await runCommandTrigger("comment", ["--db", dbPath], {
      home,
      open: () => {
        opened += 1;
        throw new Error("unreachable");
      },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "manual" });
    /**
     * The whole cost of automatic sync on a manual-mode machine: two file reads.
     * No workspace opened, and — asserted structurally below — no transport
     * module loaded.
     */
    expect(opened).toBe(0);
  });

  it("fires for a command in the table, and not for one that is absent", async () => {
    const manifest = JSON.parse(
      readFileSync(join(dirname(dbPath), "repository.json"), "utf8"),
    ) as { repositoryId: string };
    connect(true, manifest.repositoryId);

    const fired: string[] = [];
    const stub = {
      request: (_t: unknown, trigger: string) => {
        fired.push(trigger);
        return Promise.resolve({ status: "skipped", reason: "manual" as const });
      },
    } as unknown as AutoSyncScheduler;

    const options = {
      home,
      open: () => ({ db: FAKE_DB, close: () => undefined }),
      scheduler: () => stub,
    };
    await runCommandTrigger("done", ["--db", dbPath], options);
    await runCommandTrigger("ls", ["--db", dbPath], options);
    await runCommandTrigger("doctor", ["--db", dbPath], options);
    await runCommandTrigger("cloud", ["sync", "--db", dbPath], options);
    expect(fired).toEqual(["post-write", "startup"]);
  });

  it("closes the handle it opened, on every path", async () => {
    const manifest = JSON.parse(
      readFileSync(join(dirname(dbPath), "repository.json"), "utf8"),
    ) as { repositoryId: string };
    connect(true, manifest.repositoryId);
    let closed = 0;
    await runCommandTrigger("done", ["--db", dbPath], {
      home,
      open: () => ({
        db: FAKE_DB,
        close: () => {
          closed += 1;
        },
      }),
      scheduler: () =>
        ({
          request: () => Promise.reject(new Error("boom")),
        }) as unknown as AutoSyncScheduler,
    }).catch(() => undefined);
    expect(closed).toBe(1);
  });
});

// -------------------------------------------------------------- the import graph

describe("the gate cannot reach the network, and that is structural", () => {
  /**
   * A transitive walk, not a one-level import list.
   *
   * `test/repo-identity.test.ts` pins its module's direct imports, which is the
   * right assertion for a leaf. This one is not a leaf: it imports
   * `connection.ts`, which imports `credential-store.ts`, and the claim being
   * made is about everything reachable from it. A one-level check would have
   * passed the day somebody added `fetch` two hops away.
   */
  function reachable(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:^|\n)import\s+(?:type\s+)?[^;]*?from\s+"(\.[^"]+)"/g)) {
        // `import type` is erased by the compiler and creates no runtime edge.
        if (/import\s+type\s/.test(match[0])) continue;
        const resolved = join(dirname(file), match[1]!.replace(/\.js$/, ".ts"));
        if (existsSync(resolved)) queue.push(resolved);
      }
    }
    return seen;
  }

  const CLOUD = new URL("../src/core/cloud/", import.meta.url).pathname;

  it("`auto.ts` cannot reach `sync.ts` or `client.ts`", () => {
    const graph = reachable(join(CLOUD, "auto.ts"));
    expect([...graph].filter((f) => /\/(sync|client)\.ts$/.test(f))).toEqual([]);
    // And it holds no `fetch(` of its own, which no import walk would catch.
    for (const file of graph) expect(readFileSync(file, "utf8"), file).not.toMatch(/\bfetch\s*\(/);
  });

  it("`auto-state.ts` cannot either — the clock is files, and stays files", () => {
    const graph = reachable(join(CLOUD, "auto-state.ts"));
    expect([...graph].filter((f) => /\/(sync|client)\.ts$/.test(f))).toEqual([]);
  });

  /**
   * The scheduler is allowed to reach the transport — that is its job — but only
   * through a DYNAMIC import, which runs after the gate. A static one would put
   * `client.ts` in the import graph of every surface that registers a trigger,
   * and the module that captures `fetch` at load time would then be evaluated on
   * every `staple ls` on every machine.
   */
  it("`auto-sync.ts` reaches the transport only through `await import()`", () => {
    const source = readFileSync(join(CLOUD, "auto-sync.ts"), "utf8");
    const staticValueImports = [...source.matchAll(/(?:^|\n)import\s+(?!type\s)[^;]*?from\s+"([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(staticValueImports).not.toContain("./sync.js");
    expect(staticValueImports).not.toContain("./client.js");
    expect(source).toMatch(/await import\("\.\/sync\.js"\)/);
  });

  /**
   * The same discipline for the hub registry command group (STA-283).
   *
   * `src/commands/hub-registry.ts` is statically imported by `src/cli.ts`, so it is
   * evaluated on every invocation including `staple ls`. It may reach the transport only
   * through `await import()`; a static `import { publishRegistry }` would add a second
   * static edge from the CLI entry point to `client.ts` and nothing else in the tree would
   * notice — the runtime spy in `test/cloud-hub-registry-cli.test.ts` proves no CALL is
   * made, which is the property that matters, but it would stay green while the graph
   * quietly widened.
   */
  it("`commands/hub-registry.ts` reaches the registry service only through `await import()`", () => {
    const source = readFileSync(
      new URL("../src/commands/hub-registry.ts", import.meta.url).pathname,
      "utf8",
    );
    const staticValueImports = [
      ...source.matchAll(/(?:^|\n)import\s+(?!type\s)[^;]*?from\s+"([^"]+)"/g),
    ].map((m) => m[1]!);
    expect(staticValueImports).not.toContain("../core/cloud/hub-registry-service.js");
    expect(staticValueImports).not.toContain("../core/cloud/client.js");
    expect(staticValueImports).not.toContain("../core/cloud/sync.js");
    expect(source).toMatch(/await import\(|import\("\.\.\/core\/cloud\/hub-registry-service\.js"\)/);
    // The guard on the guard: the regex above must have found imports at all.
    expect(staticValueImports.length).toBeGreaterThan(3);
  });

  /**
   * And the two leaf modules stay leaves.
   *
   * `hub-registry.ts` holds `REGISTRY_DISCLOSURE`, which `hub-surface.ts` renders — and
   * `hub-surface.ts` is reached by a route the settings page POLLS. If the leaf ever
   * acquired the transport, every poll would evaluate the module that captures `fetch`.
   * That is why the constant lives there rather than beside the code that spends it.
   */
  it("`hub-registry.ts` and `hub-registry-ops.ts` cannot reach `client.ts`", () => {
    for (const leaf of ["hub-registry.ts", "hub-registry-ops.ts"]) {
      const graph = reachable(join(CLOUD, leaf));
      expect([...graph].filter((f) => /\/client\.ts$/.test(f)), leaf).toEqual([]);
      for (const file of graph) {
        expect(readFileSync(file, "utf8"), `${leaf} -> ${file}`).not.toMatch(/\bfetch\s*\(/);
      }
    }
  });
});
