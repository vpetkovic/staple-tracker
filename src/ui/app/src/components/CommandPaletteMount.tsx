/**
 * MOUNT POINT — owned by U7 (cmd-K palette).
 *
 * It is already rendered once, at the top of the tree in App.tsx, above the shell and
 * outside every view. That placement is the part worth getting right up front: a
 * palette has to survive view switches, sit above the detail panel, and be reachable
 * whatever is focused.
 *
 * This file owns exactly two things — the key binding and the open flag. The palette
 * body lives in command-palette/ and is only mounted while open, so its issue fetch
 * happens on open and the list is fresh every time, rather than being one more thing the
 * 1.5s poll keeps warm for a dialog nobody has opened.
 */
import { useEffect, useState } from "react";
import { CommandPalette } from "./command-palette/CommandPalette";

export function CommandPaletteMount() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      // Deliberately not gated on what has focus. cmd-K from inside the assignee filter
      // is the case where you most want it, and the browser's own cmd-K (search bar
      // focus, in some builds) is not something a local tool needs to preserve.
      event.preventDefault();
      setOpen((current) => !current);
    };
    // Capture phase: the detail panel and the dialog both stop keydown propagation in
    // places, and cmd-K has to work over all of them.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  if (!open) return null;
  return <CommandPalette open onOpenChange={setOpen} />;
}
