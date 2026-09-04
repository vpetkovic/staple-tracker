import { describe, expect, it } from "vitest";
import {
  BUILTIN_KIND_APPEARANCE,
  EMOJI_MAX_GRAPHEMES,
  EMOJI_MAX_UNITS,
  GENERIC_KIND_FALLBACK,
  KIND_APPEARANCE_SOURCES,
  LUCIDE_KEY_PATTERN,
  emojiGlyphProblem,
  kindAppearanceMapProblem,
  kindAppearanceProblem,
  resolveKindAppearance,
  type StoredKindAppearance,
} from "../src/core/kind-appearance.js";
import { sanitizeSvg } from "../src/core/svg-sanitize.js";
import { BUILTIN_KIND_SEED } from "../src/core/types.js";
import * as mirror from "../src/ui/app/src/lib/kind-appearance.js";

/**
 * R5a (STA-181) — kind appearance as a pure module.
 *
 * Three claims. The built-in table names Lucide-SHAPED keys with a terminal
 * fallback that is one text-presentation glyph each (that each key is canonical
 * in the generated catalog is proven browser-side, in
 * `src/ui/app/src/lib/kind-appearance.test.ts`, since core deliberately cannot
 * import the catalog and the catalog cannot be reached from here). Resolution
 * is deterministic and total: the same kind and the same stored record give the
 * same answer, and there is no kind that gets none. And the validator is the
 * colour guard: a record can name a source, a value, a label and a fallback,
 * and nothing else. The store and the surfaces are exercised in their own
 * suites; nothing here touches a database.
 *
 * R5c (STA-183) adds two: an `emoji` value is bounded by GRAPHEMES, not units,
 * and an `svg` value is accepted only as the sanitiser's canonical output —
 * and a stored record that no longer validates resolves to the fallback mark
 * rather than throwing.
 */

/** The sanitiser's canonical output for a small clean document — the only svg value the validator accepts. */
const canonicalSvg = (label = "Flask") => {
  const result = sanitizeSvg('<svg viewBox="0 0 16 16"><path d="M4 2h8v12H4z"/></svg>', { label });
  if (!result.ok) throw new Error(result.problem);
  return result.svg;
};

const seededIds = BUILTIN_KIND_SEED.map((kind) => kind.id);

