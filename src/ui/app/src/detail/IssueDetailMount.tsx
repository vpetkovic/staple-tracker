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
 * negotiating for space, "and it can also be the entire screen" costs one extra
 * class list rather than a second layout.
 *
 * WHY THE EXPANDED MODE IS STILL A DIALOG WHEN IT LOOKS LIKE A PAGE. R3 (STA-104)
 * made `full` edge-to-edge with no visible scrim, which is a fair description of a
 * route. It is deliberately NOT one. A route would need the list's scroll position,
 * filter state and expansion state to survive a round trip, plus a URL scheme, plus
 * an answer for what the back button does mid-edit — to arrive at a screen that
 * already behaves correctly. What page-mode actually needed from us was geometry,
 * and geometry is a class list. Esc, the focus trap, focus RESTORE to the row you
 * came from, `aria-modal` and the scroll lock keep working precisely because this
 * is still a dialog underneath, and every one of them is right for this screen.
 * See drawer.ts's `panelClass` for the frame argument in full.
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
import { useCallback, useMemo, useState } from "react";
import { Dialog as DialogPrimitive, VisuallyHidden } from "radix-ui";
import type { AuthError } from "@/lib/api";
import { isTyping } from "@/lib/keyboard";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { loadMode, otherMode, panelClass, saveMode, type DetailMode } from "./drawer";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { neighbours, type NavTarget } from "./navigation";
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
 * "Is this event coming out of somewhere the user is TYPING?" is `isTyping` from
 * lib/keyboard.ts — the same answer the create shortcut and the rail's shortcuts use,
 * so no two surfaces can disagree about it (it counts a SELECT, which a local copy here
 * once did not). The panel contains an inline title editor, a label composer and a
 * comment box; a hotkey that fires while one of them has the caret is not a hotkey, it
 * is data loss with a keyboard shortcut.
 */

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

  /**
   * PREV/NEXT (R6 / STA-106). The logic is all in navigation.ts; what is here is the
   * wiring, and the one thing worth defending is where it lives. The mount already
   * holds `session` and already owns the frame-level controls (the mode toggle sits
   * next to these), so the panel keeps taking a small, explicit set of props instead
   * of learning how to find the list it is floating over.
   *
   * Two dependencies, and no more, because `session.visibleOrder` is plain data held
   * behind a value-equality guard: an unchanged list on the 1.5s poll is the SAME
   * array, so this memo sleeps through every tick that did not actually reorder
   * anything, and wakes for every one that did. That guard is the whole reason this
   * can be an ordinary derivation — the first cut of this ticket had to read the
   * rendered treegrid during render, and depend on `session.version` to know when to
   * bother, because there was no published order to depend on instead.
   */
  const nav = useMemo(
    () => neighbours(session.visibleOrder, selection),
    [session.visibleOrder, selection],
  );

  const navigate = useCallback(
    (target: NavTarget | null) => {
      // `session.open()` is the single navigation primitive, and using it is what
      // makes the list highlight follow for free: TreeView passes
      // `currentRef={selection?.ref}` down to the rows, which render `aria-current`.
      // The dialog is never closed and reopened — only its selection changes.
      if (target) session.open(target.workspace, target.ref);
    },
    [session],
  );

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
            panelClass(mode),
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
            if (isTyping(event.target)) event.preventDefault();
          }}
          /**
           * PREV/NEXT FROM THE KEYBOARD (R6 / STA-106).
           *
           * `J` / `K` — next and previous. Linear's binding for exactly this, and
           * vim's before it, which is most of the argument: the people who will use a
           * hotkey to page through tickets are the people who already have these two
           * in their hands.
           *
           * `Alt+ArrowDown` / `Alt+ArrowUp` for everyone else, because a letter key
           * is not discoverable and the arrows are.
           *
           * WHAT IS DELIBERATELY NOT BOUND: bare ArrowUp/ArrowDown. This panel has one
           * scroll container and can hold a thousand-row activity timeline; taking the
           * arrow keys away from scrolling to save a modifier would break the panel's
           * most ordinary interaction to speed up one of its rarest. The modifier is
           * cheap and scrolling is not.
           *
           * The listener sits on Content rather than on the document because Radix
           * traps focus inside it — everything the user can type while the panel is
           * open bubbles through here, and nothing else does, so there is no global
           * listener to install, scope or tear down.
           */
          onKeyDown={(event) => {
            if (event.metaKey || event.ctrlKey) return;
            if (isTyping(event.target)) return;

            const alt = event.altKey;
            const key = event.key;
            const wantsNext = (!alt && key === "j") || (alt && key === "ArrowDown");
            const wantsPrev = (!alt && key === "k") || (alt && key === "ArrowUp");
            if (!wantsNext && !wantsPrev) return;

            const target = wantsNext ? nav.next : nav.prev;
            // Swallow the key even at the ends of the list. Letting a bare `j` fall
            // through to the page would type it into whatever the app decides to do
            // with a loose keystroke, and "the shortcut did nothing because you are
            // at the bottom" is a better outcome than "the shortcut did something
            // else because you are at the bottom".
            event.preventDefault();
            navigate(target);
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
              nav={nav}
              onNavigate={navigate}
              onClose={session.close}
              onAuthError={onAuthError}
            />
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
