/**
 * MOUNT POINT — owned by U5 (create dialog).
 *
 * Already rendered once in App.tsx, above the shell and outside every view, which is
 * what lets the dialog sit over the board and the detail panel without either owning it.
 *
 * This file owns exactly two things — the triggers and the open flag. The form lives in
 * CreateIssueDialog and is only mounted while open, so its state resets between opens
 * and a half-typed task never comes back from a previous session.
 *
 * Two ways in, deliberately:
 *   - `c`, the convention every issue tracker shares;
 *   - a visible button, because a keyboard-only affordance is undiscoverable and this
 *     is the one action the page previously could not do at all.
 */
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
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

  return (
    <>
      <button
        type="button"
        data-create-open
        onClick={() => setOpen(true)}
        title="New task (c)"
        className="fixed right-5 bottom-5 z-40 inline-flex items-center gap-1.5 rounded-full border bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-foreground shadow-lg transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Plus className="size-4" aria-hidden />
        New task
      </button>

      {/* Mounted only while open: the form's state resets with it, by construction. */}
      {open ? <CreateIssueDialog open onOpenChange={setOpen} /> : null}
    </>
  );
}
