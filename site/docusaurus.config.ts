import {existsSync} from 'node:fs';
import path from 'node:path';
import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// Where the site lives: the only two values to change when it moves. `url` is a
// placeholder until the production domain is set up with the Cloudflare deploy.
const url = 'https://example.com';
const baseUrl = '/';

const repo = 'https://github.com/vpetkovic/staple-tracker';
const repoRoot = path.resolve(__dirname, '..');
const docsDir = path.join(repoRoot, 'docs');

// docs/*.md is the single source of truth and links to repository files outside
// docs/ (CONTRIBUTING.md, RELEASING.md). Those links point at the file on GitHub.
// Any other unresolvable Markdown link fails the build.
function linkOutsideDocs({sourceFilePath, url: target}: {sourceFilePath: string; url: string}): string {
  const [filePart = '', hash] = target.split('#');
  const source = path.resolve(__dirname, sourceFilePath);
  const resolved = path.resolve(path.dirname(source), decodeURIComponent(filePart));
  const inRepo = resolved.startsWith(repoRoot + path.sep);
  const inDocs = resolved.startsWith(docsDir + path.sep);
  if (inRepo && !inDocs && existsSync(resolved)) {
    const relative = path.relative(repoRoot, resolved).split(path.sep).join('/');
    return `${repo}/blob/master/${relative}${hash ? `#${hash}` : ''}`;
  }
  throw new Error(`Broken Markdown link "${target}" in ${sourceFilePath}`);
}

const config: Config = {
  title: 'staple',
  tagline: 'Local-first task tracking for coding agents.',
  url,
  baseUrl,
  trailingSlash: false,

  onBrokenLinks: 'throw',
  // docs/sync.md links to two anchors that are bold paragraph leads, not headings.
  // Switch to 'throw' once those links are fixed.
  onBrokenAnchors: 'warn',
  markdown: {
    // .md files are CommonMark, .mdx files are MDX: docs/*.md render as written.
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: linkOutsideDocs,
      onBrokenMarkdownImages: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../docs',
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          editUrl: `${repo}/edit/master/docs/`,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'staple',
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
        {href: repo, label: 'GitHub', position: 'right'},
      ],
    },
    footer: {
      style: 'light',
      copyright: 'staple is MIT licensed.',
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
