/**
 * Where a document revision goes: one rule, for every reader of the log.
 *
 * Contract: `docs/sync.md`, "Two revisions written as one number".
 *
 * A revision's number is its document's next, decided on the device that writes it, so two
 * devices that each write revision N before seeing the other's both send an N. The log
 * decides: taken in log order, each revision is the first number from the one it claimed
 * upward that no revision before it holds. The applier (`applyDocumentRevision` in
 * `apply.ts`), the service's fold (`worker/src/fold.ts`), the tail fold (`tail-fold.ts`)
 * and the test service all place a revision with {@link placeRevision}, so every device and
 * every snapshot reach the same numbers.
 *
 * Pure: no database, no Node. The Worker imports it as it stands.
 */

/** What identifies a revision's content. */
export interface RevisionContent {
  readonly body?: unknown;
  readonly author?: unknown;
}

/**
 * The same revision: the same body, and the same author where both have one.
 *
 * Never its time. A build before this one stamped a revision it applied with the time of
 * the operation, which can be a millisecond off the time the revision carries; compared,
 * every revision such a device held read as a different one, and it gained a renumbered
 * copy of each.
 */
export function sameRevision(held: RevisionContent, incoming: RevisionContent): boolean {
  if (held.body !== incoming.body) return false;
  if (typeof held.author === "string" && typeof incoming.author === "string" && held.author !== incoming.author) return false;
  return true;
}

/** The first number from `from` upward that `taken` does not hold. */
export function firstFreeRevision(taken: ReadonlySet<number>, from: number): number {
  let slot = from;
  while (taken.has(slot)) slot += 1;
  return slot;
}

const RENUMBERED = /^(?:([\s\S]*) — )?renumbered from r(\d+) to r\d+: written at the same time as another r\2, which the repository's log holds first$/;

/**
 * A renumbered revision's change summary: its own, and what happened to its number — from
 * the number it was written as, whatever it was moved through on the way, so every device
 * says the same thing about it.
 */
export function renumberedSummary(summary: unknown, from: number, to: number): string {
  const written = writtenAs(summary) ?? from;
  const own = writtenSummary(summary) ?? "";
  const kept = own.trim() !== "" ? `${own} — ` : "";
  return `${kept}renumbered from r${written} to r${to}: written at the same time as another r${written}, which the repository's log holds first`;
}

/** The summary a revision was written with, without what a renumbering added. */
export function writtenSummary(summary: unknown): string | null {
  if (typeof summary !== "string") return null;
  const moved = RENUMBERED.exec(summary);
  if (!moved) return summary;
  return moved[1] ?? null;
}

/** The number a renumbered revision was written as, from its summary; null for one never moved. */
export function writtenAs(summary: unknown): number | null {
  if (typeof summary !== "string") return null;
  const moved = RENUMBERED.exec(summary);
  return moved ? Number(moved[2]) : null;
}

/** A revision's summary at `slot`, when it claimed `claimed` (or, moved before, the number its summary says). */
export function summaryAt(summary: unknown, claimed: number, slot: number): string | null {
  const written = writtenAs(summary) ?? claimed;
  return slot === written ? writtenSummary(summary) : renumberedSummary(summary, written, slot);
}

export interface Placement {
  /** The number the revision holds. */
  readonly revision: number;
  /** True when the log already placed this revision: a re-send, or the same text sent twice. */
  readonly again: boolean;
  /** Its change summary there, the move said in it when it moved. */
  readonly changeSummary: string | null;
}

/**
 * One step of the log: a revision claiming `claimed`, against the revisions of its document
 * the log placed before it.
 *
 * It is already there when a revision with its content sits at or above the number it was
 * written as — a device sending again the revision it moved, under the number it moved it
 * to (`claims.ts`), or two devices sending the same text. Below that number it is not: a
 * document put back to an earlier text is a new revision of it. Otherwise it takes the
 * first free number from `claimed` upward.
 */
export function placeRevision(
  held: Iterable<RevisionContent & { readonly revision: number }>,
  claimed: number,
  incoming: RevisionContent & { readonly changeSummary?: unknown },
): Placement {
  const floor = Math.min(claimed, writtenAs(incoming.changeSummary) ?? claimed);
  const taken = new Set<number>();
  let again: number | null = null;
  for (const row of held) {
    taken.add(row.revision);
    if (row.revision >= floor && sameRevision(row, incoming) && (again === null || row.revision < again)) again = row.revision;
  }
  if (again !== null) return { revision: again, again: true, changeSummary: null };
  const revision = firstFreeRevision(taken, claimed);
  return { revision, again: false, changeSummary: summaryAt(incoming.changeSummary, claimed, revision) };
}

/** An entity as a fold of the log holds it. */
export interface FoldedRevisionEntry {
  readonly entity: string;
  readonly entityId: string;
  readonly deletedAt: number | null;
  readonly state: Record<string, unknown>;
}

/**
 * A revision's `create`, as a fold of the log takes it: under the number {@link placeRevision}
 * settles it to, the move said in its summary — or null when the log already holds it, and
 * the operation adds nothing. `entityId` is `<issue>/<key>/<revision>`.
 */
export function settleRevisionCreate(
  entries: Iterable<FoldedRevisionEntry>,
  entityId: string,
  payload: Record<string, unknown>,
): { entityId: string; payload: Record<string, unknown> } | null {
  const slash = entityId.lastIndexOf("/");
  const document = entityId.slice(0, slash + 1);
  const claimed = Number(entityId.slice(slash + 1));
  if (!Number.isInteger(claimed)) return { entityId, payload };
  const held: Array<RevisionContent & { revision: number }> = [];
  for (const entry of entries) {
    if (entry.entity !== "documentRevision" || entry.deletedAt !== null || !entry.entityId.startsWith(document)) continue;
    const revision = Number(entry.entityId.slice(document.length));
    if (Number.isInteger(revision)) held.push({ revision, body: entry.state.body, author: entry.state.author });
  }
  const placed = placeRevision(held, claimed, payload);
  if (placed.again) return null;
  if (placed.revision === claimed && placed.changeSummary === (payload.changeSummary ?? null)) return { entityId, payload };
  return {
    entityId: `${document}${placed.revision}`,
    payload: { ...payload, revision: placed.revision, changeSummary: placed.changeSummary },
  };
}
