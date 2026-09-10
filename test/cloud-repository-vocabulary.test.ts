/**
 * A repository holds ONE vocabulary (STA-290), client side.
 *
 * Two things are pinned here, and neither is the Worker's rule itself — that is
 * `worker/test/vocabulary.test.ts`, against the real Worker in workerd:
 *
 *  1. **The fake refuses exactly what the Worker refuses, with the same bytes.** Both
 *     suites compare against `worker/test/vocabulary-fixture.ts`, one committed set of
 *     literals. The epic learned six times that a fake more permissive than the service
 *     hides bugs; before this change the fake accepted a registry push into a workspace
 *     repository, which the deployed Worker now refuses.
 *  2. **A person sees a sentence, not a code**, and the refusal is not retried. Asserted
 *     through `syncRepository` and `publishRegistry`, the paths a person actually runs,
 *     not only through the transport.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { Hub } from "../src/core/hub.js";
import { bindJournal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import {
  acquireRemoteLease,
  advanceRemoteRestore,
  cloudCodeOf,
  isVocabularyRefusal,
  pushOperations,
  vocabularyRefusalMessage,
} from "../src/core/cloud/client.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { parseEndpoint } from "../src/core/cloud/endpoint.js";
import { REGISTRY_PROTOCOL } from "../src/core/cloud/hub-registry-ops.js";
import {
  REGISTRY_DISCLOSURE,
  publishRegistry,
  setRegistryConsent,
} from "../src/core/cloud/hub-registry-service.js";
import { syncRepository } from "../src/core/cloud/sync.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { VOCABULARY_REFUSALS } from "../worker/test/vocabulary-fixture.js";

const REPO_ID = "0e77fa01-2900-4290-8290-000000000290";
const ENDPOINT = "https://sync.test.example";
const DEVICE = "device-a";
const TOKEN = "stpl_vocab_test_device-a";

let dirs: string[] = [];
let stores: WorkspaceStore[] = [];
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.STAPLE_HOME;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  for (const store of stores) store.db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  stores = [];
  dirs = [];
});

function registration(index: number, protocol = 2): Record<string, unknown> {
  return {
    opId: `reg-${index}`,
    repoId: REPO_ID,
    protocol,
    schema: 12,
    entity: "registration",
    entityId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    verb: "create",
    baseVersion: null,
    payload: { format: 1, slug: `ws-${index}`, prefix: `W${index}`, kind: "repo", addedAt: "x" },
    deviceId: DEVICE,
    actor: "opus-vocab",
    clientSeq: index,
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

function issue(index: number): Record<string, unknown> {
  return {
    opId: `issue-${index}`,
    repoId: REPO_ID,
    protocol: 1,
    schema: 12,
    entity: "issue",
    entityId: `issue-${index}`,
    verb: "create",
    baseVersion: null,
    payload: { title: `work ${index}` },
    deviceId: DEVICE,
    actor: "opus-vocab",
    clientSeq: index,
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

function serverWith(vocabulary?: "hub" | "workspace"): FakeSyncServer {
  const server = new FakeSyncServer({
    repositoryId: REPO_ID,
    ...(vocabulary === undefined ? {} : { vocabulary }),
  });
  server.enroll(DEVICE, TOKEN);
  return server;
}

/** The raw answer, exactly as a client would read it off the wire. */
async function rawPush(
  server: FakeSyncServer,
  ops: Record<string, unknown>[],
  protocol: number,
): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify({ protocol, deviceId: DEVICE, ops });
  const response = await server.fetch(`${ENDPOINT}/v1/repos/${REPO_ID}/ops`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Staple-Protocol": String(protocol),
      "Staple-Device": DEVICE,
      "Content-Type": "application/json",
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function rejection(promise: Promise<unknown>): Promise<StapleError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StapleError);
  return error as StapleError;
}

const repoCall = { repositoryId: REPO_ID, token: TOKEN, deviceId: DEVICE };

// ------------------------------------------------------------- the fake

