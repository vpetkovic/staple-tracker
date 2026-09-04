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
 * `readSettingsRoute`. Three things can change it and all three go through the URL first:
 *
 *   the gear / the palette  — pushes ONE history entry carrying `?settings`;
 *   selecting a category    — replaces that entry with `?settings=<id>` (no new entry,
 *                             so Back still means "the page I was on");
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
import { onOpenSettings } from "@/lib/shell-events";
import { SettingsDialog } from "./SettingsDialog";
import { closeAction, readSettingsRoute, withSettingsRoute, type SettingsRoute } from "./settings-shell";

export function SettingsMount() {
  const [route, setRoute] = useState<SettingsRoute | null>(() => readSettingsRoute(window.location.search));
  /** Did WE push the history entry the shell is open on? Decides how closing leaves. */
  const pushed = useRef(false);

  useEffect(
    () =>
      onOpenSettings(() => {
        // Already open (the palette re-dispatching over an open shell): nothing to do.
        if (readSettingsRoute(window.location.search)) return;
        window.history.pushState(null, "", withSettingsRoute(window.location.href, ""));
        pushed.current = true;
        setRoute({ category: "" });
      }),
    [],
  );

  useEffect(() => {
    const onPop = () => {
      // Whatever entry we are on now, the browser put us there; there is nothing of ours
      // left to pop, whichever way the next close goes.
      pushed.current = false;
      setRoute(readSettingsRoute(window.location.search));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const focusCategory = useCallback((category: string) => {
    window.history.replaceState(null, "", withSettingsRoute(window.location.href, category));
    setRoute({ category });
  }, []);

  const close = useCallback(() => {
    if (closeAction(pushed.current) === "history-back") {
      pushed.current = false;
      // The popstate handler closes the dialog once the browser has moved.
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", withSettingsRoute(window.location.href, null));
    setRoute(null);
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
      onCategoryChange={focusCategory}
      onOpenChange={onOpenChange}
    />
  );
}
