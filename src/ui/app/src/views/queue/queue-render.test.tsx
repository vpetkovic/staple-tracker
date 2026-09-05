/**
 * R2d (STA-169) — the Queue view as markup, after the redesign: what the pickup order draws
 * for an entry, how a queued container's expansion is NESTED rather than listed, what the
 * rail says about a row nobody can pick up, what a stale reorder puts on screen, and which
 * panes exist at which layout. Rendered with `react-dom/server`, no DOM, the way
 * `views/milestones/milestones-render.test.tsx` does.
 *
 * ── WHAT THE REDESIGN CHANGED IN HERE, AND WHAT IT DID NOT ────────────────────────────
 *
 * Every CONTRACT assertion is unchanged and most are unchanged character for character: the
 * plan renders in plan order at the server's revision; one reorder row per entry carrying
 * drag and the labelled keyboard moves; the conflict banner keeps its two deliberate ways
 * out and is told apart from a plain refusal; eligibility is legible by glyph AND word; the
 * unqueued band stays separate and capped; a milestone date is a cue and never an order; and
 * the worked example still goes through the real client with a stubbed `fetch`.
 *
 * What was rewritten is the MARKUP SHAPE those contracts are read off, because the shape is
 * the ticket. Three specifically:
 *
 *   `data-queue-effective` → `data-queue-tree-row`. Expansion rows are shared task rows now,
 *   nested on the tree's connector rails, so the assertion that used to prove "these rows are
 *   listed under the container" now proves "these rows are nested under it" — `depth` and the
 *   guides, which is the thing a reader was previously asked to infer.
 *
 *   The per-row position `<input>` is gone, so the assertions about it moved to the rail,
 *   which is where the one remaining field lives.
 *
 *   `QueuePreviewPane` → `QueueRailPane`, which is a different component answering a
 *   different question, so its tests are new rather than edited.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { row } from "@/components/task-list/fixtures";
import { taskOption } from "@/components/createIssueForm";
import { reorderQueue } from "@/lib/api";
import type { QueueView as QueueViewData } from "@/lib/types";
import { effective, entry, queue, workedExample } from "./fixtures";
import { effectivePreview, planRows } from "./queue-model";
import { knownRows } from "./queue-tree";
import { EligibilityBadge, NextUpBand, QueueBoard, UnqueuedSection } from "./QueueView";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const noop = () => {};
const EMPTY_KNOWN = knownRows([]);

function renderPlan(
  view: QueueViewData = workedExample(),
  over: Partial<Parameters<typeof QueueBoard>[0]> = {},
): string {
  return renderToStaticMarkup(
    <QueueBoard
      view={view}
      rows={planRows(view, [], "staple")}
      preview={effectivePreview(view)}
      known={EMPTY_KNOWN}
      workspace="staple"
      now={NOW}
      busy={false}
      failure={null}
      candidates={[]}
      collapsed={new Set()}
      unqueuedOpen={false}
      onOpen={noop}
      onToggleCollapsed={noop}
      onToggleUnqueued={noop}
      onMove={noop}
      onMoveToEdge={noop}
      onAdd={noop}
      onPrune={noop}
      onReload={noop}
      onRetry={noop}
      onDismissFailure={noop}
      {...over}
    />,
  );
}

describe("the pickup order", () => {
  const html = renderPlan();

  it("lists the plan in plan order, with the revision the next write will send", () => {
    expect(html).toContain('data-queue-entry="STA-31"');
    expect(html).toContain('data-queue-entry="STA-66"');
    expect(html).toContain('data-queue-entry="STA-146"');
    expect(html.indexOf("STA-31")).toBeLessThan(html.indexOf("STA-66"));
    expect(html.indexOf("STA-66")).toBeLessThan(html.indexOf('data-queue-entry="STA-146"'));
    expect(html).toContain('data-queue-revision="7"');
    expect(html).toContain("3 entries · revision 7");
  });

  it("gives every entry ONE reorder row carrying drag AND the labelled keyboard moves", () => {
    // The drag wiring is `settings/form/ReorderList`; both paths land in its single onMove.
    expect(html).toContain('data-reorder-row="STA-146"');
    expect(html).toContain('aria-label="Drag STA-146 to reorder"');
    expect(html).toContain('aria-label="Move STA-146 up"');
    expect(html).toContain('aria-label="Move STA-146 down"');
    // …and the edges are disabled rather than silently doing nothing.
    expect(html).toMatch(/aria-label="Move STA-31 up"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Move STA-146 down"[^>]*disabled=""/);
  });

  it("keeps ONE scale per indent level, so the gutter never has to be decoded", () => {
    // Top level is the PLAN, printed bare and contiguous: 1, 2, 3 for three entries.
    const gutters = [...html.matchAll(/tabular-nums[^>]*>([^<]*)</g)].map((m) => m![1]!);
    // Document order interleaves an entry's expansion between it and the next entry, so the
    // two scales are separated by the mark rather than by position.
    expect(gutters.filter((g) => !g.startsWith("#"))).toEqual(["1", "2", "3"]);
    expect(gutters.filter((g) => g.startsWith("#"))).toEqual(["#2", "#3", "#4"]);
    // One indent in is the PICKUP order, marked with the `#` that means "effective"
    // everywhere else in this app (see row-cues.ts).
    expect(html).toContain(">#2<");
    expect(html).toContain(">#3<");
    // And none of the three old scales survives anywhere on the row.
    expect(html).not.toContain("from plan");
    expect(html).not.toContain("pickup #");
    // (The list's accessible name still says "What STA-66 expands to", which is a sentence
    // rather than the old `expands to 3` gutter label.)
    expect(html).not.toContain("expands to 3");
    expect(html).not.toContain("step 2");
  });

  it("gives a resolved entry its place and no pickup number", () => {
    // It is IN the list — the plan is a thing a human wrote and a view that omitted a step
    // would number the rest 1, 3, 4 with nothing explaining the gap — and it is dimmed.
    expect(html).toContain('data-queue-entry="STA-31"');
    expect(html).toContain('data-queue-resolved="true"');
    // …and it keeps its plan position, which is what makes the column read 1, 2, 3 rather
    // than 2, 3 with an unexplained hole where step 1 used to be.
    expect(html).toMatch(/data-queue-resolved="true"[\s\S]{0,400}?tabular-nums[^>]*>1</);
  });

  it("NESTS what a queued container expands to, in effective order, on the tree's rails", () => {
    expect(html).toContain('data-queue-expansion="STA-66"');
    expect(html).toContain('aria-label="What STA-66 expands to"');
    const at = html.indexOf('data-queue-expansion="STA-66"');
    const block = html.slice(at, html.indexOf('data-queue-entry="STA-146"'));
    expect(block).toContain('data-queue-tree-row="STA-67"');
    expect(block).toContain('data-queue-tree-row="STA-68"');
    expect(block).toContain('data-queue-tree-row="STA-70"');
    expect(block.indexOf("STA-67")).toBeLessThan(block.indexOf("STA-68"));
    // THE POINT OF THE TICKET: the descendants are drawn as task rows with connectors, so
    // "this hangs off that" is in the markup rather than in a reader's inference.
    expect(block).toContain("staple-row-guides");
    expect(block).toContain("staple-guide-elbow");
    expect(block).toContain('data-testid="task-row"');
    // The store's own sentence still rides on the row that cannot be taken.
    expect(block).toContain("blocked by STA-35, STA-67");
    expect(block).toContain('data-testid="row-caption"');
  });

  /**
   * THE EXPANSION HANGS OFF THE ROW, NOT OFF THE DRAG HANDLE.
   *
   * `ReorderList` lays a row out as `[grip] [content] [move buttons]`, and it used to render
   * `renderBelow` at the row's OUTER edge — 30px left of the content. The nested rows were
   * therefore shifted a handle's width left of the entry they belong to, which put every
   * child's elbow 30px left of the parent chevron `guideX` says it hangs from. Measured in a
   * browser: parent chevron at x=111, child elbow at x=89.
   *
   * The fix is in `ReorderList` (below means below the CONTENT), and this is the assertion
   * that keeps it there — the queue is that prop's only consumer, so this is where it is
   * cheapest to notice.
   */
  it("hangs the expansion off the entry's content, not off the drag handle", () => {
    const inset = html.indexOf("padding-left:30px");
    const expansion = html.indexOf('data-queue-expansion="STA-66"');
    expect(inset).toBeGreaterThan(-1);
    // The inset wrapper OPENS before the expansion it contains.
    expect(inset).toBeLessThan(expansion);
  });

  it("counts the descendants it did not draw rather than hiding them", () => {
    const many = queue({
      entries: [entry({ identifier: "STA-66", kind: "epic", planPosition: 1 })],
      effective: Array.from({ length: 9 }, (_, i) =>
        effective({ identifier: `STA-${67 + i}`, position: i + 1, planPosition: 1, via: "STA-66" }),
      ),
    });
    const rendered = renderPlan(many);
    expect(rendered).toContain("data-queue-expansion-more");
    expect(rendered).toContain("and 4 more under STA-66");
  });

  it("folds a container's expansion away without touching its membership", () => {
    const folded = renderPlan(workedExample(), { collapsed: new Set(["STA-66"]) });
    expect(folded).toContain('data-queue-entry="STA-66"');
    expect(folded).not.toContain('data-queue-expansion="STA-66"');
    expect(folded).not.toContain('data-queue-tree-row="STA-67"');
    // The entry count is the plan's, and no fold can reach it.
    expect(folded).toContain("3 entries · revision 7");
  });

  it("explains a plan row that is not itself pickable, on the row", () => {
    expect(html).toContain("STA-31 is done");
    expect(html).toContain('data-testid="row-caption"');
  });

  it("prunes the resolved entries, and offers it only when there are some", () => {
    expect(html).toContain("Prune 1 resolved");
    // Nothing resolved, nothing to prune.
    expect(renderPlan(queue({ entries: [entry({ identifier: "STA-1" })] }))).not.toContain("Prune");
  });

  /*
   * REMOVING ONE ENTRY moved out of a per-row trash can and into the row's `⋯`, with the two
   * moves beside it. The bin was a third control competing with the drag handle and the move
   * buttons for the same 60px, and it was the only destructive act on the row wearing no
   * confirmation and no context. The menu is closed in static markup, so what is asserted
   * here is the slot; the items themselves are `components/queue-row-menu.test.tsx`.
   */
  it("hangs per-row actions off the shared ⋯ rather than a bin of its own", () => {
    expect(html).toContain("staple-row-actions");
    expect(html).not.toContain('aria-label="Remove STA-31 from the plan"');
  });

  it("carries the entry's note under its row", () => {
    const noted = queue({ entries: [entry({ identifier: "STA-146", note: "CI is red for everyone" })] });
    expect(renderPlan(noted)).toContain("data-queue-note");
    expect(renderPlan(noted)).toContain("CI is red for everyone");
  });

  it("states the rule the whole view depends on, once, in words", () => {
    expect(html).toContain("data-queue-legend");
    expect(html).toContain("Agents take work from the top down");
  });

  /**
   * ADDING IS THE APP'S TASK PICKER, not a control of this view's own.
   *
   * The create dialog asks "which task" three times (parent, blocked by, blocking) and
   * answers with `SearchableSelect`. This is the same question, so it is the same control —
   * which means the filtering, the ranking, the status icons and the popover behaviour are
   * all pinned by `searchable-select.test.tsx`, and what is left to assert here is the
   * WIRING: that the control is present, and that it is fed the shared option shape.
   */
  it("adds through the same task picker the create dialog uses", () => {
    const candidates = [
      taskOption(row({ identifier: "STA-190", title: "October cut", kind: "milestone" })),
      taskOption(row({ identifier: "STA-66", title: "opt-in cloud continuity", kind: "epic" })),
    ];
    const rendered = renderPlan(workedExample(), { candidates });
    expect(rendered).toContain("data-queue-add");
    expect(rendered).toContain('data-searchable-select="queue-add"');
    expect(rendered).toContain("Queue a task, epic or milestone");
    // No bespoke match list of its own any more.
    expect(rendered).not.toContain("data-queue-candidate=");
  });

  it("never offers to invent a ref, because the store would refuse it", () => {
    // `searchable-select.tsx`: a relation field must not offer to create STA-999. A queue
    // entry is a relation — the store resolves the ref.
    expect(renderPlan()).not.toContain("Create");
  });

  it("says what an empty plan means rather than showing a blank box", () => {
    const empty = renderPlan(queue());
    expect(empty).toContain("nothing is queued");
    expect(empty).not.toContain("data-reorder-row");
  });

  it("disables every control while a write is in flight", () => {
    const busy = renderPlan(workedExample(), { busy: true });
    expect(busy).toMatch(/aria-label="Move STA-66 down"[^>]*disabled=""/);
    expect(busy).toMatch(/aria-label="Move STA-66 up"[^>]*disabled=""/);
    // The trigger renders `disabled` ahead of its name attribute; the pair is what matters.
    expect(busy).toMatch(/disabled=""[^>]*data-searchable-select="queue-add"/);
  });

  it("gives every row the one place its actions live", () => {
    // The `⋯` column is ON here, and it is the same slot the tree hangs its menu on.
    expect(html).toContain("staple-row-actions");
  });
});

