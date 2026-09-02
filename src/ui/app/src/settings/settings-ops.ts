/**
 * What an edit in the settings dialog MEANS, as pure functions — O7b (STA-141).
 *
 * Same discipline as components/command-palette/commands.ts, and for the same reason: the
 * parts of a vocabulary editor most likely to be subtly wrong are the list arithmetic
 * (does a move to index 0 keep the list a permutation?) and the guard arithmetic (does the
 * migrate-to picker exclude the row being removed?). Neither needs React, a DOM, or a
 * fetch to be checked, so neither lives in a component.
 *
 * Imports are relative rather than "@/…" so the tests run under the repo-root vitest
 * config with or without the app's alias.
 *
 * NOTHING HERE VALIDATES ON THE STORE'S BEHALF. `validateVocabularyId` answers the one
 * question the dialog can answer before a round trip — is this even a legal id shape —
 * and every other refusal (a duplicate id, the last member of a required category, a
 * removal that still has rows) belongs to the store and arrives as the store's own
 * sentence. A second copy of those rules here is a second chance to paraphrase one.
 */
import { VOCABULARY_ID_PATTERN } from "../lib/types";
import type { StatusCategory, VocabularyOp, WorkspaceKind, WorkspaceStatus } from "../lib/types";

/** Either list's row, reduced to what the editor manipulates. */
export interface VocabularyRow {
  id: string;
  label: string;
  isBuiltin: boolean;
  /** Statuses only. Absent on a kind, which has no behaviour to inherit. */
  category?: StatusCategory;
}

export function statusRows(statuses: readonly WorkspaceStatus[]): VocabularyRow[] {
  return statuses.map((s) => ({ id: s.id, label: s.label, isBuiltin: s.isBuiltin, category: s.category }));
}

export function kindRows(kinds: readonly WorkspaceKind[]): VocabularyRow[] {
  return kinds.map((k) => ({ id: k.id, label: k.label, isBuiltin: k.isBuiltin }));
}

/**
 * Move one element to a new index, returning a NEW array that is a permutation of the old.
 *
 * `to` is clamped rather than rejected, because both callers can legitimately overshoot:
 * the keyboard buttons ask for `index - 1` at the top of the list, and a drag can end over
 * the last row's lower half. Clamping makes "move up at the top" a no-op instead of an
 * error the user has to understand.
 *
 * The splice order matters and is the classic off-by-one in this function: the element is
 * REMOVED first, so `to` indexes into the shortened array. Moving item 0 to index 2 in
 * [a,b,c] gives [b,c,a] — the element lands after two others, which is what "move down
 * twice" means to anyone dragging it.
 */
export function moveIndex<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** `moveIndex` by id, for the drag handlers, which speak in ids and not in indices. */
export function moveId<T extends { id: string }>(list: readonly T[], id: string, overId: string): T[] {
  const from = list.findIndex((row) => row.id === id);
  const to = list.findIndex((row) => row.id === overId);
  if (from === -1 || to === -1 || from === to) return [...list];
  return moveIndex(list, from, to);
}

/**
 * The single op a reorder produces: EVERY id, in the order you want.
 *
 * The store's `reorderStatuses` takes the whole list rather than a delta, and that is
 * worth preserving up here: a partial reorder has to be interpreted against a list the
 * client last saw, and the client's copy can be stale by exactly one MCP call.
 */
export function reorderOp(rows: readonly { id: string }[]): VocabularyOp {
  return { op: "reorder", ids: rows.map((row) => row.id) };
}

export function renameOp(id: string, label: string): VocabularyOp {
  return { op: "rename", id, label: label.trim() };
}

export function recategorizeOp(id: string, category: StatusCategory): VocabularyOp {
  return { op: "recategorize", id, category };
}

/**
 * `add`, placed after a row or appended.
 *
 * `label` is omitted when the user left the field empty, so the STORE derives it
 * (`awaiting_approval` -> `Awaiting Approval`) rather than this file sending a label it
 * title-cased itself. One derivation, in one place — the dialog only PREVIEWS it.
 */
export function addOp(input: {
  id: string;
  label?: string;
  category?: StatusCategory;
  after?: string | null;
}): VocabularyOp {
  const label = input.label?.trim();
  return {
    op: "add",
    id: input.id.trim(),
    ...(label ? { label } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.after ? { after: input.after } : {}),
  };
}

/**
 * `remove`, with the migrate-to target when there is one.
 *
 * `migrateTo` is sent only when non-empty. Sending `null` explicitly would be indis-
 * tinguishable from "no target" to the store, so the difference is expressed by the key
 * being absent — and the store then refuses if rows still reference the row, which is
 * exactly the refusal the user needs to see if the count this client held was stale.
 */
export function removeOp(id: string, migrateTo?: string | null): VocabularyOp {
  return migrateTo ? { op: "remove", id, migrateTo } : { op: "remove", id };
}

/**
 * Which rows a removal may migrate ONTO: every other row, in configured order.
 *
 * Excluding the row itself is the whole content of this function and it is not a detail —
 * `{ remove: "todo", migrateTo: "todo" }` is a request to move rows onto a status that
 * will not exist a microsecond later, and the store would either refuse it confusingly or
 * orphan the rows.
 */
export function migrateCandidates(rows: readonly VocabularyRow[], removing: string): VocabularyRow[] {
  return rows.filter((row) => row.id !== removing);
}

/**
 * Is this id even legal? The mirror of the store's own check, run before the round trip.
 *
 * Returns the store's vocabulary in the message ("lowercase") rather than a regex, because
 * a user who sees `/^[a-z][a-z0-9_]{0,31}$/` has been shown the implementation instead of
 * the rule. Null means "nothing to say", which is what a valid id gets — not "ok", so a
 * caller renders nothing rather than a green tick nobody asked for.
 */
export function validateVocabularyId(id: string, existing: readonly VocabularyRow[]): string | null {
  const trimmed = id.trim();
  if (trimmed === "") return "An id is required.";
  if (!VOCABULARY_ID_PATTERN.test(trimmed)) {
    return "Ids are lowercase letters, digits and underscores, start with a letter, and are at most 32 characters.";
  }
  if (existing.some((row) => row.id === trimmed)) return `"${trimmed}" already exists.`;
  return null;
}

/**
 * Has the label actually changed? A rename op for an identical label is a write, an event
 * log entry and a settings-revision bump for nothing — and the label field commits on
 * blur, so it would fire every time the user tabbed through the list.
 */
export function labelChanged(row: VocabularyRow, next: string): boolean {
  const trimmed = next.trim();
  return trimmed !== "" && trimmed !== row.label;
}
