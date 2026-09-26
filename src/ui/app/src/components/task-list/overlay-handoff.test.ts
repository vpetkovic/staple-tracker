/**
 * "Open details" from a row menu waits for the menu's Back entry to be taken out before the
 * detail pushes its own — otherwise the browser drops the pending back and a dead Back step
 * is left under the detail (seen in the browser: history state [menu, detail] after the open).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { afterOverlayCloses, HANDOFF_FALLBACK_MS } from "./overlay-handoff";

function fakeWindow() {
  const listeners = new Set<() => void>();
  return {
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
    pop: () => [...listeners].forEach((listener) => listener()),
    listeners,
  };
}

afterEach(() => vi.useRealTimers());

describe("afterOverlayCloses", () => {
  it("does not open the next overlay until the closing one's entry is gone", () => {
    vi.useFakeTimers();
    const win = fakeWindow();
    const run = vi.fn();
    afterOverlayCloses(run, win as unknown as Window);
    expect(run).not.toHaveBeenCalled();
    win.pop();
    expect(run).toHaveBeenCalledTimes(1);
    // Once, and it stops listening: a later Back is not a second open.
    vi.advanceTimersByTime(HANDOFF_FALLBACK_MS * 2);
    win.pop();
    expect(run).toHaveBeenCalledTimes(1);
    expect(win.listeners.size).toBe(0);
  });

  it("still opens when there was no entry to take out", () => {
    vi.useFakeTimers();
    const win = fakeWindow();
    const run = vi.fn();
    afterOverlayCloses(run, win as unknown as Window);
    vi.advanceTimersByTime(HANDOFF_FALLBACK_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(win.listeners.size).toBe(0);
  });
});
