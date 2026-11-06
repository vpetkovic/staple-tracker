/**
 * A shared workspace actually stays in sync, with nobody running `cloud sync`.
 *
 * The recorded two-UI run found three gaps, each reproduced here:
 *   1. a CLI write with `--ws` never pushed (the trigger resolved the current directory);
 *   2. a hub-mode UI server synced only its default workspace, never one registered later;
 *   3. five minutes between session syncs is too slow for two people.
 *
 * Two machines over the Fleet fixture: the owner in a checkout, the buddy in a workspace
 * joined from a link (home-resident, no checkout anywhere).
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutoSyncScheduler, type AutoSyncSchedulerOptions } from "../src/core/cloud/auto-sync.js";
import { runCommandTrigger, SurfaceAutoSync } from "../src/core/cloud/auto-triggers.js";
import { AUTO_SYNC_SESSION_INTERVAL_MS, AUTO_SYNC_SHARED_SESSION_INTERVAL_MS } from "../src/core/cloud/auto.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { MEMBERS_CACHE_VERSION, writeMembersCache } from "../src/core/cloud/members-cache.js";
import { resolveJoinTarget } from "../src/core/cloud/share.js";
import { bindJournal } from "../src/core/journal.js";
import { openWorkspace } from "../src/core/open.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { ENDPOINT, Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-00000000a5e7";
const dirs: string[] = [];
const previousHome = process.env.STAPLE_HOME;
let fleet: Fleet | null = null;
let ui: UiHandle | null = null;

afterEach(() => {
  ui?.close();
  ui = null;
  fleet?.close();
  fleet = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
});

function tmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `staple-shared-sync-${label}-`));
  dirs.push(dir);
  return dir;
}

/** Two current members, with this machine's device as `self`. */
function sharedCache(home: string, selfDevice: string): void {
  writeMembersCache(home, {
    version: MEMBERS_CACHE_VERSION,
    repositoryId: REPO,
    fetchedAt: "2026-11-06T00:00:00.000Z",
    self: { memberId: selfDevice === "device-owner" ? "m-vp" : "m-marko", deviceId: selfDevice },
    members: [
      { memberId: "m-vp", name: "VP", isOwner: true, removed: false, devices: [] },
      { memberId: "m-marko", name: "marko", isOwner: false, removed: false, devices: [] },
    ],
  });
}

function connect(home: string, deviceId: string, server: FakeSyncServer, auto = true): void {
  const token = `token-${deviceId}`;
  credentialStoreFor(home, "file").write(REPO, token);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO,
    endpoint: ENDPOINT,
    deviceId,
    label: deviceId,
    credentialMechanism: "file",
    connectedAt: "2026-11-06T00:00:00.000Z",
    auto,
    ...(auto ? { autoReason: "shared-workspace" as const } : {}),
    backup: false,
    protocol: 1,
  });
  server.enroll(deviceId, token);
}

/** A scheduler that talks to the fake service instead of the network. */
const viaFake = (server: FakeSyncServer, now?: () => number) => (options: AutoSyncSchedulerOptions) =>
  new AutoSyncScheduler({ ...options, fetchImpl: server.fetch, ...(now ? { now } : {}) });

/** The buddy: an empty home, joined from a link, so its workspace is home-resident. */
function buddyFromLink(server: FakeSyncServer): { home: string; dbPath: string } {
  const home = tmp("buddy");
  process.env.STAPLE_HOME = home;
  const link = { endpoint: ENDPOINT, repositoryId: REPO, name: "ai-inbox", prefix: null, sharedBy: "VP", invitedAs: "marko" };
  const target = resolveJoinTarget({ home, cwd: tmp("nowhere"), link, create: true });
  expect(target).toMatchObject({ name: "ai-inbox", created: true, fromCheckout: false });
  connect(home, "device-buddy", server);
  sharedCache(home, "device-buddy");
  return { home, dbPath: target.dbPath };
}

