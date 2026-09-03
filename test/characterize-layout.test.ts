/**
 * A1 — the ON-DISK LAYOUT of a fresh install, frozen before A4 and A5.
 *
 * This is the file A5 needs most. Its ticket moves repository state from
 * `.tasks/tasks.db` to `.staple/staple.db` through a journalled, resumable
 * migration, and a migration is only verifiable against a proven "before". A4
 * replaces the column-probe schema code with an ordered migration registry and
 * has to keep producing a database a v2 reader recognises.
 *
 * So everything is pinned as a WHOLE: the complete directory tree with
 * permission bits (not a handful of existsSync calls), the complete `meta`
 * table, the complete table list of both databases. An added file, a dropped
 * index, or a permission change is then a visible diff instead of a discovery
 * made in production.
 *
 * All paths are relative to a temporary root, so the goldens are literal.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { diskTree, removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

const created: string[] = [];

function scratch(prefix: string): string {
  const dir = tempDir(prefix);
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) removeDir(created.pop());
});

/** Table and index names, so a schema change to either database is a diff. */
function schemaObjects(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db
        .prepare("SELECT type, name FROM sqlite_master ORDER BY type, name")
        .all() as Array<{ type: string; name: string }>
    ).map((row) => `${row.type}:${row.name}`);
  } finally {
    db.close();
  }
}

function metaRows(dbPath: string): Array<{ key: string; value: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT key, value FROM meta ORDER BY key").all() as Array<{
      key: string;
      value: string;
    }>;
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------ repo-local init

