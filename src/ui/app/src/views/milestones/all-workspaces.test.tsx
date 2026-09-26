/**
 * Milestones in All workspaces (review items 7 and 8).
 *
 *   7 — All workspaces lists every workspace's milestones, grouped, read-only; workspaces
 *       with none are left out; opening one is the moment the page switches workspace.
 *   8 — a workspace without the milestone kind never shows the store's command-line
 *       sentence: a plain sentence and one button to that workspace's kinds in Settings.
 *
 * The "no milestone kind" error is produced by the REAL store guard and the REAL envelope
 * the UI server sends (core/milestones.ts → core/types.ts `errorEnvelope` → api.ts
 * `ApiError`), not a hand-written object, so the test breaks if the server's shape changes.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assertMilestoneKindConfigured } from "../../../../../core/milestones";
import { errorEnvelope, StapleError } from "../../../../../core/types";
import { ApiError, AuthError } from "@/lib/api";
import type { MilestoneListRow } from "@/lib/types";
import { MilestoneListPane } from "./MilestonesView";
import { MilestonesOff, openMilestoneIn, readAllMilestones, turnOnMilestones } from "./AllWorkspacesMilestones";
import { listRow } from "./fixtures";
import { groupAllMilestones, isMissingMilestoneKind } from "./milestones-model";

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

  it("keeps a real failure visible under its workspace instead of hiding it", () => {
    const boom = new ApiError(500, { code: "unknown", message: "database is locked" });
    expect(groupAllMilestones([{ workspace: "staple", ok: false, error: boom }]).failed).toEqual([
      { workspace: "staple", error: boom },
    ]);
  });

  it("reads every workspace, and one failing does not hide the others", async () => {
    const asked: string[] = [];
    const results = await readAllMilestones(
      [{ slug: "a" }, { slug: "b" }],
      false,
      async ({ ws }) => {
        asked.push(ws!);
        if (ws === "a") throw missingKindError();
        return [row("B-1")];
      },
    );
    expect(asked).toEqual(["a", "b"]);
    expect(results.map((r) => [r.workspace, r.ok])).toEqual([["a", false], ["b", true]]);
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
    openMilestoneIn({ setWs: (ws) => calls.push(`ws:${ws}`), focusMilestone: (ref) => calls.push(`focus:${ref}`) }, "marketing-site", "MAR-4");
    expect(calls).toEqual(["ws:marketing-site", "focus:MAR-4"]);
  });

  it("is read-only: a row is one button that opens, with no reorder or remove controls", () => {
    const html = renderToStaticMarkup(<MilestoneListPane rows={[row("MAR-4")]} selectedRef={null} onSelect={() => {}} />);
    expect(html).toContain('data-milestone-row="MAR-4"');
    expect(html).not.toMatch(/Move|Remove|Add member/);
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
