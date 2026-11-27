import { useLayoutEffect, useState } from "react";
import { useIsDesk } from "./use-media";

/**
 * The phone shell's slot beside the page name (AppShell's `[data-phone-header-slot]`), or null:
 * on the desk, and wherever the shell drew none. A page portals its own compact control into it
 * (Plan's lens tabs, Milestones' fold control).
 */
export function usePhoneHeaderSlot(): HTMLElement | null {
  const desk = useIsDesk();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setSlot(desk ? null : document.querySelector<HTMLElement>("[data-phone-header-slot]")), [desk]);
  return slot;
}
