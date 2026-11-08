/**
 * Horizons in the task list: every row whose work belongs to a horizon wears the ◇ chip, the
 * Horizon axis sections the list by horizon in the plan's order, and the horizon filter keeps
 * the work of the horizons asked for. All three read the row's own `horizon`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HorizonCompactChip } from "@/components/task-list/RowCues";
import { rowPlan } from "@/components/task-list/row-layout";
import { placeForAxis } from "./milestone-placement";
import { TaskRowLine } from "@/components/task-list/TaskRowLine";
import { resolveTaskListConfig } from "@/components/task-list/config";
import { flatRow } from "@/components/task-list/model";
import { row } from "@/components/task-list/fixtures";
import { milestoneCueSentence, rowMilestoneCue } from "@/components/task-list/row-cues";
import { applyFilters, emptyFilters, findDimension, NO_HORIZON } from "@/lib/filters";
import type { IssueRow, RowHorizon } from "@/lib/types";
import { buildHorizonGroups, buildList, NO_HORIZON_GROUP_KEY } from "./tree-model";

const now: RowHorizon = { id: "h-now", identifier: "LAR-3", name: "Now · Beta", date: "2026-12-31", rank: 1 };
const next: RowHorizon = { id: "h-next", identifier: "LAR-4", name: "Next · v2", date: null, rank: 2 };

const on = (base: IssueRow, horizon: RowHorizon | null): IssueRow => ({ ...base, horizon });

const epic = on(row({ id: "e", identifier: "LAR-40", kind: "epic", status: "in_progress" }), now);
const task = on(row({ id: "t", identifier: "LAR-41", parentId: "e", status: "todo" }), now);
const later = on(row({ id: "l", identifier: "LAR-50", status: "todo" }), next);
const loose = on(row({ id: "x", identifier: "LAR-60", status: "todo" }), null);
const rows = [loose, later, task, epic];

describe("the ◇ horizon chip", () => {
  it("names the row's horizon, ahead of the queue's milestone cue", () => {
    expect(rowMilestoneCue({ horizon: now, cues: { pickup: null, milestone: { identifier: "LAR-9", title: "Other" } } })).toEqual({ identifier: "LAR-3", title: "Now · Beta", horizon: true });
    expect(rowMilestoneCue({ horizon: null, cues: { pickup: null, milestone: { identifier: "LAR-9", title: "Other" } } })).toEqual({ identifier: "LAR-9", title: "Other" });
    expect(rowMilestoneCue({ horizon: null, cues: null })).toBeNull();
    expect(milestoneCueSentence("LAR-3", "Now · Beta", true)).toBe("On horizon LAR-3: Now · Beta — open the horizon");
  });
});

describe("Group by Horizon", () => {
  const options = { isExpanded: () => true, showResolved: true, rollupSource: rows };

  it("sections the list by horizon in the plan's order, then No horizon, an epic and its task together", () => {
    const groups = buildHorizonGroups(rows, options);
    expect(groups.map((group) => group.status)).toEqual(["h-now", "h-next", NO_HORIZON_GROUP_KEY]);
    expect(groups.map((group) => group.heading?.label)).toEqual(["Now · Beta · Dec 31, 2026", "Next · v2", "No horizon"]);
    expect(groups.map((group) => group.heading?.identifier)).toEqual(["LAR-3", "LAR-4", null]);
    expect(groups.map((group) => group.heading?.kind)).toEqual(["milestone", "milestone", null]);
    expect(groups[0]!.rows.map((entry) => entry.issue.identifier)).toEqual(["LAR-40", "LAR-41"]);
    expect(groups.map((group) => group.count)).toEqual([2, 1, 1]);
  });

  it("is an axis of the list like the others", () => {
    const shape = buildList(rows, "horizon", options);
    expect(shape.kind).toBe("grouped");
  });

  it("carries each row's horizon into the rows the list draws, flat and grouped, so the chip has it", () => {
    const flat = buildList(rows, "none", options);
    const drawn = flat.kind === "flat" ? flat.rows : [];
    expect(drawn.map((entry) => [entry.issue.identifier, entry.horizon?.identifier ?? null])).toEqual(
      expect.arrayContaining([["LAR-40", "LAR-3"], ["LAR-41", "LAR-3"], ["LAR-50", "LAR-4"], ["LAR-60", null]]),
    );
    for (const entry of drawn) expect(rowMilestoneCue(entry)?.horizon ?? false).toBe(entry.horizon ? true : false);
    const grouped = buildList(rows, "kind", options);
    const inKind = grouped.kind === "grouped" ? grouped.groups.flatMap((group) => group.rows) : [];
    expect(inKind.find((entry) => entry.issue.identifier === "LAR-41")?.horizon?.name).toBe("Now · Beta");
  });
});

describe("the horizon filter", () => {
  it("offers the horizons on the page in the plan's order, then No horizon, with counts", () => {
    expect(findDimension("horizon")!.options(rows)).toEqual([
      { value: "Now · Beta", label: "Now · Beta", count: 2 },
      { value: "Next · v2", label: "Next · v2", count: 1 },
      { value: NO_HORIZON, label: "No horizon", count: 1 },
    ]);
  });

  it("is not offered on a page with no horizon", () => {
    expect(findDimension("horizon")!.options([loose])).toEqual([]);
  });

  it("keeps the work of the horizons asked for", () => {
    const pick = (values: string[]) => applyFilters(rows, { ...emptyFilters(), dims: { horizon: values } }).map((entry) => entry.issue.identifier);
    expect(pick(["Now · Beta"])).toEqual(["LAR-41", "LAR-40"]);
    expect(pick([NO_HORIZON])).toEqual(["LAR-60"]);
    expect(pick(["Next · v2", NO_HORIZON])).toEqual(["LAR-60", "LAR-50"]);
  });
});

describe("a horizon's own row, should one reach the list", () => {
  // The task list leaves horizons out (`/api/issues`); a row that is one still files under itself.
  const own = on(row({ id: "h-now", identifier: "LAR-3", kind: "milestone", status: "in_progress" }), now);
  const withHorizon = [own, ...rows];
  const options = { isExpanded: () => true, showResolved: true, rollupSource: withHorizon };

  it("files it under its own section, once, never under No horizon", () => {
    const groups = buildHorizonGroups(withHorizon, options);
    const where = groups.filter((group) => group.rows.some((entry) => entry.issue.identifier === "LAR-3")).map((group) => group.status);
    expect(where).toEqual(["h-now"]);
    expect(groups.find((group) => group.status === NO_HORIZON_GROUP_KEY)!.rows.map((entry) => entry.issue.identifier)).toEqual(["LAR-60"]);
  });

  it("is never kept by the No horizon filter", () => {
    const kept = applyFilters(withHorizon, { ...emptyFilters(), dims: { horizon: [NO_HORIZON] } }).map((entry) => entry.issue.identifier);
    expect(kept).toEqual(["LAR-60"]);
  });

  it("is never re-placed under its milestone on the Horizon axis, so nothing is drawn twice", () => {
    const placed = placeForAxis(withHorizon, "horizon");
    expect(placed).toBe(withHorizon);
    expect(placeForAxis(withHorizon, "parent")).toBe(withHorizon);
  });
});

describe("the ◇ horizon chip on a phone", () => {
  it("keeps its own slot below 480px, where the milestone mark is dropped", () => {
    expect(rowPlan(390)).toMatchObject({ milestoneMark: false, horizonChip: "compact" });
    expect(rowPlan(1280).horizonChip).toBe("full");
  });

  it("shows a short name and gives the full one on tap", () => {
    const html = renderToStaticMarkup(<HorizonCompactChip cue={{ identifier: "LAR-3", title: "Now · Beta release train", horizon: true }} />);
    expect(html).toContain('data-horizon-chip-compact="LAR-3"');
    expect(html).toContain('aria-label="On horizon LAR-3: Now · Beta release train — tap for the full name"');
    expect(html.replace(/<[^>]*>/g, " ")).toContain("◇");
  });
});

describe("the ◇ horizon chip on a drawn row", () => {
  const drawn = flatRow({ ...row({ id: "t2", identifier: "LAR-42", title: "A task on Now" }), horizon: now });
  const at = (width: number) => {
    const plan = rowPlan(width);
    return renderToStaticMarkup(
      <TaskRowLine
        row={drawn}
        config={resolveTaskListConfig("tree", { labelMax: plan.labelMax, plan, desk: width >= 768 })}
        semantics="grid"
        isExpanded
        isFocused={false}
        now={new Date("2026-11-08T12:00:00.000Z")}
        onOpen={() => {}}
        onOpenParent={() => {}}
        onToggleExpand={() => {}}
        onToggleSelect={() => {}}
        onFocus={() => {}}
        onKeyDown={() => {}}
        registerRef={() => {}}
      />,
    );
  };

  it("draws the compact chip on a 390px row, where the milestone mark is gone", () => {
    const phone = at(390);
    expect(phone).toContain('data-horizon-chip-compact="LAR-3"');
    expect(phone).not.toContain('data-testid="row-milestone-cue"');
  });

  it("draws the full chip on a desk row, and no compact one", () => {
    const desk = at(1280);
    expect(desk).toContain('data-horizon-chip="LAR-3"');
    expect(desk).not.toContain("data-horizon-chip-compact");
  });
});
