/**
 * R4e (STA-190) — WHAT THE 1.5s POLL IS ALLOWED TO CHANGE, WHICH IS ALMOST NOTHING.
 *
 * The list refetches on `session.version` roughly every 1.5 seconds, and everything R4
 * added is a preference the reader set BY HAND: the sort mode, eleven filter dimensions,
 * which epics are folded, and a set of cues joined against a second endpoint. Each of those
 * is a chance for the poll to undo a choice, and the failure is uniquely bad because it is
 * intermittent — the list works, and then a second and a half later it does not.
 *
 * There is no test for it anywhere in the repo, because nothing polls: `session.version`
 * lives in `lib/session.ts` and only ever appears in a `useResource` dependency array. So
 * this file models what a poll IS — the whole `views/TreeView.tsx` pipeline run twice over
 * two payloads — and compares the two results.
 *
 * ── HOW A POLL IS MODELLED, AND WHY IT IS FAITHFUL ────────────────────────────────────
 *
 * `TreeView` does, in order: join the queue onto the unfiltered rows (`attachRowCues`),
 * narrow them (`applyFilterDimensions`), find the parents the narrowing removed
 * (`hiddenParents`), and build the shape (`buildList`). `pollOnce` below is those four calls
 * and nothing else, so a change to the real pipeline that this file does not have is a
 * change to a line this file is not claiming anything about.
 *
 * THE SECOND PAYLOAD IS THE SAME ROWS WITH THE CLOCK MOVED ON — every `updatedAt` shifted
 * by exactly one hour, and `now` shifted by the same hour. That is what a poll looks like
 * from the browser's side, and the uniform shift is deliberate: a payload that moved one
 * row's timestamp and not another's would legitimately reorder the `updated` mode, and the
 * test would then be about the sort rather than about the poll.
 *
 * `session.version` itself is never read by any of these functions, and that IS the design:
 * the version is a fetch trigger, not an input to the model. The bump is represented here by
 * the second call, which is the only observable it has.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { attachRowCues, buildRowCueIndex } from "@/components/task-list/row-cues";
import type { TaskRow } from "@/components/task-list";
import {
  applyFilterDimensions,
  buildFilterContext,
  type FilterContext,
} from "@/lib/filter-dimensions";
import { emptyFilters, hiddenParents, type FilterState } from "@/lib/filters";
import { DEFAULT_SORT, type SortPref } from "@/lib/sort-modes";
import type { GroupBy } from "@/lib/view-prefs";
import type { IssueRow, QueueView } from "@/lib/types";
import {
  driftInbox,
  driftMilestones,
  driftMilestoneTitles,
  driftQueue,
  driftRows,
  MILESTONE,
  withGate,
} from "./drift-fixture";
import { explicitExpansion } from "./expansion";
import { buildPickupIndex } from "./pickup-model";
import { TreeGrid } from "./TreeGrid";
import { buildList, sectionsOf, visibleOrder, type ListShape } from "./tree-model";

const BOARD = withGate(driftRows());
const PICKUP = buildPickupIndex(driftInbox());
const CONTEXT: FilterContext = { ...buildFilterContext(BOARD), milestones: driftMilestones() };

const HOUR_MS = 60 * 60 * 1000;
const FIRST_RENDER_AT = new Date("2026-09-04T12:00:00.000Z");

/**
 * The second payload: identical rows, one hour later.
 *
 * THE CLAIM IS NOT SHIFTED, and that is the faithful choice rather than the lazy one. A
 * claim has its own clock — `idleSeconds` and `lastActivityAt` are SERVED, and they move
 * when the holder checkpoints, not when the poll fires. A poll in which nobody touched a
 * claim brings that claim back byte-identical, which is exactly what makes "the stale badge
 * says the same thing" a claim worth checking rather than an artefact of the shift.
 */
function laterBy(rows: IssueRow[], ms: number): IssueRow[] {
  const shift = (iso: string) => new Date(new Date(iso).getTime() + ms).toISOString();
  return rows.map((r) => ({
    ...r,
    issue: {
      ...r.issue,
      updatedAt: shift(r.issue.updatedAt),
      createdAt: shift(r.issue.createdAt),
    },
  }));
}

interface PollInput {
  rows: IssueRow[];
  queue: QueueView | null;
  filters?: FilterState;
  sort?: SortPref;
  groupBy?: GroupBy;
  /** `issue.id -> the user's EXPLICIT fold`, exactly as expansion.ts stores it. */
  expanded?: Map<string, boolean>;
}

