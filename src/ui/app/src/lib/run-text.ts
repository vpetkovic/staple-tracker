/**
 * Autopilot runs in plain words: the banner line, why a run ended or waits, what would stop
 * it, whether a driver is attached, and how each ticket went.
 *
 * Every figure comes off `GET /api/runs` (the object `staple run status --json` prints).
 * This module PHRASES the tracker's reason codes and never decides anything itself: whether
 * a run goes on is `evaluateStopRules` in core/run-store.ts, and the page only says what it
 * answered. The codes are a public contract (docs/runs.md) and every one of them has words
 * here; `STOP_REASON_WORDS` is a `Record` over the tuple, so a code added to core without
 * words fails to compile once the mirror in lib/types.ts learns it.
 *
 * `touched_main_line` is its own stop reason (`staple run drive` stops the run with it, by
 * `staple run drive`, when a session moved master or main): the most serious way a run can
 * end, so it is named as what it is. A ticket's failure reason is free text, but the
 * driver's own ones start with a code (`session exited 1`, `timed out: …`, `no_review: …`,
 * `stopped_by_human: …`, `touched_main_line: …`). Those get words; anything else is the
 * tracker's own sentence, passed through.
 *
 * A goal run (a run over a milestone, docs/runs.md "Goal mode") adds `goal_met`, the
 * `goal_children` budget and the goal check a live run is about to take; each has words.
 *
 * Pure and tested (run-text.test.ts).
 */
import type { Run, RunDecision, RunDriver, RunEntry, RunFacts, RunStop, RunStopReason, RunTicket, RunWaitReason } from "./types";

/** Who a stop was recorded by when the driver itself stopped the run. */
export const DRIVER_ACTOR = "staple run drive";

/** The plain words for each stop reason, before any detail is added. */
export const STOP_REASON_WORDS: Readonly<Record<RunStopReason, string>> = {
  stopped_by_human: "Stopped by a person",
  touched_main_line: "Stopped: a session changed master or main",
  budget: "Reached its limit",
  failure_streak: "Two tickets in a row failed",
  scope_gone: "Its work no longer exists",
  vp_blocked: "Waiting on a person",
  gate_pending: "Waiting for approval",
  goal_met: "Goal met: waiting for approval",
  scope_empty: "Finished: nothing left to do",
};

/** The plain words for each wait reason: the run is live and takes nothing right now. */
export const WAIT_REASON_WORDS: Readonly<Record<RunWaitReason, string>> = {
  paused: "Paused",
  waiting_on_others: "Waiting on work others hold",
  out_of_order: "Waiting: earlier work in the plan comes first",
};

const list = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const refsOf = (value: unknown, key = "identifier"): string[] =>
  Array.isArray(value) ? value.map((entry) => (typeof entry === "string" ? entry : String((entry as Record<string, unknown>)?.[key] ?? ""))).filter(Boolean) : [];

/** "2 tickets", "1 ticket". */
export function tickets(n: number): string {
  return `${n} ${n === 1 ? "ticket" : "tickets"}`;
}

/** A time of day, or a date and time when it is not today: "18:00", "28 Sep 18:00". */
export function clockText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? time : `${at.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

/**
 * Why a run ended, in one sentence a person reads first. The detail (which budget, which
 * tickets, whose approval) comes from `stop.detail`, which core fills per reason.
 */
export function stopReasonText(stop: Pick<RunStop, "reason" | "detail"> & Partial<Pick<RunStop, "by" | "note">>): string {
  const detail = stop.detail ?? {};
  switch (stop.reason) {
    case "stopped_by_human":
      return stop.by ? `Stopped by ${stop.by}` : STOP_REASON_WORDS.stopped_by_human;
    case "touched_main_line":
      return typeof detail.ticket === "string" && detail.ticket
        ? `Stopped: the session on ${detail.ticket} changed master or main`
        : STOP_REASON_WORDS.touched_main_line;
    case "budget": {
      if (detail.budget === "tickets") return `Reached its limit of ${tickets(Number(detail.maxTickets))}`;
      if (detail.budget === "time") return "Its time ran out";
      if (detail.budget === "ceiling") return `Usage reached its ${String(detail.ceilingPercent)}% limit`;
      if (detail.budget === "goal_children") {
        const of = typeof detail.milestone === "string" ? `${detail.milestone}'s goal` : "The goal";
        return `${of} is not met and it created all ${tickets(Number(detail.childCap))} it may`;
      }
      return STOP_REASON_WORDS.budget;
    }
    case "failure_streak": {
      // A retried ticket fails twice as itself: "ABC-1 failed twice in a row", not "ABC-1 and ABC-1".
      const refs = [...new Set(refsOf(detail.tickets))];
      if (refs.length === 1) return `${refs[0]} failed twice in a row`;
      return refs.length > 0 ? `${list(refs)} both failed in a row` : STOP_REASON_WORDS.failure_streak;
    }
    case "scope_gone":
      return "What it was working on no longer exists";
    case "vp_blocked": {
      const blocks = Array.isArray(detail.blocks) ? (detail.blocks as Array<{ identifier?: string; owner?: string }>) : [];
      const first = blocks[0];
      return first?.identifier && first.owner ? `${first.identifier} is waiting on ${first.owner}` : STOP_REASON_WORDS.vp_blocked;
    }
    case "gate_pending": {
      const refs = refsOf(detail.gates);
      return refs.length > 0 ? `${list(refs)} ${refs.length === 1 ? "is" : "are"} waiting for approval` : STOP_REASON_WORDS.gate_pending;
    }
    case "goal_met":
      return typeof detail.milestone === "string" && detail.milestone
        ? `Goal met: ${detail.milestone} is waiting for approval`
        : STOP_REASON_WORDS.goal_met;
    case "scope_empty":
      return STOP_REASON_WORDS.scope_empty;
  }
  return String(stop.reason);
}

