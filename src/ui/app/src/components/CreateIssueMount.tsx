/**
 * MOUNT POINT — the create dialog.
 *
 * Already rendered once in App.tsx, above the shell and outside every view, which is
 * what lets the dialog sit over any view and over the detail drawer without either
 * owning it.
 *
 * This file owns exactly two things — the ways in, and the open flag. The form lives in
 * CreateIssueDialog and is only mounted while open, so its state resets between opens
 * and a half-typed task never comes back from a previous session.
 *
 * Two ways in, deliberately:
 *   - `c`, the convention every issue tracker shares;
 *   - a visible control, because a keyboard-only affordance is undiscoverable.
 *
 * V2 (STA-87) MOVED THE VISIBLE CONTROL. It used to be a floating pill pinned to the
 * bottom-right corner of the viewport. A FAB is an Android pattern; no tool in the
 * language this app now speaks has one, and it had two concrete costs beyond taste — it
 * hovered over the last rows of the list, and it put the app's primary action as far from
 * the app's other actions as the screen allows. The button now lives in the header next
 * to search and theme, and reaches this state through `lib/shell-events`, so the open
 * flag stays here rather than being lifted into a component that does not care about it.
 */
import { useEffect, useState } from "react";
import { onOpenCreateIssue } from "@/lib/shell-events";
import { CreateIssueDialog } from "./CreateIssueDialog";

/**
 * True when the keystroke belongs to whatever the user is typing into.
 *
 * The palette binds cmd-K and can afford to ignore focus; a bare letter cannot. Without
 * this, `c` would be swallowed out of the assignee filter, the comment box, and the
 * dialog's own title field — which would make the shortcut actively hostile.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function CreateIssueMount() {
  const [open, setOpen] = useState(false);

  useEffect(() => onOpenCreateIssue(() => setOpen(true)), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "c" && event.key !== "C") return;
      // A modifier means the user meant cmd-C / ctrl-C / alt-C, none of which are ours.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      // Radix marks the rest of the page inert while any dialog is open; opening a
      // second one over the palette would trap focus between the two.
      if (document.querySelector("[data-slot='dialog-content'], [role='dialog']")) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Mounted only while open: the form's state resets with it, by construction.
  if (!open) return null;
  return <CreateIssueDialog open onOpenChange={setOpen} />;
}
