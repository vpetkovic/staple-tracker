import { describe, expect, it } from "vitest";
import {
  findRun,
  headerPill,
  instructionsLine,
  isRetry,
  listTime,
  noTicketsText,
  nowEyebrow,
  runPill,
  runTitle,
  scopeLine,
  sentence,
  shownRun,
  statTiles,
  tally,
  takenLine,
} from "./autopilot-text";
import { entry, failedEntry, issue, NOW, run, workingEntry } from "./fixtures";

const keys = (tiles: ReturnType<typeof statTiles>) => tiles.map((tile) => tile.key);

describe("run title and scope", () => {
  it("prints the payload's title, and the scope in words without one", () => {
    expect(runTitle(entry({ title: "Queue: Adopt staple" }))).toBe("Queue: Adopt staple");
    expect(runTitle({ ...entry(), title: undefined } as never)).toBe("Whole queue");
  });

  it("names an epic or milestone scope by its identifier as it is now", () => {
    const epic = entry({ run: run({ scope: { kind: "issue", issueId: "i-1", identifier: "STA-1" } }), issues: [issue({ issueId: "i-1", identifier: "STA-369" })] });
    expect(scopeLine(epic)).toBe("Epic STA-369");
    const milestone = entry({ run: run({ scope: { kind: "milestone", issueId: "gone", identifier: "STA-533" } }) });
    expect(scopeLine(milestone)).toBe("Milestone STA-533");
    expect(scopeLine(entry())).toBe("Whole queue");
  });
});

describe("state pills", () => {
  it("a working run names the ticket it holds, by its identifier now", () => {
    const working = workingEntry();
    working.issues = working.issues.map((row) => (row.issueId === "i-366" ? { ...row, identifier: "EXE-400" } : row));
    expect(runPill(working)).toEqual({ text: "Working on EXE-400", tone: "ok" });
  });

  it("a paused run says so, and an ended run says why", () => {
    expect(runPill(workingEntry({ run: run({ state: "paused", tickets: workingEntry().run.tickets }) })).text).toBe("Paused");
    expect(runPill(failedEntry()).text).toBe("AII-37 failed twice in a row");
  });

  it("the header calls an ended run Finished or Stopped, in the tone it ended in", () => {
    expect(headerPill(failedEntry())).toEqual({ text: "Stopped", tone: "risk" });
  });
});

describe("list lines", () => {
  it("times a live run from its start and an ended one from its end", () => {
    expect(listTime(workingEntry().run, NOW)).toBe("6m");
    expect(listTime(failedEntry().run, NOW)).toBe("4m ago");
  });

  it("places an ended run with one unit", () => {
    const ended = { ...failedEntry().run, endedAt: new Date(NOW.getTime() - (12 * 60 + 50) * 60_000).toISOString() };
    expect(listTime(ended, NOW)).toBe("12h ago");
  });

  it("tallies done and failed, else what is in progress or that it took nothing", () => {
    expect(tally(workingEntry().run)).toEqual([
      { text: "2 done", tone: "ok" },
      { text: "1 failed", tone: "risk" },
    ]);
    expect(tally(run({ counts: { tickets: 1, taken: 1, done: 0, failed: 0, open: 1 } }))).toEqual([{ text: "1 in progress", tone: "quiet" }]);
    expect(tally(run())).toEqual([{ text: "no tickets", tone: "quiet" }]);
  });
});

describe("the Now panel's words", () => {
  it("says when the open ticket was taken and for how long", () => {
    expect(takenLine({ takenAt: "2026-11-26T12:03:00.000Z" }, NOW)).toMatch(/^taken \d\d:\d\d · 5m so far$/);
  });

  it("names what a live run is doing", () => {
    expect(nowEyebrow(workingEntry(), NOW)).toEqual({ label: "Working on", detail: null });
    expect(nowEyebrow(workingEntry({ run: run({ state: "paused" }) }), NOW).label).toBe("Paused on");
    const waiting = workingEntry({ decision: { stop: false, wait: { reason: "waiting_on_others", detail: { rows: [{ identifier: "EXE-1" }] }, message: "" } } });
    expect(nowEyebrow(waiting, NOW)).toEqual({ label: "Waiting", detail: "Waiting on EXE-1" });
    const stopping = workingEntry({ decision: { stop: true, reason: "scope_empty", state: "completed", detail: {}, message: "" } });
    expect(nowEyebrow(stopping, NOW)).toEqual({ label: "Stopping", detail: "will stop: finished: nothing left to do" });
  });
});

