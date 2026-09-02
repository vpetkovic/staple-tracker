/**
 * THE reusable task list — R4 (STA-102). What the config actually does to the DOM.
 *
 * Rendered to a string with `react-dom/server`, same as row-render.test.tsx: every claim
 * below is about which elements EXIST and what roles they carry, not about layout, which is
 * CSS and is checked in the screenshot evidence instead.
 *
 * The four properties worth a test, in order of how quietly they would break:
 *
 *   1. A dropped column is ABSENT, not hidden. The entire argument for a config over a fork
 *      is that a narrow container gets its width back; a `display: none` box gives it none,
 *      and the failure is invisible until someone measures a title that should have fitted.
 *   2. No preset drops a §14 never-drop element. This is the rule a future "it's only a
 *      popup" decision would break, and it would break silently, because a palette row
 *      missing its status icon still looks fine.
 *   3. The three consumers render the SAME row. Asserted by stripping the container-specific
 *      attributes and comparing markup — the moment someone forks the row for the palette,
 *      this fails.
 *   4. Semantics follow the container. A treegrid row inside a detail panel is a lie told to
 *      a screen reader and there is no other test in this repo that would catch it.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskList } from "./TaskList";
import { TaskRowLine } from "./TaskRowLine";
import {
  NEVER_DROPPED,
  resolveTaskListConfig,
  SHOW_ROW_CHECKBOXES,
  TASK_LIST_PRESETS,
  type TaskListPreset,
} from "./config";
import { flatRow, guideX, type TaskSource } from "./model";
import { claim, row } from "./fixtures";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const PRESETS = Object.keys(TASK_LIST_PRESETS) as TaskListPreset[];

function renderAt(preset: TaskListPreset, source: TaskSource = row({ assignee: "VP" })): string {
  return renderToStaticMarkup(
    <TaskRowLine
      row={flatRow(source)}
      config={resolveTaskListConfig(preset)}
      semantics="grid"
      now={NOW}
      onOpen={() => {}}
    />,
  );
}

describe("column config", () => {
  it("drops a column by REMOVING it from the DOM, never by hiding it", () => {
    const tree = renderAt("tree");
    const popup = renderAt("popup");

    // The columns the popup drops that the tree still has.
    for (const marker of ["staple-row-date", "staple-row-actions", "staple-row-chevron"]) {
      expect(tree).toContain(marker);
      expect(popup).not.toContain(marker);
    }
    // And nothing was swapped for an invisible placeholder on the way out.
    expect(popup).not.toContain("display:none");
    expect(popup).not.toContain("visibility:hidden");
  });

  it("keeps every §14 never-drop element in EVERY preset", () => {
    // priority, identifier, status, assignee, claim. If this fails, a preset decided a
    // signal was optional; §14 says none of these are, at any width, in any container.
    const markers: Record<(typeof NEVER_DROPPED)[number], string> = {
      priority: "staple-row-priority",
      identifier: "staple-row-id",
      status: "staple-row-status",
      assignee: "staple-row-assignee",
      claim: 'data-testid="working-pill"',
    };

    for (const preset of PRESETS) {
      const markup = renderAt(
        preset,
        row({ assignee: "VP", status: "in_progress", checkoutAgent: "opus-x" }, claim({ idleSeconds: 5 })),
      );
      for (const key of NEVER_DROPPED) {
        expect(markup, `${preset} dropped ${key}`).toContain(markers[key]);
      }
      // The title is not a switch — there is no way to turn it off, and that is the point.
      expect(markup).toContain("staple-row-title");
    }
  });

  it("puts the workspace pill ONLY where the surface mixes workspaces", () => {
    // STA-97 §6.3's prefix chip was dropped because it rendered `STA STA-22`. This element
    // carries the SLUG, and it is only justified where nothing else says which file a
    // result came from — which is the palette, and nothing else today.
    expect(renderAt("popup")).toContain('data-testid="workspace-pill"');
    expect(renderAt("tree")).not.toContain('data-testid="workspace-pill"');
    expect(renderAt("panel")).not.toContain('data-testid="workspace-pill"');
  });

  it("declares which structural columns are on, so CSS can drop the grid track too", () => {
    expect(renderAt("tree")).toContain(`data-select="${SHOW_ROW_CHECKBOXES ? "on" : "off"}"`);
    expect(renderAt("tree")).toContain('data-disclosure="on"');
    expect(renderAt("panel")).toContain('data-select="off"');
    expect(renderAt("panel")).toContain('data-disclosure="off"');
  });

  it("carries its density on the row itself, not only on the list root", () => {
    // A row rendered `bare` inside cmdk has no list root of ours to inherit from.
    expect(renderAt("tree")).toContain('data-density="comfortable"');
    expect(renderAt("popup")).toContain('data-density="compact"');
  });

  it("lets a caller override a preset without editing it", () => {
    const config = resolveTaskListConfig("tree", { labelMax: 1, columns: { actions: false } });
    expect(config.labelMax).toBe(1);
    expect(config.columns.actions).toBe(false);
    // …and the preset itself is untouched, so the override is not a global mutation.
    expect(TASK_LIST_PRESETS.tree.columns.actions).toBe(true);
    expect(TASK_LIST_PRESETS.tree.labelMax).toBe(2);
  });
});

describe("one row, three containers", () => {
  /** Strip everything that is legitimately container-specific; the rest must be identical. */
  const shape = (markup: string) =>
    markup
      .replace(/ role="[^"]*"/g, "")
      .replace(/ tabindex="[^"]*"/g, "")
      .replace(/ aria-(level|selected|expanded)="[^"]*"/g, "")
      // `bare` opts out of the row's own hover/selection paint, because its host already
      // draws one. That is a container concern, not a difference in the row.
      .replace(/ staple-row-bare/g, "");

  it("renders the SAME markup for grid, list and bare semantics", () => {
    const source = row({ assignee: "VP" });
    const config = resolveTaskListConfig("panel");
    const at = (semantics: "grid" | "list" | "bare") =>
      renderToStaticMarkup(
        <TaskRowLine row={flatRow(source)} config={config} semantics={semantics} now={NOW} onOpen={() => {}} />,
      );

    expect(shape(at("list"))).toBe(shape(at("grid")));
    expect(shape(at("bare"))).toBe(shape(at("grid")));
  });

  it("gives each container the roles it is entitled to and no others", () => {
    const source = flatRow(row());
    const config = resolveTaskListConfig("panel");
    const at = (semantics: "grid" | "list" | "bare") =>
      renderToStaticMarkup(
        <TaskRowLine row={source} config={config} semantics={semantics} now={NOW} onOpen={() => {}} />,
      );

    expect(at("grid")).toContain('role="row"');
    expect(at("grid")).toContain('role="gridcell"');

    // A listbox option, NOT a treegrid row: a flat list has no levels to announce.
    expect(at("list")).toContain('role="option"');
    expect(at("list")).not.toContain('role="gridcell"');
    expect(at("list")).not.toContain("aria-level");

    // Bare: the host (cmdk) is already the option and already owns focus. A second role
    // here would nest two options, and a second tab stop would double the arrow keys.
    // Scoped to the ROW element — the glyphs inside it are legitimately `role="img"`.
    expect(at("bare")).not.toMatch(/^<div[^>]*\srole=/);
    expect(at("bare")).not.toMatch(/^<div[^>]*\stabindex=/);
    expect(at("bare")).not.toMatch(/^<div[^>]*\saria-selected=/);
  });
});