describe("work that is not in the plan", () => {
  const view = queue({
    entries: [entry({ identifier: "STA-1", planPosition: 1 })],
    effective: [
      effective({ identifier: "STA-1", position: 1, planPosition: 1 }),
      ...Array.from({ length: 12 }, (_, i) =>
        effective({ identifier: `STA-${200 + i}`, position: i + 2, unqueued: true }),
      ),
    ],
  });

  const render = (open: boolean) =>
    renderToStaticMarkup(
      <UnqueuedSection
        preview={effectivePreview(view)}
        known={EMPTY_KNOWN}
        workspace="staple"
        now={NOW}
        open={open}
        onToggleOpen={noop}
        onOpen={noop}
      />,
    );

  it("is one folded section that counts itself, not a second list competing for the page", () => {
    const shut = render(false);
    expect(shut).toContain("data-queue-unqueued-section");
    expect(shut).toContain('aria-expanded="false"');
    expect(shut).toContain("Not planned");
    expect(shut).toContain("12 items");
    expect(shut).toContain("picked up after the plan");
    // Folded means the rows are ABSENT, not hidden.
    expect(shut).not.toContain("data-queue-tree-row");
  });

  it("opens into the same tree rows the plan uses, still capped", () => {
    const open = render(true);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("data-queue-unqueued");
    expect(open).toContain('data-queue-tree-row="STA-200"');
    expect(open).toContain('data-testid="task-row"');
    expect(open).toContain("data-queue-unqueued-more");
    expect(open).toContain("and 2 more");
  });

  it("says nothing at all when every open leaf is planned", () => {
    const planned = queue({
      entries: [entry({ identifier: "STA-1", planPosition: 1 })],
      effective: [effective({ identifier: "STA-1", position: 1, planPosition: 1 })],
    });
    expect(
      renderToStaticMarkup(
        <UnqueuedSection
          preview={effectivePreview(planned)}
          known={EMPTY_KNOWN}
          workspace="staple"
          now={NOW}
          open={false}
          onToggleOpen={noop}
          onOpen={noop}
        />,
      ),
    ).toBe("");
  });
});