/** `views/TreeView.tsx`'s four steps, in its order. */
function pollOnce({
  rows,
  queue,
  filters = emptyFilters(),
  sort = DEFAULT_SORT,
  groupBy = "none",
  expanded = new Map(),
}: PollInput): { shape: ListShape; visible: IssueRow[] } {
  const all = attachRowCues(rows, buildRowCueIndex(queue, driftMilestoneTitles()));
  const visible = applyFilterDimensions(all, filters, CONTEXT);
  const shape = buildList(
    visible,
    groupBy,
    {
      isExpanded: (issue) => explicitExpansion(expanded, issue),
      showResolved: filters.showDone,
      hiddenParents: hiddenParents(visible, all),
      rollupSource: all,
      sort,
    },
    PICKUP,
  );
  return { shape, visible };
}

/**
 * EVERYTHING THE READER CAN SEE, as one comparable value.
 *
 * A structural snapshot rather than a markup string, so this file can compare the four
 * things the ticket names — order, membership, fold state and cues — without also comparing
 * the relative clock, which a poll is SUPPOSED to move. The markup itself is compared in the
 * last block, where the clock is moved with it and the two cancel.
 */
function snapshot(shape: ListShape) {
  const line = (row: TaskRow) => ({
    id: row.issue.identifier,
    depth: row.depth,
    ghost: row.ghost === true,
    expanded: row.isExpanded,
    childCount: row.childCount,
    rollup: row.rollup ? `${row.rollup.resolved}/${row.rollup.total}` : null,
    cue: row.cues?.pickup ? `${row.cues.pickup.state}:${row.cues.pickup.position ?? "-"}` : null,
    milestone: row.cues?.milestone?.identifier ?? null,
  });
  const sections =
    shape.kind === "flat"
      ? [{ key: "__flat__", count: shape.rows.length, rows: shape.rows.map(line) }]
      : sectionsOf(shape).map((section, index) => ({
          key: section.key,
          count:
            shape.kind === "grouped" ? shape.groups[index]!.count : shape.groups[index]!.count,
          rows: section.rows.map(line),
        }));
  return { sections, order: visibleOrder(shape, () => false).map((s) => s.ref) };
}

