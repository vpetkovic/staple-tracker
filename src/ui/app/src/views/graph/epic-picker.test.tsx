/**
 * O4b (STA-134) — one epic picker, and the four things it must not confuse.
 *
 * Rendered to a string with `react-dom/server`, like every other component test in this
 * repo. The popover BODY is asserted through `EpicPickerBody` rather than by opening the
 * popover: Radix portals its content and only while open, so a closed popover has no
 * markup a string render can see, and forcing one open in a server render would be
 * testing Radix rather than this ticket. `graph-toolbar.test.tsx` established the shape.
 *
 * What is worth a test here, in order of how quietly it would break:
 *
 *   1. SELECTION AND COLLAPSE ARE DIFFERENT THINGS. This is the entire ticket. The old
 *      row could only say one of them and the two controls that said them were a hand's
 *      width apart, which is why they were confused. A row must be able to be selected
 *      and expanded, or unselected and collapsed, and the markup must say which is which.
 *   2. THE CANVAS SEES THE UNION. Multi-select is what replaced a one-slot `<Select>`;
 *      the set arithmetic is `restrictToEpics`, tested next door, and what is tested here
 *      is that the control can express more than one at a time — chips and all.
 *   3. HIERARCHY IS VISIBLE. A child epic that renders at the same indent as its parent
 *      turns the picker back into the flat list it replaced.
 *   4. TYPING FILTERS, IN ORDER. Order is the R7 rule and the reason the filtering is a
 *      pure function next door rather than a fuzzy scorer inside a component.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EpicPicker, EpicPickerBody, epicTriggerLabel } from "./EpicPicker";
import { summarizeEpics } from "./graph-clusters";
import type { GraphNode } from "@/lib/types";

const noop = () => {};

const node = (id: string, parent: string | null, title: string): GraphNode => ({
  id,
  workspace: "sta",
  title,
  status: "todo",
  parent,
});

/** E1 "Platform" > E2 "Auth" > E3 "Tokens", plus the root E9 "Docs". */
const EPICS = summarizeEpics(
  [
    node("E1", null, "Platform"),
    node("E2", "E1", "Auth"),
    node("E3", "E2", "Tokens"),
    node("E9", null, "Docs"),
    node("A1", "E1", "one"),
    node("A2", "E2", "two"),
    node("A3", "E3", "three"),
    node("A9", "E9", "nine"),
  ],
  [
    node("E1", null, "Platform"),
    node("E2", "E1", "Auth"),
    node("E3", "E2", "Tokens"),
    node("E9", null, "Docs"),
    node("A1", "E1", "one"),
    node("A2", "E2", "two"),
    node("A3", "E3", "three"),
    node("A9", "E9", "nine"),
  ],
);

function picker(input: {
  epics?: readonly (typeof EPICS)[number][];
  selected?: string[];
  collapsed?: string[];
}): string {
  return renderToStaticMarkup(
    <EpicPicker
      epics={input.epics ?? EPICS}
      selected={new Set(input.selected ?? [])}
      onToggleSelect={noop}
      onClearSelection={noop}
      collapsed={new Set(input.collapsed ?? [])}
      onSetCollapse={noop}
      onCollapseAll={noop}
      onExpandAll={noop}
    />,
  );
}

function body(input: { selected?: string[]; collapsed?: string[]; query?: string }): string {
  return renderToStaticMarkup(
    <EpicPickerBody
      epics={EPICS}
      query={input.query ?? ""}
      onQuery={noop}
      selected={new Set(input.selected ?? [])}
      onToggleSelect={noop}
      onClearSelection={noop}
      collapsed={new Set(input.collapsed ?? [])}
      onSetCollapse={noop}
      onCollapseAll={noop}
      onExpandAll={noop}
    />,
  );
}

/**
 * The picker trigger's opening tag.
 *
 * Attribute ORDER is Radix's, not the JSX's — `Slot` merges the trigger's own props over
 * the child's, so `class` lands before `data-epic-picker` and a regex that assumed the
 * source order would pass or fail for reasons that have nothing to do with this ticket.
 */
