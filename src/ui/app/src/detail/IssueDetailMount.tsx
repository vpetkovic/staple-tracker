/**
 * MOUNT POINT — the detail overlay (V3 / STA-88).
 *
 * WHAT CHANGED AND WHY. The detail used to be the right-hand column of a CSS grid in
 * App.tsx: opening an issue reflowed the entire view to 70% width and everything the
 * reader was looking at moved sideways. That is the single worst thing a detail
 * panel can do — you click a row to learn more about it and the row jumps. It also
 * capped the panel at 30rem, because anything wider would have squeezed the list it
 * was squeezing out of, which is why the old panel's tabs were a column of
 * eleven-pixel text in a 400px slot.
 *
 * An overlay unpicks both at once. The view underneath does not move, does not
 * reflow, and does not know this exists; the panel is as wide as it wants to be
 * because it is not taking the width from anybody. Once nothing behind it is
 * negotiating for space, "and it can also be nearly full-screen" costs one extra
 * class list rather than a second layout.
 *
 * WHY A MOUNT AND NOT A PROP. This renders next to CommandPaletteMount and
 * CreateIssueMount, above the shell, and takes no props at all: it reads
 * `session.selection` itself and portals to `document.body`. That is a coordination
 * decision as much as a technical one — V2 (STA-87) is rewriting the shell in
 * parallel, and a component that portals out of the tree and reads its own state has
 * exactly one line of contact with whatever shell it ends up inside. V2 renders
 * `<IssueDetailMount />`; there is nothing else for them to get right.
 *
 * WHY RADIX DIALOG AND NOT A DIV. Everything in the acceptance criteria after
 * "overlay" — Esc, scrim-dismiss, focus trap, focus RESTORE to the row you came
 * from, `aria-modal`, inert background, scroll lock — is a solved problem that is
 * miserable to solve again, and the app already vendors the primitive. What is left
 * for this file is the part that is actually staple's: which mode, how wide, and the
 * two places Radix's defaults are wrong for this panel (see onEscapeKeyDown).
 */
