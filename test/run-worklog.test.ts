import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { checkpointedSince } from "../src/core/run-worklog.js";

let store: WorkspaceStore;
let issue: string;
const body = "## Done\n- Implemented.\n## Next\n- Review.\n## Files touched\n- src/example.ts\n";

beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  issue = store.createIssue({ title: "Resumable work" }).id;
});
afterEach(() => store.db.close());

describe("automated handoff checkpoint", () => {
  it("does not mistake milestone comments or a plan for a worklog", () => {
    store.addComment(issue, body, "worker");
    store.putDocument(issue, "plan", body);
    expect(checkpointedSince(store, issue, "2020-01-01T00:00:00Z")).toBe(false);
  });

  it("requires a checkpoint from this tenure, even when old notes are complete", () => {
    store.putDocument(issue, "worklog", body);
    const at = store.getDocument(issue, "worklog").createdAt;
    expect(checkpointedSince(store, issue, at)).toBe(true);
    expect(checkpointedSince(store, issue, new Date(Date.parse(at) + 1).toISOString())).toBe(false);
  });

  it.each(["", "\n ", "## Done\n- Implemented.", "## Done\n- Implemented.\n## Next\n## Files touched\n- src/example.ts"])("rejects an incomplete latest checkpoint: %j", (incomplete) => {
    store.putDocument(issue, "worklog", body);
    store.putDocument(issue, "worklog", incomplete);
    expect(checkpointedSince(store, issue, "2020-01-01T00:00:00Z")).toBe(false);
  });

  it("accepts explicit none and case-insensitive headings", () => {
    store.putDocument(issue, "worklog", "# WORKLOG\r\n### DONE\r\nNone\r\n### NEXT\r\nNone\r\n### FILES TOUCHED\r\nNone");
    expect(checkpointedSince(store, issue, "2020-01-01T00:00:00Z")).toBe(true);
  });
});