describe("a stale reorder", () => {
  const conflict = {
    kind: "conflict" as const,
    refusal: {
      message: "The queue is at revision 8, not 7. Re-read the plan and retry.",
      code: "revision_conflict",
      blockers: [],
      retryable: false,
      fromServer: true,
    },
    intended: ["STA-146", "STA-31", "STA-66"],
  };

  it("keeps the server order on screen and offers a deliberate Reload and Retry", () => {
    const html = renderPlan(workedExample(), { failure: conflict });
    expect(html).toContain("data-queue-conflict");
    expect(html).toContain('role="alert"');
    expect(html).toContain("The plan changed elsewhere — nothing was written.");
    expect(html).toContain("at revision 8, not 7");
    expect(html).toContain("The order below is the server&#x27;s.");
    expect(html).toContain("Reload");
    expect(html).toContain("Retry my order");
    expect(html).not.toContain("data-guard-refusal");
    // The list under the banner is still the whole plan, in the server's order.
    expect(html.indexOf('data-queue-entry="STA-31"')).toBeLessThan(html.indexOf('data-queue-entry="STA-146"'));
  });

  it("offers no Retry for a write that had no order to retry", () => {
    const html = renderPlan(workedExample(), { failure: { ...conflict, intended: null } });
    expect(html).toContain("Reload");
    expect(html).not.toContain("Retry my order");
  });

  it("is told apart from a plain refusal, which is the store's own sentence", () => {
    const html = renderPlan(workedExample(), {
      failure: {
        kind: "refusal",
        refusal: {
          message: "WOR-12 belongs to another workspace",
          code: "validation",
          blockers: [],
          retryable: false,
          fromServer: true,
        },
        intended: null,
      },
    });
    expect(html).toContain("data-guard-refusal");
    expect(html).toContain("WOR-12 belongs to another workspace");
    expect(html).not.toContain("data-queue-conflict");
  });
});

