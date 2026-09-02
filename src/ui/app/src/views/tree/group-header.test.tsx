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

describe("the epic header", () => {
  const markup = renderTree([EPIC, CHILD_DONE, CHILD_OPEN, LONER], "parent");

  it("shows the identifier, the title and the kind glyph", () => {
    const epic = header(markup, "id-1");

    expect(epic).toContain(">STA-1<");
    expect(epic).toContain(">Tree ordering<");
    // O1c (STA-130) made the swap O1b's glyph was waiting for, and the seam moved with it:
    // the shared `KindGlyph` spells it `data-issue-kind`, because the ROW already carries
    // `data-kind` on its avatars where it means human-or-agent. One spelling app-wide is
    // the point of the rename, so this header wears the shared one rather than a private
    // alias. Still the only thing this test knows about the glyph.
    expect(epic).toContain('data-issue-kind="epic"');
  });

  it("shows resolved/total from the rollup INSTEAD of the row count", () => {
    // One of the two descendants is done, so the rollup reads 1/2. The bare count would
    // have read 2, and the two numbers answer different questions in the same corner — see
    // `GroupHeader`'s `progress`.
    const epic = header(markup, "id-1");

    expect(epic).toContain(">1/2<");
    expect(epic).not.toContain('staple-group-count">2<');
  });

  it("names both numbers in the accessible name, so nothing is lost to the eye's version", () => {
    expect(markup).toContain(
      'aria-label="STA-1, Tree ordering, 2 tasks, 1 of 2 resolved"',
    );
  });

  it("gives the catch-all a header with no identifier, no glyph kind and no rollup", () => {
    const orphans = header(markup, NO_PARENT_GROUP_KEY);

    expect(orphans).toContain(">No epic<");
    expect(orphans).toContain('data-issue-kind="none"');
    expect(orphans).not.toContain(">STA-4<");
    // No rollup, so the trailing slot falls back to the count it was always meant to show.
    expect(orphans).toContain('staple-group-count">1<');
  });

  it("puts the epic in the header and NOT in the rows beneath it", () => {
    // The model's promise, asserted where a reader would actually notice it broken.
    expect(markup).not.toContain('data-identifier="STA-1"');
    expect(markup).toContain('data-identifier="STA-2"');
    expect(markup).toContain('data-identifier="STA-3"');
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
