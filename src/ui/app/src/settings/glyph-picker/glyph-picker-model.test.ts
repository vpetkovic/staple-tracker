/**
 * What the glyph picker DECIDES — R5d (STA-184).
 *
 * Same shape as form/vocabulary-draft.test.ts: no DOM, no fetch, one call per rule. The
 * markup is glyph-picker.test.tsx; this is the arithmetic under it — the one form
 * contract, the gate a choice passes, the map the Kinds draft carries and the op Save
 * posts for it, the windowed grid and its keyboard, and the bounded recents list.
 */
import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../../../../../core/svg-sanitize.js";
import type { WorkspaceSettingsEnvelope } from "../../lib/settings";
import { SEED_SETTINGS } from "../../lib/settings";
import {
  changedGlyphs,
  choiceOf,
  draftAppearance,
  emojiChoice,
  fallbackProblem,
  glyphChoiceProblem,
  glyphMapOps,
  gridColumns,
  gridWindow,
  isGlyphMapDirty,
  labelProblem,
  lucideChoice,
  moveActive,
  NO_GLYPHS,
  pushRecent,
  readRecents,
  RECENTS_KEY,
  RECENTS_MAX,
  scrollTopFor,
  servedGlyphMap,
  svgChoice,
  toStoredGlyph,
  withGlyph,
  writeRecents,
  type GlyphChoice,
  type GlyphMap,
} from "./glyph-picker-model";
import { resolveIcon } from "../../lib/icon-catalog";

const BUG = resolveIcon("bug")!;
const CURRENT = { label: "Bug", fallback: "✱" };
/** A real canonical document, from the sanitiser itself — the only kind the gate accepts. */
const CANONICAL = (() => {
  const result = sanitizeSvg('<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4"/></svg>', { label: "Bug" });
  if (!result.ok) throw new Error(result.problem);
  return result.svg;
})();

describe("one contract for three sources", () => {
  it("a catalog entry, an emoji and a sanitised SVG are the same four fields", () => {
    const three = [
      lucideChoice(BUG, CURRENT),
      emojiChoice("🐞", CURRENT),
      svgChoice(CANONICAL, CURRENT),
    ];
    for (const choice of three) {
      expect(Object.keys(choice).sort()).toEqual(["fallback", "label", "source", "value"]);
      expect(choice.label).toBe("Bug");
      expect(choice.fallback).toBe("✱");
    }
    expect(three.map((c) => c.source)).toEqual(["lucide", "emoji", "svg"]);
    expect(three[0]!.value).toBe("bug");
  });

  it("the stored record drops a label that is the kind's own, so a rename keeps being heard", () => {
    expect(toStoredGlyph(lucideChoice(BUG, CURRENT), "Bug")).toEqual({
      source: "lucide",
      value: "bug",
      fallback: "✱",
    });
    expect(toStoredGlyph(lucideChoice(BUG, { ...CURRENT, label: "Defect" }), "Bug")).toEqual({
      source: "lucide",
      value: "bug",
      fallback: "✱",
      label: "Defect",
    });
  });

  it("choiceOf round-trips a resolved appearance, and answers null for the built-in mark", () => {
    const appearance = draftAppearance(NO_GLYPHS, { id: "bug", label: "Bug" });
    expect(choiceOf(appearance)).toEqual({ source: "lucide", value: "bug", label: "Bug", fallback: "✱" });
    expect(choiceOf({ source: "none", value: "", label: "Research", fallback: "•" })).toBeNull();
  });
});

