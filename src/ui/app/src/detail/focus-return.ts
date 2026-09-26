/**
 * Where focus goes when the detail closes: back to the row of the task that was open.
 *
 * Radix returns focus to whatever was focused when the dialog opened. That is the wrong
 * element twice over. A tap on a phone focuses nothing (or the `⋯` trigger, when the detail
 * came from the row menu), and Previous/Next can move the sheet several tasks away from the
 * row it was opened from. The reader closing the sheet expects to land on the task they were
 * last looking at, so that is the row we look for.
 *
 * It is a lookup and not a remembered element because the list re-renders on every poll: an
 * element captured at open time may be gone by the time the sheet closes.
 */

/** The smallest slice of `Document` this needs, so a test can hand in a stub. */
export interface FocusRoot {
  querySelector(selector: string): { focus(options?: FocusOptions): void } | null;
  readonly activeElement: unknown;
}

/** The row the list drew for this identifier, never the dimmed parent-for-context copy. */
export function rowSelector(identifier: string): string {
  const escaped = identifier.replace(/["\\]/g, "\\$&");
  return `[data-testid="task-row"][data-identifier="${escaped}"]:not([data-ghost])`;
}

/**
 * Focus the row for `identifier`. True when the row took focus, so the caller can stop the
 * dialog's own return; false (no row on screen, or a row that is not focusable, as on the
 * Queue's plan rows) leaves the dialog's default in place.
 */
export function focusRow(root: FocusRoot, identifier: string | null | undefined): boolean {
  if (!identifier) return false;
  const row = root.querySelector(rowSelector(identifier));
  if (!row) return false;
  row.focus({ preventScroll: false });
  return root.activeElement === row;
}
