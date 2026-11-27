/**
 * Milestones in All workspaces (review items 7 and 8).
 *
 *   7 — All workspaces lists every workspace's milestones, grouped, read-only; workspaces
 *       with none are left out; opening one is the moment the page switches workspace. The
 *       page is the outline, read-only: a heading strip per workspace, its open milestones as
 *       section headers that are each one control, then its own Finished line. The presses
 *       are `test/ui-milestones-page.test.ts`'s, in Chromium.
 *   8 — a workspace without the milestone kind never shows the store's command-line
 *       sentence: a plain sentence and one button to that workspace's kinds in Settings.
 *
 * The "no milestone kind" error is produced by the REAL store guard and the REAL envelope
 * the UI server sends (core/milestones.ts → core/types.ts `errorEnvelope` → api.ts
 * `ApiError`), not a hand-written object, so the test breaks if the server's shape changes.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { assertMilestoneKindConfigured } from "../../../../../core/milestones";
import { errorEnvelope, StapleError } from "../../../../../core/types";
import { ApiError, AuthError } from "@/lib/api";
import { SessionContext } from "@/lib/session";
import type { MilestoneListRow } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { AllWorkspacesOutline, MilestonesOff, openMilestoneIn, readAllMilestones, turnOnMilestones } from "./AllWorkspacesMilestones";
import { listRow, progress } from "./fixtures";
import { groupAllMilestones, isMissingMilestoneKind, type WorkspaceMilestonesResult } from "./milestones-model";

/** What `/api/milestones?ws=<a workspace without the kind>` answers, end to end. */
function missingKindError(): ApiError {
  try {
    assertMilestoneKindConfigured(["epic", "task", "bug"]);
  } catch (error) {
    return new ApiError(400, errorEnvelope(error));
  }
  throw new Error("the store accepted a workspace with no milestone kind");
}

const row = (identifier: string, over: Partial<MilestoneListRow["milestone"]> = {}) =>
  listRow({ milestone: { identifier, title: `${identifier} title`, ...over } });

describe("isMissingMilestoneKind", () => {
  it("recognises the store's refusal by code and detail", () => {
    expect(isMissingMilestoneKind(missingKindError())).toBe(true);
  });

  it("does not swallow other validation errors, or anything else", () => {
    expect(isMissingMilestoneKind(new ApiError(400, errorEnvelope(new StapleError("validation", "bad date", { field: "target" }))))).toBe(false);
    expect(isMissingMilestoneKind(new ApiError(500, { code: "unknown", message: "boom" }))).toBe(false);
    expect(isMissingMilestoneKind(new Error("network"))).toBe(false);
    expect(isMissingMilestoneKind(null)).toBe(false);
  });
});

