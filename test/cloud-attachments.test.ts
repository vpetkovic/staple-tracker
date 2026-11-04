/**
 * A file's metadata reaches every device. Its bytes do too when they were inlined,
 * and a device that never held a local-only file can say so.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACH_INLINE_MAX_BYTES, sha256Hex } from "../src/core/attachments.js";
import { applyToDatabase } from "../src/core/cloud/apply.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { syncRepository } from "../src/core/cloud/sync.js";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "a77a0000-0000-4000-8000-000000000389";
const ENDPOINT = "https://sync.test.example";

describe("file attachments across devices", () => {
  let fleet: Fleet | null = null;
  const homes: string[] = [];
  const stores: WorkspaceStore[] = [];

  afterEach(() => {
    fleet?.close();
    fleet = null;
    for (const store of stores) store.db.close();
    stores.length = 0;
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    homes.length = 0;
  });

  it("copies an inlined file byte for byte and keeps a larger file's bytes where they were attached", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const writer = fleet.machine("writer");
    const reader = fleet.machine("reader");
    writer.use();
    await writer.sync();
    reader.use();
    await reader.sync();

    writer.use();
    const issue = writer.store.createIssue({ title: "Evidence" });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11]);
    const small = writer.store.attachFile(issue.identifier, { filename: "shot.txt", bytes: png, author: "writer" });
    const large = writer.store.attachFile(issue.identifier, {
      filename: "clip.bin",
      bytes: Buffer.alloc(ATTACH_INLINE_MAX_BYTES + 1, 7),
      author: "writer",
    });
    expect(small.byteSync).toBe("inline");
    expect(large.byteSync).toBe("local");
    expect(small.mediaType).toBe("image/png");

    await writer.sync();
    reader.use();
    await reader.sync();

    const copied = reader.store.readFile(small.id);
    expect(copied.bytes.equals(png)).toBe(true);
    expect(copied.meta.sha256).toBe(small.sha256);
    expect(() => reader.store.readFile(large.id)).toThrow(/did not travel/);
    expect(reader.store.listFiles(issue.identifier).map((file) => file.filename).sort()).toEqual(["clip.bin", "shot.txt"]);
    expect(differences("reader", stateOf(writer.db), stateOf(reader.db))).toEqual([]);

    writer.use();
    writer.store.removeFile(small.id, "writer");
    await writer.sync();
    reader.use();
    await reader.sync();
    expect(reader.store.listFiles(issue.identifier).map((file) => file.id)).toEqual([large.id]);
  }, 60_000);

  it("uploads a file that was attached before the workspace connected", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    const previous = process.env.STAPLE_HOME;
    const open = (deviceId: string, armed: boolean) => {
      const home = mkdtempSync(join(tmpdir(), `staple-file-seed-${deviceId}-`));
      homes.push(home);
      process.env.STAPLE_HOME = home;
      const db = openDb(":memory:");
      migrateWorkspace(db);
      writeStoredRepositoryId(db, REPO);
      bindJournal(db, armed ? deviceId : null);
      const store = new WorkspaceStore(db, "test", "TST");
      stores.push(store);
      credentialStoreFor(home, "file").write(REPO, `token-${deviceId}`);
      writeConnection(home, {
        schemaVersion: 1,
        repositoryId: REPO,
        endpoint: ENDPOINT,
        deviceId,
        label: deviceId,
        credentialMechanism: "file",
        connectedAt: "2026-10-01T00:00:00.000Z",
        auto: false,
        backup: false,
        protocol: 1,
      });
      server.enroll(deviceId, `token-${deviceId}`);
      return {
        store,
        sync: () => syncRepository(db, REPO, { home, fetchImpl: server.fetch, sleep: async () => undefined }),
        arm: () => bindJournal(db, deviceId),
      };
    };

    try {
      const origin = open("origin", false);
      const issue = origin.store.createIssue({ title: "Already filed" });
      const body = Buffer.from("seeded log\n");
      const file = origin.store.attachFile(issue.identifier, { filename: "log.txt", bytes: body, author: "origin" });
      origin.arm();
      await origin.sync();

      const other = open("other", true);
      await other.sync();
      expect(other.store.readFile(file.id).bytes.equals(body)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.STAPLE_HOME;
      else process.env.STAPLE_HOME = previous;
    }
  }, 60_000);

  it("a second create keeps the first file, and only the same bytes can fill a missing blob", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    const store = new WorkspaceStore(db, "re", "RE");
    stores.push(store);
    const issue = store.createIssue({ title: "One" });
    const original = Buffer.from("log\n");
    const meta = store.attachFile(issue.identifier, { filename: "note.txt", bytes: original, author: "a" });
    const other = Buffer.from("nope");
    const replay = (bytes: Buffer, filename: string): void => {
      applyToDatabase(db, {
        entity: "attachment",
        entityId: meta.id,
        verb: "create",
        payload: {
          issueId: meta.issueId,
          filename,
          mediaType: "text/plain",
          size: bytes.byteLength,
          sha256: sha256Hex(bytes),
          author: "b",
          caption: null,
          byteSync: "inline",
          createdAt: meta.createdAt,
          bytes: bytes.toString("base64"),
        },
        actor: "b",
        deviceId: "other",
        at: meta.createdAt,
        opId: "op-replay",
      });
    };

    replay(other, "other.txt");
    expect(store.readFile(meta.id).bytes.equals(original)).toBe(true);
    expect(store.listFiles(issue.identifier)[0]?.filename).toBe("note.txt");

    db.prepare("DELETE FROM attachment_bytes").run();
    replay(other, "other.txt");
    expect(() => store.readFile(meta.id)).toThrow(/did not travel/);

    replay(original, "note.txt");
    expect(store.readFile(meta.id).bytes.equals(original)).toBe(true);
    expect(store.listFiles(issue.identifier)[0]?.filename).toBe("note.txt");
  });
});