describe("the built-in marks", () => {
  it("cover every seeded kind and milestone, each a Lucide-shaped key", () => {
    for (const id of [...seededIds, "milestone"]) {
      const mark = BUILTIN_KIND_APPEARANCE[id];
      expect(mark, id).toBeDefined();
      expect(mark!.source).toBe("lucide");
      expect(mark!.value).toMatch(LUCIDE_KEY_PATTERN);
    }
  });

  it("give the terminal one glyph each, distinct, and none an emoji that would be two columns wide", () => {
    const fallbacks = Object.values(BUILTIN_KIND_APPEARANCE).map((mark) => mark.fallback);
    expect(new Set(fallbacks).size).toBe(fallbacks.length);
    for (const fallback of [...fallbacks, GENERIC_KIND_FALLBACK]) {
      expect([...fallback]).toHaveLength(1);
      expect(fallback).not.toMatch(/\p{Emoji_Presentation}/u);
    }
  });

  it("hold the browser's gate to the sanitiser's real output: canonical passes, raw and hostile do not (R5c)", () => {
    const documents = [
      '<svg viewBox="0 0 16 16"><title>T</title><path d="M0 0"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" style="color:red"><g fill="#f00" stroke="blue"><path d="M4 4h16v16H4z" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none"/></g></svg>',
      '<svg viewBox="-8 -8 16 16" preserveAspectRatio="xMidYMid" fill="#000"><title>A &amp; "B"</title><defs><path id="p" d="M0 0h8"/></defs><clipPath id="c"><rect width="8" height="8"/></clipPath><use xlink:href="#p" clip-path="url(#c)"/><polygon points="0,0 8,0 4,8" transform="rotate(45)"/></svg>',
    ];
    for (const document of documents) {
      const result = sanitizeSvg(document, { label: "Label" });
      expect(result.ok, document).toBe(true);
      const canonical = (result as { svg: string; viewBox: string }).svg;
      expect(mirror.isCanonicalSvg(canonical), canonical).toBe(true);
      expect(mirror.safeGlyph({ source: "svg", value: canonical, label: "Label" })).toMatchObject({ source: "svg", viewBox: (result as { viewBox: string }).viewBox });
      // Raw never passes the browser's gate either, however clean.
      expect(mirror.isCanonicalSvg(document)).toBe(false);
    }
    for (const value of ["🚀", "👨‍👩‍👧‍👦", "🇺🇸", "→→", "→→→", "\u200d", "a b", "", "🚀".repeat(9)]) {
      expect(mirror.isEmojiGlyph(value), JSON.stringify(value)).toBe(emojiGlyphProblem(value) === null);
    }
    expect(mirror.EMOJI_MAX_GRAPHEMES).toBe(EMOJI_MAX_GRAPHEMES);
    expect(mirror.EMOJI_MAX_UNITS).toBe(EMOJI_MAX_UNITS);
  });

  it("are mirrored field for field in the browser module, which cannot import core", () => {
    expect(mirror.BUILTIN_KIND_APPEARANCE).toEqual(BUILTIN_KIND_APPEARANCE);
    expect(mirror.GENERIC_KIND_FALLBACK).toBe(GENERIC_KIND_FALLBACK);
    expect(mirror.KIND_APPEARANCE_SOURCES).toEqual(KIND_APPEARANCE_SOURCES);
    for (const kind of [...BUILTIN_KIND_SEED, { id: "milestone", label: "Milestone" }, { id: "research", label: "Research" }]) {
      expect(mirror.fallbackKindAppearance(kind)).toEqual(resolveKindAppearance(kind));
    }
  });
});

describe("resolution", () => {
  const epic = { id: "epic", label: "Epic" };
  const stored: StoredKindAppearance = { source: "emoji", value: "🚀", fallback: "E" };

  it("uses the built-in mark and the kind's own label when nothing is stored", () => {
    expect(resolveKindAppearance(epic)).toEqual({ source: "lucide", value: "layers", label: "Epic", fallback: "◆" });
    // A renamed kind is heard without re-saving its glyph.
    expect(resolveKindAppearance({ id: "spike", label: "Investigation" }).label).toBe("Investigation");
  });

  it("falls back to the generic mark for a kind nobody has given one", () => {
    expect(resolveKindAppearance({ id: "research", label: "Research" })).toEqual({
      source: "none",
      value: "",
      label: "Research",
      fallback: GENERIC_KIND_FALLBACK,
    });
  });

  it("prefers the stored record, and the stored label only when it is non-empty", () => {
    expect(resolveKindAppearance(epic, stored)).toEqual({ source: "emoji", value: "🚀", label: "Epic", fallback: "E" });
    expect(resolveKindAppearance(epic, { ...stored, label: "Initiative" }).label).toBe("Initiative");
    expect(resolveKindAppearance(epic, { ...stored, label: "   " }).label).toBe("Epic");
  });

  it("is deterministic: the same inputs give equal records every time", () => {
    expect(resolveKindAppearance(epic, stored)).toEqual(resolveKindAppearance(epic, stored));
    expect(resolveKindAppearance({ id: "zzz", label: "Zzz" })).toEqual(resolveKindAppearance({ id: "zzz", label: "Zzz" }));
  });

  it("resolves a stored record that no longer validates to the fallback mark, without throwing", () => {
    const hostile = { source: "svg", value: '<svg viewBox="0 0 16 16" onload="alert(1)"><script>x()</script></svg>', fallback: "s", label: "Bad" } as StoredKindAppearance;
    expect(resolveKindAppearance(epic, hostile)).toEqual(resolveKindAppearance(epic));
    expect(resolveKindAppearance({ id: "research", label: "Research" }, hostile)).toEqual({ source: "none", value: "", label: "Research", fallback: GENERIC_KIND_FALLBACK });
    // A raw (unsanitised) document, an over-long emoji, and a record missing its fallback: the same answer.
    for (const bad of [
      { source: "svg", value: '<svg viewBox="0 0 16 16"><title>T</title><path d="M0 0"/></svg>', fallback: "s" },
      { source: "emoji", value: "🚀🚀🚀", fallback: "e" },
      { source: "lucide", value: "layers" },
      { source: "svg", value: canonicalSvg(), fallback: "s", color: "#f00" },
    ] as unknown as StoredKindAppearance[]) {
      expect(resolveKindAppearance(epic, bad), JSON.stringify(bad)).toEqual({ source: "lucide", value: "layers", label: "Epic", fallback: "◆" });
    }
    // The stored label is not borrowed from a record that was thrown away.
    expect(resolveKindAppearance(epic, hostile).label).toBe("Epic");
  });
});