describe("<TaskList>", () => {
  const rows = [row({ identifier: "STA-1" }), row({ identifier: "STA-2" })];

  it("takes raw API rows and needs no placement pass", () => {
    const markup = renderToStaticMarkup(
      <TaskList rows={rows} label="Children" onOpen={() => {}} />,
    );

    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('aria-label="Children"');
    expect(markup.match(/data-testid="task-row"/g)).toHaveLength(2);
    // No tree furniture in a list that has no tree: no connectors, no chevron column.
    expect(markup).not.toContain("staple-row-guides");
    expect(markup).not.toContain("staple-row-chevron");
  });

  it("holds exactly one tab stop", () => {
    const markup = renderToStaticMarkup(<TaskList rows={rows} label="Children" onOpen={() => {}} />);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
  });

  it("renders the caller's empty state rather than an empty listbox", () => {
    // "List box, 0 items" is a worse sentence than the one the caller would have written.
    const markup = renderToStaticMarkup(
      <TaskList rows={[]} label="Children" empty={<p>no children</p>} onOpen={() => {}} />,
    );
    expect(markup).toBe("<p>no children</p>");
  });

  it("marks the row that is open in the drawer", () => {
    const markup = renderToStaticMarkup(
      <TaskList rows={rows} label="Children" currentRef="STA-2" onOpen={() => {}} />,
    );
    // Exactly one row is marked, and it is the one that is open.
    expect(markup.match(/aria-current="true"/g)).toHaveLength(1);
    const marked = markup.split("<div role=\"option\"").find((chunk) => chunk.includes('aria-current="true"'));
    expect(marked).toContain('data-identifier="STA-2"');
  });
});

