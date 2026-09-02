/**
 * R7 (STA-103) — the searchable select, tested where it can be quietly wrong.
 *
 * Two halves, and only one of them is visible to a reviewer opening the page:
 *
 *  1. The MATCHING. `filterOptions` is why the control is worth building — a box that
 *     filters on the identifier but not the title, or that breaks on a two-word query,
 *     looks identical in a screenshot to one that works.
 *  2. The CREATE OFFER. "Type a new label, press enter" is one keystroke away from
 *     "silently create a second label that differs from the first by nothing", and the
 *     difference is entirely in `shouldOfferCreate`.
 *
 * The render asserts at the bottom pin the one structural promise the ticket makes about
 * the chips: a selected cross-project reference keeps its workspace indication AFTER
 * selection, not only while the list is open. Rendered to a string via react-dom/server,
 * the way the row tests do — the popover's contents are closed and out of scope here,
 * which is precisely why the chips are what gets asserted.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SearchableSelect,
  filterOptions,
  resolvePaste,
  shouldOfferCreate,
  type SelectOption,
} from "./searchable-select";

const OPTIONS: SelectOption[] = [
  { value: "STA-13", label: "STA-13", hint: "Ship the create dialog", pill: "staple" },
  { value: "STA-9", label: "STA-9", hint: "Row list extraction", pill: "staple" },
  { value: "PC-4", label: "PC-4", hint: "Ship the pinecone importer", pill: "pinecone" },
];

describe("filterOptions", () => {
  it("returns everything for an empty or whitespace-only query", () => {
    expect(filterOptions(OPTIONS, "")).toHaveLength(3);
    expect(filterOptions(OPTIONS, "   ")).toHaveLength(3);
  });

  it("matches on the identifier", () => {
    expect(filterOptions(OPTIONS, "STA-13").map((o) => o.value)).toEqual(["STA-13"]);
  });

  it("matches on a word from the title, which is how you find a task you cannot number", () => {
    expect(filterOptions(OPTIONS, "row list").map((o) => o.value)).toEqual(["STA-9"]);
  });

  it("is case-insensitive in both directions", () => {
    expect(filterOptions(OPTIONS, "sta-9").map((o) => o.value)).toEqual(["STA-9"]);
    expect(filterOptions(OPTIONS, "SHIP").map((o) => o.value)).toEqual(["STA-13", "PC-4"]);
  });

  /**
   * Every token must hit, and they may hit different fields. "ship pinecone" is one
   * word of a title plus a workspace name, which is exactly how someone narrows two
   * similarly-titled tasks in a hub — a naive substring match on the whole query finds
   * neither, because that string appears in no single field.
   */
  it("requires every token, across any field", () => {
    expect(filterOptions(OPTIONS, "ship pinecone").map((o) => o.value)).toEqual(["PC-4"]);
    expect(filterOptions(OPTIONS, "ship nonsense")).toEqual([]);
  });

  it("matches on the workspace pill", () => {
    expect(filterOptions(OPTIONS, "staple").map((o) => o.value)).toEqual(["STA-13", "STA-9"]);
  });

  it("preserves the caller's order rather than imposing a relevance score", () => {
    expect(filterOptions(OPTIONS, "sta").map((o) => o.value)).toEqual(["STA-13", "STA-9"]);
  });
});

describe("shouldOfferCreate", () => {
  const labels: SelectOption[] = [
    { value: "ui", label: "ui" },
    { value: "needs review", label: "needs review" },
  ];

  it("offers nothing for an empty query", () => {
    expect(shouldOfferCreate("", labels, [])).toBe(false);
    expect(shouldOfferCreate("   ", labels, [])).toBe(false);
  });

  it("offers a novel value", () => {
    expect(shouldOfferCreate("api", labels, [])).toBe(true);
  });

  /**
   * The load-bearing one. An existing label typed in full must NOT offer "create" — the
   * option is right there in the filtered list, and a create affordance beside it is an
   * invitation to make a duplicate.
   */
  it("does not offer a value that already exists", () => {
    expect(shouldOfferCreate("ui", labels, [])).toBe(false);
    expect(shouldOfferCreate("  needs review  ", labels, [])).toBe(false);
  });

  it("does not offer a value that exists in a different case", () => {
    expect(shouldOfferCreate("UI", labels, [])).toBe(false);
  });

  /**
   * A value created a moment ago is selected but is in nobody's option list yet, because
   * the options are derived from issues the server has already stored. Without this the
   * control offers to create the same new label twice in one sitting.
   */
  it("does not offer a value that is already selected", () => {
    expect(shouldOfferCreate("api", labels, ["api"])).toBe(false);
    expect(shouldOfferCreate("API", labels, ["api"])).toBe(false);
  });
});

