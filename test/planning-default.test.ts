/**
 * Planning is on by default for a NEW workspace, and only for one: a database and a repository
 * identity both made by this `staple init`. A clone, a join target and a workspace an older
 * build made each keep whatever the workspace itself says, which for a workspace that never
 * stored the key is still off.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { initWorkspace } from "../src/core/workspace.js";
import { resolveJoinTarget } from "../src/core/cloud/share.js";
import { settingDefinition } from "../src/core/settings-registry.js";
import { readStoredRepositoryId } from "../src/core/repo-identity.js";
import { createHash } from "node:crypto";

/** The id a default horizon takes in a repository (`defaultHorizonId` in the plan store). */
function stableHorizonId(repositoryId: string, name: string): string {
  const hex = createHash("sha256").update(`staple:default-horizon:${repositoryId}:${name}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const REPO_ID = "11111111-1111-4111-8111-111111111111";
const previousHome = process.env.STAPLE_HOME;
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "staple-planning-default-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
});

let n = 0;
beforeEach(() => {
  n += 1;
  process.env.STAPLE_HOME = join(root, `home-${n}`);
});

function dir(name: string): string {
  const path = join(root, `${name}-${n}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** What the workspace reads: the stored value, whether planning works, and its horizons. */
function planning(store: WorkspaceStore) {
  return {
    setting: store.getSetting("features.planning"),
    on: store.planningOn(),
    kinds: store.getKinds().map((kind) => kind.id).filter((id) => id === "idea" || id === "milestone"),
  };
}

function withInit<T>(options: Parameters<typeof initWorkspace>[0], read: (store: WorkspaceStore) => T): T {
  const opened = initWorkspace(options);
  try {
    return read(opened.store);
  } finally {
    opened.store.db.close();
  }
}

describe("a new workspace starts with planning on", () => {
  it("a new repository workspace has planning on, its kinds and the default horizons", () => {
    withInit({ dir: dir("repo") }, (store) => {
      expect(planning(store)).toEqual({ setting: true, on: true, kinds: ["idea", "milestone"] });
      const horizons = store.plan().view().horizons;
      expect(horizons.map((horizon) => horizon.name)).toEqual(["Now", "Next"]);
      // Made after the identity, so they take the repository's stable ids: two devices that
      // each turn planning on before hearing of each other make the same records.
      const repositoryId = readStoredRepositoryId(store.db)!;
      expect(horizons.map((horizon) => horizon.id)).toEqual(["Now", "Next"].map((name) => stableHorizonId(repositoryId, name)));
      // Stored as a setting, so it travels to every device like the person's own choice.
      expect(store.settings().values.get("features.planning")?.value).toBe(true);
    });
  });

  it("a new global workspace has planning on too", () => {
    withInit({ global: true, slug: "notes" }, (store) => {
      expect(planning(store)).toEqual({ setting: true, on: true, kinds: ["idea", "milestone"] });
    });
  });

  it("init again leaves a person's later choice alone", () => {
    const repo = dir("repo-off");
    withInit({ dir: repo }, (store) => store.setSetting("features.planning", false, "vp", { via: "cli" }));
    withInit({ dir: repo }, (store) => {
      expect(planning(store).setting).toBe(false);
      expect(store.planningOn()).toBe(false);
    });
  });

  it("the person can still turn it off, and the ideas stay", () => {
    withInit({ dir: dir("repo-data") }, (store) => {
      const idea = store.plan().capture({ title: "Passkey sign-in" }, "vp");
      store.setSetting("features.planning", false, "vp", { via: "cli" });
      expect(store.planningOn()).toBe(false);
      store.setSetting("features.planning", true, "vp", { via: "cli" });
      expect(store.plan().view().ideas.map((row) => row.id)).toContain(idea.id);
    });
  });
});

describe("an existing workspace keeps its own setting", () => {
  it("the registry default stays off, so a workspace an older build made is not turned on", () => {
    expect(settingDefinition("features.planning")?.default).toBe(false);
    const repo = dir("older");
    // An older build's database: made and stamped without the new default.
    mkdirSync(join(repo, ".staple"), { recursive: true });
    const db = openDb(join(repo, ".staple", "staple.db"));
    migrateWorkspace(db);
    db.prepare("INSERT INTO meta (key, value) VALUES ('slug', 'older'), ('prefix', 'OLD')").run();
    db.close();
    withInit({ dir: repo }, (store) => {
      expect(planning(store)).toEqual({ setting: false, on: false, kinds: [] });
    });
  });

  it("a clone whose identity came out of git does not turn planning on", () => {
    const clone = dir("clone");
    mkdirSync(join(clone, ".staple"), { recursive: true });
    writeFileSync(join(clone, ".staple", "repository.json"), `${JSON.stringify({ repositoryId: REPO_ID, format: 1 })}\n`);
    withInit({ dir: clone }, (store) => {
      expect(planning(store)).toEqual({ setting: false, on: false, kinds: [] });
      expect(store.journal.pending().filter((op) => op.entity === "setting")).toEqual([]);
    });
  });

  it("a workspace made to join a shared one does not turn planning on", () => {
    const home = process.env.STAPLE_HOME!;
    const link = { endpoint: "https://sync.example", repositoryId: REPO_ID, name: "shared", prefix: null, sharedBy: "vp", invitedAs: null };
    const target = resolveJoinTarget({ home, cwd: dir("elsewhere"), link, create: true });
    expect(target.created).toBe(true);
    const db = openDb(target.dbPath);
    try {
      const store = new WorkspaceStore(db, target.name, "");
      expect(planning(store)).toEqual({ setting: false, on: false, kinds: [] });
    } finally {
      db.close();
    }
  });
});
