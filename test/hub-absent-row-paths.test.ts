/**
 * An absent hub row has no path, and nothing may resolve the one it doesn't have.
 *
 * `Hub.registerAbsent` stores `path = ""` for a workspace this machine knows of from an
 * adopted registry but does not have. Every path function in node reads `""` as the
 * process's current directory: `resolve("")`, `normalizePath("")`, `dirname(resolve(""))`.
 * So each consumer that fed a hub row's path to one of them, without asking whether the
 * row had a path, quietly worked on wherever the command happened to be standing:
 *
 *  - `doctor --fix --only hub-registrations` repointed every absent row AT THE CURRENT
 *    DIRECTORY, and `doctor` failed two absent rows as "one path, two slugs";
 *  - walk-up repair and `staple discover` refused to attach an absent row, calling the
 *    current directory a second live claimant it could not read;
 *  - `staple add` refused for the same reason;
 *  - `--ws <absent>` said "No workspace at ." and told the reader to run init;
 *  - `staple config home --move` counted an absent row as still inside the old home
 *    whenever it was run from there.
 *
 * Every test here stands in a directory it controls, whose parent holds a stray
 * `repository.json`, so a consumer that resolved `""` would find a real directory and a
 * real manifest rather than failing loudly.
 */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ABSENT_PATH, Hub } from "../src/core/hub.js";
import {
  findCopyClaimant,
  findRepointableRows,
  repairHubRegistration,
} from "../src/core/hub-repair.js";
import { classifyCandidates } from "../src/core/discovery.js";
import { initWorkspace, resolveWorkspace } from "../src/core/workspace.js";
import { describeSkip, describeWorkspace, skipReasonFor } from "../src/core/cloud/hub-scope.js";
import { moveHome } from "../src/config/move.js";
import { runCliAt } from "./fixtures/characterize-support.js";
import { mcpEnvelope, startMcpClient } from "./fixtures/contract-support.js";

const ONE = "11111111-1111-4111-8111-111111111111";
const TWO = "22222222-2222-4222-8222-222222222222";
const STRAY = "99999999-9999-4999-8999-999999999999";

let previousCwd: string;
let previousHome: string | undefined;
let home: string;
/** The directory every test stands in. Its parent holds the stray manifest. */
let trapCwd: string;
let dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  previousCwd = process.cwd();
  previousHome = process.env.STAPLE_HOME;
  home = tempDir("staple-absent-home-");
  process.env.STAPLE_HOME = home;
  const parent = tempDir("staple-absent-trap-");
  writeFileSync(join(parent, "repository.json"), `${JSON.stringify({ repositoryId: STRAY, format: 1 })}\n`);
  trapCwd = join(parent, "cwd");
  mkdirSync(trapCwd);
  process.chdir(trapCwd);
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function withHub<T>(run: (hub: Hub) => T): T {
  const hub = Hub.open();
  try {
    return run(hub);
  } finally {
    hub.close();
  }
}

/**
 * A real workspace on disk whose hub row has been turned into the placeholder an adopt
 * leaves: same slug, same prefix, the given recorded identity, and no path.
 */
function absentWorkspace(slug: string, recorded: "own" | string | null): {
  dir: string;
  dbPath: string;
  prefix: string;
  repositoryId: string;
} {
  const dir = join(tempDir(`staple-absent-ws-${slug}-`), slug);
  const created = initWorkspace({ dir, slug });
  const dbPath = created.dbPath;
  const repositoryId = created.repository.repositoryId;
  created.store.db.close();
  const prefix = withHub((hub) => {
    const before = hub.get(slug)!;
    hub.unregister(slug);
    hub.registerAbsent({
      slug,
      prefix: before.prefix,
      kind: before.kind,
      repositoryId: recorded === "own" ? repositoryId : recorded,
    });
    return before.prefix;
  });
  return { dir, dbPath, prefix, repositoryId };
}

const rowOf = (slug: string) => withHub((hub) => hub.get(slug)!);

