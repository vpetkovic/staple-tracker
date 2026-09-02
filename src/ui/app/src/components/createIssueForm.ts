/**
 * The create dialog's state -> one `{ type: "create" }` ActionPayload. Owned by U5,
 * widened by R7 (STA-103).
 *
 * Split out of the dialog because this is the only part of creating a task that can be
 * wrong in a way nobody sees. Two rules run through all of it:
 *
 *  1. ABSENT is not EMPTY. `store.createIssue` reads `undefined` as "use the default"
 *     and a value as "use this", so an untouched field has to disappear from the payload
 *     rather than arrive as `""` or `[]`. A description of `""` would overwrite nothing
 *     today and would be a lie tomorrow.
 *  2. This module validates NOTHING. A blank title is sent blank, so `createIssue`
 *     throws its own "Title is required" and the dialog renders that sentence. Every
 *     rule about what a task may be lives in the store; a copy here is a second rule
 *     that can drift from the first.
 *
 * R7 changed the SHAPE and not the CONTRACT. `labels` and `blockedBy` are lists now that
 * they come from a dropdown rather than a text box, and `blocking` joined them — but
 * what reaches `store.createIssue` is what it always was, plus one key.
 *
 * Pure and DOM-free on purpose — it is unit-tested next door without React.
 */
import type { SelectOption } from "./ui/searchable-select";
import type { ActionPayload, IssuePriority, IssueRow } from "../lib/types";

/** Exactly what the dialog holds in state. */
export interface CreateFormState {
  title: string;
  description: string;
  priority: IssuePriority;
  /** A single ref, or "". Single-select, because a task has one parent. */
  parent: string;
  labels: string[];
  /** Refs that must finish before this task can start. */
  blockedBy: string[];
  /**
   * Refs this task will block — the INVERSE relation, new in R7.
   *
   * Nothing in the store takes this as create input. See the `create` branch of
   * src/ui/server.ts: it is applied after the insert by rewriting each target's
   * blocked-by set, because `setBlockedBy` replaces rather than appends. That
   * read-modify-write lives on the server so it cannot straddle a round trip.
   */
  blocking: string[];
}

/** Medium is the store's own create-time default, so an untouched form agrees with it. */
export const EMPTY_CREATE_FORM: CreateFormState = {
  title: "",
  description: "",
  priority: "medium",
  parent: "",
  labels: [],
  blockedBy: [],
  blocking: [],
};

/** Trim, drop blanks, de-duplicate — keeping the order they were first chosen in. */
function tidy(parts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const value = part.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Commas only. "needs review, ui" is two labels, not three — splitting on whitespace
 * as well would quietly shred every multi-word label an agent already wrote.
 *
 * Since R7 this is the CREATE path rather than the typing path: it splits what was
 * typed into the label search box when the "create «x»" offer is taken, so one enter
 * on "api, infra" makes two labels.
 */
export function splitLabels(raw: string): string[] {
  return tidy(raw.split(","));
}

/**
 * Commas and/or whitespace, because "STA-1 STA-2" and "STA-1, STA-2" are both what a
 * person types. Case is left alone: resolving a ref is the store's job, and lowercasing
 * here would decide something this form has no business deciding.
 *
 * Since R7 this is the PASTE path: dropping a list of refs into a relation search box
 * adds all of them rather than searching for one long string that matches nothing.
 */
export function splitRefs(raw: string): string[] {
  return tidy(raw.split(/[\s,]+/));
}

/** The payload the dialog POSTs. Empty optional fields are omitted, not emptied. */
export function buildCreatePayload(state: CreateFormState): Extract<ActionPayload, { type: "create" }> {
  const payload: Extract<ActionPayload, { type: "create" }> = {
    type: "create",
    // Trimmed but never rejected — see rule 2 above.
    title: state.title.trim(),
    priority: state.priority,
  };

  const description = state.description.trim();
  if (description) payload.description = description;

  const parent = state.parent.trim();
  if (parent) payload.parent = parent;

  // Still tidied even though these arrive from a dropdown: a chip can be added,
  // removed and re-added against a stale option list, and the dialog should not be
  // the reason the store sees the same ref twice.
  const labels = tidy(state.labels);
  if (labels.length > 0) payload.labels = labels;

  const blockedBy = tidy(state.blockedBy);
  if (blockedBy.length > 0) payload.blockedBy = blockedBy;

  const blocking = tidy(state.blocking);
  if (blocking.length > 0) payload.blocking = blocking;

  return payload;
}

// ------------------------------------------------------------------ options

/**
 * The options for parent / blocked-by / blocking — RESTRICTED TO ONE WORKSPACE, and
 * that restriction is the finding rather than a shortcut.
 *
 * `relations` is a per-workspace SQLite table keyed on local `issues.id` values, and
 * every ref the store is handed goes through `Store.requireRow`, which refuses with
 * `No issue matches "<ref>" in workspace <slug>`. A workspace database has no way to
 * name a row in another one, so a cross-workspace parent or blocker is not something
 * the store can hold. Cross-workspace blocking does exist — but as a separate concept
 * in the hub registry (`Hub.addCrossLink`, identifier to identifier, surfaced read-only
 * on /api/issue as `crossBlockers`), with no HTTP write route and no create-time input.
 *
 * So the list offers what can actually be stored. Offering the rest and letting the
 * store refuse would be a dropdown whose options are a guess.
 *
 * The pill rides every option anyway. The workspace is selectable in the same dialog,
 * which makes "which project is this ref in" a live question even when every answer on
 * screen is the same — and a pill that appears only on the exceptional row is a pill
 * nobody learns to read.
 */
export function issueOptions(rows: readonly IssueRow[], workspace: string): SelectOption[] {
  if (!workspace) return [];
  return rows
    .filter((row) => row.workspace === workspace)
    .map((row) => ({
      value: row.issue.identifier,
      label: row.issue.identifier,
      hint: row.issue.title,
      pill: row.workspace,
    }));
}

/**
 * The same options minus a set already spoken for — how Blocked by and Blocking stay
 * out of each other's way.
 *
 * This is NOT a copy of a store rule, which is the bar this file's header sets. The
 * store owns cycle detection (`assertNoCycle`, BFS over the whole blocks graph) and
 * still refuses anything this misses. What this removes is the ONE contradiction the
 * form can see in itself: naming the same task as both a blocker and a blockee is a
 * two-node cycle by construction, and the store can only say so AFTER the task has been
 * created — at which point the refusal arrives attached to a task that now exists.
 *
 * A control that cannot express the contradiction is better than a refusal that arrives
 * too late to undo. Found by evidence, not by reading: the shot list picked the first
 * option in each list, they collided, and the create came back 409 with the task
 * already written.
 */
export function withoutValues(
  options: readonly SelectOption[],
  taken: readonly string[],
): SelectOption[] {
  if (taken.length === 0) return [...options];
  const excluded = new Set(taken);
  return options.filter((option) => !excluded.has(option.value));
}

/**
 * Every distinct label in scope, commonest first.
 *
 * Gathered across ALL rows, not just the target workspace — and the asymmetry with
 * `issueOptions` is the point. A label is a plain string on the issue row: no join, no
 * foreign key, nothing to resolve. Reusing a name another project already uses is free
 * and is usually what you want, which is exactly what is NOT true of a ref.
 *
 * Ordered by count then alphabetically. The tiebreak is not cosmetic: without it the
 * list would reshuffle on every 1.5s poll that changed a count, under a cursor.
 */
export function labelOptions(rows: readonly IssueRow[]): SelectOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const label of row.issue.labels) {
      const value = label.trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: value, count }));
}
