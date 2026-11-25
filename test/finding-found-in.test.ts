/**
 * A ticket filed for a finding records the ticket it was found in, and blocks it when the
 * finding is a blocker. Stored on the origin columns (`origin_kind` 'finding', `origin_id`
 * '<origin id>/<finding id>'); blocking is the ordinary blocked-by relation, written in the
 * same create, so the disposition is derived: found in + blocks the origin or a scope above
 * it = blocker, found in alone = follow-up.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

let store: WorkspaceStore;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  store.addKind({ id: "milestone", label: "Milestone" }, "vp");
});

/** A milestone with `member` in it, as an issue row's id and identifier. */
function milestoneOver(member: string): { id: string; identifier: string } {
  const made = store.milestones().create({ title: "M1", targetDate: "2026-12-01" }, "vp");
  if (made.preview) throw new Error("unexpected preview");
  store.milestones().addMember(made.milestone.id, member, {}, "vp");
  return { id: made.milestone.id, identifier: made.milestone.identifier };
}

function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StapleError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const blockerIds = (ref: string) => store.blockersOf(store.getIssue(ref).id).map((row) => row.identifier);

describe("filing a finding", () => {
  it("records where it was found, and a follow-up blocks nothing", () => {
    const origin = store.createIssue({ title: "Origin" });
    const finding = store.createIssue({ title: "Follow-up finding", foundIn: origin.identifier });
    expect(finding.originKind).toBe("finding");
    expect(finding.originId).toBe(`${origin.id}/${finding.id}`);
    expect(blockerIds(origin.identifier)).toEqual([]);

    const ctx = store.context(finding.identifier);
    expect(ctx.foundIn).toEqual({ identifier: origin.identifier, title: "Origin", status: "backlog", disposition: "follow-up" });
    expect(store.context(origin.identifier).findings).toEqual([
      { identifier: finding.identifier, title: "Follow-up finding", status: "backlog", disposition: "follow-up" },
    ]);
  });

  it("a blocker is added to the origin's blockers in the same create, beside the ones it had", () => {
    const origin = store.createIssue({ title: "Origin" });
    const earlier = store.createIssue({ title: "Earlier blocker" });
    store.setBlockedBy(origin.id, [earlier.id], "vp");
    const finding = store.createIssue({ title: "Blocker finding", foundIn: origin.identifier, blocks: true, createdBy: "eng" });
    expect(blockerIds(origin.identifier)).toEqual([earlier.identifier, finding.identifier]);
    expect(store.context(origin.identifier).findings).toEqual([
      { identifier: finding.identifier, title: "Blocker finding", status: "backlog", disposition: "blocker" },
    ]);
    expect(store.context(finding.identifier).foundIn?.disposition).toBe("blocker");
  });

  it("a blocker may block a scope above the origin: its parent or its milestone", () => {
    const epic = store.createIssue({ title: "Epic" });
    const origin = store.createIssue({ title: "Origin", parent: epic.id });
    const milestone = milestoneOver(epic.id);

    const onEpic = store.createIssue({ title: "Blocks the epic", foundIn: origin.identifier, blocks: epic.identifier });
    const onMilestone = store.createIssue({ title: "Blocks the milestone", foundIn: origin.identifier, blocks: milestone.id });
    expect(blockerIds(epic.identifier)).toEqual([onEpic.identifier]);
    expect(store.blockersOf(milestone.id).map((row) => row.identifier)).toEqual([onMilestone.identifier]);
    expect(store.context(origin.identifier).findings.map((f) => f.disposition)).toEqual(["blocker", "blocker"]);
  });

  it("refuses a scope that is neither the origin nor above it", () => {
    const origin = store.createIssue({ title: "Origin" });
    const elsewhere = store.createIssue({ title: "Elsewhere" });
    const error = refusal(() => store.createIssue({ title: "Misplaced", foundIn: origin.identifier, blocks: elsewhere.identifier }));
    expect(error.code).toBe("validation");
    expect(error.message).toContain(elsewhere.identifier);
    // Nothing was written: no issue number spent.
    expect(store.createIssue({ title: "Next" }).identifier).toBe("TST-3");
  });

  it("refuses blocking a resolved origin and names its parent and milestone as the scope instead", () => {
    const epic = store.createIssue({ title: "Epic" });
    const origin = store.createIssue({ title: "Merged origin", parent: epic.id });
    // An open sibling keeps the epic open once the origin is done.
    store.createIssue({ title: "Sibling", parent: epic.id });
    const milestone = milestoneOver(epic.id);
    store.updateIssue(origin.id, { status: "done" }, "vp");

    const error = refusal(() => store.createIssue({ title: "Too late", foundIn: origin.identifier, blocks: true }));
    expect(error.code).toBe("validation");
    expect(error.message).toContain(`${origin.identifier} is done`);
    expect(error.message).toContain(epic.identifier);
    expect(error.message).toContain(milestone.identifier);
    expect(store.listIssues({ q: "Too late", includeResolved: true })).toEqual([]);

    // The named scope is accepted.
    const finding = store.createIssue({ title: "On the epic", foundIn: origin.identifier, blocks: epic.identifier });
    expect(blockerIds(epic.identifier)).toEqual([finding.identifier]);
  });

  it("refuses a found-in ticket that does not exist, and blocks without a found-in ticket", () => {
    expect(refusal(() => store.createIssue({ title: "Nowhere", foundIn: "TST-99" })).code).toBe("not_found");
    expect(refusal(() => store.createIssue({ title: "Unanchored", blocks: true })).code).toBe("validation");
  });

  it("refuses a blocker that would close a cycle", () => {
    const origin = store.createIssue({ title: "Origin" });
    // The finding is born blocked by the origin; making it block the origin closes the loop.
    const error = refusal(() => store.createIssue({ title: "Loop", foundIn: origin.identifier, blocks: true, blockedBy: [origin.id] }));
    expect(error.code).toBe("cycle");
    expect(blockerIds(origin.identifier)).toEqual([]);
  });

  it("an idempotent replay returns the original finding and adds no second edge or finding", () => {
    const origin = store.createIssue({ title: "Origin" });
    const first = store.createIssueResult({ title: "Keyed", foundIn: origin.identifier, blocks: true, idempotencyKey: "finding-1" });
    const again = store.createIssueResult({ title: "Keyed", foundIn: origin.identifier, blocks: true, idempotencyKey: "finding-1" });
    expect(again.replayed).toBe(true);
    expect(again.issue.id).toBe(first.issue.id);
    expect(blockerIds(origin.identifier)).toEqual([first.issue.identifier]);
    expect(store.context(origin.identifier).findings).toHaveLength(1);
  });

  it("a finding that later stops blocking reads as a follow-up", () => {
    const origin = store.createIssue({ title: "Origin" });
    const finding = store.createIssue({ title: "Was a blocker", foundIn: origin.identifier, blocks: true });
    store.setBlockedBy(origin.id, [], "vp");
    expect(store.context(origin.identifier).findings[0]?.disposition).toBe("follow-up");
    expect(store.context(finding.identifier).foundIn?.disposition).toBe("follow-up");
  });

  it("an ordinary ticket has no found-in and no findings", () => {
    const plain = store.createIssue({ title: "Plain" });
    const ctx = store.context(plain.identifier);
    expect(ctx.foundIn).toBeNull();
    expect(ctx.findings).toEqual([]);
  });
});
