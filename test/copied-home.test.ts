/**
 * STA-274 — a restored staple home must not become a second claimant.
 *
 * S2's copy detection is `findRepositoryIdCollisions`: one id at two REGISTERED
 * PATHS on one machine. A global workspace defeats it twice over — it lives at a
 * fixed path inside the home, so a home restored onto a second machine presents
 * the same id at the *same* path, and the two machines never see each other's
 * hub. There is no clone to tell them apart because there is no repository.
 *
 * So the discriminator cannot be anything inside the home: the database, the
 * manifest, the device id and its secret, the cursor and the client-sequence
 * allocator all travel with the copy. It has to be the MACHINE — recorded when
 * the identity is minted, re-computed when it is used.
 *
 * These tests are two machines by being two values of `STAPLE_HOST_ID`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { openWorkspace } from "../src/core/open.js";
import { initWorkspace } from "../src/core/workspace.js";
import { StapleError } from "../src/core/types.js";
import { hostFingerprint } from "../src/core/host-id.js";
import {
  assertOwnHost,
  describeHostBinding,
  forkWorkspaceIdentity,
  readOriginHost,
  readStoredRepositoryId,
  readWorkspaceManifest,
  reconcileRepositoryIdentity,
} from "../src/core/repo-identity.js";
import { cloudSurfaceReport } from "../src/core/cloud/surface.js";
import { localCloudStatus } from "../src/core/cloud/status.js";
import { syncRepository } from "../src/core/cloud/sync.js";
import { removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

let root: string;
let homeA: string;

beforeAll(() => {
  root = tempDir("copied-home-root");
  homeA = join(root, "machine-a-home");
  mkdirSync(homeA, { recursive: true });
});

afterAll(() => removeDir(root));

beforeEach(() => {
  process.env.STAPLE_HOME = homeA;
  process.env.STAPLE_HOST_ID = "machine-a";
});

afterEach(() => {
  delete process.env.STAPLE_HOST_ID;
});

/**
 * The same home, opened as if the backup had been restored on another machine.
 *
 * Restores the machine only once an async body has SETTLED. A plain `finally`
 * around a promise-returning body puts the machine back the instant the promise
 * is created, so a check that moved behind an `await` would be evaluated as
 * machine A and the test would pass for the wrong reason.
 */
function asOtherMachine<T>(body: () => T): T {
  const restore = (): void => {
    process.env.STAPLE_HOST_ID = "machine-a";
  };
  process.env.STAPLE_HOST_ID = "machine-b";
  let result: T;
  try {
    result = body();
  } catch (error) {
    restore();
    throw error;
  }
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
}

