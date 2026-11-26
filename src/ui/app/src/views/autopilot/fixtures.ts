/**
 * Run entries for the Autopilot page's tests, in the shape `GET /api/runs` serves (the
 * scratch hub's runs were the model). Each builder takes overrides for the part under test.
 */
import type { Run, RunEntry, RunIssue, RunTicket } from "@/lib/types";

export const NOW = new Date("2026-11-26T12:08:00.000Z");

export function issue(over: Partial<RunIssue> & Pick<RunIssue, "issueId" | "identifier">): RunIssue {
  return { title: `Title of ${over.identifier}`, status: "todo", category: "ready", kind: "task", ...over };
}

export function take(seq: number, over: Partial<RunTicket> & Pick<RunTicket, "issueId" | "identifier">): RunTicket {
  return {
    seq,
    takenAt: "2026-11-26T12:03:00.000Z",
    outcome: null,
    reason: null,
    attemptId: null,
    recordedAt: null,
    ...over,
  };
}

export function run(over: Partial<Run> = {}): Run {
  return {
    id: "e6b5ebbb-0000-4000-8000-000000000001",
    actor: "autopilot-nightly",
    scope: { kind: "queue" },
    state: "active",
    budget: { maxTickets: null, until: null, ceilingPercent: null, ceilingAccount: null },
    goal: null,
    override: null,
    instructions: [],
    tickets: [],
    counts: { tickets: 0, taken: 0, done: 0, failed: 0, open: 0 },
    stop: null,
    startedAt: "2026-11-26T12:02:00.000Z",
    updatedAt: "2026-11-26T12:03:00.000Z",
    endedAt: null,
    ...over,
  };
}

export function entry(over: Partial<RunEntry> = {}): RunEntry {
  return {
    workspace: "exercises-api",
    title: "Queue: Rewrite every existing exercise",
    issues: [],
    run: run(),
    decision: { stop: false },
    facts: { now: NOW.toISOString(), workable: [], waiting: [], pendingGates: [], personBlocks: [], ceiling: null },
    driver: null,
    goal: null,
    instructionsChanged: [],
    ...over,
  };
}

/** A live queue run working EXE-366 after EXE-298 was done and EXE-299 failed once, then done. */
export function workingEntry(over: Partial<RunEntry> = {}): RunEntry {
  return entry({
    issues: [
      issue({ issueId: "i-298", identifier: "EXE-298", status: "in_review", category: "review" }),
      issue({ issueId: "i-299", identifier: "EXE-299", status: "in_review", category: "review" }),
      issue({ issueId: "i-366", identifier: "EXE-366", status: "in_progress", category: "active", title: "Rewrite every existing exercise" }),
      issue({ issueId: "i-96", identifier: "EXE-96" }),
    ],
    run: run({
      budget: { maxTickets: 8, until: null, ceilingPercent: null, ceilingAccount: null },
      tickets: [
        take(1, { issueId: "i-298", identifier: "EXE-298", outcome: "done", takenAt: "2026-11-26T12:02:10.000Z", recordedAt: "2026-11-26T12:02:19.000Z" }),
        take(2, { issueId: "i-299", identifier: "EXE-299", outcome: "failed", reason: "session exited 1", takenAt: "2026-11-26T12:02:20.000Z", recordedAt: "2026-11-26T12:02:23.000Z" }),
        take(3, { issueId: "i-299", identifier: "EXE-299", outcome: "done", takenAt: "2026-11-26T12:02:30.000Z", recordedAt: "2026-11-26T12:02:40.000Z" }),
        take(4, { issueId: "i-366", identifier: "EXE-366", takenAt: "2026-11-26T12:03:00.000Z" }),
      ],
      counts: { tickets: 3, taken: 4, done: 2, failed: 1, open: 1 },
    }),
    facts: {
      now: NOW.toISOString(),
      workable: [
        { issueId: "i-366", identifier: "EXE-366", held: true },
        { issueId: "i-96", identifier: "EXE-96", held: false },
      ],
      waiting: [{ issueId: "i-500", identifier: "EXE-500", eligibility: "blocked", reason: null }],
      pendingGates: [],
      personBlocks: [],
      ceiling: null,
    },
    driver: { pid: 1, host: "here", agent: "claude", startedAt: "2026-11-26T12:02:00.000Z", heartbeatAt: "2026-11-26T12:07:50.000Z", ticket: "EXE-366", sessionPid: 2, logDir: "/tmp", alive: true },
    ...over,
  });
}

/** An ended queue run stopped after AII-37 failed twice in a row. */
export function failedEntry(over: Partial<RunEntry> = {}): RunEntry {
  return entry({
    workspace: "ai-inbox-supabase",
    title: "Queue: preset date ranges",
    issues: [issue({ issueId: "i-37", identifier: "AII-37", title: "Preset date ranges use the server's midnight" })],
    run: run({
      id: "b2be7256-0000-4000-8000-000000000002",
      actor: "codex-overnight",
      state: "stopped",
      budget: { maxTickets: 5, until: null, ceilingPercent: null, ceilingAccount: null },
      tickets: [
        take(1, { issueId: "i-37", identifier: "AII-37", outcome: "failed", reason: "timed out: 45m without progress", recordedAt: "2026-11-26T12:03:01.000Z" }),
        take(2, { issueId: "i-37", identifier: "AII-37", outcome: "failed", reason: "no_review: handed on without a review", recordedAt: "2026-11-26T12:03:02.000Z" }),
      ],
      counts: { tickets: 1, taken: 2, done: 0, failed: 2, open: 0 },
      stop: { reason: "failure_streak", detail: { tickets: ["AII-37", "AII-37"], limit: 2 }, by: null, note: null, at: "2026-11-26T12:03:02.000Z" },
      startedAt: "2026-11-26T12:03:00.000Z",
      updatedAt: "2026-11-26T12:03:02.000Z",
      endedAt: "2026-11-26T12:03:02.000Z",
    }),
    decision: { stop: true, reason: "failure_streak", state: "stopped", detail: {}, message: "The run already ended (failure_streak)." },
    facts: null,
    ...over,
  });
}
