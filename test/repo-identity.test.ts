/**
 * STA-68 — repository identity: what a clone recovers, what a fork does, and
 * what a copied directory looks like from the inside.
 *
 * The centrepiece is the git test. Every other assertion here could be satisfied
 * by a design that quietly depended on the database, so the clone case is run
 * against REAL git — `git init`, a real commit, a real `git clone` — rather than
 * against a hand-copied directory that a helper decided the contents of. What is
 * being proven is a property of the repository as git sees it: the identity is in
 * the tree, the database is not, and no secret rode along.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { StapleError } from "../src/core/types.js";
import {
  REPOSITORY_MANIFEST_FILENAME,
  REPOSITORY_MANIFEST_FORMAT,
  REPOSITORY_MANIFEST_KEYS,
  ensureRepositoryManifest,
  findRepositoryIdCollisions,
  forkRepositoryId,
  isRepositoryId,
  parseRepositoryManifest,
  readRepositoryManifest,
  readStoredRepositoryId,
  reconcileRepositoryIdentity,
  renderRepositoryManifest,
  repositoryManifestPath,
} from "../src/core/repo-identity.js";
import { WORKSPACE_GITIGNORE_BODY } from "../src/core/workspace-gitignore.js";
import { removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

let home: string;
let root: string;

beforeAll(() => {
  home = tempDir("s2-identity-home");
  root = tempDir("s2-identity-root");
});

afterAll(() => {
  removeDir(home);
  removeDir(root);
});

function scratch(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A migrated workspace database plus the directory its manifest belongs in. */
function workspace(name: string): { dir: string; db: DatabaseSync } {
  const dir = scratch(name);
  const db = openDb(join(dir, "staple.db"));
  migrateWorkspace(db);
  return { dir, db };
}

function git(cwd: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8" },
  );
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

// --------------------------------------------------------------- the manifest