/** Why a live run takes nothing now. */
export function waitReasonText(wait: { reason: RunWaitReason; detail?: Record<string, unknown> }): string {
  if (wait.reason === "waiting_on_others") {
    const rows = Array.isArray(wait.detail?.rows) ? (wait.detail!.rows as Array<{ identifier?: string }>) : [];
    const refs = rows.map((row) => row.identifier).filter((ref): ref is string => Boolean(ref));
    if (refs.length > 0) return `Waiting on ${list(refs.slice(0, 3))}${refs.length > 3 ? ` and ${refs.length - 3} more` : ""}`;
  }
  return WAIT_REASON_WORDS[wait.reason] ?? String(wait.reason);
}

/** A ticket's outcome, in words: "Done", "In progress", "Failed: the session ended with an error". */
export function ticketOutcomeText(ticket: Pick<RunTicket, "outcome" | "reason">): string {
  if (ticket.outcome === null) return "In progress";
  if (ticket.outcome === "done") return "Done";
  return ticket.reason ? `Failed: ${failureReasonText(ticket.reason)}` : "Failed";
}

/** A failure reason: the driver's codes in words, anything else as the tracker said it. */
export function failureReasonText(reason: string): string {
  const text = reason.trim();
  const exited = /^session exited (\S+)/.exec(text);
  if (exited) return `the agent session ended with an error (exit ${exited[1]})`;
  if (text.startsWith("timed out")) return "the agent session ran out of time";
  if (text.startsWith("no_review")) return "it finished without a review";
  if (text.startsWith("touched_main_line")) return "the session changed master or main";
  if (text.startsWith("stopped_by_human")) return "the run was stopped while it was being worked";
  return text;
}

/** The scope as the banner names it: "Queue", or the epic or milestone's reference. */
export function scopeText(run: Pick<Run, "scope">): string {
  if (run.scope.kind === "queue") return "Queue";
  return run.scope.identifier ?? "a deleted issue";
}

/**
 * What the run has done and what is left, as two numbers that measure different things and
 * never pretend to be one fraction: `done` is the distinct tickets THIS RUN handed on (a
 * fact about the run: a ticket reopened since stays one it did), `left` the unresolved rows
 * still in scope, whoever works them (a ticket in review, or reopened, is left). A milestone's
 * progress is its detail's to say (leaves done over countable leaves); a run is not the
 * milestone. Null without facts (an ended run): the history shows its tickets instead.
 */
export function progress(run: Pick<Run, "tickets" | "counts">, facts: Pick<RunFacts, "workable" | "waiting"> | null): { done: number; left: number } | null {
  if (facts === null) return null;
  const done = new Set(run.tickets.filter((ticket) => ticket.outcome === "done").map((ticket) => ticket.issueId));
  const left = new Set([...facts.workable, ...facts.waiting].map((row) => row.issueId));
  return { done: done.size, left: left.size };
}

/** "2 done this run · 9 left": the banner's words for {@link progress}. */
export function progressText(counted: { done: number; left: number }): string {
  return `${counted.done} done this run · ${counted.left} left`;
}

/**
 * The ticket the banner points at: the one being worked ("working ABC-3"), else the next the
 * queue would hand it ("next ABC-4"), else nothing.
 */