describe("every workspace's milestones, grouped", () => {
  it("groups by workspace in the order given, omits workspaces with none, and never shows the kind refusal", () => {
    const all = groupAllMilestones([
      { workspace: "data-pipeline", ok: false, error: missingKindError() },
      { workspace: "marketing-site", ok: true, rows: [row("MAR-4")] },
      { workspace: "mobile-app", ok: true, rows: [] },
      { workspace: "staple", ok: true, rows: [row("STA-313", { targetDate: "2026-12-01" }), row("STA-312", { targetDate: "2026-11-01" })] },
    ]);
    expect(all.groups.map((group) => group.workspace)).toEqual(["marketing-site", "staple"]);
    // Sorted as one workspace's own page sorts them: the earlier target first.
    expect(all.groups[1]!.rows.map((r) => r.milestone.identifier)).toEqual(["STA-312", "STA-313"]);
    expect(all.failed).toEqual([]);
  });

  it("lists finished ones with the rest: the page puts them on each group's Finished shelf", () => {
    const done = row("STA-9");
    done.milestone.state = "done";
    expect(groupAllMilestones([{ workspace: "staple", ok: true, rows: [row("STA-1"), done], effective: [] }]).groups[0]!.rows.map((r) => r.milestone.identifier)).toEqual(["STA-1", "STA-9"]);
    // A workspace whose milestones are all finished is still a group.
    expect(groupAllMilestones([{ workspace: "staple", ok: true, rows: [done] }]).groups.map((group) => group.workspace)).toEqual(["staple"]);
  });

  it("keeps a real failure visible under its workspace instead of hiding it", () => {
    const boom = new ApiError(500, { code: "unknown", message: "database is locked" });
    expect(groupAllMilestones([{ workspace: "staple", ok: false, error: boom }]).failed).toEqual([
      { workspace: "staple", error: boom },
    ]);
  });

  it("reads every workspace, and one failing does not hide the others", async () => {
    const asked: string[] = [];
    const queues: string[] = [];
    const results = await readAllMilestones(
      [{ slug: "a" }, { slug: "b" }],
      false,
      async (params) => {
        const ws = params?.ws;
        asked.push(ws!);
        if (ws === "a") throw missingKindError();
        return [row("B-1")];
      },
      // The queue too, per workspace with milestones: what blocked and gated are counted from.
      async ({ ws }) => (queues.push(ws), { effective: [] }),
    );
    expect(asked).toEqual(["a", "b"]);
    expect(queues).toEqual(["b"]);
    expect(results.map((r) => [r.workspace, r.ok])).toEqual([["a", false], ["b", true]]);
    expect(results[1]).toMatchObject({ effective: [] });
  });

  it("hands a bad credential to the token screen rather than filing it under one workspace", async () => {
    await expect(
      readAllMilestones([{ slug: "a" }], false, async () => {
        throw new AuthError(401, "unauthorized", "no");
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("opens a milestone by switching to its workspace, then pointing the page at it", () => {
    const calls: string[] = [];
    const recorder = (mode: "hub" | "workspace", ws: string) => ({
      mode,
      ws,
      setWs: (slug: string) => calls.push(`ws:${slug}`),
      focusMilestone: (ref: string | null) => calls.push(`focus:${ref}`),
    });
    // All workspaces, and another workspace's page: switch, then focus.
    openMilestoneIn(recorder("hub", ""), "marketing-site", "MAR-4");
    openMilestoneIn(recorder("hub", "staple"), "marketing-site", "MAR-4");
    expect(calls.splice(0)).toEqual(["ws:marketing-site", "focus:MAR-4", "ws:marketing-site", "focus:MAR-4"]);
    // Already there, or a single workspace with nowhere to switch: the focus moves alone, so the
    // page takes one history step and keeps the workspace it is on.
    openMilestoneIn(recorder("hub", "marketing-site"), "marketing-site", "MAR-4");
    openMilestoneIn(recorder("workspace", ""), "marketing-site", "MAR-4");
    expect(calls).toEqual(["focus:MAR-4", "focus:MAR-4"]);
  });

});

const NOW = new Date("2026-09-04T12:00:00.000Z");
const finished = (identifier: string, closedAt: string) => row(identifier, { state: "done", status: "done", closedAt });

/** The page as it draws `results`, every milestone listed whatever the Done toggle says. */
function page(results: WorkspaceMilestonesResult[], wrap: (node: ReactNode) => ReactNode = (node) => node): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession({ mode: "hub", ws: "" })}>{wrap(<AllWorkspacesOutline all={groupAllMilestones(results)} now={NOW} onOpen={() => {}} />)}</SessionContext.Provider>,
  );
}

/** Visible words, tags stripped. */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

/** Render as a viewport `width` px wide: the page reads its narrow form from the shell's width until it is measured. */
function atWidth(width: number, draw: () => string): string {
  (globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const max = /max-width:\s*(\d+)px/.exec(query);
      return { matches: min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false, addEventListener: () => {}, removeEventListener: () => {} };
    },
  };
  return draw();
}
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("All workspaces, drawn as the outline", () => {
  const staple: WorkspaceMilestonesResult = {
    workspace: "staple",
    ok: true,
    rows: [
      row("STA-1", { title: "October cut", targetDate: "2026-10-31", planPosition: 2 }),
      listRow({ milestone: { identifier: "STA-2", title: "November cut", targetDate: "2026-11-30" }, progress: progress({ counts: { done: 1, ready: 3 } }) }),
      finished("STA-3", "2026-08-01T00:00:00.000Z"),
    ],
    effective: [],
  };

  it("gives each workspace a heading strip with its name and quiet counts, then its open milestones, then its Finished line, folded", () => {
    const html = page([staple]);
    const group = html.slice(html.indexOf('data-milestone-group="staple"'));
    expect(group).toContain('data-milestone-group-heading=""');
    expect(text(group)).toMatch(/^[^]*staple 2 open · 1 finished/);
    // The open ones in the workspace page's own order, then the shelf.
    const order = [...group.matchAll(/data-milestone-header-link="([^"]+)"|data-milestone-group-shelf="([^"]+)"/g)].map((match) => match[1] ?? `shelf:${match[2]}`);
    expect(order).toEqual(["STA-1", "STA-2", "shelf:staple"]);
    expect(text(group)).toContain("Finished 1 · show");
    expect(group).toMatch(/data-milestone-group-shelf="staple"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*data-milestone-group-shelf="staple"/);
    // Folded: the finished milestone is not drawn until the line is opened.
    expect(group).not.toContain('data-milestone-finished-link="STA-3"');
    // Full width, and no heading paragraph: the top bar names the page.
    expect(html).not.toContain("Milestones in every workspace");
    expect(html).not.toContain("max-w-3xl");
  });

  it("draws each open milestone as the outline's header, as one control that says where it goes", () => {
    const html = page([staple]);
    const header = html.slice(html.indexOf('data-milestone-header-link="STA-1"'), html.indexOf('data-milestone-header-link="STA-2"'));
    const tag = html.slice(html.lastIndexOf("<", html.indexOf('data-milestone-header-link="STA-1"')), html.indexOf(">", html.indexOf('data-milestone-header-link="STA-1"')));
    expect(tag).toContain('role="button"');
    expect(tag).toContain('tabindex="0"');
    expect(tag).toContain('aria-label="Open October cut in staple"');
    expect(tag).toContain("hover:bg-surface-hover");
    expect(tag).toContain("focus-ring-inset");
    // The header's parts: the glyph, the name, the due date in words, the queue chip as text, the bar, the facts.
    expect(header).toContain("data-milestone-glyph");
    expect(text(header)).toContain("October cut");
    expect(header).toContain('data-milestone-target=""');
    expect(header).toContain('data-milestone-queued="2"');
    expect(header).toContain('data-milestone-bar=""');
    expect(header).toContain('data-milestone-facts=""');
    // Read-only: nothing inside it is a control of its own.
    for (const control of ["data-milestone-fold", "data-milestone-menu", "data-milestone-due-button", "data-milestone-queue=", "data-milestone-open=", "<button"]) {
      expect(header, control).not.toContain(control);
    }
    // Not stuck: the heading strip and the headers scroll with the page.
    expect(html).not.toContain("sticky");
  });

  it("keeps a failed workspace's line under its heading strip, and draws the others", () => {
    const boom = new ApiError(500, { code: "unknown", message: "database is locked" });
    const html = page([{ workspace: "broken", ok: false, error: boom }, staple]);
    const failed = html.slice(html.indexOf('data-milestone-group-failed="broken"'));
    expect(failed).toContain('data-milestone-group-heading=""');
    expect(text(failed)).toContain("Could not read this workspace's milestones: database is locked");
    expect(html).toContain('data-milestone-header-link="STA-1"');
  });

  it("leaves out workspaces with no milestones, and with none anywhere shows the outline's empty state without + Milestone", () => {
    const html = page([{ workspace: "empty", ok: true, rows: [] }, { workspace: "off", ok: false, error: missingKindError() }]);
    expect(html).toContain('data-all-milestones-empty=""');
    expect(text(html)).toContain("No milestones here yet");
    expect(html).not.toContain("data-create-milestone");
    expect(html).not.toContain("data-milestone-group");
  });

  it("with only finished ones, gives each group its No open milestones line and its Finished line", () => {
    const html = page([{ workspace: "staple", ok: true, rows: [finished("STA-3", "2026-08-01T00:00:00.000Z")], effective: [] }]);
    const group = html.slice(html.indexOf('data-milestone-group="staple"'));
    expect(text(group)).toContain("0 open · 1 finished");
    expect(group).toContain('data-milestones-none-open=""');
    expect(text(group)).toContain("No open milestones");
    expect(group).toContain('data-milestone-group-shelf="staple"');
  });

  it("under 760px puts the percent on the name line, and the due date and queue chip in the facts", () => {
    const desk = atWidth(1440, () => page([staple]));
    const phone = atWidth(390, () => page([staple]));
    expect(desk).not.toContain("data-milestone-facts-due");
    expect(phone).toContain("data-milestone-facts-due");
    const facts = phone.slice(phone.indexOf("data-milestone-facts-due"));
    expect(text(facts.slice(0, facts.indexOf("</div>")))).toContain("· Queued #2");
    // The queue chip is text in the facts there, not the desk's chip on the name line.
    expect(phone).not.toContain('data-milestone-queued="2"');
  });
});

describe("a workspace without milestones turned on", () => {
  it("says so in a plain sentence, with no command line in sight", () => {
    const html = renderToStaticMarkup(<MilestonesOff workspace="data-pipeline" />);
    expect(html).toContain("Milestones are not turned on in data-pipeline.");
    expect(html).toContain("Turn on milestones in Settings");
    expect(html).not.toContain("staple kinds");
    expect(html).not.toContain("--label");
  });

  it("opens Settings on that workspace's kinds", () => {
    const events: Array<{ type: string; detail: unknown }> = [];
    const globals = globalThis as { window?: unknown; CustomEvent?: unknown };
    const hadCustomEvent = "CustomEvent" in globalThis;
    globals.window = { dispatchEvent: (event: { type: string; detail: unknown }) => events.push(event) };
    try {
      turnOnMilestones("data-pipeline");
    } finally {
      delete globals.window;
    }
    expect(hadCustomEvent).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toEqual({ section: "kinds", workspace: "data-pipeline" });
  });
});
