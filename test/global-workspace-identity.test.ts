/**
 * STA-273 — a workspace with no repository gets a sync identity.
 *
 * The block was one line in `initWorkspace`: `kind === "repo" ? reconcile... : null`,
 * justified by "there is nothing to identify and nowhere for a manifest to be
 * checked in". The first half is wrong and the second half is about CLONE
 * RECOVERY — a global workspace is never cloned, so it needs no git-recoverable
 * copy, and nothing in the identity path invokes git in the first place.
 *
 * What this file pins:
 *
 *   - where a non-repository manifest lives, and that it is NOT the shared
 *     `workspaces/` directory (that would hand every global workspace one id);
 *   - that an existing global workspace gains an identity without losing data;
 *   - and, the regression this change could introduce, that the repo-backed path
 *     is byte-for-byte what it was.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { openWorkspace } from "../src/core/open.js";
import { initWorkspace } from "../src/core/workspace.js";
import {
  REPOSITORY_MANIFEST_FILENAME,
  isRepositoryId,
  readOriginHost,
  readStoredRepositoryId,
  readWorkspaceManifest,
  reconcileRepositoryIdentity,
  repositoryManifestPath,
  workspaceIdentityDir,
} from "../src/core/repo-identity.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";

let home: string;
let root: string;

beforeAll(() => {
  home = tempDir("gid-home");
  root = tempDir("gid-root");
});

afterAll(() => {
  removeDir(home);
  removeDir(root);
});

beforeEach(() => {
  process.env.STAPLE_HOME = home;
  process.env.STAPLE_HOST_ID = "machine-a";
});

function repoDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("workspaceIdentityDir", () => {
  it("gives a home-resident workspace its own directory beside the database", () => {
    expect(workspaceIdentityDir(join(home, "workspaces", "workshop.db"), home)).toBe(
      join(home, "workspaces", "workshop"),
    );
  });

  it("never resolves two global workspaces to one directory", () => {
    const a = workspaceIdentityDir(join(home, "workspaces", "workshop.db"), home);
    const b = workspaceIdentityDir(join(home, "workspaces", "notes.db"), home);
    expect(a).not.toBe(b);
    // The shared parent is what the naive fix would have used, and it is exactly
    // what must never be an identity directory.
    expect(a).not.toBe(join(home, "workspaces"));
  });

  it("leaves a repository-backed workspace on the directory that holds its database", () => {
    const dbPath = join(root, "project", ".staple", "staple.db");
    expect(workspaceIdentityDir(dbPath, home)).toBe(join(root, "project", ".staple"));
  });

  it("does not treat a lookalike path outside the home as home-resident", () => {
    const dbPath = join(root, "elsewhere", "workspaces", "workshop.db");
    expect(workspaceIdentityDir(dbPath, home)).toBe(join(root, "elsewhere", "workspaces"));
  });
});

describe("a global workspace mints and keeps an identity", () => {
  it("records one on init, in its own directory", () => {
    const ws = initWorkspace({ global: true, slug: "workshop" });
    try {
      expect(ws.repository).not.toBeNull();
      expect(isRepositoryId(ws.repository!.repositoryId)).toBe(true);
      expect(ws.repository!.manifestPath).toBe(
        join(home, "workspaces", "workshop", REPOSITORY_MANIFEST_FILENAME),
      );
      expect(existsSync(ws.repository!.manifestPath)).toBe(true);
      expect(readStoredRepositoryId(ws.store.db)).toBe(ws.repository!.repositoryId);
    } finally {
      ws.store.db.close();
    }
  });

  it("survives reopening the workspace", () => {
    const first = initWorkspace({ global: true, slug: "reopened" });
    const minted = first.repository!.repositoryId;
    first.store.db.close();

    const second = openWorkspace(join(home, "workspaces", "reopened.db"));
    try {
      expect(readStoredRepositoryId(second.store.db)).toBe(minted);
      expect(readWorkspaceManifest(second.dbPath)?.repositoryId).toBe(minted);
    } finally {
      second.store.db.close();
    }
  });

  it("gives two global workspaces in one home two different identities", () => {
    const one = initWorkspace({ global: true, slug: "alpha" });
    const two = initWorkspace({ global: true, slug: "beta" });
    try {
      expect(one.repository!.repositoryId).not.toBe(two.repository!.repositoryId);
      expect(one.repository!.manifestPath).not.toBe(two.repository!.manifestPath);
    } finally {
      one.store.db.close();
      two.store.db.close();
    }
  });

  it("adopts an existing manifest rather than minting a second identity", () => {
    const first = initWorkspace({ global: true, slug: "adopted" });
    const minted = first.repository!.repositoryId;
    first.store.db.close();

    const second = initWorkspace({ global: true, slug: "adopted" });
    try {
      expect(second.repository!.repositoryId).toBe(minted);
      expect(second.repository!.manifestWritten).toBe(false);
    } finally {
      second.store.db.close();
    }
  });

  it("gives an existing identity-less global workspace one, without losing its data", () => {
    // A workspace created before this change: a database with rows, no identity
    // directory, and no recorded id.
    const created = initWorkspace({ global: true, slug: "legacy" });
    const issue = created.store.createIssue({ title: "survives the upgrade" });
    created.store.db.exec("UPDATE sync_state SET repository_id = NULL");
    created.store.db.close();
    rmSync(join(home, "workspaces", "legacy"), { recursive: true, force: true });

    const reopened = openWorkspace(join(home, "workspaces", "legacy.db"));
    try {
      const identity = readWorkspaceManifest(reopened.dbPath);
      expect(identity).not.toBeNull();
      expect(readStoredRepositoryId(reopened.store.db)).toBe(identity!.repositoryId);
      expect(reopened.store.getIssue(issue.identifier).title).toBe("survives the upgrade");
    } finally {
      reopened.store.db.close();
    }
  });

  it("keeps the identity out of git's way: nothing in the path invokes it", () => {
    for (const file of ["src/core/repo-identity.ts", "src/core/host-id.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      // Not a spelling check: `git` appears in prose about clone recovery. What
      // must not appear is an invocation of it.
      expect(source).not.toMatch(/["'`]git["'`]/);
      expect(source).not.toMatch(/exec\w*\((\s*)["'`]git\b/);
    }
  });
});

describe("the repository-backed path is unchanged", () => {
  it("writes the same manifest, in the same place, with the same bytes", () => {
    const dir = join(repoDir("byte-identical"), ".staple");
    mkdirSync(dir, { recursive: true });
    const db = openDb(join(dir, "staple.db"));
    migrateWorkspace(db);
    try {
      const report = reconcileRepositoryIdentity(db, dir);
      expect(report.manifestPath).toBe(repositoryManifestPath(dir));

      const text = readFileSync(report.manifestPath, "utf8");
      expect(text).toBe(`{\n  "repositoryId": "${report.repositoryId}",\n  "format": 1\n}\n`);
      expect(Object.keys(JSON.parse(text))).toEqual(["repositoryId", "format"]);
    } finally {
      db.close();
    }
  });

  it("resolves a repo workspace's identity to the directory holding the database", () => {
    const dir = join(repoDir("resolver"), ".staple");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "staple.db");
    const db = openDb(dbPath);
    migrateWorkspace(db);
    try {
      const report = reconcileRepositoryIdentity(db, dir);
      expect(readWorkspaceManifest(dbPath)?.repositoryId).toBe(report.repositoryId);
    } finally {
      db.close();
    }
  });

  it("records no host binding, so no copy check can ever fire on it", () => {
    const dir = join(repoDir("unbound"), ".staple");
    mkdirSync(dir, { recursive: true });
    const db = openDb(join(dir, "staple.db"));
    migrateWorkspace(db);
    try {
      reconcileRepositoryIdentity(db, dir);
      expect(readOriginHost(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("still lets the manifest win over the stored id, and still reports the mismatch", () => {
    const dir = join(repoDir("mismatch"), ".staple");
    mkdirSync(dir, { recursive: true });
    const db = openDb(join(dir, "staple.db"));
    migrateWorkspace(db);
    try {
      const original = reconcileRepositoryIdentity(db, dir).repositoryId;
      const replacement = "11111111-2222-3333-4444-555555555555";
      writeFileSync(
        repositoryManifestPath(dir),
        `{\n  "repositoryId": "${replacement}",\n  "format": 1\n}\n`,
        "utf8",
      );

      const report = reconcileRepositoryIdentity(db, dir);
      expect(report.status).toBe("manifest_mismatch");
      expect(report.repositoryId).toBe(replacement);
      expect(report.storedRepositoryId).toBe(original);
      // Reported, never repaired: both sides keep their evidence.
      expect(readStoredRepositoryId(db)).toBe(original);
    } finally {
      db.close();
    }
  });

  it("still fails closed on a malformed manifest rather than minting over it", () => {
    const dir = join(repoDir("malformed"), ".staple");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "staple.db");
    const db = openDb(dbPath);
    migrateWorkspace(db);
    try {
      writeFileSync(repositoryManifestPath(dir), "{ corrupted", "utf8");
      expect(() => reconcileRepositoryIdentity(db, dir)).toThrow(/valid JSON/i);
      expect(() => readWorkspaceManifest(dbPath)).toThrow(/valid JSON/i);
      expect(readFileSync(repositoryManifestPath(dir), "utf8")).toBe("{ corrupted");
    } finally {
      db.close();
    }
  });
});
