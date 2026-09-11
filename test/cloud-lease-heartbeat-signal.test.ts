/**
 * `staple cloud lease renew --heartbeat`: a second Ctrl-C while the heartbeat is
 * winding down is absorbed (STA-255, the sibling of the `staple open` fix).
 *
 * The heartbeat stops on Ctrl-C by aborting its loop, and then finishes the beat
 * in flight and prints its report. It registered that stop with `process.once`.
 * A `once` listener removes itself as it fires, and with no listener left Node
 * restores the default disposition. So a second Ctrl-C while the last renewal
 * was still in flight killed the process by signal, and the report never came.
 *
 * This drives the real CLI against the fake sync service over HTTP. The service
 * holds every renewal until the test releases it, which puts both signals
 * inside the wind-down every time: the first while a renewal is in flight, the
 * second a moment later, and only then does the renewal answer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { readStoredRepositoryId } from "../src/core/repo-identity.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { spawnCli } from "./fixtures/lifecycle-support.js";

const DEVICE = "device-heartbeat-signal";
const TOKEN = "tok-heartbeat-signal";

let home: string;
let repo: string;
let ref: string;
let fake: FakeSyncServer;
let service: Server;
/** Renewal requests the service has received and not yet answered. */
let heldRenewals: Array<() => void> = [];
let renewalsSeen = 0;

async function bridge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[name] = value;
  }
  const url = `http://127.0.0.1${req.url ?? "/"}`;
  if (/\/leases\/[^/]+\/renew$/.test(new URL(url).pathname)) {
    renewalsSeen += 1;
    await new Promise<void>((release) => heldRenewals.push(release));
  }
  const response = await fake.fetch(url, { method: req.method ?? "GET", headers, ...(body ? { body } : {}) });
  res.writeHead(response.status, { "content-type": "application/json" });
  res.end(await response.text());
}

beforeAll(async () => {
  home = tempDir("beat-signal-home");
  repo = tempDir("beat-signal-repo");
  const env = { STAPLE_HOME: home };
  expect(runCliAt(repo, ["init"], env).status).toBe(0);

  const db = openDb(join(repo, ".staple", "staple.db"));
  const repositoryId = readStoredRepositoryId(db)!;
  bindJournal(db, DEVICE);
  db.close();

  fake = new FakeSyncServer({ repositoryId });
  fake.enroll(DEVICE, TOKEN);
  service = createServer((req, res) => void bridge(req, res));
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const endpoint = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

  credentialStoreFor(home, "file").write(repositoryId, TOKEN);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId,
    endpoint,
    deviceId: DEVICE,
    label: "heartbeat-signal",
    credentialMechanism: "file",
    connectedAt: "2026-09-11T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 1,
  });

  const created = runCliAt(repo, ["new", "long work", "--json"], env);
  expect(created.status, created.stderr).toBe(0);
  ref = (JSON.parse(created.stdout) as { identifier: string }).identifier;
  // Spawned, not spawnSync: the service answers from this process's event loop.
  const acquire = spawnCli(["cloud", "lease", "acquire", ref, "--agent", "agent-a", "--ttl", "5m"], {
    cwd: repo,
    env,
  });
  expect(await acquire.waitForExit(25_000), acquire.stderr()).toBe(0);
}, 60_000);

afterAll(() => {
  for (const release of heldRenewals) release();
  service?.close();
  removeDir(home);
  removeDir(repo);
});

describe("a second signal while the heartbeat winds down (STA-255)", () => {
  it.each([
    ["SIGINT", "SIGINT"],
    ["SIGTERM", "SIGTERM"],
  ] as const)("%s, then %s during the last renewal: absorbed, and the report is printed", async (first, second) => {
    heldRenewals = [];
    renewalsSeen = 0;
    const proc = spawnCli(["cloud", "lease", "renew", ref, "--heartbeat", "1s", "--for", "60s"], {
      cwd: repo,
      env: { STAPLE_HOME: home },
    });

    // The first beat's renewal is at the service and being held.
    expect(await proc.waitFor(() => renewalsSeen === 1, 25_000)).toBe(true);
    proc.signalIt(first);
    // Let the first signal be handled before the second arrives, so the second
    // lands after the stop, which is where `once` had left no listener.
    await new Promise((r) => setTimeout(r, 300));
    proc.signalIt(second);
    await new Promise((r) => setTimeout(r, 300));
    for (const release of heldRenewals) release();

    const code = await proc.waitForExit(25_000);
    expect({ code, signal: proc.signal() }, proc.stderr()).toEqual({ code: 0, signal: null });
    expect(proc.stdout()).toContain("stopped: cancelled after 1 beat");
    // The stop did what it says: no renewal after the one in flight.
    expect(renewalsSeen).toBe(1);
  }, 60_000);
});