describe("a --ws write on a link-joined workspace is pushed, and the owner's session pulls it", () => {
  it("delivers without anybody running cloud sync", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const owner = fleet.machine("owner");
    sharedCache(owner.home, "device-owner");
    // The owner's device consents too: a shared workspace syncs on every device.
    writeConnection(owner.home, readOwnerConnection(owner.home));

    // The buddy writes, through the CLI's path: a store write, then the trigger with --ws,
    // run from a directory that is no workspace at all.
    const buddy = buddyFromLink(server);
    const opened = openWorkspace(buddy.dbPath);
    bindJournal(opened.store.db, "device-buddy");
    opened.store.createIssue({ title: "Rate-limit the webhook endpoint", createdBy: "marko" });
    opened.store.db.close();

    const pushed = await runCommandTrigger("new", ["new", "Rate-limit the webhook endpoint", "--ws", "ai-inbox"], {
      home: buddy.home,
      cwd: tmp("not-a-workspace"),
      scheduler: viaFake(server),
    });
    expect(pushed.status).toBe("synced");
    expect(server.ops.map((op) => op.entity)).toContain("issue");

    // The owner's open page: a session tick 30 s in pulls it (the workspace is shared).
    owner.use();
    let clock = 1_000_000;
    const surface = new SurfaceAutoSync({
      home: () => owner.home,
      resolve: () => ({ db: owner.db, repositoryId: REPO }),
      scheduler: viaFake(server, () => clock),
      now: () => clock,
    });
    surface.startSession();
    clock += AUTO_SYNC_SHARED_SESSION_INTERVAL_MS;
    surface.tickSession();
    await waitUntil(() => !surface.busy && titles(owner.db).includes("Rate-limit the webhook endpoint"));
    surface.stop();
    expect(titles(owner.db)).toContain("Rate-limit the webhook endpoint");
  });
});

function readOwnerConnection(home: string) {
  process.env.STAPLE_HOME = home;
  return {
    schemaVersion: 1,
    repositoryId: REPO,
    endpoint: ENDPOINT,
    deviceId: "device-owner",
    label: "owner",
    credentialMechanism: "file" as const,
    connectedAt: "2026-09-10T00:00:00.000Z",
    auto: true,
    autoReason: "shared-workspace" as const,
    backup: false,
    protocol: 1,
  };
}

function titles(db: import("node:sqlite").DatabaseSync): string[] {
  return (db.prepare("SELECT title FROM issues").all() as Array<{ title: string }>).map((row) => row.title);
}

async function waitUntil(condition: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the session interval", () => {
  it("is 30 s for a shared workspace and stays 5 min for one person", () => {
    expect(AUTO_SYNC_SHARED_SESSION_INTERVAL_MS).toBe(30_000);
    const home = tmp("home");
    for (const shared of [true, false]) {
      let clock = 0;
      const fired: string[] = [];
      const surface = new SurfaceAutoSync({
        home: () => home,
        resolve: () => ({ db: null as never, repositoryId: REPO }),
        isShared: () => shared,
        now: () => clock,
        scheduler: () =>
          ({
            request: async () => {
              fired.push(String(clock));
              return { status: "skipped", reason: "manual" };
            },
            stop: () => undefined,
            busy: false,
          }) as unknown as AutoSyncScheduler,
      });
      surface.startSession();
      clock = AUTO_SYNC_SHARED_SESSION_INTERVAL_MS;
      surface.tickSession();
      clock = AUTO_SYNC_SESSION_INTERVAL_MS;
      surface.tickSession();
      surface.stop();
      expect(fired).toEqual(shared ? ["30000", "300000"] : ["300000"]);
    }
  });
});

