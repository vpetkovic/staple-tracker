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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive, VisuallyHidden } from "radix-ui";
import { RunStopNotices } from "@/components/autopilot/RunStopNotices";
import type { AuthError } from "@/lib/api";
import {
  afterHistorySettles,
  leaveOverlays,
  overlayEntryIsOpen,
  popOverlay,
  pushOverlayEntry,
  replaceUrl,
  traversalKind,
  whenHistoryIsFree,
} from "@/lib/back-to-close";
import { issueHistoryStep, readIssueUrl, resolveIssueWorkspace, sameIssue, withIssue } from "@/lib/issue-url";
import { isTyping } from "@/lib/keyboard";
import { useSession, type Selection, type StapleSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { loadMode, otherMode, panelClass, presentationFor, saveMode, SHEET_BELOW, type DetailMode } from "./drawer";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { focusRow } from "./focus-return";
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

/**
 * The viewport width as the sheet rule sees it: below `SHEET_BELOW` or not. Asked through
 * `matchMedia` and kept live, so rotating a tablet moves between sheet and drawer.
 */
function readViewportWidth(): number {
  const narrow =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(`(max-width: ${SHEET_BELOW - 1}px)`).matches;
  return narrow ? 0 : Number.POSITIVE_INFINITY;
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(readViewportWidth);
  useEffect(() => {
    const onResize = () => setWidth(readViewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/**
 * THE OPEN TICKET IS IN THE ADDRESS — `?issue=STA-12` (lib/issue-url.ts).
 *
 * PHONE BACK CLOSES THE DETAIL. Opening a ticket from the page pushes ONE history entry,
 * carrying `issue`, whatever the detail goes on to show: Previous/Next and a blocker chip
 * change the selection, not whether it is open, so they rewrite that entry rather than add
 * Back steps. Back pops the entry and closes; the Back button, the X and Escape close
 * through `session.close` and this takes the entry back out.
 *
 * A LINK OPENS ITS TICKET. An address that arrives carrying `issue` — a shared link, the
 * ticket card's "Open in Staple", a reload with the detail open — opens that ticket when
 * the page starts. There is no entry of ours to pop then, so closing strips the parameter
 * in place, the way Settings closes after a deep link (SettingsMount.tsx).
 *
 * Back and Forward follow the address: an entry without `issue` closes the detail, one
 * with a different `issue` opens that ticket.
 */
function useIssueAddress(session: StapleSession): void {
  const selection = session.selection;
  const hub = session.mode === "hub";
  /** The overlay entry this pushed when the detail opened from the page, or null. */
  const entry = useRef<string | null>(null);
  /** The ticket the address was last brought in line with. */
  const shown = useRef<Selection | null>(null);
  /** The entry is queued behind a traversal (a menu closing as its Open opened this). */
  const pushing = useRef(false);
  const live = useRef(session);
  live.current = session;

  // Arrival: the address names a ticket. The mount renders only once bootstrap is in, so
  // the workspace list the ref is resolved against is already known.
  useEffect(() => {
    const request = readIssueUrl(window.location.search);
    if (request) live.current.open(resolveIssueWorkspace(request, live.current), request.ref);
  }, []);

  useEffect(() => {
    const before = shown.current;
    shown.current = selection;
    const ours = entry.current;
    const step = issueHistoryStep({
      before,
      after: selection,
      entryOpen: ours !== null && overlayEntryIsOpen(ours),
      addressHasIssue: readIssueUrl(window.location.search) !== null,
    });
    if (step === "push") {
      const opened = selection;
      pushing.current = true;
      whenHistoryIsFree(() => {
        pushing.current = false;
        // Closed again before the history was free: nothing to push.
        if (!sameIssue(shown.current, opened)) return;
        entry.current = pushOverlayEntry(withIssue(window.location.href, opened, hub));
      });
    } else if (step === "replace") {
      const showing = selection;
      afterHistorySettles(() => {
        if (!sameIssue(shown.current, showing)) return;
        const href = withIssue(window.location.href, showing, hub);
        if (href !== window.location.href) replaceUrl(href);
      });
    } else if (step === "pop") {
      entry.current = null;
      popOverlay(ours!);
    } else if (step === "strip") {
      entry.current = null;
      // Out of any overlay entries above the page first (a reload keeps their ids), then
      // the parameter goes, unless a ticket was opened again in the meantime.
      leaveOverlays(() => {
        if (shown.current === null) replaceUrl(withIssue(window.location.href, null, hub));
      });
    }
  }, [selection, hub]);

  /*
   * The page's workspace changed under an open ticket without a navigation — the address
   * named a workspace this page does not have, and the page fell back to All workspaces.
   * `issue-ws` is decided against the page's `ws`, so it is written again once the page has
   * rewritten the address (after it: `whenHistoryIsFree`), or a reload would look for the
   * ticket somewhere else.
   */
  const pageWs = session.ws;
  useEffect(() => {
    whenHistoryIsFree(() => {
      const showing = shown.current;
      // A navigation closed the ticket and took `issue` off the address: nothing to redo.
      if (!showing || readIssueUrl(window.location.search) === null) return;
      const href = withIssue(window.location.href, showing, hub);
      if (href !== window.location.href) replaceUrl(href);
    });
  }, [pageWs, hub]);

  useEffect(() => {
    const onPop = () => {
      /*
       * Not ours to read: the detail's entry is not in history yet (it waits for the
       * traversal landing now — the row menu whose Open opened it, stepping out), or an
       * overlay this page closed is stepping back to the entry beneath it. Neither is the
       * person leaving the ticket.
       */
      if (pushing.current || traversalKind() === "close") return;
      const request = readIssueUrl(window.location.search);
      const held = shown.current;
      if (request === null) {
        if (held === null) return;
        // Back took the detail's entry (or stepped past it): close, with nothing to write.
        shown.current = null;
        entry.current = null;
        live.current.close();
        return;
      }
      const target = { workspace: resolveIssueWorkspace(request, live.current), ref: request.ref };
      if (sameIssue(held, target)) return;
      // Forward onto an entry that names a ticket: open it as the address says. The entry
      // is not one this page pushed, so closing it strips in place.
      shown.current = target;
      entry.current = null;
      live.current.open(target.workspace, target.ref);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}

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
  const presentation = presentationFor(useViewportWidth(), mode);
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

  useIssueAddress(session);

  /**
   * The task the detail showed last, for focus return. Kept past the close, because the
   * close is what clears `selection` and the focus decision runs after it.
   */
  const lastRef = useRef<string | null>(null);
  if (selection) lastRef.current = selection.ref;

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
        <DialogPrimitive.Overlay data-mode={presentation} className="staple-detail-scrim" />

        <DialogPrimitive.Content
          data-mode={presentation}
          data-detail-overlay=""
          // Radix warns when a dialog has no description. There is nothing here that
          // would honestly serve as one — the panel's content IS the description —
          // so the association is explicitly declined rather than filled with a
          // sentence invented for the linter.
          aria-describedby={undefined}
          className={cn(
            "staple-detail-panel bg-card text-foreground fixed z-50 flex flex-col overflow-hidden shadow-xl outline-none",
            panelClass(presentation),
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
          /**
           * FOCUS GOES BACK TO THE ROW of the task that was showing — not to whatever held
           * focus when the detail opened (on a phone, nothing; from the row menu, its `⋯`;
           * after Previous/Next, a different task's row). See focus-return.ts.
           */
          onCloseAutoFocus={(event) => {
            if (focusRow(document, lastRef.current)) event.preventDefault();
          }}
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
            A stable accessible name, present before the detail loads. The selection
            can be an unpromoted idea's internal id, which is never a reader-facing
            label. The loaded record's title is the heading immediately inside.
          */}
          <VisuallyHidden.Root asChild>
            <DialogPrimitive.Title>Issue detail</DialogPrimitive.Title>
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
              presentation={presentation}
              onToggleMode={toggleMode}
              nav={nav}
              onNavigate={navigate}
              onClose={session.close}
              onAuthError={onAuthError}
            />
          ) : null}
          {/* A run that ended, inside the modal: in its flow and its focus order (RunStopNotices). */}
          {selection ? <RunStopNotices placement="drawer" /> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
