/**
 * The presence index and the concurrency context it feeds (`docs/execution-telemetry.md`,
 * "Concurrency context"; hub migration 006). One machine, one staple home, several real
 * workspaces registered in its hub; every attempt is opened and ended by a real mutation.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceStore } from "../src/core/store.js";
import { attemptsOfIssue, transitionsOf } from "../src/core/telemetry/attempt-records.js";
import { rebuildPresence } from "../src/core/telemetry/presence.js";
import { initWorkspace } from "../src/core/workspace.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

let home: string;
let root: string;
const previousHome = process.env.STAPLE_HOME;
const opened: WorkspaceStore[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-presence-home-"));
  root = mkdtempSync(join(tmpdir(), "staple-presence-root-"));
  process.env.STAPLE_HOME = home;
});
afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.db.close();
    } catch {
      // closed by the test
    }
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
});

function workspace(slug: string): WorkspaceStore {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const { store } = initWorkspace({ dir, slug });
  opened.push(store);
  return store;
}

const hubRows = (): Array<Record<string, unknown>> => {
  const hub = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
  try {
    return hub.prepare("SELECT workspace, attempt_id, account_ref, ended_at FROM attempt_presence ORDER BY workspace, started_at").all() as Array<Record<string, unknown>>;
  } finally {
    hub.close();
  }
};

/** The concurrency the last transition of the issue's latest attempt recorded. */
function lastConcurrency(store: WorkspaceStore, issueId: string): Record<string, unknown> {
  const attempts = attemptsOfIssue(store.db, issueId);
  return transitionsOf(store.db, attempts[attempts.length - 1]!.id).at(-1)!.concurrency as Record<string, unknown>;
}

