/**
 * R5c (STA-183) — a configured glyph on screen, and the row that carries it.
 *
 * Rendered to a string with `react-dom/server`, like every other test in this folder.
 * Two claims a string can answer. SAFETY: the only markup that ever lands inside the
 * wrapper is the sanitiser's canonical output — every hostile or merely raw value draws
 * the record's terminal fallback as text, with no `<script`, no handler and no URL in
 * the result, and the row keeps its glyph slot. ACCESSIBILITY: a standalone glyph is an
 * image with the record's label; inside `KindGlyph`, which names the kind in text, it
 * is hidden so the fact is read once.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KindGlyph } from "./KindGlyph";
import { SafeGlyph } from "./SafeGlyph";

const CANONICAL =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="Box"><title>Box</title><path d="M4 2h16v20H4z" fill="currentColor"/></svg>';

const svgRecord = { source: "svg" as const, value: CANONICAL, label: "Research", fallback: "▣" };
const emojiRecord = { source: "emoji" as const, value: "🧪", label: "Research", fallback: "R" };

const HOSTILE = [
  '<svg viewBox="0 0 16 16"><title>T</title><path d="M0 0"/></svg>',
  CANONICAL.replace("<path", "<script>alert(1)</script><path"),
  CANONICAL.replace("<path", '<image href="https://evil.example/x.png"/><path'),
  CANONICAL.replace("<path", '<foreignObject><div onclick="x()">x</div></foreignObject><path'),
  CANONICAL.replace('fill="currentColor"', 'fill="currentColor" onload="alert(1)"'),
  CANONICAL.replace('fill="currentColor"', 'fill="url(https://evil.example/f.svg#g)"'),
  CANONICAL.replace("<path", '<a href="javascript:alert(1)"><path d="M0 0"/></a><path'),
  CANONICAL.slice(0, -12),
  "<svg><script>alert(1)</script></svg>",
  "",
];

describe("SafeGlyph", () => {
  it("draws a canonical SVG inside its own sized wrapper, coloured by currentColor and named for assistive tech", () => {
    const markup = renderToStaticMarkup(<SafeGlyph appearance={svgRecord} size={16} />);
    expect(markup).toMatch(/^<svg class="staple-safe-glyph[^"]*" data-testid="safe-glyph" data-glyph-source="svg" width="16" height="16" viewBox="0 0 24 24" focusable="false" role="img" aria-label="Research">/);
    expect(markup).toContain('<title>Box</title><path d="M4 2h16v20H4z" fill="currentColor"/></svg>');
    // The wrapper sizes it: the inner document brought no width, height or namespace of its own.
    expect(markup.match(/<svg/g)).toHaveLength(1);
    expect(markup).not.toContain("xmlns");
  });

  it("draws an emoji as text at the requested size", () => {
    const markup = renderToStaticMarkup(<SafeGlyph appearance={emojiRecord} size={12} />);
    expect(markup).toContain('data-glyph-source="emoji"');
    expect(markup).toContain('role="img" aria-label="Research"');
    expect(markup).toMatch(/width:12px;height:12px;font-size:12px/);
    expect(markup).toContain(">🧪</span>");
  });

  it("draws the terminal fallback as text for every hostile or non-canonical value, injecting nothing", () => {
    for (const value of HOSTILE) {
      const markup = renderToStaticMarkup(<SafeGlyph appearance={{ ...svgRecord, value }} />);
      expect(markup, value.slice(0, 100)).toContain('data-glyph-source="fallback"');
      expect(markup, value.slice(0, 100)).toContain(">▣</span>");
      expect(markup, value.slice(0, 100)).not.toMatch(/<svg|<script|onload|onclick|evil\.example|javascript:|foreignObject/i);
    }
    // An emoji that fails the grapheme rule falls back the same way.
    expect(renderToStaticMarkup(<SafeGlyph appearance={{ ...emojiRecord, value: "🚀🚀🚀" }} />)).toContain(">R</span>");
    // `lucide` and `none` are not this component's to draw: the fallback, never a guess.
    expect(renderToStaticMarkup(<SafeGlyph appearance={{ source: "lucide", value: "layers", label: "Epic", fallback: "◆" }} />)).toContain(">◆</span>");
  });

  it("is hidden from assistive tech when decorative, whatever it draws", () => {
    for (const appearance of [svgRecord, emojiRecord, { ...svgRecord, value: HOSTILE[1]! }]) {
      const markup = renderToStaticMarkup(<SafeGlyph appearance={appearance} decorative />);
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).not.toMatch(/role="img"|aria-label/);
    }
  });
});

describe("KindGlyph with a configured appearance", () => {
  it("delegates an emoji or canonical SVG to SafeGlyph, decorative, and keeps the kind named once in text", () => {
    for (const appearance of [svgRecord, emojiRecord]) {
      const markup = renderToStaticMarkup(<KindGlyph kind="research" appearance={appearance} />);
      expect(markup).toMatch(/^<span class="staple-kind-glyph" data-issue-kind="research" data-testid="kind-glyph">/);
      expect(markup).toContain('data-glyph-source="' + appearance.source + '"');
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('<span class="sr-only">Kind: Research</span>');
      expect(markup).not.toMatch(/role="img"/);
    }
    expect(renderToStaticMarkup(<KindGlyph kind="research" appearance={svgRecord} size={16} />)).toContain('width="16" height="16" viewBox="0 0 24 24"');
  });

  it("draws its built-in mark for an absent, lucide, none or invalid appearance, so the row never loses its glyph", () => {
    const builtIn = renderToStaticMarkup(<KindGlyph kind="epic" />);
    expect(builtIn).toContain('viewBox="0 0 16 16"');
    expect(renderToStaticMarkup(<KindGlyph kind="epic" appearance={{ source: "lucide", value: "layers", label: "Epic", fallback: "◆" }} />)).toBe(builtIn);
    expect(renderToStaticMarkup(<KindGlyph kind="epic" appearance={{ source: "none", value: "", label: "Epic", fallback: "◆" }} />)).toBe(builtIn);
    for (const value of HOSTILE) {
      const markup = renderToStaticMarkup(<KindGlyph kind="epic" appearance={{ ...svgRecord, value, label: "Epic" }} />);
      expect(markup, value.slice(0, 100)).toBe(builtIn);
    }
    expect(renderToStaticMarkup(<KindGlyph kind="epic" appearance={{ ...emojiRecord, value: "\u200d", label: "Epic" }} />)).toBe(builtIn);
  });
});
