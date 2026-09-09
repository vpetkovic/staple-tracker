/**
 * STA-285 — two copies of one workspace, on ONE machine.
 *
 * S20's host binding (`origin_host`, migration 012) catches a restore or an
 * rsync onto a SECOND machine. It cannot see this case, and that is not an
 * omission: both copies sit on the same host, so the recorded fingerprint
 * matches in both, and `origin_host` is null for every checkout-backed
 * workspace anyway.
 *
 * `findRepositoryIdCollisions` cannot see it either, for a different reason —
 * it compares REGISTERED paths, and a copy is not registered. Opening it
 * re-pointed the hub row at it, so the registry never held two paths to
 * compare; it held one that oscillated between two databases, a hub WRITE per
 * command, forever.
 *
 * So this is hub-registration territory. The distinction the fix turns on:
 *
 *   - a MOVE vacates the registered path, and re-pointing is the repair;
 *   - a COPY leaves a live workspace database at the registered path, and
 *     re-pointing steals a registration from a directory that still exists.
 *
 * Both halves are tested here. A suite that only proved the refusal would pass
 * for an implementation that refused everything, which would break `staple
 * migrate`'s crash recovery and every moved repository on the machine.
 *
 * Every case drives the REAL CLI in a child process from a real directory,
 * because the walk-up path is the only door that repairs and `runCliAt`'s cwd
 * is the only way to enter it. The assertions are on the hub row read out of
 * SQLite afterwards, never on prose.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { classifyRegisteredPath, isSecondClaimant } from "../src/core/hub-repair.js";
import { removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

let home: string;
let root: string;

beforeAll(() => {
  home = tempDir("sta285-home");
  root = tempDir("sta285-root");
});

afterAll(() => {
  removeDir(home);
  removeDir(root);
});

function cli(dir: string, args: string[]) {
  return runCliAt(dir, args, { STAPLE_HOME: home }, 60_000);
}

/** A registered workspace at `<root>/<name>`, created by the real `init`. */
function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const init = cli(dir, ["init"]);
  expect(init.status, init.stderr).toBe(0);
  expect(rowFor(name)?.path).toBe(dbIn(dir));
  return dir;
}

function dbIn(dir: string): string {
  return join(dir, ".staple", "staple.db");
}

function hubDb<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function rowFor(slug: string): { slug: string; prefix: string; path: string } | undefined {
  return hubDb(
    (db) =>
      db.prepare("SELECT slug, prefix, path FROM workspaces WHERE slug = ?").get(slug) as
        | { slug: string; prefix: string; path: string }
        | undefined,
  );
}

