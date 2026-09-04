import { describe, expect, it } from "vitest";
import {
  SVG_LABEL_MAX,
  SVG_MAX_BYTES,
  SVG_NAMESPACE,
  SVG_VIEWBOX_MAX,
  isCanonicalSvg,
  sanitizeSvg,
} from "../src/core/svg-sanitize.js";

/**
 * R5c (STA-183) — the SVG sanitiser, pure.
 *
 * Three claims. Anything that can run, fetch, embed or navigate is REFUSED with
 * a sentence naming it, whichever spelling or encoding it arrives in — and a
 * malformed or oversized document is refused rather than repaired. A clean
 * document comes out CANONICAL: sized by the caller (no width/height on the
 * root, a bounded viewBox), coloured by the row (`currentColor` unless `none`),
 * named for assistive tech (one `<title>` and an `aria-label`), and a fixed
 * point of the sanitiser itself. And the stripping is deliberate: editor noise
 * goes quietly, hostile content never does.
 */

const clean = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Flask</title><path d="M4 2h8v12H4z"/></svg>';

const wrap = (inner: string, rootAttrs = "") => `<svg viewBox="0 0 16 16"${rootAttrs}><title>T</title>${inner}</svg>`;

function ok(input: string, label?: string): string {
  const result = sanitizeSvg(input, label === undefined ? {} : { label });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as { svg: string }).svg;
}

function refused(input: string, label?: string): string {
  const result = sanitizeSvg(input, label === undefined ? {} : { label });
  expect(result.ok, `expected a refusal for ${String(input).slice(0, 80)}`).toBe(false);
  return (result as { problem: string }).problem;
}

