/**
 * The order of history writes around a navigation that first steps back past open overlays
 * (lib/back-to-close.ts). The suite has no DOM, so `window` is a small fake whose `go()`
 * lands a tick later, as a browser's does; the timing that decides the order is set here
 * rather than left to how busy the machine is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Entry = { url: string; state: unknown };
type Listener = () => void;

/** How long a traversal takes to land: a timer's delay, or before the next timer runs at all. */
type Lag = number | "before-next-timer";

function fakeWindow(start: string, lag: Lag = 20) {
  const origin = "http://localhost";
  const entries: Entry[] = [{ url: origin + start, state: null }];
  let index = 0;
  const capture: Listener[] = [];
  const bubble: Listener[] = [];
  const abs = (url: string | URL | null | undefined) => (url == null ? entries[index]!.url : new URL(String(url), origin).href);
  const history = {
    get state() {
      return entries[index]!.state;
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown, _title: string, url?: string | URL | null) {
      entries.splice(index + 1);
      entries.push({ url: abs(url), state });
      index += 1;
    },
    replaceState(state: unknown, _title: string, url?: string | URL | null) {
      entries[index] = { url: abs(url), state };
    },
    go(delta = 0) {
      // A traversal is asynchronous: the entry stays current until the browser gets to it.
      const land = () => {
        const target = index + delta;
        if (target < 0 || target >= entries.length) return;
        index = target;
        for (const fn of [...capture, ...bubble]) fn();
      };
      if (lag === "before-next-timer") queueMicrotask(land);
      else setTimeout(land, lag);
    },
    back() {
      history.go(-1);
    },
  };
  const win = {
    history,
    location: {
      get href() {
        return entries[index]!.url;
      },
    },
    addEventListener(type: string, fn: Listener, options?: boolean | AddEventListenerOptions) {
      if (type !== "popstate") return;
      const useCapture = typeof options === "boolean" ? options : options?.capture === true;
      (useCapture ? capture : bubble).push(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      if (type !== "popstate") return;
      for (const list of [capture, bubble]) {
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      }
    },
  };
  const pages = () => entries.map((entry) => entry.url.slice(origin.length));
  return { win, pages, current: () => index };
}

let fake: ReturnType<typeof fakeWindow>;
let lib: typeof import("./back-to-close");

/** A fresh module (its queue is module state) over a fresh history at Tasks. */
async function setup(lag?: Lag) {
  vi.resetModules();
  fake = fakeWindow("/?view=tasks", lag);
  vi.stubGlobal("window", fake.win);
  lib = await import("./back-to-close");
}

beforeEach(async () => {
  vi.useFakeTimers();
  await setup();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("going to another page with overlays open", () => {
  it("pushes the new page before any write the page queued while the overlays were closing", async () => {
    // A task's drawer, and the command palette over it.
    lib.pushOverlayEntry(`${window.location.href}&issue=STA-1`);
    const palette = lib.pushOverlayEntry();
    const order: string[] = [];

    // The palette's command closes the palette (its entry is taken out) and goes to Graph,
    // which first steps back past the drawer's entry and then pushes Graph.
    lib.popOverlay(palette);
    lib.leaveOverlays(() => {
      order.push("push graph");
      lib.pushPage("/?view=graph");
    });
    // The page re-renders while the palette's entry is still being taken out and writes its
    // address again: a replace, queued behind the traversal like every write.
    lib.afterHistorySettles(() => {
      order.push("replace with the page's address");
      lib.replaceUrl("/?view=graph");
    });

    await vi.runAllTimersAsync();

    expect(order).toEqual(["push graph", "replace with the page's address"]);
    // Tasks is still there to go Back to, and nothing of the drawer or the palette is left.
    expect(fake.pages()).toEqual(["/?view=tasks", "/?view=graph"]);
    expect(fake.current()).toBe(1);
  });

  it("pushes the new page before a write asked for after the step back landed but before the queue ran", async () => {
    // The browser lands the navigation's step back before the next timer: the write the
    // page schedules for an overlay closing (App.tsx keeps its address on a "close")
    // arrives while the push is still queued, and must wait behind it.
    await setup("before-next-timer");
    const order: string[] = [];
    window.addEventListener("popstate", () => {
      if (lib.traversalKind() !== "close") return;
      lib.whenHistoryIsFree(() => {
        order.push("keep the page's address");
        lib.replaceUrl("/?view=graph");
      });
    });
    lib.pushOverlayEntry(`${window.location.href}&issue=STA-1`);
    const palette = lib.pushOverlayEntry();

    lib.popOverlay(palette);
    lib.leaveOverlays(() => {
      order.push("push graph");
      lib.pushPage("/?view=graph");
    });

    await vi.runAllTimersAsync();

    expect(order).toEqual(["push graph", "keep the page's address"]);
    expect(fake.pages()).toEqual(["/?view=tasks", "/?view=graph"]);
    expect(fake.current()).toBe(1);
  });

  it("keeps running the queue after a write in it throws", async () => {
    const drawer = lib.pushOverlayEntry();
    const order: string[] = [];
    lib.popOverlay(drawer);
    lib.afterHistorySettles(() => {
      throw new Error("a write failed");
    });
    lib.afterHistorySettles(() => order.push("next write"));
    await expect(vi.runAllTimersAsync()).rejects.toThrow("a write failed");
    await vi.runAllTimersAsync();
    expect(order).toEqual(["next write"]);
    lib.afterHistorySettles(() => order.push("a later write runs at once"));
    expect(order).toEqual(["next write", "a later write runs at once"]);
  });

  it("pushes at once when no overlay is open", async () => {
    const order: string[] = [];
    lib.leaveOverlays(() => order.push("push"));
    lib.afterHistorySettles(() => order.push("write"));
    expect(order).toEqual(["push", "write"]);
    await vi.runAllTimersAsync();
    expect(order).toEqual(["push", "write"]);
  });

  it("keeps the order of writes queued before the navigation was asked for", async () => {
    const drawer = lib.pushOverlayEntry();
    const order: string[] = [];
    lib.popOverlay(drawer);
    lib.afterHistorySettles(() => order.push("earlier write"));
    lib.leaveOverlays(() => order.push("push"));
    lib.afterHistorySettles(() => order.push("later write"));
    await vi.runAllTimersAsync();
    expect(order).toEqual(["earlier write", "push", "later write"]);
  });
});