describe("a poll that brings the same rows back changes nothing the reader chose", () => {
  const SECOND = laterBy(BOARD, HOUR_MS);

  it("moved the clock and nothing else — the premise the rest of this block rests on", () => {
    expect(SECOND.map((r) => r.issue.identifier)).toEqual(BOARD.map((r) => r.issue.identifier));
    expect(SECOND[1]!.issue.updatedAt).not.toBe(BOARD[1]!.issue.updatedAt);
    expect(new Date(SECOND[1]!.issue.updatedAt).getTime()).toBe(
      new Date(BOARD[1]!.issue.updatedAt).getTime() + HOUR_MS,
    );
    // The claim is byte-identical, including the served durations — a poll does not
    // re-derive staleness in the browser and nobody checkpointed between the two fetches.
    expect(SECOND[3]!.claim).toEqual(BOARD[3]!.claim);
  });

  it("keeps the SORT: every mode produces the same page across the poll", () => {
    for (const mode of ["activity", "updated", "created", "title", "priority", "status"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        const sort: SortPref = { mode, direction };
        const before = snapshot(pollOnce({ rows: BOARD, queue: driftQueue(), sort }).shape);
        const after = snapshot(pollOnce({ rows: SECOND, queue: driftQueue(), sort }).shape);
        expect(after, `${mode}/${direction}`).toEqual(before);
      }
    }
  });

  it("keeps the FILTERS, including the ghosts the filter created", () => {
    const filters: FilterState = {
      ...emptyFilters(),
      dims: { milestone: [MILESTONE.identifier] },
    };
    const before = pollOnce({ rows: BOARD, queue: driftQueue(), filters, groupBy: "status" });
    const after = pollOnce({ rows: SECOND, queue: driftQueue(), filters, groupBy: "status" });

    expect(before.visible.map((r) => r.issue.identifier)).toEqual(["STA-2", "STA-7"]);
    expect(snapshot(after.shape)).toEqual(snapshot(before.shape));
    // The two ghosts are still ghosts. A poll that re-ran `hiddenParents` against a
    // different array would be the way they silently turn into real rows.
    expect(snapshot(after.shape).sections.flatMap((s) => s.rows).filter((r) => r.ghost)).toHaveLength(
      2,
    );
  });

  it("keeps the EXPANSION, because a fold is keyed on an issue id and a poll cannot move one", () => {
    // The user folded the open epic by hand and unfolded the cold one — both are the
    // OPPOSITE of each shape's default, so a poll that dropped the overrides would be
    // visible in both directions rather than only one.
    const expanded = new Map([
      ["epic-order", false],
      ["epic-cold", true],
    ]);
    const before = snapshot(pollOnce({ rows: BOARD, queue: driftQueue(), expanded }).shape);
    const after = snapshot(pollOnce({ rows: SECOND, queue: driftQueue(), expanded }).shape);

    const foldOf = (snap: ReturnType<typeof snapshot>, id: string) =>
      snap.sections.flatMap((s) => s.rows).find((r) => r.id === id)!.expanded;
    expect(foldOf(before, "STA-1")).toBe(false);
    expect(foldOf(before, "STA-5")).toBe(true);
    expect(after).toEqual(before);
  });

  it("keeps the fold across a poll on every axis, not only the ungrouped one", () => {
    const expanded = new Map([["epic-order", false]]);
    for (const groupBy of ["none", "status", "pickup", "parent", "kind"] as const) {
      const before = snapshot(pollOnce({ rows: BOARD, queue: driftQueue(), expanded, groupBy }).shape);
      const after = snapshot(pollOnce({ rows: SECOND, queue: driftQueue(), expanded, groupBy }).shape);
      expect(after, groupBy).toEqual(before);
    }
  });

  it("keeps the CUES: the same queue payload joins onto the same rows", () => {
    const before = snapshot(pollOnce({ rows: BOARD, queue: driftQueue() }).shape);
    const after = snapshot(pollOnce({ rows: SECOND, queue: driftQueue() }).shape);
    const cues = (snap: ReturnType<typeof snapshot>) =>
      Object.fromEntries(snap.sections.flatMap((s) => s.rows).map((r) => [r.id, r.cue]));

    expect(cues(after)).toEqual(cues(before));
    expect(cues(before)["STA-8"]).toBe("pickable:4");
  });

  it("survives a poll that has not answered yet — no queue is silence, not `unqueued`", () => {
    /*
     * `/api/queue` and `/api/issues` are two requests on one fingerprint and they do not land
     * together. The instant between them must not stamp a cue on every row: the cue index is
     * empty, `attachRowCues` hands back the caller's own array, and every row says nothing.
     */
    const withoutQueue = pollOnce({ rows: SECOND, queue: null });
    const rows = snapshot(withoutQueue.shape).sections.flatMap((s) => s.rows);

    expect(rows.every((r) => r.cue === null)).toBe(true);
    // The ORDER is unaffected — the cue is a caption, and the queue is not an input to the
    // comparator on today's payload.
    expect(snapshot(withoutQueue.shape).order).toEqual(
      snapshot(pollOnce({ rows: SECOND, queue: driftQueue() }).shape).order,
    );
  });
});

describe("a poll that brings a NEW queue back changes the cues and only the cues", () => {
  /**
   * The plan moved while the reader was looking at it: another agent took the row that was
   * `next`, so the queue now calls STA-8 claimed and the research task becomes the first
   * eligible row. That is exactly the change the 1.5s poll exists to deliver — and it must
   * arrive as two captions changing, not as the page rebuilding.
   */
  function reorderedQueue(): QueueView {
    const queue = driftQueue();
    return {
      ...queue,
      revision: queue.revision + 1,
      effective: queue.effective.map((row) =>
        row.identifier === "STA-8"
          ? { ...row, eligibility: "claimed" as const, reason: "held by opus-r4e" }
          : row,
      ),
    };
  }

  /** Both epics open, so every row the queue has an opinion about is on the page. */
  const OPEN = new Map([["epic-cold", true]]);
  const before = snapshot(pollOnce({ rows: BOARD, queue: driftQueue(), expanded: OPEN }).shape);
  const after = snapshot(pollOnce({ rows: BOARD, queue: reorderedQueue(), expanded: OPEN }).shape);

  it("moves the word `next` to the row that is now first eligible", () => {
    const cueOf = (snap: typeof before, id: string) =>
      snap.sections.flatMap((s) => s.rows).find((r) => r.id === id)!.cue;

    expect(cueOf(before, "STA-8")).toBe("pickable:4");
    expect(cueOf(after, "STA-8")).toBe("in_flight:-");
    // The research task was `queued:5` and is now the one an agent would be handed.
    expect(cueOf(before, "STA-7")).toBe("queued:5");
    expect(cueOf(after, "STA-7")).toBe("pickable:5");
  });

  it("changes NOTHING else — same sections, same counts, same order, same folds", () => {
    const strip = (snap: typeof before) => ({
      order: snap.order,
      sections: snap.sections.map((section) => ({
        key: section.key,
        count: section.count,
        rows: section.rows.map(({ cue, ...rest }) => rest),
      })),
    });

    expect(strip(after)).toEqual(strip(before));
  });
});

