/**
 * A workspace joining a repository takes the repository's identifier prefix.
 *
 * A prefix is derived from the directory a clone is initialised in, so two clones of one
 * repository in `tracker/` and `staple-tracker/` numbered issues `TRA-N` and `STA-N`, and a
 * repository they both synchronized held two identifier namespaces. `docs/sync.md` said the
 * prefix synchronizes; nothing sent it.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDiagnostics } from "../src/commands/doctor.js";
import { Hub } from "../src/core/hub.js";
import { initWorkspace } from "../src/core/workspace.js";
import { openWorkspace } from "../src/core/open.js";
import { describeSeed } from "../src/core/cloud/seed.js";
import { REPOSITORY_PREFIX_SETTING, recordedRepositoryPrefix } from "../src/core/cloud/repository-prefix.js";
import { StapleError } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-00000000013a";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function prefixOf(machine: Machine): string {
  return (machine.db.prepare("SELECT value FROM meta WHERE key = 'prefix'").get() as { value: string }).value;
}

function hubPrefixOf(machine: Machine, slug: string): string | undefined {
  const hub = Hub.openAt(machine.home);
  try {
    return hub.findBySlug(slug)?.prefix;
  } finally {
    hub.close();
  }
}

/** A repository that A seeded from a clone in `tracker/`: its issues are TRA-N. */
async function repositoryOfTra(): Promise<{ server: FakeSyncServer; a: Machine }> {
  const server = new FakeSyncServer({ repositoryId: REPO });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a", { dirName: "tracker", slug: "tracker" });
  a.store.createIssue({ title: "One" });
  a.store.createIssue({ title: "Two" });
  await a.sync();
  return { server, a };
}

describe("the first device declares its prefix, and a joining clone takes it", () => {
  it("a fresh clone with no issues of its own just takes it: nothing renumbered, nothing said", async () => {
    const { a } = await repositoryOfTra();
    expect(recordedRepositoryPrefix(a.db)).toBe("TRA");
    // Recorded as a setting key older builds preserve unread; this build does not call it unknown.
    const reopened = openWorkspace(a.dbPath);
    try {
      expect(reopened.store.unknownSettingKeys()).toEqual([]);
    } finally {
      reopened.store.db.close();
    }

    const b = fleet!.machine("b", { dirName: "staple-tracker", slug: "staple-tracker" });
    expect(prefixOf(b)).toBe("STA");
    const report = await b.sync();

    expect(prefixOf(b)).toBe("TRA");
    expect(hubPrefixOf(b, "staple-tracker")).toBe("TRA");
    expect(report.seed?.prefix).toEqual({ from: "STA", to: "TRA" });
    expect(report.seed?.renamed).toEqual([]);
    expect(describeSeed(report.seed!).details).toEqual([]);
    // It numbers new issues in the repository's namespace, clear of the repository's own.
    b.use();
    expect(b.store.createIssue({ title: "Three, from B" }).identifier).toBe("TRA-3");
    await b.sync();
    await a.sync();
    expect(a.db.prepare("SELECT identifier FROM issues ORDER BY identifier").all()).toEqual([
      { identifier: "TRA-1" },
      { identifier: "TRA-2" },
      { identifier: "TRA-3" },
    ]);
  });

  it("a clone that worked before joining moves its issues into the repository's numbering, the way any renumber goes", async () => {
    const { a } = await repositoryOfTra();
    const prepared = fleet!.prepare("c", { dirName: "staple-tracker", slug: "staple-tracker" });
    const c = fleet!.connect("c", prepared);
    const mine = c.store.createIssue({ title: "C's own, from before joining" });
    expect(mine.identifier).toBe("STA-1");
    // A cross-link on C's machine naming it, to another workspace there.
    c.use();
    const otherDir = join(prepared.dir, "..", "other");
    mkdirSync(join(otherDir, ".staple"), { recursive: true });
    writeFileSync(join(otherDir, ".staple", "repository.json"), JSON.stringify({ repositoryId: randomUUID(), format: 1 }));
    const other = initWorkspace({ dir: otherDir, slug: "other" });
    const target = other.store.createIssue({ title: "Waits on C's issue" }).identifier;
    other.store.db.close();
    const hub = Hub.openAt(c.home);
    hub.addCrossLink("STA-1", target);
    hub.close();

    const report = await c.sync();
    const moved = (c.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(mine.id) as { identifier: string }).identifier;
    expect(moved).toBe("TRA-3");
    expect(prefixOf(c)).toBe("TRA");
    // The seed report says so, and so does what the CLI prints from it.
    expect(report.seed?.renamed).toEqual([expect.objectContaining({ entityId: mine.id, from: "STA-1", to: "TRA-3" })]);
    expect(describeSeed(report.seed!).details).toEqual(
      expect.arrayContaining([
        "this workspace now numbers issues TRA-N, as the repository does (it was STA-N)",
        "renumbered STA-1 -> TRA-3: into the repository's TRA numbering",
      ]),
    );
    // The old identifier still finds it here, the hub link followed it, and the comment
    // that says why reached the other device.
    expect(c.store.getIssue("STA-1").id).toBe(mine.id);
    const after = Hub.openAt(c.home);
    try {
      expect(after.crossLinksFor("staple-tracker").map((link) => link.blockerIdentifier)).toEqual(["TRA-3"]);
    } finally {
      after.close();
    }
    await a.sync();
    const note = a.db.prepare("SELECT body FROM comments WHERE issue_id = ?").get(mine.id) as { body: string };
    expect(note.body).toContain("Renumbered from STA-1 to TRA-3");
  });
});

