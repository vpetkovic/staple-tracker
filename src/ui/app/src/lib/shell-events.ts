/**
 * The shell verbs, as window events — V2 (STA-87), a third added by O7b (STA-141).
 *
 * The command palette and the create dialog are mounted ABOVE the shell, deliberately:
 * a palette has to outlive view switches, and a create dialog has to be triggerable from
 * anywhere without any one surface owning it. That placement is correct and it is why
 * neither of them can simply be handed a prop by the header that now needs to open them.
 *
 * The alternatives were a third context just for "open this dialog", or lifting two
 * booleans into App.tsx and drilling them down. Both put the open-state of a dialog
 * somewhere other than the dialog, which is the thing the mounts were designed to avoid.
 * An event says the same thing in ten lines and keeps each mount the only owner of its
 * own flag.
 *
 * This is the same idiom lib/api.ts already uses to get an AuthError past a catch block
 * that would otherwise swallow it, so the file introduces a pattern the app already has
 * rather than a new one.
 */

const CREATE_ISSUE = "staple:open-create-issue";
const COMMAND_PALETTE = "staple:open-command-palette";
/** O7b (STA-141) — the workspace vocabulary editor. Third verb, same idiom. */
const SETTINGS = "staple:open-settings";

/** Ask whatever owns the create dialog to open it. No-op if nothing is listening. */
export function openCreateIssue(): void {
  window.dispatchEvent(new CustomEvent(CREATE_ISSUE));
}

/** Ask whatever owns the palette to open it. No-op if nothing is listening. */
export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE));
}

/** Subscribe a mount to its verb. Returns the unsubscribe, shaped for useEffect. */
export function onOpenCreateIssue(handler: () => void): () => void {
  window.addEventListener(CREATE_ISSUE, handler);
  return () => window.removeEventListener(CREATE_ISSUE, handler);
}

export function onOpenCommandPalette(handler: () => void): () => void {
  window.addEventListener(COMMAND_PALETTE, handler);
  return () => window.removeEventListener(COMMAND_PALETTE, handler);
}

/** Ask whatever owns the settings dialog to open it. No-op if nothing is listening. */
export function openSettings(): void {
  window.dispatchEvent(new CustomEvent(SETTINGS));
}

export function onOpenSettings(handler: () => void): () => void {
  window.addEventListener(SETTINGS, handler);
  return () => window.removeEventListener(SETTINGS, handler);
}