describe("stat tiles by budget", () => {
  const withBudget = (budget: Partial<ReturnType<typeof run>["budget"]>, over: Parameters<typeof run>[0] = {}) =>
    entry({ run: run({ ...over, budget: { maxTickets: null, until: null, ceilingPercent: null, ceilingAccount: null, ...budget } }) });

  it("a run with no limit says so, and what stops it", () => {
    const tiles = statTiles(withBudget({}), NOW);
    expect(keys(tiles)).toEqual(["done", "left", "limit", "took"]);
    expect(tiles.find((tile) => tile.key === "limit")?.note).toBe("stops when nothing is left");
  });

  it("shows each limit that is set, and only those", () => {
    expect(keys(statTiles(withBudget({ maxTickets: 8 }), NOW))).toEqual(["done", "left", "tickets", "took"]);
    expect(keys(statTiles(withBudget({ until: "2026-11-26T14:00:00.000Z" }), NOW))).toEqual(["done", "left", "time", "took"]);
    expect(keys(statTiles(withBudget({ ceilingPercent: 80 }), NOW))).toEqual(["done", "left", "usage", "took"]);
  });

  it("an ended run has no 'Left in scope' and says how long it took", () => {
    const tiles = statTiles(failedEntry(), NOW);
    expect(keys(tiles)).toEqual(["done", "tickets", "took"]);
    expect(tiles.at(-1)).toMatchObject({ label: "Took", value: "2s" });
  });

  it("counts what is left, ready and waiting", () => {
    const left = statTiles(workingEntry(), NOW).find((tile) => tile.key === "left");
    expect(left).toMatchObject({ value: "3", note: "1 ready, 1 waiting on others" });
  });

  it("the ticket limit reads 3 of 8 with its meter", () => {
    expect(statTiles(workingEntry(), NOW).find((tile) => tile.key === "tickets")).toMatchObject({ value: "3", of: " of 8", meter: 3 / 8 });
  });

  it("usage prints the used share only when the facts carry it", () => {
    const known = withBudget({ ceilingPercent: 80 });
    known.facts = { ...known.facts!, ceiling: { usedPercent: 41, accountRef: null, limitKey: null, missing: null } };
    expect(statTiles(known, NOW).find((tile) => tile.key === "usage")).toMatchObject({ value: "41%", of: " of 80%" });
    expect(statTiles(withBudget({ ceilingPercent: 80 }), NOW).find((tile) => tile.key === "usage")).toEqual({ key: "usage", label: "Usage limit", value: "80%" });
  });
});

describe("tickets", () => {
  it("marks a take as a retry when an earlier take had the same issue", () => {
    const all = workingEntry().run.tickets;
    expect(all.map((_, i) => isRetry(all, i))).toEqual([false, false, true, false]);
  });

  it("makes a failure reason a sentence", () => {
    expect(sentence("the agent session ran out of time")).toBe("The agent session ran out of time.");
    expect(sentence("Already one.")).toBe("Already one.");
  });

  it("says a live run has taken nothing yet, and a goal run that its goal was checked", () => {
    expect(noTicketsText(entry())).toBe("It has taken no tickets yet.");
    const goal = { gateOwner: "VP", childCap: 3, children: [], gatedAt: null };
    expect(noTicketsText(entry({ run: run({ state: "completed", goal }) }))).toBe("It took no tickets. The goal was checked against work already done.");
    expect(noTicketsText(failedEntry())).toBe("It took no tickets.");
  });

  it("lists changed instruction documents, and nothing when none changed", () => {
    expect(instructionsLine(entry())).toBeNull();
    const change = { seq: 1, ref: "STA-1", issueId: "i", key: "rules", revision: 2, instructions: true, actor: null, at: NOW.toISOString() };
    expect(instructionsLine(entry({ instructionsChanged: [change, { ...change, seq: 2, key: "stacking" }] }))).toBe(
      "2 instruction documents changed since its last take: rules, stacking",
    );
  });
});

describe("which run the page shows", () => {
  const ended = failedEntry();
  const live = workingEntry();

  it("with nothing selected on a wide page, the newest live run, else the newest", () => {
    expect(shownRun([ended, live], null, true)).toBe(live);
    expect(shownRun([ended], null, true)).toBe(ended);
  });

  it("with nothing selected on a narrow page, no run: the list", () => {
    expect(shownRun([ended, live], null, false)).toBeNull();
  });

  it("finds a run by its id or a unique prefix of eight characters, and nothing else", () => {
    expect(findRun([ended, live], ended.run.id)).toBe(ended);
    expect(findRun([ended, live], "b2be7256")).toBe(ended);
    expect(findRun([ended, live], "b2be")).toBeNull();
    expect(shownRun([ended, live], "nope-nope", true)).toBeNull();
  });
});
