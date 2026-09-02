/**
 * A9 (STA-39) — `staple add <path>` and `staple discover <root>`.
 *
 * STA-39's six acceptance criteria, and where each is proven:
 *
 *   | Add previews project mutations before applying them | `add previews`      |
 *   | Discover never scans outside the supplied root      | `the root boundary` |
 *   | Discover skips directory symlinks by default        | `the root boundary` |
 *   | Unreadable directories do not abort the full scan   | `hostile trees`     |
 *   | Discovery preview performs no registrations         | `preview is inert`  |
 *   | Headless registration requires a selection policy   | `the three gates`   |
 *
 * Plus A5's handoff requirement, which is not in the criteria and matters most:
 * "NEVER register an ambiguous directory."
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { diskTree, removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

let home: string;
let root: string;
/** Somewhere to stand that is not inside any scanned tree. */
let elsewhere: string;

beforeAll(() => {
  home = tempDir("a9-home");
  root = tempDir("a9-root");
  elsewhere = tempDir("a9-elsewhere");
});

afterAll(() => {
  removeDir(home);
  removeDir(root);
  removeDir(elsewhere);
});

function cli(args: string[], hubHome = home, cwd = elsewhere) {
  return runCliAt(cwd, args, { STAPLE_HOME: hubHome }, 30_000);
}

/** A workspace created against a THROWAWAY hub, so `home` has never heard of it. */
function orphanWorkspace(dir: string, slug?: string): string {
  mkdirSync(dir, { recursive: true });
  const scratch = tempDir("a9-scratch-home");
  const args = slug ? ["init", "--slug", slug] : ["init"];
  expect(runCliAt(dir, args, { STAPLE_HOME: scratch }, 30_000).status).toBe(0);
  removeDir(scratch);
  return dir;
}

/** The same, in the pre-migration `.tasks/tasks.db` layout. */
function legacyOrphan(dir: string, slug: string): string {
  const seed = orphanWorkspace(join(root, `${slug}-seed`), slug);
  mkdirSync(join(dir, ".tasks"), { recursive: true });
  copyFileSync(join(seed, ".staple", "staple.db"), join(dir, ".tasks", "tasks.db"));
  removeDir(seed);
  return dir;
}

function hubSlugs(hubHome = home): string[] {
  const path = join(hubHome, "hub.db");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT slug FROM workspaces ORDER BY slug").all() as Array<{ slug: string }>).map(
      (r) => r.slug,
    );
  } finally {
    db.close();
  }
}

interface DiscoverJson {
  root: string;
  scannedDirs: number;
  truncated: boolean;
  previewOnly: boolean;
  candidates: Array<{
    dir: string;
    slug: string | null;
    state: string;
    registrable: boolean;
    layout: string | null;
    reason: string;
  }>;
  denied: Array<{ path: string; reason: string }>;
  skipped: Array<{ path: string; reason: string }>;
  registered: Array<{ slug: string; outcome: string }>;
}

function discover(args: string[], hubHome = home): DiscoverJson {
  const result = cli(["discover", ...args, "--json"], hubHome);
  return JSON.parse(result.stdout.trim()) as DiscoverJson;
}

// ------------------------------------------------------------------- `add`

