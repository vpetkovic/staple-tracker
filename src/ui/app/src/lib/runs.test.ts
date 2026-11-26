/**
 * Which run the Autopilot page shows when its address names none.
 */
import { describe, expect, it } from "vitest";
import { defaultRun } from "./runs";
import type { RunEntry } from "./types";

const entry = (id: string, state: string): RunEntry => ({ workspace: "app", run: { id, state } }) as unknown as RunEntry;

describe("defaultRun", () => {
  it("is the newest live run, ahead of a newer ended one", () => {
    // `/api/runs` answers newest first.
    expect(defaultRun([entry("ended-new", "stopped"), entry("paused", "paused"), entry("active-old", "active")])?.run.id).toBe("paused");
  });

  it("is the newest run when none is live, and nothing when there are none", () => {
    expect(defaultRun([entry("b", "completed"), entry("a", "stopped")])?.run.id).toBe("b");
    expect(defaultRun([])).toBeNull();
  });
});
