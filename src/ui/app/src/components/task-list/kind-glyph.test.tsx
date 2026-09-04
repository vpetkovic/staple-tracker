/**
 * R5e (STA-185) — ONE resolver, at every site that draws a kind.
 *
 * `safe-glyph.test.tsx` proves what `KindGlyph` does with an appearance it is HANDED.
 * This proves the other half, which is the whole ticket: that nobody hands it one. Every
 * surface — a list row, a group header, a graph node, a detail form — renders
 * `<KindGlyph kind={…}/>` and the component resolves the workspace's configured record
 * itself, so the four cannot disagree and a save in settings moves all four.
 *
 * ── HOW THE SITES ARE ASSERTED ────────────────────────────────────────────────────────
 *
 * Through the REAL components, rendered to a string with `react-dom/server`, the way
 * `row-render.test.tsx` and `group-header.test.tsx` do. Asserting `<KindGlyph/>` on its
 * own would prove the component and nothing about whether the row still reaches it; the
 * one bug this file exists to catch is a site that quietly kept its own mark.
 *
 * ── THE THREE ARMS, AND WHAT A STRING RENDER CAN SEE ──────────────────────────────────
 *
 *   emoji / svg  drawn by `SafeGlyph`, which stamps `data-glyph-source`. Synchronous.
 *   lucide       the catalog icon, which lives behind an `import()`. Effects do not run
 *                in a string render, so the chunk is loaded EXPLICITLY here with
 *                `loadKindIcons()` before the suite starts — after which the module
 *                cache makes every render synchronous, exactly as it is in a browser
 *                after the first glyph has mounted.
 *   built-in     the hand-drawn mark, `viewBox="0 0 16 16"`. The floor: an unknown
 *                Lucide key, a rejected emoji, a `none` record, or the moment before
 *                the chunk lands.
 */
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildGroups } from "@/views/tree/tree-model";
import { TreeGrid } from "@/views/tree/TreeGrid";
import { ReactFlowProvider } from "@xyflow/react";
import { EpicContainerNode } from "@/views/graph/EpicContainerNode";
import { EpicPickerBody } from "@/views/graph/EpicPicker";
import { summarizeEpics } from "@/views/graph/graph-clusters";
import { InlineKind } from "@/detail/InlineProperties";
import { publishWorkspaceSettings, resetWorkspaceSettings, workspaceSettings } from "@/lib/settings";
import type { WorkspaceSettings, Issue, IssueRow, GraphNode } from "@/lib/types";
import { KindGlyph, loadKindIcons } from "./KindGlyph";
import { TaskRowLine } from "./TaskRowLine";
import { resolveTaskListConfig } from "./config";
import { row } from "./fixtures";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const noop = () => {};

/** A served kind row, appearance and all. */
const kind = (
  id: string,
  label: string,
  appearance?: { source: string; value: string; label: string; fallback: string },
) => ({ id, label, sortOrder: 0, isBuiltin: false, ...(appearance ? { appearance } : {}) });

/**
 * The seed, captured before anything is published — the built-in statuses and their
 * orders. Only the KINDS vary in this suite, and a fixture that blanked the statuses
 * would break the grouping model rather than test the glyph.
 */
const SEED = workspaceSettings();

/** The seed's statuses with a given kind vocabulary in place of the seeded one. */
function envelope(kinds: ReturnType<typeof kind>[]): WorkspaceSettings {
  return { ...SEED, kinds: kinds as WorkspaceSettings["kinds"] };
}

/** The five seeded kinds plus `milestone`, each with the appearance the server resolves. */
const SEEDED = [
  kind("milestone", "Milestone", { source: "lucide", value: "milestone", label: "Milestone", fallback: "⚑" }),
  kind("epic", "Epic", { source: "lucide", value: "layers", label: "Epic", fallback: "◆" }),
  kind("task", "Task", { source: "lucide", value: "square-check", label: "Task", fallback: "◇" }),
  kind("bug", "Bug", { source: "lucide", value: "bug", label: "Bug", fallback: "✱" }),
  kind("chore", "Chore", { source: "lucide", value: "wrench", label: "Chore", fallback: "↻" }),
  kind("spike", "Spike", { source: "lucide", value: "zap", label: "Spike", fallback: "↯" }),
];

/** ONE CUSTOM KIND, customised the way an operator would: a kind the seed never had, wearing an emoji. */
const RESEARCH = kind("research", "Research", { source: "emoji", value: "🔬", label: "Research", fallback: "⚗" });

