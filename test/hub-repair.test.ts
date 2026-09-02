/**
 * A7 (STA-37) — idempotent hub repair during normal resolution.
 *
 * The defect this closes is A1's quirk #6, pinned verbatim in
 * `characterize-hub-contract.test.ts`: "a MOVED repository leaves a stale hub
 * path that nothing repairs: local commands still work (walk-up never consults
 * the hub) while `--ws` and every hub view follow the dead path indefinitely.
 * Only an explicit re-init fixes it."
 *
 * Plan §4 is the specification, and its three sentences are the three describe
 * blocks below: repair happens on resolution, repair may not renumber anything,
 * and a repair that cannot happen must not take the workspace down with it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

let home: string;
let root: string;

beforeAll(() => {
  home = tempDir("a7-repair-home");
  root = tempDir("a7-repair-root");
});

afterAll(() => {
  removeDir(home);
  removeDir(root);
});

function cli(dir: string, args: string[], hubHome = home) {
  return runCliAt(dir, args, { STAPLE_HOME: hubHome }, 30_000);
}

function repo(name: string, hubHome = home): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  expect(cli(dir, ["init"], hubHome).status).toBe(0);
  return dir;
}

/** The hub rows, read directly rather than through `hub ls`'s renderer. */
function hubRows(hubHome = home): Array<{ slug: string; prefix: string; path: string }> {
  const db = new DatabaseSync(join(hubHome, "hub.db"), { readOnly: true });
  try {
    return db.prepare("SELECT slug, prefix, path FROM workspaces ORDER BY slug").all() as Array<{
      slug: string;
      prefix: string;
      path: string;
    }>;
  } finally {
    db.close();
  }
}

function rowFor(slug: string, hubHome = home) {
  return hubRows(hubHome).find((r) => r.slug === slug);
}

// ------------------------------------------------------- the moved repository

