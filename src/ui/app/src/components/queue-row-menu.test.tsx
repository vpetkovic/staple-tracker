/**
 * The row `⋯` menu — what it may offer for a row, and what it must refuse.
 *
 * ── WHAT IS TESTED HERE AND WHAT DELIBERATELY IS NOT ──────────────────────────────────
 *
 * `vitest.config.ts` has no jsdom environment, on purpose ("DELIBERATELY NOT HERE"), so a
 * portalled menu cannot be opened in this suite. That is the right split rather than a gap:
 * opening on click, closing on Escape, the roving focus between items and `aria-disabled`
 * are RADIX's contract, exercised against a real browser, and re-asserting them here would
 * be testing a dependency through two layers of our own markup.
 *
 * The same split covers the portal-propagation guard on `DropdownMenuContent`: React portals
 * bubble through the COMPONENT tree, so a menu click used to reach `TaskRowLine`'s `onClick`
 * and open the drawer alongside the action. There is no jsdom here to open a portal in, so
 * that one is browser-verified — by mouse and by keyboard, checking both that the drawer
 * stays shut on an action AND that "Open details" still opens it. A static-markup test could
 * only assert that a closed menu renders nothing, which would be a name promising more than
 * the assertion checks.
 *
 * What IS ours is the decision — which items a row gets, and when removal must be refused —
 * and it is a pure function, so it is pinned here directly. The static markup below then
 * proves the one wiring fact that a browser check would find hardest to see: the trigger the
 * row hands over is the one that ends up in the menu, carrying the accessible name.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { row } from "@/components/task-list/fixtures";
import { QueueRowMenu, queueRowMenuState } from "./QueueRowMenu";

/** The plan's identifiers, as `TreeView` builds them once per fetch. */
const planned = new Set(["STA-66"]);

describe("what the menu may offer for a row", () => {
  it("offers the ADD items for a row nobody has queued", () => {
    const state = queueRowMenuState(row({ identifier: "STA-146" }), planned);
    expect(state.queued).toBe(false);
    expect(state.heldBy).toBeNull();
  });

  it("calls a row queued only when it is a PLAN ENTRY of its own", () => {
    expect(queueRowMenuState(row({ identifier: "STA-66" }), planned).queued).toBe(true);
    /*
     * A row that is only in the EFFECTIVE order — reached because an ancestor was queued —
     * is not queued in the sense "remove from queue" means. There is no entry to remove, and
     * dequeuing the ancestor is a far larger act than the item implies. It gets the add
     * items, which is exactly how you pull one child in front of its siblings.
     */
    expect(queueRowMenuState(row({ identifier: "STA-67" }), planned).queued).toBe(false);
  });

  it("refuses removal once the work has started, and names who has it", () => {
    const held = queueRowMenuState(
      row({ identifier: "STA-66", status: "in_progress", checkoutAgent: "codex-1" }),
      planned,
    );
    expect(held.heldBy).toBe("codex-1");
  });

  it("still refuses when the holder is anonymous, rather than offering a doomed write", () => {
    const held = queueRowMenuState(row({ identifier: "STA-66", status: "in_progress" }), planned);
    expect(held.heldBy).toBe("someone");
  });

  it("does not call a row held merely for being unfinished", () => {
    for (const status of ["backlog", "todo", "blocked", "done"] as const) {
      expect(queueRowMenuState(row({ identifier: "STA-66", status }), planned).heldBy).toBeNull();
    }
  });

  it("says nothing is queued when the plan has not loaded, rather than guessing", () => {
    expect(queueRowMenuState(row({ identifier: "STA-66" }), new Set()).queued).toBe(false);
  });
});

describe("the trigger the row hands over", () => {
  it("is the element the menu opens from, accessible name and all", () => {
    const source = row({ identifier: "STA-146" });
    const html = renderToStaticMarkup(
      <QueueRowMenu
        trigger={
          <button type="button" className="staple-row-actions" aria-label="Actions for STA-146" />
        }
        identifier="STA-146"
        state={queueRowMenuState(source, planned)}
        disabled={false}
        onOpen={() => {}}
        onQueueNext={() => {}}
        onQueueLast={() => {}}
        onDequeue={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Actions for STA-146"');
    expect(html).toContain("staple-row-actions");
    // Closed is closed: the items are absent from the document, not hidden in it.
    expect(html).not.toContain("Queue next");
  });
});