/** What every seeded kind's Lucide icon puts in the markup, once the chunk has landed. */
const LUCIDE_CLASS: Record<string, string> = {
  milestone: "lucide-milestone",
  epic: "lucide-layers",
  task: "lucide-square-check",
  bug: "lucide-bug",
  chore: "lucide-wrench",
  spike: "lucide-zap",
};

// ---------------------------------------------------------------- the four sites

/** A LIST ROW, through the real model, exactly as `row-render.test.tsx` builds one. */
function renderRow(over: Partial<Issue> = {}): string {
  const built = buildGroups([row(over)], { isExpanded: () => true, showResolved: true })[0]!.rows[0]!;
  return renderToStaticMarkup(
    <TaskRowLine
      row={built}
      config={resolveTaskListConfig("tree", { labelMax: 2 })}
      semantics="grid"
      isExpanded
      isFocused
      now={NOW}
      onOpen={noop}
      onOpenParent={noop}
      onToggleExpand={noop}
      onToggleSelect={noop}
      onFocus={noop}
      onKeyDown={noop}
      registerRef={noop}
    />,
  );
}

/**
 * A GROUP HEADER whose heading names a kind — the `kind` axis, which is the one axis whose
 * header draws `GroupKindGlyph`. (The `parent` axis deliberately has NO header: O8d made
 * the epic's own ROW the head of its group, and that row is the `row` site below.)
 */
function renderGroupHeader(rows: IssueRow[]): string {
  const markup = renderToStaticMarkup(
    <TreeGrid
      rows={rows}
      allRows={rows}
      mode="workspace"
      groupBy="kind"
      currentRef={null}
      showResolved
      onOpen={noop}
      onCloseDrawer={noop}
      onVisibleOrder={noop}
    />,
  );
  const at = markup.indexOf('data-testid="group-header"');
  expect(at, "no group header rendered").toBeGreaterThan(-1);
  return markup.slice(at, markup.indexOf("staple-group-count", at));
}

/**
 * THE GRAPH NODE — an expanded epic's title bar, which until this ticket drew a hard-coded
 * `Layers` whatever the kind was. Wrapped in a `ReactFlowProvider` because the box carries
 * two `<Handle/>`s; nothing else about the render needs a canvas.
 */
function renderGraphNode(kindId: string): string {
  const epic = { id: "E1", workspace: "sta", title: "Platform", status: "todo", kind: kindId, resolved: 1, total: 3 };
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <EpicContainerNode
        {...({
          id: "E1",
          type: "container",
          data: { epic, showWorkspace: false, dim: false, focused: false, width: 400, height: 200, onCollapse: noop },
        } as unknown as Parameters<typeof EpicContainerNode>[0])}
      />
    </ReactFlowProvider>,
  );
}

/** THE GRAPH'S EPIC PICKER — the popover beside the canvas, the same glyph at the same 14px. */
function renderGraphPicker(kindId: string): string {
  const node = (id: string, parent: string | null, k?: string): GraphNode =>
    ({ id, workspace: "sta", title: id, status: "todo", parent, kind: k }) as GraphNode;
  const nodes = [node("E1", null, kindId), node("A1", "E1")];
  return renderToStaticMarkup(
    <EpicPickerBody
      epics={summarizeEpics(nodes, nodes)}
      query=""
      onQuery={noop}
      selected={new Set()}
      onToggleSelect={noop}
      onClearSelection={noop}
      collapsed={new Set()}
      onSetCollapse={noop}
      onCollapseAll={noop}
      onExpandAll={noop}
    />,
  );
}

/** THE DETAIL FORM's kind editor — its trigger draws the real glyph, not a `<SelectValue/>`. */
function renderForm(kindId: string): string {
  const issue = row({ kind: kindId }).issue;
  return renderToStaticMarkup(<InlineKind issue={issue} workspace="staple" refresh={noop} />);
}

const SITES: Record<string, (kindId: string) => string> = {
  row: (k) => renderRow({ kind: k }),
  header: (k) => renderGroupHeader([row({ identifier: "STA-1", kind: k })]),
  graph: renderGraphNode,
  picker: renderGraphPicker,
  form: renderForm,
};

// The catalog chunk, once. See the header: without it a string render can only ever see
// the built-in fallback, and the `lucide` arm would go untested.
beforeAll(() => loadKindIcons());
afterEach(() => resetWorkspaceSettings());