describe("the gate is a mirror, and an svg is only ever the sanitiser's output", () => {
  it("accepts a catalog key, an alias-resolved key, an emoji and a canonical document", () => {
    expect(glyphChoiceProblem(lucideChoice(BUG, CURRENT))).toBeNull();
    expect(glyphChoiceProblem(emojiChoice("🐞", CURRENT))).toBeNull();
    expect(glyphChoiceProblem(svgChoice(CANONICAL, CURRENT))).toBeNull();
  });

  it("refuses a key the catalog does not have", () => {
    const problem = glyphChoiceProblem({ source: "lucide", value: "not-an-icon", ...CURRENT });
    expect(problem).toContain("not an icon in the catalog");
  });

  it("refuses an emoji that is three graphemes, or carries whitespace", () => {
    expect(glyphChoiceProblem(emojiChoice("abc", CURRENT))).not.toBeNull();
    expect(glyphChoiceProblem(emojiChoice("a b", CURRENT))).not.toBeNull();
  });

  it("refuses a RAW svg, however harmless — only the canonical fixed point is a choice", () => {
    const raw = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4"/></svg>';
    expect(glyphChoiceProblem(svgChoice(raw, CURRENT))).toContain("sanitised");
    expect(glyphChoiceProblem(svgChoice(CANONICAL, CURRENT))).toBeNull();
  });

  it("holds the two text bounds core states", () => {
    expect(fallbackProblem("")).not.toBeNull();
    expect(fallbackProblem("✱")).toBeNull();
    expect(fallbackProblem("abcde")).not.toBeNull();
    expect(fallbackProblem("a\nb")).not.toBeNull();
    expect(labelProblem("x".repeat(80))).toBeNull();
    expect(labelProblem("x".repeat(81))).not.toBeNull();
    expect(glyphChoiceProblem({ ...lucideChoice(BUG, CURRENT), fallback: "" })).not.toBeNull();
  });
});

describe("the map inside the Kinds draft", () => {
  const stored = { source: "emoji" as const, value: "🐞", fallback: "✱" };

  it("sets, replaces and resets one kind without touching the others", () => {
    const one = withGlyph(NO_GLYPHS, "bug", stored);
    const two = withGlyph(one, "task", { source: "emoji", value: "✅", fallback: "◇" });
    expect(Object.keys(two).sort()).toEqual(["bug", "task"]);
    expect(withGlyph(two, "bug", null)).toEqual({ task: { source: "emoji", value: "✅", fallback: "◇" } });
    // The input is never mutated: Cancel is dropping a reference.
    expect(NO_GLYPHS).toEqual({});
  });

  it("is dirty against the served map, and counts what changed", () => {
    const served: GlyphMap = { bug: stored };
    expect(isGlyphMapDirty(served, served)).toBe(false);
    expect(isGlyphMapDirty(withGlyph(served, "task", stored), served)).toBe(true);
    expect(changedGlyphs(served, served)).toBe(0);
    expect(changedGlyphs(served, withGlyph(served, "task", stored))).toBe(1);
    expect(changedGlyphs(served, withGlyph(served, "bug", null))).toBe(1);
  });

  it("Save posts one `set` of the whole map, naming only configured kinds", () => {
    const draft = withGlyph(withGlyph(NO_GLYPHS, "bug", stored), "gone", stored);
    expect(glyphMapOps(NO_GLYPHS, draft, ["bug", "task"])).toEqual([
      { op: "set", key: "kinds.appearance", value: { bug: stored } },
    ]);
  });

  it("Save posts `reset` when nothing is customised any more, and nothing when nothing moved", () => {
    const served: GlyphMap = { bug: stored };
    expect(glyphMapOps(served, NO_GLYPHS, ["bug"])).toEqual([{ op: "reset", key: "kinds.appearance" }]);
    expect(glyphMapOps(served, served, ["bug"])).toEqual([]);
  });

  it("draftAppearance shows what Save will produce, resolving the label against the kind", () => {
    const map = withGlyph(NO_GLYPHS, "bug", { ...stored, label: "Defect" });
    expect(draftAppearance(map, { id: "bug", label: "Bug" })).toEqual({
      source: "emoji",
      value: "🐞",
      label: "Defect",
      fallback: "✱",
    });
    // No stored label: the kind's own, so renaming the kind renames what is announced.
    expect(draftAppearance(withGlyph(NO_GLYPHS, "bug", stored), { id: "bug", label: "Defect" }).label).toBe("Defect");
    // No entry at all: the built-in mark.
    expect(draftAppearance(NO_GLYPHS, { id: "epic", label: "Epic" })).toEqual({
      source: "lucide",
      value: "layers",
      label: "Epic",
      fallback: "◆",
    });
  });

  it("reads the served map out of the envelope, dropping anything not shaped like a record", () => {
    const envelope = {
      ...SEED_SETTINGS,
      registry: { categories: [], definitions: [] },
      values: {
        "kinds.appearance": {
          key: "kinds.appearance",
          scope: "workspace" as const,
          value: { bug: stored, junk: "nope" },
          source: "workspace" as const,
          version: 1,
        },
      },
      unknownKeys: [],
      global: { path: "", present: false, values: {} },
    } as WorkspaceSettingsEnvelope;
    expect(servedGlyphMap(envelope)).toEqual({ bug: stored });
    expect(servedGlyphMap({ ...envelope, values: {} })).toEqual({});
  });
});

