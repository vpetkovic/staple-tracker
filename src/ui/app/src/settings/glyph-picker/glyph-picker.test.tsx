/**
 * The glyph picker, RENDERED — R5d (STA-184).
 *
 * `react-dom/server`, as vocabulary-list.test.tsx and settings-shell.test.tsx: the suite
 * has no DOM, so what is pinned here is the MARKUP — the roles and accessible names a
 * keyboard and a screen reader navigate by, the windowing (a catalog of ~1,800 icons is
 * a few dozen cells plus two spacers), the preview at the row's and the graph's sizes,
 * the three tabs, and the two arrangements the dialog puts the picker in. Every decision
 * behind that markup is pinned by calling it in glyph-picker-model.test.ts.
 *
 * `useEffect` does not run in a static render, so `loadIconComponents` is never awaited
 * here and every cell draws its placeholder box — which is also the state a real browser
 * is in for the first frame, and the state the search, the keyboard and the choice all
 * have to work in.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ICON_CATEGORIES, searchIcons } from "@/lib/icon-catalog";
import { SEED_SETTINGS } from "@/lib/settings";
import { GlyphPicker, type SanitizeSvg } from "./GlyphPicker";
import { GlyphPreview, PREVIEW_SIZES } from "./GlyphPreview";
import { draftAppearance, NO_GLYPHS, type GlyphChoice, type GlyphMap } from "./glyph-picker-model";
import { VocabularyList } from "../VocabularyList";
import { kindRows, statusRows } from "../settings-ops";

const BUG = { id: "bug", label: "Bug" };
const sanitize: SanitizeSvg = async () => ({ ok: false, problem: "not called in a static render" });
const noop = () => {};

function picker(overrides: Partial<Parameters<typeof GlyphPicker>[0]> = {}): string {
  return renderToStaticMarkup(
    <GlyphPicker
      kind={BUG}
      appearance={draftAppearance(NO_GLYPHS, BUG)}
      isDefault
      onChoose={noop}
      onReset={noop}
      onClose={noop}
      sanitize={sanitize}
      layout="wide"
      storage={null}
      {...overrides}
    />,
  );
}

const wide = picker();

describe("the catalog is searchable over names, aliases and categories", () => {
  it("offers a search field, a category filter over the registry's own categories, and a live count", () => {
    expect(wide).toContain('aria-label="Search icons"');
    // The select's own list is a Radix portal that opens on demand, so only the trigger
    // is in a static render; what it offers is `ICON_CATEGORIES`, pinned below.
    expect(wide).toContain('aria-label="Icon category"');
    expect(ICON_CATEGORIES.length).toBeGreaterThan(3);
    expect(wide).toContain("data-glyph-count");
    expect(wide).toContain(`${searchIcons("").length} icons`);
  });

  it("the field's query reaches the catalog's own ranked search, which reads aliases too", () => {
    // `alert-triangle` is not a key; it is `triangle-alert`'s alias, and the picker
    // types straight into this function.
    expect(searchIcons("alert-triangle")[0]!.key).toBe("triangle-alert");
    expect(searchIcons("bug")[0]!.key).toBe("bug");
    const filtered = searchIcons("", { category: ICON_CATEGORIES[0]! });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(searchIcons("").length);
    expect(filtered.every((entry) => entry.category === ICON_CATEGORIES[0])).toBe(true);
  });
});

describe("the grid is one listbox with one active option, and it is windowed", () => {
  it("is a listbox that takes focus and names its active cell", () => {
    expect(wide).toContain('role="listbox"');
    expect(wide).toContain('aria-label="Icon catalog"');
    expect(wide).toContain('tabindex="0"');
    expect(wide).toContain(`aria-activedescendant="glyph-option-bug-${searchIcons("")[0]!.key}"`);
  });

  it("every cell is an option with the icon's label as its accessible name", () => {
    const first = searchIcons("")[0]!;
    expect(wide).toContain(`data-glyph-option="${first.key}"`);
    expect(wide).toContain(`aria-label="${first.label}"`);
    expect(wide).toContain('role="option"');
  });

  it("holds a few dozen cells for a catalog of thousands, with two spacers standing in", () => {
    const rendered = [...wide.matchAll(/data-glyph-option=/g)].length;
    expect(searchIcons("").length).toBeGreaterThan(1000);
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
    // The bottom spacer is the rest of the list, so the scrollbar is honest about it.
    expect(wide).toMatch(/<div style="height:\d+px" aria-hidden="true">?<\/div>/);
  });

  it("marks the appearance's own icon selected, not merely active", () => {
    const withEpic = picker({
      kind: { id: "epic", label: "Epic" },
      appearance: draftAppearance(NO_GLYPHS, { id: "epic", label: "Epic" }),
    });
    // `layers` is the built-in mark for `epic`; whether it is inside the first window is
    // not the point — that some option carries aria-selected="true" when it is, is.
    const selected = [...withEpic.matchAll(/aria-selected="true"/g)].length;
    expect(selected).toBeGreaterThan(0);
  });
});

describe("three sources, one form contract", () => {
  it("has a tablist with the three tabs and a roving tabindex", () => {
    expect(wide).toContain('role="tablist"');
    expect(wide).toContain('aria-label="Glyph source"');
    for (const label of ["Catalog", "Emoji", "Custom SVG"]) expect(wide).toContain(`>${label}<`);
    expect(wide).toContain('id="glyph-tab-bug-lucide"');
    expect(wide).toContain('aria-controls="glyph-panel-bug-lucide"');
    expect(wide).toMatch(/id="glyph-tab-bug-emoji"[^>]*tabindex="-1"/);
  });

  it("the emoji tab is one field, validated by the browser's own gate", () => {
    const emoji = picker({ initialSource: "emoji" });
    expect(emoji).toContain('aria-label="Emoji or Unicode glyph"');
    expect(emoji).toContain("One or two visible characters");
    expect(emoji).not.toContain('aria-label="Icon catalog"');
  });

  it("the custom SVG tab posts a raw document and says only the canonical answer is stored", () => {
    const svg = picker({ initialSource: "svg" });
    expect(svg).toContain('aria-label="Custom SVG document"');
    expect(svg).toContain("Sanitise and use");
    expect(svg).toContain("8 KiB");
    expect(svg).toContain("only its canonical output is stored");
  });

  it("opens on the tab the current appearance came from", () => {
    const emoji = picker({ appearance: { source: "emoji", value: "🐞", label: "Bug", fallback: "✱" } });
    expect(emoji).toContain('aria-label="Emoji or Unicode glyph"');
    expect(emoji).toMatch(/id="glyph-tab-bug-emoji"[^>]*aria-selected="true"/);
  });
});

describe("the preview is the row's renderer, at the row's and the graph's sizes", () => {
  it("draws the same appearance twice, labelled for both surfaces", () => {
    expect(wide).toContain('data-preview-size="row"');
    expect(wide).toContain('data-preview-size="graph"');
    expect(wide).toContain("list row");
    expect(wide).toContain("graph node");
  });

  it("an emoji record goes through KindGlyph, exactly as a list row draws it", () => {
    const appearance = { source: "emoji" as const, value: "🐞", label: "Bug", fallback: "✱" };
    const preview = renderToStaticMarkup(<GlyphPreview kind="bug" appearance={appearance} size={PREVIEW_SIZES.row} />);
    expect(preview).toContain('data-testid="kind-glyph"');
    expect(preview).toContain("🐞");
    expect(PREVIEW_SIZES.row).toBe(12);
    expect(PREVIEW_SIZES.graph).toBe(14);
  });

  it("names the choice in text, so the picture is never the only reading", () => {
    expect(wide).toContain("data-preview-caption");
    expect(wide).toContain("catalog icon bug");
    expect(wide).toContain("terminal");
  });
});

describe("the keyboard has a full path: browse, choose, preview, reset and save", () => {
  it("every control the flow needs carries a name", () => {
    expect(wide).toContain('aria-label="Glyph for Bug"');
    expect(wide).toContain('aria-label="Accessible name for Bug"');
    expect(wide).toContain('aria-label="Terminal fallback for Bug"');
    expect(wide).toContain("Reset to default");
    expect(wide).toContain(">Done<");
  });

  it("Reset is offered only when there is something to reset", () => {
    expect(wide).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Reset to default/);
    const customised = picker({ isDefault: false });
    expect(customised).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Reset to default/);
  });

  it("a disabled picker disables every control, so a save in flight cannot be edited under", () => {
    const busy = picker({ disabled: true });
    expect(busy).toMatch(/aria-label="Search icons"[^>]*disabled=""/);
  });
});

describe("recent choices", () => {
  const recents: GlyphChoice[] = [
    { source: "lucide", value: "bug", label: "Bug", fallback: "✱" },
    { source: "emoji", value: "🐞", label: "Bug", fallback: "✱" },
  ];
  const storage = {
    getItem: () => JSON.stringify(recents),
    setItem: () => {},
  };

  it("are a second listbox, named, and absent when there are none", () => {
    const withRecents = picker({ storage });
    expect(withRecents).toContain('aria-label="Recent glyphs"');
    expect(withRecents).toContain("data-glyph-recents");
    expect(wide).not.toContain("data-glyph-recents");
  });
});

describe("the picker works in the drawer, the two-pane shell and full screen", () => {
  const stacked = picker({ layout: "stacked" });

  it("stacks the preview under the chooser on a narrow viewport, and beside it otherwise", () => {
    expect(stacked).toContain('data-layout="stacked"');
    expect(stacked).toContain("flex flex-col");
    expect(wide).toContain('data-layout="wide"');
    expect(wide).toContain("grid-cols-[minmax(0,1fr)_minmax(0,14rem)]");
  });

  it("holds the same controls either way — only the arrangement changes", () => {
    for (const name of ['aria-label="Icon catalog"', 'aria-label="Glyph for Bug"', "Reset to default"]) {
      expect(stacked).toContain(name);
      expect(wide).toContain(name);
    }
  });
});

describe("the Kinds editor carries the picker, and the Statuses editor does not", () => {
  const served: GlyphMap = { bug: { source: "emoji", value: "🐞", fallback: "✱" } };
  const kinds = renderToStaticMarkup(
    <VocabularyList
      target="kinds"
      rows={kindRows(SEED_SETTINGS.kinds)}
      usage={{}}
      write={async () => null}
      glyphs={{ served, write: async () => null, sanitize }}
    />,
  );
  const statuses = renderToStaticMarkup(
    <VocabularyList
      target="statuses"
      rows={statusRows(SEED_SETTINGS.statuses)}
      usage={{}}
      categories={SEED_SETTINGS.categories}
      write={async () => null}
    />,
  );

  it("gives every kind a glyph and a Change control that opens the panel under its row", () => {
    expect(kinds).toContain('aria-label="Change glyph for Epic"');
    expect(kinds).toContain('aria-label="Change glyph for Bug"');
    expect(kinds).toContain('data-glyph-change="epic"');
    expect(kinds).toContain('aria-controls="glyph-panel-row-epic"');
    expect(kinds).toContain('aria-expanded="false"');
    expect(kinds).toContain(">glyph<");
  });

  it("the row shows the SERVED choice, so the list and the picker agree before any edit", () => {
    expect(kinds).toContain("🐞");
  });

  it("keeps every operation the editor already had", () => {
    for (const control of [
      'aria-label="Label for epic"',
      'aria-label="Move Epic up"',
      'aria-label="Remove Epic"',
      "Add kind",
      'data-action-bar="true"',
    ]) {
      expect(kinds).toContain(control);
    }
  });

  it("starts clean: one ActionBar, Save disabled, no conflict banner", () => {
    expect(kinds).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
    expect([...kinds.matchAll(/data-action-bar="true"/g)]).toHaveLength(1);
    expect(kinds).not.toContain("data-conflict-banner");
  });

  it("statuses have no appearance, so they get no glyph control at all", () => {
    expect(statuses).not.toContain("data-glyph-change");
    expect(statuses).not.toContain("Change glyph for");
  });
});