describe("the manifest is publishable by construction", () => {
  it("carries exactly two keys — an id and a format number", () => {
    const { dir } = workspace("manifest-shape");
    const { manifest, path } = ensureRepositoryManifest(dir);

    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([...REPOSITORY_MANIFEST_KEYS].sort());
    expect(parsed).toEqual({
      repositoryId: manifest.repositoryId,
      format: REPOSITORY_MANIFEST_FORMAT,
    });
    expect(isRepositoryId(manifest.repositoryId)).toBe(true);
  });

  it("contains nothing that looks like a credential, an endpoint or an account", () => {
    /**
     * The point of the manifest being tracked is that publishing it discloses
     * that a repository MAY be connected and nothing else. This is the assertion
     * that keeps that true as the file evolves — anything resembling a secret or
     * a destination fails here rather than in somebody's public repository.
     */
    const { dir } = workspace("manifest-nonsecret");
    const text = readFileSync(ensureRepositoryManifest(dir).path, "utf8");
    for (const forbidden of [
      "token",
      "secret",
      "key",
      "password",
      "credential",
      "endpoint",
      "account",
      "device",
      "http",
      "bearer",
      "user",
    ]) {
      expect(text.toLowerCase(), `manifest must not mention ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("serializes deterministically, so a rewrite is not a spurious diff", () => {
    const manifest = { repositoryId: "0e77fa01-1111-4222-8333-444455556666", format: 1 };
    const text = renderRepositoryManifest(manifest);
    expect(text).toBe(
      '{\n  "repositoryId": "0e77fa01-1111-4222-8333-444455556666",\n  "format": 1\n}\n',
    );
    // Key ORDER is fixed, not inherited from whatever object the caller passed.
    expect(renderRepositoryManifest({ format: 1, repositoryId: manifest.repositoryId })).toBe(text);
  });
});

describe("a manifest that cannot be understood is refused, never replaced", () => {
  const cases: Array<[string, string, string]> = [
    ["invalid JSON", "{ not json", "valid JSON"],
    ["a JSON array", "[]", "JSON object"],
    ["a missing id", '{ "format": 1 }', "repositoryId"],
    ["a non-UUID id", '{ "repositoryId": "nope", "format": 1 }', "repositoryId"],
    [
      "an upper-case UUID",
      '{ "repositoryId": "0E77FA01-1111-4222-8333-444455556666", "format": 1 }',
      "repositoryId",
    ],
    ["a missing format", '{ "repositoryId": "0e77fa01-1111-4222-8333-444455556666" }', "format"],
    [
      "an extra key",
      '{ "repositoryId": "0e77fa01-1111-4222-8333-444455556666", "format": 1, "token": "sekrit" }',
      "unexpected keys",
    ],
  ];

  it.each(cases)("refuses %s", (_label, text, expected) => {
    expect(() => parseRepositoryManifest(text, "/tmp/repository.json")).toThrow(
      new RegExp(expected, "i"),
    );
  });

  it("refuses a newer format as a conflict, the same shape as the schema guard", () => {
    /**
     * `conflict`, not `validation`: the file is not malformed, this build is
     * older than it. An older binary that shrugged would write a manifest the
     * newer one had already moved past.
     */
    try {
      parseRepositoryManifest(
        '{ "repositoryId": "0e77fa01-1111-4222-8333-444455556666", "format": 99 }',
        "/tmp/repository.json",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StapleError);
      expect((error as StapleError).code).toBe("conflict");
    }
  });

  it("does NOT treat an unreadable manifest as an absent one", () => {
    /**
     * The single most important refusal in this file. "Unreadable" degrading to
     * "absent" means minting a new id, and minting a new id on a clone is a
     * silent, unattributable fork discovered weeks later.
     */
    const { dir } = workspace("manifest-corrupt");
    writeFileSync(repositoryManifestPath(dir), "{ corrupted", "utf8");

    expect(() => readRepositoryManifest(dir)).toThrow(/valid JSON/i);
    expect(() => ensureRepositoryManifest(dir)).toThrow(/valid JSON/i);
    // And the bad file is still there — nothing overwrote the evidence.
    expect(readFileSync(repositoryManifestPath(dir), "utf8")).toBe("{ corrupted");
  });

  it("names a remedy that does not lose the identity", () => {
    const { dir } = workspace("manifest-remedy");
    writeFileSync(repositoryManifestPath(dir), "{ corrupted", "utf8");
    expect(() => readRepositoryManifest(dir)).toThrow(/git checkout/);
  });
});

// ------------------------------------------------------------------ adoption

describe("adoption — the manifest wins, and is never clobbered", () => {
  it("mints once and adopts forever after", () => {
    const { dir } = workspace("adopt-once");
    const first = ensureRepositoryManifest(dir);
    expect(first.written).toBe(true);

    const second = ensureRepositoryManifest(dir);
    expect(second.written).toBe(false);
    expect(second.manifest.repositoryId).toBe(first.manifest.repositoryId);
  });

  it("teaches an empty database what the manifest already says", () => {
    const { dir, db } = workspace("adopt-db");
    try {
      const manifest = ensureRepositoryManifest(dir);
      expect(readStoredRepositoryId(db)).toBeNull();

      const report = reconcileRepositoryIdentity(db, dir);
      expect(report.status).toBe("consistent");
      expect(report.storedRepositoryId).toBeNull();
      expect(report.repositoryId).toBe(manifest.manifest.repositoryId);
      expect(readStoredRepositoryId(db)).toBe(manifest.manifest.repositoryId);
    } finally {
      db.close();
    }
  });

  it("is idempotent — reconciling twice writes nothing new", () => {
    const { dir, db } = workspace("adopt-idempotent");
    try {
      const first = reconcileRepositoryIdentity(db, dir);
      const second = reconcileRepositoryIdentity(db, dir);
      expect(second.repositoryId).toBe(first.repositoryId);
      expect(second.manifestWritten).toBe(false);
      expect(second.status).toBe("consistent");
      expect((db.prepare("SELECT COUNT(*) AS n FROM sync_state").get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("reports a hand-edited manifest as a mismatch and repairs nothing", () => {
    /**
     * A database that recorded one id beside a manifest naming another has either
     * been copied out of a different repository or had its manifest edited. Both
     * are decisions for a human — `staple cloud fork-id` if the split is meant,
     * restoring from git if it is not — so the disagreement is preserved, not
     * resolved. Repairing either side would destroy the only evidence.
     */
    const { dir, db } = workspace("adopt-mismatch");
    try {
      const original = reconcileRepositoryIdentity(db, dir).repositoryId;
      const replacement = "0e77fa01-1111-4222-8333-444455556666";
      writeFileSync(
        repositoryManifestPath(dir),
        renderRepositoryManifest({ repositoryId: replacement, format: 1 }),
        "utf8",
      );

      const report = reconcileRepositoryIdentity(db, dir);
      expect(report.status).toBe("manifest_mismatch");
      expect(report.storedRepositoryId).toBe(original);
      expect(report.repositoryId).toBe(replacement);
      // Neither side moved.
      expect(readStoredRepositoryId(db)).toBe(original);
      expect(readRepositoryManifest(dir)?.repositoryId).toBe(replacement);
    } finally {
      db.close();
    }
  });
});

// --------------------------------------------------------------------- clone

describe("a fresh clone recovers the identity from git alone", () => {
  it("tracks the manifest, ignores the database, and hydrates on the other side", () => {
    const originDir = scratch("clone-origin");
    expect(git(originDir, ["init", "--quiet"]).status).toBe(0);
    expect(runCliAt(originDir, ["init"], { STAPLE_HOME: home }).status).toBe(0);

    const manifestPath = join(originDir, ".staple", REPOSITORY_MANIFEST_FILENAME);
    expect(existsSync(manifestPath)).toBe(true);
    const originId = readRepositoryManifest(join(originDir, ".staple"))!.repositoryId;

    expect(git(originDir, ["add", "-A"]).status).toBe(0);
    expect(git(originDir, ["commit", "-m", "initial", "--quiet"]).status).toBe(0);

    // What git actually tracks. The manifest is in; the database and its
    // sidecars are out, because `.staple/.gitignore` says so.
    const tracked = git(originDir, ["ls-files"]).stdout.split("\n").filter(Boolean).sort();
    expect(tracked).toContain(".staple/repository.json");
    expect(tracked).toContain(".staple/AGENTS.md");
    expect(tracked).toContain(".staple/.gitignore");
    expect(tracked.filter((f) => f.includes("staple.db"))).toEqual([]);

    // Clone it, exactly as a second machine would.
    const cloneParent = scratch("clone-parent");
    expect(git(cloneParent, ["clone", "--quiet", originDir, "copy"]).status).toBe(0);
    const cloneDir = join(cloneParent, "copy");

    // The clone has the identity and NO database. This is the state the whole
    // design is for.
    expect(existsSync(join(cloneDir, ".staple", REPOSITORY_MANIFEST_FILENAME))).toBe(true);
    expect(existsSync(join(cloneDir, ".staple", "staple.db"))).toBe(false);
    expect(readRepositoryManifest(join(cloneDir, ".staple"))!.repositoryId).toBe(originId);

    // First command in the clone creates the database — and ADOPTS the id rather
    // than minting one. An init that minted here would fork the repository at
    // exactly the moment the manifest exists to prevent it.
    const cloneHome = tempDir("s2-identity-clone-home");
    try {
      expect(runCliAt(cloneDir, ["init"], { STAPLE_HOME: cloneHome }).status).toBe(0);
      expect(readRepositoryManifest(join(cloneDir, ".staple"))!.repositoryId).toBe(originId);

      const db = new DatabaseSync(join(cloneDir, ".staple", "staple.db"));
      try {
        expect(readStoredRepositoryId(db)).toBe(originId);
      } finally {
        db.close();
      }
    } finally {
      removeDir(cloneHome);
    }
  }, 120_000);

  it("commits no secret — the tracked tree holds only the guide, the ignore file and the manifest", () => {
    const originDir = scratch("clone-nosecret");
    expect(git(originDir, ["init", "--quiet"]).status).toBe(0);
    expect(runCliAt(originDir, ["init"], { STAPLE_HOME: home }).status).toBe(0);
    expect(git(originDir, ["add", "-A"]).status).toBe(0);

    const staged = git(originDir, ["ls-files"]).stdout.split("\n").filter(Boolean).sort();
    expect(staged).toEqual([".staple/.gitignore", ".staple/AGENTS.md", ".staple/repository.json"]);
  }, 120_000);

  it("spares the manifest in the ignore file explicitly, not by accident", () => {
    /**
     * None of `*.db`, `*.db-wal`, `*.db-shm` match `repository.json`, so the
     * negation changes no behaviour today. It is stated so a future editor who
     * broadens the first rule to `*` trips over it — losing the guide on a clone
     * costs an onboarding surface, losing the manifest costs the identity.
     */
    expect(WORKSPACE_GITIGNORE_BODY).toContain("!repository.json");
    expect(WORKSPACE_GITIGNORE_BODY).toContain("!AGENTS.md");
  });
});

// ------------------------------------------------------- fork and copied dirs

describe("fork is explicit, because a copy is indistinguishable from a clone", () => {
  it("converges by default — a copied directory keeps the same id", () => {
    /**
     * Stated as a test because it is a DESIGN CHOICE that looks like a bug. Two
     * directories with one manifest push the same entity ids and identical
     * content merges to itself, which is right for a clone and surprising for a
     * fork. The surprise is resolved by making forking explicit, not by trying to
     * guess which one this is.
     */
    const { dir: originalDir, db } = workspace("fork-origin");
    try {
      const id = reconcileRepositoryIdentity(db, originalDir).repositoryId;

      const copyDir = scratch("fork-copy");
      writeFileSync(
        repositoryManifestPath(copyDir),
        readFileSync(repositoryManifestPath(originalDir), "utf8"),
        "utf8",
      );
      expect(readRepositoryManifest(copyDir)!.repositoryId).toBe(id);
    } finally {
      db.close();
    }
  });

  it("mints a new id, drops the old repository's positions, and keeps local facts", () => {
    const { dir, db } = workspace("fork-does");
    try {
      const before = reconcileRepositoryIdentity(db, dir).repositoryId;

      // Populate every sync table, so what survives is proven rather than assumed.
      db.prepare(
        "UPDATE sync_state SET epoch = 4, cursor = 'c-9', head_seq = 900, client_seq_high_water = 12 WHERE id = 1",
      ).run();
      db.prepare(
        `INSERT INTO sync_outbox (op_id, client_seq, entity, entity_id, verb, payload, created_at)
         VALUES ('op-1', 12, 'issue', 'e1', 'update', '{}', '2026-09-05T12:00:00.000Z')`,
      ).run();
      db.prepare(
        "INSERT INTO sync_applied (op_id, seq, applied_at) VALUES ('op-r', 5, '2026-09-05T12:00:00.000Z')",
      ).run();
      db.prepare(
        "INSERT INTO sync_leases (entity_id, fencing_token, holder, server_expires_at, acquired_at) VALUES ('e1', 3, 'opus-s2', 'x', 'y')",
      ).run();
      db.prepare("INSERT INTO sync_devices (device_id, label) VALUES ('d1', 'laptop')").run();
      db.prepare(
        "INSERT INTO sync_entity_versions (entity, entity_id, version) VALUES ('issue', 'e1', 7)",
      ).run();
      db.prepare(
        "INSERT INTO sync_tombstones (entity, entity_id, deleted_at) VALUES ('issue', 'gone', 'z')",
      ).run();
      db.prepare(
        `INSERT INTO sync_conflicts (id, entity, entity_id, field, detected_at)
         VALUES ('c1', 'issue', 'e1', 'title', '2026-09-05T12:00:00.000Z')`,
      ).run();

      const result = forkRepositoryId(db, dir);

      expect(result.previousRepositoryId).toBe(before);
      expect(result.repositoryId).not.toBe(before);
      expect(isRepositoryId(result.repositoryId)).toBe(true);
      expect(readRepositoryManifest(dir)!.repositoryId).toBe(result.repositoryId);
      expect(readStoredRepositoryId(db)).toBe(result.repositoryId);

      // Positions in the OLD repository's log are gone…
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count("sync_outbox")).toBe(0);
      expect(count("sync_applied")).toBe(0);
      expect(count("sync_leases")).toBe(0);
      expect(count("sync_devices")).toBe(0);
      expect(db.prepare("SELECT epoch, cursor, head_seq FROM sync_state WHERE id = 1").get()).toEqual(
        { epoch: 0, cursor: null, head_seq: 0 },
      );

      // …and local facts survive. A fork does not make this device's history
      // untrue, and rewinding entity versions would let the first post-fork
      // operation reuse a baseVersion.
      expect(count("sync_entity_versions")).toBe(1);
      expect(count("sync_tombstones")).toBe(1);
      expect(count("sync_conflicts")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("leaves the original repository untouched", () => {
    const original = workspace("fork-original");
    const copy = workspace("fork-sibling");
    try {
      const sharedId = reconcileRepositoryIdentity(original.db, original.dir).repositoryId;
      // The copy starts life carrying the original's manifest, as a copied
      // directory would.
      writeFileSync(
        repositoryManifestPath(copy.dir),
        readFileSync(repositoryManifestPath(original.dir), "utf8"),
        "utf8",
      );
      reconcileRepositoryIdentity(copy.db, copy.dir);

      forkRepositoryId(copy.db, copy.dir);

      expect(readRepositoryManifest(original.dir)!.repositoryId).toBe(sharedId);
      expect(readStoredRepositoryId(original.db)).toBe(sharedId);
    } finally {
      original.db.close();
      copy.db.close();
    }
  });
});

describe("the copied-directory diagnostic", () => {
  it("names every workspace path claiming one id", () => {
    const collisions = findRepositoryIdCollisions([
      { path: "/a", repositoryId: "id-1" },
      { path: "/b", repositoryId: "id-1" },
      { path: "/c", repositoryId: "id-2" },
      { path: "/d", repositoryId: null },
    ]);
    expect(collisions).toEqual([{ repositoryId: "id-1", paths: ["/a", "/b"] }]);
  });

  it("is quiet when every workspace has its own identity", () => {
    expect(
      findRepositoryIdCollisions([
        { path: "/a", repositoryId: "id-1" },
        { path: "/b", repositoryId: "id-2" },
        { path: "/c", repositoryId: null },
        { path: "/d", repositoryId: null },
      ]),
    ).toEqual([]);
  });

  it("does not report one workspace registered twice under the same path", () => {
    expect(
      findRepositoryIdCollisions([
        { path: "/a", repositoryId: "id-1" },
        { path: "/a", repositoryId: "id-1" },
      ]),
    ).toEqual([]);
  });

  it("reports several collisions in a stable order", () => {
    const collisions = findRepositoryIdCollisions([
      { path: "/z", repositoryId: "id-b" },
      { path: "/y", repositoryId: "id-b" },
      { path: "/x", repositoryId: "id-a" },
      { path: "/w", repositoryId: "id-a" },
    ]);
    expect(collisions).toEqual([
      { repositoryId: "id-a", paths: ["/w", "/x"] },
      { repositoryId: "id-b", paths: ["/y", "/z"] },
    ]);
  });
});

// ------------------------------------------------------------------ boundaries

describe("what identity does NOT do", () => {
  it("gives a global workspace no manifest — there is no repository to identify", () => {
    const anywhere = scratch("global-none");
    const globalHome = tempDir("s2-identity-global-home");
    try {
      expect(runCliAt(anywhere, ["init", "--global", "solo"], { STAPLE_HOME: globalHome }).status).toBe(
        0,
      );
      expect(existsSync(join(anywhere, ".staple"))).toBe(false);
      expect(existsSync(join(globalHome, "workspaces", REPOSITORY_MANIFEST_FILENAME))).toBe(false);
    } finally {
      removeDir(globalHome);
    }
  }, 120_000);

  it("keeps credentials and device identity out of the workspace database entirely", () => {
    /**
     * The workspace database synchronizes. A credential stored in it would
     * replicate itself to every device, and a consent flag stored in it would
     * mean one machine enabling automatic sync silently enabled it everywhere.
     * So no table here has anywhere to put one — asserted against the whole
     * schema rather than against the tables this ticket happened to add.
     */
    const { dir, db } = workspace("no-credentials");
    try {
      reconcileRepositoryIdentity(db, dir);
      const columns = db
        .prepare(
          `SELECT m.name AS tbl, p.name AS col
             FROM sqlite_master m JOIN pragma_table_info(m.name) p
            WHERE m.type = 'table'`,
        )
        .all() as Array<{ tbl: string; col: string }>;

      const offenders = columns.filter(({ col }) =>
        /token|secret|password|credential|endpoint|bearer/i.test(col),
      );
      // `sync_leases.fencing_token` is the one legitimate "token": a monotonic
      // integer issued by the server for write fencing, not an authenticator.
      expect(offenders).toEqual([{ tbl: "sync_leases", col: "fencing_token" }]);

      // And there is no device secret anywhere, under any spelling. Deliberately
      // narrower than /auth/, which matches `comments.author` — attribution is
      // disclosed on purpose (docs/sync.md, "What synchronizes") and is not a
      // credential.
      expect(
        columns.filter(({ col }) => /device_secret|api_key|access_token|refresh_token/i.test(col)),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("imports nothing that could open a socket", () => {
    /**
     * A structural stand-in for the epic-wide network assertion, scoped to this
     * module: identity is local file and local row work, and it stays that way.
     * A future edit that reaches for `fetch` or `node:http` fails here.
     */
    const source = readFileSync(
      new URL("../src/core/repo-identity.ts", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.sort()).toEqual(["./types.js", "node:crypto", "node:fs", "node:path", "node:sqlite"]);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