describe("a fresh repo-local `staple init`", () => {
  // MOVED BY A5, then again BY A6 (both deliberate). A5 changed the directory
  // and database names from `.tasks/tasks.db` to `.staple/staple.db` per the
  // plan's storage table. A6 adds the THIRD file: `.staple/.gitignore`.
  //
  // That third file is STA-59's resolution, and it closes the tension A5
  // flagged and deliberately left open. A5's note here read: "init still writes
  // NOTHING outside its own directory, and there is still no `.gitignore` edit
  // … A5 deliberately did NOT add the `.gitignore` rule: the plan gates it on
  // consent, which is A6's machinery. That rule and re-homing AGENTS.md out of
  // an ignored directory are ONE change and must land together."
  //
  // They land together here, and the resolution is better than either half
  // alone: a PER-DIRECTORY ignore that covers `*.db*` but NOT `AGENTS.md`. The
  // database stops being committable (plan §3's goal, and STA-59's), the guide
  // stays tracked and travels with the repository (STA-59's other goal), and
  // plan §5's premise — that a guide inside `.staple/` would be invisible —
  // stops being true, so its prohibition no longer applies. Nothing is written
  // outside `.staple/`, which is stricter than the plan's wording, not looser.
  it("writes exactly three files, all 0644, under a single .staple directory", () => {
    const home = scratch("char-layout-home");
    const root = scratch("char-layout-root");
    const project = join(root, "layoutrepo");
    mkdirSync(project, { recursive: true });

    expect(runCliAt(project, ["init"], { STAPLE_HOME: home }).status).toBe(0);

    expect(diskTree(root)).toEqual([
      "layoutrepo/",
      "layoutrepo/.staple/",
      "layoutrepo/.staple/.gitignore 644",
      "layoutrepo/.staple/AGENTS.md 644",
      "layoutrepo/.staple/staple.db 644",
    ]);

    // Still NOTHING outside `.staple/`: the repository's own root `.gitignore`
    // is never created and never edited.
    expect(existsSync(join(project, ".gitignore"))).toBe(false);
    // …and no `-wal`/`-shm` survive a clean process exit, so the tree above is
    // the complete steady state, not a snapshot mid-transaction.
  }, 60_000);

  it("`--no-gitignore` goes back to exactly the two files A5 pinned", () => {
    const home = scratch("char-layout-home-noignore");
    const root = scratch("char-layout-root-noignore");
    const project = join(root, "layoutrepo");
    mkdirSync(project, { recursive: true });

    expect(runCliAt(project, ["init", "--no-gitignore"], { STAPLE_HOME: home }).status).toBe(0);

    expect(diskTree(root)).toEqual([
      "layoutrepo/",
      "layoutrepo/.staple/",
      "layoutrepo/.staple/AGENTS.md 644",
      "layoutrepo/.staple/staple.db 644",
    ]);
  }, 60_000);

  it("leaves an existing .gitignore untouched", () => {
    const home = scratch("char-layout-home2");
    const root = scratch("char-layout-root2");
    const project = join(root, "ignorerepo");
    mkdirSync(project, { recursive: true });
    const ignore = join(project, ".gitignore");
    writeFileSync(ignore, "node_modules\n");

    expect(runCliAt(project, ["init"], { STAPLE_HOME: home }).status).toBe(0);
    expect(readFileSync(ignore, "utf8")).toBe("node_modules\n");
  }, 30_000);

  it("pins the workspace meta table: slug, prefix, and schema_version as TEXT", () => {
    const home = scratch("char-layout-home3");
    const root = scratch("char-layout-root3");
    const project = join(root, "metarepo");
    mkdirSync(project, { recursive: true });
    expect(runCliAt(project, ["init"], { STAPLE_HOME: home }).status).toBe(0);

    expect(metaRows(join(project, ".staple", "staple.db"))).toEqual([
      { key: "prefix", value: "MET" },
      // WORKSPACE_SCHEMA_VERSION, stored as a STRING. A4's ordered registry has
      // to keep reading (and probably keep writing) this exact representation,
      // or an old binary's `CAST(meta.value AS INTEGER)` guard misbehaves.
      // Bumped to "6" by STA-143 (006-approval-gates), after STA-140's 004 and
      // STA-124's 005; the TEXT typing is the characterization, the number just
      // tracks the migration list.
      { key: "schema_version", value: "6" },
      { key: "slug", value: "metarepo" },
    ]);
  }, 30_000);

  it("pins the full workspace schema object list", () => {
    const home = scratch("char-layout-home4");
    const root = scratch("char-layout-root4");
    const project = join(root, "schemarepo");
    mkdirSync(project, { recursive: true });
    expect(runCliAt(project, ["init"], { STAPLE_HOME: home }).status).toBe(0);

    expect(schemaObjects(join(project, ".staple", "staple.db"))).toEqual([
      "index:comments_idempotency_uq",
      "index:comments_issue_idx",
      "index:events_dedup_uq",
      "index:events_issue_idx",
      "index:issues_assignee_status_idx",
      // STA-143: the partial index 006 creates over active gates — the "what
      // needs a human" query, indexed only over the handful of rows that ever
      // hold one.
      "index:issues_gate_state_idx",
      "index:issues_idempotency_uq",
      "index:issues_live_origin_uq",
      "index:issues_normalized_title_open_idx",
      "index:issues_parent_idx",
      "index:issues_status_idx",
      "index:issues_updated_idx",
      "index:relations_blocked_idx",
      "index:relations_blocker_idx",
      "index:sqlite_autoindex_comments_1",
      "index:sqlite_autoindex_document_revisions_1",
      "index:sqlite_autoindex_documents_1",
      "index:sqlite_autoindex_issues_1",
      "index:sqlite_autoindex_issues_2",
      "index:sqlite_autoindex_meta_1",
      "index:sqlite_autoindex_relations_1",
      // STA-140 (004-workspace-settings): the statuses and kinds a workspace
      // configures are rows now, so the vocabulary is part of the pinned shape.
      "index:sqlite_autoindex_workspace_kinds_1",
      "index:sqlite_autoindex_workspace_statuses_1",
      "index:workspace_kinds_order_idx",
      "index:workspace_statuses_order_idx",
      "table:comments",
      "table:document_revisions",
      "table:documents",
      "table:events",
      "table:issues",
      "table:meta",
      "table:relations",
      "table:sqlite_sequence",
      "table:workspace_kinds",
      "table:workspace_statuses",
    ]);
  }, 30_000);

  it("opens in WAL with foreign keys on — the pragmas a migrated copy must preserve", () => {
    const home = scratch("char-layout-home5");
    const root = scratch("char-layout-root5");
    const project = join(root, "pragmarepo");
    mkdirSync(project, { recursive: true });
    expect(runCliAt(project, ["init"], { STAPLE_HOME: home }).status).toBe(0);

    const db = new DatabaseSync(join(project, ".staple", "staple.db"));
    try {
      // journal_mode is persistent in the FILE header, so this reads back the
      // mode init left behind, not one this connection just set.
      expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    } finally {
      db.close();
    }
  }, 30_000);
});

// ----------------------------------------------------------------- the home