describe("the windowed grid", () => {
  const grid = { count: 1800, columns: 10, rowHeight: 44, viewportHeight: 240 };

  it("renders a viewport's worth plus an overscan, whatever the catalog's size", () => {
    // ceil(240/44) = 6 viewport rows, plus 2 overscan rows either side. At the top the
    // upper overscan is clamped away, which is the only reason the two differ.
    const top = gridWindow({ ...grid, scrollTop: 0 });
    expect(top.start).toBe(0);
    expect(top.end - top.start).toBe(8 * 10);
    const deep = gridWindow({ ...grid, scrollTop: 4400 });
    expect(deep.end - deep.start).toBe(10 * 10);
    expect(deep.start).toBe(98 * 10);
  });

  it("the two spacers keep the scrollbar honest about the whole list", () => {
    const rows = Math.ceil(1800 / 10);
    const window = gridWindow({ ...grid, scrollTop: 4400 });
    const rendered = Math.ceil((window.end - window.start) / 10) * 44;
    expect(window.topPad + rendered + window.bottomPad).toBe(rows * 44);
  });

  it("never runs past the end, and an empty result is an empty window", () => {
    expect(gridWindow({ ...grid, scrollTop: 999999 }).end).toBe(1800);
    expect(gridWindow({ ...grid, count: 0, scrollTop: 0 })).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
  });

  it("a narrow drawer still reads as a grid", () => {
    expect(gridColumns(880, 44)).toBe(20);
    expect(gridColumns(100, 44)).toBe(4);
  });

  it("arrows step a cell or a row, Home and End jump, and nothing wraps", () => {
    const at = (index: number, key: string) => moveActive({ index, key, columns: 10, count: 100 });
    expect(at(0, "ArrowRight")).toBe(1);
    expect(at(0, "ArrowLeft")).toBe(0);
    expect(at(0, "ArrowDown")).toBe(10);
    expect(at(5, "ArrowUp")).toBe(0);
    expect(at(99, "ArrowRight")).toBe(99);
    expect(at(99, "ArrowDown")).toBe(99);
    expect(at(42, "Home")).toBe(0);
    expect(at(42, "End")).toBe(99);
    expect(at(42, "a")).toBeNull();
    expect(moveActive({ index: 0, key: "End", columns: 10, count: 0 })).toBeNull();
  });

  it("keeps the active cell in view, moving as little as possible", () => {
    const at = (index: number, scrollTop: number) =>
      scrollTopFor({ index, columns: 10, rowHeight: 44, scrollTop, viewportHeight: 240 });
    expect(at(5, 0)).toBe(0);
    expect(at(60, 0)).toBe(44 * 7 - 240);
    expect(at(5, 400)).toBe(0);
  });
});

describe("recents are bounded, and never carry a document", () => {
  const choice = (value: string): GlyphChoice => ({ source: "lucide", value, label: "Bug", fallback: "✱" });

  it("puts the newest first, once", () => {
    const once = pushRecent([choice("bug"), choice("zap")], choice("zap"));
    expect(once.map((c) => c.value)).toEqual(["zap", "bug"]);
  });

  it("stops at the maximum", () => {
    let recents: GlyphChoice[] = [];
    for (let i = 0; i < RECENTS_MAX + 5; i += 1) recents = pushRecent(recents, choice(`icon-${i}`));
    expect(recents).toHaveLength(RECENTS_MAX);
  });

  it("does not remember an svg — a canonical document is up to 8 KiB", () => {
    expect(pushRecent([], svgChoice(CANONICAL, CURRENT))).toEqual([]);
  });

  it("round-trips through storage, and survives anything malformed", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    writeRecents(storage, [choice("bug")]);
    expect(readRecents(storage)).toEqual([choice("bug")]);
    store.set(RECENTS_KEY, "{not json");
    expect(readRecents(storage)).toEqual([]);
    store.set(RECENTS_KEY, JSON.stringify([{ source: "svg", value: "x", label: "", fallback: "" }, 3]));
    expect(readRecents(storage)).toEqual([]);
    expect(readRecents(null)).toEqual([]);
  });

  it("private mode is a no-op, not a throw", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readRecents(hostile)).toEqual([]);
    expect(() => writeRecents(hostile, [choice("bug")])).not.toThrow();
  });
});