export function nextText(run: Pick<Run, "tickets">, facts: Pick<RunFacts, "workable"> | null): string | null {
  const open = [...run.tickets].reverse().find((ticket) => ticket.outcome === null);
  if (open) return `working ${open.identifier}`;
  const next = facts?.workable.find((row) => !row.held) ?? facts?.workable[0];
  return next ? `next ${next.identifier}` : null;
}

/**
 * What would stop a live run, the nearest rule first: its ticket budget, its end time, its
 * usage ceiling, and always the scope running dry. When the tracker already says the next
 * `continue` stops it, that is said instead.
 */
export function stopRuleText(run: Pick<Run, "budget" | "counts" | "tickets"> & Partial<Pick<Run, "goal">>, decision: RunDecision, now: Date = new Date()): string {
  if (decision.stop) return `will stop: ${lowerFirst(stopReasonText(decision))}`;
  const taken = new Set(run.tickets.map((ticket) => ticket.issueId)).size;
  const parts: string[] = [];
  if (run.budget.maxTickets !== null) parts.push(`stops after ${tickets(run.budget.maxTickets)} (${taken} taken)`);
  if (run.budget.until !== null) parts.push(`stops at ${clockText(run.budget.until, now)}`);
  if (run.budget.ceilingPercent !== null) parts.push(`stops at ${run.budget.ceilingPercent}% usage`);
  const last = run.goal ? "stops when its goal is met" : "stops when nothing is left";
  return parts.length > 0 ? parts.join(", ") : last;
}

/** Lower-case the first letter only, so a ticket reference inside the sentence keeps its case. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/** THE banner line: "Autopilot · ABC-40 · 2 done this run · 3 left · next ABC-43 · stops after 5 tickets (2 taken)". */
export function bannerLine(entry: Pick<RunEntry, "run" | "decision" | "facts">, now: Date = new Date()): string {
  const { run, decision, facts } = entry;
  const parts = ["Autopilot", scopeText(run)];
  const counted = progress(run, facts);
  if (counted) parts.push(progressText(counted));
  const next = nextText(run, facts);
  if (next) parts.push(next);
  parts.push(stopRuleText(run, decision, now));
  return parts.join(" · ");
}

export type RunTone = "ok" | "tight" | "risk" | "unknown";

/** A live run's state, in a word or two, with the tone its pill wears (never colour alone). */
export function liveStateText(entry: Pick<RunEntry, "run" | "decision">): { text: string; tone: RunTone } {
  const { run, decision } = entry;
  if (run.state === "paused") return { text: WAIT_REASON_WORDS.paused, tone: "tight" };
  if (decision.stop) return { text: "Stopping", tone: "risk" };
  if (decision.wait) return { text: waitReasonText(decision.wait), tone: "tight" };
  if (decision.goalCheck) return { text: "Checking its goal", tone: "ok" };
  return { text: "Working", tone: "ok" };
}

/** How an ended run ended: the reason in words, and a tone (a finished run is fine; a failure is not). */
export function endedStateText(run: Pick<Run, "state" | "stop">): { text: string; tone: RunTone } {
  if (run.stop === null) return { text: run.state === "completed" ? "Finished" : "Stopped", tone: "unknown" };
  const text = stopReasonText(run.stop);
  if (run.stop.reason === "scope_empty" || run.stop.reason === "goal_met") return { text, tone: "ok" };
  if (run.stop.reason === "failure_streak" || run.stop.reason === "touched_main_line") return { text, tone: "risk" };
  return { text, tone: "unknown" };
}

/** Whether a driver is attached to a live run, in words. */
export function driverText(driver: RunDriver | null): string {
  if (driver === null) return "No driver attached";
  if (driver.alive === true) return `Driver attached (${driver.agent})`;
  if (driver.alive === false) return "Driver stopped responding";
  return `Driver on ${driver.host}`;
}

/** Who ended a run, as a sentence: the person (or the driver), or the tracker's own rule. */
export function stoppedByText(run: Pick<Run, "state" | "stop">): string {
  if (run.stop === null) return "";
  if (run.stop.by) return `Stopped by ${run.stop.by}.`;
  return run.state === "completed" ? "It finished on its own." : "A stop rule ended it.";
}

/** A span of time, compact: "40s", "12m", "1h 20m", "2d 3h". */
export function durationText(fromIso: string, toIso: string | null, now: Date = new Date()): string {
  const from = Date.parse(fromIso);
  const to = toIso === null ? now.getTime() : Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "";
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** Is this run live (active or paused)? */
export function isLiveRun(run: Pick<Run, "state">): boolean {
  return run.state === "active" || run.state === "paused";
}
