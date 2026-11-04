/**
 * The MCP Apps views `staple mcp` serves.
 *
 * A view is one self-contained HTML file (script and styles inlined, no network) that an
 * MCP Apps host renders in a sandboxed frame inside the agent's thread. A tool links to its
 * view by declaring `_meta.ui.resourceUri`; the host reads that `ui://` resource, renders it,
 * and hands it the tool's result. Hosts without MCP Apps ignore all of this and show the
 * tool's text content, which is why every view tool still answers in plain text.
 *
 * The HTML is built by `scripts/build-views.ts` (`npm run build:views`) from `src/views/`, and
 * read from disk on every resources/read, so a rebuilt view is served without a restart:
 *
 *   packaged   <dir of staple.mjs>/views/<name>.html   (build:package copies it there)
 *   source     src/views/dist/<name>.html              (tsx src/mcp.ts)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps/server";
import { StapleError } from "./core/types.js";

export { RESOURCE_MIME_TYPE };

export interface ViewDefinition {
  /** The file name under the views directory, and the last segment of the URI. */
  name: string;
  /** Shown by hosts that list resources. */
  title: string;
  description: string;
}

/** Every view staple serves. `scripts/build-views.ts` builds one `src/views/<name>/` per entry. */
export const VIEWS: readonly ViewDefinition[] = [
  {
    name: "about",
    title: "About this staple server",
    description: "Placeholder view: the server version, the workspace, its tickets by status, and the host it renders in.",
  },
];

export function viewUri(name: string): string {
  return `ui://staple/${name}`;
}

/** The view a `ui://` URI names, or undefined when staple serves no such view. */
export function viewForUri(uri: string): ViewDefinition | undefined {
  return VIEWS.find((view) => viewUri(view.name) === uri);
}

/** The `_meta` a tool declares to show `name`. Unknown names fail at startup, not in a host. */
export function viewToolMeta(name: string): { ui: { resourceUri: string } } {
  if (!VIEWS.some((view) => view.name === name)) throw new Error(`staple serves no view named "${name}"`);
  return { ui: { resourceUri: viewUri(name) } };
}

/**
 * The `ui://` URI a tool's `_meta` declares, from the current key or the deprecated flat one.
 * Returns undefined for a tool without a view.
 */
export function declaredViewUri(meta: Record<string, unknown> | undefined): string | undefined {
  const ui = meta?.ui as { resourceUri?: unknown } | undefined;
  const uri = typeof ui?.resourceUri === "string" ? ui.resourceUri : meta?.[RESOURCE_URI_META_KEY];
  return typeof uri === "string" ? uri : undefined;
}

/**
 * A tool's `_meta` with both spellings of the view URI. Hosts built before `_meta.ui` read
 * the flat `ui/resourceUri` key; the reference server helper writes both, and so does this.
 */
export function normalizedViewMeta(meta: Record<string, unknown>, uri: string): Record<string, unknown> {
  const ui = (meta.ui ?? {}) as Record<string, unknown>;
  return { ...meta, ui: { ...ui, resourceUri: uri }, [RESOURCE_URI_META_KEY]: uri };
}

type ToolCallback = (...args: unknown[]) => unknown;

/**
 * Link a tool to its view, for the `registerTool` wrapper in `src/mcp.ts`.
 *
 * A tool shows an MCP Apps view by declaring `_meta.ui.resourceUri` (`viewToolMeta`). The URI
 * must name a view this server serves, or this throws and the server refuses to start. The
 * declaration gets the legacy `ui/resourceUri` key too, and every result (an error result
 * included: the view renders it as an error) carries the same `_meta.ui.resourceUri`, so a
 * host or proxy that only sees the result still knows which view renders it. Other keys the
 * result already has under `_meta` and `_meta.ui` are kept. The text content is untouched:
 * it is all a host without MCP Apps shows. A tool without a view comes back as it went in.
 */
export function linkToolView<C extends object>(name: string, config: C, cb: ToolCallback): [C, ToolCallback] {
  const meta = (config as { _meta?: Record<string, unknown> })._meta;
  const uri = declaredViewUri(meta);
  if (uri === undefined) return [config, cb];
  if (viewForUri(uri) === undefined) throw new Error(`tool ${name} declares ${uri}, which is not a view staple serves`);
  const stamp = (value: unknown) => {
    if (value === null || typeof value !== "object") return value;
    const result = value as { _meta?: Record<string, unknown> };
    const ui = (result._meta?.ui ?? {}) as Record<string, unknown>;
    return { ...result, _meta: { ...result._meta, ui: { ...ui, resourceUri: uri } } };
  };
  const stamped: ToolCallback = (...args: unknown[]) => {
    const result = cb(...args);
    return result instanceof Promise ? result.then(stamp) : stamp(result);
  };
  return [{ ...config, _meta: normalizedViewMeta(meta ?? {}, uri) }, stamped];
}

/**
 * Where the built view files are, given the directory the running module lives in. The
 * packaged layout wins when it holds the first view; otherwise this is a source checkout.
 */
export function resolveViewsDir(runtimeDir: string): string {
  const packaged = resolve(runtimeDir, "views");
  if (existsSync(join(packaged, `${VIEWS[0]!.name}.html`))) return packaged;
  return resolve(runtimeDir, "views", "dist");
}

export const VIEWS_DIR = resolveViewsDir(dirname(fileURLToPath(import.meta.url)));

/** The built HTML of one view. A missing build is an instruction, not a stack trace. */
export function readViewHtml(name: string, dir = VIEWS_DIR): string {
  const file = join(dir, `${name}.html`);
  if (!existsSync(file)) {
    throw new StapleError("not_found", `The "${name}" view is not built (expected ${file}). Run \`npm run build:views\`.`);
  }
  return readFileSync(file, "utf8");
}