describe("`staple add <path>` previews before it applies", () => {
  it("refuses without --yes, lists every change, and writes nothing", () => {
    const dir = join(root, "add-preview");
    mkdirSync(dir, { recursive: true });
    const before = diskTree(dir);

    const result = cli(["add", dir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`Refusing to change ${dir} without --yes`);
    // Every mutation named, including the two files and the hub row.
    expect(result.stderr).toContain(join(dir, ".staple", "staple.db"));
    expect(result.stderr).toContain("AGENTS.md");
    expect(result.stderr).toContain(".gitignore");
    expect(result.stderr).toContain("register the workspace in the hub");

    expect(diskTree(dir)).toEqual(before);
    expect(hubSlugs()).not.toContain("add-preview");
  }, 40_000);

  it("the refusal carries the preview as --json detail, not a second command", () => {
    const dir = join(root, "add-json-preview");
    mkdirSync(dir, { recursive: true });
    const result = cli(["add", dir, "--json"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as {
      code: string;
      detail: { path: string; action: string; changes: string[]; confirmWith: string };
    };
    expect(envelope.code).toBe("validation");
    expect(envelope.detail.action).toBe("create");
    expect(envelope.detail.path).toBe(dir);
    expect(envelope.detail.changes.length).toBeGreaterThan(2);
    expect(envelope.detail.confirmWith).toBe(`staple add ${dir} --yes`);
  }, 40_000);

  it("--yes creates and registers exactly one project", () => {
    const dir = join(root, "add-applied");
    mkdirSync(dir, { recursive: true });

    const result = cli(["add", dir, "--yes", "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(report.slug).toBe("add-applied");
    expect(report.created).toBe(true);
    expect(report.path).toBe(dir);
    expect(existsSync(join(dir, ".staple", "staple.db"))).toBe(true);
    expect(hubSlugs()).toContain("add-applied");
  }, 40_000);

  /** Plan §4: "A path already registered returns success after refreshing `last_seen_at`." */
  it("an already-registered path succeeds without --yes and changes nothing", () => {
    const dir = join(root, "add-idempotent");
    mkdirSync(dir, { recursive: true });
    expect(cli(["add", dir, "--yes"]).status).toBe(0);
    const after = diskTree(dir).filter((e) => !/\.db-(wal|shm) \d+$/.test(e));

    const again = cli(["add", dir]); // no --yes at all
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("is already registered");
    expect(diskTree(dir).filter((e) => !/\.db-(wal|shm) \d+$/.test(e))).toEqual(after);
  }, 40_000);

  it("names one project and never scans: a workspace in a subdirectory is not touched", () => {
    const outer = join(root, "add-outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    orphanWorkspace(inner, "add-inner");

    expect(cli(["add", outer, "--yes"]).status).toBe(0);
    expect(hubSlugs()).toContain("add-outer");
    expect(hubSlugs()).not.toContain("add-inner");
  }, 40_000);

  it("refuses an ambiguous project with exit 4, before writing anything", () => {
    const dir = legacyOrphan(join(root, "add-ambiguous"), "addambig");
    mkdirSync(join(dir, ".staple"), { recursive: true });
    copyFileSync(join(dir, ".tasks", "tasks.db"), join(dir, ".staple", "staple.db"));
    const before = diskTree(dir);

    const result = cli(["add", dir, "--yes"]);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("Ambiguous workspace");
    expect(diskTree(dir)).toEqual(before);
  }, 40_000);

  it("requires a path", () => {
    const result = cli(["add"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: staple add <path>");
    expect(result.stderr).toContain("never scans");
  }, 30_000);

  it("reports a path that is not there rather than creating it", () => {
    const result = cli(["add", join(root, "does-not-exist"), "--yes"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("No such directory");
    expect(existsSync(join(root, "does-not-exist"))).toBe(false);
  }, 30_000);
});

// -------------------------------------------------------------- `discover`

describe("the root boundary", () => {
  /**
   * STA-39: "Discover never scans outside the supplied root."
   *
   * The trap, and the reason the boundary is enforced on realpaths rather than
   * on string prefixes: a symlink INSIDE the root pointing OUT of it makes every
   * path on the machine look like it is beneath the root.
   */
  it("does not follow a symlink that escapes the root, and says it skipped it", () => {
    const outside = join(root, "boundary-outside");
    orphanWorkspace(outside, "boundary-outside");

    const scanned = join(root, "boundary-root");
    mkdirSync(scanned, { recursive: true });
    orphanWorkspace(join(scanned, "inside"), "boundary-inside");
    symlinkSync(outside, join(scanned, "escape-hatch"));

    const report = discover([scanned]);
    const slugs = report.candidates.map((c) => c.slug);
    expect(slugs).toContain("boundary-inside");
    expect(slugs).not.toContain("boundary-outside");
    expect(report.skipped.some((s) => s.path.endsWith("escape-hatch") && s.reason === "symlink")).toBe(true);
  }, 60_000);

  /** STA-39: "Discover skips directory symlinks by default." */
  it("skips an internal directory symlink too, unless --follow-symlinks", () => {
    const scanned = join(root, "symlink-root");
    const real = join(scanned, "real");
    mkdirSync(real, { recursive: true });
    orphanWorkspace(join(real, "project"), "symlinked-project");
    symlinkSync(real, join(scanned, "alias"));

    const plain = discover([scanned]);
    // Found exactly once, through the real path — not twice through the alias.
    expect(plain.candidates.filter((c) => c.slug === "symlinked-project")).toHaveLength(1);
    expect(plain.skipped.some((s) => s.reason === "symlink")).toBe(true);

    // With --follow-symlinks the alias IS entered, and the visited set stops it
    // from reporting the same directory a second time.
    const followed = discover([scanned, "--follow-symlinks"]);
    expect(followed.candidates.filter((c) => c.slug === "symlinked-project")).toHaveLength(1);
  }, 60_000);

  /**
   * A symlink loop. Without the visited set this walks forever; with it, the
   * scan terminates and records why.
   */
  it("terminates on a symlink loop instead of spinning", () => {
    const scanned = join(root, "loop-root");
    const inner = join(scanned, "inner");
    mkdirSync(inner, { recursive: true });
    symlinkSync(scanned, join(inner, "back-to-top"));
    orphanWorkspace(join(inner, "loopproject"), "loopproject");

    const result = cli(["discover", scanned, "--follow-symlinks", "--json"]);
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as DiscoverJson;
    expect(report.candidates.map((c) => c.slug)).toContain("loopproject");
  }, 60_000);

  it("stops at --depth and says the scan was truncated", () => {
    const scanned = join(root, "depth-root");
    const deep = join(scanned, "a", "b", "c", "d");
    mkdirSync(deep, { recursive: true });
    orphanWorkspace(deep, "deepproject");

    const shallow = discover([scanned, "--depth", "2"]);
    expect(shallow.candidates.map((c) => c.slug)).not.toContain("deepproject");
    expect(shallow.truncated).toBe(true);

    const full = discover([scanned, "--depth", "6"]);
    expect(full.candidates.map((c) => c.slug)).toContain("deepproject");
  }, 60_000);

  it("requires a root and never defaults to one", () => {
    const result = cli(["discover"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("The root is required and is never defaulted");
    expect(result.stderr).toContain("does not scan your home directory");
  }, 30_000);

  it("skips generated directories", () => {
    const scanned = join(root, "generated-root");
    mkdirSync(join(scanned, "node_modules"), { recursive: true });
    orphanWorkspace(join(scanned, "node_modules", "buried"), "buried-project");
    orphanWorkspace(join(scanned, "visible"), "visible-project");

    const report = discover([scanned]);
    const slugs = report.candidates.map((c) => c.slug);
    expect(slugs).toContain("visible-project");
    expect(slugs).not.toContain("buried-project");
    expect(report.skipped.some((s) => s.path.endsWith("node_modules") && s.reason === "generated")).toBe(true);
  }, 60_000);
});

describe("hostile trees", () => {
  /** STA-39: "Unreadable directories do not abort the full scan." */
  it("reports a directory it cannot read and keeps going", () => {
    const scanned = join(root, "denied-root");
    const locked = join(scanned, "locked");
    mkdirSync(locked, { recursive: true });
    orphanWorkspace(join(scanned, "readable"), "readable-project");
    chmodSync(locked, 0o000);

    try {
      const result = cli(["discover", scanned, "--json"]);
      expect(result.status).toBe(0); // NOT a failure
      const report = JSON.parse(result.stdout.trim()) as DiscoverJson;
      expect(report.candidates.map((c) => c.slug)).toContain("readable-project");
      expect(report.denied.some((d) => d.path === locked)).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
  }, 60_000);

  it("reports an unreadable database as a candidate that cannot be registered", () => {
    const scanned = join(root, "corrupt-root");
    const broken = join(scanned, "broken");
    mkdirSync(join(broken, ".staple"), { recursive: true });
    writeFileSync(join(broken, ".staple", "staple.db"), "not a database\n");

    const report = discover([scanned]);
    const candidate = report.candidates.find((c) => c.dir === broken)!;
    expect(candidate.registrable).toBe(false);
    expect(candidate.state).toBe("unreadable");
    expect(hubSlugs()).not.toContain(null);
  }, 60_000);
});

describe("both layouts, and the one directory it must never register", () => {
  /** A5: discovery "must scan for BOTH layouts — `.staple/staple.db` and legacy `.tasks/tasks.db`". */
  it("finds a legacy .tasks workspace and marks it as such", () => {
    const scanned = join(root, "layouts-root");
    mkdirSync(scanned, { recursive: true });
    orphanWorkspace(join(scanned, "modern"), "modern-project");
    legacyOrphan(join(scanned, "ancient"), "ancient-project");

    const report = discover([scanned]);
    const modern = report.candidates.find((c) => c.slug === "modern-project")!;
    const ancient = report.candidates.find((c) => c.slug === "ancient-project")!;
    expect(modern.layout).toBe("current");
    expect(ancient.layout).toBe("legacy");
    // Legacy is registrable — the compatibility window is open, and registering
    // it is not the same as migrating it.
    expect(ancient.registrable).toBe(true);
  }, 60_000);

  /**
   * A5's handoff, verbatim: "NEVER register an ambiguous directory — that is the
   * forked workspace the whole epic is about, and the hub can only hold one path
   * per slug, so registering one silently picks a winner. Report it as a conflict
   * candidate instead and let the operator resolve it."
   */
  it("reports an ambiguous directory and refuses to register it, even with --all-found", () => {
    const scanned = join(root, "ambiguous-root");
    const forked = join(scanned, "forked");
    legacyOrphan(forked, "forked-project");
    mkdirSync(join(forked, ".staple"), { recursive: true });
    copyFileSync(join(forked, ".tasks", "tasks.db"), join(forked, ".staple", "staple.db"));
    orphanWorkspace(join(scanned, "fine"), "fine-project");

    const preview = discover([scanned]);
    const candidate = preview.candidates.find((c) => c.dir === forked)!;
    expect(candidate.state).toBe("ambiguous");
    expect(candidate.registrable).toBe(false);
    expect(candidate.reason).toContain("silently pick a winner");

    const applied = discover([scanned, "--all-found", "--yes"]);
    expect(applied.registered.map((r) => r.slug)).toEqual(["fine-project"]);
    expect(hubSlugs()).not.toContain("forked-project");
  }, 60_000);

  it("--select naming an ambiguous directory is a loud error, not a silent skip", () => {
    const scanned = join(root, "select-ambiguous");
    const forked = join(scanned, "forked2");
    legacyOrphan(forked, "forked2-project");
    mkdirSync(join(forked, ".staple"), { recursive: true });
    copyFileSync(join(forked, ".tasks", "tasks.db"), join(forked, ".staple", "staple.db"));

    const result = cli(["discover", scanned, "--select", forked, "--yes"]);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("cannot be registered");
    expect(hubSlugs()).not.toContain("forked2-project");
  }, 60_000);

  it("reports a crashed migration rather than registering through it", () => {
    const scanned = join(root, "journal-root");
    const crashed = join(scanned, "crashed");
    orphanWorkspace(crashed, "crashed-project");
    writeFileSync(
      join(crashed, ".staple", "migration.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        migrationId: "abc123abc123",
        state: "snapshotted",
        sourcePath: join(crashed, ".tasks", "tasks.db"),
        targetPath: join(crashed, ".staple", "staple.db"),
        snapshotPath: "",
        backupPath: "",
        source: { slug: "crashed-project", prefix: "CRA", schemaVersion: 2, identity: { dev: 1, ino: 1 }, rowCounts: {} },
        snapshotSha256: null,
        hub: { pathBefore: null, pathAfter: null, error: null },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      })}\n`,
      "utf8",
    );
    // The journal is only consulted when BOTH paths exist, so give it both.
    mkdirSync(join(crashed, ".tasks"), { recursive: true });
    copyFileSync(join(crashed, ".staple", "staple.db"), join(crashed, ".tasks", "tasks.db"));

    const report = discover([scanned]);
    const candidate = report.candidates.find((c) => c.dir === crashed)!;
    expect(candidate.registrable).toBe(false);
    expect(["in-migration", "ambiguous"]).toContain(candidate.state);
  }, 60_000);
});

describe("preview is inert", () => {
  /** STA-39: "Discovery preview performs no registrations." */
  it("a bare discover registers nothing, whatever it finds", () => {
    const previewHome = tempDir("a9-preview-home");
    const scanned = join(root, "inert-root");
    mkdirSync(scanned, { recursive: true });
    orphanWorkspace(join(scanned, "one"), "inert-one");
    orphanWorkspace(join(scanned, "two"), "inert-two");
    // A hub that exists but is empty, so "registered nothing" is observable.
    expect(runCliAt(elsewhere, ["hub", "ls"], { STAPLE_HOME: previewHome }, 30_000).status).toBe(0);
    const before = hubSlugs(previewHome);

    const report = discover([scanned], previewHome);
    expect(report.previewOnly).toBe(true);
    expect(report.candidates).toHaveLength(2);
    expect(report.candidates.every((c) => c.registrable)).toBe(true);
    expect(report.registered).toEqual([]);
    expect(hubSlugs(previewHome)).toEqual(before);

    removeDir(previewHome);
  }, 60_000);

  it("the human preview names both ways to confirm and says nothing was written", () => {
    const scanned = join(root, "inert-human");
    mkdirSync(scanned, { recursive: true });
    orphanWorkspace(join(scanned, "shown"), "shown-project");

    const result = cli(["discover", scanned]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Nothing has been written.");
    expect(result.stdout).toContain("--all-found --yes");
    expect(result.stdout).toContain("--select shown-project --yes");
  }, 60_000);
});

describe("the three gates on registration", () => {
  /** STA-39: "Headless registration requires an explicit selection policy." */
  it("--yes alone is refused, because yes to what", () => {
    const scanned = join(root, "gate-root");
    mkdirSync(scanned, { recursive: true });
    orphanWorkspace(join(scanned, "gated"), "gated-project");

    const result = cli(["discover", scanned, "--yes"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--yes says yes, but not to what");
    expect(result.stderr).toContain("--all-found");
    expect(result.stderr).toContain("--select");
    expect(hubSlugs()).not.toContain("gated-project");
  }, 60_000);

  it("a selection without --yes is refused too", () => {
    const scanned = join(root, "gate-noyes");
    mkdirSync(scanned, { recursive: true });
    orphanWorkspace(join(scanned, "unconsented"), "unconsented-project");

    const result = cli(["discover", scanned, "--all-found"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Refusing to write hub registrations without --yes");
    expect(hubSlugs()).not.toContain("unconsented-project");
  }, 60_000);

  it("--all-found and --select together are refused rather than merged", () => {
    const scanned = join(root, "gate-both");
    mkdirSync(scanned, { recursive: true });
    const result = cli(["discover", scanned, "--all-found", "--select", "x", "--yes"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("contradict each other");
  }, 40_000);

  it("--select naming something the scan never saw is an error, not an empty run", () => {
    const scanned = join(root, "gate-missing");
    mkdirSync(scanned, { recursive: true });
    orphanWorkspace(join(scanned, "present"), "present-project");

    const result = cli(["discover", scanned, "--select", "present-project,ghost-project", "--yes"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('--select named "ghost-project"');
    // …and it registered NEITHER: the selection is resolved before anything writes.
    expect(hubSlugs()).not.toContain("present-project");
  }, 60_000);

  it("all three together register exactly the selected projects, and only hub rows", () => {
    const scanned = join(root, "gate-applied");
    mkdirSync(scanned, { recursive: true });
    const a = orphanWorkspace(join(scanned, "alpha"), "gate-alpha");
    orphanWorkspace(join(scanned, "beta"), "gate-beta");
    const treeBefore = diskTree(a);

    const report = discover([scanned, "--select", "gate-alpha", "--yes"]);
    expect(report.previewOnly).toBe(false);
    expect(report.registered.map((r) => r.slug)).toEqual(["gate-alpha"]);
    expect(hubSlugs()).toContain("gate-alpha");
    expect(hubSlugs()).not.toContain("gate-beta");

    // "Selected hub registrations only" — the project on disk is untouched.
    expect(diskTree(a).filter((e) => !/\.db-(wal|shm) \d+$/.test(e))).toEqual(
      treeBefore.filter((e) => !/\.db-(wal|shm) \d+$/.test(e)),
    );
  }, 60_000);

  /**
   * Plan §4: discover "never initializes discovered Git repositories". A plain
   * directory — even one that looks like a project — is not a candidate and is
   * not created into one.
   */
  it("never initializes a directory that has no workspace", () => {
    const scanned = join(root, "noinit-root");
    const plain = join(scanned, "just-a-repo");
    mkdirSync(join(plain, ".git"), { recursive: true });
    writeFileSync(join(plain, "package.json"), "{}\n");

    const report = discover([scanned, "--all-found", "--yes"]);
    expect(report.candidates).toHaveLength(0);
    expect(report.registered).toEqual([]);
    expect(existsSync(join(plain, ".staple"))).toBe(false);
    expect(existsSync(join(plain, ".tasks"))).toBe(false);
  }, 60_000);

  /** Registering a MOVED project repoints its row rather than duplicating it. */
  it("repoints a workspace the hub knows at a different path", () => {
    const movedHome = tempDir("a9-moved-home");
    const original = join(root, "moved-original");
    mkdirSync(original, { recursive: true });
    expect(runCliAt(original, ["init"], { STAPLE_HOME: movedHome }, 30_000).status).toBe(0);

    const scanned = join(root, "moved-root");
    mkdirSync(scanned, { recursive: true });
    const relocated = join(scanned, "moved-original");
    mkdirSync(relocated, { recursive: true });
    mkdirSync(join(relocated, ".staple"), { recursive: true });
    copyFileSync(join(original, ".staple", "staple.db"), join(relocated, ".staple", "staple.db"));
    removeDir(original);

    const preview = discover([scanned], movedHome);
    const candidate = preview.candidates.find((c) => c.slug === "moved-original")!;
    expect(candidate.state).toBe("moved");
    expect(candidate.registrable).toBe(true);

    const applied = discover([scanned, "--all-found", "--yes"], movedHome);
    expect(applied.registered[0]!.outcome).toBe("repointed");
    expect(hubSlugs(movedHome)).toEqual(["moved-original"]); // one row, not two
    removeDir(movedHome);
  }, 60_000);
});