describe("validation", () => {
  const ok: StoredKindAppearance = { source: "lucide", value: "triangle-alert", fallback: "!" };

  it("accepts a Lucide key, an emoji, and none — each with a terminal fallback", () => {
    expect(kindAppearanceProblem(ok)).toBeNull();
    expect(kindAppearanceProblem({ source: "emoji", value: "🐛", fallback: "b", label: "Defect" })).toBeNull();
    expect(kindAppearanceProblem({ source: "none", value: "", fallback: GENERIC_KIND_FALLBACK })).toBeNull();
  });

  it("refuses a colour, or any other field it does not know — appearance is not a status hue", () => {
    expect(kindAppearanceProblem({ ...ok, color: "#ff0000" })).toMatch(/without "color"/);
    expect(kindAppearanceProblem({ ...ok, category: "active" })).toMatch(/without "category"/);
  });

  it("accepts custom SVG only as the sanitiser's canonical output, never the raw document", () => {
    expect(kindAppearanceProblem({ source: "svg", value: canonicalSvg(), fallback: "s" })).toBeNull();
    expect(kindAppearanceProblem({ source: "svg", value: canonicalSvg("Custom"), fallback: "s", label: "Custom" })).toBeNull();
    // Clean but raw: the sentence says what to do, and the raw markup never reaches disk.
    expect(kindAppearanceProblem({ source: "svg", value: '<svg viewBox="0 0 16 16"><title>T</title><path d="M0 0"/></svg>', fallback: "s" })).toMatch(
      /the sanitiser's canonical SVG for value/,
    );
    expect(kindAppearanceProblem({ source: "svg", value: "<svg/>", fallback: "s" })).toMatch(/viewBox .* for value/);
    // Hostile: refused with the sanitiser's reason.
    expect(kindAppearanceProblem({ source: "svg", value: `${canonicalSvg().slice(0, -6)}<script>alert(1)</script></svg>`, fallback: "s" })).toMatch(
      /without <script> elements for value/,
    );
    expect(kindAppearanceProblem({ source: "svg", value: canonicalSvg().replace("<path", '<path onclick="x()"'), fallback: "s" })).toMatch(/event handler/);
    expect(kindAppearanceProblem({ source: "svg", value: canonicalSvg().replace("<path", '<image href="https://evil.example/x.png"/><path'), fallback: "s" })).toMatch(/<image>/);
    expect(kindAppearanceProblem({ source: "svg", value: "<svg>" + "a".repeat(1024 * 1024), fallback: "s" })).toMatch(/at most 8192 bytes/);
    // A canonical document whose title no longer matches the record's label is still canonical: the title was fixed at sanitise time.
    expect(kindAppearanceProblem({ source: "svg", value: canonicalSvg("Flask"), fallback: "s", label: "Renamed" })).toBeNull();
  });

  it("bounds an emoji by grapheme clusters, so a joined family or a flag is one glyph and nine rockets are not", () => {
    expect(EMOJI_MAX_GRAPHEMES).toBe(2);
    for (const value of ["🚀", "👨‍👩‍👧‍👦", "🇺🇸", "1️⃣", "🏳️‍🌈", "→→", "é", "ǅ"]) {
      expect(emojiGlyphProblem(value), JSON.stringify(value)).toBeNull();
      expect(kindAppearanceProblem({ source: "emoji", value, fallback: "e" }), JSON.stringify(value)).toBeNull();
    }
    // Eleven UTF-16 units, one grapheme: the unit bound is a ceiling, not the count.
    expect("👨‍👩‍👧‍👦".length).toBe(11);
    expect("👨‍👩‍👧‍👦".length).toBeLessThanOrEqual(EMOJI_MAX_UNITS);
    for (const value of ["→→→", "🚀".repeat(9), "abc", "👨‍👩‍👧‍👦".repeat(3), "\u200d", "\ufe0f", "\u200d\u200d\ufe0f", "\ud83d", "a b", "\u0007", ""]) {
      expect(emojiGlyphProblem(value), JSON.stringify(value)).toMatch(/1 to 2 visible characters, at most 32 UTF-16 units/);
      expect(kindAppearanceProblem({ source: "emoji", value, fallback: "e" }), JSON.stringify(value)).toMatch(/emoji/);
    }
  });

  it("refuses a value that is not shaped like a Lucide key, and an emoji with whitespace or nothing", () => {
    for (const value of ["", "Triangle Alert", "triangle_alert", "-alert", "alert-", "a".repeat(65)]) {
      expect(kindAppearanceProblem({ ...ok, value }), value).toMatch(/Lucide icon key/);
    }
    expect(kindAppearanceProblem({ source: "emoji", value: "", fallback: "e" })).toMatch(/emoji/);
    expect(kindAppearanceProblem({ source: "emoji", value: "a b", fallback: "e" })).toMatch(/emoji/);
    expect(kindAppearanceProblem({ source: "emoji", value: "🚀".repeat(9), fallback: "e" })).toMatch(/emoji/);
    expect(kindAppearanceProblem({ source: "none", value: "x", fallback: "e" })).toMatch(/empty value/);
    expect(kindAppearanceProblem({ source: "svg2", value: "", fallback: "e" })).toMatch(/a source of lucide, emoji, svg, none/);
  });

  it("requires a short, printable terminal fallback and a bounded label", () => {
    expect(kindAppearanceProblem({ ...ok, fallback: "" })).toMatch(/terminal fallback/);
    expect(kindAppearanceProblem({ ...ok, fallback: "12345" })).toMatch(/terminal fallback/);
    expect(kindAppearanceProblem({ ...ok, fallback: "a\n" })).toMatch(/terminal fallback/);
    expect(kindAppearanceProblem({ ...ok, label: "x".repeat(81) })).toMatch(/label/);
    expect(kindAppearanceProblem({ ...ok, label: 7 })).toMatch(/label/);
    expect(kindAppearanceProblem("nope")).toBe("an object");
  });

  it("validates a whole map: kind-id keys, and the offending kind named in the sentence", () => {
    expect(kindAppearanceMapProblem({})).toBeNull();
    expect(kindAppearanceMapProblem({ epic: ok, bug: { source: "none", value: "", fallback: "b" } })).toBeNull();
    expect(kindAppearanceMapProblem([])).toMatch(/a map of kind id/);
    expect(kindAppearanceMapProblem(null)).toMatch(/a map of kind id/);
    expect(kindAppearanceMapProblem({ "Not-A-Kind": ok })).toMatch(/"Not-A-Kind" is not one/);
    expect(kindAppearanceMapProblem({ epic: { ...ok, value: "Nope Nope" } })).toMatch(/Lucide icon key .* for "epic"/);
  });
});
