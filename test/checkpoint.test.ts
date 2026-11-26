/**
 * `writeCheckpoint`: one call replaces a ticket's worklog with Done, Next and Files touched,
 * and sets its branch through the same write `staple branch` makes. The revision and the
 * branch replicate like any document and branch write.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointBody, writeCheckpoint } from "../src/core/checkpoint.js";
import { checkpointedSince } from "../src/core/run-worklog.js";
import { setTicketBranch, ticketBranch } from "../src/core/ticket-branch.js";
import { StapleError } from "../src/core/types.js";
import { initWorkspace } from "../src/core/workspace.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  if (previous === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previous;
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "staple-checkpoint-"));
  dirs.push(home);
  process.env.STAPLE_HOME = home;
  const store = initWorkspace({ global: true, slug: "checkpoint-tests" }).store;
  const task = store.createIssue({ title: "Hand me off" });
  return { store, task };
}

function revisions(store: ReturnType<typeof setup>["store"], id: string) {
  return store.listDocumentRevisions(id, "worklog").length;
}

function caught(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StapleError) return error;
    throw error;
  }
  throw new Error("expected a StapleError");
}

describe("a checkpoint", () => {
  it("writes the worklog as Done, Next and Files touched, in that order", () => {
    const { store, task } = setup();
    const result = writeCheckpoint(store, task.identifier, { done: "Wrote the parser.", next: "Wire the CLI.", filesTouched: "src/parse.ts" }, "ada");
    const doc = store.getDocument(task.id, "worklog");
    expect(doc.body).toBe("## Done\n\nWrote the parser.\n\n## Next\n\nWire the CLI.\n\n## Files touched\n\nsrc/parse.ts\n");
    expect(doc.author).toBe("ada");
    expect(result).toMatchObject({ ref: task.identifier, key: "worklog", revision: 1, body: doc.body, branch: null, branchChanged: false });
    // A full checkpoint satisfies the run's handoff check.
    expect(checkpointedSince(store, task.id, new Date(0).toISOString())).toBe(true);
    store.db.close();
  });

  it("replaces the previous checkpoint with a new revision instead of appending to it", () => {
    const { store, task } = setup();
    writeCheckpoint(store, task.id, { done: "first", next: "second", filesTouched: "a.ts" }, "ada");
    const second = writeCheckpoint(store, task.id, { done: "second", next: "third", filesTouched: "b.ts" }, "ada");
    expect(second.revision).toBe(2);
    const body = store.getDocument(task.id, "worklog").body;
    expect(body).toBe(checkpointBody({ done: "second", next: "third", filesTouched: "b.ts" }));
    expect(body).not.toContain("first");
    expect(body.match(/^## Done$/gm)).toHaveLength(1);
    expect(revisions(store, task.id)).toBe(2);
    store.db.close();
  });

  it("stores an omitted section as its heading with nothing under it, and still succeeds", () => {
    const { store, task } = setup();
    const result = writeCheckpoint(store, task.id, { done: "Only this." }, "ada");
    expect(result.body).toBe("## Done\n\nOnly this.\n\n## Next\n\n## Files touched\n");
    expect(writeCheckpoint(store, task.id, {}, "ada").body).toBe("## Done\n\n## Next\n\n## Files touched\n");
    // A blank section is as thin as an omitted one, and the run's check says so.
    expect(writeCheckpoint(store, task.id, { done: "x", next: "  \n", filesTouched: "y" }, "ada").body).toBe("## Done\n\nx\n\n## Next\n\n## Files touched\n\ny\n");
    expect(checkpointedSince(store, task.id, new Date(0).toISOString())).toBe(false);
    store.db.close();
  });

  it("sets the ticket's branch through the branch write, in the same call", () => {
    const { store, task } = setup();
    const result = writeCheckpoint(store, task.id, { done: "d", next: "n", filesTouched: "f", branch: "feat/hand-off" }, "ada");
    expect(result).toMatchObject({ branchChanged: true, branch: { name: "feat/hand-off", source: "field", setBy: "ada" } });
    expect(ticketBranch(store, task.id)).toMatchObject({ name: "feat/hand-off", source: "field" });
    expect(store.db.prepare("SELECT kind FROM events WHERE issue_id = ? AND kind IN ('branch_set', 'doc_updated') ORDER BY seq").all(task.id)).toEqual([
      { kind: "branch_set" },
      { kind: "doc_updated" },
    ]);
    store.db.close();
  });

  it("leaves the branch and its base as they were when no branch is given", () => {
    const { store, task } = setup();
    setTicketBranch(store, task.id, { branch: "feat/kept", base: "abc1234" }, "ada");
    const result = writeCheckpoint(store, task.id, { done: "d" }, "bob");
    expect(result).toMatchObject({ branchChanged: false, branch: { name: "feat/kept", base: "abc1234", setBy: "ada" } });
    // The same branch again keeps its base: the branch write's own rule.
    expect(writeCheckpoint(store, task.id, { branch: "feat/kept" }, "bob")).toMatchObject({ branchChanged: false, branch: { base: "abc1234" } });
    store.db.close();
  });

  it("refuses a blank or malformed branch before writing anything", () => {
    const { store, task } = setup();
    for (const branch of ["", "   ", "not a branch"]) {
      const error = caught(() => writeCheckpoint(store, task.id, { done: "d", branch }, "ada"));
      expect(error.code, branch).toBe("validation");
    }
    expect(revisions(store, task.id)).toBe(0);
    expect(ticketBranch(store, task.id)).toBeNull();
    store.db.close();
  });

  it("writes neither the worklog nor the branch when the worklog write fails", () => {
    const { store, task } = setup();
    const put = store.putDocument.bind(store);
    store.putDocument = () => {
      throw new StapleError("conflict", "simulated");
    };
    expect(caught(() => writeCheckpoint(store, task.id, { done: "d", branch: "feat/never" }, "ada")).code).toBe("conflict");
    store.putDocument = put;
    expect(ticketBranch(store, task.id)).toBeNull();
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE issue_id = ? AND kind = 'branch_set'").get(task.id)).toEqual({ n: 0 });
    store.db.close();
  });

  it("answers not_found for a ticket that does not exist", () => {
    const { store, task } = setup();
    const missing = task.identifier.replace(/\d+$/, "999");
    expect(caught(() => writeCheckpoint(store, missing, { done: "d" }, "ada")).code).toBe("not_found");
    expect(caught(() => writeCheckpoint(store, missing, { done: "d", branch: "feat/x" }, "ada")).code).toBe("not_found");
    store.db.close();
  });
});

describe("a checkpoint on two devices", () => {
  it("converges: the other device reads the same worklog and branch, and a later checkpoint replaces both", async () => {
    const repo = "5eed0000-0000-4000-8000-000000000377";
    fleet = new Fleet(new FakeSyncServer({ repositoryId: repo }), repo);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    const issue = a.store.createIssue({ title: "Synced handoff" });
    writeCheckpoint(a.store, issue.id, { done: "on a", next: "go to b", filesTouched: "a.ts", branch: "feat/on-a" }, "alice");
    await a.sync();
    b.use();
    await b.sync();
    expect(b.store.getDocument(issue.id, "worklog")).toMatchObject({ revision: 1, body: checkpointBody({ done: "on a", next: "go to b", filesTouched: "a.ts" }) });
    expect(ticketBranch(b.store, issue.id)).toMatchObject({ name: "feat/on-a", source: "field" });

    writeCheckpoint(b.store, issue.id, { done: "on b", branch: "feat/on-b" }, "bob");
    await b.sync();
    a.use();
    await a.sync();
    for (const machine of [a, b]) {
      machine.use();
      expect(machine.store.getDocument(issue.id, "worklog"), machine.label).toMatchObject({ revision: 2, body: "## Done\n\non b\n\n## Next\n\n## Files touched\n" });
      expect(ticketBranch(machine.store, issue.id), machine.label).toMatchObject({ name: "feat/on-b" });
    }
  });
});
