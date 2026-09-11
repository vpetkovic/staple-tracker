/**
 * Several machines on one repository, each as real as a test can make it.
 *
 * A machine here is what a person has: a staple home of its own (its own hub, its own
 * credential, its own device id), and a clone of the repository — the tracked
 * `.staple/repository.json` and nothing else — on which `staple init` has run. Every
 * machine talks to the same in-process {@link FakeSyncServer}, which re-implements the
 * deployed Worker's semantics, so what one machine pushes another pulls through the real
 * client code: `syncRepository`, the applier, the journal and the hub.
 *
 * Two devices sharing a home would be one device, and a device whose workspace was built
 * by hand would skip `initWorkspace` — the path every real workspace takes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { bindJournal } from "../../src/core/journal.js";
import { openWorkspace } from "../../src/core/open.js";
import { initWorkspace } from "../../src/core/workspace.js";
import type { WorkspaceStore } from "../../src/core/store.js";
import { writeConnection } from "../../src/core/cloud/connection.js";
import { credentialStoreFor } from "../../src/core/cloud/credential-store.js";
import { syncRepository, type SyncOptions, type SyncReport } from "../../src/core/cloud/sync.js";
import type { FakeSyncServer } from "./fake-sync-server.js";

export const ENDPOINT = "https://sync.test.example";

export interface Machine {
  readonly label: string;
  readonly deviceId: string;
  readonly home: string;
  readonly dir: string;
  readonly dbPath: string;
  readonly store: WorkspaceStore;
  readonly db: DatabaseSync;
  /** Point `STAPLE_HOME` at this machine, for code that reads it from the environment. */
  use(): void;
  sync(extra?: Partial<SyncOptions>): Promise<SyncReport>;
}

export class Fleet {
  private readonly dirs: string[] = [];
  private readonly opened: DatabaseSync[] = [];
  private readonly previousHome = process.env.STAPLE_HOME;

  constructor(
    readonly server: FakeSyncServer,
    readonly repositoryId: string,
  ) {}

  private tmp(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `staple-fleet-${label}-`));
    this.dirs.push(dir);
    return dir;
  }

  /** A home that has never connected, and a clone in a directory called `dirName`. */
  prepare(label: string, options: { dirName?: string; slug?: string } = {}): { home: string; dir: string } {
    const home = this.tmp(`home-${label}`);
    const root = this.tmp(`clone-${label}`);
    const dir = join(root, options.dirName ?? "tracker");
    mkdirSync(join(dir, ".staple"), { recursive: true });
    writeFileSync(
      join(dir, ".staple", "repository.json"),
      `${JSON.stringify({ repositoryId: this.repositoryId, format: 1 }, null, 2)}\n`,
    );
    process.env.STAPLE_HOME = home;
    const ws = initWorkspace({ dir, slug: options.slug ?? "tracker" });
    ws.store.db.close();
    return { home, dir };
  }

  /** Open a prepared clone and connect it as `deviceId`. */
  connect(label: string, prepared: { home: string; dir: string }, deviceId = `device-${label}`): Machine {
    const { home, dir } = prepared;
    process.env.STAPLE_HOME = home;
    const dbPath = join(dir, ".staple", "staple.db");
    const opened = openWorkspace(dbPath);
    this.opened.push(opened.store.db);
    bindJournal(opened.store.db, deviceId);
    const token = `token-${deviceId}`;
    credentialStoreFor(home, "file").write(this.repositoryId, token);
    writeConnection(home, {
      schemaVersion: 1,
      repositoryId: this.repositoryId,
      endpoint: ENDPOINT,
      deviceId,
      label,
      credentialMechanism: "file",
      connectedAt: "2026-09-10T00:00:00.000Z",
      auto: false,
      backup: false,
      protocol: 1,
    });
    this.server.enroll(deviceId, token);
    const server = this.server;
    const repositoryId = this.repositoryId;
    return {
      label,
      deviceId,
      home,
      dir,
      dbPath,
      store: opened.store,
      db: opened.store.db,
      use: () => {
        process.env.STAPLE_HOME = home;
      },
      sync: (extra = {}) => {
        process.env.STAPLE_HOME = home;
        return syncRepository(opened.store.db, repositoryId, {
          home,
          fetchImpl: server.fetch,
          sleep: async () => undefined,
          ...extra,
        });
      },
    };
  }

  /** `prepare` then `connect`: a machine whose clone had nothing in it before connecting. */
  machine(label: string, options: { dirName?: string; slug?: string } = {}): Machine {
    return this.connect(label, this.prepare(label, options));
  }

  close(): void {
    for (const db of this.opened) {
      try {
        db.close();
      } catch {
        // Already closed by the test.
      }
    }
    for (const dir of this.dirs) rmSync(dir, { recursive: true, force: true });
    if (this.previousHome === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = this.previousHome;
  }
}

/** One value per row, in a stable order: what two converged machines must agree on. */
export function rows(db: DatabaseSync, sql: string): unknown[] {
  return db.prepare(sql).all();
}
