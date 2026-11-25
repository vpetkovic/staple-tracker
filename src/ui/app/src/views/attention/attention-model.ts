/**
 * The Attention page's model: the server's rows, in sections, worded. Pure and tested
 * (attention-render.test.tsx).
 *
 * Nothing about WHICH rows are listed or in what order is decided here: `/api/attention`
 * answers with `core/attention.ts`'s rows already sorted (kind order, then the longest waiting
 * first), the same rows `staple attention` prints. This file only cuts that list into one
 * section per kind, in the order the rows arrive, under the label each row carries.
 */
import { formatAgo } from "@/lib/claim";
import type { AttentionRow } from "@/lib/types";

export interface AttentionSection {
  kind: string;
  label: string;
  rows: AttentionRow[];
}

/** One section per kind present, in the order the server sent the rows. */
export function attentionSections(rows: readonly AttentionRow[]): AttentionSection[] {
  const sections: AttentionSection[] = [];
  for (const row of rows) {
    const last = sections[sections.length - 1];
    if (last && last.kind === row.kind) last.rows.push(row);
    else sections.push({ kind: row.kind, label: row.label, rows: [row] });
  }
  return sections;
}

/** "waiting 2h". */
export function ageText(row: Pick<AttentionRow, "ageSeconds">): string {
  return `waiting ${formatAgo(row.ageSeconds)}`;
}

/** What the row is called on its first line: the ticket, or the run. */
export function rowSubject(row: Pick<AttentionRow, "ref" | "runId">): string | null {
  return row.ref ?? (row.runId ? `run ${row.runId.slice(0, 8)}` : null);
}

/** What a click on the row's action does, by verb. */
export type AttentionGo =
  | { to: "issue"; workspace: string; ref: string }
  | { to: "run"; runId: string }
  | { to: "resolve"; workspace: string; conflictId: string };

export function attentionGo(row: AttentionRow): AttentionGo | null {
  if (row.action.verb === "inspect" && row.runId) return { to: "run", runId: row.runId };
  if (row.action.verb === "resolve" && row.conflictId) return { to: "resolve", workspace: row.workspace, conflictId: row.conflictId };
  return row.ref ? { to: "issue", workspace: row.workspace, ref: row.ref } : null;
}
