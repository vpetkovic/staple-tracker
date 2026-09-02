/**
 * The canvas as a file — G5 (STA-58).
 *
 * ── Why this GENERATES svg instead of photographing the DOM ──────────────────────────
 *
 * The usual way to export a React Flow canvas is html-to-image: clone the live DOM into a
 * `<foreignObject>` and inline every computed style. That library is not installed and
 * must not be, and rebuilding it here would be the worst of both worlds — the fragile
 * part of that approach is exactly the cloning, which breaks on pseudo-elements, on CSS
 * custom properties, and on anything the browser resolves lazily.
 *
 * So this does the opposite: it DRAWS the graph, from the same data the view already
 * holds. Positions come from `positions` + NODE_W/NODE_H, which is what dagre laid out and
 * what React Flow rendered, so the file cannot disagree with the screen. Edge geometry is
 * the one thing not worth re-deriving — smoothstep routing is React Flow's — so the real
 * `d` attributes are read off the rendered paths. Those live inside the same viewport
 * transform as the nodes, so the two coordinate spaces are already the same one.
 *
 * PNG then falls out honestly rather than being faked: a self-contained SVG serialized to
 * a data URL, drawn into a canvas at 2×, `toBlob`. A data-URL SVG does not taint the
 * canvas, and the only fonts named are generic families, which a rasterizer can resolve
 * (a webfont URL could not be). There is no PNG gap to apologise for.
 */

/** One box in the exported picture. Geometry is untransformed flow coordinates. */
export interface ExportNode {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Monospace line: the identifier, optionally workspace-prefixed. */
  label: string;
  title: string;
  /** Resolved colour for the status accent. Never a CSS variable — see resolveColors. */
  accent: string;
  /** `3/9 done`, clusters only. */
  badge?: string;
  /** Draws the offset "stack" outline that marks a collapsed epic. */
  cluster?: boolean;
  /** Finished work, faded in the export exactly as on screen. */
  faded?: boolean;
}

export interface ExportEdge {
  /** The `d` attribute lifted from the rendered path. */
  d: string;
  /** Cross-workspace: the long dash. */
  cross?: boolean;
  /** Bridged across hidden work: the fine dot. */
  derived?: boolean;
}

/** Theme colours, already resolved to real values by the caller. */
export interface ExportColors {
  background: string;
  card: string;
  border: string;
  text: string;
  muted: string;
}

export interface ExportInput {
  nodes: readonly ExportNode[];
  edges: readonly ExportEdge[];
  colors: ExportColors;
  /** Free space around the drawing, in flow units. */
  padding?: number;
  /** Stamped bottom-left so a picture in a slide deck can be dated later. */
  caption?: string;
}

/**
 * XML escaping.
 *
 * NOT OPTIONAL AND NOT PARANOIA: ticket titles on this very project contain `&` (see any
 * "A & B" title) and `<`. An unescaped one produces a file that every SVG viewer refuses
 * to open, and the failure arrives at the moment someone tries to paste it into a deck.
 * Quotes are escaped too because these strings also land in attributes.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Break a title into at most two lines that fit the card, ellipsizing the overflow.
 *
 * Deliberately crude — average character width rather than real text metrics. Measuring
 * properly would mean a canvas context and a font that may not have loaded, to place text
 * that is already clamped to two lines on screen. The card is fixed-size and truncating,
 * so the export is agreeing with the screen rather than being sloppy.
 */
export function wrapTitle(title: string, width: number, lines = 2): string[] {
  const perLine = Math.max(8, Math.floor(width / 5.6));
  const words = title.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current === "" ? word : `${current} ${word}`;
    if (next.length <= perLine) {
      current = next;
      continue;
    }
    out.push(current);
    current = word;
    if (out.length === lines) break;
  }
  if (out.length < lines && current !== "") out.push(current);
  if (out.length === lines && current !== "" && out[lines - 1] !== current) {
    out[lines - 1] = `${out[lines - 1]!.slice(0, Math.max(0, perLine - 1))}…`;
  }
  return out.slice(0, lines).map((line) => (line.length > perLine ? `${line.slice(0, perLine - 1)}…` : line));
}