/**
 * THE BAND replaced the rail. The rail's job split in two: the one fact it carried that the
 * list could not (what is next) is here, and everything else it offered — open, remove,
 * reorder — moved to the row's own `⋯`, which is one place rather than a panel whose
 * contents changed by selection.
 */
describe("the next-up band", () => {
  const render = (view: QueueViewData) =>
    renderToStaticMarkup(<NextUpBand next={effectivePreview(view).next} onOpen={noop} />);

  it("names the row an agent asking now would be handed", () => {
    const html = render(workedExample());
    expect(html).toContain("data-queue-next-up");
    expect(html).toContain('data-queue-next="eligible"');
    expect(html).toMatch(/data-queue-next-ref[^>]*>STA-67</);
    expect(html).toContain("S1: specify the local-first sync");
    expect(html).toContain("Open");
  });

  it("says so plainly when the whole order is waiting on something", () => {
    const html = render(
      queue({
        effective: [
          effective({ identifier: "STA-7", eligibility: "gated", reason: "queued behind STA-66's review" }),
        ],
      }),
    );
    expect(html).toContain('data-queue-next="none"');
    expect(html).toContain("Nothing is pickable right now");
    // Nothing to open, so no button offering to.
    expect(html).not.toContain("data-queue-next-ref");
  });
});

