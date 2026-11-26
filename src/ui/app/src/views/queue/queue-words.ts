/**
 * The Queue page's words and counts: what a row's state column says, why the pinned next row
 * is the one it is, and what a container entry rolls up to. Pure functions of the rows the
 * server sent (`/api/queue`); nothing here decides order or eligibility, it only words the
 * store's answer. `queue-words.test.ts` pins them.
 */
import type { EffectiveQueueRow, IssueKind, IssueRow, QueueEntry, QueueView } from "@/lib/types";
import { blockersOf } from "./queue-model";
import { BUCKET_OF, type QueueBucket } from "./queue-summary";

export type Counts = Record<QueueBucket, number>;

export const EMPTY_COUNTS: Readonly<Counts> = { done: 0, active: 0, ready: 0, waiting: 0 };

export function countsOf(rows: readonly EffectiveQueueRow[]): Counts {
  const counts: Counts = { ...EMPTY_COUNTS };
  for (const row of rows) counts[BUCKET_OF[row.eligibility]] += 1;
  return counts;
}

/** The four buckets in the order the words read them. */
export const WORD_ORDER: readonly QueueBucket[] = ["ready", "active", "waiting", "done"];

const WIDE_WORD: Readonly<Record<QueueBucket, string>> = {
  ready: "ready",
  active: "being worked on",
  waiting: "waiting",
  done: "done",
};

const NARROW_WORD: Readonly<Record<QueueBucket, string>> = {
  ready: "ready",
  active: "working",
  waiting: "waiting",
  done: "done",
};

/** The non-zero buckets as number and word, wide or narrow: "3 ready · 4 being worked on". */
export function countParts(counts: Counts, narrow = false): Array<{ bucket: QueueBucket; count: number; word: string }> {
  const words = narrow ? NARROW_WORD : WIDE_WORD;
  return WORD_ORDER.filter((bucket) => counts[bucket] > 0).map((bucket) => ({ bucket, count: counts[bucket], word: words[bucket] }));
}

