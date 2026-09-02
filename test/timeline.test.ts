/**
 * The activity timeline merge. Pure input -> pure output, no server and no DOM.
 *
 * What is worth pinning is the stuff that is invisible in a screenshot: that the three
 * sources actually interleave by time rather than concatenating, that the two lossy
 * duplicate event kinds are dropped in favour of the richer source, and that an event
 * kind nobody has written yet still produces a row.
 */
import { describe, expect, it } from "vitest";
import { buildTimeline, describeEvent } from "../src/ui/app/src/detail/timeline.js";
import type { DocumentRevision, IssueComment, StapleEvent } from "../src/ui/app/src/lib/types.js";

const comment = (id: string, at: string, body: string, author = "vpetkovic"): IssueComment => ({
  id,
  issueId: "issue-1",
  author,
  authorType: author.includes("-") ? "agent" : "user",
  body,
  idempotencyKey: null,
  deletedAt: null,
  createdAt: at,
});

const event = (
  seq: number,
  kind: string,
  at: string,
  payload: Record<string, unknown> = {},
  actor: string | null = "opus-detail",
): StapleEvent => ({
  seq,
  kind,
  issueId: "issue-1",
  actor,
  payload,
  dedupKey: null,
  createdAt: at,
});

const revision = (
  n: number,
  at: string,
  summary: string | null,
  author: string | null = "opus-detail",
  key = "plan",
) =>
  ({ key, revision: n, author, changeSummary: summary, createdAt: at }) as DocumentRevision & {
    key: string;
  };

const worklog = (n: number, at: string, summary: string | null, author: string | null = "opus-detail") =>
  revision(n, at, summary, author, "worklog");

describe("describeEvent", () => {
  it("drops comment_added — the comment row carries the body, the event carries 120 chars", () => {
    expect(describeEvent(event(1, "comment_added", "2026-09-01T10:00:00Z", { preview: "hi" }))).toBeNull();
  });

  it("drops doc_updated — the revision row carries the change summary and the author", () => {
    expect(describeEvent(event(1, "doc_updated", "2026-09-01T10:00:00Z", { key: "plan", revision: 2 }))).toBeNull();
  });

  it("phrases a status change as from → to", () => {
    const described = describeEvent(event(1, "status_changed", "2026-09-01T10:00:00Z", {
      from: "todo",
      to: "in_progress",
    }))!;
    expect(described.kind).toBe("status");
    expect(described.status).toBe("in_progress");
    expect(described.summary).toBe("status todo → in_progress");
  });

  it("carries the blocker list on a blockers_resolved wake", () => {
    const described = describeEvent(event(1, "blockers_resolved", "2026-09-01T10:00:00Z", {
      identifier: "STA-15",
      blockers: ["STA-13", "STA-14"],
    }))!;
    expect(described.kind).toBe("blocker");
    expect(described.chips).toEqual(["STA-13", "STA-14"]);
  });

  it("unwraps children_complete, whose payload holds objects rather than strings", () => {
    const described = describeEvent(event(1, "children_complete", "2026-09-01T10:00:00Z", {
      children: [
        { identifier: "STA-14", title: "U2", status: "done" },
        { identifier: "STA-15", title: "U3", status: "done" },
      ],
    }))!;
    expect(described.chips).toEqual(["STA-14", "STA-15"]);
  });

  it("distinguishes setting dependencies from clearing them", () => {
    expect(describeEvent(event(1, "blockers_changed", "2026-09-01T10:00:00Z", { blockedBy: [] }))!.summary).toBe(
      "dependencies cleared",
    );
    expect(
      describeEvent(event(1, "blockers_changed", "2026-09-01T10:00:00Z", { blockedBy: ["STA-13"] }))!.summary,
    ).toBe("dependencies set");
  });

  it("fails soft on a kind it has never seen rather than dropping history", () => {
    const described = describeEvent(event(1, "some_future_event", "2026-09-01T10:00:00Z"))!;
    expect(described).not.toBeNull();
    expect(described.summary).toBe("some future event");
  });

  it("survives a payload that is missing the fields it expects", () => {
    const described = describeEvent(event(1, "status_changed", "2026-09-01T10:00:00Z", {}))!;
    expect(described.summary).toBe("status changed");
    expect(described.status).toBeUndefined();
  });
});

