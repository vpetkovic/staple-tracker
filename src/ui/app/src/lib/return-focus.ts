/**
 * WHERE A DIALOG HANDS THE FOCUS BACK when nothing on the page is its trigger.
 *
 * Radix's Dialog returns the focus, on closing, to its own `Dialog.Trigger`. A dialog opened by
 * an event (`openSettings`, `openProjectDialog`) has no trigger, so the focus fell to `<body>`
 * and a keyboard reader lost their place. This remembers what had the focus when the dialog
 * opened (the rail's Settings row, the phone's More tab) and gives it back on close, when it
 * is still on the page.
 */
import { useRef } from "react";

export function useReturnFocus(open: boolean): (event: Event) => void {
  const opener = useRef<HTMLElement | null>(null);
  const read = useRef(false);
  // Read once, while the dialog first renders open: the focus is still where the person was.
  if (open && !read.current && typeof document !== "undefined") {
    read.current = true;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  if (!open) read.current = false;
  return (event) => {
    const target = opener.current;
    opener.current = null;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus();
  };
}
