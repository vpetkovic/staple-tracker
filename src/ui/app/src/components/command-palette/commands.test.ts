/**
 * U7 — the parts of the palette that can be quietly wrong.
 *
 * A palette feels broken long before it *is* broken: one bad tie-break and the issue you
 * typed the identifier of sits third. So the properties pinned here are ordering
 * properties, not "does it return something" properties.
 *
 * Relative imports, no "@/…": there is no vitest config at the repo root, so the app's
 * alias does not exist at test time.
 */
import { describe, expect, it } from "vitest";
import type { Issue, IssueRow, IssueStatus } from "../../lib/types";
import {
  buildCommands,
  filterCommands,
  fuzzyScore,
  issueCommand,
  orderCommands,
  rankIssues,
  rememberCommand,
  RECENTS_LIMIT,
  type PaletteContext,
} from "./commands";

function row(identifier: string, title: string, overrides: Partial<Issue> = {}): IssueRow {
  return {
    workspace: "staple",
    // C3 added `claim` to the wire row. The palette does not read it; this is here so
    // the fixture stays an honest IssueRow rather than a subset the compiler tolerates.
    claim: null,
    issue: {
      id: `id-${identifier}`,
      identifier,
      title,
      description: null,
      status: "todo",
      statusVersion: 0,
      kind: "task",
      priority: "medium",
      parentId: null,
      depth: 0,
      assignee: null,
      createdBy: null,
      labels: [],
      acceptanceCriteria: null,
      blockParentUntilDone: false,
      unblockOwner: null,
      unblockAction: null,
      originKind: "user",
      originId: null,
      idempotencyKey: null,
      checkoutAgent: null,
      checkoutAt: null,
      blockedTransitionAt: null,
      // STA-81. null = no estimate recorded, which is not the same as zero.
      estimatedSeconds: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      ...overrides,
    },
  };
}

const context = (overrides: Partial<PaletteContext> = {}): PaletteContext => ({
  selection: null,
  selectionStatus: null,
  view: "tree",
  ws: "",
  assignee: "",
  workspaces: [{ slug: "staple", prefix: "STA" }],
  hub: false,
  ...overrides,
});

