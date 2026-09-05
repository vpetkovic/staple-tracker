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
 * THE VISIBLE CONTROL IS THE FIRST ROW OF THE NAVIGATION RAIL. It was once a floating
 * pill in the bottom-right corner, then a button in the header; it is now the full-width
 * "New task" at the top of the rail (`components/nav/NavRail.tsx`), which reaches this
 * state through `lib/shell-events`, so the open flag stays here rather than being lifted
 * into a component that does not care about it.
 */
import { useEffect, useState } from "react";
import { dialogIsOpen, isTyping } from "@/lib/keyboard";
import { onOpenCreateIssue } from "@/lib/shell-events";
import { CreateIssueDialog } from "./CreateIssueDialog";

export function CreateIssueMount() {
  const [open, setOpen] = useState(false);

  useEffect(() => onOpenCreateIssue(() => setOpen(true)), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "c" && event.key !== "C") return;
      // A modifier means the user meant cmd-C / ctrl-C / alt-C, none of which are ours.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // `isTyping`: a bare letter must not fire out of a text box. `dialogIsOpen`: Radix
      // marks the rest of the page inert while any dialog is open, and opening a second
      // one over the palette would trap focus between the two.
      if (isTyping(event.target) || dialogIsOpen()) return;
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
