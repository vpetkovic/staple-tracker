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
 * browser first kept it (`since`, on the server's clock): a stop recorded before that is
 * history, not news, so opening the page for the first time does not greet the reader with
 * every run ever stopped. Keys of runs the server no longer serves are pruned. The app has no service worker, so there is no system notification; the notice
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
  /** "Autopilot · ABC-332": the compact card's title, where the reason says how it ended. */
  short: string;
  /** Why, in the run history's words (`endedStateText`). */
  reason: string;
  /** What the person who stopped it said (`run stop -m`), or null. */
  note: string | null;
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
    short: `Autopilot · ${scope}`,
    reason: state.text,
    note: run.stop.note?.trim() ? run.stop.note.trim() : null,
    tone: state.tone,
    attention: stopAttention(run),
    endedAt: run.endedAt ?? run.stop.at,
  };
}

/**
 * Whether the notice's reference is the issue already open (in the same workspace): its link
 * would open what the reader is looking at, so it is not offered.
 */
export function attentionIsOpen(notice: Pick<StopNotice, "workspace" | "attention">, open: { workspace: string; ref: string } | null): boolean {
  return notice.attention !== null && open !== null && open.workspace === notice.workspace && open.ref.toUpperCase() === notice.attention.ref.toUpperCase();
}

/**
 * The notices to show: every ended run this browser has not seen and that ended at or after
 * `since`, newest first. Deterministic in its inputs, so reading the same runs twice (the
 * next poll) answers the same list.
 */
export function pendingStopNotices(entries: readonly Pick<RunEntry, "workspace" | "run">[], seen: StopSeen): StopNotice[] {
  if (seen.since === null) return [];
  const since = Date.parse(seen.since);
  const known = new Set(seen.seen);
  return entries
    .map(stopNotice)
    .filter((notice): notice is StopNotice => notice !== null && !known.has(notice.key) && !(Date.parse(notice.endedAt) < since))
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
}

// ---------- what this browser has seen ----------

export const STOP_SEEN_KEY = "staple:run-stops:v1";

export interface StopSeen {
  /**
   * When this browser started keeping notices, on the SERVER's clock (`/api/runs` `now`, the
   * clock that writes `endedAt`): a stop before it is not news. Null until the first read.
   */
  since: string | null;
  /** `stopKey`s dismissed, opened, or stopped from this page, oldest first. */
  seen: string[];
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Read what was seen; nothing stored (or a corrupt value) reads as a first visit, `since` unknown. */
export function loadStopSeen(storage: Storage | null): StopSeen {
  try {
    const raw = storage?.getItem(STOP_SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<StopSeen>) : null;
    if (parsed && typeof parsed.since === "string" && !Number.isNaN(Date.parse(parsed.since)) && Array.isArray(parsed.seen)) {
      return { since: parsed.since, seen: parsed.seen.filter((key): key is string => typeof key === "string") };
    }
  } catch {
    // A corrupt value reads as a first visit and is replaced at the next save.
  }
  return { since: null, seen: [] };
}

export function saveStopSeen(storage: Storage | null, state: StopSeen): void {
  try {
    storage?.setItem(STOP_SEEN_KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full quota: the notice still goes for this page's life.
  }
}

/** The first read of the server's clock starts the count; a later one changes nothing. */
export function withBaseline(state: StopSeen, serverNow: string | null): StopSeen {
  return state.since === null && serverNow !== null ? { ...state, since: serverNow } : state;
}

/** `state` with `keys` seen, each once. */
export function withSeen(state: StopSeen, keys: readonly string[]): StopSeen {
  return { since: state.since, seen: [...state.seen.filter((key) => !keys.includes(key)), ...keys] };
}

/**
 * `state` without the keys of runs the server no longer serves. `/api/runs` serves every
 * ended run down to its limit per workspace, newest first, so a run that dropped off never
 * comes back and its key is dead. Only the workspaces this read covers are judged: a key of
 * a workspace the page is not showing now (one workspace, not All) is kept, or switching to
 * All would raise its stops again. The same object when nothing changed.
 */
export function prunedSeen(state: StopSeen, entries: readonly Pick<RunEntry, "workspace" | "run">[]): StopSeen {
  if (entries.length === 0) return state;
  const workspaces = new Set(entries.map((entry) => entry.workspace));
  const served = new Set(entries.map(stopKey));
  const seen = state.seen.filter((key) => !workspaces.has(key.slice(0, key.indexOf("/"))) || served.has(key));
  return seen.length === state.seen.length ? state : { since: state.since, seen };
}
