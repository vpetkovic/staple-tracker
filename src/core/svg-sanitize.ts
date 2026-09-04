/**
 * SVG SANITISER — R5c (STA-183).
 *
 * A custom kind glyph is markup an operator typed or pasted, and the task list
 * draws it inline on every row. This module is the only thing standing between
 * that paste and the DOM, so it does one job in one direction: it turns a
 * bounded SVG document into ONE canonical string, or refuses with a sentence
 * that says why. The canonical string is what the store persists (never the
 * input), what every read surface serves, and the only thing the browser will
 * inject — `SafeGlyph.tsx` recognises its exact shape and draws the terminal
 * fallback for anything else.
 *
 * ## Allowlist, not denylist
 *
 * Pure string work: no DOM, no dependency. A small tokenizer builds an element
 * tree, and the tree is checked against a short list of what a monochrome
 * glyph can be made of — shapes, groups, local definitions and a title. Every
 * element and attribute outside that list is either REFUSED (anything that can
 * run, fetch, embed or navigate: `<script>`, `<foreignObject>`, `<style>`,
 * `<image>`, `<a>`, nested `<svg>`, `on*` handlers, `javascript:`/`data:` URLs,
 * external `href`s, `url(` and `@import` in a style, DOCTYPE and entity
 * declarations) or STRIPPED (editor noise: `class`, `data-*`, `xml:space`,
 * `xmlns:serif`, width/height/x/y on the root, `style` with nothing external).
 * Refuse where the operator would want to know; strip where they would not.
 *
 * ## Canonical means: sized by the caller, coloured by the row
 *
 * The root keeps a `viewBox` (derived from width/height when absent) and loses
 * its absolute size, so the glyph inherits whatever box the caller draws it in.
 * `fill` and `stroke` are normalised to `currentColor` unless `none`, because a
 * kind glyph is monochrome by design (`kind-appearance.ts` explains why hue is
 * a status property). The document carries exactly one `<title>` and an
 * `aria-label`, both the accessible name — from the input's own title, or from
 * the record's label when it had none. The output is a fixed point: sanitising
 * it again returns it unchanged, which is what lets the validator accept only
 * canonical values and still be cheap.
 */

/** The byte-size cap on an input document (UTF-8). A glyph is a few paths, not an illustration. */
export const SVG_MAX_BYTES = 8 * 1024;
/** `viewBox` bounds: |min-x|, |min-y| ≤ this, and 0 < width, height ≤ this. */
export const SVG_VIEWBOX_MAX = 4096;
/** The accessible name's length cap, matching the appearance record's label bound. */
export const SVG_LABEL_MAX = 80;
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const MAX_ELEMENTS = 512;
const MAX_DEPTH = 32;

export type SvgSanitizeResult =
  | { ok: true; svg: string; viewBox: string; label: string }
  | { ok: false; problem: string };

/**
 * Elements a glyph may contain, keyed by lowercase for a case-insensitive
 * match on the way in and written back in SVG's own case on the way out.
 * `title` and `desc` are recognised so their text can be read, then replaced
 * by the one canonical title.
 */
const ELEMENTS: Readonly<Record<string, string>> = Object.freeze({
  svg: "svg",
  g: "g",
  path: "path",
  circle: "circle",
  ellipse: "ellipse",
  rect: "rect",
  line: "line",
  polyline: "polyline",
  polygon: "polygon",
  defs: "defs",
  clippath: "clipPath",
  symbol: "symbol",
  use: "use",
  title: "title",
  desc: "desc",
});

/** Attributes that survive, in the order they are written. `xlink:href` is folded onto `href`. */
const ATTRIBUTES = [
  "id",
  "d",
  "points",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "transform",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "stroke-opacity",
  "opacity",
  "clip-rule",
  "clip-path",
  "href",
  "preserveaspectratio",
] as const;
const ATTRIBUTE_ORDER = new Map(ATTRIBUTES.map((name, index) => [name, index]));
const ATTRIBUTE_CASE: Readonly<Record<string, string>> = { preserveaspectratio: "preserveAspectRatio" };
/** Attributes that only make sense on the root, and that the caller's box replaces. */
const ROOT_STRIPPED = new Set(["width", "height", "x", "y", "id", "href"]);