export function countSentence(counts: Counts, narrow = false): string {
  return countParts(counts, narrow)
    .map((part) => `${part.count} ${part.word}`)
    .join(" · ");
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A container entry's roll-up: "10 tasks · 2 ready · 4 being worked on". The waiting count is
 * said only when nothing is ready or active, where it is the whole story.
 */
export function rollUp(rows: readonly EffectiveQueueRow[], narrow = false): string {
  const counts = countsOf(rows);
  const parts = [plural(rows.length, "task")];
  if (counts.ready > 0) parts.push(`${counts.ready} ready`);
  if (counts.active > 0) parts.push(`${counts.active} ${narrow ? "working" : "being worked on"}`);
  if (counts.ready === 0 && counts.active === 0 && counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  return parts.join(" · ");
}

// ---------- the state column ----------

/** The mark beside the words: a filled dot, a hollow dot, or an amber diamond (a person's move). */
export type StateTone = "ready" | "active" | "waiting" | "person" | "done";

export interface RowState {
  tone: StateTone;
  /** The words, whole: what a screen reader and the title attribute say. */
  words: string;
  /** A claim: who holds it, and its initials for the tile. */
  holder?: string;
  initials?: string;
  /** A claim idle for over an hour: "quiet 8d". */
  quiet?: string;
  /** Named blockers, each a link in the column. */
  blockers?: string[];
}

/** "dux-shell" → "DS", "fable" → "F". */
export function initials(name: string): string {
  const parts = name.split(/[-_ .@]/).filter(Boolean);
  return (parts.length > 0 ? parts : [name])
    .slice(0, 2)
    .map((part) => part[0]!)
    .join("")
    .toUpperCase();
}

/** Seconds as the app's short age: 45s, 12m, 3h, 8d. */
export function shortAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const QUIET_AFTER_SECONDS = 3600;

function holderOf(row: EffectiveQueueRow): { holder: string | null; idle: number | null } {
  const detail = row.detail ?? {};
  const heldBy = row.claim?.heldBy ?? (typeof detail.heldBy === "string" ? detail.heldBy : null);
  const idle = row.claim?.idleSeconds ?? (typeof detail.idleSeconds === "number" ? detail.idleSeconds : null);
  return { holder: heldBy, idle };
}

/**
 * The store's sentence without the reference it opens with, and with a status id spoken as
 * words: "STA-9 is in_progress, which cannot be checked out." → "In progress, which cannot be
 * checked out."
 */
export function reasonWithoutRef(row: Pick<EffectiveQueueRow, "identifier" | "reason" | "status">): string {
  let text = (row.reason ?? "").trim();
  if (text.startsWith(row.identifier)) text = text.slice(row.identifier.length).trimStart();
  if (text.startsWith("is ")) text = text.slice(3);
  text = text.replace(row.status, row.status.replace(/_/g, " "));
  if (text.endsWith(".")) text = text.slice(0, -1);
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : "Cannot be taken now";
}

/** What the state column says for one task row. One vocabulary for every row on the page. */
export function rowState(row: EffectiveQueueRow): RowState {
  switch (row.eligibility) {
    case "eligible":
      return { tone: "ready", words: "Ready" };
    case "claimed": {
      const { holder, idle } = holderOf(row);
      const name = holder ?? "an agent";
      const quiet = idle !== null && idle > QUIET_AFTER_SECONDS ? `quiet ${shortAge(idle)}` : undefined;
      return {
        tone: "active",
        words: `Working · ${name}${quiet ? ` · ${quiet}` : ""}`,
        holder: name,
        initials: holder ? initials(holder) : "?",
        quiet,
      };
    }
    case "resolved":
      return { tone: "done", words: "Done" };
    case "gated":
      return { tone: "person", words: "Needs your approval" };
    case "blocked": {
      const blockers = blockersOf(row);
      return blockers.length > 0
        ? { tone: "waiting", words: `Waiting on ${blockers.join(", ")}`, blockers }
        : { tone: "person", words: "Blocked on a person" };
    }
    case "unavailable":
      return row.status === "in_review" ? { tone: "person", words: "In review" } : { tone: "waiting", words: reasonWithoutRef(row) };
    case "assigned_to_other_member":
      return { tone: "waiting", words: "Another member's" };
  }
}

// ---------- the pinned next row ----------

export interface Why {
  wide: string;
  narrow: string;
}

/**
 * Why the next pick is the one it is: first in the order, or its place and what is ahead of it
 * (`skipped`, resolved rows left out); or, for a pick from after the plan, that the plan has
 * nothing ready or there is no plan.
 */
export function whyNext(next: EffectiveQueueRow, skipped: readonly EffectiveQueueRow[], hasPlan: boolean): Why {
  if (next.unqueued) {
    const text = hasPlan
      ? "The plan has nothing ready, so agents take this from the open work"
      : "No plan, so agents take open work in list order";
    return { wide: text, narrow: text };
  }
  const ahead = skipped.filter((row) => row.eligibility !== "resolved" && !row.unqueued);
  if (ahead.length === 0) return { wide: "First in the order", narrow: "First in the order" };
  const counts = countsOf(ahead);
  const parts = [
    counts.active > 0 ? `${counts.active} being worked on` : "",
    counts.waiting > 0 ? `${counts.waiting} waiting` : "",
  ].filter(Boolean);
  const at = `#${next.position} in the order`;
  if (parts.length === 0) return { wide: at, narrow: at };
  return { wide: `${at} · ahead of it: ${parts.join(", ")}`, narrow: `${at} · ahead: ${parts.join(", ")}` };
}

/** "11 waiting · 4 being worked on. Agents asking for work get none." */
export function nothingPickable(effective: readonly EffectiveQueueRow[]): string {
  const counts = countsOf(effective.filter((row) => row.eligibility !== "resolved"));
  const parts = [
    counts.waiting > 0 ? `${counts.waiting} waiting` : "",
    counts.active > 0 ? `${counts.active} being worked on` : "",
  ].filter(Boolean);
  return `${parts.length > 0 ? `${parts.join(" · ")}. ` : ""}Agents asking for work get none.`;
}

/** Is there any open work at all, planned or not. */
export function hasOpenWork(effective: readonly EffectiveQueueRow[]): boolean {
  return effective.some((row) => row.eligibility !== "resolved");
}

// ---------- entries ----------

/**
 * An entry whose work the order already reached through an EARLIER entry: its own row, or the
 * rows inside it, came out of another entry's expansion. Null when the entry stands for itself.
 */
export function coveredBy(entry: QueueEntry, view: Pick<QueueView, "effective">): { position: number; via: string; identifier: string } | null {
  for (const row of view.effective) {
    if (row.unqueued || row.via === null || row.via === entry.identifier) continue;
    const inside = row.identifier === entry.identifier || row.epicPath.includes(entry.identifier) || row.milestonePath.includes(entry.identifier);
    if (inside) return { position: row.position, via: row.via, identifier: row.identifier };
  }
  return null;
}

export function coveredWords(covered: { position: number; via: string }): string {
  return `Already in the order at #${covered.position}, inside ${covered.via}`;
}

// ---------- what a container entry expands to ----------

export type ExpansionLine =
  | { kind: "caption"; identifier: string; title: string; issueKind: IssueKind }
  | { kind: "task"; row: EffectiveQueueRow };

/**
 * A container's rows in effective order, each preceded by a caption for every epic between the
 * entry and it that the row above did not already name. Effective order is kept, so the `#n`
 * column only ever counts up: a later row under an earlier epic repeats that epic's caption
 * rather than being pulled up beside its siblings.
 */
export function expansionLines(
  rows: readonly EffectiveQueueRow[],
  root: string,
  known: ReadonlyMap<string, IssueRow>,
): ExpansionLine[] {
  const lines: ExpansionLine[] = [];
  let previous: string[] = [];
  for (const row of rows) {
    const chain = chainBelow(row, root);
    let same = 0;
    while (same < chain.length && same < previous.length && chain[same] === previous[same]) same += 1;
    for (const identifier of chain.slice(same)) {
      const issue = known.get(identifier)?.issue;
      lines.push({ kind: "caption", identifier, title: issue?.title ?? "", issueKind: issue?.kind ?? "epic" });
    }
    previous = chain;
    lines.push({ kind: "task", row });
  }
  return lines;
}

/**
 * The containers between a root entry and a row, outermost first, as the wire names them. A
 * root the chain does not name (a queued task with open children) has nothing between it and
 * its rows: what the chain names then sits above the root, not below it.
 */
function chainBelow(row: EffectiveQueueRow, root: string): string[] {
  const chain = [...row.milestonePath, ...row.epicPath];
  const at = chain.lastIndexOf(root);
  return at === -1 ? [] : chain.slice(at + 1);
}

// ---------- paging ----------

export const EXPANSION_PAGE = 5;
export const BAND_PAGE = 10;

/** The rows a paged list shows: the first `page`, or every row once shown whole. */
export function paged<T>(rows: readonly T[], page: number, whole: boolean): T[] {
  return whole ? [...rows] : rows.slice(0, page);
}

/** "103 more in EXE-234" for a container, "51 more" for the band. */
export function moreWords(total: number, page: number, inside?: string): string {
  const more = Math.max(0, total - page);
  return inside ? `${more} more in ${inside}` : `${more} more`;
}

// ---------- the band ----------

export function bandWords(count: number, hasPlan: boolean): { title: string; count: string; rest: string } {
  return {
    title: hasPlan ? "After the plan" : "Open work",
    count: plural(count, "open task"),
    rest: `agents take ${count === 1 ? "it" : "these"} in list order${hasPlan ? " once the plan runs out" : ""}`,
  };
}

// ---------- the move announcement ----------

export function moveAnnouncement(identifier: string, index: number, total: number): string {
  return `${identifier} is now ${index + 1} of ${total}`;
}