describe("fuzzyScore", () => {
  it("drops a non-match instead of ranking it last", () => {
    // The difference between null and a low score is a palette that shows seven
    // irrelevant rows under a three-letter query, which is how one stops being trusted.
    expect(fuzzyScore("zzz", "STA-13")).toBeNull();
    expect(fuzzyScore("qxy", "Command palette")).toBeNull();
  });

  it("orders exact above prefix above contiguous above scattered", () => {
    const exact = fuzzyScore("sta-13", "STA-13")!;
    const prefix = fuzzyScore("sta-1", "STA-13")!;
    const contiguous = fuzzyScore("pal", "command palette")!;
    const scattered = fuzzyScore("cpl", "command palette")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(contiguous);
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("rewards a hit that starts a word over one buried mid-word", () => {
    expect(fuzzyScore("but", "the export button")!).toBeGreaterThan(fuzzyScore("but", "distributed")!);
  });

  it("prefers the shorter of two prefix matches", () => {
    expect(fuzzyScore("sta-1", "STA-1")!).toBeGreaterThan(fuzzyScore("sta-1", "STA-1000")!);
  });

  it("is case-insensitive and treats an empty query as neutral", () => {
    expect(fuzzyScore("STA", "sta-9")).toBe(fuzzyScore("sta", "STA-9"));
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("rankIssues", () => {
  const rows = [
    row("STA-1", "Command palette groundwork"),
    row("STA-13", "Migrate the UI stack"),
    row("STA-42", "Fix STA-13 regression"),
  ];

  it("puts the identifier you typed first, even when another title mentions it", () => {
    const ranked = rankIssues(rows, "STA-13");
    expect(ranked[0]?.row.issue.identifier).toBe("STA-13");
  });

  it("finds an issue by title when the identifier does not match", () => {
    const ranked = rankIssues(rows, "palette");
    expect(ranked.map((r) => r.row.issue.identifier)).toEqual(["STA-1"]);
  });

  it("returns nothing rather than everything for a query that matches nothing", () => {
    expect(rankIssues(rows, "zzzz")).toEqual([]);
  });

  it("falls back to the server's order for an empty query, and honours the limit", () => {
    expect(rankIssues(rows, "").map((r) => r.row.issue.identifier)).toEqual(["STA-1", "STA-13", "STA-42"]);
    expect(rankIssues(rows, "  ", 2)).toHaveLength(2);
  });
});

describe("buildCommands", () => {
  it("offers no issue actions when nothing is selected", () => {
    const commands = buildCommands(context());
    expect(commands.filter((c) => c.group === "actions")).toEqual([]);
  });

  it("offers every status except the one the issue already has", () => {
    const commands = buildCommands(
      context({ selection: { workspace: "staple", ref: "STA-13" }, selectionStatus: "todo" }),
    );
    const statuses = commands
      .filter((c) => c.action.type === "status")
      .map((c) => (c.action as { status: IssueStatus }).status);
    expect(statuses).not.toContain("todo");
    /**
     * BACK TO 6 — Q2 (STA-144) closed Q1's follow-up.
     *
     * STA-143 added `awaiting_approval` to `ISSUE_STATUSES`, which this list is built
     * from, and the palette briefly offered a "set status awaiting_approval" the store
     * REFUSES: the status is reachable only through `gate`, which records WHO must
     * approve, and a parked issue with no named owner is a queue nobody drains. The
     * entry is suppressed; the detail panel's "Request approval" is where it lives now,
     * because that surface can ask for the owner and this one cannot.
     *
     * So the count is 8 statuses, minus the one it already has, minus this one.
     */
    expect(statuses).not.toContain("awaiting_approval");
    expect(statuses).toHaveLength(6);
  });

  it("routes checkout through a page, because the agent name has to be typed", () => {
    const commands = buildCommands(context({ selection: { workspace: "staple", ref: "STA-13" } }));
    expect(commands.find((c) => c.id === "checkout")?.action).toEqual({ type: "page", page: "checkout" });
    expect(commands.find((c) => c.id === "release")?.action).toEqual({ type: "release" });
  });

  it("does not offer the view you are already on", () => {
    /*
     * Filtered on the ACTION type rather than on the group. O7b (STA-141) put the
     * settings command in the `view` group — it changes what the workspace is rather
     * than narrowing what you are looking at — so "everything in the view group" stopped
     * meaning "every view switch". The action type is what this test was always about.
     */
    const views = buildCommands(context({ view: "tree" })).filter((c) => c.action.type === "view");
    expect(views.map((c) => c.id)).toEqual(["view:graph", "view:milestones"]);
  });

  /**
   * O7b (STA-141) — the vocabulary editor is reachable from the palette, always, with no
   * issue selected. It is the second way in (the header gear is the first), and a command
   * that only appeared when something was open would be a command nobody finds.
   */
  it("always offers the workspace settings dialog", () => {
    const settings = buildCommands(context()).find((c) => c.id === "settings");
    expect(settings?.action).toEqual({ type: "settings" });
  });

  /**
   * The status commands come from the CONFIGURED vocabulary when one is handed over, and
   * fall back to the built-in seven when it is not — which is what keeps every other test
   * in this file describing the shipped default.
   */
  it("offers the configured statuses, by their configured labels", () => {
    const commands = buildCommands(
      context({
        selection: { workspace: "staple", ref: "STA-13" },
        selectionStatus: "todo",
        statuses: [
          { id: "todo", label: "Queued" },
          { id: "pairing", label: "Pairing" },
          { id: "done", label: "Shipped" },
        ],
      }),
    ).filter((c) => c.action.type === "status");

    // `todo` is the selection's own status and is not offered.
    expect(commands.map((c) => c.id)).toEqual(["status:pairing", "status:done"]);
    expect(commands.map((c) => c.label)).toEqual(["Set status → Pairing", "Set status → Shipped"]);
    expect(commands[0]!.action).toEqual({ type: "status", status: "pairing" });
  });

  it("only offers to clear the assignee filter when one is set", () => {
    expect(buildCommands(context()).some((c) => c.id === "filter:assignee:clear")).toBe(false);
    expect(buildCommands(context({ assignee: "kim" })).some((c) => c.id === "filter:assignee:clear")).toBe(true);
  });

  it("keeps workspace switching out of workspace mode entirely", () => {
    expect(buildCommands(context({ hub: false })).some((c) => c.id.startsWith("ws:"))).toBe(false);
    const hub = buildCommands(
      context({ hub: true, ws: "staple", workspaces: [{ slug: "staple", prefix: "STA" }, { slug: "other", prefix: "OTH" }] }),
    );
    expect(hub.map((c) => c.id).filter((id) => id.startsWith("ws:"))).toEqual(["ws:all", "ws:other"]);
  });
});

/**
 * W5 (STA-117) — the handoff-risk commands of STA-108 §3F.
 *
 * Two properties are worth pinning and neither is "the commands exist". The first is that
 * the action stays PLAIN DATA: the whole reason this file has no React in it is that a
 * command is a serialisable object, and a closure smuggled into an action would work
 * perfectly while quietly making the palette untestable. The second is that the risk
 * judgement is NOT made here — the counts have to come from `handoffRiskOf` in
 * lib/filters.ts, or the palette will one day advertise "3 issues" over a filter that
 * selects four.
 */
describe("handoff-risk commands", () => {
  const ACTIVE = "2026-09-01T12:00:00Z";
  const before = (seconds: number) => new Date(Date.parse(ACTIVE) - seconds * 1000).toISOString();

  /** Held by an agent whose last checkpoint is `checkpointAgo` seconds behind its activity. */
  const held = (identifier: string, checkpointAgo: number | null): IssueRow => ({
    ...row(identifier, `task ${identifier}`, { status: "in_progress", checkoutAgent: "opus-a" }),
    claim: {
      heldBy: "opus-a",
      checkoutAt: before(6 * 60 * 60),
      lastActivityAt: ACTIVE,
      heldSeconds: 6 * 60 * 60,
      idleSeconds: 30,
    },
    worklog:
      checkpointAgo === null
        ? null
        : { key: "worklog", revisions: 3, updatedAt: before(checkpointAgo), author: "opus-a" },
  });

  const board = () => [
    held("STA-1", 4 * 60 * 60), // busy, four hours behind its own handoff → stale
    held("STA-2", 5 * 60), // checkpointed five minutes ago → not a risk
    held("STA-3", null), // nothing written down at all → none
    held("STA-4", null),
    row("STA-5", "unheld backlog item"), // nobody holding it → not a finding
  ];

  const handoff = (over: Partial<PaletteContext> = {}) =>
    buildCommands(context(over)).filter((c) => c.id.startsWith("filter:handoff"));

  it("offers one command per risk, in the registry's order", () => {
    expect(handoff().map((c) => c.id)).toEqual(["filter:handoff:stale", "filter:handoff:none"]);
    expect(handoff().every((c) => c.group === "filter")).toBe(true);
  });

  it("targets the lib/filters.ts dimension by name and value", () => {
    // The action is generic over dimensions on purpose — see the note on CommandAction.
    expect(handoff().map((c) => c.action)).toEqual([
      { type: "dimension", dimension: "handoff", values: ["stale"] },
      { type: "dimension", dimension: "handoff", values: ["none"] },
    ]);
  });

  it("stays plain data — a serialisable object, never a closure", () => {
    const commands = handoff({ rows: board() });
    expect(JSON.parse(JSON.stringify(commands))).toEqual(commands);
  });

  it("counts what each command would select, using the filter's own predicate", () => {
    const hints = handoff({ rows: board() }).map((c) => c.hint);
    expect(hints).toEqual(["1 issue", "2 issues"]);
  });

  it("answers the question before the click when nothing is at risk", () => {
    // "none" rather than a hidden command: a healthy board is the answer the orchestrator
    // came for, and a command that disappears when it is true is one nobody ever learns.
    expect(handoff({ rows: [row("STA-9", "quiet")] }).map((c) => c.hint)).toEqual(["none", "none"]);
  });

  it("still offers the commands before any rows have loaded, with no invented count", () => {
    expect(handoff().map((c) => c.hint)).toEqual([undefined, undefined]);
  });

  it("is findable by words that appear in no label", () => {
    const all = buildCommands(context({ rows: board() }));
    expect(filterCommands(all, "abandoned").map((c) => c.id)).toEqual(["filter:handoff:none"]);
    // Both, and only both. The order between them is `fuzzyScore`'s shorter-haystack
    // tie-break rather than anything this feature promises, so it is not asserted.
    expect(filterCommands(all, "handoff").map((c) => c.id).sort()).toEqual([
      "filter:handoff:none",
      "filter:handoff:stale",
    ]);
  });
});

describe("orderCommands", () => {
  const commands = buildCommands(
    context({ selection: { workspace: "staple", ref: "STA-13" }, selectionStatus: "todo" }),
  );

  it("floats commands acting on the open issue above everything else", () => {
    const ordered = orderCommands(commands, ["view:graph"], true);
    expect(ordered[0]?.group).toBe("actions");
    // Even though view:graph is the single most recent command.
    expect(ordered.findIndex((c) => c.id === "view:graph")).toBeGreaterThan(0);
  });

  it("promotes recents when there is no selection to be contextual about", () => {
    const noSelection = buildCommands(context());
    const ordered = orderCommands(noSelection, ["filter:assignee"], false);
    expect(ordered[0]?.id).toBe("filter:assignee");
  });

  it("orders the recent tier most-recent-first", () => {
    const noSelection = buildCommands(context({ assignee: "kim" }));
    const ordered = orderCommands(noSelection, ["filter:assignee:clear", "view:graph"], false);
    expect(ordered.slice(0, 2).map((c) => c.id)).toEqual(["filter:assignee:clear", "view:graph"]);
  });

  it("is stable — it never reshuffles commands within a tier", () => {
    const ordered = orderCommands(commands, [], false);
    expect(ordered.map((c) => c.id)).toEqual(commands.map((c) => c.id));
  });
});

describe("rememberCommand", () => {
  it("moves a repeat to the front instead of duplicating it", () => {
    expect(rememberCommand(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("caps the list so an MRU stays an MRU", () => {
    let list: string[] = [];
    for (let i = 0; i < RECENTS_LIMIT + 4; i += 1) list = rememberCommand(list, `cmd-${i}`);
    expect(list).toHaveLength(RECENTS_LIMIT);
    expect(list[0]).toBe(`cmd-${RECENTS_LIMIT + 3}`);
  });
});

describe("filterCommands", () => {
  const commands = buildCommands(
    context({ selection: { workspace: "staple", ref: "STA-13" }, selectionStatus: "todo" }),
  );

  it("matches on keywords the label never shows", () => {
    // "claim" is what an agent calls it; the label says "Check out as…".
    expect(filterCommands(commands, "claim").map((c) => c.id)).toContain("checkout");
  });

  it("narrows to one command for an unambiguous query", () => {
    expect(filterCommands(commands, "in_review").map((c) => c.id)).toEqual(["status:in_review"]);
  });

  it("returns the list untouched for an empty query", () => {
    expect(filterCommands(commands, "  ").map((c) => c.id)).toEqual(commands.map((c) => c.id));
  });
});

describe("issueCommand", () => {
  it("carries the workspace, so a hub jump lands in the right file", () => {
    const command = issueCommand(row("STA-13", "Migrate the UI stack"), true);
    expect(command.action).toEqual({ type: "open", workspace: "staple", ref: "STA-13" });
    expect(command.hint).toBe("staple · todo");
  });

  it("drops the workspace from the hint in workspace mode, where it is noise", () => {
    expect(issueCommand(row("STA-13", "Migrate the UI stack"), false).hint).toBe("todo");
  });
});
