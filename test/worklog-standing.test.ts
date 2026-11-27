import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { assertHandoffStatus, assertHandoffWorklog, holderWorklog, worklogNudge } from "../src/core/worklog-standing.js";

let store: WorkspaceStore;
let ref: string;
const complete = "## Done\n- Parsed it.\n## Next\n- Wire it.\n## Files touched\n- src/a.ts\n";
const start = new Date("2026-11-27T10:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  ref = store.createIssue({ title: "Hand off", assignee: "worker" }).identifier;
});
afterEach(() => {
  store.db.close();
  vi.useRealTimers();
});

const later = (minutes: number) => vi.setSystemTime(new Date(start.getTime() + minutes * 60_000));

function refusal(fn: () => void): StapleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StapleError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the holder's worklog standing", () => {
  it("is nobody's business but the holder's", () => {
    expect(holderWorklog(store, ref, "worker")).toBeNull();
    store.checkoutIssue(ref, "worker");
    expect(holderWorklog(store, ref, "someone-else")).toBeNull();
    expect(holderWorklog(store, ref, null)).toBeNull();
  });

  it("is missing until the holder checkpoints, and a predecessor's worklog does not count", () => {
    store.putDocument(ref, "worklog", complete, { author: "predecessor" });
    later(1);
    store.checkoutIssue(ref, "worker");
    const standing = holderWorklog(store, ref, "worker")!;
    expect(standing).toMatchObject({ state: "missing", revision: 1, author: "predecessor" });
    expect(standing.action).toContain("written before you took it (predecessor");
    expect(standing.action).toContain(`staple checkpoint ${ref}`);
  });

  it("is incomplete while a section is empty, current once all three have content", () => {
    store.checkoutIssue(ref, "worker");
    store.putDocument(ref, "worklog", "## Done\n- Parsed it.\n## Next\n## Files touched\n", { author: "worker" });
    expect(holderWorklog(store, ref, "worker")!.state).toBe("incomplete");
    store.putDocument(ref, "worklog", complete, { author: "worker" });
    expect(holderWorklog(store, ref, "worker")).toMatchObject({ state: "current", action: null });
  });

  it("falls behind once the holder has kept writing for an hour past its last checkpoint", () => {
    store.checkoutIssue(ref, "worker");
    store.putDocument(ref, "worklog", complete, { author: "worker" });
    later(59);
    store.addComment(ref, "milestone: parsed", "worker");
    expect(holderWorklog(store, ref, "worker")!.state).toBe("current");
    later(60);
    store.addComment(ref, "milestone: wired", "worker");
    expect(holderWorklog(store, ref, "worker")!.state).toBe("behind");
    expect(worklogNudge(store, ref, "worker").worklog?.action).toContain("kept working");
  });

  it("stays current through a long silence: a build or a usage-limit pause changes nothing it says", () => {
    store.checkoutIssue(ref, "worker");
    store.putDocument(ref, "worklog", complete, { author: "worker" });
    later(5 * 60);
    expect(holderWorklog(store, ref, "worker")!.state).toBe("current");
    // Somebody else's comment is not the holder working.
    store.addComment(ref, "any news?", "vp");
    expect(holderWorklog(store, ref, "worker")!.state).toBe("current");
  });

  it("nudges only when there is something to do", () => {
    store.checkoutIssue(ref, "worker");
    expect(worklogNudge(store, ref, "worker").worklog?.state).toBe("missing");
    expect(worklogNudge(store, ref, "someone-else")).toEqual({});
    store.putDocument(ref, "worklog", complete, { author: "worker" });
    expect(worklogNudge(store, ref, "worker")).toEqual({});
  });
});

describe("handing a ticket on", () => {
  it("refuses the holder without a current worklog, naming the checkpoint", () => {
    store.checkoutIssue(ref, "worker");
    const error = refusal(() => assertHandoffWorklog(store, ref, "worker", "release"));
    expect(error.code).toBe("validation");
    expect(error.message).toContain("Checkpoint before you hand this on (release)");
    expect(error.message).toContain(`staple checkpoint ${ref}`);
    expect(error.detail).toMatchObject({ worklog: { state: "missing" } });
    store.putDocument(ref, "worklog", complete, { author: "worker" });
    expect(() => assertHandoffWorklog(store, ref, "worker", "release")).not.toThrow();
  });

  it("lets a non-holder through: a person closing an agent's ticket", () => {
    store.checkoutIssue(ref, "worker");
    expect(() => assertHandoffWorklog(store, ref, "vp", "done")).not.toThrow();
  });

  // todo and backlog clear the claim as a release does.
  it.each(["in_review", "done", "blocked", "todo", "backlog"])("checks a move into %s", (status) => {
    store.checkoutIssue(ref, "worker");
    expect(refusal(() => assertHandoffStatus(store, ref, status, "worker")).message).toContain(`status ${status}`);
  });

  it.each(["cancelled", "in_progress", undefined])("does not check %s", (status) => {
    store.checkoutIssue(ref, "worker");
    expect(() => assertHandoffStatus(store, ref, status, "worker")).not.toThrow();
  });
});
