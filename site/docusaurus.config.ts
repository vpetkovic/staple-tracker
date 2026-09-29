import {execFileSync} from 'node:child_process';
import path from 'node:path';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {syntaxTheme} from './src/css/prism';

// Where the site lives: the only two values to change when it moves. `url` is a
// placeholder until the production domain is set up with the Cloudflare deploy.
const url = 'https://example.com';
const baseUrl = '/';

const repo = 'https://github.com/vpetkovic/staple-tracker';
const repoRoot = path.resolve(__dirname, '..');
const docsDir = path.join(repoRoot, 'docs');

// True when git tracks exactly this path (same case), so the GitHub link resolves.
function tracked(relative: string): boolean {
  try {
    const out = execFileSync('git', ['ls-files', '--', relative], {cwd: repoRoot, encoding: 'utf8'});
    return out.split('\n').includes(relative);
  } catch {
    return false;
  }
}

// docs/*.md is the single source of truth and links to repository files outside
// docs/ (CONTRIBUTING.md, RELEASING.md). Those links point at the file on GitHub.
// Any other unresolvable Markdown link fails the build.
function linkOutsideDocs({sourceFilePath, url: target}: {sourceFilePath: string; url: string}): string {
  const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(target);
  const filePart = match?.[1] ?? '';
  const suffix = `${match?.[2] ?? ''}${match?.[3] ?? ''}`;
  const source = path.resolve(__dirname, sourceFilePath);
  const resolved = path.resolve(path.dirname(source), decodeURIComponent(filePart));
  const relative = path.relative(repoRoot, resolved).split(path.sep).join('/');
  const inDocs = resolved.startsWith(docsDir + path.sep);
  if (!inDocs && !relative.startsWith('../') && tracked(relative)) {
    return `${repo}/blob/master/${relative}${suffix}`;
  }
  throw new Error(`Broken Markdown link "${target}" in ${sourceFilePath}`);
}

const config: Config = {
  title: 'staple',
  tagline: 'Local-first task tracking for coding agents.',
  favicon: 'img/favicon.svg',
  headTags: [
    {tagName: 'link', attributes: {rel: 'apple-touch-icon', href: `${baseUrl}img/apple-touch-icon.png`}},
  ],
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
          editUrl: ({docPath}) => `${repo}/edit/master/docs/${docPath}`,
        },
        blog: false,
        theme: {
          // Fonts first, then the tokens, then the chrome that reads them.
          customCss: [
            './src/css/fonts.css',
            './src/css/tokens.css',
            './src/css/custom.css',
          ],
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
      logo: {src: 'img/logo.svg', srcDark: 'img/logo-dark.svg', alt: 'staple logo', width: 24, height: 24},
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
        {href: repo, label: 'GitHub', position: 'right'},
      ],
    },
    footer: {
      style: 'light',
      logo: {src: 'img/logo.svg', srcDark: 'img/logo-dark.svg', alt: 'staple', width: 20, height: 20, href: '/'},
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Overview', to: '/docs'},
            {label: 'CLI', to: '/docs/cli'},
            {label: 'Web UI', to: '/docs/web-ui'},
            {label: 'Cloud sync', to: '/docs/sync'},
          ],
        },
        {
          title: 'Work',
          items: [
            {label: 'Pickup queue', to: '/docs/queue'},
            {label: 'Milestones', to: '/docs/milestones'},
            {label: 'Autopilot runs', to: '/docs/runs'},
            {label: 'Agents', to: '/docs/agents'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'GitHub', href: repo},
            {label: 'Contributing', href: `${repo}/blob/master/CONTRIBUTING.md`},
            {label: 'License', href: `${repo}/blob/master/LICENSE`},
          ],
        },
      ],
      copyright: 'staple is MIT licensed.',
    },
    prism: {
      theme: syntaxTheme,
      darkTheme: syntaxTheme,
      additionalLanguages: ['bash', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