describe("refusals", () => {
  it("name the executable, embedding and navigating elements, in any case", () => {
    expect(refused(wrap("<script>alert(1)</script>"))).toMatch(/without <script>/);
    expect(refused(wrap("<SCRIPT>alert(1)</SCRIPT>"))).toMatch(/without <SCRIPT>/);
    expect(refused(wrap("<foreignObject><div>x</div></foreignObject>"))).toMatch(/without <foreignObject>/);
    expect(refused(wrap('<image href="https://evil.example/x.png"/>'))).toMatch(/without <image>/);
    expect(refused(wrap('<a href="https://evil.example"><path d="M0 0"/></a>'))).toMatch(/without <a>/);
    expect(refused(wrap('<style>path { fill: url(https://evil.example) }</style>'))).toMatch(/without <style>/);
    expect(refused(wrap('<animate attributeName="href" to="javascript:alert(1)"/>'))).toMatch(/without <animate>/);
    expect(refused(wrap('<iframe src="https://evil.example"/>'))).toMatch(/without <iframe>/);
  });

  it("refuse a nested <svg> and anything that is not one root element", () => {
    expect(refused(wrap('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'))).toMatch(/no nested <svg>/);
    expect(refused('<path d="M0 0"/>')).toMatch(/one <svg> root/);
    expect(refused(`${clean}${clean}`)).toMatch(/one <svg> root/);
    expect(refused("")).toMatch(/one <svg> root/);
  });

  it("refuse every event handler attribute, wherever it sits", () => {
    expect(refused(wrap('<path d="M0 0" onclick="alert(1)"/>'))).toMatch(/event handler attributes \(onclick\)/);
    expect(refused(wrap('<path d="M0 0" ONLOAD="alert(1)"/>'))).toMatch(/event handler attributes \(onload\)/);
    expect(refused(wrap("", ' onload="alert(1)"'))).toMatch(/event handler attributes \(onload\)/);
    expect(refused(wrap('<g onmouseover="alert(1)"><path d="M0 0"/></g>'))).toMatch(/event handler/);
  });

  it("refuse javascript:, data: and url( in attribute values, including entity-encoded spellings", () => {
    expect(refused(wrap('<path d="M0 0" fill="javascript:alert(1)"/>'))).toMatch(/without URLs or scripts in attribute values \(fill\)/);
    expect(refused(wrap('<path d="M0 0" fill="&#106;avascript:alert(1)"/>'))).toMatch(/attribute values \(fill\)/);
    expect(refused(wrap('<path d="M0 0" fill="&#x6A;avascript:alert(1)"/>'))).toMatch(/attribute values \(fill\)/);
    expect(refused(wrap('<path d="M0 0" fill="url(https://evil.example/f.svg#g)"/>'))).toMatch(/attribute values \(fill\)/);
    expect(refused(wrap('<path d="M0 0" filter="url(data:image/svg+xml;base64,PHN2Zz4=)"/>'))).toMatch(/attribute values \(filter\)/);
  });

  it("refuse external references: href to another origin, url( and @import in a style", () => {
    expect(refused(wrap('<use href="https://evil.example/sprite.svg#icon"/>'))).toMatch(/references are local \(#id\), not "https:\/\/evil.example\/sprite.svg#icon"/);
    expect(refused(wrap('<use xlink:href="//evil.example/sprite.svg#icon"/>'))).toMatch(/references are local/);
    expect(refused(wrap('<use href="/local/sprite.svg#icon"/>'))).toMatch(/references are local/);
    expect(refused(wrap('<path d="M0 0" clip-path="url(https://evil.example/c.svg#c)"/>'))).toMatch(/clip-path references are local/);
    expect(refused(wrap('<path d="M0 0" style="fill:url(https://evil.example/p.png)"/>'))).toMatch(/styles carry no external references/);
    expect(refused(wrap('<path d="M0 0" style="@import url(https://evil.example/x.css)"/>'))).toMatch(/styles carry no external references/);
    expect(refused(wrap("", ' style="behavior:url(x.htc)"'))).toMatch(/styles carry no external references/);
  });

  it("refuse DOCTYPE, entity declarations (billion laughs), CDATA and processing instructions", () => {
    const laughs =
      '<!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>' +
      wrap("<desc>&c;</desc>");
    expect(refused(laughs)).toMatch(/without DOCTYPE, entity declarations or CDATA/);
    expect(refused(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${clean}`)).toMatch(/DOCTYPE/);
    expect(refused(wrap("<desc><![CDATA[<script>alert(1)</script>]]></desc>"))).toMatch(/CDATA/);
    expect(refused(wrap('<?xml-stylesheet href="https://evil.example/x.css"?>'))).toMatch(/processing instructions/);
    // An undeclared entity reference is a document that only a DTD could complete.
    expect(refused(wrap("<desc>&laughs;</desc>"))).toMatch(/predefined XML entities/);
  });

  it("refuse malformed and truncated markup rather than repairing it", () => {
    expect(refused('<svg viewBox="0 0 16 16"><title>T</title><path d="M0 0h1"')).toMatch(/malformed or the document is truncated/);
    expect(refused('<svg viewBox="0 0 16 16"><title>T</title><g><path d="M0 0"/></svg>')).toMatch(/unexpected <\/svg>/);
    expect(refused('<svg viewBox="0 0 16 16"><title>T</title><g><path d="M0 0"/>')).toMatch(/<g> is never closed/);
    expect(refused(wrap('<path d="M0 0" fill="a<b"/>'))).toMatch(/well-formed SVG markup/);
    expect(refused(wrap('<path d="M0 0" fill="a&lt;b"/>'))).toMatch(/attribute value contains </);
    expect(refused(wrap("<g>stray text</g>"))).toMatch(/text only inside <title> or <desc>/);
    expect(refused(`${clean.slice(0, -6)}<!-- never closed`)).toMatch(/comment is never closed/);
    expect(refused(wrap('<path d="M0\u00010"/>'))).toMatch(/control characters/);
    expect(refused(wrap("<g>".repeat(40) + '<path d="M0 0"/>' + "</g>".repeat(40)))).toMatch(/nested at most 32 levels/);
    expect(refused(wrap("<g/>".repeat(600)))).toMatch(/at most 512 elements/);
  });

  it("refuse an oversized or absent viewBox, and an oversized document", () => {
    expect(refused(`<svg viewBox="0 0 ${SVG_VIEWBOX_MAX + 1} 16"><title>T</title><path d="M0 0"/></svg>`)).toMatch(/viewBox is within ±4096/);
    expect(refused('<svg viewBox="-5000 0 16 16"><title>T</title><path d="M0 0"/></svg>')).toMatch(/viewBox is within/);
    expect(refused('<svg viewBox="0 0 0 16"><title>T</title><path d="M0 0"/></svg>')).toMatch(/positive width and height/);
    expect(refused('<svg viewBox="0 0 16"><title>T</title><path d="M0 0"/></svg>')).toMatch(/viewBox of four numbers/);
    expect(refused('<svg viewBox="a b c d"><title>T</title><path d="M0 0"/></svg>')).toMatch(/viewBox of four numbers/);
    expect(refused('<svg width="100%" height="1em"><title>T</title><path d="M0 0"/></svg>')).toMatch(/viewBox of four numbers/);
    expect(refused('<svg><title>T</title><path d="M0 0"/></svg>')).toMatch(/viewBox/);
    const megabyte = wrap(`<path d="M0 0${" h1".repeat(400_000)}"/>`);
    expect(megabyte.length).toBeGreaterThan(1024 * 1024);
    expect(refused(megabyte)).toMatch(new RegExp(`at most ${SVG_MAX_BYTES} bytes \\(got \\d+\\)`));
    // Bytes, not units: multi-byte text counts for what it costs on disk.
    expect(refused(wrap(`<desc>${"é".repeat(SVG_MAX_BYTES / 2)}</desc>`))).toMatch(/bytes/);
    expect(refused(1 as unknown as string)).toMatch(/as a string/);
  });

  it("refuse a document with no accessible name when the record has no label either", () => {
    expect(refused('<svg viewBox="0 0 16 16"><path d="M0 0"/></svg>')).toMatch(/accessible name/);
    expect(refused('<svg viewBox="0 0 16 16"><title>   </title><path d="M0 0"/></svg>', "   ")).toMatch(/accessible name/);
  });
});

describe("canonical output", () => {
  it("drops absolute sizing on the root and keeps a normalised viewBox, so the caller's box wins", () => {
    const svg = ok('<svg viewBox=" 0,0 24 24 " width="24px" height="24" x="1" y="1" id="root"><title>T</title><path d="M0 0"/></svg>');
    expect(svg).toBe(`<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 24 24" role="img" aria-label="T"><title>T</title><path d="M0 0"/></svg>`);
    // No viewBox but a plain width and height: derived, then the size is dropped like any other.
    expect(ok('<svg width="32" height="16px"><title>T</title><path d="M0 0"/></svg>')).toContain('viewBox="0 0 32 16"');
    // Sizes on shapes are geometry and stay.
    expect(ok(wrap('<rect x="1" y="2" width="8" height="8"/>'))).toContain('<rect x="1" y="2" width="8" height="8"/>');
  });

  it("normalises fill and stroke to currentColor unless none, and strips styles and classes", () => {
    const svg = ok(wrap('<g fill="#ff0000" stroke="rgb(0,0,255)" class="a" style="opacity:.5" data-name="x"><path d="M0 0" fill="none" stroke="NONE"/><circle cx="8" cy="8" r="2" fill="url(#g)"/></g>'));
    expect(svg).toContain('<g fill="currentColor" stroke="currentColor">');
    expect(svg).toContain('<path d="M0 0" fill="none" stroke="none"/>');
    expect(svg).toContain('<circle cx="8" cy="8" r="2" fill="currentColor"/>');
    expect(svg).not.toMatch(/class=|style=|data-name/);
  });

  it("carries the accessible name as one <title> and an aria-label: the document's own title first, then the record's label", () => {
    expect(ok(wrap('<path d="M0 0"/>'), "Record label")).toContain('aria-label="T"><title>T</title>');
    expect(ok('<svg viewBox="0 0 16 16"><path d="M0 0"/></svg>', "Record label")).toContain('aria-label="Record label"><title>Record label</title>');
    expect(ok('<svg viewBox="0 0 16 16" aria-label="From aria"><path d="M0 0"/></svg>')).toContain('aria-label="From aria"><title>From aria</title>');
    // Several titles and descriptions collapse to the one canonical title, whitespace collapsed and escaped.
    const svg = ok('<svg viewBox="0 0 16 16"><title>  A &amp; "B"\n  &lt;C&gt; </title><desc>ignored</desc><g><title>inner</title><path d="M0 0"/></g></svg>');
    expect(svg).toContain('aria-label="A &amp; &quot;B&quot; &lt;C&gt;"><title>A &amp; "B" &lt;C&gt;</title>');
    expect(svg).not.toMatch(/inner|ignored|<desc/);
    expect((sanitizeSvg(wrap('<path d="M0 0"/>').replace("<title>T</title>", `<title>${"x".repeat(200)}</title>`)) as { label: string }).label).toHaveLength(SVG_LABEL_MAX);
  });

  it("keeps local references and definitions, folding xlink:href onto href", () => {
    const svg = ok(wrap('<defs><path id="p" d="M0 0h8"/></defs><clipPath id="c"><rect width="8" height="8"/></clipPath><use xlink:href="#p" clip-path="url(#c)"/>'));
    expect(svg).toContain('<defs><path id="p" d="M0 0h8"/></defs><clipPath id="c"><rect width="8" height="8"/></clipPath><use clip-path="url(#c)" href="#p"/>');
  });

  it("strips editor noise: the XML declaration, comments, namespace declarations, unknown attributes", () => {
    const svg = ok(
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: Some Editor -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:serif="http://www.serif.com/" xml:space="preserve" version="1.1" viewBox="0 0 16 16">\n  <title>T</title>\n  <path serif:id="Layer" d="M0 0" vector-effect="non-scaling-stroke"/>\n</svg>\n',
    );
    expect(svg).toBe(`<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 16 16" role="img" aria-label="T"><title>T</title><path d="M0 0"/></svg>`);
  });

  it("writes attributes in one order and escapes their values, so equal drawings give equal strings", () => {
    const a = ok(wrap('<path stroke-width="2" d="M0 0" fill="none" transform="rotate(45)"/>'));
    const b = ok(wrap("<path transform='rotate(45)' fill='none' d='M0 0' stroke-width='2' />"));
    expect(a).toBe(b);
    expect(a).toContain('<path d="M0 0" transform="rotate(45)" fill="none" stroke-width="2"/>');
    expect(ok(wrap('<path d="M0 0" transform="translate(1,2)" stroke-dasharray="1 &amp; 2"/>'))).toContain('stroke-dasharray="1 &amp; 2"');
  });

  it("is a fixed point: sanitising the output returns it unchanged, and only the output is canonical", () => {
    for (const input of [
      clean,
      wrap('<g fill="#f00"><path d="M0 0"/><circle cx="8" cy="8" r="2" fill="none"/></g>', ' width="24" height="24"'),
      wrap('<defs><path id="p" d="M0 0h8"/></defs><use xlink:href="#p"/>'),
    ]) {
      const first = ok(input);
      expect(ok(first)).toBe(first);
      expect(isCanonicalSvg(first)).toBe(true);
      expect(isCanonicalSvg(input)).toBe(false);
    }
    expect(isCanonicalSvg("<svg><script/></svg>")).toBe(false);
    expect(isCanonicalSvg("")).toBe(false);
  });

  it("answers the viewBox and the label it wrote, for a caller that renders inline", () => {
    const result = sanitizeSvg(ok('<svg viewBox="-8 -8 16 16"><title>Named</title><path d="M0 0"/></svg>'));
    expect(result).toMatchObject({ ok: true, viewBox: "-8 -8 16 16", label: "Named" });
  });
});
