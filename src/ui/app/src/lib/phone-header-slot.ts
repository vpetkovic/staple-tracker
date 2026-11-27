import { useLayoutEffect, useState } from "react";
import { useIsDesk } from "./use-media";

/**
 * The phone shell's slot beside the page name (AppShell's `[data-phone-header-slot]`), or null:
 * on the desk, and wherever the shell drew none. A page portals its own compact control into it
 * (Plan's lens tabs, Milestones' fold control, Analytics' lenses and filters).
 *
 * The shell draws the slot only in its phone shape, and it can change shape a moment after this
 * hook hears the same media change (a desk window dragged narrow). So the slot is looked up when
 * the width class changes and again whenever the shell's own shape attribute does; otherwise the
 * page would keep its desk layout inside a phone shell until it was reloaded.
 */
export function usePhoneHeaderSlot(): HTMLElement | null {
  const desk = useIsDesk();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const find = () => setSlot(document.querySelector<HTMLElement>("[data-phone-header-slot]"));
    find();
    const shell = document.querySelector("[data-shell]");
    if (!shell || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(find);
    observer.observe(shell, { attributes: true, attributeFilter: ["data-shell"] });
    return () => observer.disconnect();
  }, [desk]);
  return slot;
}