/** The drawing's extent, plus padding. Empty input still yields a valid tiny document. */
function bounds(nodes: readonly ExportNode[], padding: number) {
  if (nodes.length === 0) return { minX: 0, minY: 0, width: padding * 2, height: padding * 2 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.w);
    maxY = Math.max(maxY, node.y + node.h);
  }
  return {
    minX: minX - padding,
    minY: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

/**
 * The whole picture, as an SVG document string.
 *
 * Everything is inside one `<g>` carrying a single translate, so node coordinates and the
 * edge `d` strings — which came from the same space — need no adjustment individually.
 * Fonts are named as generic families only: a `url()` webfont would silently disappear
 * when the SVG is rasterized into a PNG or opened outside the app.
 */
export function buildSvg(input: ExportInput): string {
  const padding = input.padding ?? 48;
  const { minX, minY, width, height } = bounds(input.nodes, padding);
  const { colors } = input;

  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
  const sans = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

  const edges = input.edges
    .map((edge) => {
      const dash = edge.derived ? ' stroke-dasharray="1 4"' : edge.cross ? ' stroke-dasharray="5 4"' : "";
      const opacity = edge.derived ? 0.7 : 0.75;
      return `<path d="${escapeXml(edge.d)}" fill="none" stroke="${escapeXml(colors.muted)}" stroke-width="1.4" opacity="${opacity}"${dash} marker-end="url(#arrow)"/>`;
    })
    .join("\n    ");

  const nodes = input.nodes
    .map((node) => {
      const lines = wrapTitle(node.title, node.w - 16);
      const group: string[] = [];
      const opacity = node.faded ? ' opacity="0.32"' : "";
      group.push(`<g transform="translate(${node.x} ${node.y})"${opacity}>`);
      if (node.cluster) {
        // The offset outline that says "this box is several boxes", same idea as the
        // stacked shadow the live super-node wears.
        group.push(
          `<rect x="3" y="3" width="${node.w}" height="${node.h}" rx="6" fill="${escapeXml(colors.card)}" stroke="${escapeXml(colors.border)}"/>`,
        );
      }
      group.push(
        `<rect width="${node.w}" height="${node.h}" rx="6" fill="${escapeXml(colors.card)}" stroke="${escapeXml(colors.border)}"/>`,
        // The accent stripe and the dot: the node's status, and the only colour in the
        // file. Both are the same 3px/`--sc` vocabulary the card uses on screen.
        `<rect width="3" height="${node.h}" fill="${escapeXml(node.accent)}"/>`,
        `<circle cx="14" cy="14" r="3" fill="${escapeXml(node.accent)}"/>`,
        `<text x="22" y="17" font-family="${mono}" font-size="10" fill="${escapeXml(colors.muted)}">${escapeXml(node.label)}</text>`,
      );
      if (node.badge) {
        group.push(
          `<text x="${node.w - 8}" y="17" text-anchor="end" font-family="${sans}" font-size="10" fill="${escapeXml(colors.muted)}">${escapeXml(node.badge)}</text>`,
        );
      }
      lines.forEach((line, i) => {
        group.push(
          `<text x="9" y="${33 + i * 13}" font-family="${sans}" font-size="11.5" font-weight="500" fill="${escapeXml(colors.text)}">${escapeXml(line)}</text>`,
        );
      });
      group.push("</g>");
      return group.join("");
    })
    .join("\n    ");

  const caption = input.caption
    ? `<text x="${minX + 8}" y="${minY + height - 8}" font-family="${sans}" font-size="11" fill="${escapeXml(colors.muted)}">${escapeXml(input.caption)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="${minX} ${minY} ${width} ${height}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeXml(colors.muted)}"/>
    </marker>
  </defs>
  <rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${escapeXml(colors.background)}"/>
  <g>
    ${edges}
    ${nodes}
  </g>
  ${caption}
</svg>`;
}

/**
 * Rasterize. 2× so the result survives a projector and a retina screen.
 *
 * `encodeURIComponent` rather than `btoa`: the SVG carries ticket titles, those carry
 * em-dashes and other non-Latin-1 characters, and `btoa` throws on exactly those.
 */
export function svgToPngBlob(svg: string, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const match = /width="(\d+)" height="(\d+)"/.exec(svg);
    const width = Number(match?.[1] ?? 1200);
    const height = Number(match?.[2] ?? 800);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("no 2d context"));
        return;
      }
      context.scale(scale, scale);
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob produced nothing"))), "image/png");
    };
    image.onerror = () => reject(new Error("the SVG could not be rasterized"));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * Put text on the clipboard, by whichever route this browser allows.
 *
 * `navigator.clipboard` is the right API and it is not always available: it needs a
 * secure context AND a permission that is refused outside a trusted user gesture, which
 * covers automation, some embedded webviews, and any non-localhost http origin — all of
 * which this app can legitimately be opened from.
 *
 * So the deprecated `execCommand("copy")` stays as a fallback. It is deprecated, not
 * gone, and it is the difference between a working button and a dead one. The textarea is
 * positioned off-screen rather than hidden because a `display:none` element cannot be
 * selected, which is the classic way this fallback silently does nothing.
 *
 * Returns whether it worked, so the caller can say so honestly rather than assume.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Hand a blob to the browser as a download. Revoked on the next tick, not never. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Immediate revocation can beat the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
