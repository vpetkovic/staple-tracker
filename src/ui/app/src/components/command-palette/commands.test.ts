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
    expect(statuses).toHaveLength(6);
  });

  it("routes checkout through a page, because the agent name has to be typed", () => {
    const commands = buildCommands(context({ selection: { workspace: "staple", ref: "STA-13" } }));
    expect(commands.find((c) => c.id === "checkout")?.action).toEqual({ type: "page", page: "checkout" });
    expect(commands.find((c) => c.id === "release")?.action).toEqual({ type: "release" });
  });

  it("does not offer the view you are already on", () => {
    const views = buildCommands(context({ view: "tree" })).filter((c) => c.group === "view");
    expect(views.map((c) => c.id)).toEqual(["view:graph"]);
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
