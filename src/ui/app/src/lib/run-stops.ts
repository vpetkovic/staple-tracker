/**
 * "Autopilot stopped": one notice per run that ended, naming why in plain words and the
 * reference that needs a person (the milestone awaiting approval, the ticket that failed,
 * the one blocked on somebody).
 *
 * It rides the page's one `/api/runs` read (lib/runs.ts) and nothing else: a run that ends
 * writes an event, the fingerprint moves, and the notice is on every open page within one
 * refresh. A notice is DERIVED, never pushed: the ended runs, minus the ones this browser
 * has seen. So a poll that reads the same stop again adds nothing, and a reload shows the
 * same notices until they are dismissed.
 *
 * "Seen" is kept per run in localStorage (`staple:run-stops:v1`), with the moment this
 * browser first kept it (`since`): a stop recorded before that is history, not news, so
 * opening the page for the first time does not greet the reader with every run ever
 * stopped. The app has no service worker, so there is no system notification; the notice
 * is in the page.
 *
 * Pure and tested (run-stops.test.ts).
 */
import { endedStateText, isLiveRun, type RunTone } from "./run-text";
import type { Run, RunEntry } from "./types";

/** What the reader does with the reference: approve it, unblock it, or look at it. */
export type StopAction = "review" | "unblock" | "open";

export interface StopAttention {
  ref: string;
  action: StopAction;
}

const refIn = (value: unknown, key = "identifier"): string | null => {
  const first = Array.isArray(value) ? value[0] : undefined;
  const ref = typeof first === "string" ? first : (first as Record<string, unknown> | undefined)?.[key];
  return typeof ref === "string" && ref ? ref : null;
};

/**
 * The reference an ended run hands to a person, by reason: a goal met or a goal short of its
 * cap names the milestone (it waits for approval); a gate the gated issue; a person's block
 * the blocked ticket; two failures the last one that failed; a main-line stop the ticket
 * whose session moved it. Anything else names the scope, when it still has one.
 */
export function stopAttention(run: Pick<Run, "scope" | "stop">): StopAttention | null {
  const stop = run.stop;
  if (stop === null) return null;
  const detail = stop.detail ?? {};
  const scope = run.scope.kind === "queue" ? null : run.scope.identifier;
  const milestone = typeof detail.milestone === "string" && detail.milestone ? detail.milestone : scope;
  const at = (ref: string | null, action: StopAction): StopAttention | null => (ref ? { ref, action } : null);
  switch (stop.reason) {
    case "goal_met":
      return at(milestone, "review");
    case "budget":
      return detail.budget === "goal_children" ? at(milestone, "review") : at(scope, "open");
    case "gate_pending":
      return at(refIn(detail.gates) ?? scope, "review");
    case "vp_blocked":
      return at(refIn(detail.blocks) ?? scope, "unblock");
    case "failure_streak": {
      const tickets = Array.isArray(detail.tickets) ? detail.tickets : [];
      return at(refIn(tickets.slice(-1)) ?? scope, "open");
    }
    case "touched_main_line":
      return at(typeof detail.ticket === "string" ? detail.ticket : scope, "open");
    default:
      return at(scope, "open");
  }
}

/** The link's words: "Review ABC-332", "Unblock ABC-340", "Open ABC-341". */
export function attentionLabel(attention: StopAttention): string {
  const verb = attention.action === "review" ? "Review" : attention.action === "unblock" ? "Unblock" : "Open";
  return `${verb} ${attention.ref}`;
}

export interface StopNotice {
  /** `<workspace>/<run id>`: what "seen" is kept by. */
  key: string;
  workspace: string;
  runId: string;
  /** "Autopilot finished · ABC-332" or "Autopilot stopped · the queue". */
  title: string;
  /** Why, in the run history's words (`endedStateText`). */
  reason: string;
  tone: RunTone;
  attention: StopAttention | null;
  endedAt: string;
}

export function stopKey(entry: Pick<RunEntry, "workspace" | "run">): string {
  return `${entry.workspace}/${entry.run.id}`;
}

export function stopNotice(entry: Pick<RunEntry, "workspace" | "run">): StopNotice | null {
  const { run } = entry;
  if (isLiveRun(run) || run.stop === null) return null;
  const scope = run.scope.kind === "queue" ? "the queue" : (run.scope.identifier ?? "a deleted issue");
  const state = endedStateText(run);
  return {
    key: stopKey(entry),
    workspace: entry.workspace,
    runId: run.id,
    title: `Autopilot ${run.state === "completed" ? "finished" : "stopped"} · ${scope}`,
    reason: state.text,
    tone: state.tone,
    attention: stopAttention(run),
    endedAt: run.endedAt ?? run.stop.at,
  };
}

/**
 * The notices to show: every ended run this browser has not seen and that ended at or after
 * `since`, newest first. Deterministic in its inputs, so reading the same runs twice (the
 * next poll) answers the same list.
 */
export function pendingStopNotices(entries: readonly Pick<RunEntry, "workspace" | "run">[], seen: StopSeen): StopNotice[] {
  const since = Date.parse(seen.since);
  const known = new Set(seen.seen);
  return entries
    .map(stopNotice)
    .filter((notice): notice is StopNotice => notice !== null && !known.has(notice.key) && !(Date.parse(notice.endedAt) < since))
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
}

// ---------- what this browser has seen ----------

export const STOP_SEEN_KEY = "staple:run-stops:v1";

/** Enough for months of runs; the oldest keys drop first, and they are long past `since` by then. */
export const STOP_SEEN_CAP = 500;

export interface StopSeen {
  /** When this browser started keeping notices; a stop before it is not news. */
  since: string;
  /** `stopKey`s dismissed or opened, oldest first. */
  seen: string[];
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Read what was seen; on the first read ever, start keeping from `now` and save that. */
export function loadStopSeen(storage: Storage | null, now: Date = new Date()): StopSeen {
  const fresh: StopSeen = { since: now.toISOString(), seen: [] };
  if (storage === null) return fresh;
  try {
    const raw = storage.getItem(STOP_SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<StopSeen>) : null;
    if (parsed && typeof parsed.since === "string" && !Number.isNaN(Date.parse(parsed.since)) && Array.isArray(parsed.seen)) {
      return { since: parsed.since, seen: parsed.seen.filter((key): key is string => typeof key === "string") };
    }
  } catch {
    // A corrupt value is replaced below, as a first read.
  }
  saveStopSeen(storage, fresh);
  return fresh;
}

export function saveStopSeen(storage: Storage | null, state: StopSeen): void {
  try {
    storage?.setItem(STOP_SEEN_KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full quota: the notice still goes for this page's life.
  }
}

/** `state` with `keys` seen, capped, oldest dropped first. */
export function withSeen(state: StopSeen, keys: readonly string[]): StopSeen {
  const seen = [...state.seen.filter((key) => !keys.includes(key)), ...keys];
  return { since: state.since, seen: seen.slice(-STOP_SEEN_CAP) };
}
