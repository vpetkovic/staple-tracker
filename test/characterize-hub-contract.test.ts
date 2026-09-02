/**
 * A1 — the HUB REGISTRATION contract, frozen before A5 and A7.
 *
 * `hub.test.ts` covers the hub as a library: prefix suffix disambiguation,
 * cross-links, unified views. What it does not cover is the hub as a PRODUCT
 * surface — what `staple init` writes into the registry as a side effect, what
 * order prefixes come out in, what happens to a row whose file has moved or been
 * deleted, and what `staple hub ls` prints about it.
 *
 * A5 moves a workspace file and has to repair its hub row. A7 adds an
 * "idempotent hub repair" plus a doctor check for "hub path and prefix
 * consistency". Both need the current behaviour written down, including the
 * parts that are currently missing entirely — a stale row today is repaired by
 * nothing and reported by nobody.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

interface HubRow {
  slug: string;
  prefix: string;
  path: string;
  kind: string;
  addedAt: string;
  lastSeenAt: string | null;
  available: boolean;
}

let home: string;
let root: string;

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  return runCliAt(cwd, args, { STAPLE_HOME: home, STAPLE_AGENT: "char-hub", ...env });
}

function hubList(homeDir = home): HubRow[] {
  const result = runCliAt(root, ["hub", "ls", "--json"], { STAPLE_HOME: homeDir });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as HubRow[];
}

beforeAll(() => {
  home = tempDir("char-hub-home");
  root = tempDir("char-hub-root");
});

afterAll(() => {
  removeDir(home);
  removeDir(root);
});

// ------------------------------------------------------- init's registry effect

describe("what `init` writes into the hub", () => {
  it("registers one row with every field populated, kind=repo, and last_seen_at set", () => {
    const project = join(root, "hubrepo");
    mkdirSync(project, { recursive: true });
    expect(cli(project, ["init"]).status).toBe(0);

    const row = hubList().find((w) => w.slug === "hubrepo")!;
    expect(row.prefix).toBe("HUB");
    expect(row.kind).toBe("repo");
    expect(row.path).toBe(join(project, ".staple", "staple.db"));
    expect(row.available).toBe(true);
    // Both timestamps are written on the same insert, so a never-reopened
    // workspace still reports a last_seen_at rather than null.
    expect(row.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }, 30_000);

  it("pins the hub row field set, so an added or renamed column is a diff", () => {
    const row = hubList().find((w) => w.slug === "hubrepo")!;
    expect(Object.keys(row).sort()).toEqual([
      "addedAt", "available", "kind", "lastSeenAt", "path", "prefix", "slug",
    ]);
  });

  /**
   * A re-init refreshes `path` and `last_seen_at` and keeps `prefix` and
   * `added_at`. This is the ONLY repair path that exists today: nothing else in
   * the product ever updates a hub row's path, which is what A7's idempotent
   * repair-on-open is for.
   */
  it("re-init refreshes path and last_seen_at while keeping prefix and added_at", async () => {
    const before = hubList().find((w) => w.slug === "hubrepo")!;
    await new Promise((r) => setTimeout(r, 5));
    expect(cli(join(root, "hubrepo"), ["init"]).status).toBe(0);
    const after = hubList().find((w) => w.slug === "hubrepo")!;

    expect(after.prefix).toBe(before.prefix);
    expect(after.addedAt).toBe(before.addedAt);
    expect(after.lastSeenAt! > before.lastSeenAt!).toBe(true);
  }, 30_000);
});

// -------------------------------------------------------- prefix allocation

