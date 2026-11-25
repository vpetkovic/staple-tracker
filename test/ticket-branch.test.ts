import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { initWorkspace } from "../src/core/workspace.js";
import { setTicketBranch, ticketBranch, ticketBranches } from "../src/core/ticket-branch.js";

const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  if (previous === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previous;
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "staple-ticket-branch-"));
  dirs.push(home);
  process.env.STAPLE_HOME = home;
  return initWorkspace({ global: true, slug: "branch-tests" }).store;
}

describe("the ticket branch", () => {
  it("stores a branch and a base commit, and never touches status", () => {
    const store = setup();
    const task = store.createIssue({ title: "Branch me" });
    const before = store.getIssue(task.id);
    const set = setTicketBranch(store, task.identifier, { branch: "feat/branch-me", base: "3F2A1BC" }, "ada");
    expect(set).toMatchObject({ changed: true, branch: { name: "feat/branch-me", base: "3f2a1bc", source: "field", setBy: "ada" } });
    const after = store.getIssue(task.id);
    expect(after.status).toBe(before.status);
    expect(after.checkoutAgent).toBe(before.checkoutAgent);
    expect(store.db.prepare("SELECT kind, actor FROM events WHERE issue_id = ? AND kind = 'branch_set'").all(task.id)).toEqual([{ kind: "branch_set", actor: "ada" }]);
    // The same values again write nothing.
    expect(setTicketBranch(store, task.id, { branch: "feat/branch-me" }, "ada")).toMatchObject({ changed: false, branch: { base: "3f2a1bc" } });
    // A new branch drops the old base unless a new one comes with it.
    expect(setTicketBranch(store, task.id, { branch: "feat/second" }, "ada").branch).toMatchObject({ name: "feat/second", base: null });
    expect(setTicketBranch(store, task.id, { branch: null }, "ada")).toMatchObject({ changed: true, branch: null });
    store.db.close();
  });

  it("replicates the branch as issue fields", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    writeStoredRepositoryId(db, "0e77fa01-1111-4222-8333-444455556666");
    bindJournal(db, "device-branch");
    const store = new WorkspaceStore(db, "test", "TST");
    const task = store.createIssue({ title: "Synced branch" });
    setTicketBranch(store, task.id, { branch: "feat/synced", base: "abcdef1" }, "ada");
    const ops = store.db.prepare("SELECT payload FROM sync_outbox WHERE entity_id = ? ORDER BY rowid").all(task.id) as Array<{ payload: string }>;
    expect(ops.map((op) => JSON.parse(op.payload)).some((p) => p.branch === "feat/synced" && p.baseCommit === "abcdef1")).toBe(true);
    store.db.close();
  });

  it("reads an existing branch-pointer comment while the field is empty, and the field wins once set", () => {
    const store = setup();
    const task = store.createIssue({ title: "Pointer" });
    const other = store.createIssue({ title: "Nothing" });
    store.addComment(task.id, "Looks good.", "eng-1");
    store.addComment(task.id, "Branch pointer: worktree /wt on branch feat/pointer, base 7d1e2f3.", "eng-1");
    expect(ticketBranch(store, task.id)).toMatchObject({ name: "feat/pointer", base: "7d1e2f3", source: "comment", setBy: "eng-1" });
    expect(ticketBranch(store, other.id)).toBeNull();
    // Reading fills the answer, not the column.
    expect(store.db.prepare("SELECT branch FROM issues WHERE id = ?").get(task.id)).toEqual({ branch: null });
    setTicketBranch(store, task.id, { branch: "feat/field" }, "ada");
    expect(ticketBranches(store, [task.id, other.id]).get(task.id)).toMatchObject({ name: "feat/field", source: "field" });
    store.db.close();
  });

  it("refuses a name git would not take and a base that is not a commit", () => {
    const store = setup();
    const task = store.createIssue({ title: "Refusals" });
    for (const bad of ["", "has space", "-leading", "a..b", "ends/", "x.lock", "a@{1}"]) {
      expect(() => setTicketBranch(store, task.id, { branch: bad }, "ada")).toThrow(/branch name/);
    }
    expect(() => setTicketBranch(store, task.id, { branch: "feat/x", base: "main" }, "ada")).toThrow(/not a commit/);
    expect(() => setTicketBranch(store, task.id, { branch: null, base: "abcdef1" }, "ada")).toThrow(/needs a branch/);
    store.db.close();
  });
});
