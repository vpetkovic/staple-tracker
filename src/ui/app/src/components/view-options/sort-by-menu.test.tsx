/**
 * R4a (STA-186) — the Sort by control, in the tree view's menu language.
 *
 * Rendered to a string with `react-dom/server`, like every other component test in this
 * repo: there is no jsdom here, and every claim below is about which elements exist and what
 * their labels and ARIA state say, which is exactly what a string can answer.
 *
 * The popover BODY is asserted through `SortByOptions` rather than by opening the popover.
 * Radix renders content through a portal and only while open, so a closed popover has no
 * markup to look at — and forcing one open in a server render would be testing Radix, not
 * this ticket. The same split `views/graph/graph-toolbar.test.tsx` makes, for the same reason.
 *
 * What is worth a test here, in order of how quietly it would break:
 *
 *   1. THE TRIGGER SAYS WHAT IS TRUE, INCLUDING THE DIRECTION. That is the ticket's first
 *      acceptance criterion, and the failure mode is not a crash — it is a control that says
 *      "Sort" and makes the reader open it to find out what they asked for.
 *   2. THE DIRECTION IS NAMED, NEVER "descending". A composite rank has no ascending reading
 *      a person can act on; "Most active first" does.
 *   3. EVERY MODE IS REACHABLE, and each one is a real radio in a labelled group — which is
 *      what makes the control keyboard-operable without a key handler of its own.
 *   4. THE CHAIN IS ON SCREEN. The docs hold the table; the question "why is this row above
 *      that one" is asked here, with both rows in view.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SORT_MODES, type SortPref } from "@/lib/sort-modes";
import { isDefaultSort, SortByMenu, SortByOptions, sortTriggerLabel, tieBreakSentence } from "./SortByMenu";

const noop = () => {};

/** React escapes apostrophes in text nodes; three of the registry's hints contain one. */
const escaped = (text: string) => text.replaceAll("'", "&#x27;");

function menu(sort: SortPref): string {
  return renderToStaticMarkup(<SortByMenu sort={sort} onChange={noop} />);
}

function options(sort: SortPref): string {
  return renderToStaticMarkup(<SortByOptions sort={sort} onMode={noop} onDirection={noop} />);
}

/** Matches the checked row of one group, whatever order React emits the attributes in. */
const checkedRow = (group: "mode" | "direction", option: string) =>
  new RegExp(`aria-checked="true"[^>]*data-sort-group="${group}" data-sort-option="${option}"`);

describe("the trigger states the sort WITHOUT being opened", () => {
  it("names the mode and the reading of the direction, not an arrow", () => {
    expect(sortTriggerLabel({ mode: "activity", direction: "asc" })).toBe(
      "Sort: Activity · Most active first",
    );
    expect(sortTriggerLabel({ mode: "updated", direction: "desc" })).toBe(
      "Sort: Updated · Newest first",
    );
    expect(sortTriggerLabel({ mode: "queue", direction: "desc" })).toBe(
      "Sort: Queue position · Back of the queue first",
    );
  });

  it("renders that sentence into the closed control, so nothing has to be opened", () => {
    const html = menu({ mode: "title", direction: "asc" });
    expect(html).toContain("Sort: Title · A to Z");
    expect(html).toContain('aria-label="Sort tasks"');
  });

  it("publishes both halves of the state as data attributes, for the browser tests", () => {
    const html = menu({ mode: "priority", direction: "desc" });
    expect(html).toContain('data-sort-mode="priority"');
    expect(html).toContain('data-sort-direction="desc"');
  });

  it("says the SAME sentence for every mode and direction — no unlabelled combination", () => {
    for (const mode of SORT_MODES) {
      for (const direction of ["asc", "desc"] as const) {
        const label = sortTriggerLabel({ mode: mode.id, direction });
        expect(label).toContain(mode.label);
        expect(label).toContain(mode.directions[direction]);
        expect(label.toLowerCase()).not.toContain("undefined");
      }
    }
  });

  it("stays muted at the default and lights up once a choice has been made", () => {
    expect(isDefaultSort({ mode: "activity", direction: "asc" })).toBe(true);
    expect(isDefaultSort({ mode: "activity", direction: "desc" })).toBe(false);
    expect(isDefaultSort({ mode: "title", direction: "asc" })).toBe(false);
  });
});

describe("the menu body", () => {
  it("offers every registered mode, in registry order, as a radio", () => {
    const html = options({ mode: "activity", direction: "asc" });
    for (const mode of SORT_MODES) {
      expect(html, mode.id).toContain(`data-sort-option="${mode.id}"`);
      expect(html, mode.id).toContain(mode.label);
    }
    const positions = SORT_MODES.map((mode) => html.indexOf(`data-sort-option="${mode.id}"`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("carries a hint under every option, the way GroupByMenu does", () => {
    const html = options({ mode: "activity", direction: "asc" });
    for (const mode of SORT_MODES) expect(html, mode.id).toContain(escaped(mode.hint));
  });

  it("ticks exactly one mode and exactly one direction", () => {
    const html = options({ mode: "created", direction: "asc" });
    expect(html).toMatch(checkedRow("mode", "created"));
    expect(html).toMatch(checkedRow("direction", "asc"));
    expect(html.match(/aria-checked="true"/g)).toHaveLength(2);
  });

  it("labels the direction rows with the ACTIVE mode's words, so they change with it", () => {
    expect(options({ mode: "updated", direction: "desc" })).toContain("Newest first");
    expect(options({ mode: "title", direction: "asc" })).toContain("A to Z");
    expect(options({ mode: "title", direction: "asc" })).not.toContain("Newest first");
  });

  it("puts both choices in NAMED radiogroups — the whole of its keyboard story", () => {
    const html = options({ mode: "activity", direction: "asc" });
    expect(html).toContain('role="radiogroup" aria-label="Sort tasks by"');
    expect(html).toContain('role="radiogroup" aria-label="Sort direction"');
    // Real buttons, so Tab reaches them and Enter/Space activate them with no key handling.
    expect(html.match(/<button type="button" role="radio"/g)).toHaveLength(SORT_MODES.length + 2);
  });

  it("states the active mode's tie-break chain, and its rollup when it has one", () => {
    const html = options({ mode: "activity", direction: "asc" });
    expect(html).toContain("Ties break by priority, then newest update, then identifier");
    expect(html).toContain("a parent takes the best activity tier in its subtree");
  });

  it("says so plainly for the one mode whose primary key is already unique", () => {
    const html = options({ mode: "identifier", direction: "asc" });
    expect(html).toContain("identifiers are unique");
  });

  it("renders no rollup sentence for a mode that takes none", () => {
    const html = options({ mode: "priority", direction: "asc" });
    expect(html).not.toContain("Parents:");
  });

  it("turns every registry step into words — no raw step id ever reaches the screen", () => {
    for (const mode of SORT_MODES) {
      const sentence = tieBreakSentence(mode.tieBreak);
      expect(sentence, mode.id).not.toContain("updatedRecent");
      expect(sentence, mode.id).not.toContain("queuedFirst");
    }
  });
});