describe("the fake refuses exactly what the Worker refuses", () => {
  it("claims the vocabulary on the first push, and not on an empty one", async () => {
    const server = serverWith();
    expect(server.vocabulary).toBeNull();
    expect((await rawPush(server, [], 2)).status).toBe(200);
    expect(server.vocabulary).toBeNull();
    expect((await rawPush(server, [issue(1)], 1)).status).toBe(200);
    expect(server.vocabulary).toBe("workspace");
  });

  it("answers registry operations into a workspace repository with the Worker's bytes", async () => {
    const server = serverWith();
    await rawPush(server, [issue(1)], 1);
    expect(await rawPush(server, [registration(2)], 2)).toEqual(
      VOCABULARY_REFUSALS.hubIntoWorkspace,
    );
    // Refused before a slot was reserved or a row written, as the Worker's batch is.
    expect(server.ops.map((op) => op.entity)).toEqual(["issue"]);
    expect(server.lastSeq).toBe(1);
  });

  it("answers workspace operations into a hub repository with the Worker's bytes", async () => {
    const server = serverWith();
    await rawPush(server, [registration(1)], 2);
    expect(await rawPush(server, [issue(2)], 1)).toEqual(VOCABULARY_REFUSALS.workspaceIntoHub);
    expect(server.ops.map((op) => op.entity)).toEqual(["registration"]);
    expect(server.lastSeq).toBe(1);
  });

  it("honours a vocabulary set at provisioning, before any operation exists", async () => {
    expect(await rawPush(serverWith("hub"), [issue(1)], 1)).toEqual(
      VOCABULARY_REFUSALS.workspaceIntoHub,
    );
    expect(await rawPush(serverWith("workspace"), [registration(1)], 2)).toEqual(
      VOCABULARY_REFUSALS.hubIntoWorkspace,
    );
  });
});

// ------------------------------------------------------- the transport

describe("the client turns the refusal into a sentence", () => {
  it("names the remedy for registry data offered to a workspace repository", async () => {
    const server = serverWith("workspace");
    const error = await rejection(
      pushOperations(
        parseEndpoint(ENDPOINT),
        { ...repoCall, epoch: null, ops: [registration(1)] },
        { fetchImpl: server.fetch, protocol: REGISTRY_PROTOCOL },
      ),
    );
    expect(error.code).toBe("conflict");
    expect(cloudCodeOf(error)).toBe("conflict");
    expect(error.detail).toMatchObject({
      retryable: false,
      repositoryVocabulary: "workspace",
      requestVocabulary: "hub",
      serverMessage: VOCABULARY_REFUSALS.hubIntoWorkspace.body.message,
    });
    expect(error.message).toBe(
      vocabularyRefusalMessage(ENDPOINT, "workspace", "hub"),
    );
    expect(error.message).toContain("holds a workspace's data, not a hub registry");
    expect(error.message).toContain('"Provisioning a HUB"');
    expect(isVocabularyRefusal(error)).toBe(true);
  });

  it("names the remedy for workspace data offered to a hub repository", async () => {
    const server = serverWith("hub");
    const error = await rejection(
      pushOperations(
        parseEndpoint(ENDPOINT),
        { ...repoCall, epoch: null, ops: [issue(1)] },
        { fetchImpl: server.fetch },
      ),
    );
    expect(error.message).toBe(vocabularyRefusalMessage(ENDPOINT, "hub", "workspace"));
    expect(error.message).toContain("holds a hub's workspace registry, not a workspace's data");
    expect(error.message).toContain('"Provisioning a repository"');
    expect(isVocabularyRefusal(error)).toBe(true);
  });

  it("does not mistake a lease race for a vocabulary refusal", async () => {
    // The same code, 409 `conflict`, which is exactly why the detail keys exist.
    const server = serverWith();
    const lease = { entityId: "issue-1", holder: "somebody" };
    const post = (holder: string) =>
      server.fetch(`${ENDPOINT}/v1/repos/${REPO_ID}/leases`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Staple-Protocol": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...lease, holder }),
      });
    expect((await post("first")).status).toBe(200);
    const error = await rejection(
      acquireRemoteLease(
        parseEndpoint(ENDPOINT),
        { ...repoCall, entityId: "issue-1", holder: "second" },
        { fetchImpl: server.fetch },
      ),
    );
    expect(cloudCodeOf(error)).toBe("conflict");
    expect(isVocabularyRefusal(error)).toBe(false);
    expect(error.message).toBe("lease is held by another device");
  });
});

