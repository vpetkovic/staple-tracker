/**
 * The two fields a row needs before a surface can put a CONTROL on it — S17/S19/S21.
 *
 * `hub-surface.ts` produced a row a surface could describe and not a row a
 * surface could act on. Two things were missing, and both are decisions that
 * must be made ONCE rather than re-derived by every reader:
 *
 * - `recordsIdentityOnOpen`. It has been on `HubWorkspace` since STA-281 and was
 *   never carried through to the report, so the settings page had no way to tell
 *   the two identity absences apart and printed "run `staple init`" at both. For
 *   one of them that instruction is not merely unhelpful, it is WRONG: run
 *   anywhere but the exact registered directory it mints a second identity for a
 *   workspace that is about to record its own.
 *
 * - `actionable`. Whether any control on this row can do anything. It is NOT
 *   `skip === null`: a workspace whose only problem is that it has not recorded a
 *   sync identity yet, and which will record one the next time staple opens it,
 *   is perfectly connectable — pressing Connect is what opens it. Deriving that
 *   in the browser would put a rule about `repo-identity.ts` in a React
 *   component.
 *
 * `available` and `actionable` are deliberately two fields answering two
 * questions. A surface GROUPS on `available` — "is this thing on the machine at
 * all" — and COUNTS on `actionable`. Collapsing them would hide a reachable
 * workspace that happens to need `staple init`, which STA-282 forbids in as many
 * words.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performSetup } from "../src/commands/init.js";
import { Hub } from "../src/core/hub.js";
import { listHubWorkspaces } from "../src/core/cloud/hub-scope.js";
import { hubCloudReport } from "../src/core/cloud/hub-surface.js";

let home: string;
let scratch: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.STAPLE_HOME;
  home = mkdtempSync(join(tmpdir(), "staple-surface-home-"));
  scratch = mkdtempSync(join(tmpdir(), "staple-surface-work-"));
  process.env.STAPLE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function makeRepo(name: string, options: { git?: boolean } = {}): { dir: string; dbPath: string } {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  if (options.git === true) mkdirSync(join(dir, ".git"), { recursive: true });
  const report = performSetup({ dir, yes: true, gitignore: false, interactive: false });
  return { dir, dbPath: report.dbPath };
}

/** Drop the manifest so the row reads `no_identity`, leaving the database in place. */
function forgetIdentity(dir: string): void {
  rmSync(join(dir, ".staple", "repository.json"), { force: true });
}

function rowFor(slug: string) {
  const row = hubCloudReport(home).workspaces.find((entry) => entry.slug === slug);
  if (!row) throw new Error(`no row for ${slug}`);
  return row;
}

describe("a row carries whether staple records its identity on the next open", () => {
  it("is true for a workspace outside a checkout and false inside one", () => {
    makeRepo("loose");
    makeRepo("checkout", { git: true });

    expect(rowFor("loose").recordsIdentityOnOpen).toBe(true);
    expect(rowFor("checkout").recordsIdentityOnOpen).toBe(false);
  });

  it("agrees with the value hub-scope computed, rather than re-deriving it", () => {
    makeRepo("loose");
    makeRepo("checkout", { git: true });

    const scope = new Map(
      listHubWorkspaces().map((workspace) => [workspace.slug, workspace.recordsIdentityOnOpen]),
    );
    for (const row of hubCloudReport(home).workspaces) {
      expect(row.recordsIdentityOnOpen).toBe(scope.get(row.slug));
    }
  });
});

