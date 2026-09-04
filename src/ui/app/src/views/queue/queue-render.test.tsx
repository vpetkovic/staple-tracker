/**
 * R2d (STA-169) — the Queue view as markup: what the plan pane draws for an entry, what a
 * queued container expands to inline, how the effective preview explains a row nobody can
 * pick up, what a stale reorder puts on screen, and which panes exist at which layout.
 * Rendered with `react-dom/server`, no DOM, the way `views/milestones/milestones-render.test.tsx`
 * does.
 *
 * The worked example at the bottom goes through the real API client with a stubbed
 * `fetch`, so "STA-31, STA-66, STA-146 in that exact plan order" is proven from the write
 * body all the way to the rendered list rather than from a hand-built view object.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { row } from "@/components/task-list/fixtures";
import { reorderQueue } from "@/lib/api";
import type { QueueView as QueueViewData } from "@/lib/types";
import { effective, entry, queue, workedExample } from "./fixtures";
import { effectivePreview, planRows } from "./queue-model";
import { EligibilityBadge, QueueLayout, QueuePlanPane, QueuePreviewPane } from "./QueueView";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const noop = () => {};

function renderPlan(
  view: QueueViewData = workedExample(),
  over: Partial<Parameters<typeof QueuePlanPane>[0]> = {},
): string {
  return renderToStaticMarkup(
    <QueuePlanPane
      view={view}
      rows={planRows(view, [], "staple")}
      now={NOW}
      busy={false}
      failure={null}
      fullScreen={false}
      query=""
      candidates={[]}
      onQuery={noop}
      onToggleFullScreen={noop}
      onOpen={noop}
      onMove={noop}
      onMoveTo={noop}
      onMoveToEdge={noop}
      onRemove={noop}
      onAdd={noop}
      onPrune={noop}
      onReload={noop}
      onRetry={noop}
      onDismissFailure={noop}
      {...over}
    />,
  );
}

function renderPreview(view: QueueViewData = workedExample(), fullScreen = false): string {
  return renderToStaticMarkup(
    <QueuePreviewPane
      preview={effectivePreview(view)}
      fullScreen={fullScreen}
      onToggleFullScreen={noop}
      onOpen={noop}
    />,
  );
}

describe("the plan pane", () => {
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

  it("shows the plan number as the field you type a new position into", () => {
    expect(html).toContain('data-queue-position-field="STA-146"');
    expect(html).toContain('aria-label="Plan position of STA-146"');
    expect(html).toMatch(/aria-label="Plan position of STA-146"[^>]*value="3"/);
  });

  it("shows the effective position beside the plan one only where they differ", () => {
    // STA-146 is plan 3 and pickup 5 — the whole point of the two numbers.
    expect(html).toContain('data-queue-pickup="STA-146"');
    expect(html).toContain("pickup #5");
    // STA-31 is plan 1 and pickup 1: nothing to say.
    expect(html).not.toContain('data-queue-pickup="STA-31"');
    // A container has no pickup row of its own; it has descendants.
    expect(html).toContain('data-queue-pickup="STA-66"');
    expect(html).toContain("expands to 3");
  });

  it("expands a queued container inline, in effective order, with each row's reason", () => {
    expect(html).toContain('data-queue-expansion="STA-66"');
    expect(html).toContain('aria-label="What STA-66 expands to"');
    const at = html.indexOf('data-queue-expansion="STA-66"');
    const block = html.slice(at, html.indexOf('data-queue-entry="STA-146"'));
    expect(block).toContain('data-queue-effective="STA-67"');
    expect(block).toContain('data-queue-effective="STA-68"');
    expect(block).toContain('data-queue-effective="STA-70"');
    expect(block.indexOf("STA-67")).toBeLessThan(block.indexOf("STA-68"));
    expect(block).toContain("blocked by STA-35, STA-67");
    expect(block).toContain('data-queue-eligibility="blocked"');
    expect(block).toContain('data-queue-eligibility="eligible"');
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

  it("explains a plan row that is not itself pickable", () => {
    expect(html).toContain('data-queue-entry-reason="STA-31"');
    expect(html).toContain("STA-31 is done");
  });

  it("offers a remove per entry and a prune for the resolved ones", () => {
    expect(html).toContain('aria-label="Remove STA-31 from the plan"');
    expect(html).toContain('aria-label="Remove STA-66 from the plan"');
    expect(html).toContain("Prune 1 resolved");
    // Nothing resolved, nothing to prune.
    expect(renderPlan(queue({ entries: [entry({ identifier: "STA-1" })] }))).not.toContain("Prune");
  });

  it("carries the entry's note under its row", () => {
    const noted = queue({ entries: [entry({ identifier: "STA-146", note: "CI is red for everyone" })] });
    expect(renderPlan(noted)).toContain("data-queue-note");
    expect(renderPlan(noted)).toContain("CI is red for everyone");
  });

  it("searches for issues, epics and milestones to add", () => {
    const candidates = [
      row({ identifier: "STA-190", title: "October cut", kind: "milestone" }),
      row({ identifier: "STA-66", title: "opt-in cloud continuity", kind: "epic" }),
    ];
    const rendered = renderPlan(workedExample(), { query: "c", candidates });
    expect(rendered).toContain("data-queue-add");
    expect(rendered).toContain('aria-label="Search issues, epics and milestones to queue"');
    expect(rendered).toContain('data-queue-candidate="STA-190"');
    expect(rendered).toContain('data-queue-candidate="STA-66"');
    expect(rendered).toContain("milestone");
    expect(rendered).toContain("Queue it");
    // With nothing typed there is no match list at all, rather than an empty box.
    expect(html).not.toContain("data-queue-candidates");
  });

  it("says what an empty plan means rather than showing a blank box", () => {
    const empty = renderPlan(queue());
    expect(empty).toContain("nothing is queued");
    expect(empty).not.toContain("data-reorder-row");
  });

  it("disables every control while a write is in flight", () => {
    const busy = renderPlan(workedExample(), { busy: true });
    expect(busy).toMatch(/aria-label="Move STA-66 down"[^>]*disabled=""/);
    expect(busy).toMatch(/aria-label="Remove STA-66 from the plan"[^>]*disabled=""/);
    // The field renders `disabled` ahead of its label; the pair is what matters.
    expect(busy).toMatch(/disabled=""[^>]*aria-label="Plan position of STA-66"/);
  });

  it("has a full-screen toggle that reports its state", () => {
    expect(html).toContain('aria-label="Expand Plan to full screen"');
    expect(html).toContain('aria-pressed="false"');
    const full = renderPlan(workedExample(), { fullScreen: true });
    expect(full).toContain('aria-label="Collapse Plan from full screen"');
    expect(full).toContain('aria-pressed="true"');
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

describe("the effective preview", () => {
  const html = renderPreview();

  it("names the row an agent asking now would be handed", () => {
    expect(html).toContain('data-queue-next="eligible"');
    expect(html).toContain("next: STA-67 (#2)");
  });

  it("lists the plan band in effective order, indenting what came out of a container", () => {
    expect(html).toContain("data-queue-planned");
    expect(html).toContain('data-queue-effective="STA-31"');
    expect(html).toContain('data-queue-via="STA-66"');
    expect(html.indexOf('data-queue-effective="STA-67"')).toBeLessThan(
      html.indexOf('data-queue-effective="STA-146"'),
    );
  });

  it("shows where a row came from when its two numbers differ", () => {
    expect(html).toContain("#3 · from plan #2");
    expect(html).toContain("#5 · from plan #3");
    expect(html).toContain(">#1<");
  });

  it("gives blocked, gated, claimed and resolved rows a badge and a concise reason", () => {
    expect(html).toContain('data-queue-eligibility="resolved"');
    expect(html).toContain('data-queue-eligibility="blocked"');
    expect(html).toContain("STA-31 is done");
    expect(html).toContain("blocked by STA-35, STA-67");

    const others = renderPreview(
      queue({
        effective: [
          effective({ identifier: "STA-7", eligibility: "gated", reason: "queued behind STA-66's review" }),
          effective({ identifier: "STA-8", eligibility: "claimed", reason: "held by codex-1, idle 4m" }),
        ],
      }),
    );
    expect(others).toContain('data-queue-eligibility="gated"');
    expect(others).toContain("queued behind STA-66&#x27;s review");
    expect(others).toContain('data-queue-eligibility="claimed"');
    expect(others).toContain("held by codex-1, idle 4m");
    expect(others).toContain('data-queue-next="none"');
    expect(others).toContain("nothing is pickable right now");
  });

  it("keeps the unqueued band separate and capped", () => {
    const view = queue({
      entries: [entry({ identifier: "STA-1", planPosition: 1 })],
      effective: [
        effective({ identifier: "STA-1", position: 1, planPosition: 1 }),
        ...Array.from({ length: 12 }, (_, i) =>
          effective({ identifier: `STA-${200 + i}`, position: i + 2, unqueued: true }),
        ),
      ],
    });
    const rendered = renderPreview(view);
    expect(rendered).toContain("Unqueued, and therefore later");
    expect(rendered).toContain("data-queue-unqueued");
    expect(rendered).toContain("#2 · unqueued");
    expect(rendered).toContain("data-queue-unqueued-more");
    expect(rendered).toContain("and 2 more unqueued");
  });

  it("says why the whole list is unqueued when the plan is empty", () => {
    expect(renderPreview(queue())).toContain("the plan is empty");
  });

  it("carries a milestone's date as a cue, never as an order", () => {
    const dated = renderPreview(
      queue({ effective: [effective({ identifier: "STA-9", dueAt: "2026-10-31" })] }),
    );
    expect(dated).toContain("data-queue-due");
    expect(dated).toContain("due 2026-10-31");
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

describe("the layout", () => {
  const render = (layout: "stacked" | "split", pane: "plan" | "preview", fullScreen = false) =>
    renderToStaticMarkup(
      <QueueLayout
        layout={layout}
        pane={pane}
        fullScreen={fullScreen}
        plan={<div data-test-plan />}
        preview={<div data-test-preview />}
        onPane={noop}
      />,
    );

  it("is a drawer on a narrow viewport: one pane, with the way across and the way back", () => {
    const plan = render("stacked", "plan");
    expect(plan).toContain('data-queue-layout="stacked"');
    expect(plan).toContain('data-queue-pane="plan"');
    expect(plan).not.toContain('data-queue-pane="preview"');
    expect(plan).toContain("Effective order");

    const preview = render("stacked", "preview");
    expect(preview).toContain('data-queue-pane="preview"');
    expect(preview).not.toContain('data-queue-pane="plan"');
    expect(preview).toContain("Back to the plan");
  });

  it("splits the plan and the preview from tablet up, with no pane switching to do", () => {
    const split = render("split", "plan");
    expect(split).toContain('data-queue-layout="split"');
    expect(split).toContain('data-queue-pane="plan"');
    expect(split).toContain('data-queue-pane="preview"');
    expect(split).not.toContain("Back to the plan");
    expect(split).not.toContain("data-full-screen");
  });

  it("gives the ACTIVE pane the whole box in full screen, at any width", () => {
    for (const layout of ["stacked", "split"] as const) {
      const plan = render(layout, "plan", true);
      expect(plan).toContain('data-full-screen="true"');
      expect(plan).toContain('data-queue-pane="plan"');
      expect(plan).not.toContain('data-queue-pane="preview"');
      expect(plan).not.toContain("Back to the plan");

      const preview = render(layout, "preview", true);
      expect(preview).toContain('data-queue-pane="preview"');
      expect(preview).not.toContain('data-queue-pane="plan"');
    }
  });
});

/**
 * THE WORKED EXAMPLE — docs/queue.md, and the ticket's first acceptance criterion.
 *
 * Through the real client with a stubbed `fetch`, so what is proven is the whole path: the
 * order a drag or a keyboard move produces goes out as one `reorder` with the CAS base,
 * and the view that comes back renders as STA-31, STA-66, STA-146, in that order, with the
 * container expanded between the two leaves.
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
    expect(html).toMatch(/aria-label="Plan position of STA-31"[^>]*value="1"/);
    expect(html).toMatch(/aria-label="Plan position of STA-66"[^>]*value="2"/);
    expect(html).toMatch(/aria-label="Plan position of STA-146"[^>]*value="3"/);
    // The container's descendants sit between the two leaves, where an agent meets them.
    const expansion = html.indexOf('data-queue-expansion="STA-66"');
    expect(expansion).toBeGreaterThan(positions[1]!);
    expect(expansion).toBeLessThan(positions[2]!);
  });
});
