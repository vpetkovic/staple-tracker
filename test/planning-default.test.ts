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
import { runCliAt } from "./fixtures/characterize-support.js";
import { startMcpClient, toolPayload } from "./fixtures/contract-support.js";

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

/** `initWorkspace` as a person's door calls it (`planning: true`), unless the case says otherwise. */
function withInit<T>(options: Parameters<typeof initWorkspace>[0], read: (store: WorkspaceStore) => T): T {
  const opened = initWorkspace({ planning: true, ...options });
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
      expect(store.settingValue("features.planning")).toMatchObject({ value: true, source: "workspace" });
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

  it("an init that is not a person's door leaves the default alone", () => {
    withInit({ dir: dir("internal"), planning: false }, (store) => {
      expect(planning(store)).toEqual({ setting: false, on: false, kinds: [] });
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

describe("the doors a person creates a workspace through", () => {
  it("staple init and staple init --global start with planning on, and the first task is the third number", () => {
    const home = process.env.STAPLE_HOME!;
    const repo = dir("cli-repo");
    const env = { STAPLE_HOME: home };
    expect(runCliAt(repo, ["init", "--slug", "lark"], env, 30_000).status).toBe(0);
    const setting = runCliAt(repo, ["settings", "get", "features.planning", "--json"], env, 30_000);
    expect(JSON.parse(setting.stdout)).toMatchObject({ value: true, source: "workspace" });
    // Now and Next are milestones, so they hold the first two ticket numbers.
    const created = runCliAt(repo, ["new", "First task", "--json"], env, 30_000);
    expect(JSON.parse(created.stdout).identifier).toBe("LAR-3");
    const global = runCliAt(repo, ["init", "--global", "notes", "--json"], env, 30_000);
    expect(JSON.parse(global.stdout)).toMatchObject({ created: true, planning: true });
    const notes = runCliAt(repo, ["settings", "get", "features.planning", "--ws", "notes", "--json"], env, 30_000);
    expect(JSON.parse(notes.stdout)).toMatchObject({ value: true, source: "workspace" });
  }, 60_000);

  it("staple init says planning is on, and --no-planning starts a plain workspace", () => {
    const env = { STAPLE_HOME: process.env.STAPLE_HOME! };
    const said = runCliAt(dir("cli-said"), ["init"], env, 30_000);
    expect(said.stdout).toContain("Planning is on: ideas, and the horizons Now and Next");
    const plain = dir("cli-plain");
    const made = runCliAt(plain, ["init", "--slug", "plain", "--no-planning", "--json"], env, 30_000);
    expect(JSON.parse(made.stdout)).toMatchObject({ created: true, planning: false });
    const setting = runCliAt(plain, ["settings", "get", "features.planning", "--json"], env, 30_000);
    expect(JSON.parse(setting.stdout)).toMatchObject({ value: false, source: "default" });
    expect(JSON.parse(runCliAt(plain, ["new", "First task", "--json"], env, 30_000).stdout).identifier).toBe("PLA-1");
    // Init again without the flag is not a new workspace: nothing turns on.
    expect(JSON.parse(runCliAt(plain, ["init", "--json"], env, 30_000).stdout)).toMatchObject({ created: false, planning: false });
  }, 60_000);

  it("the MCP init tool starts a new workspace with planning on", async () => {
    const home = process.env.STAPLE_HOME!;
    const mcp = await startMcpClient({ home, cwd: dir("mcp-cwd"), agent: "worker" });
    try {
      const made = await mcp.call("init", { global: true, slug: "wren" });
      expect(made.isError).toBeFalsy();
      expect(toolPayload(await mcp.call("get_setting", { ws: "wren", key: "features.planning" }))).toMatchObject({ value: true, source: "workspace" });
      expect((await mcp.call("list_horizons", { ws: "wren" })).isError).toBeFalsy();
      expect((await mcp.call("init", { global: true, slug: "finch", planning: false })).isError).toBeFalsy();
      expect(toolPayload(await mcp.call("get_setting", { ws: "finch", key: "features.planning" }))).toMatchObject({ value: false, source: "default" });
    } finally {
      await mcp.close();
    }
  }, 60_000);
});