describe("a row says whether any control on it can do anything", () => {
  it("is actionable when it is registered, present and has an identity", () => {
    makeRepo("alpha");
    const row = rowFor("alpha");
    expect(row.skip).toBeNull();
    expect(row.actionable).toBe(true);
  });

  /**
   * THE CASE THE OLD SHAPE GOT WRONG. `skip` is `no_identity`, so anything
   * reading `skip === null` calls this row dead — and it is not: staple records
   * the identity the next time it opens this workspace, which is what pressing
   * Connect does. A page that hid the button here would be hiding the only
   * control that would have worked.
   */
  it("is actionable with no identity when the next open will record one", () => {
    const repo = makeRepo("loose");
    forgetIdentity(repo.dir);

    const row = rowFor("loose");
    expect(row.skip).toBe("no_identity");
    expect(row.recordsIdentityOnOpen).toBe(true);
    expect(row.actionable).toBe(true);
  });

  /**
   * And the mirror image. Inside a checkout the manifest is a committed file
   * rather than something minted behind the reader, so no amount of opening will
   * produce one and `staple init` in that directory genuinely is the answer.
   */
  it("is not actionable with no identity inside a checkout", () => {
    const repo = makeRepo("checkout", { git: true });
    forgetIdentity(repo.dir);

    const row = rowFor("checkout");
    expect(row.skip).toBe("no_identity");
    expect(row.recordsIdentityOnOpen).toBe(false);
    expect(row.actionable).toBe(false);
  });

  it("is not actionable when the database is not on this machine", () => {
    const repo = makeRepo("gone");
    rmSync(repo.dir, { recursive: true, force: true });

    const row = rowFor("gone");
    expect(row.available).toBe(false);
    expect(row.skip).toBe("unavailable");
    expect(row.actionable).toBe(false);
  });

  /**
   * An unreadable manifest is neither absent nor usable, and the row must not
   * offer a control that would act on an identity nobody could read.
   */
  it("is not actionable when the identity could not be read", () => {
    const repo = makeRepo("broken");
    // Present and unparseable — the exact case `repo-identity.ts` refuses to
    // degrade into "absent".
    const manifest = join(repo.dir, ".staple", "repository.json");
    writeFileSync(manifest, "{ not json", "utf8");

    const row = rowFor("broken");
    expect(row.skip).toBe("problem");
    expect(row.actionable).toBe(false);
  });
});

describe("the count at the top describes actionable workspaces", () => {
  it("counts what a control could act on, not every registered row", () => {
    makeRepo("alpha");
    const dead = makeRepo("dead");
    const checkout = makeRepo("checkout", { git: true });
    rmSync(dead.dir, { recursive: true, force: true });
    forgetIdentity(checkout.dir);

    const counts = hubCloudReport(home).counts;
    expect(counts.total).toBe(3);
    // alpha only: dead has no disk, checkout needs a committed manifest.
    expect(counts.actionable).toBe(1);
    expect(counts.skipped).toBe(2);
  });

  it("never counts more actionable rows than there are rows", () => {
    makeRepo("alpha");
    makeRepo("bravo");
    const counts = hubCloudReport(home).counts;
    expect(counts.actionable).toBeLessThanOrEqual(counts.total);
    expect(counts.actionable).toBe(2);
  });

  it("reads zero on a machine whose every registered workspace has gone", () => {
    const a = makeRepo("alpha");
    const b = makeRepo("bravo");
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });

    const report = hubCloudReport(home);
    expect(report.counts.total).toBe(2);
    expect(report.counts.actionable).toBe(0);
    // Still enumerated, still removable. Subordinate is not the same as hidden.
    expect(report.workspaces).toHaveLength(2);
  });
});

describe("nothing about these fields opens a workspace database", () => {
  /**
   * The property `hub-scope.ts` exists to protect, restated for the two new
   * fields: `actionable` is decided from the registry, the manifest and the
   * filesystem, so computing it cannot migrate a schema as a side effect of
   * drawing a list.
   */
  it("leaves every registered workspace's mtime alone", () => {
    const repo = makeRepo("alpha");
    const before = readFileSync(join(repo.dir, ".staple", "repository.json"), "utf8");

    const hub = Hub.openReadOnly();
    const registered = hub.list().length;
    hub.close();

    for (let round = 0; round < 5; round += 1) hubCloudReport(home);

    expect(registered).toBe(1);
    expect(readFileSync(join(repo.dir, ".staple", "repository.json"), "utf8")).toBe(before);
  });
});