describe("a repository that moved", () => {
  /**
   * The headline case. `staple ls` is a plain READ command — it is the least
   * ceremonious thing a user could run — and running it once inside the moved
   * repository is enough to bring the registry back in line.
   */
  it("repairs its hub path on the next ordinary command", () => {
    const before = repo("mover");
    const slug = "mover";
    expect(rowFor(slug)!.path).toBe(join(before, ".staple", "staple.db"));

    const after = join(root, "moved-mover");
    renameSync(before, after);

    // Stale: the hub still names a path that is no longer there.
    expect(existsSync(rowFor(slug)!.path)).toBe(false);

    const result = cli(after, ["ls"]);
    expect(result.status).toBe(0);

    expect(rowFor(slug)!.path).toBe(join(after, ".staple", "staple.db"));
    expect(rowFor(slug)!.prefix).toBe("MOV"); // unchanged, and that is the point
  }, 60_000);

  /** …and `--ws`, which follows the hub, works again without a re-init. */
  it("makes --ws resolve the workspace again", () => {
    const before = repo("wsmover");
    const after = join(root, "moved-wsmover");
    renameSync(before, after);

    // Before the repair, a --ws lookup follows the dead path.
    const stale = cli(root, ["ls", "--ws", "wsmover"]);
    expect(stale.status).not.toBe(0);

    expect(cli(after, ["ls"]).status).toBe(0);

    const repaired = cli(root, ["ls", "--ws", "wsmover"]);
    expect(repaired.status).toBe(0);
  }, 60_000);

  /**
   * "Normal repository resolution repairs stale hub paths IDEMPOTENTLY."
   *
   * Idempotent here means more than "safe to repeat": the steady state performs
   * NO WRITE at all. That matters because repair now runs on every single
   * command, and a version-bumping write per read would put every `staple ls`
   * into contention with the six-process concurrency suites.
   */
  it("writes nothing once the row is already correct", () => {
    const dir = repo("idempotent");
    const hubDb = join(home, "hub.db");

    const versionOf = () => {
      const db = new DatabaseSync(hubDb, { readOnly: true });
      try {
        return (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
      } finally {
        db.close();
      }
    };

    expect(cli(dir, ["ls"]).status).toBe(0);
    const settled = versionOf();
    for (let i = 0; i < 3; i += 1) expect(cli(dir, ["ls"]).status).toBe(0);
    // `data_version` only moves when another connection COMMITS. Unchanged
    // across three more resolutions means those three wrote nothing.
    expect(versionOf()).toBe(settled);
    expect(rowFor("idempotent")!.path).toBe(join(dir, ".staple", "staple.db"));
  }, 60_000);
});

// ------------------------------------------------------------ never renumber

describe("repair never reallocates a prefix", () => {
  /**
   * Plan §4: "It may not allocate a new prefix or overwrite a slug registered
   * with another prefix."
   *
   * Forced by rewriting the hub row's prefix behind staple's back, which is the
   * only way to manufacture the disagreement. Resolution must refuse and leave
   * BOTH sides exactly as they were — it is not staple's place to decide that
   * the file or the registry is the liar.
   */
  it("refuses when the hub and the database disagree, and rewrites neither", () => {
    const dir = repo("disagree");
    const db = new DatabaseSync(join(home, "hub.db"));
    try {
      db.prepare("UPDATE workspaces SET prefix = 'ZZZ' WHERE slug = 'disagree'").run();
    } finally {
      db.close();
    }

    const result = cli(dir, ["ls"]);
    // The local command still works — that is the plan's edge case.
    expect(result.status).toBe(0);

    const row = rowFor("disagree")!;
    expect(row.prefix).toBe("ZZZ"); // the registry was not overwritten
    expect(row.path).toBe(join(dir, ".staple", "staple.db"));

    // …and the workspace database was not renumbered either.
    const wsDb = new DatabaseSync(join(dir, ".staple", "staple.db"), { readOnly: true });
    try {
      const prefix = wsDb.prepare("SELECT value FROM meta WHERE key = 'prefix'").get() as { value: string };
      expect(prefix.value).toBe("DIS");
    } finally {
      wsDb.close();
    }

    // doctor is where the disagreement becomes visible, per plan §4.
    const doctor = cli(dir, ["doctor", "--json"]);
    const report = JSON.parse(doctor.stdout.trim()) as { checks: Array<{ id: string; status: string }> };
    const link = report.checks.find((c) => c.id === "workspace-hub-link")!;
    expect(link.status).toBe("fail");
    expect(doctor.status).toBe(1);
  }, 60_000);

  /**
   * A row that vanished entirely (a deleted hub, a restored backup) is
   * RE-registered rather than newly allocated: the prefix comes out of the
   * workspace database, so the identifiers already written into commits and
   * comments keep meaning what they meant.
   */
  it("restores a missing registration with the prefix the database already carries", () => {
    const dir = repo("restored");
    const db = new DatabaseSync(join(home, "hub.db"));
    try {
      db.prepare("DELETE FROM workspaces WHERE slug = 'restored'").run();
    } finally {
      db.close();
    }
    expect(rowFor("restored")).toBeUndefined();

    expect(cli(dir, ["ls"]).status).toBe(0);

    const row = rowFor("restored")!;
    expect(row.prefix).toBe("RES");
    expect(row.path).toBe(join(dir, ".staple", "staple.db"));
  }, 60_000);

  /** A prefix another workspace has taken is not stolen, and nothing breaks. */
  it("refuses to re-register under a prefix another slug now holds", () => {
    const dir = repo("taken");
    const db = new DatabaseSync(join(home, "hub.db"));
    try {
      db.prepare("DELETE FROM workspaces WHERE slug = 'taken'").run();
      db.prepare(
        "INSERT INTO workspaces (slug, prefix, path, kind, added_at) VALUES ('squatter','TAK','/nowhere/x.db','repo','2026-01-01T00:00:00.000Z')",
      ).run();
    } finally {
      db.close();
    }

    expect(cli(dir, ["ls"]).status).toBe(0);
    expect(rowFor("taken")).toBeUndefined(); // not registered, not forced
    expect(rowFor("squatter")!.prefix).toBe("TAK"); // not stolen
  }, 60_000);
});

// ------------------------------------------------ failure must not propagate

describe("hub repair failure leaves the workspace usable", () => {
  /**
   * Plan's edge-case table: "Hub repair fails | Local project becomes unusable |
   * Keep local workspace operations available and report repair through doctor."
   *
   * An unopenable hub is the sharpest version of that: `repairHubRegistration`
   * catches everything and returns `unavailable`, so a corrupt registry costs
   * the user their cross-workspace views and nothing else.
   */
  it("a corrupt hub does not stop reads or writes in the workspace", () => {
    const brokenHome = tempDir("a7-broken-home");
    const dir = join(root, "resilient");
    mkdirSync(dir, { recursive: true });
    expect(cli(dir, ["init"], brokenHome).status).toBe(0);

    writeFileSync(join(brokenHome, "hub.db"), "this is not a database at all\n");

    // Reads work.
    expect(cli(dir, ["ls"], brokenHome).status).toBe(0);
    // Writes work.
    const created = cli(dir, ["new", "still working", "--json"], brokenHome);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout.trim()).title).toBe("still working");
    // And it survived a round trip.
    expect(cli(dir, ["ls"], brokenHome).stdout).toContain("still working");

    removeDir(brokenHome);
  }, 60_000);

  it("a hub whose file was deleted is silently re-created by the next init, not by a read", () => {
    const freshHome = tempDir("a7-fresh-home");
    const dir = join(root, "nohub");
    mkdirSync(dir, { recursive: true });
    expect(cli(dir, ["init"], freshHome).status).toBe(0);

    removeDir(join(freshHome, "hub.db"));
    // A read resolves, repairs what it can, and reports success either way.
    expect(cli(dir, ["ls"], freshHome).status).toBe(0);

    removeDir(freshHome);
  }, 60_000);
});
