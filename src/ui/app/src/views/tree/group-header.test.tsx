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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { claim, row } from "@/components/task-list/fixtures";
import type { IssueRow } from "@/lib/types";
import { TreeGrid } from "./TreeGrid";
import { NO_PARENT_GROUP_KEY } from "./tree-model";

function renderTree(
  rows: IssueRow[],
  groupBy: "status" | "parent" | "pickup",
  allRows: IssueRow[] = rows,
): string {
  return renderToStaticMarkup(
    <TreeGrid
      rows={rows}
      allRows={allRows}
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

/**
 * R4d (STA-189) — THE RHYTHM BETWEEN EPIC SECTIONS, and why it is asserted here.
 *
 * O8d put the 8px-plus-hairline separator on `.staple-group + .staple-group[data-headed-by-row]`,
 * which separates a section whose head is a ROW from whatever precedes it — and nothing
 * else. So epic followed epic with air between them, and then "No epic", whose head is a
 * header, ran straight on from the last epic's task rows. Two rhythms on one page, and the
 * difference was which KIND of head the next section had, which is not a thing the reader
 * is looking at.
 *
 * The fix is one rule keyed on the container's `data-group-by`, matching ANY two adjacent
 * sections on the epic axis. That is a fact about the DOM shape plus a fact about the
 * stylesheet, and both are pinned below: the sections must be adjacent `.staple-group`
 * siblings with nothing between (no wrapper, no divider element), and the stylesheet must
 * carry exactly one separator rule, scoped to the axis, declared at the top level so no
 * width can re-declare it.
 *
 * NOT A SCREENSHOT. The suite renders to a string and has no browser; a pixel diff would
 * need a dependency this ticket does not own. What a screenshot would have shown — the
 * separator between every pair of sections, at any width, and no gap inside a section —
 * is the DOM sequence and the rule these assertions read directly.
 */
describe("the rhythm between epic sections — R4d (STA-189)", () => {
  /** Comments stripped, so the stylesheet's own prose about the rule cannot satisfy a test. */
  const CSS = readFileSync(
    fileURLToPath(new URL("../../components/task-list/task-list.css", import.meta.url)),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const SEPARATOR = '.staple-tree[data-group-by="parent"] .staple-group + .staple-group';
  /** Every rule whose selector puts one section next to another, as `[selector, body]`. */
  const separatorRules = CSS.split("}")
    .map((block) => block.split("{") as [string, string?])
    .filter(([selector]) => /\.staple-group\s*\+\s*\.staple-group/.test(selector));

  /** The opening tag of every section, in page order. */
  const sections = (markup: string): string[] => markup.match(/<div role="rowgroup"[^>]*>/g) ?? [];

  const rows = [EPIC, CHILD_DONE, CHILD_OPEN, LONER];
  const markup = renderTree(rows, "parent");

  it("draws every section as an adjacent `.staple-group` sibling with NOTHING between", () => {
    const opened = sections(markup);
    expect(opened).toHaveLength(2);
    for (const tag of opened) expect(tag).toContain('class="staple-group"');
    // The second section opens the instant the first closes — no divider element, no
    // wrapper, so a sibling combinator is the whole separator and the accessibility tree
    // inside the treegrid has nothing extra to explain.
    const secondAt = markup.indexOf(opened[1]!);
    expect(markup.slice(secondAt - "</div>".length, secondAt)).toBe("</div>");
  });

  it("separates sections with ONE rule, scoped to the epic axis, that ANY adjacent pair matches", () => {
    expect(markup).toContain('data-group-by="parent"');
    expect(separatorRules).toHaveLength(1);
    const [selector, body] = separatorRules[0]!;
    // Not keyed on the KIND of head. A real epic row, a ghost of a filtered-out epic and
    // the "No epic" header are all `.staple-group` siblings, and the rule must not know
    // which is which.
    expect(selector.trim()).toBe(SEPARATOR);
    expect(selector).not.toContain("data-headed-by-row");
    expect(body).toMatch(/margin-top/);
    expect(body).toMatch(/border-top/);
  });

  it("puts NO gap between an epic and its own first task — same rows container, no header between", () => {
    const epicAt = markup.indexOf('data-testid="task-row" data-identifier="STA-1"');
    const nextAt = markup.indexOf('data-testid="task-row"', epicAt + 20);
    expect(epicAt).toBeGreaterThan(-1);
    expect(nextAt).toBeGreaterThan(epicAt);
    const between = markup.slice(epicAt, nextAt);
    // The first task is the very next row: no rowgroup boundary the separator could fire
    // on, and no header. The epic's own row IS the section's head.
    expect(between).not.toContain('role="rowgroup"');
    expect(between).not.toContain("staple-group");
    expect(between).not.toContain("group-header");
    expect(markup.slice(nextAt, nextAt + 200)).toContain('aria-level="2"');
  });

  it("gives 'No epic' the same rhythm — it is the next sibling, not a special case", () => {
    const [, orphans] = sections(markup);
    expect(orphans).toContain('class="staple-group"');
    expect(orphans).toContain(`data-group-key="${NO_PARENT_GROUP_KEY}"`);
    // A headed section: exactly the one the old rule skipped.
    expect(orphans).not.toContain("data-headed-by-row");
    expect(separatorRules[0]![0]).not.toContain("data-headed-by-row");
  });

  it("gives a FILTERED-OUT epic's ghost head the same rhythm too", () => {
    // The filter removed STA-1; its children still head a group, under a ghost of it.
    const filtered = renderTree([CHILD_DONE, CHILD_OPEN, LONER], "parent", rows);
    const opened = sections(filtered);
    expect(opened).toHaveLength(2);
    expect(opened[0]).toContain('data-headed-by-row="true"');
    expect(opened[0]).toContain('class="staple-group"');
    expect(opened[1]).toContain('class="staple-group"');
    // The head is drawn, dimmed, as the section's first row.
    const ghostAt = filtered.indexOf('data-ghost="true"');
    expect(ghostAt).toBeGreaterThan(filtered.indexOf(opened[0]!));
    expect(ghostAt).toBeLessThan(filtered.indexOf(opened[1]!));
    const secondAt = filtered.indexOf(opened[1]!);
    expect(filtered.slice(secondAt - "</div>".length, secondAt)).toBe("</div>");
  });

  it("holds at every width — declared once at the top level, never re-declared under @media", () => {
    const at = CSS.indexOf(SEPARATOR);
    expect(at).toBeGreaterThan(-1);
    const before = CSS.slice(0, at);
    const depth = (before.match(/{/g)?.length ?? 0) - (before.match(/}/g)?.length ?? 0);
    expect(depth).toBe(0);
    expect(CSS.indexOf(SEPARATOR, at + 1)).toBe(-1);
  });

  it("does not reach the status axis, whose sticky headers already separate sections", () => {
    const status = renderTree(rows, "status");
    expect(status).toContain('data-group-by="status"');
    expect(status).not.toContain('data-group-by="parent"');
    // The rule is scoped to the axis attribute, so a status page — same `.staple-group`
    // siblings — is untouched by it.
    expect(separatorRules[0]![0]).toContain('[data-group-by="parent"]');
  });
});
