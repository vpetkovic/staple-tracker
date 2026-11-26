/**
 * The Autopilot page's own phrasing: presentation only, over the payload and lib/run-text.ts.
 *
 * Nothing here decides a fact. States, reasons, counts and titles are the payload's and
 * run-text's; this file arranges them into the page's lines ("taken 12:03 · 5m so far",
 * "Epic STA-369", "3 of 8") and picks which run the page shows. Pure and tested
 * (autopilot-text.test.ts).
 */
import {
  clockText,
  durationText,
  endedStateText,
  isLiveRun,
  liveStateText,
  progress,
  stopRuleText,
  tickets,
  waitReasonText,
  type RunTone,
} from "@/lib/run-text";
import type { Run, RunEntry, RunFacts, RunTicket } from "@/lib/types";
import { formatAgo } from "@/lib/claim";

/** The page's width, in px, from which it shows the run list and a run side by side. */
export const AUTOPILOT_WIDE = 900;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const SCOPE_WORDS: Record<Run["scope"]["kind"], string> = { queue: "Whole queue", issue: "Epic", milestone: "Milestone" };

/** "Whole queue", "Epic", "Milestone". */
export function scopeWords(run: Pick<Run, "scope">): string {
  return SCOPE_WORDS[run.scope.kind];
}

/** The scope's identifier as it is NOW (the payload's issues), else as the run recorded it; null for the queue. */
export function scopeRef(entry: Pick<RunEntry, "run"> & { issues?: RunEntry["issues"] }): string | null {
  const scope = entry.run.scope;
  if (scope.kind === "queue") return null;
  return (entry.issues ?? []).find((issue) => issue.issueId === scope.issueId)?.identifier ?? scope.identifier;
}

/** "Whole queue", "Epic STA-369", "Milestone STA-533". */
export function scopeLine(entry: Pick<RunEntry, "run"> & { issues?: RunEntry["issues"] }): string {
  const ref = scopeRef(entry);
  return ref ? `${scopeWords(entry.run)} ${ref}` : scopeWords(entry.run);
}

/** The run's name: the payload's title, else its scope in words (an older payload has no title). */
export function runTitle(entry: Pick<RunEntry, "run"> & { title?: string; issues?: RunEntry["issues"] }): string {
  return entry.title?.trim() ? entry.title : scopeLine(entry);
}

/** The ticket a run holds now: its newest take with no outcome. */
export function openTicket(run: Pick<Run, "tickets">): RunTicket | null {
  return [...run.tickets].reverse().find((ticket) => ticket.outcome === null) ?? null;
}

/** A live run going about its work (not paused, waiting or stopping): its dot pulses. */
export function isWorking(entry: Pick<RunEntry, "run" | "decision">): boolean {
  return isLiveRun(entry.run) && liveStateText(entry).tone === "ok";
}

/** The run's state as its list item says it: a working run names the ticket it works on. */
export function runPill(entry: Pick<RunEntry, "run" | "decision"> & { issues?: RunEntry["issues"] }): { text: string; tone: RunTone } {
  if (!isLiveRun(entry.run)) return endedStateText(entry.run);
  const state = liveStateText(entry);
  const open = openTicket(entry.run);
  if (state.tone !== "ok" || open === null) return state;
  const ref = (entry.issues ?? []).find((issue) => issue.issueId === open.issueId)?.identifier ?? open.identifier;
  return { text: `Working on ${ref}`, tone: state.tone };
}

/** The header's state: a live run's state, or "Finished" / "Stopped" in the tone it ended in. */
export function headerPill(entry: Pick<RunEntry, "run" | "decision">): { text: string; tone: RunTone } {
  if (isLiveRun(entry.run)) return liveStateText(entry);
  return { text: entry.run.state === "completed" ? "Finished" : "Stopped", tone: endedStateText(entry.run).tone };
}

/** When the run ended: its end, else its last change. */
export function endedAt(run: Pick<Run, "endedAt" | "updatedAt">): string {
  return run.endedAt ?? run.updatedAt;
}

