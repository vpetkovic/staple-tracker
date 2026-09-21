/**
 * A process that opened a workspace before this machine ever connected starts journaling
 * the moment it has connected, without being restarted.
 *
 * The UI server and the MCP server each hold one database connection, and one journal, for
 * as long as they run. The journal used to resolve this machine's device id once, when it
 * was made — and a machine that has never connected has none — so a server started before
 * the first `staple cloud connect` journaled nothing for the rest of its life. Every issue
 * created through it after connecting stayed on this machine: the first sync's seed had
 * already run, nothing was queued, and nothing said so.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ensureDeviceId } from "../src/core/cloud/device.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { syncRepository } from "../src/core/cloud/sync.js";
import { openWorkspace } from "../src/core/open.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { ENDPOINT, Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000129";

let fleet: Fleet | null = null;
const toClose: Array<{ close(): void }> = [];
afterEach(() => {
  for (const db of toClose.splice(0)) db.close();
  fleet?.close();
  fleet = null;
});

describe("a long-lived process opened before the first connect", () => {
  it("journals what it writes once this machine has connected, so the next sync sends it", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const { home, dir } = fleet.prepare("a");
    const dbPath = `${dir}/.staple/staple.db`;

    // The server process: its connection, and its journal, made before any device exists.
    process.env.STAPLE_HOME = home;
    delete process.env.STAPLE_DEVICE_ID;
    const serverProcess = openWorkspace(dbPath);
    toClose.push(serverProcess.store.db);
    serverProcess.store.createIssue({ title: "Before connecting" });

    // `staple cloud connect`, then `staple cloud sync`, each in a process of its own.
    const deviceId = ensureDeviceId(home);
    credentialStoreFor(home, "file").write(REPO, `token-${deviceId}`);
    writeConnection(home, {
      schemaVersion: 1,
      repositoryId: REPO,
      endpoint: ENDPOINT,
      deviceId,
      label: "a",
      credentialMechanism: "file",
      connectedAt: "2026-09-10T00:00:00.000Z",
      auto: false,
      backup: false,
      protocol: 1,
    });
    server.enroll(deviceId, `token-${deviceId}`);
    const syncProcess = () => {
      const opened = openWorkspace(dbPath);
      return syncRepository(opened.store.db, REPO, { home, fetchImpl: server.fetch, sleep: async () => undefined }).finally(
        () => opened.store.db.close(),
      );
    };
    await syncProcess();

    // The server, still running, writes again.
    const after = serverProcess.store.createIssue({ title: "After connecting, through the running server" });
    expect(
      (serverProcess.store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE entity_id = ?").get(after.id) as { n: number }).n,
    ).toBe(1);
    await syncProcess();

    const b = fleet.machine("b");
    await b.sync();
    expect(b.db.prepare("SELECT title FROM issues ORDER BY title").all()).toEqual([
      { title: "After connecting, through the running server" },
      { title: "Before connecting" },
    ]);
  });
});
