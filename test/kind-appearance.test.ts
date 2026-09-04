import { describe, expect, it } from "vitest";
import {
  BUILTIN_KIND_APPEARANCE,
  GENERIC_KIND_FALLBACK,
  KIND_APPEARANCE_SOURCES,
  LUCIDE_KEY_PATTERN,
  kindAppearanceMapProblem,
  kindAppearanceProblem,
  resolveKindAppearance,
  type StoredKindAppearance,
} from "../src/core/kind-appearance.js";
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
 */

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

  it("refuses custom SVG until the sanitiser exists", () => {
    expect(kindAppearanceProblem({ source: "svg", value: "<svg/>", fallback: "s" })).toMatch(/sanitiser/);
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
