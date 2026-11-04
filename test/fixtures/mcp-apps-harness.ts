/**
 * Render a staple MCP Apps view in a minimal, host-agnostic MCP Apps host, in Chromium.
 *
 * The test calls a view tool on a real `staple mcp`, reads the tool's `ui://` resource, and
 * hands both to `mcp-apps-host.ts`, which renders the view the way any MCP Apps host does
 * (sandboxed frame, opaque origin, host theme and style variables, tool calls proxied back to
 * the server). `renderView` then reports what a person would see: whether the view painted,
 * how tall it is, whether it scrolls sideways, and whether it took the host's theme.
 */
import { build } from "esbuild";
import { inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Frame, Page } from "playwright-core";
import { expect } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { HostStart } from "./mcp-apps-host.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The MCP Apps extension a client advertises to say it renders views. */
export const MCP_APPS_EXTENSION = { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } };

let hostPage: Promise<string> | undefined;

/** The host page: `mcp-apps-host.ts` bundled into one inline script. Built once per file. */
export function hostPageHtml(): Promise<string> {
  hostPage ??= build({
    entryPoints: [join(here, "mcp-apps-host.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  }).then((result) => {
    const js = result.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
    return `<!doctype html><html><head><meta charset="utf-8"><title>MCP Apps test host</title>
<style>html,body{margin:0}body{padding:16px}#frame-host{box-sizing:border-box}</style></head>
<body><div id="frame-host"></div><script>${js}</script></body></html>`;
  });
  return hostPage;
}

export interface ViewSource {
  tool: Tool;
  toolInput: Record<string, unknown>;
  toolResult: CallToolResult;
  html: string;
}

/** Call a view tool and read the view it declares, as a host does before rendering. */
export async function loadView(client: Client, toolName: string, toolInput: Record<string, unknown> = {}): Promise<ViewSource> {
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no tool ${toolName}`);
  const uri = (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri;
  if (!uri?.startsWith("ui://")) throw new Error(`tool ${toolName} declares no ui:// resource`);
  const toolResult = (await client.callTool({ name: toolName, arguments: toolInput })) as CallToolResult;
  const resource = await client.readResource({ uri });
  const content = resource.contents.find((item) => item.mimeType === "text/html;profile=mcp-app");
  if (!content || !("text" in content)) throw new Error(`resource ${uri} has no text/html;profile=mcp-app text`);
  return { tool, toolInput, toolResult, html: content.text };
}

export interface RenderedView {
  page: Page;
  context: BrowserContext;
  frame: Frame;
  /** What `mcp-apps-host.ts` recorded: tool calls, messages, reported sizes, links opened. */
  record(): Promise<{ messages: unknown[]; toolCalls: string[]; sizes: number[]; links: string[] }>;
  setTheme(theme: "light" | "dark"): Promise<void>;
  /** Tear the view down (`ui/resource-teardown`). */
  teardown(): Promise<void>;
  /** Hand the view another tool result. */
  sendResult(result: CallToolResult): Promise<void>;
}

/** Open the host page and render the view in it. The caller closes `context`. */
export async function renderView(
  browser: Browser,
  client: Client,
  view: ViewSource,
  options: { theme: "light" | "dark"; width: number; serverTools?: boolean },
): Promise<RenderedView> {
  const context = await browser.newContext({
    colorScheme: options.theme,
    viewport: { width: options.width + 32, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.exposeFunction("hostCallTool", (params: { name: string; arguments?: Record<string, unknown> }) =>
    client.callTool(params),
  );
  await page.exposeFunction("hostReadResource", (params: { uri: string }) => client.readResource(params));
  await page.setContent(await hostPageHtml());
  const start: HostStart = { ...view, theme: options.theme, width: options.width, serverTools: options.serverTools ?? true };
  await page.evaluate((args) => window.startHost(args), start);
  const frame = await (await page.$("#app-frame"))!.contentFrame();
  if (!frame) throw new Error("the host page has no app frame");
  return {
    page,
    context,
    frame,
    record: () => page.evaluate(() => window.hostRecord),
    setTheme: (theme) => page.evaluate((next) => window.setHostTheme(next), theme),
    teardown: () => page.evaluate(() => window.teardownHost()),
    sendResult: (result) => page.evaluate((next) => window.sendHostResult(next), result),
  };
}

export interface PaintReport {
  /** The view marked `<body data-ready>` (it rendered a result) within the timeout. */
  ready: boolean;
  /** The frame's height, which the view reported to the host. */
  height: number;
  /** Distinct colours in a screenshot of the frame: a blank frame has one. */
  colors: number;
  /** Share of the frame's pixels that differ from the host page background behind it. */
  inked: number;
  /** Horizontal overflow inside the view, in px. */
  overflowPx: number;
  /** The view document's computed `color-scheme`. */
  colorScheme: string;
}

/** The paint report of a view a person can read at `width`, in the host's `theme`. */
export function expectPainted(report: PaintReport, theme: "light" | "dark", width: number): void {
  expect(report.ready, "the view rendered a result").toBe(true);
  expect(report.height, "the view reported a real height").toBeGreaterThan(60);
  expect(report.colors, "the frame is not one flat colour").toBeGreaterThan(8);
  expect(report.inked, "a real share of the frame is drawn").toBeGreaterThan(0.2);
  expect(report.overflowPx, `no sideways scroll at ${width}px`).toBeLessThanOrEqual(0);
  expect(report.colorScheme, "the view took the host theme").toBe(theme);
}

/** Wait for the view to paint, then measure it. Never throws on a view that does not paint. */
export async function measurePaint(view: RenderedView, timeoutMs = 10_000): Promise<PaintReport> {
  const ready = await view.frame
    .waitForSelector("body[data-ready]", { timeout: timeoutMs, state: "attached" })
    .then(() => true)
    .catch(() => false);
  // The host resizes the frame when the view reports its size; wait for it to settle.
  let height = -1;
  for (let i = 0; i < 20; i++) {
    const next = await view.page.$eval("#app-frame", (element) => element.getBoundingClientRect().height);
    if (next === height) break;
    height = next;
    await view.page.waitForTimeout(100);
  }
  const shot = height > 0 ? decodePng(await (await view.page.$("#app-frame"))!.screenshot()) : null;
  const background = decodePng(await view.page.screenshot({ clip: { x: 0, y: 0, width: 4, height: 4 } }));
  const [br, bg, bb] = [background.pixels[0]!, background.pixels[1]!, background.pixels[2]!];
  let inkedPixels = 0;
  const colors = new Set<number>();
  if (shot) {
    for (let i = 0; i < shot.pixels.length; i += 4) {
      const [r, g, b] = [shot.pixels[i]!, shot.pixels[i + 1]!, shot.pixels[i + 2]!];
      colors.add((r << 16) | (g << 8) | b);
      if (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) > 6) inkedPixels += 1;
    }
  }
  const { overflowPx, colorScheme } = await view.frame.evaluate(() => ({
    overflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  }));
  return {
    ready,
    height: Math.max(0, height),
    colors: colors.size,
    inked: shot ? inkedPixels / (shot.width * shot.height) : 0,
    overflowPx,
    colorScheme,
  };
}

/**
 * Decode an 8-bit, non-interlaced RGB or RGBA PNG (what Chromium screenshots are) to RGBA.
 * Small on purpose: the suite has no image library, and this is all it needs to count colours.
 */
export function decodePng(png: Buffer): { width: number; height: number; pixels: Uint8Array } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colorType, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${colorType}, interlace ${interlace}`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? current[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      current[x] = (line[x]! + predictor) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4;
      out[target] = current[x * channels]!;
      out[target + 1] = current[x * channels + 1]!;
      out[target + 2] = current[x * channels + 2]!;
      out[target + 3] = channels === 4 ? current[x * channels + 3]! : 255;
    }
    previous = current;
  }
  return { width, height, pixels: out };
}
