/**
 * STA-281 — a version control checkout is not the price of a sync identity.
 *
 * The workspace holding every epic lived in a plain directory. It was registered,
 * available and full of data, and every cloud surface said the same thing about
 * it: *"This workspace has no .../repository.json, so it has no sync identity.
 * Run `staple init` in it to record one."* Both halves are wrong. The workspace
 * exists, so nothing needs creating; and `init` run anywhere other than the exact
 * directory the hub has registered mints a SECOND workspace with a second
 * identity, which is the fork the manifest exists to prevent.
 *
 * The cause was one line in `openWorkspace`: identity was reconciled only for
 * home-resident workspaces. `initWorkspace` had already been widened (S14), but a
 * workspace that predates manifests never runs `init` again, so it never gained
 * one.
 *
 * What this file pins:
 *
 *   - a plain directory mints an identity, at `init` AND at open, and keeps it;
 *   - the copy hazard that opens up as a result is closed by the S15 host
 *     binding, and a MOVED workspace is not treated as a copied one;
 *   - the repository-backed path — clone recovery, no host binding, no minting on
 *     a read — is exactly what it was;
 *   - and no surface tells a reader to `init` a workspace that already exists.
 *
 * These tests are two machines by being two values of `STAPLE_HOST_ID`, the same
 * seam `copied-home.test.ts` uses.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { openWorkspace } from "../src/core/open.js";
import { initWorkspace } from "../src/core/workspace.js";
import { StapleError } from "../src/core/types.js";
import { hostFingerprint } from "../src/core/host-id.js";
import { isInsideCheckout } from "../src/core/checkout.js";
import {
  assertOwnHost,
  describeHostBinding,
  forkWorkspaceIdentity,
  isCheckoutBacked,
  readOriginHost,
  readStoredRepositoryId,
  readWorkspaceManifest,
  repositoryManifestPath,
} from "../src/core/repo-identity.js";
import { describeSkip, describeWorkspace, skipReasonFor } from "../src/core/cloud/hub-scope.js";
import { cloudSurfaceReport, noIdentityReport } from "../src/core/cloud/surface.js";
import { localCloudStatus } from "../src/core/cloud/status.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";

let root: string;
let home: string;

beforeAll(() => {
  root = tempDir("no-checkout-root");
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
});

afterAll(() => removeDir(root));

beforeEach(() => {
  process.env.STAPLE_HOME = home;
  process.env.STAPLE_HOST_ID = "machine-a";
});

afterEach(() => {
  delete process.env.STAPLE_HOST_ID;
});

/** Run `body` as if this were a second machine holding a copy. */
function asOtherMachine<T>(body: () => T): T {
  process.env.STAPLE_HOST_ID = "machine-b";
  try {
    return body();
  } finally {
    process.env.STAPLE_HOST_ID = "machine-a";
  }
}