describe("resolvePaste", () => {
  const expand = (text: string) => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

  it("adds every pasted ref that names a real option", () => {
    expect(resolvePaste("STA-13, STA-9", expand, OPTIONS)).toEqual(["STA-13", "STA-9"]);
  });

  /**
   * The safety, and the reason this is not just `expand`. A ref that names nothing is
   * dropped here rather than becoming a chip that rides all the way to a store refusal
   * at submit time — which is the late, silent failure the whole control exists to end.
   */
  it("drops a pasted ref that names nothing", () => {
    expect(resolvePaste("STA-13, oops", expand, OPTIONS)).toEqual(["STA-13"]);
    expect(resolvePaste("nothing at all", expand, OPTIONS)).toEqual([]);
  });

  it("returns the option's own casing, not the pasted casing", () => {
    expect(resolvePaste("sta-13", expand, OPTIONS)).toEqual(["STA-13"]);
  });

  it("is empty for empty text", () => {
    expect(resolvePaste("", expand, OPTIONS)).toEqual([]);
  });
});

describe("SearchableSelect rendering", () => {
  const html = (selected: string[], multiple = true) =>
    renderToStaticMarkup(
      <SearchableSelect
        name="blocked-by"
        options={OPTIONS}
        selected={selected}
        onChange={() => {}}
        multiple={multiple}
        placeholder="Nothing blocking this"
        actionLabel="Add another blocker"
      />,
    );

  it("renders a trigger the browser evidence can find", () => {
    expect(html([])).toContain('data-searchable-select="blocked-by"');
  });

  it("renders no chip row when nothing is selected", () => {
    expect(html([])).not.toContain("data-select-chip");
  });

  /**
   * Caught by looking at a screenshot, not by a test — the first cut left the trigger
   * reading "No parent" above a chip reading STA-11, so the control contradicted itself
   * in the one place a user checks to see what it holds. Pinned here so it stays fixed.
   */
  it("swaps the trigger from a placeholder to an action once something is chosen", () => {
    expect(html([])).toContain("Nothing blocking this");
    expect(html([])).not.toContain("Add another blocker");

    expect(html(["STA-13"])).toContain("Add another blocker");
    expect(html(["STA-13"])).not.toContain("Nothing blocking this");
  });

  /**
   * Requirement 3, after selection. The pill is not decoration on the option list — it
   * has to survive onto the chip, or the form forgets which project it is pointing at
   * the moment the list closes.
   */
  it("keeps the workspace indication on the selected chip", () => {
    const out = html(["PC-4"]);
    expect(out).toContain('data-select-chip="PC-4"');
    expect(out).toContain('data-chip-workspace="pinecone"');
    expect(out).toContain("pinecone");
  });

  it("renders one chip per selection", () => {
    const out = html(["STA-13", "PC-4"]);
    expect(out).toContain('data-select-chip="STA-13"');
    expect(out).toContain('data-select-chip="PC-4"');
  });

  /** A just-created label has no option behind it, so it has no pill — and must still chip. */
  it("chips a value that is not in the option list", () => {
    const out = renderToStaticMarkup(
      <SearchableSelect
        name="labels"
        options={[]}
        selected={["brand new"]}
        onChange={() => {}}
        multiple
        placeholder="No labels"
        actionLabel="Add another label"
      />,
    );
    expect(out).toContain('data-select-chip="brand new"');
    expect(out).not.toContain("data-chip-workspace");
  });
});
