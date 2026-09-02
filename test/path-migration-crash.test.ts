/**
 * A5 — crash injection at every journal boundary.
 *
 * STA-24 plan §3 defines seven journal states and a recovery rule for each. A
 * recovery rule that has never seen a real crash is a comment, so this suite
 * kills a real process at each boundary and then proves the workspace is still
 * whole.
 *
 * The kill has to be a signal, not a thrown error. A throw unwinds through
 * `finally`, releasing the SQLite barrier, closing handles and deleting
 * temporary files — precisely the cleanup a killed harness, an OOM or a power
 * loss does not do. `STAPLE_MIGRATE_CRASH_AT=<state>` makes the runner SIGKILL
 * itself the instant that transition is durable, from inside a child process
 * (`fixtures/migrate-child.ts`).
 *
 * Every case asserts the same three things, because they are the acceptance
 * criteria in ticket form:
 *
 *   1. the journal left on disk names the state we crashed at;
 *   2. resuming reaches `complete` without operator intervention; and
 *   3. every issue that existed before the crash exists afterwards.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JOURNAL_STATES, readJournal, type JournalState } from "../src/core/path-migration.js";
import {
  cleanupSandboxes,
  cli,
  hubRows,
  issueTitles,
  makeLegacyRepo,
  migrateInChild,
  seedIssues,
  type Sandbox,
} from "./fixtures/migration-support.js";

afterEach(() => cleanupSandboxes());

/** The boundaries a happy-path run actually passes through, in order. */
const REACHABLE: JournalState[] = [
  "planned",
  "locked",
  "snapshotted",
  "target_installed",
  "hub_repaired",
  "complete",
];

function prepare(name: string, issues = 4): { box: Sandbox; titles: string[] } {
  const box = makeLegacyRepo(name);
  const titles = seedIssues(box, issues, "work").sort();
  return { box, titles };
}

describe("journal states", () => {
  it("declares exactly the seven the plan names", () => {
    expect([...JOURNAL_STATES]).toEqual([
      "planned",
      "locked",
      "snapshotted",
      "target_installed",
      "hub_repaired",
      "complete",
      "rollback_required",
    ]);
  });
});

describe("crash injection", () => {
  for (const state of REACHABLE) {
    it(`survives a SIGKILL at "${state}" and resumes to complete`, { timeout: 60_000 }, () => {
      const { box, titles } = prepare(`crash-${state}`);

      const crashed = migrateInChild(box, state);
      expect(crashed.signal).toBe("SIGKILL");
      expect(crashed.payload).toBeNull(); // it never got to print anything

      const journal = readJournal(box.repo);
      expect(journal?.state).toBe(state);

      const resumed = migrateInChild(box);
      expect(resumed.signal).toBeNull();
      expect(resumed.payload?.ok).toBe(true);

      expect(readJournal(box.repo)?.state).toBe("complete");
      expect(existsSync(box.currentDb)).toBe(true);
      expect(existsSync(box.legacyDb)).toBe(false);
      expect(issueTitles(box)).toEqual(titles);
      expect(hubRows(box).find((r) => r.path === box.currentDb)).toBeDefined();
    });
  }
});

describe("what the workspace looks like mid-crash", () => {
  it("leaves the legacy database authoritative and untouched before target_installed", () => {
    for (const state of ["planned", "locked", "snapshotted"] as const) {
      const { box, titles } = prepare(`mid-${state}`, 2);
      const before = readFileSync(box.legacyDb);

      expect(migrateInChild(box, state).signal).toBe("SIGKILL");

      // The source is byte-identical and still the only canonical database.
      expect(readFileSync(box.legacyDb)).toEqual(before);
      expect(existsSync(box.currentDb)).toBe(false);
      // ...so ordinary commands keep working against it, with no migration.
      expect(issueTitles(box)).toEqual(titles);
    }
  }, 60_000);

  it("refuses to open the workspace between target_installed and the legacy move", () => {
    // This is the only window where two canonical databases genuinely coexist.
    // Resolution must refuse rather than pick, and the refusal must name the
    // resume command rather than report an unexplained fork.
    const { box } = prepare("mid-installed", 2);
    expect(migrateInChild(box, "target_installed").signal).toBe("SIGKILL");

    expect(existsSync(box.currentDb)).toBe(true);
    expect(existsSync(box.legacyDb)).toBe(true);

    const blocked = cli(box, ["ls"]);
    expect(blocked.status).toBe(4);
    expect(blocked.stderr).toContain('interrupted at "target_installed"');
    expect(blocked.stderr).toContain("staple migrate --yes");

    // And the named command clears it.
    expect(cli(box, ["migrate", "--yes"]).status).toBe(0);
    expect(cli(box, ["ls"]).status).toBe(0);
  });

  it("has already moved the data when it crashes at hub_repaired", () => {
    const { box, titles } = prepare("mid-hub", 3);
    expect(migrateInChild(box, "hub_repaired").signal).toBe("SIGKILL");

    expect(existsSync(box.legacyDb)).toBe(false);
    expect(existsSync(box.currentDb)).toBe(true);
    // Resolution is unambiguous again, so the workspace is usable immediately —
    // the remaining step is only the journal's own bookkeeping.
    expect(issueTitles(box)).toEqual(titles);
    expect(readJournal(box.repo)?.state).toBe("hub_repaired");

    expect(cli(box, ["migrate", "--yes"]).status).toBe(0);
    expect(readJournal(box.repo)?.state).toBe("complete");
  });
});

