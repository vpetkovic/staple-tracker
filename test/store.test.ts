import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { WORKSPACE_SCHEMA_VERSION, migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import {
  ISSUE_PAGE_LIMITS,
  StapleError,
  clampLimit,
  cursorScope,
  decodeOffsetCursor,
  decodeSeqCursor,
  encodeOffsetCursor,
  encodeSeqCursor,
} from "../src/core/types.js";

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
beforeEach(() => {
  store = memStore();
});

describe("creation", () => {
  it("mints sequential identifiers and defaults status by assignment", () => {
    const a = store.createIssue({ title: "First" });
    const b = store.createIssue({ title: "Second", assignee: "claude" });
    expect(a.identifier).toBe("TST-1");
    expect(b.identifier).toBe("TST-2");
    expect(a.status).toBe("backlog");
    expect(b.status).toBe("todo");
  });

  it("replays idempotency keys instead of duplicating", () => {
    const a = store.createIssue({ title: "Once", idempotencyKey: "k1" });
    const b = store.createIssue({ title: "Once again", idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
    expect(store.listIssues({ includeResolved: true })).toHaveLength(1);
  });

  it("reports whether an idempotent create wrote or replayed", () => {
    const fresh = store.createIssueResult({ title: "Once", idempotencyKey: "k1" });
    expect(fresh.replayed).toBe(false);
    const replay = store.createIssueResult({ title: "Once again", idempotencyKey: "k1" });
    expect(replay.replayed).toBe(true);
    expect(replay.issue.id).toBe(fresh.issue.id);
    // No key at all is always a fresh write, never a silent replay.
    expect(store.createIssueResult({ title: "Different" }).replayed).toBe(false);
  });

  it("rejects duplicate open titles among siblings unless allowed", () => {
    store.createIssue({ title: "Fix  the   build" });
    expect(() => store.createIssue({ title: "fix the build" })).toThrowError(/already exists/);
    const dup = store.createIssue({ title: "fix the build", allowDuplicate: true });
    expect(dup.identifier).toBe("TST-2");
    // Same title under a different parent is fine.
    const parent = store.createIssue({ title: "Parent" });
    expect(() =>
      store.createChild(parent.identifier, { title: "fix the build" }),
    ).not.toThrow();
  });

  it("caps one live machine-origin issue per source", () => {
    store.createIssue({ title: "Watchdog A", originKind: "watchdog", originId: "w1" });
    expect(() =>
      store.createIssue({ title: "Watchdog A again", originKind: "watchdog", originId: "w1", allowDuplicate: true }),
    ).toThrow();
  });

  it("requires blocked status for unblock descriptor", () => {
    expect(() =>
      store.createIssue({ title: "X", unblockOwner: "vlad", unblockAction: "approve budget" }),
    ).toThrowError(/blocked/);
    const ok = store.createIssue({
      title: "X",
      status: "blocked",
      unblockOwner: "vlad",
      unblockAction: "approve budget",
    });
    expect(ok.unblockOwner).toBe("vlad");
    expect(ok.blockedTransitionAt).toBeTruthy();
  });
});

describe("status guards", () => {
  it("refuses in_progress without an assignee", () => {
    const issue = store.createIssue({ title: "Solo" });
    expect(() => store.updateIssue(issue.id, { status: "in_progress" })).toThrowError(/assignee/);
    const ok = store.updateIssue(issue.id, { status: "in_progress", assignee: "claude" });
    expect(ok.startedAt).toBeTruthy();
    expect(ok.statusVersion).toBe(1);
  });

  it("refuses in_progress while blockers are unresolved", () => {
    const blocker = store.createIssue({ title: "Blocker" });
    const dependent = store.createIssue({ title: "Dependent", blockedBy: [blocker.id] });
    expect(() =>
      store.updateIssue(dependent.id, { status: "in_progress", assignee: "claude" }),
    ).toThrowError(/unresolved blockers TST-1/);
    store.updateIssue(blocker.id, { status: "done" });
    expect(() =>
      store.updateIssue(dependent.id, { status: "in_progress", assignee: "claude" }),
    ).not.toThrow();
  });

  it("stamps and clears blocked state", () => {
    const issue = store.createIssue({ title: "B" });
    const blocked = store.updateIssue(issue.id, {
      status: "blocked",
      unblockOwner: "vlad",
      unblockAction: "answer the question",
    });
    expect(blocked.blockedTransitionAt).toBeTruthy();
    const back = store.updateIssue(issue.id, { status: "todo" });
    expect(back.unblockOwner).toBeNull();
    expect(back.blockedTransitionAt).toBeNull();
  });

  it("enforces expectedStatusVersion optimistic concurrency", () => {
    const issue = store.createIssue({ title: "V" });
    store.updateIssue(issue.id, { status: "todo" });
    expect(() =>
      store.updateIssue(issue.id, { status: "done", expectedStatusVersion: 0 }),
    ).toThrowError(/version mismatch/i);
  });
});

describe("checkout", () => {
  it("claims atomically and refuses the loser with pick-another guidance", () => {
    const issue = store.createIssue({ title: "Claim me" });
    const won = store.checkoutIssue(issue.id, "agent-a");
    expect(won.status).toBe("in_progress");
    expect(won.checkoutAgent).toBe("agent-a");
    try {
      store.checkoutIssue(issue.id, "agent-b");
      expect.unreachable();
    } catch (error) {
      const e = error as StapleError;
      expect(e.code).toBe("conflict");
      expect(e.message).toMatch(/Pick a different task/);
    }
  });

  it("is idempotent for the same agent (crash re-claim)", () => {
    const issue = store.createIssue({ title: "Mine" });
    store.checkoutIssue(issue.id, "agent-a");
    const again = store.checkoutIssue(issue.id, "agent-a");
    expect(again.checkoutAgent).toBe("agent-a");
  });

  it("refuses checkout while blockers are unresolved", () => {
    const blocker = store.createIssue({ title: "Gate" });
    const dependent = store.createIssue({ title: "Waits", blockedBy: [blocker.id] });
    expect(() => store.checkoutIssue(dependent.id, "agent-a")).toThrowError(/unresolved blockers/);
  });

  it("release returns the issue to todo and clears the claim", () => {
    const issue = store.createIssue({ title: "R" });
    store.checkoutIssue(issue.id, "agent-a");
    expect(() => store.releaseIssue(issue.id, "agent-b")).toThrowError(/held by agent-a/);
    const released = store.releaseIssue(issue.id, "agent-a");
    expect(released.status).toBe("todo");
    expect(released.checkoutAgent).toBeNull();
  });
});

describe("dependencies", () => {
  it("rejects self-blocking and cycles", () => {
    const a = store.createIssue({ title: "A" });
    const b = store.createIssue({ title: "B" });
    const c = store.createIssue({ title: "C" });
    expect(() => store.setBlockedBy(a.id, [a.id])).toThrowError(/itself/);
    store.setBlockedBy(b.id, [a.id]); // A -> B
    store.setBlockedBy(c.id, [b.id]); // B -> C
    expect(() => store.setBlockedBy(a.id, [c.id])).toThrowError(/cycles/);
  });

  it("emits blockers_resolved exactly once per ready state, re-arming on a new blocked cycle", () => {
    const a = store.createIssue({ title: "A" });
    const b = store.createIssue({ title: "B" });
    const dependent = store.createIssue({ title: "D", assignee: "claude", blockedBy: [a.id, b.id] });

    store.updateIssue(a.id, { status: "done" });
    let wakes = store.listEvents().filter((e) => e.kind === "blockers_resolved");
    expect(wakes).toHaveLength(0); // B still open

    store.updateIssue(b.id, { status: "done" });
    wakes = store.listEvents().filter((e) => e.kind === "blockers_resolved");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.issueId).toBe(dependent.id);

    // Level-triggered: re-resolving the same state does not duplicate.
    store.updateIssue(b.id, { status: "todo" });
    store.updateIssue(b.id, { status: "done" });
    wakes = store.listEvents().filter((e) => e.kind === "blockers_resolved");
    expect(wakes).toHaveLength(1);

    // A NEW blocked cycle on the dependent re-arms the wake.
    store.updateIssue(dependent.id, { status: "blocked" });
    store.updateIssue(b.id, { status: "todo" });
    store.updateIssue(b.id, { status: "done" });
    wakes = store.listEvents().filter((e) => e.kind === "blockers_resolved");
    expect(wakes).toHaveLength(2);
  });

  it("emits children_complete for the parent once all children resolve", () => {
    const parent = store.createIssue({ title: "P", assignee: "claude" });
    const c1 = store.createChild(parent.id, { title: "c1" });
    const c2 = store.createChild(parent.id, { title: "c2" });
    store.updateIssue(c1.id, { status: "done" });
    expect(store.listEvents().filter((e) => e.kind === "children_complete")).toHaveLength(0);
    store.updateIssue(c2.id, { status: "cancelled" });
    const events = store.listEvents().filter((e) => e.kind === "children_complete");
    expect(events).toHaveLength(1);
    expect(events[0]!.issueId).toBe(parent.id);
  });

  it("blockParentUntilDone creates a real dependency edge", () => {
    const parent = store.createIssue({ title: "P", assignee: "claude" });
    const child = store.createChild(parent.id, { title: "c", blockParentUntilDone: true });
    // A sibling keeps the parent open, so this test pins the EDGE and nothing
    // else: the parent is unstartable while the blocker is open, startable once
    // it lands. (With no sibling the parent would auto-close instead — see
    // below.)
    const sibling = store.createChild(parent.id, { title: "s" });
    expect(() => store.checkoutIssue(parent.id, "claude")).toThrowError(/unresolved blockers/);
    store.updateIssue(child.id, { status: "done" });
    expect(() => store.checkoutIssue(parent.id, "claude")).not.toThrow();
    expect(store.getIssue(sibling.id).status).toBe("backlog");
  });

  it("a blocking child that is also the LAST child closes the parent instead", () => {
    // STA-153's consequence, stated rather than discovered: the parent's status
    // follows its children, so a parent whose only child lands is done — the
    // gate it was waiting behind opened and closed in the same move. A human who
    // wants the parent's own follow-up work says so by giving it a status, and
    // that statement is then immune to derivation.
    const parent = store.createIssue({ title: "P", assignee: "claude" });
    const child = store.createChild(parent.id, { title: "c", blockParentUntilDone: true });

    store.updateIssue(child.id, { status: "done" });

    expect(store.getIssue(parent.id).status).toBe("done");
  });
});

describe("comments", () => {
  it("replays an idempotency key instead of double-posting a retry", () => {
    const issue = store.createIssue({ title: "Chatty" });
    const first = store.addCommentResult(issue.id, "step 1 done", "claude", "agent", {
      idempotencyKey: "c1",
    });
    expect(first.replayed).toBe(false);
    const retry = store.addCommentResult(issue.id, "step 1 done", "claude", "agent", {
      idempotencyKey: "c1",
    });
    expect(retry.replayed).toBe(true);
    expect(retry.comment.id).toBe(first.comment.id);
    expect(store.listComments(issue.id)).toHaveLength(1);
    // The original body wins: a replay returns what was stored, not what was re-sent.
    const changed = store.addCommentResult(issue.id, "totally different", "other", "agent", {
      idempotencyKey: "c1",
    });
    expect(changed.comment.body).toBe("step 1 done");
    expect(changed.comment.author).toBe("claude");
  });

  it("scopes the key to one issue and treats a blank key as no key", () => {
    const a = store.createIssue({ title: "A" });
    const b = store.createIssue({ title: "B" });
    store.addComment(a.id, "same token, different issue", "claude", "agent", { idempotencyKey: "k" });
    store.addComment(b.id, "same token, different issue", "claude", "agent", { idempotencyKey: "k" });
    expect(store.listComments(a.id)).toHaveLength(1);
    expect(store.listComments(b.id)).toHaveLength(1);

    store.addComment(a.id, "untracked 1", "claude", "agent", { idempotencyKey: "   " });
    store.addComment(a.id, "untracked 2", "claude", "agent", {});
    expect(store.listComments(a.id)).toHaveLength(3);
    expect(store.listComments(a.id)[1]!.idempotencyKey).toBeNull();
  });
});

describe("pagination cursors", () => {
  const scope = cursorScope({ t: "list_tasks", assignee: "claude" });

  it("round-trips an offset and stays opaque", () => {
    const cursor = encodeOffsetCursor(50, scope);
    expect(cursor).not.toContain("50"); // opaque: not a number a caller can hand-craft
    expect(decodeOffsetCursor(cursor, scope)).toBe(50);
    expect(decodeSeqCursor(encodeSeqCursor(12))).toBe(12);
  });

  it("refuses a cursor issued for different arguments", () => {
    const cursor = encodeOffsetCursor(50, scope);
    const otherScope = cursorScope({ t: "list_tasks", assignee: "someone-else" });
    try {
      decodeOffsetCursor(cursor, otherScope);
      expect.unreachable();
    } catch (error) {
      const e = error as StapleError;
      expect(e.code).toBe("validation");
      expect(e.message).toMatch(/different arguments/);
    }
  });

  it("refuses garbage and cursors of the wrong kind", () => {
    expect(() => decodeOffsetCursor("not-a-cursor", scope)).toThrowError(/not a cursor/);
    expect(() => decodeOffsetCursor(encodeSeqCursor(3), scope)).toThrowError(/different kind/);
    expect(() => decodeSeqCursor(encodeOffsetCursor(3, scope))).toThrowError(/different kind/);
  });

  it("clamps limits to the surface's ceiling and rejects nonsense", () => {
    expect(clampLimit(undefined, ISSUE_PAGE_LIMITS)).toBe(ISSUE_PAGE_LIMITS.default);
    expect(clampLimit(10_000, ISSUE_PAGE_LIMITS)).toBe(ISSUE_PAGE_LIMITS.max);
    expect(clampLimit(7, ISSUE_PAGE_LIMITS)).toBe(7);
    expect(() => clampLimit(0, ISSUE_PAGE_LIMITS)).toThrowError(/positive integer/);
  });
});

describe("schema migration against a live database", () => {
  it("adds comment idempotency to a pre-existing workspace without disturbing its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "staple-migrate-"));
    try {
      // Build a database in the pre-idempotency shape, with real content in it.
      const legacyPath = join(dir, "tasks.db");
      const legacyDb = openDb(legacyPath);
      migrateWorkspace(legacyDb);
      const legacy = new WorkspaceStore(legacyDb, "legacy", "LEG");
      const issue = legacy.createIssue({ title: "Existing work", assignee: "claude" });
      legacy.addComment(issue.id, "historic note", "vlad", "user");
      // Rewind to the v1 shape: the column and its index disappear, the rows stay.
      legacyDb.exec("DROP INDEX IF EXISTS comments_idempotency_uq");
      legacyDb.exec("ALTER TABLE comments DROP COLUMN idempotency_key");
      // STA-81 added migration 003. This rewind builds a synthetic v1 out of a
      // CURRENT database, so every column a later migration introduced has to
      // come back off — otherwise the file is stamped '1' while carrying v3
      // columns, and 003 fails on "duplicate column name" rather than testing
      // anything. The genuine pre-estimate evidence lives in
      // test/fixtures/schema/workspace-v{1,2}.sqlite, which are real artefacts.
      legacyDb.exec("ALTER TABLE issues DROP COLUMN estimated_seconds");
      // STA-140 added migration 004, which creates TABLES rather than columns —
      // same rule, one level up: a synthetic v1 built out of a current database
      // has to lose them too, or 004 fails on "table already exists" instead of
      // testing the walk.
      legacyDb.exec("DROP TABLE IF EXISTS workspace_statuses");
      legacyDb.exec("DROP TABLE IF EXISTS workspace_kinds");
      // STA-124 added migration 005 — a column again, so the same rule as
      // `estimated_seconds` above: it has to come back off, or 005 fails on
      // "duplicate column name" instead of testing the walk.
      legacyDb.exec("ALTER TABLE issues DROP COLUMN kind");
      // STA-143 added migration 006: seven more columns and an index. Every one of
      // them has to come off for the same reason — a file stamped '1' that still
      // carries v6 columns tests the "duplicate column name" error path and
      // nothing else.
      legacyDb.exec("DROP INDEX IF EXISTS issues_gate_state_idx");
      for (const column of [
        "gate_state",
        "gate_owner",
        "gate_requested_by",
        "gate_requested_at",
        "gate_resolved_by",
        "gate_resolved_at",
        "gate_released",
      ]) {
        legacyDb.exec(`ALTER TABLE issues DROP COLUMN ${column}`);
      }
      // STA-172 added migration 007, two tables — the 004 rule again: a synthetic
      // v1 built out of a current database has to lose them, or 007 fails on
      // "table already exists" instead of testing the walk.
      legacyDb.exec("DROP TABLE IF EXISTS milestone_members");
      legacyDb.exec("DROP TABLE IF EXISTS milestone_meta");
      legacyDb.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
      legacyDb.close();

      // Migrate a copy, exactly as opening the workspace would.
      const copyPath = join(dir, "copy.db");
      copyFileSync(legacyPath, copyPath);
      const db = openDb(copyPath);
      migrateWorkspace(db);
      const store2 = new WorkspaceStore(db, "legacy", "LEG");

      expect(store2.listIssues().map((i) => i.identifier)).toEqual([issue.identifier]);
      const preserved = store2.listComments(issue.id);
      expect(preserved).toHaveLength(1);
      expect(preserved[0]!.body).toBe("historic note");
      expect(preserved[0]!.idempotencyKey).toBeNull();
      expect(
        (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string })
          .value,
      ).toBe(String(WORKSPACE_SCHEMA_VERSION));

      // The new guarantee holds on the migrated file...
      const first = store2.addCommentResult(issue.id, "retry me", "claude", "agent", {
        idempotencyKey: "r1",
      });
      const retry = store2.addCommentResult(issue.id, "retry me", "claude", "agent", {
        idempotencyKey: "r1",
      });
      expect(retry.replayed).toBe(true);
      expect(retry.comment.id).toBe(first.comment.id);
      expect(store2.listComments(issue.id)).toHaveLength(2);

      // ...and re-running the migration on an already-migrated file is a no-op.
      expect(() => migrateWorkspace(db)).not.toThrow();
      expect(store2.listComments(issue.id)).toHaveLength(2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("documents", () => {
  it("versions documents and enforces baseRevision optimistic concurrency", () => {
    const issue = store.createIssue({ title: "Doc host" });
    const r1 = store.putDocument(issue.id, "plan", "# v1", { author: "claude" });
    expect(r1.revision).toBe(1);
    const r2 = store.putDocument(issue.id, "plan", "# v2", { baseRevision: 1 });
    expect(r2.revision).toBe(2);
    try {
      store.putDocument(issue.id, "plan", "# stale", { baseRevision: 1 });
      expect.unreachable();
    } catch (error) {
      const e = error as StapleError;
      expect(e.code).toBe("revision_conflict");
      expect(e.detail?.currentRevision).toBe(2);
    }
    const restored = store.restoreDocumentRevision(issue.id, "plan", 1);
    expect(restored.revision).toBe(3);
    expect(store.getDocument(issue.id, "plan").body).toBe("# v1");
    expect(store.listDocumentRevisions(issue.id, "plan")).toHaveLength(3);
  });
});

describe("inbox and context", () => {
  it("orders pickup and separates blocked work, dependency-aware", () => {
    const gate = store.createIssue({ title: "Gate" });
    store.createIssue({ title: "Waiting", assignee: "claude", blockedBy: [gate.id] });
    const doing = store.createIssue({ title: "Doing", assignee: "claude", status: "in_progress" });
    store.createIssue({ title: "Queued", assignee: "claude" });
    const inbox = store.inbox("claude");
    expect(inbox.ready.map((i) => i.title)).toEqual(["Doing", "Queued"]);
    expect(inbox.ready[0]!.id).toBe(doing.id);
    expect(inbox.blocked.map((i) => i.title)).toEqual(["Waiting"]);
    expect(inbox.blocked[0]!.unresolvedBlockers).toEqual(["TST-1"]);
  });

  it("pages issues in the same order as the unpaged list, and reports hasMore honestly", () => {
    for (let i = 1; i <= 5; i += 1) store.createIssue({ title: `Task ${i}`, assignee: "claude" });
    const all = store.listIssues().map((i) => i.identifier);
    expect(all).toHaveLength(5);

    const collected: string[] = [];
    let offset = 0;
    let guard = 0;
    for (;;) {
      const page = store.listIssuesPage({}, { limit: 2, offset });
      collected.push(...page.items.map((i) => i.identifier));
      expect(page.items.length).toBeLessThanOrEqual(2);
      if (!page.hasMore) break;
      offset += page.items.length;
      if ((guard += 1) > 10) throw new Error("pagination did not terminate");
    }
    expect(collected).toEqual(all);
    // Past the end is empty, not an error.
    expect(store.listIssuesPage({}, { limit: 2, offset: 99 })).toEqual({ items: [], hasMore: false });
  });

  it("pages the inbox as one window over open issues and resolves blockers in a batch", () => {
    const gate = store.createIssue({ title: "Gate" });
    for (let i = 1; i <= 3; i += 1) {
      store.createIssue({ title: `Waiting ${i}`, assignee: "claude", blockedBy: [gate.id] });
    }
    store.createIssue({ title: "Free", assignee: "claude" });

    const first = store.inbox("claude", { limit: 2, offset: 0 });
    expect(first.ready.length + first.blocked.length).toBe(2);
    expect(first.hasMore).toBe(true);
    const second = store.inbox("claude", { limit: 2, offset: 2 });
    expect(second.ready.length + second.blocked.length).toBe(2);
    expect(second.hasMore).toBe(false);

    const paged = [...first.ready, ...first.blocked, ...second.ready, ...second.blocked]
      .map((i) => i.identifier)
      .sort();
    const unpaged = store.inbox("claude");
    expect(unpaged.hasMore).toBe(false);
    expect([...unpaged.ready, ...unpaged.blocked].map((i) => i.identifier).sort()).toEqual(paged);
    // The batch lookup agrees with the per-issue one it replaced.
    for (const entry of [...unpaged.ready, ...unpaged.blocked]) {
      expect(entry.unresolvedBlockers).toEqual(
        store.unresolvedBlockersOf(entry.id).map((b) => b.identifier),
      );
    }
  });

  it("pages comments oldest first", () => {
    const issue = store.createIssue({ title: "Threaded" });
    for (let i = 1; i <= 5; i += 1) store.addComment(issue.id, `note ${i}`, "claude", "agent");
    const first = store.listCommentsPage(issue.id, { limit: 3, offset: 0 });
    expect(first.items.map((c) => c.body)).toEqual(["note 1", "note 2", "note 3"]);
    expect(first.hasMore).toBe(true);
    const second = store.listCommentsPage(issue.id, { limit: 3, offset: 3 });
    expect(second.items.map((c) => c.body)).toEqual(["note 4", "note 5"]);
    expect(second.hasMore).toBe(false);
  });

  it("inlines document bodies only when asked", () => {
    const issue = store.createIssue({ title: "Documented" });
    store.putDocument(issue.id, "plan", "# the plan");
    store.putDocument(issue.id, "plan", "# the plan, v2");
    store.putDocument(issue.id, "notes", "scratch");

    const lean = store.context(issue.id);
    expect(lean.documents.map((d) => d.key)).toEqual(["notes", "plan"]);
    expect(lean.documents.every((d) => d.body === undefined)).toBe(true);

    const full = store.context(issue.id, { includeDocuments: true });
    expect(full.documents.find((d) => d.key === "plan")?.body).toBe("# the plan, v2");
    expect(full.documents.find((d) => d.key === "notes")?.body).toBe("scratch");
    expect(full.documents.find((d) => d.key === "plan")?.currentRevision).toBe(2);
  });

  it("context returns ancestry, relations, comments, documents", () => {
    const root = store.createIssue({ title: "Root" });
    const mid = store.createChild(root.id, { title: "Mid" });
    const leaf = store.createChild(mid.id, { title: "Leaf" });
    const gate = store.createIssue({ title: "Gate" });
    store.setBlockedBy(leaf.id, [gate.id]);
    store.addComment(leaf.id, "working on it", "claude", "agent");
    store.putDocument(leaf.id, "plan", "# plan");
    const ctx = store.context(leaf.identifier);
    expect(ctx.ancestors.map((a) => a.title)).toEqual(["Root", "Mid"]);
    expect(ctx.blockedBy[0]!.identifier).toBe(gate.identifier);
    expect(ctx.comments[0]!.body).toBe("working on it");
    expect(ctx.documents[0]!.key).toBe("plan");
    expect(ctx.issue.depth).toBe(2);
  });
});