/** A directory with nothing version-controlled about it. */
function plainDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A directory that is a checkout, without invoking a version control system. */
function checkoutDir(name: string): string {
  const dir = plainDir(name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function entryFor(slug: string, dbPath: string) {
  return {
    slug,
    prefix: slug.slice(0, 3).toUpperCase(),
    path: dbPath,
    kind: "repo",
    addedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: null,
    available: existsSync(dbPath),
    // These fixtures deliberately have no manifest, which is the whole subject
    // of this file — so the registry's copy of the identity is absent too.
    repositoryId: null,
  };
}

// ------------------------------------------------------------ the predicate

describe("isInsideCheckout", () => {
  it("finds a .git directory at the root", () => {
    const dir = checkoutDir("pred-root");
    expect(isInsideCheckout(join(dir, ".staple"))).toBe(true);
  });

  it("finds a .git FILE, which is what a worktree and a submodule have", () => {
    const dir = plainDir("pred-worktree");
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n", "utf8");
    expect(isInsideCheckout(join(dir, ".staple"))).toBe(true);
  });

  it("finds one above a nested workspace", () => {
    const dir = checkoutDir("pred-nested");
    const nested = join(dir, "packages", "inner", ".staple");
    mkdirSync(nested, { recursive: true });
    expect(isInsideCheckout(nested)).toBe(true);
  });

  it("is false for a plain directory", () => {
    expect(isInsideCheckout(join(plainDir("pred-plain"), ".staple"))).toBe(false);
  });

  it("invokes no version control system — it is a file test", () => {
    const source = readFileSync(new URL("../src/core/checkout.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\b(execSync|execFileSync|spawnSync|spawn)\s*\(/);
  });
});

describe("isCheckoutBacked", () => {
  it("is true for a workspace inside a checkout", () => {
    const dbPath = join(checkoutDir("backed-yes"), ".staple", "staple.db");
    expect(isCheckoutBacked(dbPath, home)).toBe(true);
  });

  it("is false for a workspace in a plain directory", () => {
    const dbPath = join(plainDir("backed-no"), ".staple", "staple.db");
    expect(isCheckoutBacked(dbPath, home)).toBe(false);
  });

  it("is false for a home-resident workspace even when the home is inside a checkout", () => {
    const versionedHome = join(checkoutDir("backed-home"), ".staple-home");
    mkdirSync(join(versionedHome, "workspaces"), { recursive: true });
    const dbPath = join(versionedHome, "workspaces", "notes.db");
    expect(isInsideCheckout(versionedHome)).toBe(true);
    expect(isCheckoutBacked(dbPath, versionedHome)).toBe(false);
  });
});

// -------------------------------------------- a plain directory has identity

describe("a workspace in a plain directory mints and keeps an identity", () => {
  it("mints one at init, with no version control anywhere", () => {
    const dir = plainDir("plain-init");
    const ws = initWorkspace({ dir });
    try {
      expect(existsSync(join(dir, ".git"))).toBe(false);
      const manifest = readWorkspaceManifest(ws.dbPath);
      expect(manifest?.repositoryId).toMatch(/^[0-9a-f-]{36}$/);
      expect(readStoredRepositoryId(ws.store.db)).toBe(manifest?.repositoryId);
      expect(ws.repository.status).toBe("consistent");
    } finally {
      ws.store.db.close();
    }
  });

  /**
   * The reported case. A workspace created before manifests existed has no
   * `repository.json` and no recorded id, and nothing ever runs `init` in it
   * again — so before this change it could never be connected, and the advice it
   * was given would have minted a second workspace.
   */
  it("gains one on open when it predates manifests", () => {
    const dir = plainDir("plain-legacy");
    const first = initWorkspace({ dir });
    const dbPath = first.dbPath;
    first.store.db.close();

    // Rewind to a pre-manifest workspace: no file, no recorded id.
    const manifestPath = repositoryManifestPath(join(dir, ".staple"));
    const stripped = openDb(dbPath);
    stripped.exec("DELETE FROM sync_state");
    stripped.close();
    renameSync(manifestPath, `${manifestPath}.gone`);
    expect(existsSync(manifestPath)).toBe(false);

    const reopened = openWorkspace(dbPath);
    try {
      expect(existsSync(manifestPath)).toBe(true);
      const minted = readWorkspaceManifest(dbPath)?.repositoryId;
      expect(minted).toBeTruthy();
      expect(readStoredRepositoryId(reopened.store.db)).toBe(minted);
    } finally {
      reopened.store.db.close();
    }
  });

  it("keeps it: a second open adopts rather than re-minting", () => {
    const dir = plainDir("plain-stable");
    const created = initWorkspace({ dir });
    const dbPath = created.dbPath;
    const minted = created.repository.repositoryId;
    created.store.db.close();

    const bytes = sha256(repositoryManifestPath(join(dir, ".staple")));
    const again = openWorkspace(dbPath);
    try {
      expect(readWorkspaceManifest(dbPath)?.repositoryId).toBe(minted);
      expect(readStoredRepositoryId(again.store.db)).toBe(minted);
      expect(sha256(repositoryManifestPath(join(dir, ".staple")))).toBe(bytes);
    } finally {
      again.store.db.close();
    }
  });

  /**
   * Minting on open is worth doing and must never be the reason a command fails.
   *
   * `openWorkspace` is the door every command goes through, `staple ls`
   * included, and a workspace whose manifest somebody has hand-broken — or
   * whose directory is read-only — still has all of its data. Failing closed
   * belongs on the paths that MOVE something, where it is still exactly as
   * strict: the cloud read below refuses rather than treating unreadable as
   * absent.
   */
  it("still opens when the manifest is unreadable, and the cloud path still refuses", () => {
    const dir = plainDir("plain-broken-manifest");
    const created = initWorkspace({ dir });
    const dbPath = created.dbPath;
    created.store.db.close();
    writeFileSync(repositoryManifestPath(join(dir, ".staple")), "{ not json", "utf8");

    const reopened = openWorkspace(dbPath);
    try {
      expect(reopened.store.slug).toBe("plain-broken-manifest");
      expect(reopened.store.listIssues({}).length).toBe(0);
    } finally {
      reopened.store.db.close();
    }
    expect(() => readWorkspaceManifest(dbPath)).toThrow(/valid JSON/i);
  });

  it("can be connected: the read every cloud command starts with now answers", () => {
    const dir = plainDir("plain-connectable");
    const ws = initWorkspace({ dir });
    try {
      const manifest = readWorkspaceManifest(ws.dbPath);
      expect(manifest).not.toBeNull();
      const report = cloudSurfaceReport(
        localCloudStatus(home, manifest!.repositoryId),
        ws.store.db,
      );
      expect(report.state).toBe("disconnected");
      expect(report.failure).toBeNull();
      expect(report.hint).toBe("staple cloud connect");
    } finally {
      ws.store.db.close();
    }
  });
});

// ------------------------------------------------------------ copy detection

describe("copy detection covers the no-checkout case", () => {
  it("records the machine that minted it", () => {
    const ws = initWorkspace({ dir: plainDir("bind-mint") });
    try {
      expect(readOriginHost(ws.store.db)).toBe(hostFingerprint());
      expect(ws.repository.host?.status).toBe("consistent");
    } finally {
      ws.store.db.close();
    }
  });

  it("refuses a directory copied to a second machine, and says so in status", () => {
    const dir = plainDir("copy-origin");
    const created = initWorkspace({ dir });
    const repositoryId = created.repository.repositoryId;
    created.store.db.close();

    const copy = join(root, "copy-elsewhere");
    cpSync(dir, copy, { recursive: true });

    asOtherMachine(() => {
      const opened = openWorkspace(join(copy, ".staple", "staple.db"));
      try {
        // The copy carries the id: it is the same workspace, not a new one.
        expect(readStoredRepositoryId(opened.store.db)).toBe(repositoryId);
        expect(describeHostBinding(opened.store.db).status).toBe("moved");
        expect(() => assertOwnHost(opened.store.db)).toThrow(StapleError);

        const report = cloudSurfaceReport(localCloudStatus(home, repositoryId), opened.store.db);
        expect(report.warnings.join(" ")).toMatch(/different machine/i);
      } finally {
        opened.store.db.close();
      }
    });
  });

  /**
   * A MOVE is not a COPY, and the binding is to the machine precisely so that
   * this stays true. A directory that is renamed, re-nested or dragged across
   * this disk is the same workspace on the same machine — binding to the PATH
   * would have made every one of those look like a fork.
   */
  it("is silent when the directory is moved or renamed on this machine", () => {
    const dir = plainDir("move-before");
    const created = initWorkspace({ dir });
    const repositoryId = created.repository.repositoryId;
    created.store.db.close();

    const moved = join(root, "move-after", "deeper");
    mkdirSync(join(root, "move-after"), { recursive: true });
    renameSync(dir, moved);

    const opened = openWorkspace(join(moved, ".staple", "staple.db"));
    try {
      expect(readStoredRepositoryId(opened.store.db)).toBe(repositoryId);
      expect(describeHostBinding(opened.store.db).status).toBe("consistent");
      expect(() => assertOwnHost(opened.store.db)).not.toThrow();
      const report = cloudSurfaceReport(localCloudStatus(home, repositoryId), opened.store.db);
      expect(report.warnings).toEqual([]);
    } finally {
      opened.store.db.close();
    }
  });

  it("forking the copy makes it independent and binds it to the machine that forked", () => {
    const dir = plainDir("fork-origin");
    const created = initWorkspace({ dir });
    const original = created.repository.repositoryId;
    created.store.db.close();

    const copy = join(root, "fork-copy");
    cpSync(dir, copy, { recursive: true });
    const copyDb = join(copy, ".staple", "staple.db");

    asOtherMachine(() => {
      const opened = openWorkspace(copyDb);
      try {
        const result = forkWorkspaceIdentity(opened.store.db, opened.dbPath);
        expect(result.repositoryId).not.toBe(original);
        expect(readWorkspaceManifest(copyDb)?.repositoryId).toBe(result.repositoryId);
        expect(readOriginHost(opened.store.db)).toBe(hostFingerprint());
        expect(() => assertOwnHost(opened.store.db)).not.toThrow();
      } finally {
        opened.store.db.close();
      }
    });

    // The original is untouched, and still belongs to the machine that minted it.
    const still = openWorkspace(join(dir, ".staple", "staple.db"));
    try {
      expect(readStoredRepositoryId(still.store.db)).toBe(original);
      expect(describeHostBinding(still.store.db).status).toBe("consistent");
    } finally {
      still.store.db.close();
    }
  });
});

// ------------------------------------------- the repository path is unchanged

describe("a checkout-backed workspace is exactly what it was", () => {
  it("records no host, so a clone on another machine is not refused", () => {
    const ws = initWorkspace({ dir: checkoutDir("repo-unbound") });
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

  /**
   * The reason `openWorkspace` never minted for a repository: the manifest is a
   * COMMITTED file there, and creating an untracked one on a read path is a
   * surprise inside somebody's checkout that no amount of correctness excuses.
   */
  it("gains no manifest from an open", () => {
    const dir = checkoutDir("repo-read-only-open");
    const created = initWorkspace({ dir });
    const dbPath = created.dbPath;
    created.store.db.close();

    const manifestPath = repositoryManifestPath(join(dir, ".staple"));
    renameSync(manifestPath, `${manifestPath}.gone`);

    const reopened = openWorkspace(dbPath);
    try {
      expect(existsSync(manifestPath)).toBe(false);
      expect(readWorkspaceManifest(dbPath)).toBeNull();
    } finally {
      reopened.store.db.close();
    }
  });

  it("recovers from a clone: manifest, no database, and init adopts the id", () => {
    const origin = checkoutDir("clone-origin");
    const created = initWorkspace({ dir: origin });
    const repositoryId = created.repository.repositoryId;
    const originBytes = sha256(repositoryManifestPath(join(origin, ".staple")));
    created.store.db.close();

    // What a checkout carries: the manifest, and no database.
    const clone = checkoutDir("clone-fresh");
    mkdirSync(join(clone, ".staple"), { recursive: true });
    cpSync(
      repositoryManifestPath(join(origin, ".staple")),
      repositoryManifestPath(join(clone, ".staple")),
    );

    const adopted = initWorkspace({ dir: clone });
    try {
      expect(adopted.repository.repositoryId).toBe(repositoryId);
      expect(adopted.repository.status).toBe("consistent");
      expect(adopted.repository.manifestWritten).toBe(false);
      expect(adopted.repository.host).toBeNull();
      expect(sha256(repositoryManifestPath(join(clone, ".staple")))).toBe(originBytes);
      // Two machines, one id, and neither is refused. That is what a clone IS.
      asOtherMachine(() => expect(() => assertOwnHost(adopted.store.db)).not.toThrow());
    } finally {
      adopted.store.db.close();
    }
  });

  it("still fails closed on a manifest that is present and malformed", () => {
    const dir = checkoutDir("repo-malformed");
    const created = initWorkspace({ dir });
    created.store.db.close();
    writeFileSync(repositoryManifestPath(join(dir, ".staple")), "{ nope", "utf8");
    expect(() => readWorkspaceManifest(created.dbPath)).toThrow(/valid JSON/i);
  });

  it("reports a manifest that names a different id, and repairs nothing", () => {
    const dir = checkoutDir("repo-mismatch");
    const created = initWorkspace({ dir });
    const dbPath = created.dbPath;
    created.store.db.close();

    writeFileSync(
      repositoryManifestPath(join(dir, ".staple")),
      `${JSON.stringify({ repositoryId: "11111111-2222-3333-4444-555555555555", format: 1 }, null, 2)}\n`,
      "utf8",
    );
    const again = initWorkspace({ dir });
    try {
      expect(again.repository.status).toBe("manifest_mismatch");
      expect(again.repository.repositoryId).toBe("11111111-2222-3333-4444-555555555555");
      expect(again.repository.host).toBeNull();
    } finally {
      again.store.db.close();
    }
  });
});

// ------------------------------------------------------------- the advice

describe("no surface tells a reader to init a workspace that already exists", () => {
  it("does not offer `staple init` for a workspace that records its own identity", () => {
    const dir = plainDir("advice-plain");
    const created = initWorkspace({ dir });
    const dbPath = created.dbPath;
    created.store.db.close();
    renameSync(
      repositoryManifestPath(join(dir, ".staple")),
      `${repositoryManifestPath(join(dir, ".staple"))}.gone`,
    );

    const workspace = describeWorkspace(entryFor("advice-plain", dbPath));
    const reason = skipReasonFor(workspace);
    expect(reason).toBe("no_identity");
    const message = describeSkip(workspace, reason!);
    expect(message).not.toMatch(/staple init/);
    expect(message).toMatch(/records one/i);
  });

  it("still names `staple init`, and the exact directory, inside a checkout", () => {
    const dir = checkoutDir("advice-checkout");
    const created = initWorkspace({ dir });
    const dbPath = created.dbPath;
    created.store.db.close();
    renameSync(
      repositoryManifestPath(join(dir, ".staple")),
      `${repositoryManifestPath(join(dir, ".staple"))}.gone`,
    );

    const workspace = describeWorkspace(entryFor("advice-checkout", dbPath));
    const message = describeSkip(workspace, skipReasonFor(workspace)!);
    expect(message).toMatch(/staple init/);
    expect(message).toContain(dir);
    // It must not imply the workspace is missing: it is registered and intact.
    expect(message).toMatch(/registered|intact|adopts/i);
  });

  it("keeps the missing-disk answer ahead of the identity answer", () => {
    const workspace = describeWorkspace(entryFor("gone", join(root, "not-here", ".staple", "staple.db")));
    expect(skipReasonFor(workspace)).toBe("unavailable");
  });

  it("the one-workspace report names the directory rather than a bare init", () => {
    const dir = checkoutDir("advice-report");
    const report = noIdentityReport(join(dir, ".staple", "staple.db"));
    expect(report.failure?.code).toBe("no_identity");
    expect(report.failure?.remedy).toContain(dir);
    expect(report.state).toBe("disconnected");
  });
});
