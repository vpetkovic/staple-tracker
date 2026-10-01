/**
 * Where a file's side panel sits, and how wide it may be.
 *
 * The ticket drawer is already a column. A file opens beside it, in its own
 * panel, and the reader drags the panel's left edge. The width is a working
 * preference, like the ticket's drawer-or-page choice, so it survives the
 * next file and the next ticket. A phone has no room beside the ticket, so
 * the panel is the screen and does not resize.
 */

export const FILE_PANEL_WIDTH_KEY = "staple:file-panel-width";

/** A comfortable document width, until the reader drags. */
export const FILE_PANEL_DEFAULT = 420;

/** Narrower than this and the filename, the size and the actions collide. */
export const FILE_PANEL_MIN = 320;

/** Same breakpoint as the ticket sheet. Below it, a second column does not fit. */
export const FILE_SHEET_BELOW = 768;

export interface FilePanelDock {
  /** CSS `right`, in px. 0 when the panel sits on the viewport's right edge. */
  right: number;
  /** Widest the panel may be, in px. */
  available: number;
  /** A phone: the panel is the screen, and it does not resize. */
  sheet: boolean;
}

/**
 * `taskLeft` is the ticket panel's left edge. The file meets that edge, so
 * the two sit side by side and the drag only covers the list. A ticket that
 * is already edge to edge (a page, or a phone sheet) has no left edge to
 * meet, and the file sits on the right of the viewport instead.
 */
export function filePanelDock(taskLeft: number, viewportWidth: number): FilePanelDock {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return { right: 0, available: FILE_PANEL_DEFAULT, sheet: false };
  }
  if (viewportWidth < FILE_SHEET_BELOW) {
    return { right: 0, available: viewportWidth, sheet: true };
  }
  if (!Number.isFinite(taskLeft) || taskLeft <= 8) {
    return { right: 0, available: Math.max(FILE_PANEL_MIN, viewportWidth - 48), sheet: false };
  }
  return {
    right: Math.max(0, viewportWidth - taskLeft),
    available: Math.max(FILE_PANEL_MIN, taskLeft - 8),
    sheet: false,
  };
}

export function clampFilePanelWidth(width: number, available: number): number {
  const max = Math.max(FILE_PANEL_MIN, available);
  const raw = Number.isFinite(width) ? width : FILE_PANEL_DEFAULT;
  return Math.round(Math.min(max, Math.max(FILE_PANEL_MIN, raw)));
}

export function loadFilePanelWidth(storage: Storage | undefined): number {
  if (!storage) return FILE_PANEL_DEFAULT;
  try {
    const raw = Number(storage.getItem(FILE_PANEL_WIDTH_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : FILE_PANEL_DEFAULT;
  } catch {
    return FILE_PANEL_DEFAULT;
  }
}

export function saveFilePanelWidth(storage: Storage | undefined, width: number): void {
  if (!storage) return;
  try {
    storage.setItem(FILE_PANEL_WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* private mode: the width lasts for this page load */
  }
}
