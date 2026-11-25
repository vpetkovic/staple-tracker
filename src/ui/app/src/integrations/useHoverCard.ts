import { useEffect, useRef, useState } from "react";

const OPEN_DELAY = 200;
const CLOSE_DELAY = 180;

/**
 * A card that opens on mouse hover or keyboard focus of its trigger after a short delay,
 * stays open while the pointer or focus is inside trigger or card, and closes shortly after
 * both leave. A click or tap pins it open (the only way it opens on touch) and a second one
 * closes it; Escape and an outside click close it through the popover's `onOpenChange`.
 */
export function useHoverCard() {
  const [open, setOpenState] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const pointerInside = useRef(false);
  /** Focus handed back to the trigger on Escape must not reopen the card. */
  const quietFocus = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const focusInside = () => {
    const active = document.activeElement;
    return active === trigger.current || Boolean(content.current?.contains(active));
  };
  const setOpen = (next: boolean) => {
    clearTimeout(timer.current);
    if (!next) pinned.current = false;
    setOpenState(next);
  };
  const enter = () => {
    clearTimeout(timer.current);
    if (!open) timer.current = setTimeout(() => setOpenState(true), OPEN_DELAY);
  };
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!pinned.current && !pointerInside.current && !focusInside()) setOpenState(false);
    }, CLOSE_DELAY);
  };
  const focusFirst = () =>
    requestAnimationFrame(() => content.current?.querySelector<HTMLElement>("a, button:not(:disabled)")?.focus());

  const pointer = {
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      pointerInside.current = true;
      enter();
    },
    onPointerLeave: (event: React.PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      pointerInside.current = false;
      leave();
    },
  };

  const triggerProps = {
    ref: trigger,
    ...pointer,
    onFocus: (event: React.FocusEvent<HTMLButtonElement>) => {
      if (quietFocus.current) {
        quietFocus.current = false;
        return;
      }
      // A click or tap focuses the button too; only keyboard focus opens on its own.
      if (focusVisible(event.currentTarget)) enter();
    },
    onBlur: leave,
    onClick: (event: React.MouseEvent) => {
      // The trigger toggles nothing by itself, and the row or panel behind it never sees the click.
      event.preventDefault();
      event.stopPropagation();
      if (pinned.current) return setOpen(false);
      pinned.current = true;
      setOpen(true);
      // Enter or Space (a click with no pointer): take the keyboard into the card.
      if (event.detail === 0) focusFirst();
    },
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
    onKeyDown: (event: React.KeyboardEvent) => {
      // A closed card's Escape belongs to the panel behind it (the popover has already
      // handled an open card's Escape in its own capture listener).
      if (event.key === "Escape" && !open) return;
      event.stopPropagation();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setOpen(true);
        focusFirst();
      }
    },
  };

  const contentProps = {
    ref: content,
    ...pointer,
    onFocusCapture: () => clearTimeout(timer.current),
    onBlurCapture: leave,
    onClick: (event: React.MouseEvent) => event.stopPropagation(),
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
    onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
    onOpenAutoFocus: (event: Event) => event.preventDefault(),
    onCloseAutoFocus: (event: Event) => event.preventDefault(),
    onEscapeKeyDown: () => {
      if (!content.current?.contains(document.activeElement)) return;
      quietFocus.current = true;
      trigger.current?.focus();
    },
  };

  return { open, setOpen, triggerProps, contentProps };
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}
