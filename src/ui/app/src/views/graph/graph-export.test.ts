/**
 * G5 — the exported file, and the one bug that would reach a meeting.
 *
 * XML escaping is the whole reason this file exists. Ticket titles on this project
 * contain `&` and `—` and quotes; a single unescaped ampersand produces an SVG that every
 * viewer refuses to open, and it fails at the moment somebody drags it into a deck rather
 * than at the moment it is generated. Nothing about the app looks broken beforehand.
 *
 * The geometry assertions are cheaper insurance: a viewBox computed from the wrong bound
 * yields a file that opens fine and is mostly empty space with the graph off one edge.
 */
import { describe, expect, it } from "vitest";
import { buildSvg, escapeXml, wrapTitle, type ExportColors, type ExportNode } from "./graph-export";

const colors: ExportColors = {
  background: "#ffffff",
  card: "#fefefe",
  border: "#e5e5e5",
  text: "#111111",
  muted: "#777777",
};

/**
 * Every `&` in the document that is not the start of a character entity, plus every `<`
 * that is not the start of a tag. Either one is a fatal XML error, and this is how to
 * find them without a DOM.
 */
function bareMarkupChars(svg: string): string[] {
  const bad: string[] = [];
  for (const match of svg.matchAll(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g)) bad.push(match[0]);
  // Text content lives between > and <; a `<` there would have been escaped.
  for (const match of svg.matchAll(/>([^<]*)</g)) {
    if (match[1]!.includes("&") && !/&(amp|lt|gt|quot|apos|#\d+);/.test(match[1]!)) bad.push(match[1]!);
  }
  return bad;
}

const node = (overrides: Partial<ExportNode> = {}): ExportNode => ({
  x: 0,
  y: 0,
  w: 208,
  h: 62,
  label: "STA-1",
  title: "a title",
  accent: "#00aa00",
  ...overrides,
});

describe("escapeXml", () => {
  it("escapes every character that would break the document", () => {
    expect(escapeXml(`A & B < C > D " E ' F`)).toBe(
      "A &amp; B &lt; C &gt; D &quot; E &apos; F",
    );
  });
});

describe("buildSvg", () => {
  it("escapes a title that would otherwise produce an unopenable file", () => {
    const svg = buildSvg({
      nodes: [node({ title: "sync & merge <fast>", label: "STA-1 & co" })],
      edges: [],
      colors,
    });
    expect(svg).toContain("&amp;");
    // The real assertion: no bare `&` or `<` survives inside the text content, which is
    // precisely what makes an SVG unopenable. (Checked structurally rather than with
    // DOMParser — these tests run in node, where there is no DOM.)
    expect(bareMarkupChars(svg)).toEqual([]);
  });

  it("is a well-formed svg document with a background", () => {
    const svg = buildSvg({ nodes: [node()], edges: [], colors });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain(colors.background);
  });

  it("sizes the viewBox around the drawing plus padding", () => {
    // Two nodes 400 apart, 208 wide, padding 10 -> 400 + 208 + 20 = 628 wide.
    const svg = buildSvg({
      nodes: [node({ x: 0, y: 0 }), node({ x: 400, y: 100 })],
      edges: [],
      colors,
      padding: 10,
    });
    expect(svg).toContain('width="628"');
    expect(svg).toContain('viewBox="-10 -10 628 182"');
  });

  it("handles negative coordinates, which dagre and dragging both produce", () => {
    const svg = buildSvg({ nodes: [node({ x: -300, y: -50 })], edges: [], colors, padding: 10 });
    expect(svg).toContain('viewBox="-310 -60 228 82"');
  });

  it("draws the three edge kinds distinguishably", () => {
    const svg = buildSvg({
      nodes: [node()],
      edges: [{ d: "M0 0 L10 10" }, { d: "M0 0 L20 20", cross: true }, { d: "M0 0 L30 30", derived: true }],
      colors,
    });
    expect(svg).toContain('stroke-dasharray="5 4"'); // cross-workspace
    expect(svg).toContain('stroke-dasharray="1 4"'); // bridged across hidden work
    expect(svg).toContain('d="M0 0 L10 10" fill="none"'); // plain
  });

  it("escapes the edge path attribute too", () => {
    const svg = buildSvg({ nodes: [], edges: [{ d: 'M0 0 L1 1" onload="x' }], colors });
    expect(svg).toContain("&quot;");
  });

  it("renders a cluster badge and its stacked outline", () => {
    const svg = buildSvg({
      nodes: [node({ cluster: true, badge: "3/9 done" })],
      edges: [],
      colors,
    });
    expect(svg).toContain("3/9 done");
    // Two rects for the box: the offset one behind, then the card.
    expect(svg.match(/<rect x="3" y="3"/g)).toHaveLength(1);
  });

  it("produces a valid document for an empty graph", () => {
    // A graph can legitimately be empty (everything filtered out), and the export button
    // must still hand back a file rather than an NaN-sized one.
    const svg = buildSvg({ nodes: [], edges: [], colors });
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).not.toContain("NaN");
    expect(bareMarkupChars(svg)).toEqual([]);
  });
});

describe("wrapTitle", () => {
  it("keeps a short title on one line", () => {
    expect(wrapTitle("short one", 200)).toEqual(["short one"]);
  });

  it("wraps to at most two lines", () => {
    const lines = wrapTitle("a considerably longer ticket title that will not fit on one line", 200);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("ellipsizes rather than overflowing the card", () => {
    const lines = wrapTitle(
      "an extremely long ticket title that keeps going well past anything that could fit inside a fixed size card on a canvas",
      200,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
  });

  it("survives an empty title", () => {
    expect(wrapTitle("", 200)).toEqual([]);
  });
});