describe("a hub-mode UI server syncs every consenting workspace, including one registered later", () => {
  it("fires for a workspace that joined after the server started, and never for one not connected", async () => {
    const home = tmp("ui-home");
    process.env.STAPLE_HOME = home;
    const requested: Array<{ repositoryId: string; trigger: string }> = [];
    const scheduler = () =>
      ({
        request: async (target: { repositoryId: string }, trigger: string) => {
          requested.push({ repositoryId: target.repositoryId, trigger });
          return { status: "skipped", reason: "manual" };
        },
        stop: () => undefined,
        busy: false,
      }) as unknown as AutoSyncScheduler;
    ui = startUiServer({ port: 0, hub: true, autoSync: { sharedSessionIntervalMs: 20, scheduler } });
    await once(ui.server, "listening");
    expect((ui.server.address() as AddressInfo).port).toBeGreaterThan(0);

    // After start, first: a workspace nobody connected. It is the hub's first row, so it is
    // what a server that synced only its default workspace would sync; it must never be.
    const link = { endpoint: ENDPOINT, repositoryId: REPO, name: "ai-inbox", prefix: null, sharedBy: "VP", invitedAs: null };
    resolveJoinTarget({
      home,
      cwd: tmp("nowhere"),
      link: { ...link, repositoryId: "5eed0000-0000-4000-8000-0000000000aa", name: "aaa-solo" },
      create: true,
    });
    // Then a workspace joined from a link, connected and shared.
    const server = new FakeSyncServer({ repositoryId: REPO });
    resolveJoinTarget({ home, cwd: tmp("nowhere"), link, create: true });
    connect(home, "device-buddy", server);
    sharedCache(home, "device-buddy");

    await waitUntil(() => requested.some((r) => r.repositoryId === REPO && r.trigger === "session"));
    expect(requested.every((r) => r.repositoryId === REPO)).toBe(true);
  });
});

describe("each workspace has its own scheduler", () => {
  it("syncs workspace B while workspace A's run is still in flight", async () => {
    const home = tmp("two");
    process.env.STAPLE_HOME = home;
    const OTHER = "5eed0000-0000-4000-8000-0000000000bb";
    const server = new FakeSyncServer({ repositoryId: REPO });
    const dbs = new Map<string, import("node:sqlite").DatabaseSync>();
    for (const [repositoryId, name] of [[REPO, "a"], [OTHER, "b"]] as const) {
      const target = resolveJoinTarget({
        home,
        cwd: tmp("nowhere"),
        link: { endpoint: ENDPOINT, repositoryId, name, prefix: null, sharedBy: null, invitedAs: null },
        create: true,
      });
      credentialStoreFor(home, "file").write(repositoryId, `token-${name}`);
      writeConnection(home, {
        schemaVersion: 1,
        repositoryId,
        endpoint: ENDPOINT,
        deviceId: `device-${name}`,
        label: name,
        credentialMechanism: "file",
        connectedAt: "2026-11-06T00:00:00.000Z",
        auto: true,
        backup: false,
        protocol: 1,
      });
      dbs.set(name, openWorkspace(target.dbPath).store.db);
    }
    const synced: string[] = [];
    let releaseA: () => void = () => undefined;
    const surface = new SurfaceAutoSync({
      home: () => home,
      resolve: (ws) => ({ db: dbs.get(ws!)!, repositoryId: ws === "a" ? REPO : OTHER }),
      scheduler: (options) =>
        new AutoSyncScheduler({
          ...options,
          fetchImpl: server.fetch,
          syncImpl: async (_db, repositoryId) => {
            synced.push(repositoryId);
            if (repositoryId === REPO) await new Promise<void>((resolve) => (releaseA = resolve));
            return {} as never;
          },
        }),
    });
    surface.postWrite("a");
    await waitUntil(() => synced.includes(REPO));
    surface.postWrite("b");
    await waitUntil(() => synced.includes(OTHER));
    releaseA();
    surface.stop();
    for (const db of dbs.values()) db.close();
    expect(synced).toEqual([REPO, OTHER]);
  });
});