describe("buildTimeline", () => {
  it("interleaves all three sources by time rather than concatenating them", () => {
    const merged = buildTimeline({
      comments: [
        comment("c1", "2026-09-01T10:05:00Z", "picking this up"),
        comment("c2", "2026-09-01T10:30:00Z", "diff view is in"),
      ],
      events: [
        event(1, "issue_created", "2026-09-01T10:00:00Z", { identifier: "STA-15" }),
        event(2, "status_changed", "2026-09-01T10:10:00Z", { from: "todo", to: "in_progress" }),
        event(3, "doc_updated", "2026-09-01T10:20:00Z", { key: "plan", revision: 1 }),
      ],
      revisions: [revision(1, "2026-09-01T10:20:00Z", "first draft")],
    });

    expect(merged.map((e) => e.kind)).toEqual(["lifecycle", "comment", "status", "revision", "comment"]);
    expect(merged.map((e) => e.at)).toEqual([
      "2026-09-01T10:00:00Z",
      "2026-09-01T10:05:00Z",
      "2026-09-01T10:10:00Z",
      "2026-09-01T10:20:00Z",
      "2026-09-01T10:30:00Z",
    ]);
  });

  it("renders the revision, not the doc_updated event that duplicates it", () => {
    const merged = buildTimeline({
      comments: [],
      events: [event(1, "doc_updated", "2026-09-01T10:20:00Z", { key: "plan", revision: 2 })],
      revisions: [revision(2, "2026-09-01T10:20:00Z", "restore revision 1")],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      kind: "revision",
      summary: "restore revision 1",
      chips: ["plan r2"],
    });
  });

  it("borrows the doc_updated actor when the revision row has no author", () => {
    const merged = buildTimeline({
      comments: [],
      events: [event(9, "doc_updated", "2026-09-01T10:20:00Z", { key: "plan", revision: 3 }, "ui")],
      revisions: [revision(3, "2026-09-01T10:20:00Z", "restore revision 1", null)],
    });
    expect(merged[0]!.actor).toBe("ui");
  });

  it("falls back to a phrase when a revision has no change summary", () => {
    const merged = buildTimeline({
      comments: [],
      events: [],
      revisions: [revision(1, "2026-09-01T10:20:00Z", null)],
    });
    expect(merged[0]!.summary).toBe("wrote plan");
  });

  it("keeps the comment body and author type, which is the whole reason not to use the event", () => {
    const merged = buildTimeline({
      comments: [comment("c1", "2026-09-01T10:05:00Z", "a **long** body that no preview would hold", "opus-detail")],
      events: [event(1, "comment_added", "2026-09-01T10:05:00Z", { commentId: "c1", preview: "a **long** body" })],
      revisions: [],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      kind: "comment",
      authorType: "agent",
      actor: "opus-detail",
      body: "a **long** body that no preview would hold",
    });
  });

  it("orders creation first when everything shares a timestamp", () => {
    const at = "2026-09-01T10:00:00Z";
    const merged = buildTimeline({
      comments: [comment("c1", at, "same second")],
      events: [
        event(2, "status_changed", at, { from: "backlog", to: "todo" }),
        event(1, "issue_created", at, { identifier: "STA-15" }),
      ],
      revisions: [revision(1, at, "same second too")],
    });
    expect(merged.map((e) => e.kind)).toEqual(["lifecycle", "status", "comment", "revision"]);
  });

  it("gives every entry a stable, unique id so React keys do not thrash on refetch", () => {
    const input = {
      comments: [comment("c1", "2026-09-01T10:05:00Z", "one")],
      events: [event(1, "checkout", "2026-09-01T10:06:00Z")],
      revisions: [revision(1, "2026-09-01T10:07:00Z", "first")],
    };
    const first = buildTimeline(input).map((e) => e.id);
    const second = buildTimeline(input).map((e) => e.id);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it("returns an empty thread rather than throwing when nothing has happened", () => {
    expect(buildTimeline({ comments: [], events: [], revisions: [] })).toEqual([]);
  });
});

/**
 * Promotion of the worklog key (STA-114).
 *
 * The contract is narrow on purpose: worklog rows read as checkpoints, and every other
 * key comes out of the merge exactly as it did before, because an issue with three
 * documents must not bury its own comments under promoted rows.
 */
describe("buildTimeline — worklog checkpoints", () => {
  it("promotes a worklog revision to a checkpoint and renders its change summary", () => {
    const merged = buildTimeline({
      comments: [],
      events: [],
      revisions: [worklog(3, "2026-09-01T11:45:00Z", "guard ported, HTTP surface next")],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      kind: "checkpoint",
      summary: "checkpoint · guard ported, HTTP surface next",
      actor: "opus-detail",
      chips: ["worklog r3"],
    });
  });

  it("degrades a summary-less checkpoint to the old phrasing rather than to an empty row", () => {
    const merged = buildTimeline({
      comments: [],
      events: [],
      revisions: [worklog(1, "2026-09-01T11:45:00Z", null)],
    });
    expect(merged[0]!.kind).toBe("checkpoint");
    expect(merged[0]!.summary).toBe("checkpoint · wrote worklog");
  });

  it("leaves a revision of any other key exactly as it was — kind, words, chip and id", () => {
    const input = {
      comments: [],
      events: [],
      revisions: [revision(2, "2026-09-01T10:20:00Z", "restore revision 1"), revision(3, "2026-09-01T10:30:00Z", null)],
    };
    expect(buildTimeline(input)).toEqual([
      {
        id: "revision:plan@2",
        kind: "revision",
        at: "2026-09-01T10:20:00Z",
        actor: "opus-detail",
        summary: "restore revision 1",
        chips: ["plan r2"],
      },
      {
        id: "revision:plan@3",
        kind: "revision",
        at: "2026-09-01T10:30:00Z",
        actor: "opus-detail",
        summary: "wrote plan",
        chips: ["plan r3"],
      },
    ]);
  });

  it("still borrows the doc_updated actor on a checkpoint whose row has no author", () => {
    const merged = buildTimeline({
      comments: [],
      events: [event(9, "doc_updated", "2026-09-01T11:45:00Z", { key: "worklog", revision: 2 }, "opus-w2")],
      revisions: [worklog(2, "2026-09-01T11:45:00Z", "done: rail; next: tests", null)],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: "checkpoint", actor: "opus-w2" });
  });

  it("promotes on the key the caller names, so the canonical constant can be passed in", () => {
    const merged = buildTimeline({
      comments: [],
      events: [],
      revisions: [worklog(1, "2026-09-01T11:45:00Z", "not the key in play"), revision(1, "2026-09-01T11:46:00Z", "is")],
      worklogKey: "plan",
    });
    expect(merged.map((e) => e.kind)).toEqual(["revision", "checkpoint"]);
  });

  it("keeps a checkpoint in its own place in the thread rather than floating it", () => {
    const at = "2026-09-01T11:45:00Z";
    const merged = buildTimeline({
      comments: [comment("c1", at, "same second")],
      events: [event(1, "status_changed", at, { from: "in_progress", to: "in_review" })],
      revisions: [worklog(2, at, "handing off")],
    });
    expect(merged.map((e) => e.kind)).toEqual(["status", "comment", "checkpoint"]);
  });
});
