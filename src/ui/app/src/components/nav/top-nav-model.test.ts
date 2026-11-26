import { describe, expect, it, vi } from "vitest";
import type { RunEntry, RunTicket } from "@/lib/types";
import {
  autopilotLiveText,
  autopilotTabLabel,
  currentTopRow,
  inboxRowMark,
  inboxTabLabel,
  liveDotTone,
  moreIsCurrent,
  moreSheetViews,
  openRunOnPlainClick,
  runSubRowAside,
  runSubRowLabel,
  runSubRows,
  tabBadgeText,
} from "./top-nav-model";

const ticket = (over: Partial<RunTicket>): RunTicket => ({
  seq: 1,
  issueId: "i-1",
  identifier: "STA-1",
  takenAt: "2026-11-26T12:00:00.000Z",
  outcome: null,
  reason: null,
  attemptId: null,
  recordedAt: null,
  ...over,
});

/** A live run as the payload carries it, with only what the rail reads. */
function run(id: string, over: { state?: "active" | "paused"; tickets?: RunTicket[]; wait?: boolean; stop?: boolean; issues?: RunEntry["issues"]; workspace?: string } = {}): RunEntry {
  const decision = over.stop
    ? { stop: true, reason: "budget", state: "stopped", detail: {}, message: "" }
    : over.wait
      ? { stop: false, wait: { reason: "waiting_on_others", detail: {}, message: "" } }
      : { stop: false };
  return {
    workspace: over.workspace ?? "staple",
    title: `Run ${id}`,
    issues: over.issues ?? [],
    run: { id, state: over.state ?? "active", tickets: over.tickets ?? [], scope: { kind: "queue" } },
    decision,
    facts: null,
    driver: null,
    goal: null,
    instructionsChanged: [],
  } as unknown as RunEntry;
}

describe("the Inbox row's mark", () => {
  it("shows what waits and a dot for what is new, and says both to a screen reader", () => {
    expect(inboxRowMark({ waiting: 28, unseen: 2 })).toEqual({ count: "28", fresh: true, spoken: ", 28 waiting, 2 new" });
    expect(inboxRowMark({ waiting: 28, unseen: 0 })).toEqual({ count: "28", fresh: false, spoken: ", 28 waiting" });
  });

  it("is nothing at all when nothing waits", () => {
    expect(inboxRowMark({ waiting: 0, unseen: 0 })).toEqual({ count: null, fresh: false, spoken: "" });
  });
});

describe("the Autopilot row and its live runs", () => {
  it("says how many runs are live, and nothing when none is", () => {
    expect(autopilotLiveText(2)).toBe("2 live");
    expect(autopilotLiveText(0)).toBeNull();
  });

  it("lists up to four live runs, and folds a fifth and later into one 'n more'", () => {
    const four = ["a", "b", "c", "d"].map((id) => run(id));
    expect(runSubRows(four)).toEqual({ shown: four, more: 0 });
    const six = ["a", "b", "c", "d", "e", "f"].map((id) => run(id));
    const folded = runSubRows(six);
    expect(folded.shown.map((entry) => entry.run.id)).toEqual(["a", "b", "c", "d"]);
    expect(folded.more).toBe(2);
    expect(runSubRows(six.slice(0, 5)).more).toBe(1);
  });

  it("names the open ticket of a working run by its identifier now, else the one it was taken as", () => {
    const renamed = run("a", {
      tickets: [ticket({ seq: 1, issueId: "i-1", identifier: "STA-1", outcome: "done" }), ticket({ seq: 2, issueId: "i-2", identifier: "STA-2" })],
      issues: [{ issueId: "i-2", identifier: "EXE-366", title: "t", status: "in_progress", category: "active", kind: "task" }],
    });
    expect(runSubRowAside(renamed)).toBe("EXE-366");
    const plain = run("b", { tickets: [ticket({ issueId: "i-9", identifier: "STA-9" })] });
    expect(runSubRowAside(plain)).toBe("STA-9");
  });

  it("says the state instead when the run is not working a ticket: paused, waiting, or nothing taken", () => {
    expect(runSubRowAside(run("a", { state: "paused", tickets: [ticket({})] }))).toBe("Paused");
    expect(runSubRowAside(run("b", { wait: true }))).toBe("Waiting on work others hold");
    expect(runSubRowAside(run("c"))).toBe("Working");
  });

  it("is named for its title and state, its ticket when it has one, and its workspace on All workspaces", () => {
    const working = run("a", { tickets: [ticket({ identifier: "STA-9" })], workspace: "exercises-api" });
    expect(runSubRowLabel(working, false)).toBe("Run a, Working, STA-9");
    expect(runSubRowLabel(working, true)).toBe("Run a, Working, STA-9, exercises-api");
    expect(runSubRowLabel(run("b", { state: "paused" }), true)).toBe("Run b, Paused, staple");
  });
});

