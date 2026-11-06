/**
 * Members on the page: the chip an event's origin device earns, the Mine/All
 * split, and the order the assignee picker offers members in.
 *
 * Rendered to strings, like the other detail tests. What a browser shows of the open
 * picker is in the Playwright evidence, not here.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MineToggle } from "@/components/members/MineToggle";
import { MemberChip } from "@/detail/parts/MemberChip";
import { CommentRow, EventRow } from "@/detail/tabs/ActivityTab";
import { buildTimeline } from "@/detail/timeline";
import { queueAheadOf } from "@/detail/plain-actions";
import { effectivePreview, nextEligible } from "@/views/queue/queue-model";
import { assignableMembers, memberHue, memberInitials, otherMemberOf, otherMembersRule, partitionMine } from "./members";
import type { EffectiveQueueRow } from "./types";
import type { UiMembersCache } from "./types";

const CACHE: UiMembersCache = {
  version: 1,
  repositoryId: "repo",
  fetchedAt: "2026-11-06T12:00:00.000Z",
  self: { memberId: "m-vp", deviceId: "mbp-16" },
  members: [
    { memberId: "m-zed", name: "zed", isOwner: false, removed: true, devices: [] },
    { memberId: "m-marko", name: "marko", isOwner: false, removed: false, devices: [{ deviceId: "thinkpad", label: "thinkpad", lastSeenAt: 1, revoked: false }] },
    { memberId: "m-vp", name: "VP", isOwner: true, removed: false, devices: [{ deviceId: "mbp-16", label: "mbp-16", lastSeenAt: 1, revoked: false }] },
    { memberId: "m-ana", name: "Ana", isOwner: false, removed: false, devices: [] },
  ],
};

const MARKO = { memberId: "m-marko", name: "marko", removed: false };

describe("the member chip on an activity row", () => {
  it("rides from the event's member onto the timeline entry, and onto a revision through its doc_updated event", () => {
    const entries = buildTimeline({
      comments: [],
      events: [
        { seq: 1, kind: "issue_created", actor: "claude-ab12", payload: {}, createdAt: "2026-11-06T10:00:00Z", member: { memberId: "m-vp", name: "VP", removed: false } },
        { seq: 2, kind: "doc_updated", actor: "codex-77", payload: { key: "plan", revision: 1 }, createdAt: "2026-11-06T11:00:00Z", member: MARKO },
        { seq: 3, kind: "status_changed", actor: "codex-77", payload: { from: "todo", to: "in_progress" }, createdAt: "2026-11-06T11:30:00Z" },
      ],
      revisions: [{ key: "plan", revision: 1, author: "codex-77", changeSummary: null, createdAt: "2026-11-06T11:00:00Z" }],
    });
    expect(entries.find((e) => e.id === "event:1")?.member?.name).toBe("VP");
    expect(entries.find((e) => e.id === "revision:plan@1")?.member).toEqual(MARKO);
    // No member on the event, no member on the row: a solo workspace reads as before.
    const plain = entries.find((e) => e.id === "event:3");
    expect(plain).toBeDefined();
    expect(plain).not.toHaveProperty("member");
  });

  it("draws the member's initials beside the agent, and nothing without a member", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    const [withMember] = buildTimeline({
      comments: [],
      events: [{ seq: 1, kind: "issue_created", actor: "claude-ab12", payload: {}, createdAt: "2026-11-06T10:00:00Z", member: MARKO }],
      revisions: [],
    });
    const html = renderToStaticMarkup(<EventRow entry={withMember!} today now={now} />);
    expect(html).toContain('data-member-chip="m-marko"');
    expect(html).toContain(">MA<");
    expect(html).toContain(`data-member-hue="${memberHue("m-marko")}"`);
    // The chip comes before the agent's own chip.
    expect(html.indexOf("data-member-chip")).toBeLessThan(html.indexOf('data-person="claude-ab12"'));

    const [without] = buildTimeline({
      comments: [],
      events: [{ seq: 1, kind: "issue_created", actor: "claude-ab12", payload: {}, createdAt: "2026-11-06T10:00:00Z" }],
      revisions: [],
    });
    expect(renderToStaticMarkup(<EventRow entry={without!} today now={now} />)).not.toContain("data-member-chip");
  });

  it("gives a comment its member, from the comment_added event that names it", () => {
    const entries = buildTimeline({
      comments: [{ id: "c-1", author: "codex-77", authorType: "agent", body: "Drafted the policies.", createdAt: "2026-11-06T11:00:00Z" }],
      events: [{ seq: 4, kind: "comment_added", actor: "codex-77", payload: { commentId: "c-1" }, createdAt: "2026-11-06T11:00:00Z", member: MARKO }],
      revisions: [],
    });
    const comment = entries.find((e) => e.kind === "comment")!;
    expect(comment.member).toEqual(MARKO);
    const html = renderToStaticMarkup(<CommentRow entry={comment} today now={new Date("2026-11-06T12:00:00Z")} />);
    expect(html).toContain('data-member-chip="m-marko"');
  });

  it("keeps a removed member's chip, muted", () => {
    const html = renderToStaticMarkup(<MemberChip member={{ ...MARKO, removed: true }} />);
    expect(html).toContain("data-member-removed");
    expect(html).toContain("opacity-55");
    expect(html).toContain("(removed)");
  });

  it("gives each member one stable colour from the chart ramp, and two initials", () => {
    expect(memberHue("m-marko")).toBe(memberHue("m-marko"));
    for (const id of ["a", "m-marko", "m-vp", "0e77fa01"]) expect(memberHue(id)).toBeGreaterThanOrEqual(1), expect(memberHue(id)).toBeLessThanOrEqual(4);
    expect(memberInitials("marko")).toBe("MA");
    expect(memberInitials("Vladimir Petkovic")).toBe("VP");
  });
});

describe("Mine / All", () => {
  const row = (identifier: string, assignee: string | null) => ({ issue: { identifier, assignee } });

  it("Mine keeps my work, unassigned work and agents', and counts what it hid per member", () => {
    const { mine, hidden } = partitionMine(CACHE, [
      row("AII-21", "vp"),
      row("AII-30", null),
      row("AII-24", "Marko"),
      row("AII-25", "marko"),
      row("AII-33", "claude-ab12"),
    ]);
    expect(mine.map((r) => r.issue.identifier)).toEqual(["AII-21", "AII-30", "AII-33"]);
    expect(hidden).toEqual([{ memberId: "m-marko", name: "marko", count: 2 }]);
    expect(otherMemberOf(CACHE, "VP")).toBeNull();
  });

  it("says what Mine hid, with a way to show it, and says nothing under All", () => {
    const hidden = [{ memberId: "m-marko", name: "marko", count: 4 }];
    const mine = renderToStaticMarkup(<MineToggle mine onChange={() => {}} hidden={hidden} />);
    expect(mine).toContain('data-mine-toggle="mine"');
    expect(mine).toMatch(/data-mine-option="mine"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-mine-option="mine"/);
    expect(mine).toContain("4 assigned to marko hidden");
    expect(mine).toContain(">show<");
    const all = renderToStaticMarkup(<MineToggle mine={false} onChange={() => {}} hidden={hidden} />);
    expect(all).toContain('data-mine-toggle="all"');
    expect(all).not.toContain("hidden ·");
  });
});

describe("the assignee picker", () => {
  it("offers me first, as (you), then the other current members by name, never a removed one", () => {
    const offered = assignableMembers(CACHE);
    expect(offered.map((m) => [m.name, m.self])).toEqual([
      ["VP", true],
      ["Ana", false],
      ["marko", false],
    ]);
    const html = renderToStaticMarkup(<MemberChip member={offered[0]!} you withName />);
    expect(html).toContain("(you)");
  });
});

describe("the next ticket, wherever the page names it, follows the member rule", () => {
  // AII-4 is marko's and heads the plan; AII-1 is mine, second; AII-2 is unqueued.
  const effectiveRow = (identifier: string, position: number, unqueued = false): EffectiveQueueRow => ({
    issueId: `id-${identifier}`,
    identifier,
    title: identifier,
    kind: "task",
    status: "todo",
    position,
    planPosition: unqueued ? null : position,
    via: null,
    unqueued,
    eligibility: "eligible",
    claim: null,
    reason: null,
    detail: null,
    dueAt: null,
    milestonePath: [],
    epicPath: [],
    parent: null,
  });
  const rows = [effectiveRow("AII-4", 1), effectiveRow("AII-1", 2), effectiveRow("AII-2", 3, true)];
  const issues = [
    { issue: { identifier: "AII-4", assignee: "marko" } },
    { issue: { identifier: "AII-1", assignee: "VP" } },
    { issue: { identifier: "AII-2", assignee: null } },
  ];
  const rule = otherMembersRule(CACHE, issues);

  it("the shared rule names marko's ticket and nobody else's, and is absent without a member list", () => {
    expect(rule?.("AII-4")).toBe(true);
    expect(rule?.("AII-1")).toBe(false);
    expect(rule?.("AII-2")).toBe(false);
    expect(otherMembersRule(null, issues)).toBeUndefined();
  });

  it("the Queue view's next band skips marko's ticket, as queue next does", () => {
    expect(nextEligible(rows, rule)?.identifier).toBe("AII-1");
    expect(effectivePreview({ revision: 1, entries: [], effective: rows }, undefined, rule).next?.identifier).toBe("AII-1");
    // Without a member list: the first eligible row, as before.
    expect(nextEligible(rows)?.identifier).toBe("AII-4");
  });

  it("the strict-order hint never names marko's ticket as ahead", () => {
    expect(queueAheadOf(rows, "id-AII-2", rule)?.identifier).toBe("AII-1");
    expect(queueAheadOf(rows, "id-AII-1", rule)).toBeNull();
    // Without a member list: marko's ticket is ahead, as before.
    expect(queueAheadOf(rows, "id-AII-1")?.identifier).toBe("AII-4");
  });
});
