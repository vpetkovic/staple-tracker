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
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

/** The committed repository identity of a project directory. */
function identityIn(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, ".staple", "repository.json"), "utf8")) as {
    repositoryId: string;
  }).repositoryId;
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
    // Written BEFORE the copy, so finding it in the copy's own output proves the
    // child really resolved a workspace rather than dying early. `runCliAt`
    // reports `status: 0` for a signal-killed child (`result.status ?? 0`), so an
    // exit code alone would be satisfied by a process that never ran.
    expect(cli(original, ["new", "carried across"]).status).toBe(0);
    const copy = join(root, "twin-copied");
    cpSync(original, copy, { recursive: true });
    expect(existsSync(dbIn(copy))).toBe(true);

    const settled = dataVersion();
    const ls = cli(copy, ["ls"]);
    expect(ls.timedOut).toBe(false);
    expect(ls.status, ls.stderr).toBe(0);
    expect(ls.stdout).toContain("carried across");

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
    expect(cli(original, ["new", "still here"]).status).toBe(0);
    const copy = join(root, "flap-copied");
    cpSync(original, copy, { recursive: true });

    expect(cli(original, ["ls"]).status).toBe(0); // settles last_seen_at, if any
    const settled = dataVersion();

    for (const dir of [copy, original, copy]) {
      const ls = cli(dir, ["ls"]);
      expect(ls.timedOut).toBe(false);
      expect(ls.status, ls.stderr).toBe(0);
      expect(ls.stdout).toContain("still here"); // the child really resolved one
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

  /**
   * The original is a working workspace and must not be told it is broken.
   *
   * The copy is OPENED first, deliberately. Without that this asserts nothing:
   * the row still equals `here`, so `checkWorkspaceHubLink` returns `pass` before
   * the classifier is reached, and the test passes on master and with the
   * classifier stubbed to refuse everything. Opening the copy is the state a user
   * is actually in when they ask the original how it is doing.
   */
  it("leaves the original's own diagnosis clean once a copy has been opened", () => {
    const original = repo("innocent");
    const copy = join(root, "innocent-copied");
    cpSync(original, copy, { recursive: true });
    expect(cli(copy, ["ls"]).status).toBe(0); // the copy is now a live claimant

    const { check } = doctorCheck(original, "workspace-hub-link");
    expect(check.status).toBe("pass");
    // Present and null rather than absent: `data` is one shape across statuses.
    expect(check.data.secondClaimant).toBeNull();
    expect(check.data.sharedRepositoryId).toBeNull();
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

  /**
   * The end-to-end reproduction of the second round's defect: freeze the original
   * and work in the copy.
   *
   * Every staple workspace is WAL, and SQLite needs a writable `-shm` in the
   * database's own directory to read one. With the original's `.staple` not
   * writable, the read-only probe fails with `attempt to write a readonly
   * database` — and the first version read that as "not a workspace" and handed
   * the registration to the copy, silently, with `doctor` then reporting `pass`.
   * `chmod -R a-w`, a checkout owned by another uid and a read-only bind mount are
   * all this shape, and freezing an original is precisely how copies come about.
   *
   * Skipped as root, where `chmod` does not bite; the classifier's unit cases keep
   * the branch covered there.
   */
  it.skipIf(process.getuid?.() === 0)(
    "is refused when the original's directory cannot be written",
    () => {
      const original = repo("frozen");
      const copy = join(root, "frozen-copied");
      cpSync(original, copy, { recursive: true });

      // First contact: a `-shm` left behind by an earlier reader makes the
      // read-only open succeed, which is what made the defect order-dependent.
      const stapleDir = join(original, ".staple");
      for (const sidecar of ["-wal", "-shm"]) {
        rmSync(join(stapleDir, `staple.db${sidecar}`), { force: true });
      }
      expect(existsSync(join(stapleDir, "staple.db-shm"))).toBe(false);

      chmodSync(stapleDir, 0o500);
      try {
        const settled = dataVersion();
        const ls = cli(copy, ["ls"]);
        expect(ls.timedOut).toBe(false);
        expect(ls.status, ls.stderr).toBe(0);

        // The registration did NOT follow the copy, and nothing was written.
        expect(rowFor("frozen")!.path).toBe(dbIn(original));
        expect(dataVersion()).toBe(settled);

        // ...and the operator is told, with the reason rather than a claim of a copy.
        const { check, exit } = doctorCheck(copy, "workspace-hub-link");
        expect(check.status).toBe("fail");
        expect(exit).toBe(1);
        expect(check.data.unreadableReason).toBe("attempt to write a readonly database");
        expect(check.detail).toContain(dbIn(original));
        expect(check.detail).toContain("could not be read");
      } finally {
        chmodSync(stapleDir, 0o700);
      }
    },
    120_000,
  );

  /**
   * The regression the first version of this fix shipped, and the reason the
   * discriminator is the slug rather than the repository id.
   *
   * `staple cloud fork-id` mints a new identity and touches NEITHER slug NOR
   * prefix — `forkRepositoryId` writes the manifest and clears the `sync_*`
   * tables, and `repointPath` only guards on prefix, which still matches. So an
   * id-based check saw two different ids, called the copy a MOVE, and re-pointed:
   * the exact oscillation, reached by obeying the advice the refusal printed.
   *
   * Forking is a real operation with a real purpose; it just is not the way out of
   * this, because two directories cannot both answer to one slug however many
   * identities they have.
   */
  it("stays refused after the copy forks its repository identity", () => {
    const original = repo("forked");
    const copy = join(root, "forked-copied");
    cpSync(original, copy, { recursive: true });

    const fork = cli(copy, ["cloud", "fork-id", "--yes", "--json"]);
    expect(fork.timedOut).toBe(false);
    expect(fork.status, fork.stderr).toBe(0);
    const result = JSON.parse(fork.stdout.trim()) as {
      previousRepositoryId: string;
      repositoryId: string;
    };
    // The fork really happened: a new identity, and it is not the old one.
    expect(result.repositoryId).not.toBe(result.previousRepositoryId);

    const settled = dataVersion();
    const ls = cli(copy, ["ls"]);
    expect(ls.timedOut).toBe(false);
    expect(ls.status, ls.stderr).toBe(0);

    // Still refused, still nothing written, even though the ids now differ.
    expect(rowFor("forked")!.path).toBe(dbIn(original));
    expect(dataVersion()).toBe(settled);

    const { check } = doctorCheck(copy, "workspace-hub-link");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(dbIn(original));
    expect(check.detail).toContain(dbIn(copy));
    // No shared id to report any more, and the sentence must not claim one.
    expect(check.data.sharedRepositoryId).toBeNull();
    expect(check.detail).not.toContain("Both also present repository");
    // The remedy is executable in this state: `fork-id` has already been used and
    // did not help, so what is offered is releasing the slug.
    expect(check.detail).toContain("staple hub unregister forked");
    expect(check.detail).not.toContain("fork-id");
  }, 120_000);

  /**
   * ...and the remedy the refusal prints actually resolves it, which is the
   * difference between a report and a dead end.
   */
  it("can be settled by releasing the slug, after which the copy registers", () => {
    const original = repo("settle");
    const copy = join(root, "settle-copied");
    cpSync(original, copy, { recursive: true });
    expect(cli(copy, ["ls"]).status).toBe(0);
    expect(rowFor("settle")!.path).toBe(dbIn(original));

    const released = cli(root, ["hub", "unregister", "settle"]);
    expect(released.status, released.stderr).toBe(0);
    expect(rowFor("settle")).toBeUndefined();

    // Now the operator's choice stands: the next command in the copy takes it.
    expect(cli(copy, ["ls"]).status).toBe(0);
    expect(rowFor("settle")!.path).toBe(dbIn(copy));
    expect(rowFor("settle")!.prefix).toBe("SET"); // the prefix its own database carries
    expect(doctorCheck(copy, "workspace-hub-link").check.status).toBe("pass");
  }, 120_000);
});

// -------------------------------------------------------- clones are not copies

/**
 * Two checkouts of one repository on one machine share a `repositoryId` BY
 * DESIGN: `.staple/repository.json` is deliberately committed
 * (`workspace-gitignore.ts` has `!repository.json`), and
 * `findRepositoryIdCollisions`' own doc says two directories presenting one id
 * "look exactly like two clones, which is a thing it must support".
 *
 * So a shared identity is not evidence of a copy, and refusing on it made
 * `staple add` reject a legitimate second worktree while the walk-up door
 * accepted it — the explicit command failing where the implicit one worked.
 */
describe("a second checkout of the same repository", () => {
  it("registers through both doors: they share an identity but not a slug", () => {
    const first = repo("api");

    // A second checkout: same committed identity, its own directory, and its own
    // slug, exactly as `git clone` then `staple init` would leave it.
    const second = join(root, "api-worktree");
    mkdirSync(join(second, ".staple"), { recursive: true });
    cpSync(join(first, ".staple", "repository.json"), join(second, ".staple", "repository.json"));
    const init = cli(second, ["init", "--slug", "api-wt"]);
    expect(init.status, init.stderr).toBe(0);
    // The premise: one identity, two slugs.
    expect(identityIn(second)).toBe(identityIn(first));
    expect(rowFor("api")!.path).toBe(dbIn(first));
    expect(rowFor("api-wt")!.path).toBe(dbIn(second));

    // The explicit door: `add` must not refuse what walking up already accepted.
    const readded = cli(root, ["add", second, "--yes"]);
    expect(readded.status, readded.stderr + readded.stdout).toBe(0);
    expect(rowFor("api")!.path).toBe(dbIn(first)); // nothing stolen either way
    expect(rowFor("api-wt")!.path).toBe(dbIn(second));

    // ...including after its row is lost, which is the case that has to re-register.
    const dropped = cli(root, ["hub", "unregister", "api-wt"]);
    expect(dropped.status, dropped.stderr).toBe(0);
    const again = cli(root, ["add", second, "--yes"]);
    expect(again.status, again.stderr + again.stdout).toBe(0);
    expect(rowFor("api-wt")!.path).toBe(dbIn(second));
    expect(rowFor("api")!.path).toBe(dbIn(first));
  }, 120_000);
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

  /**
   * A file at the registered path is not the same thing as a workspace at it.
   *
   * A stray or unreadable `staple.db` left behind by a partial move is exactly
   * what `doctor`'s `orphan-workspaces` check exists to report, and it must not
   * make the row unrepairable: a refusal here would leave `--ws` opening the
   * orphan indefinitely, with nothing to do about it, which is worse than the
   * stale row this file exists to fix. A refusal has to be earned by a database
   * that still answers to the slug.
   */
  it("re-points past a stray file that is not a workspace at all", () => {
    const before = repo("stray");
    const after = join(root, "stray-elsewhere");
    renameSync(before, after);

    mkdirSync(join(before, ".staple"), { recursive: true });
    writeFileSync(dbIn(before), "this is not a database at all\n");
    expect(existsSync(dbIn(before))).toBe(true);

    const ls = cli(after, ["ls"]);
    expect(ls.timedOut).toBe(false);
    expect(ls.status, ls.stderr).toBe(0);

    expect(rowFor("stray")!.path).toBe(dbIn(after));
    expect(doctorCheck(after, "workspace-hub-link").check.status).toBe("pass");
  }, 90_000);
});

// ------------------------------------------------------------ the classifier

/**
 * The verdict, unit by unit — and in particular the two cases that separate a
 * slug-keyed decision from an identity-keyed one:
 *
 *   - same slug, DIFFERENT ids (a forked copy) must still refuse; and
 *   - different slugs, SAME id (two clones) must still repair.
 *
 * An implementation that compared `repositoryId` gets both backwards, which is
 * exactly the pair of defects this replaces.
 */
describe("classifyRegisteredPath", () => {
  let bench: string;

  beforeAll(() => {
    bench = tempDir("sta285-bench");
  });

  afterAll(() => removeDir(bench));

  /**
   * A project root holding a workspace database stamped with a slug, plus
   * whatever identity was asked for beside it.
   *
   * **WAL, like every database staple writes.** The first version of this fixture
   * used a bare `new DatabaseSync` and so left `journal_mode = delete`, which is
   * the one dimension these cases turn on: a WAL database needs a writable `-shm`
   * in its own directory to be read at all. A non-WAL fixture made the read
   * unconditionally succeed, hid the failure mode entirely, and let a test assert
   * an invariant that is false of every real workspace.
   *
   * `meta` is written directly because it is the one table the classifier reads.
   * `slug: null` writes a file that is not a database at all.
   */
  function project(
    name: string,
    options: { slug?: string | null; id?: string; manifest?: string; legacy?: boolean } = {},
  ): string {
    const root = join(bench, name);
    const dir = join(root, options.legacy ? ".tasks" : ".staple");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, options.legacy ? "tasks.db" : "staple.db");
    const slug = options.slug === undefined ? name : options.slug;
    if (slug === null) {
      writeFileSync(dbPath, "not a database\n");
    } else {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA journal_mode=WAL");
        db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        db.prepare("INSERT INTO meta (key, value) VALUES ('slug', ?)").run(slug);
      } finally {
        db.close();
      }
    }
    const manifest =
      options.manifest ?? (options.id ? `{\n  "repositoryId": "${options.id}",\n  "format": 1\n}\n` : null);
    if (manifest !== null) writeFileSync(join(dir, "repository.json"), manifest);
    return dbPath;
  }

  const ID_A = "11111111-2222-4333-8444-555555555555";
  const ID_B = "99999999-8888-4777-8666-555555555555";

  it("calls a registered path that no longer exists vacated", () => {
    const opened = project("v-opened", { slug: "twin", id: ID_A });
    const verdict = classifyRegisteredPath(join(bench, "gone", ".staple", "staple.db"), opened, "twin");
    expect(verdict.kind).toBe("vacated");
    expect(isSecondClaimant(verdict)).toBe(false);
  });

  it("reports a live database still stamped with the row's slug, and names the shared id", () => {
    const registered = project("s-original", { slug: "twin", id: ID_A });
    const opened = project("s-copy", { slug: "twin", id: ID_A });
    const verdict = classifyRegisteredPath(registered, opened, "twin");
    expect(verdict).toEqual({ kind: "same-workspace", slug: "twin", sharedRepositoryId: ID_A });
    expect(isSecondClaimant(verdict)).toBe(true);
  });

  /**
   * The forked copy. `staple cloud fork-id` changes the id and leaves the slug
   * alone, so an id comparison called this a move and re-pointed — the
   * oscillation, re-entered by following the advice the refusal printed.
   */
  it("still reports a copy whose identity has been forked away", () => {
    const registered = project("f-original", { slug: "twin", id: ID_A });
    const opened = project("f-forked", { slug: "twin", id: ID_B });
    const verdict = classifyRegisteredPath(registered, opened, "twin");
    expect(verdict.kind).toBe("same-workspace");
    expect(isSecondClaimant(verdict)).toBe(true);
    // Nothing shared to report, and the message must not invent one.
    expect(verdict).toEqual({ kind: "same-workspace", slug: "twin", sharedRepositoryId: null });
  });

  /**
   * The second clone. `.staple/repository.json` is committed on purpose, so two
   * checkouts share an id by design; each carries its own slug, and the row
   * belongs to whichever one is stamped with it.
   */
  it("repairs past a different workspace that shares the identity, as two clones do", () => {
    const registered = project("c-clone", { slug: "api-wt", id: ID_A });
    const opened = project("c-origin", { slug: "api", id: ID_A });
    const verdict = classifyRegisteredPath(registered, opened, "api");
    expect(verdict).toEqual({ kind: "other-workspace", slug: "api-wt" });
    expect(isSecondClaimant(verdict)).toBe(false);
  });

  it("repairs past an unrelated workspace that moved into the old directory", () => {
    const registered = project("o-newcomer", { slug: "newcomer", id: ID_B });
    const opened = project("o-moved", { slug: "moved", id: ID_A });
    const verdict = classifyRegisteredPath(registered, opened, "moved");
    expect(verdict.kind).toBe("other-workspace");
    expect(isSecondClaimant(verdict)).toBe(false);
  });

  /**
   * A refusal has to be earned. A file that is not a workspace database is not
   * evidence that this workspace is there, and refusing on it would leave the row
   * permanently unrepairable and `--ws` pointing at the stray file for good.
   */
  it("repairs past a file that is not a workspace database", () => {
    const registered = project("n-stray", { slug: null });
    const opened = project("n-opened", { slug: "moved", id: ID_A });
    const verdict = classifyRegisteredPath(registered, opened, "moved");
    expect(verdict.kind).toBe("not-a-workspace");
    expect(isSecondClaimant(verdict)).toBe(false);
  });

  it("repairs past a workspace database that records no slug", () => {
    const registered = project("e-noslug", { slug: "" });
    const opened = project("e-opened", { slug: "moved" });
    // An empty slug matches no row, so it is somebody else's problem, not a rival.
    expect(isSecondClaimant(classifyRegisteredPath(registered, opened, "moved"))).toBe(false);
  });

  /**
   * One project root cannot be a copy of itself. The legacy layout is where a
   * single project legitimately owns two database paths, so `same-project` is
   * what stops a row still naming `.tasks/tasks.db` from being read as a rival
   * claimant to the `.staple/staple.db` beside it — and it is decided by path
   * arithmetic, before anything is opened or read.
   */
  it("calls two layouts of one project the same project", () => {
    const root = join(bench, "two-layouts");
    mkdirSync(join(root, ".tasks"), { recursive: true });
    mkdirSync(join(root, ".staple"), { recursive: true });
    writeFileSync(join(root, ".tasks", "tasks.db"), "not a database\n");
    writeFileSync(join(root, ".staple", "staple.db"), "not a database\n");
    const verdict = classifyRegisteredPath(
      join(root, ".tasks", "tasks.db"),
      join(root, ".staple", "staple.db"),
      "whatever",
    );
    expect(verdict.kind).toBe("same-project");
    expect(isSecondClaimant(verdict)).toBe(false);
  });

  /**
   * A hand-broken manifest is reported, never thrown. `doctor` calls this from
   * inside a check, and a check that threw would say only that a check threw.
   * The verdict is unaffected — the manifest is evidence, not the decision.
   */
  it("does not throw on an unparseable manifest, and still decides on the slug", () => {
    const registered = project("u-broken", { slug: "twin", manifest: "{ not json at all" });
    const opened = project("u-opened", { slug: "twin", id: ID_A });
    expect(() => classifyRegisteredPath(registered, opened, "twin")).not.toThrow();
    const verdict = classifyRegisteredPath(registered, opened, "twin");
    expect(verdict).toEqual({ kind: "same-workspace", slug: "twin", sharedRepositoryId: null });
  });

  /**
   * A path that cannot be read is its own answer, and it must refuse.
   *
   * A directory where the database should be, because that is an open failure for
   * every uid INCLUDING root — the permission-based reproduction below is the real
   * scenario but is meaningless when the suite runs as root, and this branch has to
   * be covered either way.
   */
  it("refuses when the registered path cannot be read at all", () => {
    const registered = join(bench, "u-unreadable", ".staple", "staple.db");
    mkdirSync(registered, { recursive: true });
    const opened = project("u-live", { slug: "twin", id: ID_A });
    const verdict = classifyRegisteredPath(registered, opened, "twin");
    expect(verdict.kind).toBe("unreadable");
    expect(isSecondClaimant(verdict)).toBe(true);
    // The reason is carried, because "could not read it" is useless without it.
    expect(verdict.kind === "unreadable" && verdict.reason.length > 0).toBe(true);
  });

  /**
   * The reproduction, at unit level: a real WAL database whose directory is not
   * writable. SQLite cannot create the `-shm` it needs, the read-only open fails
   * with `attempt to write a readonly database`, and the FIRST version called that
   * "not a workspace" and re-pointed the row — STA-285, re-created for the exact
   * workflow that produces copies (freeze the original, work in a copy).
   *
   * Skipped as root, where the permission does not bite; the case above keeps the
   * branch covered there.
   */
  it.skipIf(process.getuid?.() === 0)("refuses a live WAL database in a frozen directory", () => {
    const registered = project("w-frozen", { slug: "twin", id: ID_A });
    const opened = project("w-copy", { slug: "twin", id: ID_A });
    // First contact: a `-shm` left by an earlier reader makes the open succeed, so
    // the fixture must start from rest, which is how a copied directory arrives.
    for (const sidecar of ["-wal", "-shm"]) rmSync(`${registered}${sidecar}`, { force: true });
    chmodSync(dirname(registered), 0o500);
    try {
      const verdict = classifyRegisteredPath(registered, opened, "twin");
      expect(verdict.kind).toBe("unreadable");
      expect(isSecondClaimant(verdict)).toBe(true);
    } finally {
      chmodSync(dirname(registered), 0o700);
    }
  });

  /**
   * Read-only means the database's CONTENT is safe. It does NOT mean the directory
   * is untouched: reading a WAL database creates `-shm` beside it, which is how a
   * WAL database is read at all.
   *
   * The previous version of this test asserted those sidecars were absent and
   * passed only because its fixture was not WAL — a fixture differing from the real
   * thing in precisely the dimension under test. What is asserted now is the thing
   * that actually matters, and it is asserted against a WAL database.
   */
  it("cannot change the registered database, though reading it may add a -shm", () => {
    const registered = project("r-original", { slug: "twin", id: ID_A });
    const opened = project("r-copy", { slug: "twin", id: ID_A });
    const before = statSync(registered);

    classifyRegisteredPath(registered, opened, "twin");

    const after = statSync(registered);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    // And the row is still what it was, read through a fresh handle.
    const db = new DatabaseSync(registered, { readOnly: true });
    try {
      expect(db.prepare("SELECT value FROM meta WHERE key = 'slug'").get()).toEqual({ value: "twin" });
    } finally {
      db.close();
    }
  });
});