// ------------------------------------------------------------ restore

describe("a restore keeps the rule, in the fake as in the Worker", () => {
  async function enableAndBackUp(server: FakeSyncServer, protocol: number): Promise<string> {
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      "Staple-Protocol": String(protocol),
      "Content-Type": "application/json",
    };
    await server.fetch(`${ENDPOINT}/v1/repos/${REPO_ID}/backup`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    const created = await server.fetch(`${ENDPOINT}/v1/repos/${REPO_ID}/backups`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    return ((await created.json()) as { backup: { backupId: string } }).backup.backupId;
  }

  async function rawRestore(
    server: FakeSyncServer,
    backupId: string,
  ): Promise<{ status: number; body: unknown }> {
    const response = await server.fetch(
      `${ENDPOINT}/v1/repos/${REPO_ID}/backups/${backupId}/restore`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Staple-Protocol": "2",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirm: REPO_ID }),
      },
    );
    return { status: response.status, body: await response.json() };
  }

  it("refuses a hub backup into a workspace repository before the undo is captured", async () => {
    const server = serverWith();
    await rawPush(server, [registration(1)], 2);
    const hubBackup = await enableAndBackUp(server, 2);
    // Reclassified, as an operator does after the recovery recipe.
    server.ops.length = 0;
    server.vocabulary = "workspace";

    expect(await rawRestore(server, hubBackup)).toEqual(VOCABULARY_REFUSALS.hubIntoWorkspace);
    expect(server.restores).toEqual([]);
    expect(server.backups).toHaveLength(1);
    expect(server.epoch).toBe(1);
  });

  it("refuses a backup holding both vocabularies, and the client says why", async () => {
    const server = serverWith();
    await rawPush(server, [issue(1)], 1);
    // Pre-0005 contamination, which no route can produce any more: planted directly.
    server.ops.push({ ...server.ops[0]!, seq: 2, opId: "planted", entity: "registration" });
    server.lastSeq = 2;
    const mixed = await enableAndBackUp(server, 2);

    expect(await rawRestore(server, mixed)).toEqual(VOCABULARY_REFUSALS.mixedBackup);
    expect(server.restores).toEqual([]);

    const error = await rejection(
      advanceRemoteRestore(
        parseEndpoint(ENDPOINT),
        { ...repoCall, backupId: mixed, restoreId: null, actor: null },
        { fetchImpl: server.fetch, protocol: 2 },
      ),
    );
    expect(isVocabularyRefusal(error)).toBe(true);
    expect(error.message).toBe(vocabularyRefusalMessage(ENDPOINT, undefined, "mixed"));
    expect(error.message).toContain("holds both hub registry entries and workspace data");
  });

  it("claims an unclaimed repository for the backup's vocabulary at begin", async () => {
    const server = serverWith();
    await rawPush(server, [registration(1)], 2);
    const hubBackup = await enableAndBackUp(server, 2);
    server.ops.length = 0;
    server.vocabulary = null;

    expect((await rawRestore(server, hubBackup)).status).toBe(200);
    expect(server.vocabulary).toBe("hub");
    expect(await rawPush(server, [issue(9)], 1)).toEqual(VOCABULARY_REFUSALS.workspaceIntoHub);
  });

  it("asks again on every stage turn, as the Worker does", async () => {
    const server = serverWith();
    await rawPush(server, [registration(1)], 2);
    const hubBackup = await enableAndBackUp(server, 2);
    server.ops.length = 0;
    server.vocabulary = null;
    const begun = (await rawRestore(server, hubBackup)).body as { restoreId: string };
    // A restore that began before the rule existed, into what is really a workspace.
    server.vocabulary = "workspace";

    const turn = await server.fetch(
      `${ENDPOINT}/v1/repos/${REPO_ID}/backups/${hubBackup}/restore`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Staple-Protocol": "2",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirm: REPO_ID, restoreId: begun.restoreId }),
      },
    );
    expect({ status: turn.status, body: await turn.json() }).toEqual(
      VOCABULARY_REFUSALS.hubIntoWorkspace,
    );
    expect(server.ops.filter((op) => op.epoch === 2)).toEqual([]);
  });
});