describe("the machine-wide counts", () => {
  it("count the attempts this machine started across its workspaces, and those on the same account", () => {
    const one = workspace("alpha");
    const two = workspace("bravo");
    const a = one.createIssue({ title: "A" });
    one.checkoutIssue(a.id, "agent-1", undefined, { attempt: { account: "personal-max" } });
    expect(lastConcurrency(one, a.id)).toMatchObject({
      openAttemptsInWorkspace: 1,
      storedOpenAttemptsStartedHere: 1,
      storedOpenAttemptsOnAccountStartedHere: 1,
      missing: { workspaceSyncedThrough: "not_connected" },
    });

    const b = two.createIssue({ title: "B" });
    two.checkoutIssue(b.id, "agent-2", undefined, { attempt: { account: "personal-max" } });
    const c = two.createIssue({ title: "C" });
    two.checkoutIssue(c.id, "agent-3", undefined, { attempt: { account: "codex-plus" } });
    // In bravo: two open here; across the machine three, two of them on personal-max.
    expect(lastConcurrency(two, b.id)).toMatchObject({ openAttemptsInWorkspace: 1, storedOpenAttemptsStartedHere: 2, storedOpenAttemptsOnAccountStartedHere: 2 });
    expect(lastConcurrency(two, c.id)).toMatchObject({ openAttemptsInWorkspace: 2, storedOpenAttemptsStartedHere: 3, storedOpenAttemptsOnAccountStartedHere: 1 });
    expect(hubRows().map((row) => [row.workspace, row.account_ref, row.ended_at])).toEqual([
      ["alpha", "personal-max", null],
      ["bravo", "personal-max", null],
      ["bravo", "codex-plus", null],
    ]);

    // An end reaches the index after the transaction that wrote it.
    one.releaseIssue(a.id, "agent-1");
    expect(hubRows()[0]!.ended_at).not.toBeNull();
    two.recordAttemptEvent(b.id, "milestone", "agent-2", { label: "checkpoint" });
    expect(lastConcurrency(two, b.id)).toMatchObject({ storedOpenAttemptsStartedHere: 2, storedOpenAttemptsOnAccountStartedHere: 1 });

    // An attempt with no account has no account count, and says why.
    const d = two.createIssue({ title: "D" });
    two.checkoutIssue(d.id, "agent-4");
    expect(lastConcurrency(two, d.id)).toMatchObject({
      storedOpenAttemptsStartedHere: 3,
      storedOpenAttemptsOnAccountStartedHere: null,
      missing: { storedOpenAttemptsOnAccountStartedHere: "no_provider_binding" },
    });
  });

  it("hold each attempt's lane, count both lanes, and report the split by role", () => {
    const one = workspace("alpha");
    const two = workspace("bravo");
    const epic = two.createIssue({ title: "Epic" });
    two.openOrchestratorAttempt(epic.id, "orch", "orchestrator");
    const leaf = one.createIssue({ title: "Leaf" });
    one.checkoutIssue(leaf.id, "agent-1");
    expect(lastConcurrency(one, leaf.id)).toMatchObject({
      openAttemptsInWorkspace: 1,
      openAttemptsInWorkspaceByRole: { worker: 1, orchestrator: 0 },
      storedOpenAttemptsStartedHere: 2,
      storedOpenAttemptsStartedHereByRole: { worker: 1, orchestrator: 1 },
    });
    const hub = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
    try {
      expect(hub.prepare("SELECT workspace, role FROM attempt_presence ORDER BY workspace").all()).toEqual([
        { workspace: "alpha", role: "worker" },
        { workspace: "bravo", role: "orchestrator" },
      ]);
    } finally {
      hub.close();
    }
  });

  it("leave out a workspace whose database has moved away, and a full rebuild drops what is unreachable", () => {
    const one = workspace("alpha");
    const two = workspace("bravo");
    const a = one.createIssue({ title: "A" });
    one.checkoutIssue(a.id, "agent-1");
    one.db.close();
    renameSync(join(root, "alpha"), join(root, "alpha-moved"));
    const b = two.createIssue({ title: "B" });
    two.checkoutIssue(b.id, "agent-2");
    // alpha's row is still in the index, and not counted: its database is not where it was.
    expect(hubRows()).toHaveLength(2);
    expect(lastConcurrency(two, b.id)).toMatchObject({ storedOpenAttemptsStartedHere: 1 });
    expect(rebuildPresence(home)).toBe(1);
    expect(hubRows().map((row) => row.workspace)).toEqual(["bravo"]);
  });

  it("keys each database's rows by the hub row registered for its path, not the slug it stamps itself", () => {
    const one = workspace("alpha");
    const two = workspace("bravo");
    const a = one.createIssue({ title: "A" });
    one.checkoutIssue(a.id, "agent-1");
    // bravo's file claims alpha's slug (a copy, a re-registration elsewhere).
    two.db.prepare("UPDATE meta SET value = 'alpha' WHERE key = 'slug'").run();
    const b = two.createIssue({ title: "B" });
    two.checkoutIssue(b.id, "agent-2");
    expect(hubRows().map((row) => row.workspace)).toEqual(["alpha", "bravo"]);
    expect(lastConcurrency(two, b.id)).toMatchObject({ storedOpenAttemptsStartedHere: 2 });
  });

  it("a full rebuild restores what a skipped refresh missed", () => {
    const one = workspace("alpha");
    const a = one.createIssue({ title: "A" });
    one.checkoutIssue(a.id, "agent-1");
    const hub = new DatabaseSync(join(home, "hub.db"));
    hub.exec("DELETE FROM attempt_presence");
    hub.close();
    expect(rebuildPresence(home)).toBe(1);
    expect(hubRows()).toEqual([{ workspace: "alpha", attempt_id: attemptsOfIssue(one.db, a.id)[0]!.id, account_ref: null, ended_at: null }]);
  });
});

describe("an end pulled from another device", () => {
  let fleet: Fleet | null = null;
  afterEach(() => {
    fleet?.close();
    fleet = null;
  });

  it("reaches the opener's index: hub state is machine state, and an apply may write it", async () => {
    const REPO = "5eed0000-0000-4000-8000-0000000a7e02";
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    const sync = async (...machines: Machine[]) => {
      for (const machine of machines) {
        machine.use();
        await machine.sync();
      }
    };
    a.use();
    const issue = a.store.createIssue({ title: "Stolen" });
    a.store.checkoutIssue(issue.id, "agent-a");
    await sync(a, b);
    const rowsOf = (machine: Machine) => {
      const hub = new DatabaseSync(join(machine.home, "hub.db"), { readOnly: true });
      try {
        return hub.prepare("SELECT attempt_id, ended_at FROM attempt_presence").all() as Array<{ attempt_id: string; ended_at: string | null }>;
      } finally {
        hub.close();
      }
    };
    // Only the machine that opened it indexes it.
    expect(rowsOf(a)).toMatchObject([{ ended_at: null }]);
    expect(rowsOf(b)).toEqual([]);
    b.use();
    b.store.checkoutIssue(issue.id, "agent-b", undefined, { stealIfIdleSeconds: 0 });
    await sync(b, a);
    expect(rowsOf(a)[0]!.ended_at).not.toBeNull();
    expect(rowsOf(b).map((row) => row.ended_at)).toEqual([null]);
  }, 60_000);
});
