/**
 * Plan provenance in words (`plan-provenance.ts`), as every surface prints it: the CLI and the
 * page read these, so the chip and `staple show` cannot drift. Pure, with no imports the page
 * cannot bundle.
 */

/** What the chip reads of a scaffolded ticket's provenance. */
export interface ScaffoldedFromWordsInput {
  ideaNumber: string | null;
  identifier: string | null;
  rowKey: string | null;
}

/** What a sparked idea's reference reads. */
export interface SparkedIdeaWordsInput {
  ideaNumber: string | null;
  identifier: string | null;
  maturity: string | null;
}

/** The provenance chip's words, as every surface prints them: `from I-STA-4 · row R2`. */
export function scaffoldedFromWords(from: ScaffoldedFromWordsInput): string {
  const idea = from.ideaNumber ?? from.identifier ?? "an idea";
  return from.rowKey === null ? `from ${idea} · a removed row` : `from ${idea} · row ${from.rowKey}`;
}

/** A sparked idea's reference: its idea number, with its ticket number once promoted. */
export function sparkedIdeaWords(idea: SparkedIdeaWordsInput): string {
  const number = idea.ideaNumber ?? "idea";
  return idea.identifier === null ? `${number}(${idea.maturity ?? "idea"})` : `${idea.identifier} · ${number}`;
}