/**
 * ══ THE SAME CLAIM, ABOUT THE MARKUP ═══════════════════════════════════════════════════
 *
 * The blocks above compare the model. This one compares the string the browser would be
 * handed, because the model is not the only place a poll could disturb the page — a
 * component that re-derived anything from `Date.now()` per render would produce a stable
 * model and an unstable page.
 *
 * The clock is moved WITH the payload: `vi.setSystemTime` advances `now` by the same hour
 * every `updatedAt` moved, so every relative date on the row is the same age and the two
 * renders are comparable byte for byte. Moving one and not the other would be testing
 * `formatRowDate`, which owns its own tests.
 */
describe("the rendered page after a poll", () => {
  afterEach(() => vi.useRealTimers());

  const render = (rows: IssueRow[], queue: QueueView, at: Date) => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const all = attachRowCues(rows, buildRowCueIndex(queue, driftMilestoneTitles()));
    const markup = renderToStaticMarkup(
      createElement(TreeGrid, {
        rows: all,
        allRows: all,
        mode: "workspace" as const,
        groupBy: "none" as const,
        currentRef: null,
        showResolved: false,
        onOpen: () => {},
        onCloseDrawer: () => {},
        onVisibleOrder: () => {},
      }),
    );
    vi.useRealTimers();
    return markup;
  };

  /**
   * ONE ELEMENT IS ALLOWED TO DIFFER, and it is the one that is supposed to.
   *
   * `<time>` carries the row's ABSOLUTE `dateTime` and `title` — the machine-readable
   * instant, which moved with the payload — while its TEXT is the relative age, which did
   * not. Normalising the opening tag away and keeping the text is exactly the distinction:
   * everything the reader sees is compared, including ">3h<", and the two attributes that
   * are a copy of the timestamp are not.
   */
  const normaliseTime = (markup: string) =>
    markup.replace(/<time class="staple-row-date"[^>]*>/g, "<time>");

  it("shows the reader the identical page when the rows and the clock move together", () => {
    const first = render(BOARD, driftQueue(), FIRST_RENDER_AT);
    const second = render(
      laterBy(BOARD, HOUR_MS),
      driftQueue(),
      new Date(FIRST_RENDER_AT.getTime() + HOUR_MS),
    );

    expect(normaliseTime(second)).toBe(normaliseTime(first));
    // The relative age is INSIDE the compared text, so the equality above covers it.
    expect(normaliseTime(first)).toContain("<time>3h</time>");
    // And it is a page with something on it, so the equality is not two empty strings.
    expect(first).toContain('data-identifier="STA-1"');
    expect(first).toContain('data-pickup-cue="pickable"');
    // The absolute instant DID move, which is what makes the normalisation necessary rather
    // than a way of hiding a difference that matters.
    expect(first).toContain('dateTime="2026-09-04T09:00:00.000Z"');
    expect(second).toContain('dateTime="2026-09-04T10:00:00.000Z"');
  });

  it("differs in the cues, and only in the cues, when the queue moves", () => {
    const first = render(BOARD, driftQueue(), FIRST_RENDER_AT);
    const moved = render(
      BOARD,
      {
        ...driftQueue(),
        effective: driftQueue().effective.map((row) =>
          row.identifier === "STA-8" ? { ...row, eligibility: "claimed" as const } : row,
        ),
      },
      FIRST_RENDER_AT,
    );

    expect(moved).not.toBe(first);
    // Strip the two cue elements out of both and the pages are the same page.
    const withoutCues = (markup: string) =>
      markup.replace(/<span class="staple-row-cue"[\s\S]*?<\/span><\/span>/g, "");
    expect(withoutCues(moved)).toBe(withoutCues(first));
  });
});