/** The list item's time: how long a live run has run, how long ago an ended one ended. */
export function listTime(run: Pick<Run, "state" | "startedAt" | "endedAt" | "updatedAt">, now: Date): string {
  if (isLiveRun(run)) return durationText(run.startedAt, null, now);
  // One unit is enough to place an ended run: "12h ago", not "12h 50m ago".
  return `${formatAgo((now.getTime() - Date.parse(endedAt(run))) / 1000)} ago`;
}

export type TallyTone = "ok" | "risk" | "quiet";

/** The list item's tally: "2 done", "1 failed", or "1 in progress" / "no tickets". */
export function tally(run: Pick<Run, "counts">): Array<{ text: string; tone: TallyTone }> {
  const { done, failed, open } = run.counts;
  const out: Array<{ text: string; tone: TallyTone }> = [];
  if (done > 0) out.push({ text: `${done} done`, tone: "ok" });
  if (failed > 0) out.push({ text: `${failed} failed`, tone: "risk" });
  if (out.length === 0) out.push({ text: open > 0 ? `${open} in progress` : "no tickets", tone: "quiet" });
  return out;
}

/** "taken 12:03 · 5m so far". */
export function takenLine(ticket: Pick<RunTicket, "takenAt">, now: Date): string {
  return `taken ${clockText(ticket.takenAt, now)} · ${durationText(ticket.takenAt, null, now)} so far`;
}

/** The live Now panel's eyebrow, with what it waits on or what stops it. */
export function nowEyebrow(entry: Pick<RunEntry, "run" | "decision">, now: Date): { label: string; detail: string | null } {
  const { run, decision } = entry;
  if (run.state === "paused") return { label: "Paused on", detail: null };
  if (decision.stop) return { label: "Stopping", detail: stopRuleText(run, decision, now) };
  if (decision.wait) return { label: "Waiting", detail: waitReasonText(decision.wait) };
  return { label: "Working on", detail: null };
}

/** The ended Now panel's eyebrow: "Finished · 12:03", "Stopped · 25 Nov 02:30". */
export function endedEyebrow(run: Pick<Run, "state" | "endedAt" | "updatedAt">, now: Date): string {
  return `${run.state === "completed" ? "Finished" : "Stopped"} · ${clockText(endedAt(run), now)}`;
}