/** Moves only when another connection COMMITS, so it is the "wrote nothing" probe. */
function dataVersion(): number {
  return hubDb((db) => (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
}

interface DoctorCheck {
  id: string;
  status: string;
  detail: string;
  data: Record<string, unknown>;
}

function doctorCheck(dir: string, id: string): { check: DoctorCheck; exit: number } {
  const run = cli(dir, ["doctor", "--json"]);
  const parsed = JSON.parse(run.stdout.trim()) as { checks: DoctorCheck[] };
  const check = parsed.checks.find((c) => c.id === id);
  expect(check, `doctor has no ${id} check; ran in ${dir}`).toBeDefined();
  return { check: check!, exit: run.status };
}

// ------------------------------------------------------------------ the copy

describe("a second copy of a workspace on this machine", () => {
  /**
   * The headline refusal, and the criterion is about what is NOT written: the
   * hub row still names the directory it named before.
   *
   * `staple ls` in the copy must keep working. A registry disagreement that
   * broke a read would be a worse bug than the row it was trying to fix —
   * `hub-repair.ts`'s "why this never throws" — so the refusal is a `conflict`
   * result nobody prints here, and `doctor` is where a human hears about it.
   */
  it("is refused: the hub keeps pointing at the original", () => {
    const original = repo("twin");
    const copy = join(root, "twin-copied");
    cpSync(original, copy, { recursive: true });
    expect(existsSync(dbIn(copy))).toBe(true);

    const settled = dataVersion();
    const ls = cli(copy, ["ls"]);
    expect(ls.status, ls.stderr).toBe(0);

    expect(rowFor("twin")!.path).toBe(dbIn(original));
    expect(rowFor("twin")!.prefix).toBe("TWI");
    // Nothing was written to the hub at all — not the path, not last_seen_at.
    expect(dataVersion()).toBe(settled);
  }, 90_000);

  /**
   * The bug's actual signature was oscillation: each command in whichever copy
   * you were standing in stole the row, so the registry flapped and every read
   * became a write. Three alternating commands and one unchanged
   * `data_version` is the assertion that it has stopped.
   */
  it("does not oscillate: alternating commands write nothing", () => {
    const original = repo("flap");
    const copy = join(root, "flap-copied");
    cpSync(original, copy, { recursive: true });

    expect(cli(original, ["ls"]).status).toBe(0); // settles last_seen_at, if any
    const settled = dataVersion();

    for (const dir of [copy, original, copy]) {
      expect(cli(dir, ["ls"]).status).toBe(0);
      expect(rowFor("flap")!.path).toBe(dbIn(original));
    }
    expect(dataVersion()).toBe(settled);
  }, 120_000);

  /** Criterion 2: the operator is told, and told WHICH TWO PATHS. */
  it("is reported by doctor in the copy, naming both paths", () => {
    const original = repo("named");
    const copy = join(root, "named-copied");
    cpSync(original, copy, { recursive: true });

    const { check, exit } = doctorCheck(copy, "workspace-hub-link");
    expect(check.status).toBe("fail");
    expect(exit).toBe(1);
    // Both claimants, by path, in the sentence a human reads.
    expect(check.detail).toContain(dbIn(original));
    expect(check.detail).toContain(dbIn(copy));
    // And machine-readably, with the identity they share.
    expect(check.data.registeredPath).toBe(dbIn(original));
    expect(check.data.dbPath).toBe(dbIn(copy));
    expect(check.data.sharedRepositoryId).toMatch(/^[0-9a-f-]{36}$/);
  }, 90_000);

  /** The original is a working workspace and must not be told it is broken. */
  it("leaves the original's own diagnosis clean", () => {
    const original = repo("innocent");
    cpSync(original, join(root, "innocent-copied"), { recursive: true });

    const { check } = doctorCheck(original, "workspace-hub-link");
    expect(check.status).toBe("pass");
  }, 90_000);

  /**
   * `staple add` reaches the same registration through a different door, and it
   * did NOT inherit the refusal for free: `performSetup` -> `initWorkspace`
   * calls `hub.register()`, whose upsert repoints the row BEFORE `add`'s own
   * `repairHubRegistration` is reached. So `add` refuses in its preview, where
   * nothing has been written yet.
   */
  it("is refused by `staple add`, which writes nothing either", () => {
    const original = repo("added");
    const copy = join(root, "added-copied");
    cpSync(original, copy, { recursive: true });

    const settled = dataVersion();
    const add = cli(root, ["add", copy, "--yes"]);
    expect(add.status).not.toBe(0);
    expect(add.stderr).toContain(dbIn(original));
    expect(add.stderr).toContain(dbIn(copy));

    expect(rowFor("added")!.path).toBe(dbIn(original));
    expect(dataVersion()).toBe(settled);
  }, 90_000);
});

// ------------------------------------------------------------------ the move

describe("a workspace that genuinely moved", () => {
  /**
   * Criterion 3, and the test that stops the fix from being "refuse
   * everything". A move VACATES the registered path, so there is no second
   * claimant and nothing to report.
   */
  it("still re-points silently, and doctor is clean afterwards", () => {
    const before = repo("relocated");
    const after = join(root, "relocated-elsewhere");
    renameSync(before, after);
    expect(existsSync(dbIn(before))).toBe(false);

    const ls = cli(after, ["ls"]);
    expect(ls.status, ls.stderr).toBe(0);
    expect(ls.stderr).toBe("");

    expect(rowFor("relocated")!.path).toBe(dbIn(after));
    expect(rowFor("relocated")!.prefix).toBe("REL");
    expect(doctorCheck(after, "workspace-hub-link").check.status).toBe("pass");
  }, 90_000);

  /**
   * The case that makes the identity read earn its keep, and the reason
   * `existsSync` alone is not the answer.
   *
   * The workspace moved away, and something ELSE was created at the directory
   * it left. The registered path exists again, so a presence-only check would
   * refuse to repair a row that is genuinely stale — and would keep refusing
   * forever. Two live databases that present two different repository
   * identities are two workspaces, not two copies of one.
   */
  it("re-points even when another workspace has taken over its old directory", () => {
    const before = repo("vacated");
    const after = join(root, "vacated-elsewhere");
    renameSync(before, after);

    // A different project moves in, keeping its own slug and its own identity.
    mkdirSync(before, { recursive: true });
    const squatter = cli(before, ["init", "--slug", "newcomer"]);
    expect(squatter.status, squatter.stderr).toBe(0);
    expect(existsSync(dbIn(before))).toBe(true);
    expect(rowFor("newcomer")!.path).toBe(dbIn(before));

    const ls = cli(after, ["ls"]);
    expect(ls.status, ls.stderr).toBe(0);

    expect(rowFor("vacated")!.path).toBe(dbIn(after));
    expect(rowFor("newcomer")!.path).toBe(dbIn(before)); // untouched
  }, 120_000);
});

// ------------------------------------------------------------ the classifier

/**
 * The verdict, unit by unit.
 *
 * These fixtures write an EMPTY FILE where the database goes, and every case
 * still gets the right answer. That is deliberate, and it is the pin on the cost
 * claim: the classifier reads a two-key JSON file beside the database and never
 * opens the database itself, so an "improvement" that reached for SQLite to
 * compare `sync_state` would fail here rather than quietly adding a second
 * database open to the resolution path.
 */
describe("classifyRegisteredPath", () => {
  let bench: string;

  beforeAll(() => {
    bench = tempDir("sta285-bench");
  });

  afterAll(() => removeDir(bench));

  /** A project root with a database file and, optionally, an identity beside it. */
  function project(
    name: string,
    options: { id?: string; manifest?: string; legacy?: boolean } = {},
  ): string {
    const root = join(bench, name);
    const dir = join(root, options.legacy ? ".tasks" : ".staple");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, options.legacy ? "tasks.db" : "staple.db");
    writeFileSync(dbPath, ""); // never opened, so it never has to be a database
    const manifest =
      options.manifest ?? (options.id ? `{\n  "repositoryId": "${options.id}",\n  "format": 1\n}\n` : null);
    if (manifest !== null) writeFileSync(join(dir, "repository.json"), manifest);
    return dbPath;
  }

  const ID_A = "11111111-2222-4333-8444-555555555555";
  const ID_B = "99999999-8888-4777-8666-555555555555";

  it("calls a registered path that no longer exists vacated", () => {
    const opened = project("v-opened", { id: ID_A });
    const verdict = classifyRegisteredPath(join(bench, "gone", ".staple", "staple.db"), opened);
    expect(verdict.kind).toBe("vacated");
    expect(isSecondClaimant(verdict)).toBe(false);
  });

  it("calls two live directories that share an identity a shared identity", () => {
    const registered = project("s-original", { id: ID_A });
    const opened = project("s-copy", { id: ID_A });
    const verdict = classifyRegisteredPath(registered, opened);
    expect(verdict).toEqual({ kind: "shared-identity", repositoryId: ID_A });
    expect(isSecondClaimant(verdict)).toBe(true);
  });

  it("calls two live directories with different identities distinct, so the row is repaired", () => {
    const registered = project("d-newcomer", { id: ID_B });
    const opened = project("d-moved", { id: ID_A });
    const verdict = classifyRegisteredPath(registered, opened);
    expect(verdict.kind).toBe("distinct-identity");
    expect(isSecondClaimant(verdict)).toBe(false);
  });

  /**
   * One project root cannot be a copy of itself. The legacy layout is where a
   * single project legitimately owns two database paths, so `same-project` is
   * what stops a row still naming `.tasks/tasks.db` from being read as a rival
   * claimant to the `.staple/staple.db` beside it.
   */
  it("calls two layouts of one project the same project", () => {
    const root = join(bench, "two-layouts");
    mkdirSync(join(root, ".tasks"), { recursive: true });
    mkdirSync(join(root, ".staple"), { recursive: true });
    writeFileSync(join(root, ".tasks", "tasks.db"), "");
    writeFileSync(join(root, ".staple", "staple.db"), "");
    const verdict = classifyRegisteredPath(
      join(root, ".tasks", "tasks.db"),
      join(root, ".staple", "staple.db"),
    );
    expect(verdict.kind).toBe("same-project");
    expect(isSecondClaimant(verdict)).toBe(false);
  });

  /**
   * No identity to compare, so a copy cannot be ruled out. The tie goes to
   * reporting: the row asserts this workspace lives there, a live database IS
   * there, and overwriting that on no evidence is the oscillation being fixed.
   */
  it("reports a live registered path with no identity as indistinguishable", () => {
    const registered = project("i-nomanifest");
    const opened = project("i-opened", { id: ID_A });
    const verdict = classifyRegisteredPath(registered, opened);
    expect(verdict.kind).toBe("indistinguishable");
    expect(isSecondClaimant(verdict)).toBe(true);
  });

  /**
   * A hand-broken manifest is reported, never thrown. `doctor` calls this from
   * inside a check, and a check that threw would say only that a check threw.
   */
  it("does not throw on an unparseable manifest", () => {
    const registered = project("u-broken", { manifest: "{ not json at all" });
    const opened = project("u-opened", { id: ID_A });
    expect(() => classifyRegisteredPath(registered, opened)).not.toThrow();
    expect(classifyRegisteredPath(registered, opened).kind).toBe("indistinguishable");
  });
});
