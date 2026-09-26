/**
 * Phone Back closes the detail and the row menus — lane B's half of "Back closes what is
 * open on top" (lib/back-to-close.ts).
 *
 * The suite has no DOM (vitest.config.ts: "DELIBERATELY NOT HERE"), so the history itself is
 * exercised in the browser (lane A's Playwright Back tests, and the evidence scripts in the
 * PR). What is pinned here is the WIRING, which is ours: each overlay hands the hook its real
 * open state, and the close the hook calls is the overlay's real close. The hook is replaced
 * by a recorder for that; a render calls it synchronously, so a static render is enough.
 *
 * Focus return is a pure lookup (focus-return.ts) and is pinned against a stub document.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionContext, type Selection } from "@/lib/session";
import { row } from "@/components/task-list/fixtures";
import { fakeSession } from "@/views/fake-session";

const calls: Array<{ open: boolean; close: () => void }> = [];
vi.mock("@/lib/back-to-close", () => ({
  useBackToClose: (open: boolean, close: () => void) => {
    calls.push({ open, close });
  },
}));

const { IssueDetailMount } = await import("./IssueDetailMount");
const { QueueRowMenu, queueRowMenuState } = await import("@/components/QueueRowMenu");
const { focusRow, rowSelector } = await import("./focus-return");

beforeEach(() => {
  calls.length = 0;
});

function renderMount(selection: Selection | null, close: () => void): void {
  renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession({ selection, close })}>
      <IssueDetailMount />
    </SessionContext.Provider>,
  );
}

describe("the detail sheet holds one Back step while it is open", () => {
  it("asks for a Back step exactly when a task is open, and Back closes it through session.close", () => {
    let closed = 0;
    renderMount({ workspace: "staple", ref: "STA-60" }, () => closed++);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.open).toBe(true);
    calls[0]!.close();
    expect(closed).toBe(1);
  });

  it("holds none when nothing is open", () => {
    renderMount(null, () => {});
    expect(calls.map((call) => call.open)).toEqual([false]);
  });
});

describe("the row menu holds one Back step while it is open", () => {
  const menu = (over: { open?: boolean; onOpenChange?: (open: boolean) => void }) =>
    renderToStaticMarkup(
      <QueueRowMenu
        trigger={<button type="button">⋯</button>}
        identifier="STA-1"
        state={queueRowMenuState(row({ identifier: "STA-1" }), new Set())}
        disabled={false}
        onOpen={() => {}}
        onQueueNext={() => {}}
        onQueueLast={() => {}}
        onDequeue={() => {}}
        {...over}
      />,
    );

  it("follows the row's long-press state, and Back closes the menu through the row's own setter", () => {
    const changes: boolean[] = [];
    menu({ open: true, onOpenChange: (open) => changes.push(open) });
    expect(calls.map((call) => call.open)).toEqual([true]);
    calls[0]!.close();
    expect(changes).toEqual([false]);
  });

  it("holds none while closed, including when the menu keeps its own state", () => {
    menu({ open: false, onOpenChange: () => {} });
    menu({});
    expect(calls.map((call) => call.open)).toEqual([false, false]);
  });
});

describe("focus returns to the row of the task that was showing", () => {
  function stubDocument(rows: Record<string, { focusable: boolean }>) {
    const root = {
      activeElement: null as unknown,
      asked: [] as string[],
      querySelector(selector: string) {
        root.asked.push(selector);
        const id = /data-identifier="([^"]+)"/.exec(selector)?.[1] ?? "";
        const found = rows[id];
        if (!found || !selector.includes(":not([data-ghost])")) return null;
        const element = {
          focus: () => {
            if (found.focusable) root.activeElement = element;
          },
        };
        return element;
      },
    };
    return root;
  }

  it("focuses the row and tells the dialog not to restore its own element", () => {
    const doc = stubDocument({ "STA-83": { focusable: true } });
    expect(focusRow(doc, "STA-83")).toBe(true);
    expect(doc.activeElement).not.toBeNull();
  });

  it("never picks the dimmed parent-for-context copy of the row", () => {
    expect(rowSelector("STA-1")).toBe('[data-testid="task-row"][data-identifier="STA-1"]:not([data-ghost])');
  });

  it("leaves the dialog's default when the row is not on screen or cannot take focus", () => {
    expect(focusRow(stubDocument({}), "STA-9")).toBe(false);
    expect(focusRow(stubDocument({ "STA-9": { focusable: false } }), "STA-9")).toBe(false);
    expect(focusRow(stubDocument({ "STA-9": { focusable: true } }), null)).toBe(false);
  });

  it("escapes an identifier that would break out of the attribute selector", () => {
    expect(rowSelector('A"B')).toContain('data-identifier="A\\"B"');
  });
});

afterEach(() => {
  vi.useRealTimers();
});
