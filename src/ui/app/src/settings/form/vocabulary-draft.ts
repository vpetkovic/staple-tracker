/**
 * A VOCABULARY DRAFT — R6c (STA-178). The ops model of settings-ops.ts, held locally
 * until Save.
 *
 * Before this ticket every edit in the Statuses and Kinds editors was a batch of one op,
 * POSTed as the user committed it. The ops are unchanged — `add`, `rename`,
 * `recategorize`, `reorder`, `remove` with `migrateTo`, built by the same functions —
 * but now they ACCUMULATE, in order, and are projected onto a local copy of the rows so
 * the list shows what Save will produce. Save posts the whole list through the same
 * all-or-nothing batch the MCP tools use; Cancel throws it away.
 *
 * The projection is deliberately literal: it applies an op the way the store would,
 * and nothing more. It does not validate on the store's behalf (settings-ops.ts's rule),
 * so a draft can hold an op the store will refuse — a removal whose count was stale, a
 * reorder over a status somebody else just added — and the refusal arrives as the
 * store's sentence, attributed to the row it names. A usage count DOES move on a
 * migrate-to removal, because the next removal in the same draft has to know that the
 * target now carries those rows; the store's count is the one that finally decides.
 */
import { titleCaseId } from "../../lib/settings";
import type { StatusCategory, VocabularyOp } from "../../lib/types";
import { moveIndex, type VocabularyRow } from "../settings-ops";

export interface VocabularyDraft {
  /** The rows as the ops so far leave them, in the order Save will store. */
  rows: VocabularyRow[];
  /** Per-id counts, moved along by migrate-to removals. */
  usage: Record<string, number>;
  /** The ordered batch Save posts. Empty means clean. */
  ops: VocabularyOp[];
}

export function emptyDraft(rows: readonly VocabularyRow[], usage: Record<string, number>): VocabularyDraft {
  return { rows: [...rows], usage: { ...usage }, ops: [] };
}

export function isDraftDirty(draft: VocabularyDraft): boolean {
  return draft.ops.length > 0;
}

/** The ids and labels a refusal could name, for `attributeRefusal`. */
export function draftRefusalTargets(draft: VocabularyDraft): { id: string; terms: string[] }[] {
  const ids = new Set(draft.rows.map((row) => row.id));
  for (const op of draft.ops) if ("id" in op) ids.add(op.id);
  return [...ids].map((id) => {
    const row = draft.rows.find((r) => r.id === id);
    return { id, terms: row ? [`"${id}"`, `"${row.label}"`, id] : [`"${id}"`, id] };
  });
}

/**
 * The draft with one more op applied. Always a NEW draft; the previous one is untouched,
 * which is what makes Cancel a matter of dropping a reference.
 */
export function applyDraftOp(draft: VocabularyDraft, op: VocabularyOp): VocabularyDraft {
  const next: VocabularyDraft = { rows: [...draft.rows], usage: { ...draft.usage }, ops: [...draft.ops, op] };
  switch (op.op) {
    case "add": {
      const row: VocabularyRow = {
        id: op.id,
        // The store derives the label from the id when none is given; the draft previews
        // the same derivation so the list shows the row Save will produce.
        label: op.label ?? titleCaseId(op.id),
        isBuiltin: false,
        ...(op.category ? { category: op.category } : {}),
      };
      const after = op.after ? next.rows.findIndex((r) => r.id === op.after) : -1;
      if (after === -1) next.rows.push(row);
      else next.rows.splice(after + 1, 0, row);
      next.usage[op.id] = 0;
      break;
    }
    case "rename":
      next.rows = next.rows.map((r) => (r.id === op.id ? { ...r, label: op.label } : r));
      break;
    case "recategorize":
      next.rows = next.rows.map((r) => (r.id === op.id ? { ...r, category: op.category as StatusCategory } : r));
      break;
    case "reorder": {
      const byId = new Map(next.rows.map((r) => [r.id, r]));
      const ordered = op.ids.map((id) => byId.get(id)).filter((r): r is VocabularyRow => r !== undefined);
      // Rows the order did not name keep their place at the end, so a stale order
      // cannot make a row vanish from the list before the store has had its say.
      next.rows = [...ordered, ...next.rows.filter((r) => !op.ids.includes(r.id))];
      break;
    }
    case "remove": {
      const carried = next.usage[op.id] ?? 0;
      next.rows = next.rows.filter((r) => r.id !== op.id);
      delete next.usage[op.id];
      if (op.migrateTo) next.usage[op.migrateTo] = (next.usage[op.migrateTo] ?? 0) + carried;
      break;
    }
  }
  return next;
}

/** A keyboard or drag move as a draft op: the WHOLE order, as the store wants it. */
export function moveDraftRow(draft: VocabularyDraft, from: number, to: number): VocabularyDraft {
  if (to < 0 || to >= draft.rows.length || from === to) return draft;
  const rows = moveIndex(draft.rows, from, to);
  return applyDraftOp(draft, { op: "reorder", ids: rows.map((r) => r.id) });
}
