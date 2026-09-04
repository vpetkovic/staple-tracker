/**
 * R5a (STA-181) — the built-in marks against the generated catalog.
 *
 * Core validates that a `lucide` value is SHAPED like a key; only the browser
 * holds the catalog that says whether it exists. So the one claim that must be
 * proven here, and cannot be proven in `test/kind-appearance.test.ts`, is that
 * every built-in mark names a CANONICAL key — the catalog's own, not an alias —
 * so the persisted value and the rendered icon can never drift. The mirror's
 * parity with core is held on the Node side, which can import both.
 *
 * R5c (STA-183): the browser's gate on a served `emoji` or `svg` record. What is
 * proven here is the REFUSAL side — every hostile or merely non-canonical string
 * answers null — and that the one accepted shape yields a spec a renderer can
 * place inside its own `<svg>`. That the gate accepts the sanitiser's real
 * output is, again, the Node side's claim to hold.
 */

/** A canonical document, by hand — exactly what `src/core/svg-sanitize.ts` writes for a small glyph. */
const CANONICAL =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" role="img" aria-label="Flask"><title>Flask</title><g fill="currentColor"><path d="M4 2h8v12H4z" stroke="none"/><circle cx="8" cy="8" r="2"/></g></svg>';
import { describe, expect, it } from "vitest";
import { resolveIcon } from "./icon-catalog";
import {
  BUILTIN_KIND_APPEARANCE,
  GENERIC_KIND_FALLBACK,
  fallbackKindAppearance,
  isCanonicalSvg,
  isEmojiGlyph,
  safeGlyph,
} from "./kind-appearance";

describe("the built-in marks", () => {
  it("each name a canonical Lucide key the catalog resolves to itself", () => {
    for (const [id, mark] of Object.entries(BUILTIN_KIND_APPEARANCE)) {
      expect(mark.source, id).toBe("lucide");
      expect(resolveIcon(mark.value)?.key, `${id} -> ${mark.value}`).toBe(mark.value);
    }
  });

  it("fall back to the generic mark for a kind nobody has given one", () => {
    expect(fallbackKindAppearance({ id: "epic", label: "Epic" })).toEqual({ source: "lucide", value: "layers", label: "Epic", fallback: "◆" });
    expect(fallbackKindAppearance({ id: "research", label: "Research" })).toEqual({
      source: "none",
      value: "",
      label: "Research",
      fallback: GENERIC_KIND_FALLBACK,
    });
  });
});

describe("the browser's gate on a served glyph (R5c)", () => {
  it("accepts an emoji by grapheme count and refuses invisible, oversized or whitespace values", () => {
    for (const value of ["🚀", "👨‍👩‍👧‍👦", "🇺🇸", "1️⃣", "→→", "é"]) expect(isEmojiGlyph(value), value).toBe(true);
    for (const value of ["", "→→→", "🚀".repeat(9), "abc", "\u200d", "\ufe0f", "\ud83d", "a b", "\u0007", "<b>"]) {
      expect(isEmojiGlyph(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("recognises the sanitiser's canonical shape and answers a spec for a wrapper to draw", () => {
    expect(isCanonicalSvg(CANONICAL)).toBe(true);
    expect(safeGlyph({ source: "svg", value: CANONICAL, label: "Research" })).toEqual({
      source: "svg",
      viewBox: "0 0 16 16",
      label: "Research",
      body: '<title>Flask</title><g fill="currentColor"><path d="M4 2h8v12H4z" stroke="none"/><circle cx="8" cy="8" r="2"/></g>',
    });
    expect(safeGlyph({ source: "emoji", value: "🐛", label: "Bug" })).toEqual({ source: "emoji", text: "🐛", label: "Bug" });
    // Root presentation attributes the sanitiser kept, and local references, are part of the shape.
    expect(
      isCanonicalSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 16 16" role="img" aria-label="T" fill="currentColor" preserveAspectRatio="xMidYMid"><title>T</title><defs><path id="p" d="M0 0h8"/></defs><clipPath id="c"><rect width="8" height="8"/></clipPath><use clip-path="url(#c)" href="#p"/></svg>',
      ),
    ).toBe(true);
  });

  it("refuses every hostile or non-canonical string, so nothing but the sanitiser's output is ever injected", () => {
    const hostile = [
      // Clean but raw: not the sanitiser's shape.
      '<svg viewBox="0 0 16 16"><title>T</title><path d="M0 0"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" role="img" aria-label="T"><title>T</title><path d="M0 0"/></svg>',
      // Hostile content inside an otherwise canonical root.
      CANONICAL.replace("<circle", "<script>alert(1)</script><circle"),
      CANONICAL.replace("<circle", '<image href="https://evil.example/x.png"/><circle'),
      CANONICAL.replace("<circle", "<foreignObject><div>x</div></foreignObject><circle"),
      CANONICAL.replace("<circle", '<a href="https://evil.example"><path d="M0 0"/></a><circle'),
      CANONICAL.replace("<circle", '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg><circle'),
      CANONICAL.replace("<circle", '<style>path{fill:url(https://evil.example)}</style><circle'),
      CANONICAL.replace('<path d="M4 2h8v12H4z"', '<path d="M4 2h8v12H4z" onclick="alert(1)"'),
      CANONICAL.replace('<path d="M4 2h8v12H4z"', '<path d="M4 2h8v12H4z" fill="url(https://evil.example/f.svg#g)"'),
      CANONICAL.replace('<path d="M4 2h8v12H4z"', '<path d="M4 2h8v12H4z" fill="javascript:alert(1)"'),
      CANONICAL.replace("<circle", '<use href="https://evil.example/s.svg#i"/><circle'),
      CANONICAL.replace("<circle", '<use href="/s.svg#i"/><circle'),
      CANONICAL.replace('aria-label="Flask"', 'aria-label="Flask" onload="alert(1)"'),
      CANONICAL.replace('aria-label="Flask"', 'aria-label="Flask" clip-path="url(https://evil.example/c.svg#c)"'),
      CANONICAL.replace("<title>Flask</title>", "<title>Flask</title>text"),
      CANONICAL.replace("<title>Flask</title>", "<!-- c --><title>Flask</title>"),
      CANONICAL.replace('viewBox="0 0 16 16"', 'viewBox="0 0 16 16" data:="x"'),
      `<!DOCTYPE svg [<!ENTITY a "a">]>${CANONICAL}`,
      `<?xml version="1.0"?>${CANONICAL}`,
      CANONICAL.slice(0, -10),
      `${CANONICAL}${CANONICAL}`,
      CANONICAL.replace("</g>", `<path d="M0 0${" h1".repeat(10_000)}"/></g>`),
      "",
      "<svg/>",
    ];
    for (const value of hostile) {
      expect(isCanonicalSvg(value), value.slice(0, 120)).toBe(false);
      expect(safeGlyph({ source: "svg", value, label: "x" }), value.slice(0, 120)).toBeNull();
    }
    // Sources the gate does not answer for.
    expect(safeGlyph({ source: "lucide", value: "layers", label: "Epic" })).toBeNull();
    expect(safeGlyph({ source: "none", value: "", label: "Epic" })).toBeNull();
    expect(safeGlyph({ source: "emoji", value: "🚀🚀🚀", label: "Epic" })).toBeNull();
  });
});