describe("every seeded kind resolves its configured glyph, at every site", () => {
  it.each(Object.keys(SITES))("%s", (site) => {
    publishWorkspaceSettings(envelope([...SEEDED, RESEARCH]));
    for (const seeded of SEEDED) {
      const markup = SITES[site]!(seeded.id);
      expect(markup, `${site}/${seeded.id}`).toContain('data-issue-kind="' + seeded.id + '"');
      expect(markup, `${site}/${seeded.id}`).toContain(LUCIDE_CLASS[seeded.id]!);
      expect(markup, `${site}/${seeded.id}`).toContain('data-glyph-source="lucide"');
    }
  });

  it.each(Object.keys(SITES))("%s draws a CUSTOM kind's emoji, not a generic dot", (site) => {
    publishWorkspaceSettings(envelope([...SEEDED, RESEARCH]));
    const markup = SITES[site]!("research");
    expect(markup).toContain('data-issue-kind="research"');
    expect(markup).toContain("🔬");
    expect(markup).toContain('data-glyph-source="emoji"');
    // The emoji REPLACES the catalog icon; drawing both would put two kind cues on one row.
    expect(markup).not.toContain('data-glyph-source="lucide"');
  });
});

describe("the resolver is the settings snapshot, so a save repaints without a reload", () => {
  it("re-rendering with a changed envelope swaps the glyph, at every site", () => {
    publishWorkspaceSettings(envelope([...SEEDED]));
    for (const site of Object.keys(SITES)) {
      const before = SITES[site]!("epic");
      expect(before, site).toContain("lucide-layers");

      // The operator opens settings and gives `epic` an emoji. The editor republishes the
      // envelope it got back from the POST; nothing else in the app is told anything.
      publishWorkspaceSettings(
        envelope([kind("epic", "Initiative", { source: "emoji", value: "🚀", label: "Initiative", fallback: "E" })]),
      );
      const after = SITES[site]!("epic");
      expect(after, site).toContain("🚀");
      expect(after, site).not.toContain("lucide-layers");

      publishWorkspaceSettings(envelope([...SEEDED]));
    }
  });

  it("carries the renamed label into the accessible name, not just the picture", () => {
    publishWorkspaceSettings(envelope([kind("spike", "Investigation")]));
    expect(renderToStaticMarkup(<KindGlyph kind="spike" />)).toContain(
      '<span class="sr-only">Kind: Investigation</span>',
    );
  });
});

describe("the built-in mark is the floor, never a blank slot", () => {
  it("draws it for a kind nobody configured, for `none`, and for a Lucide key the catalog rejects", () => {
    publishWorkspaceSettings(
      envelope([
        kind("ghost", "Ghost"),
        kind("plain", "Plain", { source: "none", value: "", label: "Plain", fallback: "•" }),
        kind("wrong", "Wrong", { source: "lucide", value: "not-an-icon", label: "Wrong", fallback: "?" }),
      ]),
    );
    for (const id of ["ghost", "plain", "wrong"]) {
      const markup = renderToStaticMarkup(<KindGlyph kind={id} />);
      expect(markup, id).toContain('viewBox="0 0 16 16"');
      expect(markup, id).not.toContain("data-glyph-source");
    }
  });

  it("keeps the status cue distinct: a row draws its status icon AND its kind glyph, once each", () => {
    publishWorkspaceSettings(envelope([...SEEDED]));
    const markup = renderRow({ kind: "bug", status: "in_progress" });
    expect(markup.match(/data-testid="kind-glyph"/g)).toHaveLength(1);
    // `StatusIcon`'s own element, still there and still named separately.
    expect(markup).toContain('class="staple-row-status" role="img" aria-label="Status: In Progress"');
    // The kind mark is the bug icon and the status mark is not — two facts, two shapes.
    expect(markup).toContain("lucide-bug");
    expect(markup.match(/data-glyph-source="lucide"/g)).toHaveLength(1);
  });

  it("still honours an explicit `appearance` prop, which is the settings preview's whole job", () => {
    publishWorkspaceSettings(envelope([...SEEDED]));
    const markup = renderToStaticMarkup(
      <KindGlyph kind="epic" appearance={{ source: "emoji", value: "🎯", label: "Epic", fallback: "E" }} />,
    );
    expect(markup).toContain("🎯");
    expect(markup).not.toContain("lucide-layers");
  });
});