export interface StatTile {
  key: "done" | "left" | "tickets" | "time" | "usage" | "limit" | "took";
  label: string;
  value: string;
  /** The quiet half of the value: " of 8". */
  of?: string;
  note?: string;
  /** 0..1, drawn as a 4px meter. */
  meter?: number;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** The stat tiles, by what the run has: limits only when set, "Left in scope" only while it runs. */
export function statTiles(entry: Pick<RunEntry, "run" | "facts">, now: Date): StatTile[] {
  const { run, facts } = entry;
  const live = isLiveRun(run);
  const { budget, counts } = run;
  const out: StatTile[] = [];
  out.push({ key: "done", label: "Done this run", value: String(counts.done), note: counts.failed > 0 ? `${plural(counts.failed, "take")} failed` : "none failed" });
  const counted = live ? progress(run, facts) : null;
  if (counted && facts) {
    const ready = facts.workable.filter((row) => !row.held).length;
    out.push({ key: "left", label: "Left in scope", value: String(counted.left), note: `${ready} ready, ${facts.waiting.length} waiting on others` });
  }
  if (budget.maxTickets !== null) {
    out.push({ key: "tickets", label: "Ticket limit", value: String(counts.tickets), of: ` of ${budget.maxTickets}`, meter: clamp01(counts.tickets / budget.maxTickets) });
  }
  if (budget.until !== null) {
    const start = Date.parse(run.startedAt);
    const end = Date.parse(budget.until);
    const at = run.endedAt ? Date.parse(run.endedAt) : now.getTime();
    out.push({
      key: "time",
      label: "Time limit",
      value: clockText(budget.until, now),
      note: live ? `${durationText(now.toISOString(), budget.until, now)} left` : "the end it was given",
      meter: clamp01((at - start) / (end - start)),
    });
  }
  if (budget.ceilingPercent !== null) {
    const used = facts?.ceiling?.usedPercent ?? null;
    out.push(
      used === null
        ? { key: "usage", label: "Usage limit", value: `${budget.ceilingPercent}%` }
        : { key: "usage", label: "Usage limit", value: `${used}%`, of: ` of ${budget.ceilingPercent}%` },
    );
  }
  if (budget.maxTickets === null && budget.until === null && budget.ceilingPercent === null) {
    out.push({ key: "limit", label: "Limit", value: "None", note: run.goal ? "stops when its goal is met" : "stops when nothing is left" });
  }
  out.push({
    key: "took",
    label: live ? "Running for" : "Took",
    value: durationText(run.startedAt, run.endedAt, now),
    note: `started ${clockText(run.startedAt, now)}${run.endedAt ? `, ended ${clockText(run.endedAt, now)}` : ""}`,
  });
  return out;
}

/** "3 tickets, 4 takes". */
export function ticketsCount(run: Pick<Run, "counts">): string {
  return `${tickets(run.counts.tickets)}, ${plural(run.counts.taken, "take")}`;
}

/** What the Tickets block says when the run took none. */
export function noTicketsText(entry: Pick<RunEntry, "run">): string {
  if (isLiveRun(entry.run)) return "It has taken no tickets yet.";
  return entry.run.goal ? "It took no tickets. The goal was checked against work already done." : "It took no tickets.";
}

/** Is this take a second go at a ticket an earlier take already had? */
export function isRetry(all: readonly Pick<RunTicket, "issueId">[], index: number): boolean {
  const ticket = all[index];
  return ticket !== undefined && all.slice(0, index).some((earlier) => earlier.issueId === ticket.issueId);
}

const OUTCOME_WORD = { done: "Done", failed: "Failed", open: "In progress" } as const;

export function outcomeKey(ticket: Pick<RunTicket, "outcome">): keyof typeof OUTCOME_WORD {
  return ticket.outcome ?? "open";
}

/** "Done", "Failed", "In progress": the outcome is always a word, never colour alone. */
export function outcomeWord(ticket: Pick<RunTicket, "outcome">): string {
  return OUTCOME_WORD[outcomeKey(ticket)];
}

/** A phrase as a sentence: a capital first letter and a full stop. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
}

/** The time of day a ticket was taken: "12:03" (the full clock goes in its title). */
export function timeOfDay(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The rows Up next lists: the ready ones not held, in pickup order, and how many wait on others. */
export function upNextRows(facts: Pick<RunFacts, "workable" | "waiting">): { ready: RunFacts["workable"]; waiting: number } {
  return { ready: facts.workable.filter((row) => !row.held), waiting: facts.waiting.length };
}

/** How many Up next shows before "n more ready". */
export const UP_NEXT_SHOWN = 5;

/** "2 instruction documents changed since its last take: rules, stacking"; null when none did. */
export function instructionsLine(entry: Pick<RunEntry, "instructionsChanged">): string | null {
  const changed = entry.instructionsChanged ?? [];
  if (changed.length === 0) return null;
  const keys = [...new Set(changed.map((change) => change.key))];
  return `${plural(changed.length, "instruction document")} changed since its last take: ${keys.join(", ")}`;
}

/** The run with this id. The address carries the whole id (`session.openRun`), so nothing shorter names a run. */
export function findRun(entries: readonly RunEntry[], runId: string): RunEntry | null {
  return entries.find((entry) => entry.run.id === runId) ?? null;
}

/**
 * The run the page shows: the selected one; with none selected on a wide page, the newest
 * live run, else the newest run. Never on a narrow page, where no selection means the list.
 * Showing a default selects nothing: the address stays as it is.
 */
export function shownRun(entries: readonly RunEntry[], selectedRunId: string | null, wide: boolean): RunEntry | null {
  if (selectedRunId !== null) return findRun(entries, selectedRunId);
  if (!wide) return null;
  return entries.find((entry) => isLiveRun(entry.run)) ?? entries[0] ?? null;
}
