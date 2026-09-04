/**
 * What a settings FORM decides that needs no DOM — R6c (STA-178).
 *
 * The primitives in this directory (Field, Section, ActionBar, ReorderList, the guard
 * and the conflict banner) are chrome; every decision they make is a function here, so
 * the suite can pin it by calling it. Same discipline as settings-ops.ts, which owns
 * what an EDIT means; this file owns what a DRAFT means — whether it is dirty, which
 * row or field a refusal belongs to, whether the world moved under it, and where focus
 * goes after a keyboard reorder.
 *
 * ── THE REVISION IS A SIGNATURE ───────────────────────────────────────────────────────
 *
 * `/api/settings` bumps `meta.settings_revision` on every vocabulary write but does not
 * (yet) serve the number. The 1.5s fingerprint poll does republish the whole envelope,
 * so the page always holds the CURRENT served vocabulary — what it needs is to notice
 * that the copy a draft was started from is no longer that. `snapshotSignature` is the
 * served rows of one target, serialized; a draft remembers the signature it began on,
 * and a different one while the draft is dirty is an external revision. When the server
 * starts serving `revision` this is the one function to fold it into.
 *
 * ── A REFUSAL BELONGS TO SOMETHING ────────────────────────────────────────────────────
 *
 * The store refuses a batch with ONE sentence and no op index. That sentence names what
 * it refused — `Status "pairing" already exists…`, `Unknown kinds: research`,
 * `workspace "x": "queue.policy" must be…` — so the responsible row or field is found by
 * looking for each candidate's id, label or key in the message, longest term first so
 * `in_review` beats `in`. No match means the section owns it, which is where the message
 * rendered before this ticket; nothing is ever paraphrased.
 */
import type { SettingSchemaView } from "../../lib/settings";

// ---------------------------------------------------------------- save state

/** Where an async save is: nothing in flight, in flight, or refused (with the message rendered elsewhere). */
export type SaveStatus = "idle" | "pending" | "failed";

/** What the action bar can do, from what the draft is. */
export interface ActionBarState {
  canSave: boolean;
  /** Cancel discards the draft; it is offered exactly when there is one. */
  canCancel: boolean;
  /** Reset puts the form back to its DEFAULTS; offered when the form has some and is not at them. */
  canReset: boolean;
  saving: boolean;
}

/**
 * `blocked` is a client-side reason not to save — an inline validation error or an
 * unresolved conflict. A dirty draft that is blocked keeps Cancel, because the way
 * out of a bad value is to discard it. `resettable` is the form's own answer to
 * "is anything away from its default"; a vocabulary has no defaults and never is.
 */
export function actionBarState(input: {
  dirty: boolean;
  status: SaveStatus;
  blocked?: boolean;
  resettable?: boolean;
}): ActionBarState {
  const saving = input.status === "pending";
  return {
    canSave: input.dirty && !saving && !input.blocked,
    canCancel: input.dirty && !saving,
    canReset: (input.resettable ?? false) && !saving,
    saving,
  };
}

// ---------------------------------------------------------------- the unsaved-changes guard

/** Leaving a dirty form is a choice; leaving a clean one is not. */
export function leaveDecision(dirty: boolean): "proceed" | "confirm" {
  return dirty ? "confirm" : "proceed";
}

// ---------------------------------------------------------------- external revisions

/**
 * The served state of one form, as a string a draft can remember. Only what the form
 * EDITS is in it: a usage count moving because an issue changed status is not a
 * revision of the vocabulary, and a conflict banner over that would teach people to
 * click through conflict banners.
 */
export function snapshotSignature(rows: readonly unknown[]): string {
  return JSON.stringify(rows);
}

/** An external revision matters only while there is something of ours to lose. */
export function hasConflict(input: { dirty: boolean; baseline: string; served: string }): boolean {
  return input.dirty && input.baseline !== input.served;
}

// ---------------------------------------------------------------- refusal attribution

/** Something a refusal could be about: a row (id + label) or a field (key + label). */
export interface RefusalTarget {
  id: string;
  /** The words the store might use for it. Empty terms are ignored. */
  terms: readonly string[];
}

/**
 * The id of the target the store's sentence names, or null when it names none.
 * Longest term wins so a label that contains another id cannot steal a refusal.
 */
export function attributeRefusal(message: string, targets: readonly RefusalTarget[]): string | null {
  const lower = message.toLowerCase();
  let best: { id: string; length: number } | null = null;
  for (const target of targets) {
    for (const term of target.terms) {
      const needle = term.trim().toLowerCase();
      if (needle === "" || !lower.includes(needle)) continue;
      if (!best || needle.length > best.length) best = { id: target.id, length: needle.length };
    }
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------- keyboard reorder focus

export type ReorderControl = "up" | "down";

/**
 * Where focus lands after "Move X up/down" moved the row. The natural answer is the
 * same button on the same row — but a row that just reached the top has a disabled
 * "up", and focus on a disabled button is focus lost to the body. So it lands on the
 * other button of that row, which is the one you would press next anyway.
 */
export function reorderFocusTarget(input: {
  id: string;
  index: number;
  count: number;
  control: ReorderControl;
}): { id: string; control: ReorderControl } {
  const { id, index, count, control } = input;
  if (control === "up" && index === 0) return { id, control: "down" };
  if (control === "down" && index === count - 1) return { id, control: "up" };
  return { id, control };
}

// ---------------------------------------------------------------- field values

/**
 * The client-side half of `validateSettingValue`: the checks a form can make before
 * the round trip, in the store's own words where the store has them (`patternHint`).
 * Null means nothing to say. The store still refuses on its own terms; this only stops
 * a form from submitting into a refusal it could see coming.
 */
export function validateFieldValue(schema: SettingSchemaView, value: unknown): string | null {
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "Must be on or off.";
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) return "Must be a whole number.";
      if (schema.min !== undefined && value < schema.min) return `Must be at least ${schema.min}.`;
      if (schema.max !== undefined && value > schema.max) return `Must be at most ${schema.max}.`;
      return null;
    }
    case "string": {
      if (typeof value !== "string") return "Must be text.";
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return schema.patternHint ?? "Not in the expected form.";
      return null;
    }
    case "enum":
      return typeof value === "string" && schema.values.includes(value)
        ? null
        : `Must be one of ${schema.values.join(", ")}.`;
  }
}

/**
 * What a control's raw input means as a value. Numbers are parsed here so the draft
 * holds the typed value the store expects and `validateFieldValue` can judge it;
 * an unparsable number stays a string, which the integer check then refuses in words.
 */
export function parseFieldInput(schema: SettingSchemaView, raw: string): unknown {
  if (schema.type !== "integer") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : raw;
}

/** `true` when the two values are the same setting value — `===` plus a stringified fallback for objects. */
export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
