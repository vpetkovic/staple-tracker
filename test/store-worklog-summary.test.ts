import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { WORKLOG_KEY, type WorklogSummary } from "../src/core/types.js";

/**
 * W1 (STA-113) — the ONE server-side definition of "latest worklog".
 *
 * The whole point of this method is that the row cue (W4), the Overview panel (W3)
 * and the handoff filter (W5) read the same fact from the same place and therefore
 * cannot disagree. So the load-bearing test here is not "it returns a shape" — it is
 * that the BATCHED read agrees, field for field, with what a caller would get by
 * walking `listDocuments` one issue at a time. If those two ever diverge, the epic's
 * central premise is gone and no UI test would notice.
 *
 * It mirrors `claimActivityFor`'s contract deliberately, including the part that is
 * easy to get wrong: an issue with no worklog is ABSENT from the map, not present
 * with a null value. Callers already know that shape.
 */

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
beforeEach(() => {
  store = memStore();
});

function newIssue(title: string): string {
  return store.createIssue({ title }).id;
}

/**
 * The independent oracle: what a caller gets today, per issue, with no batching.
 * Written from `listDocuments` + `listDocumentRevisions` — the two methods that
 * already exist — so it shares no code with the implementation under test.
 */
function summaryViaListDocuments(issueId: string): WorklogSummary | null {
  const meta = store.listDocuments(issueId).find((d) => d.key === WORKLOG_KEY);
  if (!meta) return null;
  const current = store
    .listDocumentRevisions(issueId, WORKLOG_KEY)
    .find((r) => r.revision === meta.currentRevision)!;
  return {
    key: meta.key,
    revisions: meta.currentRevision,
    updatedAt: meta.updatedAt,
    author: current.author,
  };
}

describe("store.worklogSummaryFor — the batched read agrees with the per-issue read", () => {
  it("matches listDocuments across a mixed fixture: none, one revision, many revisions", () => {
    const none = newIssue("Nothing written down");
    const one = newIssue("One checkpoint");
    const many = newIssue("Checkpointed properly");

    store.putDocument(one, WORKLOG_KEY, "## Done\nstarted\n", { author: "agent-a" });

    store.putDocument(many, WORKLOG_KEY, "## Done\nr1\n", { author: "agent-b" });
    store.putDocument(many, WORKLOG_KEY, "## Done\nr2\n", { author: "agent-b" });
    store.putDocument(many, WORKLOG_KEY, "## Done\nr3\n", { author: "agent-c" });

    const batched = store.worklogSummaryFor([none, one, many]);

    for (const id of [none, one, many]) {
      expect(batched.get(id) ?? null).toEqual(summaryViaListDocuments(id));
    }

    // And spelled out, so a failure names which fact broke rather than just "not equal".
    expect(batched.has(none)).toBe(false);
    expect(batched.get(one)!.revisions).toBe(1);
    expect(batched.get(one)!.author).toBe("agent-a");
    expect(batched.get(many)!.revisions).toBe(3);
    expect(batched.get(many)!.key).toBe(WORKLOG_KEY);
  });

  it("reports the author of the CURRENT revision, not the first one", () => {
    const id = newIssue("Handed over mid-flight");
    store.putDocument(id, WORKLOG_KEY, "r1", { author: "first-agent" });
    store.putDocument(id, WORKLOG_KEY, "r2", { author: "rescue-agent" });
    expect(store.worklogSummaryFor([id])!.get(id)!.author).toBe("rescue-agent");
  });

  it("carries a null author rather than dropping the row when nobody signed the revision", () => {
    const id = newIssue("Unsigned");
    store.putDocument(id, WORKLOG_KEY, "written by nobody");
    const summary = store.worklogSummaryFor([id]).get(id)!;
    expect(summary.author).toBeNull();
    expect(summary.revisions).toBe(1);
  });

  it("an issue with no worklog is ABSENT from the map, not present-and-null", () => {
    const id = newIssue("Nothing written down");
    const map = store.worklogSummaryFor([id]);
    expect(map.has(id)).toBe(false);
    expect(map.size).toBe(0);
  });

  it("ignores documents under other keys — a plan is not a worklog", () => {
    const id = newIssue("Planned, never checkpointed");
    store.putDocument(id, "plan", "the plan", { author: "agent-a" });
    // STA-97 keeps its plan under `row-spec`; free-form keys are the norm, not the exception.
    store.putDocument(id, "row-spec", "the spec", { author: "agent-a" });
    expect(store.worklogSummaryFor([id]).has(id)).toBe(false);
  });

  it("returns an empty map for an empty id list without touching the database", () => {
    expect(store.worklogSummaryFor([]).size).toBe(0);
  });

  it("returns nothing for ids that do not exist rather than throwing", () => {
    expect(store.worklogSummaryFor(["not-a-real-uuid"]).size).toBe(0);
  });

  it("keys the map by issue id and never leaks another issue's worklog", () => {
    const mine = newIssue("Mine");
    const yours = newIssue("Yours");
    store.putDocument(mine, WORKLOG_KEY, "mine", { author: "me" });
    store.putDocument(yours, WORKLOG_KEY, "yours", { author: "you" });

    const only = store.worklogSummaryFor([mine]);
    expect(only.size).toBe(1);
    expect(only.get(mine)!.author).toBe("me");
    expect(only.has(yours)).toBe(false);
  });

  it("reads updatedAt straight from documents.updated_at — the ONE freshness reading", () => {
    const id = newIssue("Freshness");
    store.putDocument(id, WORKLOG_KEY, "r1", { author: "agent-a" });
    const backdated = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    store.db
      .prepare("UPDATE documents SET updated_at = ? WHERE issue_id = ? AND key = ?")
      .run(backdated, id, WORKLOG_KEY);
    expect(store.worklogSummaryFor([id]).get(id)!.updatedAt).toBe(backdated);
    expect(store.worklogSummaryFor([id]).get(id)!.updatedAt).toBe(
      summaryViaListDocuments(id)!.updatedAt,
    );
  });

  it("does one query for the whole page, not one per issue", () => {
    // The reason the method exists at all: 114 rows must not become 114 lookups.
    // Counting prepares is the only observable proof from outside the method.
    const ids = Array.from({ length: 20 }, (_, i) => {
      const id = newIssue(`Task ${i}`);
      if (i % 2 === 0) store.putDocument(id, WORKLOG_KEY, `r${i}`, { author: "agent-a" });
      return id;
    });

    const realPrepare = store.db.prepare.bind(store.db);
    let prepares = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store.db as any).prepare = (sql: string) => {
      prepares += 1;
      return realPrepare(sql);
    };
    try {
      const map = store.worklogSummaryFor(ids);
      expect(map.size).toBe(10);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store.db as any).prepare = realPrepare;
    }
    expect(prepares).toBe(1);
  });
});