describe("which top row is current", () => {
  const shown = ["live-1", "live-2"];

  it("is the Inbox on the Inbox, and nothing on any other view", () => {
    expect(currentTopRow("attention", null, shown)).toBe("view:attention");
    expect(currentTopRow("tree", null, shown)).toBeNull();
    // A stale run on another view marks nothing.
    expect(currentTopRow("tree", "live-1", shown)).toBeNull();
  });

  it("is the Autopilot row on the run list and on a run that is not listed under it", () => {
    expect(currentTopRow("autopilot", null, shown)).toBe("view:autopilot");
    // An ended run, or a live one folded into "n more".
    expect(currentTopRow("autopilot", "ended-1", shown)).toBe("view:autopilot");
  });

  it("is the live run's own sub-row on that run", () => {
    expect(currentTopRow("autopilot", "live-2", shown)).toBe("run:live-2");
  });
});

describe("a run sub-row's click", () => {
  const click = (over: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...over,
  });

  it("opens the run in the page on a plain click, instead of loading the link", () => {
    const open = vi.fn();
    const event = click();
    openRunOnPlainClick(event, open);
    expect(open).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves a modified or middle click to the browser: a new tab, a new window", () => {
    for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const open = vi.fn();
      const event = click(over);
      openRunOnPlainClick(event, open);
      expect(open, JSON.stringify(over)).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe("the phone's tab bar", () => {
  it("badges the Inbox with what waits, capped at 99+, and names it in words", () => {
    expect(tabBadgeText(0)).toBeNull();
    expect(tabBadgeText(28)).toBe("28");
    expect(tabBadgeText(99)).toBe("99");
    expect(tabBadgeText(100)).toBe("99+");
    expect(inboxTabLabel(28)).toBe("Inbox, 28 waiting");
    expect(inboxTabLabel(0)).toBe("Inbox");
  });

  it("dots Autopilot green while any live run is working, amber when every one waits or is paused", () => {
    expect(liveDotTone([])).toBeNull();
    expect(liveDotTone([run("a", { state: "paused" }), run("b")])).toBe("ok");
    expect(liveDotTone([run("a", { state: "paused" }), run("b", { wait: true })])).toBe("tight");
    expect(autopilotTabLabel(2)).toBe("Autopilot, 2 runs live");
    expect(autopilotTabLabel(1)).toBe("Autopilot, 1 run live");
    expect(autopilotTabLabel(0)).toBe("Autopilot");
  });

  it("marks More as the page when the view is not one of the four tabs", () => {
    expect(moreIsCurrent("graph")).toBe(true);
    expect(moreIsCurrent("budget")).toBe(true);
    for (const view of ["attention", "autopilot", "tree", "queue"] as const) expect(moreIsCurrent(view)).toBe(false);
  });

  it("puts every other view in the More sheet, the machine's apart, and Plan only with planning on", () => {
    expect(moreSheetViews(true)).toEqual({ views: ["graph", "milestones", "plan", "calibration"], machine: ["budget"] });
    expect(moreSheetViews(false)).toEqual({ views: ["graph", "milestones", "calibration"], machine: ["budget"] });
    expect(moreSheetViews(undefined).views).not.toContain("plan");
  });
});
