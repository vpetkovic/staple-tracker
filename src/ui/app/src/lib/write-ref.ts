/**
 * What a write from the page names an issue by: its id — never a number.
 *
 * An issue's identifier can move after the page loaded it: sync renumbers an issue two
 * devices numbered alike, and the number then names another issue. The store refuses a
 * write through a number an issue has left while that issue may be the one meant
 * (`docs/sync.md`, "A number that moved under a caller"), and the page has no way to say
 * "I know" — so it never writes through a number at all. Every row the page shows carries
 * its id; a write takes the id of the row the reader acted on, and a number somebody typed
 * or pasted is looked up among the rows the page holds, where it names exactly one.
 *
 * An issue in another workspace is named `<slug>:<id>`, which the server and the hub
 * resolve by id (`Hub.validateCrossLink`).
 */
/** A row the page shows: its workspace, and the issue with its id and number. */
export interface WritableRow {
  readonly workspace: string;
  readonly issue: { readonly id: string; readonly identifier: string };
}

/**
 * Identifiers the reader acted on — an order, a row — as the ids of the rows that showed
 * them. A list the page holds (the plan's entries, a milestone's members) knows both.
 */
export function idsOf(rows: readonly { identifier: string; id: string }[], identifiers: readonly string[]): string[] {
  const byIdentifier = new Map(rows.map((row) => [row.identifier, row.id]));
  return identifiers.map((identifier) => byIdentifier.get(identifier) ?? identifier);
}

export function pinnedRef(rows: readonly WritableRow[], workspace: string, ref: string): string {
  const typed = ref.trim();
  const wanted = typed.toUpperCase();
  const row =
    rows.find((candidate) => candidate.issue.id === typed) ??
    rows.find((candidate) => candidate.workspace === workspace && candidate.issue.identifier.toUpperCase() === wanted) ??
    rows.find((candidate) => candidate.issue.identifier.toUpperCase() === wanted);
  if (!row) return typed;
  return row.workspace === workspace || workspace === "" ? row.issue.id : `${row.workspace}:${row.issue.id}`;
}