import { useCallback, useState } from "react";
import { Dialog as DialogPrimitive, VisuallyHidden } from "radix-ui";
import type { AuthError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { loadMode, otherMode, saveMode, type DetailMode } from "./drawer";
import { IssueDetailPanel } from "./IssueDetailPanel";
import "./detail.css";

/** `window.localStorage` can throw on ACCESS, not just on use, when site data is blocked. */
function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The geometry, per mode, and the only place either number appears.
 *
 *   drawer — 46rem (736px), flush to the right edge, full height. Roughly twice the
 *            old column. The width is chosen against content rather than against a
 *            breakpoint: the widest thing this panel has to render is DocumentDiff's
 *            side-by-side revision compare, which needs two ~40ch columns plus
 *            gutters before it starts wrapping mid-word. `94vw` is the floor so the
 *            drawer is still a drawer on a small laptop rather than a full cover.
 *
 *   full   — inset from every edge and capped at 86rem (1376px). NOT `inset-0`, and
 *            the margin is load-bearing: an overlay that reaches all four edges has
 *            stopped being an overlay and become a page, at which point closing it
 *            feels like navigating back, and the scrim — the thing telling you the
 *            list is still there behind this — has nowhere to show. The cap keeps
 *            the reading measure sane on a 32" display, where a 3000px-wide
 *            description would be unreadable at any font size.
 */
const PANEL_CLASS: Record<DetailMode, string> = {
  drawer: "inset-y-0 right-0 w-[min(46rem,94vw)] border-l",
  full: "inset-2 mx-auto max-w-[86rem] rounded-xl border shadow-xl sm:inset-4 lg:inset-6",
};

export function IssueDetailMount() {
  const session = useSession();
  const selection = session.selection;

  /**
   * The mode lives here rather than in the panel, and that is deliberate: the panel
   * is keyed per issue and remounts every time you open a different one, so a mode
   * held down there would silently collapse back to `drawer` on every navigation.
   * It is a preference about how you are working, not a property of the ticket.
   */
  const [mode, setMode] = useState<DetailMode>(() => loadMode(safeStorage()));
  const toggleMode = useCallback(() => {
    setMode((current) => {
      const next = otherMode(current);
      saveMode(safeStorage(), next);
      return next;
    });
  }, []);

  /**
   * `useResource` requires a handler, and this one deliberately does almost nothing.
   * lib/api.ts already broadcasts every AuthError on `staple:auth-error` precisely so
   * that a component catching one locally cannot swallow it, and App.tsx listens on
   * that channel — so the token screen is already on its way by the time this runs.
   * Re-dispatching here would set the same state twice for one failure. What this
   * DOES buy is stopping the resource from retrying against a credential that is
   * known bad, which is the contract the hook is asking for.
   */
  const onAuthError = useCallback((_error: AuthError) => {
    /* handled by App.tsx, over the window channel api.ts broadcasts on */
  }, []);

  return (
    <DialogPrimitive.Root
      open={selection !== null}
      onOpenChange={(open) => {
        // One-way. The overlay is opened by `session.open()` from a row, a chip, a
        // graph node or the palette — never by this component — so the only
        // transition it reports is the close, and `session.close()` is the single
        // place selection is cleared.
        if (!open) session.close();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-mode={mode} className="staple-detail-scrim" />

        <DialogPrimitive.Content
          data-mode={mode}
          data-detail-overlay=""
          // Radix warns when a dialog has no description. There is nothing here that
          // would honestly serve as one — the panel's content IS the description —
          // so the association is explicitly declined rather than filled with a
          // sentence invented for the linter.
          aria-describedby={undefined}
          className={cn(
            "staple-detail-panel bg-card text-foreground fixed z-50 flex flex-col overflow-hidden shadow-xl outline-none",
            PANEL_CLASS[mode],
          )}
          /**
           * Radix's default sends focus to the first tabbable thing, which here is
           * the expand button — so opening a ticket would put a focus ring on
           * "expand" and leave a screen reader announcing it before the issue. Focus
           * goes to the panel itself instead: the dialog's own label is read, the
           * whole panel is the reading context, and Tab from there walks the content
           * in order.
           */
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
          }}
          /**
           * ESC BELONGS TO THE INNERMOST THING THAT CAN USE IT.
           *
           * This panel is full of fields that already treat Escape as "cancel what I
           * am typing": the inline title editor reverts its draft, the label composer
           * drops the chip it was about to add. Those handlers call preventDefault(),
           * which does nothing to Radix — it listens on the document — so without
           * this, one Escape while renaming would cancel the rename AND close the
           * drawer, throwing away the panel the user was mid-edit in.
           *
           * So: inside a field, Escape is the field's. Anywhere else, it closes.
           * That is what Linear does and what anyone who has typed in a modal
           * expects; it is only a special case because Radix cannot know which of
           * its descendants are editors.
           */
          onEscapeKeyDown={(event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (
              target.tagName === "INPUT" ||
              target.tagName === "TEXTAREA" ||
              target.isContentEditable
            ) {
              event.preventDefault();
            }
          }}
        >
          {/*
            The accessible name, present from the first frame. It is the identifier
            rather than the title because the title is not known until the fetch
            lands, and a dialog whose name arrives a beat after it opens is a dialog
            that gets announced as "dialog". The human title is the <h2> immediately
            inside, which is the next thing read either way.
          */}
          <VisuallyHidden.Root asChild>
            <DialogPrimitive.Title>{selection?.ref ?? "Issue detail"}</DialogPrimitive.Title>
          </VisuallyHidden.Root>

          {selection ? (
            <IssueDetailPanel
              // Keyed by the selected issue: tab state like a half-picked status, an
              // armed restore, or a document key must not survive an issue switch.
              // Opening a blocker chip from inside the panel is a real navigation and
              // has to arrive at a clean panel — while the mode, held above this
              // boundary, correctly does not reset.
              key={`${selection.workspace}:${selection.ref}`}
              selection={selection}
              mode={mode}
              onToggleMode={toggleMode}
              onClose={session.close}
              onAuthError={onAuthError}
            />
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
