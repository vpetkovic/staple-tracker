import fs from 'node:fs/promises';
import path from 'node:path';
import type {Plugin} from '@docusaurus/types';

// The self-hosted Latin faces every page paints with first (src/css/fonts.css).
// Without a preload the browser finds them only after it has parsed the stylesheet,
// which puts a second round trip in front of the first text in Geist.
const FACES = ['geist-latin-wght-normal', 'geist-mono-latin-wght-normal'];

// Webpack names the emitted files `<name>-<contenthash>.woff2`, known only after the
// bundle is written, so the preload links go into the HTML after the build.
export default function preloadFonts(): Plugin {
  return {
    name: 'preload-fonts',
    async postBuild({outDir, baseUrl}) {
      const fontsDir = path.join(outDir, 'assets', 'fonts');
      const files = await fs.readdir(fontsDir);
      const links = FACES.map((face) => {
        const file = files.find((name) => name.startsWith(`${face}-`) && name.endsWith('.woff2'));
        if (!file) throw new Error(`preload-fonts: no emitted file for ${face} in ${fontsDir}`);
        return `<link rel="preload" href="${baseUrl}assets/fonts/${file}" as="font" type="font/woff2" crossorigin>`;
      }).join('');
      const pages = await htmlFiles(outDir);
      await Promise.all(
        pages.map(async (page) => {
          const html = await fs.readFile(page, 'utf8');
          if (!html.includes('</title>')) return;
          // Straight after the title, ahead of the stylesheet that would discover them.
          // Other plugins read these files in their own postBuild at the same time (the
          // search index does), so the new file replaces the old one in a single rename
          // and a reader never sees it half-written.
          const next = `${page}.preload-fonts.tmp`;
          await fs.writeFile(next, html.replace('</title>', `</title>${links}`));
          await fs.rename(next, page);
        }),
      );
    },
  };
}

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return htmlFiles(full);
      return entry.name.endsWith('.html') ? [full] : [];
    }),
  );
  return nested.flat();
}
