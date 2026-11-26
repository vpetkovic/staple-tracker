/**
 * Which run the Autopilot page shows when its address names none.
 */
import { describe, expect, it } from "vitest";
import { currentRef, defaultRun, runAnswerFor } from "./runs";
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

describe("runAnswerFor", () => {
  it("answers for the run asked, and reads as loading while the answer on hand is another run's", () => {
    const notFound = { id: "a", entry: null, error: new Error("No autopilot run a") };
    expect(runAnswerFor("a", notFound)).toEqual({ entry: null, error: notFound.error, loading: false });
    // Following a link to b after a's 404: b is loading, not "No autopilot run a".
    expect(runAnswerFor("b", notFound)).toEqual({ entry: null, error: undefined, loading: true });
    const b = entry("b", "stopped");
    expect(runAnswerFor("b", { id: "b", entry: b, error: undefined })).toEqual({ entry: b, error: undefined, loading: false });
    expect(runAnswerFor("b", null).loading).toBe(true);
  });
});

describe("currentRef", () => {
  it("opens a ticket by its identifier now, not the one the run recorded, and falls back when it is gone", () => {
    const run = { tickets: [{ identifier: "APP-5", issueId: "x" }, { identifier: "APP-6", issueId: "gone" }] } as unknown as RunEntry["run"];
    const issues = [{ issueId: "x", identifier: "APP-9" }] as RunEntry["issues"];
    expect(currentRef({ run, issues }, "APP-5")).toBe("APP-9");
    expect(currentRef({ run, issues }, "APP-6")).toBe("APP-6");
    expect(currentRef({ run, issues }, "APP-7")).toBe("APP-7");
  });
});
