/**
 * What arms the journal seam, and what keeps it disarmed.
 *
 * `test/journal-seam.test.ts` covers the seam's behaviour once armed, and it
 * arms it by calling `bindJournal` directly — which is right for testing the
 * seam and wrong for testing the *arming*, because it bypasses the function that
 * decides. This file exercises `resolveDeviceId` for real, through `journalFor`,
 * with a real staple home on disk.
 *
 * The property being defended is the privacy posture:
 *
 *   *"an unconnected workspace journals nothing at all: no outbox rows, no
 *   version rows, no observable difference from the build before this one."*
 *
 * Two independent conditions have to hold, and the test that matters is that
 * EITHER one being absent is enough to keep the seam silent. A single condition
 * would be one refactor away from arming every workspace on a machine that had
 * connected one of them.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { journalFor, resolveDeviceId } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { ensureDeviceId, readDeviceId } from "../src/core/cloud/device.js";

const REPO_ID = "0e77fa01-1111-4222-8333-444455556666";

let home: string;
let savedHome: string | undefined;
let savedDevice: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-arming-home-"));
  savedHome = process.env.STAPLE_HOME;
  savedDevice = process.env.STAPLE_DEVICE_ID;
  process.env.STAPLE_HOME = home;
  // The override wins over the file, so it has to be out of the way for the
  // file-based path to be what is under test.
  delete process.env.STAPLE_DEVICE_ID;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = savedHome;
  if (savedDevice === undefined) delete process.env.STAPLE_DEVICE_ID;
  else process.env.STAPLE_DEVICE_ID = savedDevice;
  rmSync(home, { recursive: true, force: true });
});

/** A workspace with an identity — what `staple init` leaves behind. */
function workspace(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  writeStoredRepositoryId(db, REPO_ID);
  return new WorkspaceStore(db, "test", "TST");
}

describe("a machine that has never connected anything", () => {
  it("has no device id, and nothing mints one by being asked", () => {
    expect(readDeviceId(home)).toBeNull();
    expect(resolveDeviceId()).toBeNull();
    // Asking again did not create it. `readDeviceId` never mints; only
    // `staple cloud connect` does, through `ensureDeviceId`.
    expect(readDeviceId(home)).toBeNull();
  });

  it("journals nothing, for a workspace that HAS a repository identity", () => {
    const store = workspace();
    const issue = store.createIssue({ title: "Local only", description: "and staying local" });
    store.updateIssue(issue.identifier, { priority: "high" });
    store.addComment(issue.identifier, "a comment", "agent-a", "agent");
    store.queue().enqueue(issue.identifier, {}, "agent-a");

    expect(store.journal.armed()).toBe(false);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sync_entity_versions").get()).toEqual({ n: 0 });
    // And the allocator never moved, so connecting later starts from a clean 1.
    expect(store.db.prepare("SELECT client_seq_high_water AS n FROM sync_state").get()).toEqual({
      n: 0,
    });
    store.db.close();
  });
});

describe("a machine that HAS connected something", () => {
  it("still journals nothing for a workspace with no repository identity", () => {
    ensureDeviceId(home);
    expect(resolveDeviceId()).not.toBeNull();

    const db = openDb(":memory:");
    migrateWorkspace(db);
    // No `writeStoredRepositoryId`: this is a global workspace, or one that
    // `staple init` has not given an identity to.
    const store = new WorkspaceStore(db, "test", "TST");

    store.createIssue({ title: "Unidentified" });

    expect(store.journal.armed()).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 });
    db.close();
  });

  it("arms a workspace that has both, and journals from the first mutation", () => {
    ensureDeviceId(home);
    const store = workspace();

    expect(store.journal.armed()).toBe(true);
    const issue = store.createIssue({ title: "Journaled" });

    const rows = store.db
      .prepare("SELECT entity, entity_id, verb FROM sync_outbox ORDER BY client_seq")
      .all() as Array<{ entity: string; entity_id: string; verb: string }>;
    expect(rows).toEqual([{ entity: "issue", entity_id: issue.id, verb: "create" }]);
    store.db.close();
  });

  it("uses the same device id for every repository on the machine", () => {
    const first = ensureDeviceId(home);
    const second = ensureDeviceId(home);
    expect(second).toBe(first);
    expect(resolveDeviceId()).toBe(first);
  });
});

describe("the environment override", () => {
  it("wins over the file, which is what lets a test arm the seam without a home", () => {
    ensureDeviceId(home);
    process.env.STAPLE_DEVICE_ID = "explicit-device";
    expect(resolveDeviceId()).toBe("explicit-device");
  });

  it("is ignored when it is empty, rather than arming with an empty identity", () => {
    process.env.STAPLE_DEVICE_ID = "   ";
    expect(resolveDeviceId()).toBeNull();
  });
});

describe("a home that cannot be resolved is disarmed, not fatal", () => {
  it("keeps the workspace fully usable when the staple home is unusable", () => {
    // A bootstrap locator pointing at nonsense: the home cannot be resolved, and
    // `stapleHome()` refuses. An ordinary command must not care.
    mkdirSync(join(home, "broken"), { recursive: true });
    process.env.STAPLE_HOME = join(home, "broken", "\0invalid");

    const store = workspace();
    expect(() => store.createIssue({ title: "Still works" })).not.toThrow();
    expect(store.journal.armed()).toBe(false);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 });
    store.db.close();
  });
});

describe("journalFor caches per connection", () => {
  it("hands every store on one database the same journal", () => {
    ensureDeviceId(home);
    const store = workspace();
    expect(journalFor(store.db)).toBe(store.journal);
    // Which is what makes "one seam" true: a milestone create composing an issue
    // create opens one scope, not two, and journals the composition once.
    expect(journalFor(store.db)).toBe(journalFor(store.db));
    store.db.close();
  });
});
