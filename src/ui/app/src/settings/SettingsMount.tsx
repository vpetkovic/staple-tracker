/**
 * MOUNT POINT — the settings dialog. O7b (STA-141); R6b (STA-177) gave it a URL.
 *
 * The same shape as `CreateIssueMount`, and for the same reasons: rendered once in
 * App.tsx above the shell so it survives view switches and can sit over the detail
 * drawer, opened through a `lib/shell-events` verb so the open flag stays here rather
 * than being lifted into the header that happens to have the button, and mounted ONLY
 * while open so a half-typed new status id does not come back next time.
 *
 * ── THE URL IS THE OPEN FLAG ──────────────────────────────────────────────────────────
 *
 * Since R6b the flag is not a boolean but the `?settings` parameter, read through
 * `readSettingsRoute`, with `settings-ws` naming the workspace the per-workspace sections
 * edit. Four things can change them and all four go through the URL first:
 *
 *   the gear / the palette  — pushes ONE history entry carrying `?settings`;
 *   selecting a category    — replaces that entry with `?settings=<id>` (no new entry,
 *                             so Back still means "the page I was on");
 *   the workspace picker    — replaces it with `settings-ws=<slug>`, same reason;
 *   Back / forward          — `popstate` re-reads the URL, which is what closes the
 *                             shell on Back and reopens it on Forward.
 *
 * Closing with the X or Esc pops the entry this mount pushed, so the URL and the dialog
 * cannot disagree; a deep-link arrival pushed nothing, so the parameter is stripped in
 * place instead. `closeAction` in settings-shell.ts is that choice, and it is tested.
 *
 * No bare-letter keyboard shortcut. `c` earned one because creating a task is the thing
 * you do twenty times a day; editing the workspace's settings is a thing you do twice a
 * year, and spending another single letter on it would take that letter away from
 * something that deserves it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  afterHistorySettles,
  leaveOverlays,
  overlayEntryIsOpen,
  popOverlay,
  pushOverlayEntry,
  replaceUrl,
} from "@/lib/back-to-close";
import { onOpenSettings } from "@/lib/shell-events";
import { rememberWorkspace } from "@/lib/session-workspace";
import { SettingsDialog } from "./SettingsDialog";
import { closeAction, readSettingsRoute, withSettingsRoute, type SettingsRoute } from "./settings-shell";

export function SettingsMount() {
  const [route, setRoute] = useState<SettingsRoute | null>(() => readSettingsRoute(window.location.search));
  /**
   * The overlay entry WE pushed when the shell opened (lib/back-to-close.ts), or null after
   * a deep-link arrival, which pushed nothing. Decides how closing leaves: `closeAction`.
   */
  const entry = useRef<string | null>(null);

  useEffect(
    () =>
      onOpenSettings((request) => {
        const category = request.section ?? "";
        const workspace = request.workspace ?? "";
        // Queued behind whatever was closing when this was asked for — the drawer the gear
        // sits in, the palette — so the entry lands on top of the page, not under a Back.
        afterHistorySettles(() => {
          // Already open (the palette re-dispatching over an open shell): re-point it in place.
          if (readSettingsRoute(window.location.search)) {
            replaceUrl(withSettingsRoute(window.location.href, category, workspace || undefined));
            setRoute(readSettingsRoute(window.location.search));
            return;
          }
          entry.current = pushOverlayEntry(withSettingsRoute(window.location.href, category, workspace || null));
          setRoute({ category, workspace });
        });
      }),
    [],
  );

  useEffect(() => {
    // Back, Forward, or an overlay above the shell closing: the address says what is open.
    const onPop = () => setRoute(readSettingsRoute(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const focusCategory = useCallback((category: string) => {
    afterHistorySettles(() => replaceUrl(withSettingsRoute(window.location.href, category)));
    setRoute((current) => ({ category, workspace: current?.workspace ?? "" }));
  }, []);

  /**
   * The in-Settings workspace picker. Replaces the entry (Back still means "the page I was
   * on"), keeps the section, and is remembered as the default answer to "which workspace?".
   */
  const focusWorkspace = useCallback((workspace: string) => {
    rememberWorkspace(workspace);
    afterHistorySettles(() => {
      const current = readSettingsRoute(window.location.search);
      replaceUrl(withSettingsRoute(window.location.href, current?.category ?? "", workspace));
    });
    setRoute((held) => ({ category: held?.category ?? "", workspace }));
  }, []);

  const close = useCallback(() => {
    const ours = entry.current;
    entry.current = null;
    if (closeAction(ours !== null && overlayEntryIsOpen(ours)) === "history-back") {
      // Back past our entry and anything above it (a section's own entry on a phone); the
      // popstate handler closes the dialog once the browser has moved.
      popOverlay(ours!);
      return;
    }
    // A deep-link arrival: step out of any overlay entries above the page, then strip the
    // parameters in place.
    leaveOverlays(() => {
      replaceUrl(withSettingsRoute(window.location.href, null));
      setRoute(null);
    });
  }, []);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close();
    },
    [close],
  );

  if (!route) return null;
  return (
    <SettingsDialog
      open
      category={route.category}
      workspace={route.workspace}
      onCategoryChange={focusCategory}
      onWorkspaceChange={focusWorkspace}
      onOpenChange={onOpenChange}
    />
  );
}
