/**
 * Estimates is a lens of Analytics. The old address (`?view=estimate-accuracy`), the `calibration`
 * view id and the palette's "Go to Estimates" all open Analytics on the Estimates lens for the
 * same workspace; the standalone page is no longer routed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCommands } from "@/components/command-palette/commands";
import { viewLanding, type AnalyticsLanding } from "@/lib/session";
import { readShellUrl } from "@/lib/session-url";
import { openingLens, openingWorkspace } from "./AnalyticsView";

const WORKSPACES = [{ slug: "staple" }, { slug: "exercises-api" }];

describe("where a request for Estimates lands", () => {
  it("sends the calibration view to Analytics on the Estimates lens, for the workspace it was asked from", () => {
    expect(viewLanding("calibration", "staple", 4)).toEqual({ view: "analytics", analytics: { lens: "estimates", workspace: "staple", seq: 4 } });
    expect(viewLanding("calibration", "", 5)).toEqual({ view: "analytics", analytics: { lens: "estimates", workspace: "", seq: 5 } });
  });

  it("lands every other view on itself, with no landing left over", () => {
    expect(viewLanding("analytics", "staple", 6)).toEqual({ view: "analytics", analytics: null });
    expect(viewLanding("tree", "staple", 7)).toEqual({ view: "tree", analytics: null });
  });

  it("reads the old address and its internal id as the Estimates view, so both land there", () => {
    for (const address of ["?ws=staple&view=estimate-accuracy", "?ws=staple&view=calibration"]) {
      const read = readShellUrl(address)!;
      expect(viewLanding(read.view, read.ws, 1)).toEqual({ view: "analytics", analytics: { lens: "estimates", workspace: "staple", seq: 1 } });
    }
  });

  it("is what the palette's Go to Estimates asks for", () => {
    const command = buildCommands({ planningEnabled: true, selection: null, selectionStatus: null, view: "tree", ws: "", assignee: "", workspaces: [{ slug: "staple", prefix: "STA" }], hub: false }).find((item) => item.label === "Go to Estimates");
    expect(command?.action).toEqual({ type: "view", view: "calibration" });
    expect(viewLanding("calibration", "exercises-api", 2).view).toBe("analytics");
  });
});

describe("the Analytics page opening on a landing", () => {
  const landing = (workspace: string): AnalyticsLanding => ({ lens: "estimates", workspace, seq: 3 });

  it("opens on the landing's lens and workspace, over what the address says", () => {
    expect(openingLens("?view=analytics&lens=return", landing("staple"))).toBe("estimates");
    expect(openingWorkspace("?view=analytics&workspace=exercises-api", landing("staple"), WORKSPACES, true)).toBe("staple");
    // From every workspace: every workspace.
    expect(openingWorkspace("?view=analytics&workspace=exercises-api", landing(""), WORKSPACES, true)).toBe("");
  });

  it("opens on the address's own lens and workspace without a landing", () => {
    expect(openingLens("?view=analytics&lens=return", null)).toBe("return");
    expect(openingLens("?view=analytics&lens=nonsense", null)).toBe("overview");
    expect(openingWorkspace("?view=analytics&workspace=exercises-api", null, WORKSPACES, true)).toBe("exercises-api");
  });

  it("ignores a workspace this hub does not have, or any workspace outside hub mode", () => {
    expect(openingWorkspace("", landing("ghost"), WORKSPACES, true)).toBe("");
    expect(openingWorkspace("", landing("staple"), WORKSPACES, false)).toBe("");
  });
});

describe("the app's routes", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");

  it("no longer renders the standalone Estimates page", () => {
    expect(app).not.toMatch(/CalibrationView/);
    expect(app).toMatch(/calibration: AnalyticsView,/);
  });

  it("lands the first address, Back and Forward, and every view switch through viewLanding", () => {
    expect(app).toMatch(/const landing = viewLanding\(url\.view, url\.ws, 1\);/);
    expect(app).toMatch(/const landing = viewLanding\(read\.view, read\.ws, \(landingSeq\.current \+= 1\)\);/);
    expect(app).toMatch(/const landing = viewLanding\(next, ws, \(landingSeq\.current \+= 1\)\);/);
    expect(app).toMatch(/analyticsLanding,\n\s+milestoneFocus,/);
  });
});