function trigger(markup: string): string {
  const start = markup.indexOf("<button");
  return markup.slice(start, markup.indexOf(">", start));
}

/** The rows a render produced, in order, as `[id, depth]`. */
function rows(markup: string): Array<[string, string]> {
  return [...markup.matchAll(/data-epic-row="([^"]+)" data-epic-depth="(\d+)"/g)].map(
    (match) => [match[1]!, match[2]!],
  );
}

describe("the trigger says what is true", () => {
  it("names both counts, separately, in O4a's idiom", () => {
    // Two numbers that must never merge: they are the two states the old row confused,
    // and one combined count would put us straight back there.
    expect(epicTriggerLabel(0, 0)).toBe("Epics");
    expect(epicTriggerLabel(2, 0)).toBe("Epics: 2 selected");
    expect(epicTriggerLabel(0, 5)).toBe("Epics: 5 collapsed");
    expect(epicTriggerLabel(2, 5)).toBe("Epics: 2 selected · 5 collapsed");
  });

  it("carries the label as its own accessible name, not an aria-label", () => {
    // An aria-label here would overwrite the very words that carry the state, which is
    // the mistake O4a called out on the View button.
    const markup = picker({ selected: ["E1"], collapsed: ["E2", "E3"] });
    expect(markup).toContain("Epics: 1 selected · 2 collapsed");
    expect(trigger(markup)).toContain("data-epic-picker");
    expect(trigger(markup)).not.toContain("aria-label");
  });

  it("is muted at rest and foreground once it is doing something", () => {
    expect(trigger(picker({}))).toContain("text-muted-foreground");
    expect(trigger(picker({}))).not.toMatch(/class="[^"]*\stext-foreground/);
    expect(trigger(picker({ selected: ["E1"] }))).toMatch(/class="[^"]*\stext-foreground/);
  });

  it("draws nothing at all when the graph has no epics", () => {
    // Hub mode, or a genuinely flat workspace. Every control would be a no-op and a row
    // of dead buttons is worse than no row — the call EpicControls made before it.
    expect(picker({ epics: [] })).toBe("");
  });
});

describe("selection and collapse are independent", () => {
  it("draws a row that is SELECTED and EXPANDED", () => {
    const markup = body({ selected: ["E1"], collapsed: [] });
    expect(markup).toMatch(/aria-checked="true"[^>]*data-epic-select="E1"/);
    expect(markup).toMatch(/aria-pressed="false"[^>]*data-epic-collapse="E1"/);
  });

  it("draws a row that is UNSELECTED and COLLAPSED", () => {
    const markup = body({ selected: [], collapsed: ["E1"] });
    expect(markup).toMatch(/aria-checked="false"[^>]*data-epic-select="E1"/);
    expect(markup).toMatch(/aria-pressed="true"[^>]*data-epic-collapse="E1"/);
  });

  it("gives every row its own collapse control, named after its epic", () => {
    const markup = body({ collapsed: ["E2"] });
    for (const id of ["E1", "E2", "E3", "E9"]) {
      expect(markup).toContain(`data-epic-collapse="${id}"`);
    }
    // The name states the ACTION, so a screen reader hears what pressing it will do.
    expect(markup).toContain('aria-label="Collapse E1"');
    expect(markup).toContain('aria-label="Expand E2"');
  });

  it("puts Collapse all and Expand all in the header", () => {
    const markup = body({ collapsed: ["E1", "E2"] });
    expect(markup).toContain("Collapse all");
    expect(markup).toContain("Expand all");
    expect(markup).toContain("data-epic-collapse-all");
    expect(markup).toContain("data-epic-expand-all");
    // "all" is stated, so nobody has to guess whether it meant the filtered rows.
    expect(markup).toContain("2/4 collapsed");
  });

  it("keeps the two controls as SIBLINGS, never one inside the other", () => {
    // A button inside a button is invalid HTML and the browser's own hit-testing gives
    // up on it — which is how a collapse click becomes a select click on one machine.
    const markup = body({});
    const row = markup.slice(markup.indexOf('data-epic-row="E1"'));
    const select = row.indexOf('data-epic-select="E1"');
    const collapse = row.indexOf('data-epic-collapse="E1"');
    expect(select).toBeGreaterThan(-1);
    expect(collapse).toBeGreaterThan(select);
    expect(row.slice(select, collapse)).toContain("</button>");
  });
});