describe("prefix allocation", () => {
  it("pins the derive-then-suffix order, including the collision ladder", () => {
    const allocHome = tempDir("char-hub-alloc");
    const alloc = (slug: string) => {
      const result = runCliAt(root, ["init", "--global", slug], { STAPLE_HOME: allocHome });
      expect(result.status, slug).toBe(0);
      return /\(prefix ([A-Z]+)\)/.exec(result.stdout)?.[1];
    };

    // First three LETTERS of the slug, uppercased; non-letters are dropped
    // before the slice, so "al-pha-x" derives from "ALPHAX".
    expect(alloc("alpha")).toBe("ALP");
    // Collisions append one "A" per failed attempt: ALP -> ALPA -> ALPAA…
    expect(alloc("alpine")).toBe("ALPA");
    expect(alloc("al-pha-x")).toBe("ALPAA");
    // …which means allocation is ORDER-DEPENDENT and machine-global. The same
    // repository initialized on two machines can carry two different prefixes,
    // and here "alp" — whose natural prefix is ALP — ends up four suffixes deep
    // purely because three other workspaces were registered first.
    expect(alloc("alp")).toBe("ALPAAA");
    // A slug with no letters at all falls back to PREFIX_FALLBACK.
    expect(alloc("123")).toBe("WS");
    removeDir(allocHome);
  }, 60_000);

  it("`hub ls` orders by slug, not by prefix or registration time", () => {
    const orderHome = tempDir("char-hub-order");
    for (const slug of ["zulu", "alpha", "mike"]) {
      expect(runCliAt(root, ["init", "--global", slug], { STAPLE_HOME: orderHome }).status).toBe(0);
    }
    expect(hubList(orderHome).map((w) => w.slug)).toEqual(["alpha", "mike", "zulu"]);
    removeDir(orderHome);
  }, 40_000);

  it("refuses to re-register a slug under a different prefix", () => {
    // Two DIFFERENT directories with the same basename slugify identically, so
    // the second init hits the slug that the first one owns.
    const conflictHome = tempDir("char-hub-conflict");
    const a = join(root, "one", "samename");
    const b = join(root, "two", "samename");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    expect(runCliAt(a, ["init"], { STAPLE_HOME: conflictHome }).status).toBe(0);

    // QUIRK (A7/A9): the SECOND directory succeeds. Its fresh database has no
    // prefix yet, so init allocates a NEW one (SAMA), then `register` sees the
    // slug already held with prefix SAM and throws conflict — AFTER the second
    // database has already been created and stamped on disk. A failed init
    // therefore leaves a real, unregistered workspace behind.
    const second = runCliAt(b, ["init"], { STAPLE_HOME: conflictHome });
    expect(second.status).toBe(4);
    expect(second.stderr).toContain("error(conflict):");
    expect(second.stderr).toContain('Workspace "samename" is registered with prefix SAM, not SAMA');

    const rows = hubList(conflictHome);
    expect(rows.map((w) => w.slug)).toEqual(["samename"]);
    expect(rows[0]!.path).toBe(join(a, ".staple", "staple.db"));
    removeDir(conflictHome);
  }, 40_000);
});

// ------------------------------------------------------------- availability

