/**
 * An idea's permanent number: `I-<PREFIX>-<n>` (design/plan.md, "Idea numbers").
 *
 * An idea holds its number as its identifier, so everything the tracker does for a ticket
 * number it does for this one: the identifier's `UNIQUE` index, the stand-in sync gives the
 * later of two claims (`I-STA-5+12`), the settlement by the device that made it, the conflict
 * record and its resolution, and the aliases `identifier-moves.ts` keeps when a number moves.
 * Only the counter is its own: `meta.next_idea_number`, beside `next_issue_number` and like it a
 * local provisional allocator that never synchronizes; the applier keeps it clear of every idea
 * number that lands on this device, as it does the ticket counter.
 *
 * Promotion (and Scaffold, which promotes) moves the identifier to the ticket number and keeps
 * the idea number on the row, in `plan_idea_number` (migration 026), written in the same
 * journaled update. An alias is device-local (`meta`), so the column is what a device that
 * receives the promotion by sync, or hydrates long after it, reads the number from.
 *
 * Never reused: the allocator only moves forward, and passes every number a row here holds
 * as its identifier or as its kept number.
 */
import type { DatabaseSync } from "node:sqlite";

/** What every idea number starts with. A ticket identifier never does: its prefix is letters, then a dash. */
export const IDEA_NUMBER_LEAD = "I-";

const IDEA_NUMBER_RE = /^I-([A-Z]+)-(\d+)$/;
/** An idea number, or one sync gave a stand-in suffix (`I-STA-5+12`). */
const IDEA_NUMBER_OR_STAND_IN_RE = /^I-([A-Z]+)-(\d+)(\+\d+)?$/;
/** `I-5`: the number in this workspace, as `5` is the ticket `STA-5`. */
const SHORT_IDEA_NUMBER_RE = /^I-(\d+)$/;

export function formatIdeaNumber(prefix: string, number: number): string {
  return `${IDEA_NUMBER_LEAD}${prefix}-${number}`;
}

export function parseIdeaNumber(value: string): { prefix: string; number: number } | null {
  const match = IDEA_NUMBER_RE.exec(value.trim().toUpperCase());
  return match ? { prefix: match[1]!, number: Number(match[2]!) } : null;
}

/** Whether an identifier is an idea's number, a stand-in for one included. */
export function isIdeaNumber(value: string | null | undefined): boolean {
  return typeof value === "string" && IDEA_NUMBER_OR_STAND_IN_RE.test(value);
}

/**
 * The idea number a reference spells, in its canonical form, or null: `I-STA-5`, any case,
 * a stand-in included, and the short `I-5` in the workspace whose prefix is given.
 */
export function canonicalIdeaRef(ref: string, prefix: string): string | null {
  const upper = ref.trim().toUpperCase();
  const full = IDEA_NUMBER_OR_STAND_IN_RE.exec(upper);
  if (full) return `${IDEA_NUMBER_LEAD}${full[1]}-${Number(full[2])}${full[3] ?? ""}`;
  const short = SHORT_IDEA_NUMBER_RE.exec(upper);
  return short ? formatIdeaNumber(prefix, Number(short[1])) : null;
}

const COUNTER = "next_idea_number";

/**
 * The next idea number to hand out here, consumed. Forward only, and past every number a row
 * here holds, as identifier or as kept number: a database that predates the counter, or one
 * whose rows arrived some way the applier did not see, never hands a held number out twice.
 */
export function nextIdeaNumber(db: DatabaseSync, prefix: string): string {
  const stored = Number((db.prepare("SELECT value FROM meta WHERE key = ?").get(COUNTER) as { value: string } | undefined)?.value ?? "1");
  let next = Number.isInteger(stored) && stored > 0 ? stored : 1;
  const held = highestHeld(db, prefix);
  if (held >= next) next = held + 1;
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(COUNTER, String(next + 1));
  return formatIdeaNumber(prefix, next);
}

/** The highest idea number of this prefix a row here holds, or 0. */
function highestHeld(db: DatabaseSync, prefix: string): number {
  const lead = `${IDEA_NUMBER_LEAD}${prefix}-`;
  const rows = db
    .prepare("SELECT identifier AS value FROM issues WHERE substr(identifier, 1, ?) = ? UNION ALL SELECT plan_idea_number AS value FROM issues WHERE plan_idea_number IS NOT NULL")
    .all(lead.length, lead) as Array<{ value: string }>;
  let highest = 0;
  for (const row of rows) {
    const parsed = parseIdeaNumber(row.value);
    if (parsed && parsed.prefix === prefix && parsed.number > highest) highest = parsed.number;
  }
  return highest;
}

/**
 * Keep the idea counter ahead of an idea number that has just landed on this device, as
 * `advanceIssueNumber` (`cloud/apply.ts`) keeps the ticket counter: the counter never
 * synchronizes, so without this a device that received `I-STA-7` would hand it out again.
 * A stand-in has no number of its own to pass; another workspace's prefix is not this counter's.
 */
export function advanceIdeaNumber(db: DatabaseSync, value: unknown): void {
  if (typeof value !== "string") return;
  const parsed = parseIdeaNumber(value);
  if (!parsed) return;
  const prefix = db.prepare("SELECT value FROM meta WHERE key = 'prefix'").get() as { value: string } | undefined;
  if (prefix && prefix.value !== parsed.prefix) return;
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = CASE WHEN CAST(meta.value AS INTEGER) > CAST(excluded.value AS INTEGER)
                    THEN meta.value ELSE excluded.value END`,
  ).run(COUNTER, String(parsed.number + 1));
}

/** The meta key of the counter, for the few places that reason about it by name. */
export const IDEA_COUNTER_KEY = COUNTER;