describe("the machine home", () => {
  it("holds only hub.db until a global workspace or the UI adds to it", () => {
    const home = scratch("char-layout-home6");
    const root = scratch("char-layout-root6");
    const project = join(root, "homerepo");
    mkdirSync(project, { recursive: true });

    expect(runCliAt(project, ["init"], { STAPLE_HOME: home }).status).toBe(0);
    // NOTE for A3: there is no config.json, no version marker, and no bootstrap
    // locator anywhere. The home is created implicitly by openDb's mkdirSync and
    // its ONLY contents are databases. A3 introduces a versioned config.json
    // here; this golden is what "no configuration at all" looks like today.
    expect(diskTree(home)).toEqual(["hub.db 644"]);

    expect(runCliAt(project, ["init", "--global", "globalone"], { STAPLE_HOME: home }).status).toBe(0);
    expect(diskTree(home)).toEqual([
      "hub.db 644",
      "workspaces/",
      "workspaces/globalone.db 644",
    ]);
  }, 60_000);

  it("pins the hub schema object list — and that the hub IS versioned", () => {
    const home = scratch("char-layout-home7");
    const root = scratch("char-layout-root7");
    const project = join(root, "hubschemarepo");
    mkdirSync(project, { recursive: true });
    expect(runCliAt(project, ["init"], { STAPLE_HOME: home }).status).toBe(0);

    /**
     * UPDATED BY A4 (STA-34). Two objects were added here: `table:meta` and its
     * `index:sqlite_autoindex_meta_1`. Everything else is byte-identical to the
     * pre-A4 pin, because hub migration 001 is the old `HUB_DDL` verbatim.
     *
     * This is the one characterization assertion A4 was entitled to move. The
     * quirk it used to record — "`migrateHub` is a bare `db.exec(HUB_DDL)` with
     * no meta table and no version row of any kind, so the hub database is
     * UNVERSIONED" — was filed against A4 precisely because A4 is the ticket
     * that fixes it. The workspace pins above are unchanged and were the target
     * the consolidated fresh-create snapshot had to reproduce.
     */
    expect(schemaObjects(join(home, "hub.db"))).toEqual([
      "index:cross_links_blocked_idx",
      "index:cross_links_blocker_idx",
      "index:hub_events_dedup_uq",
      "index:sqlite_autoindex_cross_links_1",
      "index:sqlite_autoindex_meta_1",
      "index:sqlite_autoindex_workspaces_1",
      "index:sqlite_autoindex_workspaces_2",
      "table:cross_links",
      "table:hub_events",
      "table:meta",
      "table:sqlite_sequence",
      "table:workspaces",
    ]);

    // The hub now carries a version, stamped as TEXT in the same representation
    // the workspace uses — so an old binary's `CAST(meta.value AS INTEGER)`
    // guard can read it, and A4's newer-database refusal has something to read
    // on this side. `schema_version` is the ONLY key the hub stores: slug and
    // prefix remain authoritative in each workspace file, not here.
    expect(metaRows(join(home, "hub.db"))).toEqual([{ key: "schema_version", value: "2" }]);
  }, 30_000);

  it("mints ~/.staple/ui-token at 0600 the first time the UI is asked for", () => {
    const home = scratch("char-layout-home8");
    const root = scratch("char-layout-root8");
    const project = join(root, "tokenrepo");
    mkdirSync(project, { recursive: true });
    expect(runCliAt(project, ["init"], { STAPLE_HOME: home }).status).toBe(0);
    expect(existsSync(join(home, "ui-token"))).toBe(false);

    // `--port abc` makes server.listen throw synchronously, so the token is
    // minted (it happens first) without leaving a server bound.
    runCliAt(project, ["ui", "--port", "abc", "--no-open"], { STAPLE_HOME: home }, 20_000);

    const tokenPath = join(home, "ui-token");
    expect(existsSync(tokenPath)).toBe(true);
    expect((statSync(tokenPath).mode & 0o777).toString(8)).toBe("600");
    // base64url of 32 random bytes, plus the trailing newline the file carries.
    expect(readFileSync(tokenPath, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
  }, 40_000);
});

// -------------------------------------------------------- global vs repo shape

describe("global workspaces", () => {
  it("live at <home>/workspaces/<slug>.db with no guide and kind=global", () => {
    const home = scratch("char-layout-home9");
    const root = scratch("char-layout-root9");
    const project = join(root, "anyrepo");
    mkdirSync(project, { recursive: true });

    expect(runCliAt(project, ["init", "--global", "solo"], { STAPLE_HOME: home }).status).toBe(0);
    // Nothing lands in the repository at all — not even a .staple directory.
    expect(diskTree(root)).toEqual(["anyrepo/"]);
    expect(diskTree(home)).toEqual(["hub.db 644", "workspaces/", "workspaces/solo.db 644"]);
    expect(metaRows(join(home, "workspaces", "solo.db"))).toEqual([
      { key: "prefix", value: "SOL" },
      // WORKSPACE_SCHEMA_VERSION — 6 since STA-143. The hub beside it is still 2;
      // the two databases version independently.
      { key: "schema_version", value: "6" },
      { key: "slug", value: "solo" },
    ]);
  }, 30_000);

  /**
   * QUIRK (A6/A9): `--global` slugifies its argument silently. A name with no
   * usable characters collapses to the literal slug "workspace" and a numeric
   * name yields the "WS" prefix fallback, both without a word of warning — so
   * two different requested names can land on the same file.
   */
  it("KNOWN: --global slugifies silently, including a total collapse to \"workspace\"", () => {
    const home = scratch("char-layout-home10");
    const root = scratch("char-layout-root10");
    const project = join(root, "sluggy");
    mkdirSync(project, { recursive: true });

    const collapsed = runCliAt(project, ["init", "--global", "!!!"], { STAPLE_HOME: home });
    expect(collapsed.status).toBe(0);
    expect(collapsed.stdout).toContain('Created workspace "workspace" (prefix WOR)');

    const numeric = runCliAt(project, ["init", "--global", "123"], { STAPLE_HOME: home });
    expect(numeric.status).toBe(0);
    expect(numeric.stdout).toContain('Created workspace "123" (prefix WS)');

    expect(diskTree(home)).toEqual([
      "hub.db 644",
      "workspaces/",
      "workspaces/123.db 644",
      "workspaces/workspace.db 644",
    ]);
  }, 40_000);
});
