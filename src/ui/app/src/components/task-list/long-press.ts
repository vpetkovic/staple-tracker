/**
 * Long-press on a row opens the row's menu — the touch half of "no hover-only affordances".
 *
 * The decision is a pure state machine so it can be tested without a browser; the hook is
 * only timers and event plumbing around it.
 *
 *   down (touch or pen) → pressing, timer armed
 *   move beyond the slop → idle (it was a scroll)
 *   timer fires while pressing → fired (open the menu)
 *   the click that follows a fired press is swallowed, so the row does not ALSO open the
 *   detail behind the menu
 *
 * A mouse never long-presses: desktop has the `⋯` on hover and focus, and a held left button
 * is the start of a text selection or a drag.
 */
import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

export const LONG_PRESS_MS = 450;
/** Finger travel, in CSS px, past which a press is a scroll and not a hold. */
export const LONG_PRESS_SLOP = 8;

export type PressState =
  | { kind: "idle" }
  | { kind: "pressing"; x: number; y: number }
  | { kind: "fired" };

export type PressEvent =
  | { type: "down"; pointerType: string; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "up" }
  | { type: "timer" }
  | { type: "click" };

export const IDLE: PressState = { kind: "idle" };

export function pressStep(state: PressState, event: PressEvent): PressState {
  switch (event.type) {
    case "down":
      return event.pointerType === "mouse" ? IDLE : { kind: "pressing", x: event.x, y: event.y };
    case "move":
      if (state.kind !== "pressing") return state;
      return Math.hypot(event.x - state.x, event.y - state.y) > LONG_PRESS_SLOP ? IDLE : state;
    case "timer":
      return state.kind === "pressing" ? { kind: "fired" } : state;
    case "up":
      // A fired press survives its own pointerup: the click that follows must still be
      // swallowed, and it arrives after the up.
      return state.kind === "fired" ? state : IDLE;
    case "click":
      return IDLE;
  }
}

/** Should this click be swallowed? Only the one that ends a long-press. */
export function swallowsClick(state: PressState): boolean {
  return state.kind === "fired";
}

export interface LongPressHandlers {
  onPointerDown?: (event: PointerEvent) => void;
  onPointerMove?: (event: PointerEvent) => void;
  onPointerEnd?: (event: PointerEvent) => void;
  onClickCapture?: (event: MouseEvent) => void;
  onContextMenu?: (event: MouseEvent) => void;
}

/** Handlers for the row, or none at all when there is nothing to open. */
export function useLongPress(onLongPress: (() => void) | null): LongPressHandlers {
  const state = useRef<PressState>(IDLE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clear, [clear]);

  const step = useCallback(
    (event: PressEvent) => {
      const next = pressStep(state.current, event);
      if (next.kind !== "pressing") clear();
      if (next.kind === "fired" && state.current.kind === "pressing") callback.current?.();
      state.current = next;
    },
    [clear],
  );

  if (!onLongPress) return {};
  return {
    onPointerDown: (event) => {
      // A press that starts on a control inside the row (chevron, badge, `⋯`) belongs to
      // that control.
      if ((event.target as Element | null)?.closest?.("button, a, input")) return;
      step({ type: "down", pointerType: event.pointerType, x: event.clientX, y: event.clientY });
      if (state.current.kind === "pressing") timer.current = setTimeout(() => step({ type: "timer" }), LONG_PRESS_MS);
    },
    onPointerMove: (event) => step({ type: "move", x: event.clientX, y: event.clientY }),
    onPointerEnd: () => step({ type: "up" }),
    onClickCapture: (event) => {
      if (swallowsClick(state.current)) {
        event.preventDefault();
        event.stopPropagation();
      }
      step({ type: "click" });
    },
    onContextMenu: (event) => {
      // Android raises a context menu for the same hold; the row's menu is the answer to it.
      if (state.current.kind !== "idle") event.preventDefault();
    },
  };
}
