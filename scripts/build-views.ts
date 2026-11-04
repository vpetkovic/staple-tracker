/**
 * Build staple's MCP Apps views: one self-contained HTML file per view.
 *
 *   npm run build:views            -> src/views/dist/<name>.html
 *
 * Each `src/views/<name>/index.html` is a Vite entry. A host renders a view in a sandboxed
 * frame whose content security policy allows inline script and style and no network at all,
 * so the build inlines the script and the stylesheet into the page and inlines every asset
 * as a data URL. The result is checked: a view that still references a file is an error here,
 * not a blank frame in someone's thread.
 *
 * `src/mcp-views.ts` names the views the server serves; every one of them must be built.
 * `scripts/build-package.ts` copies the output into the package as `views/`.
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build, type Plugin } from "vite";
import { VIEWS } from "../src/mcp-views.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VIEWS_SOURCE_DIR = join(repoRoot, "src", "views");
export const VIEWS_DIST_DIR = join(VIEWS_SOURCE_DIR, "dist");

/** A host refuses a view resource larger than this (the MCP Apps reference hosts use 5 MB). */
const MAX_VIEW_BYTES = 5 * 1024 * 1024;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Inline the entry chunk and its stylesheet into the page, then drop them from the output.
 * `</script` inside the code is escaped so the inline script cannot end early. `<!--` cannot
 * be escaped the same way (`\!` is a syntax error in a unicode regex), and with a `<script`
 * after it the HTML parser would swallow the rest of the page, so code holding it fails the
 * build instead.
 */
function singleFile(packages: Set<string>): Plugin {
  return {
    name: "staple-single-file-view",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = Object.values(bundle).find((item) => item.type === "asset" && item.fileName.endsWith(".html"));
      if (!page || page.type !== "asset") throw new Error("the view build produced no HTML page");
      let html = String(page.source);
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item === page) continue;
        const pattern = escapeRegExp(fileName);
        if (item.type === "chunk") {
          for (const id of Object.keys(item.modules)) {
            const name = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id)?.[1];
            if (name) packages.add(name);
          }
          const tag = new RegExp(`<script\\b[^>]*\\bsrc="(?:\\./|/)?${pattern}"[^>]*></script>`);
          if (!tag.test(html)) throw new Error(`the view build emitted a script the page does not load: ${fileName}`);
          if (item.code.includes("<!--")) {
            throw new Error(`${fileName} contains "<!--", which an inline script cannot hold safely`);
          }
          const code = item.code.replace(/<\/script/gi, "<\\/script");
          html = html.replace(tag, () => `<script type="module">${code}</script>`);
        } else if (fileName.endsWith(".css")) {
          const tag = new RegExp(`<link\\b[^>]*\\bhref="(?:\\./|/)?${pattern}"[^>]*>`);
          if (!tag.test(html)) throw new Error(`the view build emitted a stylesheet the page does not load: ${fileName}`);
          const css = String(item.source).replace(/<\/style/gi, "<\\/style");
          html = html.replace(tag, () => `<style>${css}</style>`);
        } else {
          throw new Error(`the view build emitted a separate file, which a sandboxed host cannot load: ${fileName}`);
        }
        delete bundle[fileName];
      }
      page.source = html;
    },
  };
}

/** The checks that make "one self-contained file" true rather than hoped for. */
function verifySelfContained(name: string, html: string): void {
  // The markup and the stylesheets, without the script's own text (its strings are not tags).
  const markup = html.replace(/<script type="module">[\s\S]*?<\/script>/g, '<script type="module"></script>');
  if (markup === html) throw new Error(`view "${name}" has no inline script`);
  // Any attribute that loads something, quoted either way or not at all, unless it is a data: URL.
  const external =
    /<[a-z][^>]*?\s(?:src|href|srcset|poster|data|action)\s*=\s*(?:"(?!data:|#)[^"]+"|'(?!data:|#)[^']+'|(?!["'])(?!data:|#)[^\s>]+)/i.exec(markup);
  if (external) throw new Error(`view "${name}" still references a file: ${external[0]}`);
  const styles = [...markup.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join("\n");
  const cssUrl = /url\(\s*['"]?(?!data:|#)[^'")\s]+/i.exec(styles);
  if (cssUrl) throw new Error(`view "${name}" still references a file from CSS: ${cssUrl[0]}`);
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_VIEW_BYTES) throw new Error(`view "${name}" is ${bytes} bytes, over the ${MAX_VIEW_BYTES}-byte limit hosts apply`);
}

async function buildView(name: string, outDir: string, packages: Set<string>): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), `staple-view-${name}-`));
  try {
    await build({
      configFile: false,
      root: join(VIEWS_SOURCE_DIR, name),
      base: "./",
      logLevel: "warn",
      plugins: [singleFile(packages)],
      build: {
        outDir: scratch,
        emptyOutDir: true,
        target: "es2022",
        // Every asset becomes a data URL: the frame has no origin to fetch from.
        assetsInlineLimit: () => true,
        cssCodeSplit: false,
        modulePreload: false,
        reportCompressedSize: false,
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    });
    const html = readFileSync(join(scratch, "index.html"), "utf8");
    verifySelfContained(name, html);
    const file = join(outDir, `${name}.html`);
    // Written beside the target and renamed over it, so a reader never sees half a file.
    writeFileSync(`${file}.tmp`, html);
    renameSync(`${file}.tmp`, file);
    return file;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Beside the views: the npm packages compiled into them, for the package's notices. */
export const VIEW_PACKAGES_FILE = "packages.json";

/**
 * Build every view `src/mcp-views.ts` names into `outDir` (default `src/views/dist/`), and
 * record the npm packages compiled into them in `packages.json` beside them.
 */
export async function buildViews(options: { outDir?: string } = {}): Promise<{ files: string[]; packages: string[] }> {
  const outDir = resolve(options.outDir ?? VIEWS_DIST_DIR);
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const packages = new Set<string>();
  for (const view of VIEWS) files.push(await buildView(view.name, outDir, packages));
  const sorted = [...packages].sort();
  writeFileSync(join(outDir, VIEW_PACKAGES_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
  return { files, packages: sorted };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const { files, packages } = await buildViews(values.out === undefined ? {} : { outDir: values.out });
  console.log(`bundled ${packages.length} packages: ${packages.join(", ")}`);
  for (const file of files) {
    console.log(`built ${relative(repoRoot, file)} (${Math.round(Buffer.byteLength(readFileSync(file)) / 1024)} KB)`);
  }
}