const LOCAL_ID = /^[A-Za-z_][\w.:-]*$/;
const LOCAL_REF = /^#[A-Za-z_][\w.:-]*$/;
const LOCAL_URL = /^url\(#[A-Za-z_][\w.:-]*\)$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const HOSTILE_VALUE = /javascript:|vbscript:|data:|url\(|@import|expression\(|behavior:|binding:/i;
const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/;

interface Element {
  name: string;
  attrs: Array<[string, string]>;
  children: Element[];
  text: string;
}

class Refusal extends Error {}
const refuse = (problem: string): never => {
  throw new Refusal(problem);
};

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (_, name: string) => {
    switch (name) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0x10ffff ? "�" : String.fromCodePoint(code);
      }
    }
  });
}

const escapeText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (text: string): string => escapeText(text).replace(/"/g, "&quot;");

const TAG = /<\s*(\/?)\s*([A-Za-z_][\w.:-]*)((?:[^"'<>]|"[^"<]*"|'[^'<]*')*?)\s*(\/?)\s*>/y;
const ATTR = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;

/**
 * Tokenize into a tree. Every `<` must open a well-formed tag, every open tag
 * must be closed by its own name, and text may only sit inside `title`/`desc`
 * — a truncated or interleaved document is refused rather than repaired.
 */
function parse(source: string): Element {
  const root: Element = { name: "#root", attrs: [], children: [], text: "" };
  const stack: Element[] = [root];
  let count = 0;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    const text = source.slice(index, open === -1 ? source.length : open);
    if (text.trim().length > 0) {
      const parent = stack[stack.length - 1]!;
      if (parent.name !== "title" && parent.name !== "desc") refuse("an SVG with text only inside <title> or <desc>");
      parent.text += decodeEntities(text);
    }
    if (open === -1) break;
    TAG.lastIndex = open;
    const match = TAG.exec(source);
    if (!match) refuse("well-formed SVG markup (a tag is malformed or the document is truncated)");
    const [, closing, rawName, rawAttrs, selfClosing] = match as unknown as [string, string, string, string, string];
    index = TAG.lastIndex;
    const name = rawName.toLowerCase();
    if (closing) {
      const current = stack.pop();
      if (!current || current.name !== name) refuse(`well-formed SVG markup (unexpected </${rawName}>)`);
      continue;
    }
    // Refused by name at the tag, before any of its content is read: the sentence
    // should say <script>, not describe the text the script happened to carry.
    if (!ELEMENTS[name]) refuse(`an SVG without <${rawName}> elements`);
    if (name === "svg" && stack.length > 1) refuse("an SVG with one root and no nested <svg>");
    if (++count > MAX_ELEMENTS) refuse(`an SVG of at most ${MAX_ELEMENTS} elements`);
    if (stack.length > MAX_DEPTH) refuse(`an SVG nested at most ${MAX_DEPTH} levels deep`);
    const element: Element = { name, attrs: [], children: [], text: "" };
    for (const attr of rawAttrs.matchAll(ATTR)) {
      const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
      element.attrs.push([attr[1]!.toLowerCase(), decodeEntities(value)]);
    }
    stack[stack.length - 1]!.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 1) refuse(`well-formed SVG markup (<${stack[stack.length - 1]!.name}> is never closed)`);
  return root;
}

function numbers(text: string, expected: number): number[] | null {
  const parts = text.trim().split(/[\s,]+/);
  if (parts.length !== expected || !parts.every((part) => NUMBER.test(part))) return null;
  return parts.map(Number);
}

/** A plain or `px` length, as `width="24"` / `width="24px"`; anything else (%, em) is not a box. */
function pixels(text: string | undefined): number | null {
  if (text === undefined) return null;
  const match = /^\s*(-?(?:\d+\.?\d*|\.\d+))(?:px)?\s*$/.exec(text);
  return match ? Number(match[1]) : null;
}

function canonicalViewBox(root: Element): string {
  const attrs = new Map(root.attrs);
  let box = attrs.has("viewbox") ? numbers(attrs.get("viewbox")!, 4) : null;
  if (!box && !attrs.has("viewbox")) {
    const width = pixels(attrs.get("width"));
    const height = pixels(attrs.get("height"));
    if (width !== null && height !== null) box = [0, 0, width, height];
  }
  if (!box) return refuse("an SVG with a viewBox of four numbers (or a plain width and height to derive one from)");
  const [minX, minY, width, height] = box as [number, number, number, number];
  if (
    !box.every(Number.isFinite) ||
    Math.abs(minX) > SVG_VIEWBOX_MAX ||
    Math.abs(minY) > SVG_VIEWBOX_MAX ||
    width <= 0 ||
    height <= 0 ||
    width > SVG_VIEWBOX_MAX ||
    height > SVG_VIEWBOX_MAX
  ) {
    refuse(`an SVG whose viewBox is within ±${SVG_VIEWBOX_MAX} with a positive width and height of at most ${SVG_VIEWBOX_MAX}`);
  }
  return box.map((n) => String(n)).join(" ");
}

/** The accessible name: the document's own root-level `<title>`, else the record's label, else its `aria-label`. */
function accessibleName(root: Element, label: string | undefined): string {
  const title = root.children.find((child) => child.name === "title")?.text;
  const ariaLabel = new Map(root.attrs).get("aria-label");
  const name = [title, label, ariaLabel].map((text) => text?.replace(/\s+/g, " ").trim() ?? "").find((text) => text.length > 0);
  if (!name) refuse("an SVG with an accessible name (a <title> element, or a label on the record)");
  return name!.slice(0, SVG_LABEL_MAX);
}

/**
 * Check one element's attributes and return the ones that survive, in
 * canonical order. Refuses handlers and anything that can reach outside the
 * document; strips the rest of what it does not know.
 */
function sanitizeAttributes(element: Element, isRoot: boolean): Array<[string, string]> {
  const kept = new Map<string, string>();
  for (const [rawName, value] of element.attrs) {
    const name = rawName === "xlink:href" ? "href" : rawName;
    if (name.startsWith("on")) refuse(`an SVG without event handler attributes (${rawName})`);
    if (value.includes("<")) refuse("well-formed SVG markup (an attribute value contains <)");
    if (name === "style") {
      if (HOSTILE_VALUE.test(value)) refuse("an SVG whose styles carry no external references, URLs or scripts");
      continue; // Presentation attributes only: colour comes from the row, not from a stylesheet.
    }
    if (name === "href") {
      if (element.name !== "use") continue;
      if (!LOCAL_REF.test(value)) refuse(`an SVG whose references are local (#id), not "${value}"`);
    } else if (name === "clip-path") {
      if (!LOCAL_URL.test(value)) refuse(`an SVG whose clip-path references are local (url(#id)), not "${value}"`);
    } else if ((name === "fill" || name === "stroke") && LOCAL_URL.test(value)) {
      // A local paint server (a gradient the document defined): monochrome makes it currentColor below.
    } else if (HOSTILE_VALUE.test(value)) {
      refuse(`an SVG without URLs or scripts in attribute values (${rawName})`);
    }
    if (!ATTRIBUTE_ORDER.has(name as (typeof ATTRIBUTES)[number])) continue;
    if (isRoot && ROOT_STRIPPED.has(name)) continue;
    if (name === "id" && !LOCAL_ID.test(value)) continue;
    if (name === "fill" || name === "stroke") {
      kept.set(name, value.trim().toLowerCase() === "none" ? "none" : "currentColor");
      continue;
    }
    kept.set(name, value.trim());
  }
  return [...kept.entries()].sort((a, b) => ATTRIBUTE_ORDER.get(a[0] as never)! - ATTRIBUTE_ORDER.get(b[0] as never)!);
}

function write(element: Element, isRoot: boolean): string {
  const tag = ELEMENTS[element.name]!; // The parser refused anything not in the list.
  if (element.name === "title" || element.name === "desc") return ""; // Replaced by the canonical title.
  const attrs = sanitizeAttributes(element, isRoot)
    .map(([name, value]) => ` ${ATTRIBUTE_CASE[name] ?? name}="${escapeAttr(value)}"`)
    .join("");
  const children = element.children.map((child) => write(child, false)).join("");
  return children.length === 0 && !isRoot ? `<${tag}${attrs}/>` : `<${tag}${attrs}>${children}</${tag}>`;
}

/**
 * Sanitise one SVG document. `label` is the accessible name to use when the
 * document has no `<title>` of its own — the appearance record's label. The
 * result is either the canonical string with the viewBox and the name it
 * carries, or the reason it was refused, phrased as the "must be …" sentence
 * the settings registry completes.
 */
export function sanitizeSvg(input: unknown, options: { label?: string } = {}): SvgSanitizeResult {
  try {
    if (typeof input !== "string") refuse("an SVG document as a string");
    const bytes = new TextEncoder().encode(input as string).length;
    if (bytes > SVG_MAX_BYTES) refuse(`an SVG of at most ${SVG_MAX_BYTES} bytes (got ${bytes})`);
    let source = (input as string).replace(/^\uFEFF/, "").trim();
    source = source.replace(/^<\?xml[^>]*\?>\s*/i, "");
    if (source.includes("<!--")) {
      if (!/<!--[\s\S]*?-->/.test(source)) refuse("well-formed SVG markup (a comment is never closed)");
      source = source.replace(/<!--[\s\S]*?-->/g, "");
    }
    if (source.includes("<!")) refuse("an SVG without DOCTYPE, entity declarations or CDATA sections");
    if (source.includes("<?")) refuse("an SVG without processing instructions");
    if (ENTITY.test(source)) refuse("an SVG using only the predefined XML entities (&amp; &lt; &gt; &quot; &apos; and numeric references)");
    if (/[\p{Cc}]/u.test(source.replace(/[\t\n\r]/g, ""))) refuse("an SVG without control characters");

    const parsed = parse(source);
    if (parsed.children.length !== 1 || parsed.children[0]!.name !== "svg") refuse("an SVG with one <svg> root element");
    const root = parsed.children[0]!;
    // Attributes are checked as the tree is written: a hostile one anywhere is a refusal, not a strip.
    const body = root.children.map((child) => write(child, false)).join("");
    const viewBox = canonicalViewBox(root);
    const label = accessibleName(root, options.label);
    const rootAttrs = sanitizeAttributes(root, true)
      .map(([name, value]) => ` ${ATTRIBUTE_CASE[name] ?? name}="${escapeAttr(value)}"`)
      .join("");
    const svg = `<svg xmlns="${SVG_NAMESPACE}" viewBox="${viewBox}" role="img" aria-label="${escapeAttr(label)}"${rootAttrs}><title>${escapeText(label)}</title>${body}</svg>`;
    return { ok: true, svg, viewBox, label };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, problem: error.message };
    throw error;
  }
}

/**
 * Is this string the sanitiser's own output? True only for a fixed point —
 * the value the validator lets into the store and the only thing the browser
 * injects. Everything else, including a raw document that WOULD sanitise
 * cleanly, is not canonical.
 */
export function isCanonicalSvg(value: string): boolean {
  const result = sanitizeSvg(value);
  return result.ok && result.svg === value;
}