/** The hub row exactly as stored, every column, for "left as it was" assertions. */
function rawRow(slug: string): Record<string, unknown> | undefined {
  const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM workspaces WHERE slug = ?").get(slug) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

const cli = (cwd: string, args: string[]) => runCliAt(cwd, args, { STAPLE_HOME: home }, 30_000);

describe("hub repair never reads an absent row's path as the current directory", () => {
  it("offers no repoint for an absent row", () => {
    withHub((hub) => hub.registerAbsent({ slug: "alpha", prefix: "ALP", kind: "repo", repositoryId: ONE }));
    expect(withHub((hub) => findRepointableRows(hub))).toEqual([]);
  });

  it("attaches an absent row to a workspace that presents the recorded identity", () => {
    const ws = absentWorkspace("alpha", "own");
    const result = repairHubRegistration({ slug: "alpha", prefix: ws.prefix, dbPath: ws.dbPath, kind: "repo" });
    expect(result).toMatchObject({ outcome: "repointed", pathBefore: null, changed: true, error: null });
    expect(rowOf("alpha")).toMatchObject({ path: ws.dbPath, available: true, repositoryId: ws.repositoryId });
  });

  it("refuses to attach an absent row to a different repository, and names no directory for the row", () => {
    const ws = absentWorkspace("alpha", TWO);
    const result = repairHubRegistration({ slug: "alpha", prefix: ws.prefix, dbPath: ws.dbPath, kind: "repo" });
    expect(result).toMatchObject({ outcome: "conflict", pathBefore: null, changed: false });
    expect(result.error).toContain(TWO);
    expect(result.error).toContain(ws.repositoryId);
    expect(result.error).not.toContain(trapCwd);
    expect(result.error).not.toContain(join(trapCwd, ".."));
    expect(rowOf("alpha")).toMatchObject({ path: ABSENT_PATH, available: false, repositoryId: TWO });
  });

  it("refuses an absent row with no recorded identity, even to a workspace that presents none", () => {
    // Both sides null is not a match: there is nothing to check the workspace against.
    const ws = absentWorkspace("alpha", null);
    renameSync(join(ws.dir, ".staple", "repository.json"), join(ws.dir, ".staple", "repository.json.gone"));
    const before = rawRow("alpha");
    const result = repairHubRegistration({ slug: "alpha", prefix: ws.prefix, dbPath: ws.dbPath, kind: "repo" });
    expect(result).toMatchObject({ outcome: "conflict", pathBefore: null, changed: false });
    expect(result.error).toContain("no recorded sync identity");
    expect(rawRow("alpha")).toEqual(before);
  });

  it("reports no previous path when an absent row's prefix disagrees", () => {
    const ws = absentWorkspace("alpha", "own");
    const result = repairHubRegistration({ slug: "alpha", prefix: "OTHER", dbPath: ws.dbPath, kind: "repo" });
    expect(result).toMatchObject({ outcome: "conflict", pathBefore: null, changed: false });
  });

  it("does not treat an absent row as a live claimant against `staple add`", () => {
    const ws = absentWorkspace("alpha", "own");
    expect(withHub((hub) => findCopyClaimant(hub, ws.dbPath))).toBeNull();
  });

  it("gives an absent row no registered path in discovery", () => {
    const ws = absentWorkspace("alpha", "own");
    const [classified] = withHub((hub) => {
      const entries = hub.list();
      return classifyCandidates(
        [
          {
            dir: ws.dir,
            dbPath: ws.dbPath,
            layout: "current",
            ambiguous: false,
            aliased: false,
            journalState: null,
            slug: "alpha",
            prefix: ws.prefix,
            readError: null,
          },
        ],
        {
          bySlug: (slug) => entries.find((e) => e.slug === slug),
          slugForPrefix: (prefix) => entries.find((e) => e.prefix === prefix)?.slug,
        },
      );
    });
    expect(classified).toMatchObject({ registrable: true, registeredPath: null });
    expect(classified!.reason).not.toMatch(/registered at\s*,/);
    expect(classified!.reason).toMatch(/no database on this machine/);
  });
});

describe("doctor never reads an absent row's path as the current directory", () => {
  const doctor = (args: string[]) => runCliAt(trapCwd, ["doctor", ...args], { STAPLE_HOME: home }, 30_000);

  it("reports two absent rows as not here, not as one path under two slugs", () => {
    withHub((hub) => {
      hub.registerAbsent({ slug: "alpha", prefix: "ALP", kind: "repo", repositoryId: ONE });
      hub.registerAbsent({ slug: "beta", prefix: "BET", kind: "repo", repositoryId: TWO });
    });
    const run = doctor(["--json"]);
    const check = (JSON.parse(run.stdout.trim()) as { checks: Array<{ id: string; status: string; detail: string }> })
      .checks.find((c) => c.id === "hub-registrations")!;
    expect(check.status).toBe("warn");
    expect(check.detail).not.toContain(trapCwd);
    expect(check.detail).not.toContain("()");
    expect(check.detail).toContain("staple hub registry locate");
  }, 60_000);

  it("the hub-link check says what repair does with an absent row, from inside the workspace", () => {
    type Check = { id: string; status: string; detail: string; data: Record<string, unknown> };
    const hubLink = (dir: string) =>
      (JSON.parse(runCliAt(dir, ["doctor", "--json"], { STAPLE_HOME: home }, 30_000).stdout.trim()) as {
        checks: Check[];
      }).checks.find((c) => c.id === "workspace-hub-link")!;

    const other = absentWorkspace("alpha", TWO);
    const refused = hubLink(other.dir);
    expect(refused.status).toBe("fail");
    expect(refused.detail).toContain(TWO);
    expect(refused.detail).not.toContain("could not be read");
    expect(refused.data).toMatchObject({ registeredPath: null, registeredPathNormalized: null });

    const same = absentWorkspace("beta", "own");
    const attachable = hubLink(same.dir);
    expect(attachable.status).toBe("warn");
    expect(attachable.detail).toContain("attaches it here");
  }, 60_000);

  it("`--fix --only hub-registrations` leaves absent rows without a path", () => {
    withHub((hub) => {
      hub.registerAbsent({ slug: "alpha", prefix: "ALP", kind: "repo", repositoryId: ONE });
      hub.registerAbsent({ slug: "beta", prefix: "BET", kind: "repo", repositoryId: TWO });
    });
    const run = doctor(["--fix", "--only", "hub-registrations", "--yes", "--json"]);
    expect(run.status).toBe(0);
    expect(withHub((hub) => hub.list().map((r) => [r.slug, r.path]))).toEqual([
      ["alpha", ABSENT_PATH],
      ["beta", ABSENT_PATH],
    ]);
  }, 60_000);
});

describe("`add` and `init` take an absent row only with its recorded identity", () => {
  /**
   * `hub.register()` upserts on the slug. An absent row is a registry entry for a
   * repository this machine hasn't got, so a different repository sharing the slug
   * and prefix used to take it over through `init` or `add --yes`, and the recorded id
   * was then overwritten with the newcomer's. These run the real CLI.
   */
  it("`add` refuses a different repository, in the preview and with --yes, and leaves the row as it was", () => {
    const ws = absentWorkspace("zeta", TWO);
    const before = rawRow("zeta");

    const preview = cli(trapCwd, ["add", ws.dir]);
    expect(preview.status).not.toBe(0);
    expect(preview.stderr).toContain(TWO);
    expect(preview.stderr).toContain(ws.repositoryId);

    const applied = cli(trapCwd, ["add", ws.dir, "--yes", "--json"]);
    expect(applied.status).not.toBe(0);
    expect(applied.stderr).toContain(TWO);
    expect(rawRow("zeta")).toEqual(before);
  }, 60_000);

  it("`add` names the adopted row, says the identity matches, and attaches it", () => {
    const ws = absentWorkspace("zeta", "own");

    const preview = cli(trapCwd, ["add", ws.dir]);
    expect(preview.stderr).toContain(`attach the adopted row "zeta" (sync identity ${ws.repositoryId})`);
    expect(preview.stderr).toContain("presents the same identity");

    const applied = cli(trapCwd, ["add", ws.dir, "--yes", "--json"]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(rowOf("zeta")).toMatchObject({ path: ws.dbPath, available: true, repositoryId: ws.repositoryId });
  }, 60_000);

  it("`add` on a clone's manifest names the adopted row it takes over", () => {
    const ws = absentWorkspace("zeta", "own");
    // A clone carries the manifest and not the database.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${ws.dbPath}${suffix}`, { force: true });

    const preview = cli(trapCwd, ["add", ws.dir]);
    expect(preview.stderr).toContain(`take over the adopted row "zeta" (prefix ${ws.prefix})`);

    const applied = cli(trapCwd, ["add", ws.dir, "--yes", "--json"]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(rowOf("zeta")).toMatchObject({ prefix: ws.prefix, available: true, repositoryId: ws.repositoryId });
  }, 60_000);

  it("`init` refuses a different repository and leaves the row as it was", () => {
    const ws = absentWorkspace("zeta", TWO);
    const before = rawRow("zeta");
    const run = cli(ws.dir, ["init", "--json"]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(TWO);
    expect(run.stderr).toContain(ws.repositoryId);
    expect(rawRow("zeta")).toEqual(before);
  }, 60_000);

  it("`init` attaches the absent row when the identity matches", () => {
    const ws = absentWorkspace("zeta", "own");
    const run = cli(ws.dir, ["init", "--json"]);
    expect(run.status, run.stderr).toBe(0);
    expect(rowOf("zeta")).toMatchObject({ path: ws.dbPath, available: true, repositoryId: ws.repositoryId });
  }, 60_000);
});

describe("the other readers of a hub row's path", () => {
  it("MCP passes the absent-row sentence through instead of saying the slug is unregistered", async () => {
    withHub((hub) => hub.registerAbsent({ slug: "alpha", prefix: "ALP", kind: "repo", repositoryId: ONE }));
    const mcp = await startMcpClient({ home, cwd: trapCwd });
    try {
      const result = await mcp.call("list_tasks", { ws: "alpha" });
      expect(result.isError).toBe(true);
      const envelope = mcpEnvelope(result);
      expect(envelope.code).toBe("not_found");
      expect(envelope.message).toContain("not on this machine");
      expect(envelope.message).toContain("staple hub registry locate alpha");
      expect(envelope.message).not.toContain("is registered in the hub. Call");
    } finally {
      await mcp.close();
    }
  }, 60_000);

  it("`--ws` on an absent row says it is not on this machine, rather than 'No workspace at .'", () => {
    withHub((hub) => hub.registerAbsent({ slug: "alpha", prefix: "ALP", kind: "repo", repositoryId: ONE }));
    let message = "";
    try {
      resolveWorkspace({ ws: "alpha" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("No workspace at .");
    expect(message).toContain("not on this machine");
    expect(message).toContain("staple hub registry locate alpha");
  });

  it("the hub-wide skip sentence for an absent row names what to run, and no path", () => {
    withHub((hub) => hub.registerAbsent({ slug: "alpha", prefix: "ALP", kind: "repo", repositoryId: ONE }));
    const workspace = describeWorkspace(rowOf("alpha"));
    const reason = skipReasonFor(workspace);
    expect(reason).toBe("unavailable");
    const sentence = describeSkip(workspace, reason!);
    expect(sentence).not.toContain("()");
    expect(sentence).not.toContain(trapCwd);
    expect(sentence).toContain("staple hub registry locate alpha");
    // Asked directly for the identity sentence, it still has no directory to name.
    const byHand = describeSkip(workspace, "no_identity");
    expect(byHand).not.toContain("repository.json");
    expect(byHand).toContain("staple hub registry locate alpha");
  });

  it("a home move run from inside the old home does not count an absent row as left behind", () => {
    withHub((hub) => hub.registerAbsent({ slug: "alpha", prefix: "ALP", kind: "repo", repositoryId: ONE }));
    const to = join(tempDir("staple-absent-newhome-"), "home");
    process.chdir(home);
    const result = moveHome({ from: home, to, locatorPath: join(tempDir("staple-absent-locator-"), "home.json") });
    expect(result.staleHubPaths).toBe(0);
  });
});