describe("availability of a registered workspace", () => {
  it("flips `available` to false and prints MISSING when the file is gone", () => {
    const gone = tempDir("char-hub-gone");
    expect(runCliAt(root, ["init", "--global", "vanishing"], { STAPLE_HOME: gone }).status).toBe(0);
    rmSync(join(gone, "workspaces", "vanishing.db"));

    expect(hubList(gone)[0]!.available).toBe(false);
    const human = runCliAt(root, ["hub", "ls"], { STAPLE_HOME: gone }).stdout;
    expect(human).toContain("MISSING");
    // QUIRK (A7): the availability token is the ONLY unpadded column. "MISSING"
    // is 7 characters where "available" is 9, so the path column shifts left by
    // two on exactly the rows a human is scanning for. Pinned as-is.
    expect(human).toBe(
      `VAN    vanishing            global  MISSING  ${join(gone, "workspaces", "vanishing.db")}\n`,
    );
    removeDir(gone);
  }, 40_000);

  it("keeps the stale row and reports not_found when the missing workspace is opened", () => {
    const gone = tempDir("char-hub-gone2");
    expect(runCliAt(root, ["init", "--global", "vanishing"], { STAPLE_HOME: gone }).status).toBe(0);
    const dbPath = join(gone, "workspaces", "vanishing.db");
    rmSync(dbPath);

    const result = runCliAt(root, ["ls", "--ws", "vanishing"], { STAPLE_HOME: gone });
    expect(result.status).toBe(3);
    expect(result.stderr).toBe(
      `error(not_found): No workspace at ${dbPath}. ` +
        "Run `staple init` in the repo (or `staple init --global <slug>`).\n",
    );
    // The row survives the failed open: nothing prunes or repairs the registry.
    expect(hubList(gone).map((w) => w.slug)).toEqual(["vanishing"]);
    removeDir(gone);
  }, 40_000);

  /**
   * INVERTED BY A7 (STA-37) — this is the quirk the ticket exists to close.
   *
   * A1's "before", recorded here verbatim: "A repository that MOVED still has a
   * hub row pointing at its old path, and today absolutely nothing notices:
   * opening it from its new location works (the walk-up never consults the hub),
   * while `--ws` and every hub-wide view keep following the dead path. The two
   * surfaces disagree indefinitely and silently. … Only an explicit re-init
   * repairs the row."
   *
   * Plan §4: "Every successful resolution through a repository path also calls
   * one idempotent repair operation." So the plain `ls` that used to leave the
   * row stale is now the thing that fixes it, and the re-init is no longer
   * required for anything. `hub-repair.test.ts` covers the rest of the contract
   * — idempotence, the prefix guard, and survival when the hub is unusable.
   */
  it("a moved repository repairs its own hub path on the next ordinary command", () => {
    const moveHome = tempDir("char-hub-move");
    const moveRoot = tempDir("char-hub-moveroot");
    const before = join(moveRoot, "movable");
    const after = join(moveRoot, "moved");
    mkdirSync(before, { recursive: true });
    expect(runCliAt(before, ["init"], { STAPLE_HOME: moveHome }).status).toBe(0);
    expect(runCliAt(before, ["new", "task in movable"], { STAPLE_HOME: moveHome, STAPLE_AGENT: "m" }).status).toBe(0);
    expect(hubList(moveHome)[0]!.path).toBe(join(before, ".staple", "staple.db"));

    renameSync(before, after);

    // Local operation from the new location: fine, exactly as before — the
    // walk-up still never DEPENDS on the hub.
    expect(runCliAt(after, ["ls"], { STAPLE_HOME: moveHome }).stdout).toContain("task in movable");

    // …and that same plain `ls` brought the registry back in line, with the
    // prefix untouched. No re-init, no explicit repair command.
    const repaired = hubList(moveHome)[0]!;
    expect(repaired.path).toBe(join(after, ".staple", "staple.db"));
    expect(repaired.available).toBe(true);
    expect(repaired.prefix).toBe("MOV");

    // The surface that used to disagree indefinitely now agrees.
    expect(
      runCliAt(moveRoot, ["ls", "--ws", "movable"], { STAPLE_HOME: moveHome }).stdout,
    ).toContain("task in movable");

    removeDir(moveHome);
    removeDir(moveRoot);
  }, 60_000);
});

// -------------------------------------------------------------- hub views

describe("hub subcommand output", () => {
  it("prints nothing at all for an empty registry, links, or event log", () => {
    const empty = tempDir("char-hub-empty");
    for (const sub of ["ls", "links", "events"]) {
      const result = runCliAt(root, ["hub", sub], { STAPLE_HOME: empty });
      expect(result.status, sub).toBe(0);
      // QUIRK (A7): every hub view is silent when it is empty — unlike `ls`,
      // which says "(no issues)". A first-run user gets a blank screen with no
      // indication of whether the command worked.
      expect(result.stdout, sub).toBe("");
      expect(result.stderr, sub).toBe("");
    }
    removeDir(empty);
  }, 40_000);

  it("pins the `hub ls` column layout for an available row", () => {
    const one = tempDir("char-hub-one");
    expect(runCliAt(root, ["init", "--global", "onlyone"], { STAPLE_HOME: one }).status).toBe(0);
    // prefix padEnd(6), slug padEnd(20), kind padEnd(7), availability, two
    // spaces, absolute path.
    expect(runCliAt(root, ["hub", "ls"], { STAPLE_HOME: one }).stdout).toBe(
      `ONL    onlyone              global  available  ${join(one, "workspaces", "onlyone.db")}\n`,
    );
    removeDir(one);
  }, 30_000);

  it("emits hub ls/links as JSON arrays but hub events as NDJSON", () => {
    const shapes = tempDir("char-hub-shapes");
    expect(runCliAt(root, ["init", "--global", "shapes"], { STAPLE_HOME: shapes }).status).toBe(0);
    expect(Array.isArray(JSON.parse(runCliAt(root, ["hub", "ls", "--json"], { STAPLE_HOME: shapes }).stdout))).toBe(true);
    expect(Array.isArray(JSON.parse(runCliAt(root, ["hub", "links", "--json"], { STAPLE_HOME: shapes }).stdout))).toBe(true);
    // `hub events` writes one object per line with no wrapping array, matching
    // `events --json` — so a caller cannot JSON.parse the whole stream.
    expect(runCliAt(root, ["hub", "events", "--json"], { STAPLE_HOME: shapes }).stdout).toBe("");
    removeDir(shapes);
  }, 40_000);
});