describe("flatRow", () => {
  it("fills in every tree-shaped field with its no-tree value", () => {
    const flat = flatRow(row({ identifier: "STA-7" }));
    expect(flat).toMatchObject({
      depth: 0,
      hasChildren: false,
      childCount: 0,
      guides: [],
      isLast: true,
      breadcrumb: null,
    });
  });
});

describe("connector geometry follows the select column", () => {
  it("shifts the rails left by the whole column when the checkbox is off", () => {
    // Not cosmetic: with the checkbox column gone the grid shifts left, and a rail that did
    // not shift with it hangs off the identifier instead of the chevron.
    expect(guideX(0, true) - guideX(0, false)).toBe(32); // 24px column + 8px gap
    // The per-level step is unchanged either way — the indent is independent of the gutter.
    expect(guideX(1, false) - guideX(0, false)).toBe(20);
  });
});


/**
 * R2 (STA-101) — the checkbox gutter is off, and turning it back on is ONE line.
 *
 * The point of the tests below is that the ticket's acceptance line ("re-enabling must be a
 * one-line change") is a property of the code and not a claim in a worklog. If someone
 * hardcodes `select: true` beside the constant, the first test fails; if someone deletes the
 * selection model while they are in there, the second and third do.
 */
describe("row checkboxes (STA-101)", () => {
  it("is off, and the tree preset READS THE CONSTANT rather than restating it", () => {
    expect(SHOW_ROW_CHECKBOXES).toBe(false);
    // The wiring, not the value: flipping the constant must be sufficient on its own.
    expect(TASK_LIST_PRESETS.tree.columns.select).toBe(SHOW_ROW_CHECKBOXES);
  });

  it("puts no checkbox in the DOM in ANY preset", () => {
    for (const preset of PRESETS) {
      const markup = renderAt(preset);
      expect(markup, preset).not.toContain("staple-row-check");
      expect(markup, preset).not.toContain('type="checkbox"');
      // Absent, not hidden — the 32px of gutter goes back to the title.
      expect(markup, preset).toContain('data-select="off"');
    }
  });

  it("KEEPS the selection model — the row still says it is selected", () => {
    // Space still selects, Shift+Arrow still extends, and a keyboard user has to be able to
    // SEE that. The checkbox was the affordance; `aria-selected` and the selected background
    // are the feedback, and only the affordance went.
    const markup = renderToStaticMarkup(
      <TaskRowLine
        row={flatRow(row())}
        config={resolveTaskListConfig("tree")}
        semantics="grid"
        isSelected
        anySelected
        now={NOW}
        onOpen={() => {}}
      />,
    );

    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("staple-row-selecting");
  });

  it("keeps the connector geometry honest once the gutter is gone", () => {
    // The one thing that would break silently: with the select track removed the whole grid
    // shifts 32px left, and a rail that did not shift with it hangs off the identifier
    // instead of the chevron.
    expect(guideX(0, SHOW_ROW_CHECKBOXES)).toBe(16); // 8 padding + 16/2 disclosure centre
    expect(guideX(1, SHOW_ROW_CHECKBOXES) - guideX(0, SHOW_ROW_CHECKBOXES)).toBe(20);
  });
});