describe("resume is idempotent", () => {
  it("re-running after a completed migration changes nothing", () => {
    const { box, titles } = prepare("idempotent", 3);
    expect(migrateInChild(box).payload?.ok).toBe(true);
    const journalAfterFirst = readFileSync(join(box.repo, ".staple", "migration.json"), "utf8");
    const dbAfterFirst = readFileSync(box.currentDb);

    const second = cli(box, ["migrate", "--yes"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already stores its state");

    expect(readFileSync(join(box.repo, ".staple", "migration.json"), "utf8")).toBe(journalAfterFirst);
    expect(readFileSync(box.currentDb)).toEqual(dbAfterFirst);
    expect(issueTitles(box)).toEqual(titles);
  });

  it("resumes twice in a row without a second crash", () => {
    const { box, titles } = prepare("double", 2);
    expect(migrateInChild(box, "snapshotted").signal).toBe("SIGKILL");
    expect(migrateInChild(box, "target_installed").signal).toBe("SIGKILL");
    expect(migrateInChild(box).payload?.ok).toBe(true);
    expect(issueTitles(box)).toEqual(titles);
  });
});

describe("blocked recovery", () => {
  it("records rollback_required and refuses when the installed target vanished", () => {
    const { box } = prepare("vanished", 2);
    expect(migrateInChild(box, "target_installed").signal).toBe("SIGKILL");

    // Simulate the worst case the plan names: the new database is gone after it
    // was installed. Automatic recovery may only choose a side the journal
    // proves, and nothing here proves one.
    const fs = require("node:fs") as typeof import("node:fs");
    fs.rmSync(box.currentDb, { force: true });

    const failed = migrateInChild(box);
    expect(failed.payload?.ok).toBe(false);
    expect(failed.payload?.code).toBe("conflict");
    expect(failed.payload?.message).toContain("is gone");
    expect(readJournal(box.repo)?.state).toBe("rollback_required");

    // The legacy workspace is still there and still authoritative.
    expect(existsSync(box.legacyDb)).toBe(true);
    expect(issueTitles(box)).toEqual(["work 1", "work 2"]);
  });

  it("records rollback_required when something wrote to the installed target", () => {
    const { box } = prepare("tampered", 2);
    expect(migrateInChild(box, "target_installed").signal).toBe("SIGKILL");

    writeFileSync(box.currentDb, "not a database at all");

    const failed = migrateInChild(box);
    expect(failed.payload?.ok).toBe(false);
    expect(failed.payload?.message).toContain("does not match the hash");
    expect(readJournal(box.repo)?.state).toBe("rollback_required");
    expect(existsSync(box.legacyDb)).toBe(true);
  });

  it("blocks every command once rollback_required is recorded", () => {
    const { box } = prepare("blocked-cli", 2);
    expect(migrateInChild(box, "target_installed").signal).toBe("SIGKILL");
    writeFileSync(box.currentDb, "corrupt");
    expect(migrateInChild(box).payload?.ok).toBe(false);

    const listed = cli(box, ["ls"]);
    expect(listed.status).toBe(4);
    expect(listed.stderr).toContain("manual recovery");
    expect(listed.stderr).toContain("staple doctor --fix");

    const retried = cli(box, ["migrate", "--yes"]);
    expect(retried.status).toBe(4);
    expect(retried.stderr).toContain("needs manual recovery");
  });
});

describe("source identity", () => {
  it("refuses to resume onto a source file that was replaced", () => {
    const { box } = prepare("identity", 2);
    expect(migrateInChild(box, "planned").signal).toBe("SIGKILL");

    // Replace the legacy database with a different file at the same path: same
    // name, different inode. A resume that trusted the path would migrate a
    // database it never inspected.
    const other = makeLegacyRepo("identity-other");
    seedIssues(other, 1, "stranger");
    const fs = require("node:fs") as typeof import("node:fs");
    fs.rmSync(box.legacyDb, { force: true });
    fs.copyFileSync(other.legacyDb, box.legacyDb);

    const failed = migrateInChild(box);
    expect(failed.payload?.ok).toBe(false);
    expect(failed.payload?.code).toBe("conflict");
    expect(failed.payload?.message).toContain("not the file this migration started from");
    expect(existsSync(box.currentDb)).toBe(false);
  });
});