describe("the host fingerprint", () => {
  it("is stable for one machine and different for another", () => {
    const a = hostFingerprint();
    expect(a).toBe(hostFingerprint());
    expect(asOtherMachine(() => hostFingerprint())).not.toBe(a);
  });

  it("discloses no hardware identifier — it is a digest, not a serial", () => {
    expect(hostFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(hostFingerprint()).not.toContain("machine-a");
  });
});

describe("a global workspace is bound to the machine that minted it", () => {
  it("records the host at mint", () => {
    const ws = initWorkspace({ global: true, slug: "bound" });
    try {
      expect(readOriginHost(ws.store.db)).toBe(hostFingerprint());
      expect(describeHostBinding(ws.store.db).status).toBe("consistent");
    } finally {
      ws.store.db.close();
    }
  });

  it("stays consistent when the same machine reopens it", () => {
    const first = initWorkspace({ global: true, slug: "same-machine" });
    first.store.db.close();
    const again = openWorkspace(join(homeA, "workspaces", "same-machine.db"));
    try {
      expect(describeHostBinding(again.store.db).status).toBe("consistent");
      expect(() => assertOwnHost(again.store.db)).not.toThrow();
    } finally {
      again.store.db.close();
    }
  });

  it("reports a copy, not a fresh device, when the home is restored elsewhere", () => {
    const ws = initWorkspace({ global: true, slug: "restored" });
    const minted = ws.repository!.repositoryId;
    ws.store.db.close();

    asOtherMachine(() => {
      const opened = openWorkspace(join(homeA, "workspaces", "restored.db"));
      try {
        const binding = describeHostBinding(opened.store.db);
        expect(binding.status).toBe("moved");
        expect(binding.recorded).not.toBe(binding.current);
        // The identity is NOT silently re-minted and NOT silently re-bound:
        // either would be the fork this check exists to prevent.
        expect(readStoredRepositoryId(opened.store.db)).toBe(minted);
        expect(readWorkspaceManifest(opened.dbPath)?.repositoryId).toBe(minted);
        expect(readOriginHost(opened.store.db)).toBe(binding.recorded);
      } finally {
        opened.store.db.close();
      }
    });
  });

  it("refuses, with a diagnostic naming the fork command", () => {
    const ws = initWorkspace({ global: true, slug: "refused" });
    ws.store.db.close();

    asOtherMachine(() => {
      const opened = openWorkspace(join(homeA, "workspaces", "refused.db"));
      try {
        let thrown: unknown;
        try {
          assertOwnHost(opened.store.db);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(StapleError);
        expect((thrown as StapleError).code).toBe("conflict");
        expect((thrown as StapleError).message).toMatch(/staple cloud fork-id/);
        expect((thrown as StapleError).message).toMatch(/copied|restored/i);
      } finally {
        opened.store.db.close();
      }
    });
  });

  /**
   * The CLI refuses earlier, so this looks redundant — and it is not.
   *
   * Deleting the guard inside `syncRepository` left all thirteen other tests in
   * this file green, because every one of them reached sync through the CLI. The
   * automatic path does not: `AutoSyncScheduler` imports `syncRepository`
   * directly, so on a restored home whose device had already consented to
   * background sync, nothing anybody typed would be involved at all. This is the
   * test that fails when that guard goes.
   *
   * It also proves the guard runs BEFORE the session is opened: this workspace
   * is not connected, so a check placed any later would produce "not connected"
   * instead of the truth.
   */
  it("refuses inside syncRepository, ahead of the session, for the automatic path", async () => {
    const ws = initWorkspace({ global: true, slug: "background" });
    const repositoryId = ws.repository!.repositoryId;
    ws.store.db.close();

    await asOtherMachine(async () => {
      const opened = openWorkspace(join(homeA, "workspaces", "background.db"));
      try {
        await expect(
          syncRepository(opened.store.db, repositoryId, { home: homeA }),
        ).rejects.toThrow(/staple cloud fork-id/);
      } finally {
        opened.store.db.close();
      }
    });
  });

  it("says so in cloud status rather than only when something is about to move", () => {
    const ws = initWorkspace({ global: true, slug: "status-warns" });
    const repositoryId = ws.repository!.repositoryId;
    ws.store.db.close();

    asOtherMachine(() => {
      const opened = openWorkspace(join(homeA, "workspaces", "status-warns.db"));
      try {
        const report = cloudSurfaceReport(localCloudStatus(homeA, repositoryId), opened.store.db);
        expect(report.warnings.join(" ")).toMatch(/staple cloud fork-id/);
      } finally {
        opened.store.db.close();
      }
    });
  });
});

describe("the fork is the way out", () => {
  it("mints a new identity, drops the positions, and claims the machine", () => {
    const ws = initWorkspace({ global: true, slug: "forked" });
    const original = ws.repository!.repositoryId;
    ws.store.db.exec(
      "UPDATE sync_state SET cursor = 'page-9', epoch = 4, client_seq_high_water = 17",
    );
    ws.store.db.close();

    asOtherMachine(() => {
      const opened = openWorkspace(join(homeA, "workspaces", "forked.db"));
      try {
        const result = forkWorkspaceIdentity(opened.store.db, opened.dbPath);
        expect(result.previousRepositoryId).toBe(original);
        expect(result.repositoryId).not.toBe(original);

        expect(readWorkspaceManifest(opened.dbPath)?.repositoryId).toBe(result.repositoryId);
        expect(readStoredRepositoryId(opened.store.db)).toBe(result.repositoryId);

        const state = opened.store.db
          .prepare("SELECT cursor, epoch, client_seq_high_water AS high FROM sync_state")
          .get() as { cursor: string | null; epoch: number; high: number };
        expect(state.cursor).toBeNull();
        expect(state.epoch).toBe(0);
        expect(state.high).toBe(0);

        // The machine that forked now owns it, so the refusal stops.
        expect(describeHostBinding(opened.store.db).status).toBe("consistent");
        expect(() => assertOwnHost(opened.store.db)).not.toThrow();
      } finally {
        opened.store.db.close();
      }
    });
  });

  it("leaves the original machine's workspace untouched", () => {
    const ws = initWorkspace({ global: true, slug: "untouched" });
    const original = ws.repository!.repositoryId;
    ws.store.db.close();

    // Machine B forks its restored copy of the home.
    const homeB = join(root, "machine-b-home");
    cpSync(homeA, homeB, { recursive: true });
    asOtherMachine(() => {
      process.env.STAPLE_HOME = homeB;
      const opened = openWorkspace(join(homeB, "workspaces", "untouched.db"));
      try {
        forkWorkspaceIdentity(opened.store.db, opened.dbPath);
      } finally {
        opened.store.db.close();
        process.env.STAPLE_HOME = homeA;
      }
    });

    const stillA = openWorkspace(join(homeA, "workspaces", "untouched.db"));
    try {
      expect(readStoredRepositoryId(stillA.store.db)).toBe(original);
      expect(readWorkspaceManifest(stillA.dbPath)?.repositoryId).toBe(original);
      expect(describeHostBinding(stillA.store.db).status).toBe("consistent");
    } finally {
      stillA.store.db.close();
    }
  });
});

describe("a repository-backed workspace is not host-bound", () => {
  /**
   * Through `initWorkspace`, not through `reconcileRepositoryIdentity`.
   *
   * The unit test below calls the low-level function, and making the binding
   * unconditional left it green — because a repository never reaches the
   * low-level function by the route that would bind it. This is the test that
   * fails, and it is the regression this lane could actually ship: a
   * repository-backed workspace that started refusing to sync because somebody
   * copied a project directory between two machines, which is a thing people do
   * on purpose and which a checkout is entitled to do by design.
   */
  it("is not bound by the real init path either", () => {
    const dir = join(root, "init-path-repo");
    mkdirSync(dir, { recursive: true });
    const ws = initWorkspace({ dir });
    try {
      expect(ws.repository.host).toBeNull();
      expect(readOriginHost(ws.store.db)).toBeNull();
      asOtherMachine(() => {
        expect(describeHostBinding(ws.store.db).status).toBe("unbound");
        expect(() => assertOwnHost(ws.store.db)).not.toThrow();
      });
    } finally {
      ws.store.db.close();
    }
  });

  it("records no host, so moving the directory to another machine changes nothing", () => {
    const dir = join(root, "project", ".staple");
    mkdirSync(dir, { recursive: true });
    const db = openDb(join(dir, "staple.db"));
    migrateWorkspace(db);
    try {
      const report = reconcileRepositoryIdentity(db, dir);
      expect(readOriginHost(db)).toBeNull();
      expect(describeHostBinding(db).status).toBe("unbound");
      asOtherMachine(() => {
        expect(describeHostBinding(db).status).toBe("unbound");
        expect(() => assertOwnHost(db)).not.toThrow();
      });
      expect(report.status).toBe("consistent");
    } finally {
      db.close();
    }
  });
});

describe("end to end, through the CLI", () => {
  /**
   * The restore has to land on the SAME PATH to be the scenario at all.
   *
   * A first attempt copied the home to a second directory, and it proved
   * nothing: the hub inside the copy still records the first home's absolute
   * path, so the CLI reached back and opened the original database. That is an
   * artefact of pretending two machines are two directories. On real hardware
   * `~/.staple` is `~/.staple` on both machines — which is exactly the ticket's
   * point, "a fixed path inside the staple home" — so the faithful simulation is
   * to back the home up, remove it, and restore it over itself.
   */
  function restoreOverItself(home: string): void {
    const backup = `${home}-backup`;
    cpSync(home, backup, { recursive: true });
    rmSync(home, { recursive: true, force: true });
    cpSync(backup, home, { recursive: true });
  }

  it("refuses to sync a restored home and names the fork command", () => {
    const cliHome = join(root, "cli-home");
    mkdirSync(cliHome, { recursive: true });

    const init = runCliAt(root, ["init", "--global", "e2e", "--json"], {
      STAPLE_HOME: cliHome,
      STAPLE_HOST_ID: "cli-machine-a",
    });
    expect(init.status).toBe(0);

    restoreOverItself(cliHome);

    const sync = runCliAt(root, ["cloud", "sync", "--ws", "e2e"], {
      STAPLE_HOME: cliHome,
      STAPLE_HOST_ID: "cli-machine-b",
    });
    expect(sync.status).not.toBe(0);
    expect(`${sync.stdout}${sync.stderr}`).toMatch(/staple cloud fork-id/);
    expect(`${sync.stdout}${sync.stderr}`).toMatch(/Nothing was sent/);
  });

  it("lets the operator fork out of it, and syncing stops being refused", () => {
    const cliHome = join(root, "cli-forkable");
    mkdirSync(cliHome, { recursive: true });

    expect(
      runCliAt(root, ["init", "--global", "forkable", "--json"], {
        STAPLE_HOME: cliHome,
        STAPLE_HOST_ID: "cli-machine-a",
      }).status,
    ).toBe(0);

    restoreOverItself(cliHome);
    const asB = { STAPLE_HOME: cliHome, STAPLE_HOST_ID: "cli-machine-b" };

    const fork = runCliAt(root, ["cloud", "fork-id", "--ws", "forkable", "--yes", "--json"], asB);
    expect(fork.status).toBe(0);
    const result = JSON.parse(fork.stdout) as { previousRepositoryId: string; repositoryId: string };
    expect(result.repositoryId).not.toBe(result.previousRepositoryId);

    // The copy refusal is gone; what is left is the ordinary "not connected".
    const sync = runCliAt(root, ["cloud", "sync", "--ws", "forkable"], asB);
    expect(`${sync.stdout}${sync.stderr}`).not.toMatch(/staple cloud fork-id/);
  });

  /**
   * The report the settings section reads, not the section itself.
   *
   * `canOfferConnect` is `mode === "disconnected" && failure?.code !==
   * "no_identity"`, and it lives in the browser app, which the Node tsconfig
   * deliberately excludes — a root test that imported it would drag DOM code
   * into the Node compilation. The app's own suite already covers the predicate
   * against a fixture report; what only this side can prove is that a global
   * workspace now PRODUCES that report instead of a `no_identity` one. The
   * predicate never needed changing: it was always asking about the identity
   * rather than about the kind of workspace.
   */
  it("produces the report the settings section will offer a connect form for", () => {
    const cliHome = join(root, "cli-settings-home");
    mkdirSync(cliHome, { recursive: true });
    process.env.STAPLE_HOME = cliHome;

    const ws = initWorkspace({ global: true, slug: "settings" });
    try {
      const report = cloudSurfaceReport(
        localCloudStatus(cliHome, ws.repository!.repositoryId),
        ws.store.db,
      );
      expect(report.mode).toBe("disconnected");
      expect(report.failure).toBeNull();
      expect(report.repositoryId).toBe(ws.repository!.repositoryId);
    } finally {
      ws.store.db.close();
      process.env.STAPLE_HOME = homeA;
    }
  });

  it("offers a global workspace a connection once it has an identity", () => {
    const cliHome = join(root, "cli-connectable");
    mkdirSync(cliHome, { recursive: true });

    const init = runCliAt(root, ["init", "--global", "connectable", "--json"], {
      STAPLE_HOME: cliHome,
      STAPLE_HOST_ID: "cli-machine-a",
    });
    expect(init.status).toBe(0);

    const status = runCliAt(root, ["cloud", "status", "--ws", "connectable"], {
      STAPLE_HOME: cliHome,
      STAPLE_HOST_ID: "cli-machine-a",
    });
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/Connect with: staple cloud connect/);
    expect(`${status.stdout}${status.stderr}`).not.toMatch(/cannot be connected/);
  });
});