/**
 * WORK AN AGENT HAS ALREADY PICKED UP.
 *
 * docs/queue.md: rows are never dropped for being ineligible. So a claimed row keeps its
 * place and its number, and says who has it — the alternative, lifting it into a section of
 * its own, would rearrange the order while somebody was reading it.
 */
describe("a row that an agent is holding", () => {
  const held = queue({
    entries: [entry({ identifier: "STA-9", planPosition: 1 })],
    effective: [
      effective({
        identifier: "STA-9",
        position: 1,
        planPosition: 1,
        status: "in_progress",
        eligibility: "claimed",
        reason: "STA-9 is held by codex-1.",
        detail: { heldBy: "codex-1", idleSeconds: 240 },
      }),
    ],
  });

  it("stays exactly where it was, marked in flight and naming the holder", () => {
    const html = renderPlan(held);
    expect(html).toContain('data-queue-entry="STA-9"');
    expect(html).toContain('data-queue-inflight="true"');
    // The store's sentence, on the row — not hidden behind a selection.
    expect(html).toContain("STA-9 is held by codex-1.");
    // It keeps its plan position; it is still where it sits in the order.
    expect(html).toMatch(/tabular-nums[^>]*>1</);
  });

  it("is not the row anybody is offered next", () => {
    expect(renderToStaticMarkup(<NextUpBand next={effectivePreview(held).next} onOpen={noop} />)).toContain(
      'data-queue-next="none"',
    );
  });
});

describe("eligibility badges", () => {
  it("differ by glyph AND word, so colour is never the only signal", () => {
    const rendered = (["eligible", "claimed", "blocked", "gated", "resolved"] as const).map((eligibility) =>
      renderToStaticMarkup(<EligibilityBadge eligibility={eligibility} />),
    );
    expect(rendered[0]).toContain("Eligible");
    expect(rendered[1]).toContain("◐");
    expect(rendered[2]).toContain("⊘");
    expect(rendered[3]).toContain("◇");
    expect(rendered[4]).toContain("✓");
    expect(new Set(rendered).size).toBe(5);
  });
});

/**
 * THE LAYOUT IS GONE, and its tests with it: there is one full-width column at every width,
 * so there are no panes to switch between, no Back, and no full-screen toggle to report a
 * state for. What used to need three tests is now the absence of a mechanism — the strongest
 * form the simplification could take.
 */
describe("the board", () => {
  it("is one column, with no pane machinery to get lost in", () => {
    const html = renderPlan();
    expect(html).toContain("data-queue-board");
    expect(html).not.toContain("data-queue-layout");
    expect(html).not.toContain('data-queue-pane');
    expect(html).not.toContain("Back to the");
    expect(html).not.toContain("full screen");
  });
});

/**
 * THE WORKED EXAMPLE — docs/queue.md, and the ticket's first acceptance criterion.
 *
 * Through the real client with a stubbed `fetch`, so what is proven is the whole path: the
 * order a drag or a keyboard move produces goes out as one `reorder` with the CAS base,
 * and the view that comes back renders as STA-31, STA-66, STA-146, in that order, with the
 * container's descendants nested between the two leaves.
 */
describe("arranging STA-31, STA-66 and STA-146 in that plan order", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends one reorder and renders the plan the server answers with", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return { ok: true, status: 200, statusText: "OK", json: async () => workedExample() } as Response;
    });

    const view = await reorderQueue({ order: ["STA-31", "STA-66", "STA-146"], baseRevision: 6 });

    expect(calls).toEqual([
      {
        url: "/api/queue/reorder",
        body: { actor: "ui", order: ["STA-31", "STA-66", "STA-146"], baseRevision: 6 },
      },
    ]);
    expect(view.entries.map((e) => e.identifier)).toEqual(["STA-31", "STA-66", "STA-146"]);

    const html = renderPlan(view);
    const positions = ["STA-31", "STA-66", "STA-146"].map((id) => html.indexOf(`data-queue-entry="${id}"`));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The container's descendants sit between the two leaves, where an agent meets them.
    const expansion = html.indexOf('data-queue-expansion="STA-66"');
    expect(expansion).toBeGreaterThan(positions[1]!);
    expect(expansion).toBeLessThan(positions[2]!);
  });
});