describe("a device that joined before the prefix was declared", () => {
  it("learns it as an operation on the tail, and doctor reports that it disagrees", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    // W joined an empty repository from `staple-tracker/`, on a build that declared nothing:
    // its declaration is not in the log and not recorded on W.
    const w = fleet.machine("w", { dirName: "staple-tracker", slug: "staple-tracker" });
    w.store.createIssue({ title: "W's" });
    await w.sync();
    const declared = server.ops.findIndex((op) => op.entity === "setting" && op.entityId === REPOSITORY_PREFIX_SETTING);
    expect(declared).toBeGreaterThanOrEqual(0);
    server.ops.splice(declared, 1);
    w.db.prepare("DELETE FROM meta WHERE key = ?").run(`setting:${REPOSITORY_PREFIX_SETTING}`);

    // Most of the repository was then written as TRA-N, by a device on an older build.
    const schema = Number((w.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    const sent = JSON.parse(
      (w.db.prepare("SELECT payload FROM sync_outbox WHERE entity = 'issue' AND verb = 'create'").get() as { payload: string }).payload,
    );
    await new OlderBuildDevice(server, REPO, "device-old", schema).push(
      [2, 3, 4].map((n) => ({
        entity: "issue",
        entityId: randomUUID(),
        verb: "create" as const,
        payload: { ...sent, identifier: `TRA-${n}`, title: `Old build's ${n}` },
      })),
    );

    // A current device joins from a third directory name: the prefix is undeclared, and TRA
    // is the one most of the issues carry, so that is what it declares — and takes.
    const t = fleet.machine("t", { dirName: "work", slug: "work" });
    expect(prefixOf(t)).toBe("WOR");
    await t.sync();
    expect(recordedRepositoryPrefix(t.db)).toBe("TRA");
    expect(prefixOf(t)).toBe("TRA");

    // W receives the declaration in its ordered tail, records it, and keeps its own prefix.
    await w.sync();
    expect(recordedRepositoryPrefix(w.db)).toBe("TRA");
    expect(prefixOf(w)).toBe("STA");
    w.use();
    const check = runDiagnostics({ dir: w.dir }).checks.find((candidate) => candidate.id === "repository-prefix")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("numbers its issues STA-N, and its repository numbers them TRA-N");
    t.use();
    expect(runDiagnostics({ dir: t.dir }).checks.find((candidate) => candidate.id === "repository-prefix")!.status).toBe("pass");
  });
});

describe("a joining clone whose repository's prefix another workspace here holds", () => {
  it("is refused before anything is written, with the command that frees it", async () => {
    const { a } = await repositoryOfTra();
    const prepared = fleet!.prepare("d", { dirName: "staple-tracker", slug: "staple-tracker" });
    // On D's machine, an unrelated workspace already holds TRA.
    process.env.STAPLE_HOME = prepared.home;
    const otherDir = join(prepared.dir, "..", "unrelated");
    mkdirSync(join(otherDir, ".staple"), { recursive: true });
    writeFileSync(join(otherDir, ".staple", "repository.json"), JSON.stringify({ repositoryId: randomUUID(), format: 1 }));
    const unrelated = initWorkspace({ dir: otherDir, slug: "tracker" });
    expect(unrelated.store.prefix).toBe("TRA");
    unrelated.store.db.close();

    const d = fleet!.connect("d", prepared);
    d.store.createIssue({ title: "D's own" });
    d.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const settle = Hub.openAt(prepared.home);
    settle.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    settle.close();
    /**
     * A write-ahead log that does not exist and one that exists and is empty hold the same
     * bytes — none. Reading the hub (read-only) to decide the refusal can leave an empty one
     * behind; anything written would leave frames in it, and those would show.
     */
    const digest = (path: string): string =>
      createHash("sha256").update(existsSync(path) ? readFileSync(path) : Buffer.alloc(0)).digest("hex");
    const files = [d.dbPath, `${d.dbPath}-wal`, join(prepared.home, "hub.db"), join(prepared.home, "hub.db-wal")];
    const before = files.map(digest);

    const refused = await d.sync().then(() => null, (error: unknown) => error as StapleError);
    expect(refused).toBeInstanceOf(StapleError);
    expect(refused!.message).toContain('belongs to workspace "tracker"');
    expect(refused!.message).toContain("`staple hub unregister tracker`");
    expect(refused!.message).toContain("Nothing was sent and nothing was changed");
    expect(files.map(digest)).toEqual(before);
    expect(prefixOf(d)).toBe("STA");
    expect(hubPrefixOf(d, "staple-tracker")).toBe("STA");
    void a;
  });
});

/**
 * The hub row under this workspace's slug is an adopted registry's, for another repository:
 * no path, and another sync identity. A row like that takes its identity only from the
 * `repository_id` the hub recorded (#105), and nothing may attach to it or re-stamp it
 * unless it presents that identity (`absentRowRefusal` in `src/core/hub.ts`).
 */
describe("a joining clone whose slug the hub lists for another repository, with no database here", () => {
  function adoptedRowFor(
    machine: Machine,
    prefix: string,
    identity: string = randomUUID(),
  ): { slug: string; prefix: string; path: string; repository_id: string } {
    const hub = Hub.openAt(machine.home);
    try {
      hub.db
        .prepare("UPDATE workspaces SET path = '', repository_id = ?, prefix = ? WHERE slug = 'staple-tracker'")
        .run(identity, prefix);
      return hub.db.prepare("SELECT slug, prefix, path, repository_id FROM workspaces WHERE slug = 'staple-tracker'").get() as {
        slug: string;
        prefix: string;
        path: string;
        repository_id: string;
      };
    } finally {
      hub.close();
    }
  }

  function hubRow(machine: Machine): unknown {
    const hub = Hub.openAt(machine.home);
    try {
      return hub.db.prepare("SELECT slug, prefix, path, repository_id FROM workspaces WHERE slug = 'staple-tracker'").get();
    } finally {
      hub.close();
    }
  }

  it("holding the repository's prefix: the join is refused, and nothing is written", async () => {
    await repositoryOfTra();
    const d = fleet!.machine("d", { dirName: "staple-tracker", slug: "staple-tracker" });
    const row = adoptedRowFor(d, "TRA");
    const before = d.db.prepare("SELECT key, value FROM meta ORDER BY key").all();

    const refused = await d.sync().then(() => null, (error: unknown) => error as StapleError);
    expect(refused).toBeInstanceOf(StapleError);
    expect(refused!.message).toContain("`staple hub unregister staple-tracker`");
    expect(refused!.message).toContain(row.repository_id);
    expect(hubRow(d)).toEqual(row);
    expect(prefixOf(d)).toBe("STA");
    expect(d.db.prepare("SELECT key, value FROM meta ORDER BY key").all()).toEqual(before);
  });

  it("holding another prefix: the workspace joins and takes the repository's, and the row is left as it was", async () => {
    await repositoryOfTra();
    const d = fleet!.machine("d", { dirName: "staple-tracker", slug: "staple-tracker" });
    const row = adoptedRowFor(d, "STA");

    await d.sync();
    expect(prefixOf(d)).toBe("TRA");
    expect(hubRow(d)).toEqual(row);
  });

  it("recording this workspace's own identity: it is this workspace's row, whichever prefix it holds", async () => {
    await repositoryOfTra();
    const holding = fleet!.machine("d", { dirName: "staple-tracker", slug: "staple-tracker" });
    adoptedRowFor(holding, "TRA", REPO);
    await holding.sync();
    expect(prefixOf(holding)).toBe("TRA");

    const stamped = fleet!.machine("e", { dirName: "staple-tracker", slug: "staple-tracker" });
    const row = adoptedRowFor(stamped, "STA", REPO);
    await stamped.sync();
    expect(prefixOf(stamped)).toBe("TRA");
    expect(hubRow(stamped)).toEqual({ ...row, prefix: "TRA" });
  });
});
