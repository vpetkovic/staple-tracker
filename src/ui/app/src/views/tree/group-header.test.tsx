/**
 * O3d (STA-129) — what a GROUP HEADER actually puts in the DOM, on all three axes.
 *
 * Rendered to a string with `react-dom/server`, the same way `row-render.test.tsx` renders a
 * row and for the same reason: every claim below is about which elements exist and what
 * their accessible names say, not about layout.
 *
 * WHY A HEADER TEST EXISTS NOW AND DID NOT BEFORE. While a header was a status, its content
 * was a lookup in a frozen record — there was nothing to get wrong that the type did not
 * already catch. Two things changed on the same branch:
 *
 *   1. O7b's wiring replaced `STATUS_LABEL[key]` with `statusLabel(key)`. The record is a
 *      `Record<IssueStatus, string>` over the built-in seven, so a workspace's own status
 *      rendered `undefined` INTO THE PAGE. That is the exact bug STA-141's browser pass
 *      caught in a different file, and this is the assertion that stops it here.
 *   2. O3d made the header's content come from the MODEL (`StatusGroup.heading`) rather than
 *      from the key, and made the branch depend on that field's presence. A heading dropped
 *      on the way through TreeGrid would degrade silently to a status-shaped header showing
 *      a title-cased issue id — which looks like a header, and is nonsense.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { claim, row } from "@/components/task-list/fixtures";
import type { IssueRow } from "@/lib/types";
import { TreeGrid } from "./TreeGrid";
import { NO_PARENT_GROUP_KEY } from "./tree-model";

function renderTree(rows: IssueRow[], groupBy: "status" | "parent" | "pickup"): string {
  return renderToStaticMarkup(
    <TreeGrid
      rows={rows}
      allRows={rows}
      mode="workspace"
      groupBy={groupBy}
      currentRef={null}
      showResolved
      onOpen={() => {}}
      onCloseDrawer={() => {}}
      onVisibleOrder={() => {}}
    />,
  );
}

/**
 * The one header whose `data-status` is `key`, as a substring of the markup.
 *
 * Anchored on `data-testid="group-header"` and not on `data-status` alone: ROWS carry a
 * `data-status` too, and a status group's key is a status, so the naive search finds the
 * first row of the group instead of the header above it. That is a trap worth leaving a
 * note about — it is how this helper was wrong the first time.
 */
function header(markup: string, key: string): string {
  const at = markup.indexOf(`data-testid="group-header" data-status="${key}"`);
  expect(at, `no header for ${key}`).toBeGreaterThan(-1);
  // Up to the end of the header's own cell — far enough to hold the glyph, the prefix, the
  // name and the count, and no further.
  return markup.slice(at, markup.indexOf("</div>", markup.indexOf("staple-group-count", at)));
}

const EPIC = row({ identifier: "STA-1", kind: "epic", title: "Tree ordering", status: "backlog" });
const CHILD_DONE = row({ identifier: "STA-2", parentId: "id-1", status: "done" });
const CHILD_OPEN = row({ identifier: "STA-3", parentId: "id-1", status: "in_progress" }, claim());
const LONER = row({ identifier: "STA-4", status: "todo" });

/**
 * O8d (STA-152) — THE EPIC GROUP HAS NO HEADER. Its head is the epic's own row.
 *
 * O3d's header carried a triangle, a click-to-fold, a collapsed-groups key, a label, a kind
 * glyph and a rollup — six things the epic's ROW already has, drawn eight pixels above it
 * and behaving differently from it in every other view. This block is what stops that
 * coming back: the assertions are about the ROW now, and about the ABSENCE of the header.
 */
describe("the epic group", () => {
  const markup = renderTree([EPIC, CHILD_DONE, CHILD_OPEN, LONER], "parent");

  /** The epic's own row, as a slice of markup — anchored on the row testid, not the header. */
  function epicRow(): string {
    const at = markup.indexOf('data-testid="task-row" data-identifier="STA-1"');
    expect(at, "no row for STA-1").toBeGreaterThan(-1);
    return markup.slice(at, markup.indexOf('data-testid="task-row"', at + 20));
  }

  it("draws NO group header for the epic — the rowgroup says so", () => {
    expect(markup).not.toContain('data-testid="group-header" data-status="id-1"');
    // The rowgroup still carries the key, so a test or a script can still address the group.
    expect(markup).toContain('data-group-key="id-1"');
    expect(markup).toContain('data-headed-by-row="true"');
  });

  it("draws the epic as a real row at depth 0, with the identifier, title and kind glyph", () => {
    const epic = epicRow();

    expect(epic).toContain('aria-level="1"');
    expect(epic).toContain(">STA-1<");
    expect(epic).toContain(">Tree ordering<");
    // The SHARED glyph, from `TaskRowLine`'s identifier cluster — the same element every
    // other row in the app draws, rather than the header's private copy of the idea.
    expect(epic).toContain('data-issue-kind="epic"');
    expect(epic).not.toContain("staple-group-triangle");
  });

  it("gives the epic row the ordinary chevron and the ordinary rollup", () => {
    const epic = epicRow();

    // The standard disclosure button, labelled as every other parent's is — this is the
    // fold, and there is no second one.
    expect(epic).toContain("Collapse STA-1");
    expect(epic).toContain('aria-expanded="true"');
    // One of the two descendants is done, so the rollup reads 1/2 — on the row, through
    // `ParentRollup`, exactly as it does in the flat view.
    expect(epic).toContain('data-testid="parent-rollup"');
    expect(epic).toContain("1/2");
  });

  it("keeps the epic in the rows it heads, drawn once, with the family nested under it", () => {
    expect(markup).toContain('data-identifier="STA-1"');
    expect(markup).toContain('data-identifier="STA-2"');
    expect(markup).toContain('data-identifier="STA-3"');
    // Once, not twice: no header copy and no second row in the catch-all.
    expect(markup.split('data-identifier="STA-1"')).toHaveLength(2);
  });

  it("gives the catch-all a header with no identifier, no glyph kind and no rollup", () => {
    const orphans = header(markup, NO_PARENT_GROUP_KEY);

    // O8d: "No epic" NAMES NO ISSUE, so there is no row it could become. It keeps the plain
    // header and keeps folding as a group, which is the whole reason this case is separate.
    expect(orphans).toContain(">No epic<");
    expect(orphans).toContain('data-issue-kind="none"');
    expect(orphans).not.toContain(">STA-4<");
    // No rollup, so the trailing slot falls back to the count it was always meant to show.
    expect(orphans).toContain('staple-group-count">1<');
  });
});

describe("the status header, unchanged by the widening", () => {
  const markup = renderTree([EPIC, CHILD_DONE, CHILD_OPEN, LONER], "status");

  it("still resolves its label from the status vocabulary, not from a heading", () => {
    // O7b's substitution. `statusLabel("in_progress")` and `STATUS_LABEL.in_progress` are
    // the same string on a default workspace, which is what makes it a wiring change.
    expect(header(markup, "in_progress")).toContain(">In Progress<");
    expect(header(markup, "backlog")).toContain(">Backlog<");
  });

  it("still shows a bare count and no identifier prefix", () => {
    const backlog = header(markup, "backlog");

    expect(backlog).toContain('staple-group-count">1<');
    expect(backlog).not.toContain(">STA-1<");
    expect(backlog).not.toContain("data-issue-kind=");
  });

  it("keeps the plain accessible name it has always had", () => {
    expect(markup).toContain('aria-label="Backlog, 1 task"');
  });
});