describe("multi-select", () => {
  it("holds more than one epic at once and chips each of them", () => {
    // The one-slot `<Select>` this replaced could not express "these two", which is the
    // question a review actually arrives with.
    const markup = picker({ selected: ["E1", "E9"] });
    expect(markup).toContain('data-epic-chip="E1"');
    expect(markup).toContain('data-epic-chip="E9"');
    expect(markup).toContain('aria-label="Remove E1"');
  });

  it("shows no chips and no clear affordance on an empty selection", () => {
    // Empty selection IS the whole graph, so there is nothing to clear and nothing to
    // report — a chip rail that is present but empty reads as a broken control.
    expect(picker({})).not.toContain("data-epic-chips");
    expect(body({})).not.toContain("data-epic-clear");
  });

  it("offers one click back to the whole graph once something is selected", () => {
    expect(body({ selected: ["E3"] })).toContain("data-epic-clear");
    expect(body({ selected: ["E3"] })).toContain("Show the whole graph");
  });
});

describe("hierarchy and filtering", () => {
  it("indents child epics under their parents", () => {
    expect(rows(body({}))).toEqual([
      ["E1", "0"],
      ["E2", "1"],
      ["E3", "2"],
      ["E9", "0"],
    ]);
  });

  it("filters by identifier and by title, keeping list order", () => {
    expect(rows(body({ query: "docs" }))).toEqual([["E9", "0"]]);
    expect(rows(body({ query: "e" })).map(([id]) => id)).toEqual(["E1", "E2", "E3", "E9"]);
  });

  it("keeps a match's ancestors, dimmed, so the indent still means something", () => {
    const markup = body({ query: "tokens" });
    expect(rows(markup).map(([id]) => id)).toEqual(["E1", "E2", "E3"]);
    // Only the real match is flagged; the two above it are context.
    expect(markup).toMatch(/data-epic-select="E3" data-epic-matched=""/);
    expect(markup).not.toMatch(/data-epic-select="E1" data-epic-matched=""/);
  });

  it("says so plainly when nothing matches", () => {
    const markup = body({ query: "zzzz" });
    expect(rows(markup)).toEqual([]);
    expect(markup).toContain("no epic matches");
  });
});

describe("the row reads like the search popup's row", () => {
  it("carries a kind mark, a status icon, the identifier, the title and resolved/total", () => {
    const markup = body({});
    const row = markup.slice(
      markup.indexOf('data-epic-row="E9"'),
      markup.indexOf('data-epic-collapse="E9"'),
    );
    // The kind mark is a PLACEHOLDER for O1b's shared glyph and the data attribute is
    // what makes it replaceable in one place — see EpicKindMark.
    expect(row).toContain('data-issue-kind="epic"');
    // StatusIcon brings its own accessible name; a second set of status shapes in this
    // popover would be a second set to keep in step with the list.
    expect(row).toContain("Status: Todo");
    expect(row).toContain("E9");
    expect(row).toContain("Docs");
    // A9 plus E9's own node: two members, none finished.
    expect(row).toContain("0/2");
  });

  it("keeps exactly one tab stop for the whole list", () => {
    // The roving pattern O4a uses: one tab stop in, arrows within, and the list never
    // becomes four Tab presses on a graph with four epics.
    const markup = body({});
    expect([...markup.matchAll(/data-epic-select="[^"]+"/g)]).toHaveLength(4);
    expect([...markup.matchAll(/tabindex="0"[^>]*data-epic-select=/g)]).toHaveLength(1);
  });

  it("gives the search box a name, since it has no visible label", () => {
    expect(body({})).toContain('aria-label="Search epics"');
  });
});
