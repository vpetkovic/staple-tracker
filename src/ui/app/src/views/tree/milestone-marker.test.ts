import { describe, expect, it } from "vitest";
import { openMilestoneMarker } from "./milestone-marker";

function recorder(over: { mode?: "hub" | "workspace"; ws?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    session: {
      mode: over.mode ?? "hub",
      ws: over.ws ?? "",
      setWs: (slug: string) => calls.push(`ws:${slug}`),
      focusMilestone: (ref: string | null) => calls.push(`milestones:${ref}`),
      openHorizon: (workspace: string, ref: string) => calls.push(`plan:${workspace}/${ref}`),
    },
  };
}

describe("a row's milestone marker", () => {
  it("opens a horizon where the plan shows it, in its own workspace, from any workspace scope", () => {
    const all = recorder();
    openMilestoneMarker(all.session, "staple", "STA-493", true);
    expect(all.calls).toEqual(["plan:staple/STA-493"]);
  });
  it("opens any other milestone in the Milestones view of its workspace", () => {
    const milestone = recorder();
    openMilestoneMarker(milestone.session, "staple", "STA-571", false);
    expect(milestone.calls).toEqual(["ws:staple", "milestones:STA-571"]);
  });
});