// ---------------------------------------------------- the paths a person runs

describe("the refusal reaches a person as a sentence, and is not retried", () => {
  it("stops `staple cloud sync` of a workspace pointed at a hub's repository", async () => {
    const home = mkdtempSync(join(tmpdir(), "staple-vocab-sync-"));
    dirs.push(home);
    const server = serverWith("hub");

    const db = openDb(":memory:");
    migrateWorkspace(db);
    writeStoredRepositoryId(db, REPO_ID);
    bindJournal(db, DEVICE);
    const store = new WorkspaceStore(db, "test", "TST");
    stores.push(store);
    credentialStoreFor(home, "file").write(REPO_ID, TOKEN);
    writeConnection(home, {
      schemaVersion: 1,
      repositoryId: REPO_ID,
      endpoint: ENDPOINT,
      deviceId: DEVICE,
      label: DEVICE,
      credentialMechanism: "file",
      connectedAt: "2026-09-10T00:00:00.000Z",
      auto: false,
      backup: false,
      protocol: 1,
    });
    store.createIssue({ title: "local work", createdBy: "agent-a" });

    const error = await rejection(
      syncRepository(store.db, REPO_ID, {
        home,
        fetchImpl: server.fetch,
        sleep: async () => undefined,
        attempts: 3,
      }),
    );
    expect(error.message).toBe(vocabularyRefusalMessage(ENDPOINT, "hub", "workspace"));
    expect(error.detail?.retryable).toBe(false);
    // Three attempts were allowed, and the push was made exactly once: a non-retryable
    // code is not retried. A new code would have mapped to `unavailable` and been.
    expect(server.calls.filter((route) => route === "POST /v1/repos/:id/ops")).toHaveLength(1);
    expect(server.ops).toEqual([]);
  });

  it("stops a hub publish into a repository provisioned for a workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "staple-vocab-hub-"));
    dirs.push(home);
    process.env.STAPLE_HOME = home;
    const hub = Hub.open();
    const wsDir = join(home, "ws", "alpha");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "staple.db"), "");
    hub.register({ slug: "alpha", prefix: "ALP", path: join(wsDir, "staple.db"), kind: "repo" });
    hub.recordRepositoryId("alpha", "44444444-4444-4444-8444-444444444444");

    const hubId = hub.hubId();
    const server = new FakeSyncServer({ repositoryId: hubId, vocabulary: "workspace" });
    server.enroll(DEVICE, TOKEN);
    credentialStoreFor(home, "file").write(hubId, TOKEN);
    writeConnection(home, {
      schemaVersion: 1,
      repositoryId: hubId,
      endpoint: ENDPOINT,
      deviceId: DEVICE,
      label: DEVICE,
      credentialMechanism: "file",
      connectedAt: "2026-09-10T00:00:00.000Z",
      auto: false,
      backup: false,
      registry: false,
      protocol: REGISTRY_PROTOCOL,
    });
    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);

    const error = await rejection(publishRegistry(hub, home, { fetchImpl: server.fetch }));
    expect(isVocabularyRefusal(error)).toBe(true);
    expect(error.message).toBe(vocabularyRefusalMessage(ENDPOINT, "workspace", "hub"));
    expect(server.ops).toEqual([]);
    hub.close();
  });
});
